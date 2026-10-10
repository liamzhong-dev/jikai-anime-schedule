import React, { useMemo, useState } from 'react';
import TierPicker from './TierPicker.jsx';
import TierRow from './TierRow.jsx';
import TierItem from './TierItem.jsx';
import { ITEM_SIZES, PRESET_ROW_GROUPS, CUSTOM_PRESET_ID, ROW_LIMITS, addRow, isCustomPreset, moveItem, removeRow, unassignRow } from '../core/tierlist.js';
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
  onAddImage,
  imageBusy = false,
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

  /*
   * 自定义模板。
   *
   * ⚠️ 「改一行」和「换一套」是两件事，这里靠 `presetId` 分开：
   * 只要用户动过任何一行（改名、改色、加档、删档），这份表就**不再是那个预设**了，
   * 于是把 presetId 标成 custom —— 否则下拉里一直写着「Masterpiece ~ E」，
   * 而表上挂的是用户自己起的名，下次换回同一套预设还会把他的改动冲掉。
   * 已经是 custom 的就别覆盖（那会把「自定义」标成别的预设）。
   */
  const custom = isCustomPreset(tierlist.presetId);
  const markCustom = (patch) => onPatch?.({ ...patch, presetId: CUSTOM_PRESET_ID });

  const handleAddRow = () => {
    const { rows: next, added } = addRow(rows);
    if (!added) return;
    markCustom({ rows: next });
  };

  /**
   * 删一档：行和它里面的图块**必须一起改**。
   * 只删行的话，items 里那批图块会变成指向不存在档位的悬空引用 ——
   * 界面当场看着像没事（渲染时按 rowId 过滤掉了），下次读盘 normalize 时被静默丢掉。
   */
  const handleRemoveRow = (rowId) => {
    const { rows: next, removed } = removeRow(rows, rowId);
    if (!removed) return;
    markCustom({ rows: next, items: unassignRow(items, rowId) });
  };

  const dragAnime = drag ? lookup[drag.key] : null;

  return (
    <div className="tier">
      <div className="tier__bar">
        <span className="toolbar__label">档位组</span>
        <select
          className="input tier__select"
          value={tierlist.presetId ?? ''}
          onChange={(e) => {
            /*
             * 选「自定义」**不动任何一行** —— 它只是把这份表标成自定义，
             * 好让下面那些加档/删档的按钮出现。用户选它的时候，
             * 表上正摆着他自己的档位，这时候拿一份默认行去覆盖是最糟的反应。
             */
            if (e.target.value === CUSTOM_PRESET_ID) {
              onPatch?.({ presetId: CUSTOM_PRESET_ID });
              return;
            }
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
          <option value={CUSTOM_PRESET_ID}>自定义</option>
        </select>

        {custom ? (
          <>
            <button
              type="button"
              className="btn btn--mini"
              onClick={handleAddRow}
              disabled={rows.length >= ROW_LIMITS.max}
              title={rows.length >= ROW_LIMITS.max ? `最多 ${ROW_LIMITS.max} 档` : '在最下面加一档'}
            >
              + 加一档
            </button>
            <span className="tier__note">
              双击档位名改字 · 点色块改色 · 每档右边的 ✕ 删档（里面的图块会回到素材池）
            </span>
          </>
        ) : null}

        {/*
          自定义图片：档位表里不是只能放本季的番 ——
          想给某张官方视觉图、某张插画排个位置，也该排得进去。
        */}
        <button
          type="button"
          className="btn btn--mini"
          data-tier-add-image="1"
          disabled={imageBusy}
          onClick={() => onAddImage?.()}
        >
          {imageBusy ? '正在读图…' : '＋ 自定义图片'}
        </button>
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
              onRename={(rowId, label) => markCustom({ rows: rows.map((r) => (r.id === rowId ? { ...r, label } : r)) })}
              onRecolor={(rowId, color) => markCustom({ rows: rows.map((r) => (r.id === rowId ? { ...r, color } : r)) })}
              editable={custom}
              canDelete={rows.length > ROW_LIMITS.min}
              onDelete={handleRemoveRow}
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
          <TierItem anime={dragAnime} image={images[String(dragAnime.id)] ?? null} ghost />
        </div>
      ) : null}
    </div>
  );
}
