import React, { useMemo, useRef, useState } from 'react';
import Cover from './Cover.jsx';
import ReportBlock from './ReportBlock.jsx';
import {
  BLOCK_LABELS,
  BLOCK_TYPES,
  WALL_DEFAULT_COUNT,
  WALL_MAX,
  ZOOM,
  autoWallSubjects,
  clampZoom,
  fitZoom,
  isBlankBlock,
  reportStats,
} from '../core/report.js';

/**
 * 季度报告长图的界面层（三栏：素材面板 / 画布 / 属性）。
 *
 * ## 两条设计约束
 *
 * 1. **这一层不碰 store**：块的增删改序都以回调形式收进来，算在 `core/report.js` 里。
 *    这样组件能被直接塞进 SSR 断言（`renderToStaticMarkup`），而不是只能靠肉眼看。
 * 2. **所有输入用行内控件，不许用 `window.prompt`** ——
 *    Electron 里 `prompt` 存在但一调用就抛（`prompt() is and will not be supported.`），
 *    而且 `?.` 救不了它（值存在、只是会抛）。这类代码必须在两个壳里各验一遍。
 *
 * ## 受控的两个状态
 *
 * `keyword` 和 `selectedId` 都做成**受控优先**（`xxxProp` / `onXxxProp`）：
 * 组件内部的 state 外面灌不进去，SSR 测试里「筛选后还剩几部」「选中那块显示什么属性」
 * 怎么测都是错的结果 —— 这条在 Tier List 上踩过一次。
 *
 * ## 拖拽排序
 *
 * 落点换算（`moveBlock` 的「先摘再插」语义）在纯函数层，这里只负责把坐标喂进去。
 * 同时**保留上移/下移按钮**：pointer 事件在无头环境下难模拟，
 * 而按钮是能被 SSR 断言直接守住的 —— 两条路都留着，不是重复。
 */

/** 拖拽启动阈值：没超过就不算拖，否则「点一下选中」会被拖拽吃掉 */
const DRAG_THRESHOLD = 5;

/**
 * 同构的 layout effect。
 *
 * 画布高度要量出来才能把缩放后的占位撑对，而这件事必须在浏览器画出来**之前**
 * 做完，否则每次换季度都会先闪一帧「没缩放的巨幅」。但 `useLayoutEffect`
 * 在服务端渲染时会警告 —— SSR 断言就是这个项目的主要测试手段，不能让它被警告淹没。
 * 所以在模块加载时就按有没有 `window` 选一个，而不是在组件里条件调用 hook。
 */
const useIsoLayoutEffect = typeof globalThis.window !== 'undefined' ? React.useLayoutEffect : React.useEffect;

export default function ReportView({
  report,
  seasonKey = '',
  seasonLabel = '',
  pool = [],
  lookup = () => null,
  coverage = null,
  note = '',
  exporting = false,
  keyword: keywordProp,
  onKeyword: onKeywordProp,
  selectedId: selectedProp,
  onSelectedId: onSelectedIdProp,
  zoom: zoomProp,
  onZoom: onZoomProp,
  onAddBlock,
  onRemoveBlock,
  onPatchBlock,
  onMoveBlock,
  onAddToWall,
  onExportPdf,
  onExportPng,
  onReset,
}) {
  const [keywordState, setKeywordState] = useState('');
  const keyword = keywordProp ?? keywordState;
  const setKeyword = onKeywordProp ?? setKeywordState;

  const [selectedState, setSelectedState] = useState(null);
  const selectedId = selectedProp !== undefined ? selectedProp : selectedState;
  const setSelectedId = onSelectedIdProp ?? setSelectedState;

  /**
   * 预览倍率。`'fit'` 是「整幅缩到看得见」，数字是用户自己定的档。
   *
   * 做成受控优先（`zoomProp` / `onZoomProp`）跟 `keyword` 同理：
   * 「现在缩到了多少」是能被断言的，藏在组件内部 state 里就验不了。
   */
  const [zoomState, setZoomState] = useState('fit');
  const zoomMode = zoomProp !== undefined ? zoomProp : zoomState;
  const setZoomMode = onZoomProp ?? setZoomState;

  const canvasRef = useRef(null);
  const scrollRef = useRef(null);
  const dragRef = useRef(null);
  const [drag, setDrag] = useState(null); // { id, from, to }

  /** 量出来的「适应」倍率与画布真实高度。没量到之前按 1 画，不缩 */
  const [fit, setFit] = useState({ scale: 1, h: 0 });

  const blocks = report?.blocks ?? [];
  const stats = useMemo(() => reportStats(report), [report]);
  const selected = blocks.find((b) => b.id === selectedId) ?? null;
  const selIndex = selected ? blocks.findIndex((b) => b.id === selected.id) : -1;

  /** 素材面板：按关键字筛 + 标记「已经在墙里的」 */
  const poolRows = useMemo(() => {
    const k = keyword.trim().toLowerCase();
    const inWall = new Set();
    for (const b of blocks) {
      if (b.type === 'wall') for (const id of b.subjectIds) inWall.add(id);
    }
    return pool
      .filter((a) => {
        if (!a || a.id == null) return false;
        if (!k) return true;
        return [a.titleZh, a.titleJa, a.id]
          .filter(Boolean)
          .some((s) => String(s).toLowerCase().includes(k));
      })
      .map((a) => ({ anime: a, used: inWall.has(String(a.id)) }));
  }, [pool, keyword, blocks]);

  const wallTarget = selected?.type === 'wall' ? selected : null;

  /**
   * 量「适应」倍率。
   *
   * `offsetWidth/offsetHeight` 是**布局**尺寸，正好不受 `transform` 影响 ——
   * 所以把画布缩放之后也不会自己把自己量小，不会来回抖。
   * 两个尺寸都靠 ResizeObserver 跟着：窗口拉宽、加块减块都会让它们变。
   *
   * ⚠️ 可用宽度要扣掉滚动区的左右内边距，不然算出来的倍率会让画布**刚好**溢出
   * 一点点 —— 横向滚动条会回来，而用户要的就是它别回来。
   */
  useIsoLayoutEffect(() => {
    const scroll = scrollRef.current;
    const canvas = canvasRef.current;
    if (!scroll || !canvas) return undefined;

    const measure = () => {
      const cs = globalThis.getComputedStyle?.(scroll);
      const pad = cs ? (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) : 0;
      const avail = (scroll.clientWidth || 0) - pad;
      const next = { scale: fitZoom(avail, canvas.offsetWidth), h: canvas.offsetHeight || 0 };
      setFit((prev) => (
        Math.abs(prev.scale - next.scale) < 0.001 && Math.abs(prev.h - next.h) < 1 ? prev : next
      ));
    };

    measure();
    const RO = globalThis.ResizeObserver;
    if (!RO) return undefined;
    const ro = new RO(measure);
    ro.observe(scroll);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [report?.width, blocks.length]);

  const scale = zoomMode === 'fit' ? fit.scale : clampZoom(zoomMode);
  const canvasW = report?.width ?? 0;

  /**
   * 拖拽排序（纵向）。
   *
   * 目标下标用 `dragRef` 存、不用 state —— 在 `setState` 的更新函数里调
   * `onMoveBlock` 是副作用写进 reducer，React 严格模式会把它跑两遍，
   * 症状是「拖一次，块跳了两格」。
   */
  const onGripDown = (id, e) => {
    const from = blocks.findIndex((b) => b.id === id);
    if (from < 0) return;
    const startY = e.clientY;
    dragRef.current = { id, from, to: from, armed: false };
    setDrag({ id, from, to: from });

    const onMove = (ev) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.armed && Math.abs(ev.clientY - startY) < DRAG_THRESHOLD) return;
      d.armed = true;
      // 落到哪个块的「后半段」就插到它后面 —— 这就是 moveBlock 的 to 语义
      let to = 0;
      for (const el of canvasRef.current?.querySelectorAll('[data-report-block]') ?? []) {
        const r = el.getBoundingClientRect();
        if (ev.clientY > r.top + r.height / 2) to += 1;
      }
      // to 是「移走之后」的下标：往下拖经过自己那一格时要减一
      if (to > d.from) to -= 1;
      d.to = Math.min(Math.max(0, to), blocks.length - 1);
      setDrag({ id: d.id, from: d.from, to: d.to });
    };

    const onUp = () => {
      globalThis.window?.removeEventListener('pointermove', onMove);
      globalThis.window?.removeEventListener('pointerup', onUp);
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (d?.armed && d.to !== d.from) onMoveBlock?.(d.from, d.to);
    };

    globalThis.window?.addEventListener('pointermove', onMove);
    globalThis.window?.addEventListener('pointerup', onUp);
  };

  const patchSelected = (patch) => {
    if (selected) onPatchBlock?.(selected.id, patch);
  };

  const missing = coverage?.missing ?? 0;
  // 没接导出回调（比如浏览器壳）时按钮就该是灰的 —— 一个点了没反应的按钮
  // 比一个灰按钮坏得多，用户会以为「导出坏了」，而不是「这个壳没有导出」。
  const canExport = !exporting && blocks.length > 0 && missing === 0 && Boolean(onExportPdf || onExportPng);

  return (
    <div className="report" data-report-view="1" data-report-season={seasonKey}>
      {/* ───────── 左：素材面板 ───────── */}
      <aside className="report__side">
        <div className="report__side-head">
          <strong>素材</strong>
          <span className="report__dim">{pool.length} 部</span>
        </div>
        <input
          className="report__search"
          type="search"
          placeholder="搜标题 / 搜作品号"
          value={keyword}
          data-report-search="1"
          onChange={(e) => setKeyword(e.target.value)}
        />
        <div className="report__pool" data-report-pool-rows={poolRows.length}>
          {poolRows.map(({ anime, used }) => (
            <button
              type="button"
              key={anime.id}
              className={`report__pool-item${used ? ' is-used' : ''}`}
              data-report-pool-item={anime.id}
              data-report-pool-used={used ? '1' : '0'}
              title={used ? '已经在封面墙里了' : (wallTarget ? '加进封面墙' : '新建一墙并加进去')}
              onClick={() => onAddToWall?.(String(anime.id), wallTarget?.id ?? null)}
            >
              <Cover anime={anime} className="report__pool-cover" />
              <span className="report__pool-name">{anime.titleZh || anime.titleJa || `条目 ${anime.id}`}</span>
            </button>
          ))}
          {poolRows.length === 0 ? <p className="report__hint">这个关键字下没有作品</p> : null}
        </div>
      </aside>

      {/* ───────── 中：画布 ───────── */}
      <div className="report__stage">
        <div className="report__stage-head">
          <span data-report-blocks={stats.blocks}>
            {stats.blocks} 块 · 涉及 {stats.works} 部作品
          </span>
          <span className="report__dim">{seasonLabel || seasonKey} · 宽 {report?.width ?? 0}px</span>

          {/* 缩放控件：默认「适应」，也就是整幅缩到横向不用滚。
              想看细节再点 1:1 —— 那才是原始尺寸，放大超过它没有意义。 */}
          <div className="report__zoom">
            <button
              type="button"
              className="report__zbtn"
              data-report-zoom-out="1"
              title="缩小一点"
              onClick={() => setZoomMode(clampZoom(scale - ZOOM.step))}
            >
              −
            </button>
            <button
              type="button"
              className={`report__zbtn${zoomMode === 'fit' ? ' is-on' : ''}`}
              data-report-zoom-fit="1"
              title="整幅缩到看得见"
              onClick={() => setZoomMode('fit')}
            >
              适应
            </button>
            <span className="report__zoom-val" data-report-zoom-pct={Math.round(scale * 100)}>
              {Math.round(scale * 100)}%
            </span>
            <button
              type="button"
              className="report__zbtn"
              data-report-zoom-in="1"
              title="放大一点"
              onClick={() => setZoomMode(clampZoom(scale + ZOOM.step))}
            >
              ＋
            </button>
            <button
              type="button"
              className="report__zbtn"
              data-report-zoom-full="1"
              title="原始尺寸"
              onClick={() => setZoomMode(1)}
            >
              1:1
            </button>
          </div>

          {blocks.length ? (
            <button type="button" className="report__ghost" data-report-reset="1" onClick={() => onReset?.()}>
              清空重来
            </button>
          ) : null}
        </div>

        {/* 画布本身：1220px 是**逻辑宽度**，外面用 CSS 缩放去适配窗口。
            ⚠️ 缩放只能用 transform，不能用 zoom 改宽度 —— 排版一改，预览就不等于产物了。
            ⚠️ 而且 transform 只能落在**画布外面这层**：导出抓的是 `.report__canvas`
            的 outerHTML，缩放要是写在它身上，导出图就会跟着缩 —— 那才是真的走样。 */}
        <div className="report__scroll" ref={scrollRef}>
          {/* 外层撑缩放后的占位（transform 不改变布局，不撑的话画布会盖住下面的导出栏） */}
          <div
            className="report__fit"
            data-report-fit={scale.toFixed(2)}
            style={fit.h ? { width: `${canvasW * scale}px`, height: `${fit.h * scale}px` } : undefined}
          >
            {/* 内层只负责缩。宽度保持逻辑宽度，高度让内容撑 */}
            <div
              className="report__fit-inner"
              style={{
                width: `${canvasW || 1220}px`,
                ...(scale === 1 ? {} : { transform: `scale(${scale})`, transformOrigin: 'top left' }),
              }}
            >
              <div
                className="report__canvas"
                data-report-canvas="1"
                data-report-canvas-width={report?.width ?? 0}
                style={{ width: `${report?.width ?? 1220}px` }}
                ref={canvasRef}
              >
              {blocks.map((b, i) => (
                <ReportBlock
                  key={b.id}
                  block={b}
                  selected={b.id === selectedId}
                  lookup={lookup}
                  dragging={drag?.id === b.id}
                  dropBefore={Boolean(drag && drag.id !== b.id && drag.to === i)}
                  onSelect={setSelectedId}
                  onRemove={onRemoveBlock}
                  onDragStart={onGripDown}
                />
              ))}

              {blocks.length === 0 ? (
                <div className="report__empty" data-report-empty="1">
                  <p className="report__empty-title">还是一张空画布</p>
                  <p className="report__dim">从下面挑一块开始 —— 一般是先放个标题，再放封面墙</p>
                  <div className="report__add-row">
                    {BLOCK_TYPES.map((t) => (
                      <button
                        type="button"
                        key={t}
                        className="report__add"
                        data-report-add={t}
                        onClick={() => onAddBlock?.(t)}
                      >
                        ＋ {BLOCK_LABELS[t]}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              </div>
            </div>
          </div>
        </div>

        {/* ───────── 下：加块 + 导出 ───────── */}
        <div className="report__bar">
          <div className="report__add-row">
            {BLOCK_TYPES.map((t) => (
              <button
                type="button"
                key={t}
                className="report__add"
                data-report-add={t}
                onClick={() => onAddBlock?.(t)}
              >
                ＋ {BLOCK_LABELS[t]}
              </button>
            ))}
          </div>

          <div className="report__bar-right">
            <span className="report__cover-stat" data-report-cover-cached={coverage?.cached ?? 0} data-report-cover-total={coverage?.total ?? 0}>
              {coverage ? `封面 ${coverage.cached}/${coverage.total}` : '封面 —'}
            </span>
            <button
              type="button"
              className="report__ghost"
              data-report-export-png="1"
              disabled={!canExport}
              onClick={() => onExportPng?.()}
            >
              导出 PNG
            </button>
            <button
              type="button"
              className="report__primary"
              data-report-export-pdf="1"
              disabled={!canExport}
              onClick={() => onExportPdf?.()}
            >
              {exporting ? '正在导出…' : '导出 PDF'}
            </button>
          </div>
        </div>

        {/* 缺图必须**拦住并说明**，不能静默生成 —— 一张缺了 12 个封面的墙
            看着只是「没那么好看」，用户会直接发出去、然后被人指出来。 */}
        {missing > 0 ? (
          <p className="report__gate" data-report-gate={missing}>
            还有 {missing} 张封面没缓存，先导出的话墙上会是色块。在设置 → 本地库里「预热封面」跑一次再来。
          </p>
        ) : null}
        {note ? <p className="report__note" data-report-note="1">{note}</p> : null}
      </div>

      {/* ───────── 右：属性 ───────── */}
      <aside className="report__inspector" data-report-inspector={selected ? selected.type : ''}>
        {selected ? (
          <>
            <div className="report__side-head">
              <strong>{BLOCK_LABELS[selected.type]}</strong>
              {isBlankBlock(selected) ? <span className="report__warn">还是空的</span> : null}
            </div>

            {selected.type === 'header' || selected.type === 'wall' || selected.type === 'award' ? (
              <label className="report__field">
                <span>标题</span>
                <input
                  type="text"
                  data-report-field="title"
                  value={selected.title}
                  onChange={(e) => patchSelected({ title: e.target.value })}
                />
              </label>
            ) : null}

            {selected.type === 'header' ? (
              <label className="report__field">
                <span>副标题</span>
                <input
                  type="text"
                  data-report-field="subtitle"
                  value={selected.subtitle}
                  onChange={(e) => patchSelected({ subtitle: e.target.value })}
                />
              </label>
            ) : null}

            {selected.type === 'text' || selected.type === 'award' ? (
              <label className="report__field">
                <span>正文</span>
                <textarea
                  rows={6}
                  data-report-field="body"
                  value={selected.body}
                  onChange={(e) => patchSelected({ body: e.target.value })}
                />
              </label>
            ) : null}

            {selected.type === 'wall' ? (
              <>
                <label className="report__field">
                  <span>每行几列</span>
                  <select
                    data-report-field="columns"
                    value={selected.columns}
                    onChange={(e) => patchSelected({ columns: Number(e.target.value) })}
                  >
                    {[3, 4, 5, 6, 8, 10].map((n) => <option key={n} value={n}>{n} 列</option>)}
                  </select>
                </label>
                <div className="report__wall-ops">
                  <button
                    type="button"
                    className="report__ghost"
                    data-report-wall-auto={WALL_DEFAULT_COUNT}
                    onClick={() => onPatchBlock?.(selected.id, { subjectIds: autoWallSubjects(pool, WALL_DEFAULT_COUNT) })}
                  >
                    按评分挑 {WALL_DEFAULT_COUNT} 部
                  </button>
                  <button
                    type="button"
                    className="report__ghost"
                    data-report-wall-clear="1"
                    onClick={() => onPatchBlock?.(selected.id, { subjectIds: [] })}
                  >
                    清空这一墙
                  </button>
                </div>
                <div className="report__wall-list" data-report-wall-count={selected.subjectIds.length}>
                  {selected.subjectIds.map((id, i) => {
                    const a = lookup(id);
                    return (
                      <span className="report__chip" key={id}>
                        <button
                          type="button"
                          className="report__chip-x"
                          data-report-wall-remove={id}
                          title="从墙上拿掉"
                          onClick={() => {
                            const next = selected.subjectIds.slice();
                            next.splice(i, 1);
                            onPatchBlock?.(selected.id, { subjectIds: next });
                          }}
                        >
                          ✕
                        </button>
                        {a ? (a.titleZh || a.titleJa) : `作品 ${id} 查不到`}
                      </span>
                    );
                  })}
                  {selected.subjectIds.length >= WALL_MAX ? (
                    <span className="report__warn">到 {WALL_MAX} 部的上限了</span>
                  ) : null}
                </div>
              </>
            ) : null}

            {selected.type === 'award' ? (
              <label className="report__field">
                <span>关联作品（可选）</span>
                <select
                  data-report-field="subjectId"
                  value={selected.subjectId}
                  onChange={(e) => patchSelected({ subjectId: e.target.value })}
                >
                  <option value="">不关联</option>
                  {pool.slice(0, 200).map((a) => (
                    <option key={a.id} value={String(a.id)}>
                      {a.titleZh || a.titleJa || `条目 ${a.id}`}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <div className="report__order">
              <button
                type="button"
                className="report__ghost"
                data-report-up="1"
                disabled={selIndex <= 0}
                onClick={() => onMoveBlock?.(selIndex, selIndex - 1)}
              >
                ↑ 上移
              </button>
              <button
                type="button"
                className="report__ghost"
                data-report-down="1"
                disabled={selIndex >= blocks.length - 1}
                onClick={() => onMoveBlock?.(selIndex, selIndex + 1)}
              >
                ↓ 下移
              </button>
              <button
                type="button"
                className="report__danger"
                data-report-remove-sel="1"
                onClick={() => { onRemoveBlock?.(selected.id); setSelectedId(null); }}
              >
                删掉这块
              </button>
            </div>
          </>
        ) : (
          <p className="report__hint" data-report-no-selection="1">
            点画布上的一块来改它。拖左边的 ⋮⋮ 可以换顺序。
          </p>
        )}
      </aside>
    </div>
  );
}
