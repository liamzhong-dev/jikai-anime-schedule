import React, { useMemo, useState } from 'react';
import TierPicker from './TierPicker.jsx';
import TierRow from './TierRow.jsx';
import TierItem from './TierItem.jsx';
import { ITEM_SIZES, PRESET_ROW_GROUPS, moveItem } from '../core/tierlist.js';
import { useDragSort } from '../core/useDragSort.js';

/**
 * Tier List 主视图：左侧素材池 + 右侧档位表 + 顶部工具栏。
 *
 * 这一层**不碰 store、不碰 canvas**：所有改动都变成 `patch({ items / rows })` 交上去，
 * 导出交给 `core/tierExport.js`。界面只负责把鼠标坐标喂给 `useDragSort`、
 * 把算出来的档位与序号画出来。
 *
 * 一个容易忽略的点：素材池里已经排进档位的番剧要消失。
 * 不筛掉的话同一部番能被拖两次，表里出现两个一模一样的图块，
 * 而 `moveItem` 是按 key 找的，结果就是「拖了看不见」。
 */
export default function TierListView({
  seasonKey,
  tierlist,
  pool = [],
  images = {},
  coversNote = '',
  onPatch,
  onAutoRank,
  onReset,
  onExport,
  exporting = false,
  exportNote = '',
  // 搜索词做成「可受控也可不受控」：App 里不传，自己管状态；
  // 渲染测试要钉住「过滤之后池子里到底剩几个」，就必须能把关键词喂进来。
  keyword: keywordProp,
  onKeyword: onKeywordProp,
  coversRemote = false,
}) {
  const [keywordState, setKeywordState] = useState('');
  const keyword = keywordProp ?? keywordState;
  const setKeyword = onKeywordProp ?? setKeywordState;
  const tile = ITEM_SIZES[tierlist.itemSize] ?? ITEM_SIZES.poster;

  const rows = tierlist.rows ?? [];
  const items = tierlist.items ?? [];

  const lookup = useMemo(() => {
    const m = {};
    for (const a of pool) m[String(a.id)] = a;
    return m;
  }, [pool]);

  const placed = useMemo(() => new Set(items.map((it) => it.key)), [items]);

  const poolLeft = useMemo(() => {
    const k = keyword.trim().toLowerCase();
    return pool
      .filter((a) => !placed.has(String(a.id)))
      .filter((a) => (
        !k
        || [a.titleZh, a.titleJa, a.studio].filter(Boolean).some((s) => String(s).toLowerCase().includes(k))
      ));
  }, [pool, placed, keyword]);

  const handleDrop = ({ key, toRow, index }) => {
    onPatch?.({ items: moveItem(items, { key, toRow, index }) });
  };

  const dragApi = useDragSort({
    itemW: tile.w,
    itemH: tile.h,
    gap: 8,
    onDrop: handleDrop,
  });
  const { drag, begin, registerRow, registerPool } = dragApi;

  const insert = drag && !drag.overPool && drag.toRow
    ? { rowId: drag.toRow, index: drag.index }
    : null;

  const patchRows = (nextRows) => onPatch?.({ rows: nextRows });

  const dragAnime = drag ? lookup[drag.key] : null;

  return (
    <div className="tier">
      <div className="tier__bar">
        <span className="toolbar__label">档位组</span>
        <select
          className="input tier__select"
          value={tierlist.presetId ?? ''}
          onChange={(e) => {
            const preset = PRESET_ROW_GROUPS.find((p) => p.id === e.target.value);
            if (!preset) return;
            // 三套预设的行 id 都是 r1~r7，换组只换名字和颜色，
            // 已经排好的图块一个都不用动。
            onPatch?.({ rows: preset.rows.map((r) => ({ ...r })), presetId: preset.id });
          }}
        >
          {PRESET_ROW_GROUPS.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>

        <button type="button" className="btn btn--mini" onClick={() => onAutoRank?.()}>
          按评分自动分档
        </button>
        <button type="button" className="btn btn--mini" onClick={() => onReset?.()}>
          清空
        </button>
        <button
          type="button"
          className="btn btn--mini btn--primary"
          onClick={() => onExport?.()}
          disabled={exporting}
        >
          {exporting ? '正在导出…' : '导出 PNG'}
        </button>

        <span className="tier__spacer" />
        {coversNote ? <span className="tier__note">{coversNote}</span> : null}
        {exportNote ? <span className="tier__note">{exportNote}</span> : null}
      </div>

      <div className="tier__body">
        <TierPicker
          pool={poolLeft}
          images={images}
          keyword={keyword}
          onKeyword={setKeyword}
          registerPool={registerPool}
          onBeginDrag={begin}
          onPick={(a) => onPatch?.({ items: moveItem(items, { key: String(a.id), toRow: rows[0]?.id }) })}
          hint={pool.length ? `本季 ${pool.length} 部 · 已排 ${placed.size} 部` : ''}
          dropping={Boolean(drag?.overPool)}
          remote={coversRemote}
        />

        <div className="tier__board">
          {rows.map((row) => (
            <TierRow
              key={row.id}
              row={row}
              items={items.filter((it) => it.rowId === row.id)}
              lookup={lookup}
              images={images}
              insert={insert}
              registerRow={registerRow}
              onBeginDrag={begin}
              onRemove={(key) => onPatch?.({ items: moveItem(items, { key, toRow: null }) })}
              onRename={(rowId, label) => patchRows(rows.map((r) => (r.id === rowId ? { ...r, label } : r)))}
              onRecolor={(rowId, color) => patchRows(rows.map((r) => (r.id === rowId ? { ...r, color } : r)))}
              remote={coversRemote}
            />
          ))}
        </div>
      </div>

      {drag && dragAnime ? (
        <div
          className="tier-ghost"
          style={{ left: drag.x, top: drag.y }}
        >
          <TierItem anime={dragAnime} image={images[dragAnime.cover] ?? null} ghost />
        </div>
      ) : null}
    </div>
  );
}
