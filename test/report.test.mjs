/**
 * 报告的纯函数层。
 *
 * 这一层是长图功能里唯一能被自动化完整守住的部分 ——
 * 拖拽、改文字、点导出都是 pointer/副作用，SSR 动不了。
 * 所以这里的用例要**故意往脏里写**：状态文件是磁盘上的，会被旧版写、被手改、被写坏。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCK_TYPES,
  REPORT_WIDTH,
  WALL_DEFAULT_COUNT,
  WALL_MAX,
  addBlock,
  autoWallSubjects,
  blockById,
  isBlankBlock,
  isMissing,
  makeBlock,
  makeDefaultReport,
  moveBlock,
  nextBlockId,
  normalizeBlock,
  normalizeReport,
  normalizeReports,
  patchBlock,
  removeBlock,
  reportStats,
  wallItems,
} from '../src/core/report.js';

const HEADER = { id: 'b-1', type: 'header', title: '2026 夏季番', subtitle: '七月新番总结' };

/* ── 块的基本形状 ────────────────────────────────────────── */

test('makeBlock：认不出的类型返回 null，而不是塞个空块进去', () => {
  assert.equal(makeBlock('nope'), null);
  assert.equal(makeBlock(undefined), null);
  assert.equal(makeBlock('image'), null, 'image 这一版还没做，不能悄悄当成合法类型');
  for (const t of BLOCK_TYPES) assert.ok(makeBlock(t), `${t} 应当是合法类型`);
});

test('makeBlock：每种类型都带齐自己的字段（缺字段的块会让渲染层到处写 ??）', () => {
  assert.deepEqual(Object.keys(makeBlock('header')).sort(), ['id', 'subtitle', 'title', 'type']);
  assert.deepEqual(Object.keys(makeBlock('award')).sort(), ['body', 'id', 'subjectId', 'title', 'type']);
  assert.deepEqual(Object.keys(makeBlock('text')).sort(), ['body', 'id', 'type']);
  const wall = makeBlock('wall');
  assert.deepEqual(Object.keys(wall).sort(), ['columns', 'id', 'subjectIds', 'title', 'type']);
  assert.deepEqual(wall.subjectIds, []);
  assert.equal(typeof wall.columns, 'number');
});

test('normalizeBlock：缺 id 或类型不对的直接丢掉（留着会在渲染时变成幽灵）', () => {
  assert.equal(normalizeBlock({ type: 'header', title: 'x' }), null);
  assert.equal(normalizeBlock({ id: 'b-1' }), null);
  assert.equal(normalizeBlock({ id: 'b-1', type: 'wat' }), null);
  assert.equal(normalizeBlock(null), null);
  assert.equal(normalizeBlock('nope'), null);
});

test('normalizeBlock：文本裁剪 + 换行归一（CRLF 混进来会让「没改过」显示成改过）', () => {
  const b = normalizeBlock({ id: 'b-1', type: 'text', body: 'a\r\nb  \r\n  c' });
  assert.equal(b.body, 'a\nb\n  c');
  const long = normalizeBlock({ id: 'b-2', type: 'text', body: 'x'.repeat(5000) });
  assert.ok(long.body.length <= 1200, `正文应当被裁到 1200 字以内，实际 ${long.body.length}`);
});

test('normalizeBlock：对象当文本传进来不该变成 "[object Object]"', () => {
  // 直接 String(v) 的话这一句会变成字面量 "[object Object]" 存进磁盘，
  // 之后谁也分不清那是脏数据还是用户真写了这么一句
  const b = normalizeBlock({ id: 'b-1', type: 'text', body: { a: 1 } });
  assert.equal(b.body, '');
});

test('normalizeBlock：封面墙的 id 去重、丢空值、截到上限', () => {
  const b = normalizeBlock({
    id: 'b-1',
    type: 'wall',
    subjectIds: ['1', '1', '', '  ', '2', 3, null, 'x'.repeat(200)],
  });
  assert.deepEqual(b.subjectIds, ['1', '2', '3', 'x'.repeat(200)]);
  const many = normalizeBlock({ id: 'b-2', type: 'wall', subjectIds: Array.from({ length: 200 }, (_, i) => String(i)) });
  assert.equal(many.subjectIds.length, WALL_MAX);
});

test('normalizeBlock：列数被夹在合理区间，脏值退回默认', () => {
  assert.equal(normalizeBlock({ id: 'b-1', type: 'wall', columns: 99 }).columns, 10);
  assert.equal(normalizeBlock({ id: 'b-1', type: 'wall', columns: 0 }).columns, 2);
  assert.equal(normalizeBlock({ id: 'b-1', type: 'wall', columns: 'x' }).columns, 6);
});

test('isBlankBlock：空块要认得出来 —— 界面上光有空壳不给提示，用户会以为坏了', () => {
  assert.equal(isBlankBlock({ id: 'b-1', type: 'header' }), true);
  assert.equal(isBlankBlock({ id: 'b-2', type: 'wall', subjectIds: [] }), true);
  assert.equal(isBlankBlock(HEADER), false);
  assert.equal(isBlankBlock({ id: 'b-3', type: 'award', title: '', body: '', subjectId: '9' }), true);
  // 认不出来的块也算「空」，否则界面上会显示一块看不出内容的空气
  assert.equal(isBlankBlock({ id: 'b-4', type: 'nope' }), true);
});

test('nextBlockId：取现有最大值 +1，稳定可断言', () => {
  assert.equal(nextBlockId([]), 'b-1');
  assert.equal(nextBlockId([HEADER, { id: 'b-7', type: 'text', body: 'x' }]), 'b-8');
  // 手改过的 id 不该参与编号，也不能让它算出 NaN
  assert.equal(nextBlockId([{ id: 'note', type: 'text', body: 'x' }]), 'b-1');
});

/* ── 报告本身 ───────────────────────────────────────────── */

test('makeDefaultReport：一开始是一张空画布 —— 空态是真实分支，得能走到', () => {
  const doc = makeDefaultReport('2026q3', { nowMs: 5 });
  assert.deepEqual(doc.blocks, []);
  assert.equal(doc.seasonKey, '2026q3');
  assert.equal(doc.width, REPORT_WIDTH);
  assert.equal(doc.updatedAt, 5);
});

test('normalizeReport：脏块被丢掉，好块留下且顺序不变', () => {
  const doc = normalizeReport({
    blocks: [HEADER, { type: 'header' }, null, { id: 'b-2', type: 'wat' }, { id: 'b-3', type: 'text', body: 'ok' }],
  });
  assert.deepEqual(doc.blocks.map((b) => b.id), ['b-1', 'b-3']);
});

test('normalizeReport：重复 id 只留第一个（否则 React key 会撞、拖拽会算出两个落点）', () => {
  const doc = normalizeReport({
    blocks: [HEADER, { ...HEADER, title: '后来那份' }],
  });
  assert.equal(doc.blocks.length, 1);
  assert.equal(doc.blocks[0].title, '2026 夏季番');
});

test('normalizeReport：宽度被夹住，认不出的宽度退回默认', () => {
  assert.equal(normalizeReport({ width: 99999 }).width, 1600);
  assert.equal(normalizeReport({ width: 10 }).width, 800);
  assert.equal(normalizeReport({ width: 'wide' }).width, REPORT_WIDTH);
});

test('normalizeReport：不是对象的输入也能喂（读盘那一步不该抛）', () => {
  for (const bad of [null, undefined, 42, 'x', []]) {
    const doc = normalizeReport(bad, { seasonKey: '2026q2' });
    assert.deepEqual(doc.blocks, []);
    assert.equal(doc.seasonKey, '2026q2');
  }
});

test('normalizeReports：整个映射一起修，key 是季度', () => {
  const all = normalizeReports({
    '2026q3': { blocks: [HEADER] },
    '2026q2': { blocks: [] },
    '': { blocks: [HEADER] },
    '2026q1': 'nope',
  });
  assert.deepEqual(Object.keys(all).sort(), ['2026q1', '2026q2', '2026q3']);
  assert.equal(all['2026q3'].blocks.length, 1);
  assert.equal(all['2026q3'].seasonKey, '2026q3', 'seasonKey 要跟着 key 补上，不能是 null');
  assert.deepEqual(all['2026q1'].blocks, []);
});

/* ── 增删改序 ───────────────────────────────────────────── */

test('addBlock：插到指定位置；越界就挂到末尾，不算错', () => {
  const two = addBlock(addBlock([], HEADER), { id: 'b-2', type: 'text', body: 'tail' });
  assert.deepEqual(two.map((b) => b.id), ['b-1', 'b-2']);

  const mid = addBlock(two, { id: 'b-3', type: 'text', body: 'mid' }, 1);
  assert.deepEqual(mid.map((b) => b.id), ['b-1', 'b-3', 'b-2']);

  const tail = addBlock(two, { id: 'b-9', type: 'text', body: 'end' }, 99);
  assert.deepEqual(tail.map((b) => b.id), ['b-1', 'b-2', 'b-9']);
});

test('addBlock：不合法的块不改变任何东西，而且返回的是新数组', () => {
  const list = [HEADER];
  const out = addBlock(list, { type: 'header' });
  assert.deepEqual(out, list);
  assert.notEqual(out, list, '不该把原数组原样返回 —— 调用方会以为变了');
});

test('removeBlock：删掉指定那块；id 不存在时安静地不动', () => {
  const two = [HEADER, { id: 'b-2', type: 'text', body: 'x' }];
  assert.deepEqual(removeBlock(two, 'b-1').map((b) => b.id), ['b-2']);
  assert.deepEqual(removeBlock(two, 'nope').map((b) => b.id), ['b-1', 'b-2']);
});

test('patchBlock：改内容、保留 id；类型不许被改掉', () => {
  const out = patchBlock([HEADER], 'b-1', { title: '改过了', type: 'wall' });
  assert.equal(out[0].title, '改过了');
  assert.equal(out[0].id, 'b-1');
  // 类型一改，块上原有的字段就对不上了（wall 没有 subtitle），
  // 所以类型只能在造块时定，之后只读
  assert.equal(out[0].type, 'header');
  assert.equal(out[0].subtitle, '七月新番总结', '没被 patch 到的字段要原样留着');
});

test('patchBlock：改坏了也不许把块变成 null（否则渲染层会炸）', () => {
  const out = patchBlock([HEADER], 'b-1', { id: '', type: 'wat' });
  assert.equal(out.length, 1);
  assert.ok(out[0] && out[0].id === 'b-1');
});

test('moveBlock：to 是「移走之后」的下标（先摘再插，和 tierlist 一套语义）', () => {
  const list = ['b-1', 'b-2', 'b-3'].map((id) => ({ id, type: 'text', body: id }));
  assert.deepEqual(moveBlock(list, 0, 2).map((b) => b.id), ['b-2', 'b-3', 'b-1']);
  assert.deepEqual(moveBlock(list, 2, 0).map((b) => b.id), ['b-3', 'b-1', 'b-2']);
  // 移到末尾：摘完之后只剩两个，下标 2 就是「放到最后」
  assert.deepEqual(moveBlock(list, 0, 2).map((b) => b.id), ['b-2', 'b-3', 'b-1']);
});

test('moveBlock：原地下标越界时返回一份拷贝，不改原数组', () => {
  const list = [HEADER];
  const out = moveBlock(list, 5, 0);
  assert.deepEqual(out, list);
  assert.notEqual(out, list);
  assert.equal(moveBlock(list, -1, 0).length, 1);
});

test('blockById：按 id 找；找不到给 null（不是 undefined）', () => {
  assert.equal(blockById([HEADER], 'b-1').title, '2026 夏季番');
  assert.equal(blockById([HEADER], 'b-9'), null);
  assert.equal(blockById(null, 'b-1'), null);
});

/* ── 封面墙 ─────────────────────────────────────────────── */

const POOL = [
  { id: 1, score: 0, titleZh: '没评分' },
  { id: 2, score: 8.2, titleZh: '高分' },
  { id: 3, score: 6.0, titleZh: '中分' },
  { id: 4, score: null, titleZh: '空分' },
  { id: 5, score: 8.2, titleZh: '同分' },
];

test('autoWallSubjects：有评分的按分降序在前，没评分的按原顺序补在后面', () => {
  const ids = autoWallSubjects(POOL, 5);
  // 8.2 两部同分，按 id 升序兜底 → 2 在 5 前面
  assert.deepEqual(ids, ['2', '5', '3', '1', '4']);
});

test('autoWallSubjects：分不够时不留空位，count 被夹在合法区间', () => {
  assert.deepEqual(autoWallSubjects(POOL, 99), ['2', '5', '3', '1', '4']);
  assert.equal(autoWallSubjects(POOL, 0).length, 1);
  assert.equal(autoWallSubjects(Array.from({ length: 200 }, (_, i) => ({ id: i, score: 5 })), 200).length, WALL_MAX);
  assert.equal(autoWallSubjects(null, 10).length, 0);
});

test('autoWallSubjects：默认数量是个具体数字，不是 undefined', () => {
  const pool = Array.from({ length: 100 }, (_, i) => ({ id: i, score: 5 }));
  assert.equal(autoWallSubjects(pool).length, WALL_DEFAULT_COUNT);
});

test('wallItems：解析不到的作品单独报出来，不静默消失', () => {
  const block = normalizeBlock({ id: 'b-1', type: 'wall', subjectIds: ['2', '404'] });
  const { items, missing } = wallItems(block, (id) => (String(id) === '2' ? { id: 2, titleZh: '在的' } : null));
  assert.deepEqual(items.map((a) => a.id), [2]);
  assert.deepEqual(missing, ['404']);
  // 缺了 3 部作品，用户得知道是「查不到那 3 部」，而不是以为墙本来就只放这些
});

test('wallItems：没有 lookup 也不崩（只是什么都解析不出来）', () => {
  const block = normalizeBlock({ id: 'b-1', type: 'wall', subjectIds: ['2'] });
  assert.deepEqual(wallItems(block, null).missing, ['2']);
  assert.deepEqual(wallItems(null, () => ({ id: 1 })).items, []);
});

test('wallItems：上层给「占位条目」时也要算缺数据（App 里就是这样）', () => {
  // App 的 diaryLookup 为了保证入口不丢，查不到时返回的是带 __missing 的占位条目。
  // 早先照单全收的话，墙上会冒出一格写着「条目 999」的色块、看着像正常内容，
  // 而 missing 那条分支在真机里永远走不到 —— 本机测得通、装到 App 里没生效。
  const block = normalizeBlock({ id: 'b-1', type: 'wall', subjectIds: ['2', '999'] });
  const lookup = (id) => (String(id) === '2'
    ? { id: 2, titleZh: '在的' }
    : { id: Number(id), titleZh: '', titleJa: '条目 999', cover: null, __missing: true });
  const { items, missing } = wallItems(block, lookup);
  assert.deepEqual(items.map((a) => a.id), [2]);
  assert.deepEqual(missing, ['999']);

  assert.equal(isMissing(null), true);
  assert.equal(isMissing({ __missing: true }), true);
  assert.equal(isMissing({ id: 2, __missing: false }), false, '显式 false 不该被当成缺数据');
  assert.equal(isMissing({ id: 2, titleZh: '正常一部' }), false);
});

/* ── 统计 ───────────────────────────────────────────────── */

test('reportStats：作品数要跨块去重，块数是块数', () => {
  const doc = normalizeReport({
    blocks: [
      HEADER,
      { id: 'b-2', type: 'wall', subjectIds: ['2', '3'] },
      { id: 'b-3', type: 'award', title: '最佳演出', body: 'x', subjectId: '2' },
      { id: 'b-4', type: 'award', title: '最佳音乐', body: 'y', subjectId: '9' },
      { id: 'b-5', type: 'text', body: '收尾' },
    ],
  });
  const s = reportStats(doc);
  assert.equal(s.blocks, 5);
  assert.equal(s.byType.header, 1);
  assert.equal(s.byType.wall, 1);
  assert.equal(s.byType.award, 2);
  assert.equal(s.byType.text, 1);
  assert.equal(s.wallTiles, 2, '封面墙的格数只数墙里的');
  // 2 同时出现在墙和一个奖项里，只能算一部
  assert.equal(s.works, 3, '作品数应当是 {2,3,9} 共 3 部');
});

test('reportStats：空报告给全 0，不是 undefined', () => {
  const s = reportStats(makeDefaultReport());
  assert.equal(s.blocks, 0);
  assert.equal(s.works, 0);
  assert.equal(s.wallTiles, 0);
  for (const t of BLOCK_TYPES) assert.equal(s.byType[t], 0, `${t} 的计数应当是 0 而不是 undefined`);
});
