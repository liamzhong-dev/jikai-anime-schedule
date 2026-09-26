import React, { useState } from 'react';
import TierItem from './TierItem.jsx';
import { readableInk } from '../core/palette.js';

/**
 * 一档一行。
 *
 * 标签可改字改色：**改字用行内 input，不用 window.prompt** ——
 * Electron 里 prompt 存在但一调用就抛（「prompt() is and will not be supported」），
 * 在浏览器里又是好好的，属于「换个壳才炸」的那类坑。
 *
 * 落点提示是一根竖线，位置由拖拽 hook 算出的 index 决定。
 * 没有提示的话，用户只能靠「松手之后图块跳到哪」去猜，手感很差。
 */
export default function TierRow({
  row,
  items = [],
  lookup,
  images = {},
  insert = null,
  registerRow,
  onBeginDrag,
  onRemove,
  onRename,
  onRecolor,
  /*
   * 删档只在「自定义」下露出来。
   * 预设档位是成套的，随便删掉中间一档会让 items 里的 rowId 悬空；
   * 而用户选自定义的时候，他心里想的就是「这张表由我定」。
   */
  editable = false,
  canDelete = false,
  onDelete,
  remote = false,
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.label);

  const showInsert = insert && insert.rowId === row.id;
  const ink = readableInk(row.color);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== row.label) onRename?.(row.id, next);
    else setDraft(row.label);
  };

  return (
    // data-row 是给拖拽模拟脚本用的稳定钩子 —— 拿 class 找行太脆
    <div className={`tier-row${showInsert ? ' is-target' : ''}`} data-row={row.id}>
      <div
        className="tier-row__label"
        style={{ background: row.color, color: ink }}
        onDoubleClick={() => { setDraft(row.label); setEditing(true); }}
        title="双击改名字 · 点下方色块改颜色"
      >
        {editing ? (
          <input
            className="tier-row__input"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') { setDraft(row.label); setEditing(false); }
            }}
          />
        ) : (
          <span className="tier-row__text">{row.label}</span>
        )}
        <span className="tier-row__count">{items.length}</span>
        <input
          className="tier-row__color"
          type="color"
          value={/^#[0-9a-fA-F]{6}$/.test(row.color) ? row.color : '#9aa0a6'}
          onChange={(e) => onRecolor?.(row.id, e.target.value)}
          title="改颜色"
        />
        {editable ? (
          <button
            type="button"
            className="tier-row__del"
            data-row-del={row.id}
            disabled={!canDelete}
            title={canDelete
              ? '删掉这一档（里面的图块会回到素材池，不会丢）'
              : '只剩最后一档了，至少留两个'}
            // 双击按钮不该顺带把上面那层「双击改名」的输入框叫出来
            onDoubleClick={(e) => e.stopPropagation()}
            onClick={() => onDelete?.(row.id)}
          >
            ✕
          </button>
        ) : null}
      </div>

      <div
        className="tier-row__body"
        ref={registerRow(row.id)}
        data-count={items.length}
      >
        {items.map((it, i) => (
          <React.Fragment key={it.key}>
            {showInsert && insert.index === i ? <span className="tier-row__insert" /> : null}
            <TierItem
              anime={lookup?.[it.key] ?? { id: it.key, titleZh: it.label ?? `条目 ${it.key}` }}
              image={images[it.key] ?? null}
              remote={remote}
              dragging={false}
              onPointerDown={(e) => onBeginDrag?.(e, { key: it.key, rowId: row.id })}
              onRemove={() => onRemove?.(it.key)}
            />
          </React.Fragment>
        ))}
        {showInsert && insert.index >= items.length ? <span className="tier-row__insert" /> : null}
        {items.length === 0 && !showInsert ? <span className="tier-row__empty">拖到这里</span> : null}
      </div>
    </div>
  );
}
