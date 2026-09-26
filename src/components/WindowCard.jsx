import React, { useEffect, useRef, useState } from 'react';
import { setLayout } from '../core/store.js';
import { fitRect } from '../core/layout.js';
import { useCardScaleToggle } from './ScaleDock.jsx';

/**
 * 卡片式窗口：拖标题栏移动、双击标题栏最大化、按钮折叠。
 *
 * ⚠️ **不做缩放了**（这一轮去掉的）。八方向把手做过一轮，去掉不是因为它写不出来，
 * 而是因为它**没有用**：卡片窗口能拉大，里面的封面和字还是原来那么大 ——
 * 用户真正想要的是「换个大小看」，那是**内容**的比例，不是窗口的比例。
 * 那件事现在归设置里的「封面尺寸 / 文字大小」管（见 SettingsPanel 的显示分组）。
 * 留着八条边，只会多出一层到处都能抓到、一拖就把版面弄乱的把手。
 *
 * 拖动期间只动本地 state，松手才写回 store —— 否则每帧都会触发一次全局重渲染
 * 与一次落盘，拖起来会发涩。
 */
export default function WindowCard({ id, title, hint, actions, children, defaultRect, layout }) {
  const saved = layout?.[id];
  const initial = saved ?? defaultRect ?? { x: 16, y: 16, w: 640, h: 420 };

  const [rect, setRect] = useState(initial);
  const [dragging, setDragging] = useState(false);
  const [maxed, setMaxed] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  /*
   * `maxed` 的一份 ref 副本。
   * 下面那个「外部摆位变了要同步」的 effect 需要读它，而把 `maxed` 写进依赖
   * 会让 effect 在每次最大化时都跑一遍 —— 那正好会把它自己刚设的状态又推翻。
   */
  const maxedRef = useRef(false);
  // 拿不到 context（组件被单独渲染）就没有这个按钮 —— 宁可没有，也不要一个点了没反应的按钮
  const toggleScale = useCardScaleToggle();
  const drag = useRef(null);
  const restore = useRef(null);
  const rootRef = useRef(null);
  const fitted = useRef(false);

  /*
   * 外部改了摆位（切换布局预设、一键整理排列）时同步一次。
   *
   * ⚠️ **处在最大化时必须顺便退出最大化**：最大化那套样式是 `calc(100%)`，
   * 完全不看 `rect` —— 新的摆位写进来了，窗口却纹丝不动。用户看到的是
   * 「切了模板，别的卡都排好了，就那张全屏的一动没动」，像是预设对它没生效。
   * 更糟的是 `restore` 里还压着**旧的**位置：等他点「还原」，卡片会跳回
   * 模板之前的那个地方 —— 于是两处都错，而且两处都指向「用户刚才拖过」。
   */
  useEffect(() => {
    if (!saved || dragging) return;
    setRect(saved);
    if (maxedRef.current) {
      maxedRef.current = false;
      restore.current = null;
      setMaxed(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved?.x, saved?.y, saved?.w, saved?.h]);

  /*
   * 首次挂载：默认摆位装不下就缩进来。
   *
   * 只在「这张卡用户还没摆过」时做一次（`saved` 为空）—— 已经摆过的是用户的
   * 选择，哪怕他把卡片拖到画布外面也不该被纠正（多屏、临时挪开都很正常）。
   * 不落盘：窗口重新变宽之后，默认摆位又该是原来的大小。
   *
   * ⚠️ 窗口不能缩放之后这一步反而更必要：默认摆位是按 1440 宽的窗口定的
   * （见 layoutPresets.js），窄窗下卡片比画布还宽 ——
   * 而用户现在**没有任何办法**自己把它缩回来（以前至少能拖右下角）。
   */
  useEffect(() => {
    if (fitted.current || saved) return;
    fitted.current = true;
    const parent = rootRef.current?.parentElement;
    if (!parent) return;
    setRect((r) => {
      // 画布有 16px 内边距，而 absolute 定位的参照是 padding box，所以要减掉
      const next = fitRect(r, {
        availW: parent.clientWidth - r.x - 16,
        availH: parent.clientHeight - r.y - 16,
      });
      return next.w === r.w && next.h === r.h ? r : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  useEffect(() => {
    if (!dragging) return undefined;

    const onMove = (e) => {
      const d = drag.current;
      if (!d) return;
      setRect({
        ...d.base,
        x: Math.max(0, d.base.x + (e.clientX - d.sx)),
        y: Math.max(0, d.base.y + (e.clientY - d.sy)),
      });
    };
    const onUp = () => {
      setDragging(false);
      setRect((r) => {
        setLayout(id, r);
        return r;
      });
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [dragging, id]);

  const start = () => (e) => {
    e.preventDefault();
    e.stopPropagation();
    drag.current = { sx: e.clientX, sy: e.clientY, base: { ...rect } };
    setDragging(true);
  };

  const toggleMax = () => {
    if (maxed && restore.current) {
      setRect(restore.current);
      setLayout(id, restore.current);
      restore.current = null;
      maxedRef.current = false;
      setMaxed(false);
    } else {
      restore.current = { ...rect };
      maxedRef.current = true;
      setMaxed(true);
    }
  };

  const style = maxed
    ? { left: 12, top: 12, width: 'calc(100% - 24px)', height: 'calc(100% - 24px)' }
    : { left: rect.x, top: rect.y, width: rect.w, height: collapsed ? 44 : rect.h };

  const cls = ['window'];
  if (maxed) cls.push('window--max');
  if (dragging) cls.push('window--dragging');

  return (
    /*
     * `data-window-id` 与 `data-maxed`：桌面端自检靠它们认「这张卡是谁、现在是不是全屏」。
     * 不去读 `'window--max'` 那个类名 —— 类名是给 CSS 的，哪天改个样式这条断言就静默失效，
     * 而且失效的样子是「永远通过」，比报错坏得多。
     */
    <section className={cls.join(' ')} style={style} ref={rootRef} data-window-id={id} data-maxed={maxed ? '1' : '0'}>
      <header
        className="window__bar"
        onPointerDown={start()}
        onDoubleClick={toggleMax}
      >
        <span className="window__title">{title}</span>
        {hint ? <span className="window__hint">{hint}</span> : null}
        <div className="window__actions" onPointerDown={(e) => e.stopPropagation()}>
          {actions}
          {toggleScale ? (
            <button
              type="button"
              className="window__btn window__btn--scale"
              data-card-scale="1"
              title="内容大小 —— 封面与文字的比例"
              onClick={toggleScale}
            >
              Aa
            </button>
          ) : null}
          <button
            type="button"
            className="window__btn"
            title={collapsed ? '展开' : '折叠'}
            onClick={() => setCollapsed((v) => !v)}
          >
            {collapsed ? '▣' : '—'}
          </button>
          <button type="button" className="window__btn" title={maxed ? '还原' : '最大化'} onClick={toggleMax}>
            {maxed ? '❐' : '□'}
          </button>
        </div>
      </header>

      {!collapsed && <div className="window__body">{children}</div>}
    </section>
  );
}
