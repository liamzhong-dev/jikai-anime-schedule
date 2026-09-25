/**
 * Tier List 纯函数层测试。
 *
 * 这一批要守的是三类「想当然就会写错」的地方：
 *   1. 拖拽的落点换算 —— 差一位、跨行丢一个、拖回池子后顺序漂移，都是这类
 *   2. 自动分档的边界 —— 分数线是「>=」还是「>」、没评分的该不该排
 *   3. 导出几何 —— 1x/2x 是否等比、超限判定会不会把能出的图判成不能出
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CANVAS_LIMITS, DEFAULT_ROWS, EXPORT_DEFAULTS, ITEM_SIZES, PRESET_ROW_GROUPS, SCORE_THRESHOLDS,
  autoRankByScore, fitsLimits, insertIndexAt, itemsOfRow, makeDefaultTierlist, measureLayout,
  moveItem, normalizeTierlist, pickScale, poolKeys, removeItem, rowOf, rowStats, tileCrop,
} from '../src/core/tierlist.js';

// ===================== 工具 =====================

/** 造一排等高的档位矩形（界面层由 getBoundingClientRect 喂进来的就是这种形状） */
function rects(counts, { left = 0, top0 = 0, height = 140, gapBetween = 10 } = {}) {
  let top = top0;
  return counts.map((count, i) => {
    const r = { rowId: `r${i + 1}`, left, top, width: 900, height, count };
    top += height + gapBetween;
    return r;
  });
}

/** 造一条素材池条目：只有 id / 标题 / 评分会被用到 */
function anime(id, score) {
  return { id, titleZh: `番剧 ${id}`, score };
}

function keysOfRow(items, rowId) {
  return itemsOfRow(items, rowId).map((it) => it.key);
}

// ===================== 常量与初始结构 =====================

test('预设档位组：每组都是 7 档（换组不能改行数，否则已排好的图块会悬空）', () => {
  assert.equal(PRESET_ROW_GROUPS.length >= 2, true);
  for (const preset of PRESET_ROW_GROUPS) {
    assert.equal(preset.rows.length, 7, `${preset.id} 应当是 7 档`);
    assert.equal(new Set(preset.rows.map((r) => r.id)).size, 7, `${preset.id} 档位 id 不能重复`);
  }
  assert.deepEqual(DEFAULT_ROWS.map((r) => r.id), ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']);
});

test('makeDefaultTierlist：按预设生成，rows 是副本不是共享引用', () => {
  const a = makeDefaultTierlist('2026q3', { nowMs: 1000 });
  const b = makeDefaultTierlist('2026q3', { nowMs: 1000 });
  assert.equal(a.presetId, 'top-drug');
  assert.deepEqual(a.items, []);
  assert.equal(a.itemSize, 'poster');
  assert.equal(a.updatedAt, 1000);

  a.rows[0].label = '改过了';
  assert.equal(b.rows[0].label, 'TOP', '改一份不能影响另一份 —— 否则「换季度」会连带改花别的季度');
});

test('makeDefaultTierlist：预设 id 认不出来时退回默认组，不产出空表', () => {
  const t = makeDefaultTierlist('2026q4', { presetId: '并不存在的组' });
  assert.equal(t.presetId, 'top-drug');
  assert.equal(t.rows.length, 7);
});

test('ITEM_SIZES：海报 1:1.4，角色 1:3', () => {
  assert.equal(Math.round((ITEM_SIZES.poster.h / ITEM_SIZES.poster.w) * 100) / 100, 1.4);
  assert.equal(ITEM_SIZES.character.h / ITEM_SIZES.character.w, 3);
});

// ===================== normalizeTierlist =====================

test('normalizeTierlist：丢掉指向不存在档位的图块、去掉重复 key', () => {
  const out = normalizeTierlist(
    {
      rows: [{ id: 'r1', label: 'A', color: '#ff0000' }],
      items: [
        { key: '1', rowId: 'r1' },
        { key: '1', rowId: 'r1' },   // 重复
        { key: '2', rowId: 'r9' },   // 档位不存在
        { key: '3', rowId: 'r1' },
      ],
    },
    { nowMs: 5 },
  );
  assert.deepEqual(out.items.map((it) => it.key), ['1', '3']);
  assert.equal(out.items.length, 2, '同一个 key 出现两次会让拖拽算出两个落点');
});

test('normalizeTierlist：档位坏了退回默认 7 档，但能救的 items 要救回来', () => {
  const out = normalizeTierlist({ rows: null, items: [{ key: '42', rowId: 'r3' }] }, { nowMs: 7 });
  assert.equal(out.rows.length, 7);
  assert.deepEqual(out.items, [{ key: '42', rowId: 'r3' }], 'r3 在默认档位里存在，不该被丢掉');
});

test('normalizeTierlist：非法颜色与非法 itemSize 各自退回安全值', () => {
  const out = normalizeTierlist(
    { rows: [{ id: 'r1', label: 'A', color: '不是颜色' }], itemSize: '并不存在', items: [] },
    { nowMs: 1 },
  );
  assert.equal(out.rows[0].color, '#9aa0a6');
  assert.equal(out.rows[0].label, 'A', 'label 要留着，只修颜色');
  assert.equal(out.itemSize, 'poster');

  // 'toString' 这种字符串直接查表也是真值（Object 原型上有），会被误认成合法尺寸
  assert.equal(normalizeTierlist({ itemSize: 'toString' }).itemSize, 'poster');
  assert.equal(normalizeTierlist({ itemSize: 'character' }).itemSize, 'character', '合法的要认');
});

test('normalizeTierlist：整个不是对象时给一份能用的空表', () => {
  const out = normalizeTierlist(null, { seasonKey: '2026q3' });
  assert.equal(out.rows.length, 7);
  assert.deepEqual(out.items, []);
  assert.equal(out.seasonKey, '2026q3');
});

// ===================== 查询 =====================

test('itemsOfRow / rowOf / rowStats：档内顺序按数组顺序，不在任何档返回 null', () => {
  const items = [
    { key: 'a', rowId: 'r1' },
    { key: 'b', rowId: 'r2' },
    { key: 'c', rowId: 'r1' },
  ];
  assert.deepEqual(keysOfRow(items, 'r1'), ['a', 'c'], '同档的可以不连续，取的时候要按数组顺序');
  assert.deepEqual(keysOfRow(items, 'r3'), []);
  assert.equal(rowOf(items, 'c'), 'r1');
  assert.equal(rowOf(items, '不在表里的'), null);
  assert.deepEqual(rowStats(items, DEFAULT_ROWS).slice(0, 3), [
    { rowId: 'r1', count: 2 },
    { rowId: 'r2', count: 1 },
    { rowId: 'r3', count: 0 },
  ]);
});

test('poolKeys：已经排进表里的不再出现在素材池', () => {
  const pool = [anime(1, 8), anime(2, 7), anime(3, null)];
  const items = [{ key: '2', rowId: 'r1' }];
  assert.deepEqual(poolKeys(pool, items), ['1', '3']);
});

// ===================== insertIndexAt =====================

test('insertIndexAt：第 0 个 / 中间 / 最后一个，三个边界', () => {
  const rr = rects([3]);
  const hit = (x) => insertIndexAt({ x, y: 10, rowRects: rr, itemW: 100, itemH: 140, gap: 8 });

  assert.deepEqual(hit(0), { rowId: 'r1', index: 0, rowIndex: 0 }, '落在最左边插到最前');
  assert.equal(hit(20).index, 0, '落在第 0 个图块的左半边 → 插到它前面');
  assert.equal(hit(70).index, 1, '落在第 0 个图块的右半边 → 插到它后面');
  assert.equal(hit(1000).index, 3, '超出所有图块 → 挂到末尾（不能越界）');
  assert.equal(hit(-50).index, 0, '负数坐标夹到 0');
});

test('insertIndexAt：跨行拖动命中正确的一行，行间缝隙算最近的那行', () => {
  const rr = rects([2, 1, 0]);
  const hit = (x, y) => insertIndexAt({ x, y, rowRects: rr, itemW: 100, itemH: 140, gap: 8 });

  assert.equal(hit(0, 10).rowId, 'r1');
  assert.equal(hit(0, 160).rowId, 'r2');
  assert.equal(hit(0, 310).rowId, 'r3');
  // 第 r1 高 140，缝隙 10：y=145 落在缝里，tolerance=4 → 归到 r1
  assert.equal(hit(0, 145).rowId, 'r1', '缝隙里要归到最近的一行，不能算作「没命中」');
  assert.equal(hit(0, 148).rowId, 'r2');
  assert.equal(hit(0, -999).rowId, 'r1', '拖到表外上方 → 最近的一行');
  assert.equal(hit(0, 9999).rowId, 'r3', '拖到表外下方 → 最近的一行');
});

test('insertIndexAt：空档永远插到 0；没有 rect 时返回 null；步长退化不会算出 NaN', () => {
  const rr = rects([0, 0]);
  assert.equal(insertIndexAt({ x: 500, y: 10, rowRects: rr, itemW: 100, gap: 8 }).index, 0);
  assert.equal(insertIndexAt({ x: 0, y: 0, rowRects: [] }), null);
  assert.equal(insertIndexAt({}), null);

  const weird = insertIndexAt({ x: 50, y: 0, rowRects: rects([2]), itemW: 0, gap: 0 });
  assert.equal(Number.isFinite(weird.index), true, 'itemW 和 gap 都为 0 时不能算出 Infinity / NaN');
});

// ===================== moveItem =====================

test('moveItem：插到中间 —— index 是「移走之后」的位置', () => {
  const items = [
    { key: 'a', rowId: 'r1' },
    { key: 'b', rowId: 'r1' },
    { key: 'c', rowId: 'r1' },
  ];
  const out = moveItem(items, { key: 'a', toRow: 'r1', index: 1 });
  assert.deepEqual(keysOfRow(out, 'r1'), ['b', 'a', 'c']);
  assert.equal(items.length, 3, '原数组不能被改动');
});

test('moveItem：插到第 0 个与挂到末尾', () => {
  const items = [
    { key: 'a', rowId: 'r1' },
    { key: 'b', rowId: 'r1' },
    { key: 'c', rowId: 'r1' },
  ];
  assert.deepEqual(keysOfRow(moveItem(items, { key: 'c', toRow: 'r1', index: 0 }), 'r1'), ['c', 'a', 'b']);
  assert.deepEqual(keysOfRow(moveItem(items, { key: 'a', toRow: 'r1', index: 2 }), 'r1'), ['b', 'c', 'a']);
  assert.deepEqual(keysOfRow(moveItem(items, { key: 'a', toRow: 'r1', index: 99 }), 'r1'), ['b', 'c', 'a'], '越界要夹到末尾');
});

test('moveItem：跨行拖动既不重复也不丢', () => {
  const items = [
    { key: 'a', rowId: 'r1' },
    { key: 'b', rowId: 'r2' },
    { key: 'c', rowId: 'r1' },
  ];
  const out = moveItem(items, { key: 'a', toRow: 'r2', index: 0 });

  assert.equal(out.length, 3, '总数不变');
  assert.equal(new Set(out.map((it) => it.key)).size, 3, '不能出现重复 key');
  assert.deepEqual(keysOfRow(out, 'r1'), ['c']);
  assert.deepEqual(keysOfRow(out, 'r2'), ['a', 'b']);
});

test('moveItem：拖到一个还空着的档，不是挂到数组最末尾', () => {
  const items = [
    { key: 'a', rowId: 'r1' },
    { key: 'b', rowId: 'r2' },
    { key: 'c', rowId: 'r1' },
    { key: 'd', rowId: 'r2' },
  ];
  // r3 一个都没有 → 只能挂到数组末尾（这一条本来就没得选）
  assert.deepEqual(moveItem(items, { key: 'a', toRow: 'r3', index: 0 }).at(-1).key, 'a');

  // 关键的一条：r1 有两个，越界的 index 要落在 r1 的末尾，而不是数组末尾
  const out = moveItem(items, { key: 'b', toRow: 'r1', index: 99 });
  assert.deepEqual(out.map((it) => it.key), ['a', 'c', 'b', 'd'], 'b 必须紧跟在 r1 的最后一个之后');
  assert.deepEqual(keysOfRow(out, 'r1'), ['a', 'c', 'b']);
});

test('moveItem 与 removeItem：拖回池子后，其余的顺序不漂移', () => {
  const items = [
    { key: 'a', rowId: 'r1' },
    { key: 'b', rowId: 'r1' },
    { key: 'c', rowId: 'r1' },
  ];
  const after = removeItem(items, 'b');
  assert.deepEqual(keysOfRow(after, 'r1'), ['a', 'c']);

  // 再插一个新图块到中间
  const withNew = moveItem(after, { key: 'd', toRow: 'r1', index: 1 });
  assert.deepEqual(keysOfRow(withNew, 'r1'), ['a', 'd', 'c']);

  // b 加回到它原来的位置（index 1）→ 应当完全复原
  const restored = moveItem(after, { key: 'b', toRow: 'r1', index: 1 });
  assert.deepEqual(keysOfRow(restored, 'r1'), ['a', 'b', 'c'], '拖出去再拖回来，顺序要能复原');
});

test('moveItem：toRow 为空 = 移回素材池；key 不存在但给了 toRow 就新建', () => {
  const items = [{ key: 'a', rowId: 'r1' }];
  assert.deepEqual(moveItem(items, { key: 'a', toRow: null }), []);
  assert.deepEqual(moveItem(items, { key: 'a' }), [], '不给 toRow 同样是移回池子');

  const made = moveItem(items, { key: 'x', toRow: 'r2' });
  assert.deepEqual(made, [{ key: 'a', rowId: 'r1' }, { key: 'x', rowId: 'r2' }]);
});

test('moveItem：自定义名字跟着一起搬走', () => {
  const items = [{ key: 'local:1', rowId: 'r1', label: '自定义' }];
  const out = moveItem(items, { key: 'local:1', toRow: 'r3', index: 0 });
  assert.deepEqual(out, [{ key: 'local:1', rowId: 'r3', label: '自定义' }]);
});

// ===================== autoRankByScore =====================

test('autoRankByScore：分数线是「>=」，七档各就各位', () => {
  const pool = [anime(1, 8.0), anime(2, 7.9), anime(3, 7.5), anime(4, 7.0), anime(5, 6.5), anime(6, 6.0), anime(7, 5.0), anime(8, 4.9)];
  const { items, ranked, unranked } = autoRankByScore([], pool, DEFAULT_ROWS);

  assert.deepEqual(keysOfRow(items, 'r1'), ['1'], '8.0 进 TOP（是 >= 不是 >）');
  assert.deepEqual(keysOfRow(items, 'r2'), ['2', '3']);
  assert.deepEqual(keysOfRow(items, 'r3'), ['4']);
  assert.deepEqual(keysOfRow(items, 'r4'), ['5']);
  assert.deepEqual(keysOfRow(items, 'r5'), ['6']);
  assert.deepEqual(keysOfRow(items, 'r6'), ['7']);
  assert.deepEqual(keysOfRow(items, 'r7'), ['8']);
  assert.equal(ranked.length, 8);
  assert.deepEqual(unranked, []);
});

test('autoRankByScore：没有评分的不排（新番没人打分时留在池子里才是对的）', () => {
  const pool = [anime(1, 7.2), anime(2, null), anime(3, 0), anime(4, undefined)];
  const { items, ranked, unranked } = autoRankByScore([], pool, DEFAULT_ROWS);

  assert.deepEqual(ranked, ['1']);
  assert.deepEqual(unranked, ['2', '3', '4'], 'score 为 null / 0 / undefined 都不该被硬塞进最后一档');
  assert.deepEqual(keysOfRow(items, 'r3'), ['1']);
  assert.equal(items.length, 1);
});

test('autoRankByScore：同档内按评分降序，评分相同按 key 升序 —— 连点两次结果一致', () => {
  const pool = [anime(3, 7.6), anime(1, 7.6), anime(2, 7.9)];
  const first = autoRankByScore([], pool, DEFAULT_ROWS).items;
  const second = autoRankByScore(first, pool, DEFAULT_ROWS).items;

  assert.deepEqual(keysOfRow(first, 'r2'), ['2', '1', '3'], '同分要稳定排序，不能每次点出来都不一样');
  assert.deepEqual(first, second, '拿上一次的结果再排一遍，应当完全一样');
});

test('autoRankByScore：不动非番剧图块', () => {
  const existing = [{ key: 'local:ab', rowId: 'r4', label: '自定义' }];
  const pool = [anime(1, 8.5)];
  const { items } = autoRankByScore(existing, pool, DEFAULT_ROWS);

  assert.deepEqual(items[0], { key: 'local:ab', rowId: 'r4', label: '自定义' });
  assert.deepEqual(keysOfRow(items, 'r1'), ['1']);
});

test('autoRankByScore：自定义分数线与少于 7 档时都能work', () => {
  const pool = [anime(1, 9), anime(2, 6), anime(3, 1)];
  const two = [{ id: 'r1' }, { id: 'r2' }];
  const { items } = autoRankByScore([], pool, two, { thresholds: [7] });
  assert.deepEqual(keysOfRow(items, 'r1'), ['1']);
  assert.deepEqual(keysOfRow(items, 'r2'), ['2', '3'], '只有两档时，多出来的分数线要被截掉，剩下的全进最后一档');
  assert.equal(SCORE_THRESHOLDS.length, 6, '默认分数线是 7 档对应的 6 条');
});

// ===================== 导出几何 =====================

test('measureLayout：1x 与 2x 结构一致、尺寸翻倍', () => {
  const rows = DEFAULT_ROWS;
  const items = [
    { key: 'a', rowId: 'r1' },
    { key: 'b', rowId: 'r2' },
  ];
  const one = measureLayout(rows, items, { scale: 1 });
  const two = measureLayout(rows, items, { scale: 2 });

  assert.equal(two.width, one.width * 2);
  assert.equal(two.height, one.height * 2);
  assert.equal(two.rows.length, one.rows.length);
  assert.equal(two.rows[0].items[0].w, one.rows[0].items[0].w * 2);
  assert.equal(two.rows[0].items[0].x, one.rows[0].items[0].x * 2, '坐标要整体等比放大');
});

test('measureLayout：perLine 由画布宽度算出来，放不下就换行', () => {
  const { width, padding, labelWidth, gap } = EXPORT_DEFAULTS;
  const contentW = width - padding * 2 - labelWidth - gap;
  const expected = Math.max(1, Math.floor((contentW + gap) / (ITEM_SIZES.poster.w + gap)));

  const layout = measureLayout(DEFAULT_ROWS, [], { scale: 1 });
  assert.equal(layout.perLine, expected);
  assert.equal(expected, 9, '1200 宽、96 标签列、8 间距 → 一行能放 9 个 100 宽的图块');

  // 12 个塞一行 → 换两行，行高翻倍加一个间距
  const items = Array.from({ length: 12 }, (_, i) => ({ key: `k${i}`, rowId: 'r1' }));
  const wrapped = measureLayout(DEFAULT_ROWS, items, { scale: 1 });
  assert.equal(wrapped.rows[0].lines, 2);
  assert.equal(wrapped.rows[0].height, 2 * ITEM_SIZES.poster.h + gap);
  assert.equal(wrapped.rows[0].items.length, 12, '换行只影响排布，不能丢图块');
  assert.equal(wrapped.rows[0].items[9].y > wrapped.rows[0].items[0].y, true, '第 10 个应当换到第二行');
});

test('measureLayout：图块不会画出画布右边界，空表也给出合理高度', () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ key: `k${i}`, rowId: 'r1' }));
  const layout = measureLayout(DEFAULT_ROWS, items, { scale: 1 });
  for (const it of layout.rows[0].items) {
    assert.equal(it.x + it.w <= layout.width, true, `图块 ${it.key} 越过了右边界`);
  }

  // 空表不等于零行：每一档哪怕没图块，也占一行的高度（不然版面会塌成一条）
  const empty = measureLayout(DEFAULT_ROWS, [], { scale: 1 });
  const { padding, rowGap } = EXPORT_DEFAULTS;
  assert.equal(empty.height, padding * 2 + DEFAULT_ROWS.length * (ITEM_SIZES.poster.h + rowGap) - rowGap);
  assert.equal(empty.rows.every((r) => r.items.length === 0 && r.lines === 1), true);

  const noRows = measureLayout([], [], { scale: 1 });
  assert.equal(noRows.height, padding * 2, '一档都没有时才只剩上下留白');
  assert.deepEqual(noRows.rows, []);
});

test('fitsLimits：单边 16384 与面积 2.68 亿像素两条线都要卡住', () => {
  assert.equal(fitsLimits(1200, 9000), true);
  assert.equal(fitsLimits(16385, 100), false, '单边超了不行');
  assert.equal(fitsLimits(100, 16385), false);
  assert.equal(fitsLimits(0, 100), false, '尺寸为 0 不算合法画布');
  assert.equal(CANVAS_LIMITS.maxSide, 16384);

  // 默认参数下两条线是同一个数（16384² 正好是面积上限），面积那条永远撞不到。
  // 要验它必须压低上限 —— 换成非默认 limits 才测得出来。
  assert.equal(fitsLimits(1000, 1000, { maxSide: 100000, maxPixels: 500000 }), false, '面积上限要能单独生效');
  assert.equal(fitsLimits(500, 500, { maxSide: 100000, maxPixels: 500000 }), true);
});

test('pickScale：正常情况给 2x；1x 能出但 2x 超限时明确降级', () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ id: `r${i + 1}`, label: `档${i + 1}`, color: '#fff' }));
  const normal = pickScale(rows, []);
  assert.equal(normal.scale, 2);
  assert.equal(normal.degraded, false);
  assert.equal(normal.reason, null);

  // 66 档：1x 高约 9938px 能出，2x 是 19876px 撞线
  const many = Array.from({ length: 66 }, (_, i) => ({ id: `r${i + 1}`, label: `档${i + 1}`, color: '#fff' }));
  const degraded = pickScale(many, []);
  assert.equal(degraded.scale, 1, '超限时必须降到 1x，不能闷头出一张空图');
  assert.equal(degraded.degraded, true);
  assert.equal(/1x/.test(degraded.reason ?? ''), true, '降级要有能给用户看的理由');
});

test('pickScale：连 1x 都超限时也要说实话', () => {
  const huge = Array.from({ length: 300 }, (_, i) => ({ id: `r${i + 1}`, label: `档${i + 1}`, color: '#fff' }));
  const out = pickScale(huge, []);
  assert.equal(out.scale, 1);
  assert.equal(out.degraded, true);
  assert.equal(/减少图块/.test(out.reason ?? ''), true);
});

// ===================== 裁切几何 =====================

test('tileCrop：极端比例的源矩形不越界，且比例与目标一致', () => {
  const cases = [
    [1079, 1680],  // 实测里明显偏离的那张 1:1.56
    [714, 1000],   // 实测里最小的那张
    [2907, 4096],  // 实测里最大的那张
    [1000, 1000],  // 方图
    [3000, 1000],  // 极宽
    [500, 4000],   // 极窄
  ];
  for (const [srcW, srcH] of cases) {
    for (const scale of [1, 2]) {
      const r = tileCrop(srcW, srcH, 'poster', scale);
      assert.equal(r.sx >= 0 && r.sy >= 0, true, `${srcW}x${srcH} 算出负数`);
      assert.equal(r.sw > 0 && r.sh > 0, true, `${srcW}x${srcH} 算出空矩形`);
      assert.equal(r.sx + r.sw <= srcW, true, `${srcW}x${srcH} 右边越界`);
      assert.equal(r.sy + r.sh <= srcH, true, `${srcW}x${srcH} 下边越界`);
      const want = ITEM_SIZES.poster.w / ITEM_SIZES.poster.h;
      assert.equal(Math.abs(r.sw / r.sh - want) < 0.02, true, `${srcW}x${srcH} 裁出来的比例不对`);
    }
  }
});

test('tileCrop：尺寸非法时返回空矩形而不是 NaN', () => {
  const r = tileCrop(0, 0);
  assert.deepEqual(r, { sx: 0, sy: 0, sw: 0, sh: 0 });
  const bad = tileCrop(undefined, undefined, 'poster', 1);
  assert.equal(Number.isNaN(bad.sw), false);
});
