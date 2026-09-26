import React from 'react';
import Cover from './Cover.jsx';
import { isMissing, wallItems } from '../core/report.js';

/**
 * 报告画布上的一块。
 *
 * ## 为什么预览和导出必须是同一份 DOM
 *
 * 这一版把导出交给主进程的 `printToPDF`（阶段 0 验过：中文走 CID 字体嵌进去、
 * 超长页的 MediaBox 就是 1220×9000 像素）。那意味着**画布上这份 DOM 就是产物本身**，
 * 导出只是把它交给 Chromium 再打一遍。这是「预览好看、导出走样」这类问题
 * 唯一的根治办法 —— 两条渲染路径一旦分开，迟早会分叉。
 *
 * 所以这里没有任何「导出专用」的样式分支，`@media print` 里也不再改版式。
 *
 * ## 每块都带 data-*
 *
 * `data-report-block`（id）、`data-block-type`、`data-report-sel` ——
 * 无头环境下的验收全靠这几个属性定位。截图里「块没渲染出来」和「块渲染了但是空的」
 * 长得一模一样，只有数得出来的东西才能区分。
 */
export default function ReportBlock({
  block,
  selected = false,
  lookup = () => null,
  dragging = false,
  dropBefore = false,
  onSelect,
  onRemove,
  onDragStart,
}) {
  const sel = selected ? '1' : '0';
  const cls = [
    'rb',
    `rb--${block.type}`,
    selected ? 'is-sel' : '',
    dragging ? 'is-dragging' : '',
    dropBefore ? 'is-drop-before' : '',
  ].filter(Boolean).join(' ');

  const { items, missing } = block.type === 'wall' ? wallItems(block, lookup) : { items: [], missing: [] };
  // 和封面墙同一个判断：上层查不到时给的是「占位条目」不是 null，
  // 直接拿去画的话会渲染出一张空封面，「查不到」那句提示反而永远不出现。
  const awardRaw = block.type === 'award' && block.subjectId ? lookup(block.subjectId) : null;
  const awardAnime = isMissing(awardRaw) ? null : awardRaw;

  return (
    <section
      className={cls}
      data-report-block={block.id}
      data-block-type={block.type}
      data-report-sel={sel}
      onMouseDown={() => onSelect?.(block.id)}
    >
      {/* 拖拽把手和删除按钮都要 stopPropagation：不然「选中」会把「开始拖」吃掉 */}
      <span
        className="rb__grip"
        data-report-grip={block.id}
        title="拖动排序"
        onPointerDown={(e) => { e.stopPropagation(); onDragStart?.(block.id, e); }}
      >
        ⋮⋮
      </span>
      <button
        type="button"
        className="rb__x"
        data-report-remove={block.id}
        title="删掉这一块"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onRemove?.(block.id); }}
      >
        ✕
      </button>

      {block.type === 'header' ? (
        <header className="rb-head">
          <h1 className="rb-head__title" data-report-title>{block.title || '（没写标题）'}</h1>
          {block.subtitle ? <p className="rb-head__sub">{block.subtitle}</p> : null}
        </header>
      ) : null}

      {block.type === 'wall' ? (
        <div className="rb-wall">
          {block.title ? <h2 className="rb-wall__title">{block.title}</h2> : null}
          <div
            className="rb-wall__grid"
            data-report-wall-tiles={items.length}
            style={{ gridTemplateColumns: `repeat(${block.columns}, 1fr)` }}
          >
            {items.map((anime) => (
              <figure className="rb-wall__tile" data-report-wall-tile={anime.id} key={anime.id}>
                <Cover anime={anime} className="rb-wall__cover" />
                <figcaption className="rb-wall__cap">
                  {anime.titleZh || anime.titleJa || `条目 ${anime.id}`}
                </figcaption>
              </figure>
            ))}
            {/* 查不到资料的作品要**显式留位**：静默少几格的话，用户会以为墙本来就只放了这些 */}
            {missing.map((id) => (
              <figure className="rb-wall__tile rb-wall__tile--missing" data-report-wall-missing={id} key={`m-${id}`}>
                <div className="rb-wall__cover rb-wall__cover--missing" data-cover="none">?</div>
                <figcaption className="rb-wall__cap">作品 {id} 查不到</figcaption>
              </figure>
            ))}
          </div>
          {items.length === 0 && missing.length === 0 ? (
            <p className="rb__hint" data-report-wall-empty="1">这一墙还空着 —— 右边素材面板挑几部加进来</p>
          ) : null}
        </div>
      ) : null}

      {block.type === 'award' ? (
        <div className="rb-award">
          <h2 className="rb-award__title">{block.title || '（没写奖项名）'}</h2>
          <div className="rb-award__row">
            {awardAnime ? <Cover anime={awardAnime} className="rb-award__cover" /> : null}
            <p className="rb-award__body" data-report-body>{block.body || '（还没写）'}</p>
          </div>
          {block.subjectId && !awardAnime ? (
            <p className="rb__hint" data-report-award-missing={block.subjectId}>
              指定的作品 {block.subjectId} 查不到资料，先只显示文字
            </p>
          ) : null}
        </div>
      ) : null}

      {block.type === 'text' ? (
        <div className="rb-text" data-report-body>
          {(block.body || '（还没写）').split('\n').map((line, i) => (
            // 行号当 key 是安全的：段落只增删整体，不会有「插一条打乱后面所有 key」的情况
            // eslint-disable-next-line react/no-array-index-key
            <p className="rb-text__line" key={i}>{line || '\u00a0'}</p>
          ))}
        </div>
      ) : null}
    </section>
  );
}
