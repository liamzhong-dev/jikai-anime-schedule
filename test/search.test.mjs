/**
 * 跨季搜索的纯函数层测试。
 *
 * 这一层的核心不是「排序对不对」（那是 library.js 里 searchNames 的事，已有测试），
 * 而是**切分规则**：本季的进计数、别季的进列表。
 * 最容易写错的地方是「先取前 N 条再分组」—— 那样本季命中的会整片挤掉别季的，
 * 而这个功能存在的理由恰恰是「本季没有、想找别季」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { seasonKeyOfEntry, shapeHit, splitHits, stubFromHit } from '../src/core/search.js';

// ---------------------------------------------------------------- seasonKeyOfEntry

test('seasonKeyOfEntry：y/q 齐全才给季度键，缺一个就返回 null', () => {
  assert.equal(seasonKeyOfEntry({ y: 2021, q: 1 }), '2021q1');
  assert.equal(seasonKeyOfEntry({ y: 2026, q: 4 }), '2026q4');
  assert.equal(seasonKeyOfEntry({ y: 2021 }), null, '只有年没有季度');
  assert.equal(seasonKeyOfEntry({ q: 2 }), null, '只有季度没有年');
  assert.equal(seasonKeyOfEntry({ y: 2021, q: 0 }), null, 'q=0 不是合法季度');
  assert.equal(seasonKeyOfEntry({ y: 2021, q: 5 }), null, 'q=5 不是合法季度');
  assert.equal(seasonKeyOfEntry(null), null);
  assert.equal(seasonKeyOfEntry(undefined), null);
});

// ---------------------------------------------------------------- shapeHit

test('shapeHit：字段收敛，缺的给安全默认值', () => {
  const h = shapeHit({ id: 42, zh: '  中文名  ', ja: '日本語', en: 'English', t: 'TV', y: 2020, q: 3, score: 88 });
  assert.equal(h.id, 42);
  assert.equal(h.zh, '中文名', '前后空白要剪掉');
  assert.equal(h.ja, '日本語');
  assert.equal(h.en, 'English');
  assert.equal(h.type, 'tv', '类型统一小写');
  assert.equal(h.seasonKey, '2020q3');
  assert.equal(h.score, 88);
});

test('shapeHit：空条目不会抛，也不会产出 undefined 字段', () => {
  const h = shapeHit({});
  assert.equal(h.zh, '');
  assert.equal(h.ja, '');
  assert.equal(h.type, 'tv');
  assert.equal(h.seasonKey, null);
  assert.ok(Number.isNaN(h.id) || typeof h.id === 'number');
});

// ---------------------------------------------------------------- splitHits

test('splitHits：本季命中的只计数、不进列表', () => {
  const hits = [
    { id: 1, zh: '本季这部', y: 2026, q: 3, t: 'tv', score: 100 },
    { id: 2, zh: '老番那部', y: 2021, q: 1, t: 'tv', score: 90 },
  ];
  const r = splitHits(hits, new Set([1]));
  assert.equal(r.inSeason, 1);
  assert.equal(r.others.length, 1);
  assert.equal(r.others[0].id, 2);
  assert.equal(r.others[0].seasonKey, '2021q1');
});

test('splitHits：本季命中再多，也挤不掉别季的（先按季过滤，再取前 N）', () => {
  // 反向断言：如果实现写成「先 slice(limit) 再分组」，前 8 条全是本季的，
  // 那条 2020 年的老番会被切掉 —— 而它正是用户想找的。
  const hits = [
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ id: n, zh: `本季第${n}部`, y: 2026, q: 3, t: 'tv', score: 100 - n })),
    { id: 99, zh: '2020 年的老番', y: 2020, q: 2, t: 'tv', score: 10 },
  ];
  const r = splitHits(hits, new Set([1, 2, 3, 4, 5, 6, 7, 8]), { othersLimit: 8 });
  assert.equal(r.inSeason, 8);
  assert.equal(r.others.length, 1, '别季的那一条必须在，否则这个功能就白做了');
  assert.equal(r.others[0].id, 99);
});

test('splitHits：othersLimit 截断时保留靠前的（相关度高的）', () => {
  const hits = [10, 11, 12, 13, 14].map((n) => ({ id: n, zh: `番${n}`, y: 2019, q: 1, t: 'tv', score: 100 - n }));
  const r = splitHits(hits, new Set(), { othersLimit: 3 });
  assert.deepEqual(r.others.map((h) => h.id), [10, 11, 12]);
  assert.equal(r.inSeason, 0);
});

test('splitHits：没有年份的条目照样能搜到，只是季度标签为空', () => {
  // 索引里有条目没有 begin（归不进任何一季）。它们不该因为这个被丢掉 ——
  // 用户搜的是名字，不是季度。
  const r = splitHits([{ id: 7, zh: '时间未知的番', t: 'tv', score: 50 }], new Set());
  assert.equal(r.others.length, 1);
  assert.equal(r.others[0].seasonKey, null);
});

test('splitHits：空输入、非数组都不炸', () => {
  assert.deepEqual(splitHits([], new Set()), { others: [], inSeason: 0 });
  assert.deepEqual(splitHits(null, new Set()), { others: [], inSeason: 0 });
  assert.deepEqual(splitHits(undefined, null), { others: [], inSeason: 0 });
});

test('splitHits：seasonIds 传数组也认（调用方传什么形状都得能用）', () => {
  const r = splitHits([{ id: 1, zh: 'a', y: 2026, q: 3, t: 'tv' }], [1]);
  assert.equal(r.inSeason, 1);
  assert.equal(r.others.length, 0);
});

// ---------------------------------------------------------------- stubFromHit

test('stubFromHit：名字优先中文，没有用日文，都没有也有个能认的兜底', () => {
  const a = stubFromHit({ id: 1, zh: '中文名', ja: '日本語', type: 'tv', seasonKey: '2020q1' });
  assert.equal(a.titleZh, '中文名');
  assert.equal(a.titleJa, '日本語');
  assert.equal(a.platform, 'TV');
  assert.equal(a.season, '2020q1');
  assert.equal(a.__stub, true);
  assert.match(a.external.bangumi, /\/1$/);
  assert.ok(a.external.moegirl.includes(encodeURIComponent('中文名')));

  const b = stubFromHit({ id: 2, ja: '日本語だけ', type: 'ova' });
  assert.equal(b.titleZh, '', '没中文就留空，不要拿日文冒充中文名');
  assert.equal(b.titleJa, '日本語だけ');
  assert.equal(b.platform, 'OVA');

  const c = stubFromHit({ id: 3 });
  assert.ok(c.titleJa.includes('3'), '连名字都没有时至少标出条目号');
  assert.equal(c.platform, 'TV');
});

test('stubFromHit：绝不能带 __missing —— 那会被上层当成「查不到的占位条目」', () => {
  // 抽屉与封面墙都靠 __missing 判断「这条根本没有资料」。
  // 桩条目是「有资料但很少」，标错会被显示成「条目 12345」那种空壳。
  const a = stubFromHit({ id: 5, zh: '某番' });
  assert.notEqual(a.__missing, true);

  // 抽屉对空字段的兜底依赖这几个是空的，顺手钉住
  assert.equal(a.begin, null);
  assert.equal(a.eps, null);
  assert.equal(a.score, null);
  assert.deepEqual(a.tags, []);
  assert.equal(a.summary, '');
});

test('stubFromHit：id 非法时不抛错（索引里理论上不会有，但兜一层）', () => {
  const a = stubFromHit({ zh: '没有 id' });
  assert.ok(Number.isNaN(a.id));
  assert.equal(a.titleZh, '没有 id');
});
