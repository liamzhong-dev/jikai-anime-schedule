import React from 'react';
import Cover from './Cover.jsx';
import { awardCoverSize, blockCaption, blockFontScale, isMissing, wallItems } from '../core/report.js';
import { customKeyOf, isCustomKey } from '../core/customImages.js';

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
 * 唯一一处例外是「空块提示」：它用 `body:not(.print)` 关掉（见 styles.css），
 * 因为那是给**编辑时**看的指路文案，不该印到成品上。
 *
 * ## 空的一律不画
 *
 * 「（还没写）」「（没写标题）」这类占位以前是画上去的，结果导出图里也带着它们 ——
 * 用户拿到一张写着「还没写」的长图，只能自己再去修图。现在改成：
 * 没有内容就**整个节点不渲染**，画布上只留一句很淡的提示（仅编辑态可见）。
 * 导出那份文档是 `body.print`，提示不会出现。
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
  const blank = isRenderedBlank(block);
  const cls = [
    'rb',
    `rb--${block.type}`,
    selected ? 'is-sel' : '',
    blank ? 'is-blank' : '',
    dragging ? 'is-dragging' : '',
    dropBefore ? 'is-drop-before' : '',
  ].filter(Boolean).join(' ');

  const { items, missing } = block.type === 'wall' ? wallItems(block, lookup) : { items: [], missing: [] };
  // 和封面墙同一个判断：上层查不到时给的是「占位条目」不是 null，
  // 直接拿去画的话会渲染出一张空封面，「查不到」那句提示反而永远不出现。
  const awardRaw = block.type === 'award' && (block.subjectId || block.imageFile)
    ? lookup(block.subjectId || customKeyOf(block.imageFile))
    : null;
  const awardAnime = isMissing(awardRaw) ? null : awardRaw;

  // 图片块：自定义图也走 lookup（拿到的是「假条目」，cover 里就是 dataUrl），
  // 这样它和封面墙共用同一条取图路径，不用为它再开一条。
  const imageAnime = block.type === 'image' && block.imageFile
    ? lookup(customKeyOf(block.imageFile))
    : null;
  const imageSrc = imageAnime && !isMissing(imageAnime) ? (imageAnime.cover || '') : '';
  const imageName = block.type === 'image' ? blockCaption(block, imageAnime) : '';
  const awardName = block.type === 'award' ? blockCaption(block, awardAnime) : '';

  /*
   * 封面宽度与字号倍率走 **inline 的 CSS 变量**。
   *
   * 为什么必须是 inline：导出是**抓画布这份 DOM** 另存一份 HTML 再打一张，
   * 变量跟着 DOM 走，产物才会跟着变；写成 class 或挂到全局设置上，
   * 导出那份文档拿不到这一块的值 —— 于是「界面上调好了、导出又回到默认」。
   */
  const blockStyle = {
    '--rb-cover': `${awardCoverSize(block)}px`,
    '--rb-fs': blockFontScale(block),
  };

  return (
    <section
      className={cls}
      data-report-block={block.id}
      data-block-type={block.type}
      data-report-sel={sel}
      data-report-blank={blank ? '1' : '0'}
      data-report-cover-size={block.type === 'award' ? awardCoverSize(block) : ''}
      data-report-font-scale={blockFontScale(block)}
      style={blockStyle}
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
          {block.title ? <h1 className="rb-head__title" data-report-title>{block.title}</h1> : null}
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
          {block.title ? <h2 className="rb-award__title">{block.title}</h2> : null}
          {awardAnime ? (
            <figure className="rb-award__figure">
              <Cover anime={awardAnime} className="rb-award__cover" />
              {awardName ? <figcaption className="rb-award__cap">{awardName}</figcaption> : null}
            </figure>
          ) : null}
          {block.body ? (
            <div className="rb-award__body" data-report-body>
              {block.body.split('\n').map((line, i) => (
                // eslint-disable-next-line react/no-array-index-key
                <p className="rb-text__line" key={i}>{line || '\u00a0'}</p>
              ))}
            </div>
          ) : null}
          {block.subjectId && !block.imageFile && !awardAnime ? (
            <p className="rb__hint" data-report-award-missing={block.subjectId}>
              指定的作品 {block.subjectId} 查不到资料，先只显示文字
            </p>
          ) : null}
        </div>
      ) : null}

      {block.type === 'image' ? (
        <div className="rb-image">
          {block.title ? <h2 className="rb-image__title">{block.title}</h2> : null}
          {/*
            宽度是**档位**给的百分比，图居中放 —— 插画有横有竖，
            统一按 1:1.4 裁（像封面那样）会把横图裁得只剩中间一条。
          */}
          <figure
            className="rb-image__figure"
            style={{ width: `${block.size}%` }}
            data-report-image-file={block.imageFile}
          >
            {imageSrc ? (
              <img className="rb-image__img" src={imageSrc} alt="" data-report-image="1" />
            ) : (
              <div className="rb-image__empty" data-report-image-empty={block.imageFile ? '1' : '0'}>
                {block.imageFile ? '这张图还没读出来' : '还没挑图 —— 右边选一张'}
              </div>
            )}
            {imageName ? <figcaption className="rb-image__cap">{imageName}</figcaption> : null}
          </figure>
          {block.body ? (
            <div className="rb-image__body" data-report-body>
              {block.body.split('\n').map((line, i) => (
                // eslint-disable-next-line react/no-array-index-key
                <p className="rb-text__line" key={i}>{line || '\u00a0'}</p>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {block.type === 'text' ? (
        <div className="rb-text" data-report-body>
          {block.body ? block.body.split('\n').map((line, i) => (
            // 行号当 key 是安全的：段落只增删整体，不会有「插一条打乱后面所有 key」的情况
            // eslint-disable-next-line react/no-array-index-key
            <p className="rb-text__line" key={i}>{line || '\u00a0'}</p>
          )) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * 这一块是不是「什么都还没填」。
 *
 * 导出的长图里不该出现「（还没写）」，但**编辑时**得让人看见这块是空的 ——
 * 否则他只会看到一段莫名其妙的留白，不知道是块坏了还是自己没填。
 */
export function isRenderedBlank(block) {
  if (block.type === 'header') return !block.title && !block.subtitle;
  if (block.type === 'wall') return (block.subjectIds?.length ?? 0) === 0;
  if (block.type === 'award') return !block.title && !block.body && !block.subjectId && !block.imageFile;
  if (block.type === 'image') return !block.imageFile && !block.title && !block.caption && !block.body;
  return !block.body;
}

/** 给「素材面板里这一项是不是自定义图」用：`img:` 开头的键走另一套删除 */
export function isCustomEntry(id) {
  return isCustomKey(id);
}
