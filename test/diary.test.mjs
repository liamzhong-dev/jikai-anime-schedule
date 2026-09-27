/**
 * 补番日记纯函数层测试。
 *
 * 重点不是「功能能用」，而是**边界**：越界评分、字符串数字、缺 Bangumi 分、
 * 只写短评不打分、删空之后留不留空壳。这些在界面上都长得一样，
 * 只有断言能分辨。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RATING_MAX,
  RATING_MIN,
  NOTE_MAX,
  normalizeRating,
  normalizeNote,
  makeEntry,
  addDiaryEntry,
  removeDiaryEntry,
  entriesOf,
  latestEntry,
  latestRated,
  myRating,
  compareToBangumi,
  diaryStats,
  diaryTimeline,
  sortByDivergence,
  describeGap,
} from '../src/core/diary.js';

const DAY = 86400000;

test('normalizeRating 只收 1–10 的整数', () => {
  assert.equal(normalizeRating(8), 8);
  assert.equal(normalizeRating('8'), 8, '输入框给回来的是字符串，必须收');
  assert.equal(normalizeRating(' 7 '), 7);
  assert.equal(normalizeRating(1), RATING_MIN);
  assert.equal(normalizeRating(10), RATING_MAX);
  assert.equal(normalizeRating(7.4), 7, '四舍五入到整数');
  assert.equal(normalizeRating(7.5), 8);
});

test('normalizeRating 把非法输入一律变成 null（不是 0）', () => {
  for (const bad of [null, undefined, '', '  ', 0, -1, 11, 99, NaN, Infinity, 'abc', {}, [], true]) {
    assert.equal(normalizeRating(bad), null, `${JSON.stringify(bad)} 应当判为 null`);
  }
  // ⚠️ 0 必须判 null：Bangumi 的 0 表示「未评分」，混进去会让均分整体偏低
  assert.equal(normalizeRating(0), null);
});

test('normalizeNote 折叠空白并截断', () => {
  assert.equal(normalizeNote('  很好看  '), '很好看');
  assert.equal(normalizeNote('前半\n后半'), '前半 后半');
  assert.equal(normalizeNote(null), '');
  assert.equal(normalizeNote('   '), '');
  const long = 'x'.repeat(NOTE_MAX + 50);
  assert.equal(normalizeNote(long).length, NOTE_MAX);
});

test('makeEntry 全空时返回 null —— 空记录只会让「记了几次」虚高', () => {
  assert.equal(makeEntry({}), null);
  assert.equal(makeEntry({ rating: null, note: '  ' }), null);
  // ⚠️ 这里以前写的是「再调一次 makeEntry 拿它的 at 当期望值」——
  // 两次调用各自取 Date.now()，跨过毫秒边界就红（实测约 1/6 概率）。
  // 现在只调一次，然后断言「形状就是这三个字段」。
  const one = makeEntry({ rating: 8 });
  assert.deepEqual({ ...one, at: null }, { at: null, rating: 8, note: '' }, '只有评分，短评要给空串');
  assert.ok(Number.isFinite(one.at) && one.at > 0, `没给 at 时应当用当前时间，实际 ${one.at}`);
  assert.equal(makeEntry({ note: '只有短评' }).rating, null);
});

test('makeEntry 的 at 非法就退回当前时间', () => {
  const e = makeEntry({ rating: 5, at: 'not-a-date' });
  assert.ok(Number.isFinite(e.at), 'at 必须是数字');
});

test('addDiaryEntry 追加而不是覆盖；空记录不落盘', () => {
  let d = {};
  d = addDiaryEntry(d, 42, { rating: 7, note: '开头有点闷', at: 1000 }).diary;
  d = addDiaryEntry(d, 42, { rating: 9, note: '后半起飞了', at: 2000 }).diary;
  assert.equal(entriesOf(d, 42).length, 2, '同名作品的两条都要留着');

  const before = JSON.stringify(d);
  d = addDiaryEntry(d, 42, { rating: null, note: '' }).diary;
  assert.equal(JSON.stringify(d), before, '空记录不该改变任何东西');

  const skip = addDiaryEntry(d, '', { rating: 5 });
  assert.equal(skip.entry, null, '没有 id 的评分无处可存，应当返回 null 而不是造一个空键');
});

test('「我的评分」取最近一条带评分的，不被「只写了短评」的记录顶掉', () => {
  let d = {};
  d = addDiaryEntry(d, 1, { rating: 6, at: 1000 }).diary;
  d = addDiaryEntry(d, 1, { note: '想再看一遍', at: 2000 }).diary;

  assert.equal(latestEntry(d, 1).note, '想再看一遍', '最近一条是那条纯短评');
  assert.equal(myRating(d, 1), 6, '但评分仍然是 6 —— 只写短评不该让评分消失');
  assert.equal(latestRated(d, 1).rating, 6);
});

test('我的评分是「最新」而不是「平均」', () => {
  let d = {};
  d = addDiaryEntry(d, 1, { rating: 4, at: 1000 }).diary;
  d = addDiaryEntry(d, 1, { rating: 10, at: 2000 }).diary;
  assert.equal(myRating(d, 1), 10, '从 4 改成 10，就该是 10；平均成 7 不是任何一次真实判断');
});

test('removeDiaryEntry 按 at 精确删；删空后不留空壳', () => {
  let d = {};
  d = addDiaryEntry(d, 1, { rating: 6, at: 1000 }).diary;
  d = addDiaryEntry(d, 1, { rating: 7, at: 2000 }).diary;

  const afterMiss = removeDiaryEntry(d, 1, 9999);
  assert.equal(afterMiss, d, '删不到就该原样返回同一个引用');

  const one = removeDiaryEntry(d, 1, 1000);
  assert.equal(entriesOf(one, 1).length, 1);

  const none = removeDiaryEntry(one, 1, 2000);
  assert.equal('1' in none, false, '删空之后不能留一个空壳键，否则统计里会多出一部「记录过」的作品');
});

test('空 diary 上的所有读取都不抛，且给出可用的默认值', () => {
  for (const empty of [undefined, null, {}]) {
    assert.deepEqual(entriesOf(empty, 1), []);
    assert.equal(latestEntry(empty, 1), null);
    assert.equal(latestRated(empty, 1), null);
    assert.equal(myRating(empty, 1), null);
    assert.deepEqual(diaryTimeline(empty), []);
    assert.deepEqual(sortByDivergence(empty), []);
  }
});

test('compareToBangumi：差 1 算合拍、差 2 算略偏、超过才是分歧', () => {
  const a = compareToBangumi(8, 7);
  assert.equal(a.band, 'agree');
  assert.equal(a.diff, 1);
  assert.equal(a.label, '+1.0 合拍');

  const b = compareToBangumi(8, 6);
  assert.equal(b.band, 'near', '正好差 2 应当落在「略偏」，不是「分歧」');

  const c = compareToBangumi(8, 5.9);
  assert.equal(c.band, 'apart');
  assert.equal(c.diff, 2.1);
});

test('compareToBangumi：负数差要有符号，且 bangumi 分保留一位小数', () => {
  const r = compareToBangumi(6, 7.44);
  assert.equal(r.diff, -1.4);
  assert.equal(r.bgm, 7.4);
  assert.ok(r.label.startsWith('-1.4'), `文案里要带负号：${r.label}`);
});

test('compareToBangumi：缺任一边都是 unknown，绝不把缺失当成 0 分算差', () => {
  const noBgm = compareToBangumi(8, null);
  assert.equal(noBgm.band, 'unknown');
  assert.equal(noBgm.diff, null);
  assert.equal(noBgm.missing, 'bgm');
  assert.match(noBgm.label, /BGM 评分未知/);

  // Bangumi 的 0 / undefined 都表示「没人评分」，不是「0 分」
  assert.equal(compareToBangumi(8, 0).band, 'unknown');
  assert.equal(compareToBangumi(8, undefined).band, 'unknown');

  const noMine = compareToBangumi(null, 7);
  assert.equal(noMine.band, 'unknown');
  assert.equal(noMine.missing, 'mine');

  assert.equal(compareToBangumi(null, null).missing, 'both');
});

test('compareToBangumi 的阈值可以传，方便以后调', () => {
  assert.equal(compareToBangumi(8, 6, { agree: 2, near: 3 }).band, 'agree', '把 agree 放宽到 2 就该算合拍');
});

test('diaryStats：均分只统计「两边都有分」的作品', () => {
  let d = {};
  d = addDiaryEntry(d, 1, { rating: 10, at: 1000 }).diary; // BGM 8.0 → 差 +2
  d = addDiaryEntry(d, 2, { rating: 4, at: 1000 }).diary;  // 没有 BGM 分
  // 若把第 2 部也算进「我的均分」，均分会变成 7，而 BGM 均分只有 8 —— 两个数来自不同样本，
  // 相减出来的「口味偏差」就是假的。正确结果是我的均分 = 10（只有第 1 部可比）。
  const subjects = { 1: { id: 1, score: 8 }, 2: { id: 2, score: null } };
  const st = diaryStats(d, (k) => subjects[k]);

  assert.equal(st.works, 2);
  assert.equal(st.entries, 2);
  assert.equal(st.rated, 2);
  assert.equal(st.comparable, 1, '只有第 1 部两边都有分');
  assert.equal(st.avgMine, 10);
  assert.equal(st.avgBgm, 8);
  assert.equal(st.gap, 2);
  assert.equal(st.agreeRatio, 0);
  // 差 2 落在「略偏」——跟上面 compareToBangumi 的边界用例保持一致，
  // 两处要是对不上，说明阈值被谁改歪了
  assert.deepEqual(st.bands, { agree: 0, near: 1, apart: 0, unknown: 1 });
});

test('diaryStats：一部都没打分时不硬算均值，返回 null', () => {
  const d = addDiaryEntry({}, 1, { note: '只写了两句' }).diary;
  const st = diaryStats(d, () => ({ score: 7 }));
  assert.equal(st.rated, 0);
  assert.equal(st.avgMine, null);
  assert.equal(st.gap, null);
  assert.equal(st.agreeRatio, null);
  assert.match(describeGap(st), /还没有可比的作品/);
});

test('diaryTimeline 按时间倒序摊平，并带上作品资料', () => {
  let d = {};
  d = addDiaryEntry(d, 1, { rating: 6, at: 1000 }).diary;
  d = addDiaryEntry(d, 2, { rating: 8, at: 3000 }).diary;
  d = addDiaryEntry(d, 1, { note: '补记', at: 2000 }).diary;

  const tl = diaryTimeline(d, (k) => ({ id: Number(k), score: 7, titleZh: `作品${k}` }));
  assert.deepEqual(tl.map((e) => e.at), [3000, 2000, 1000]);
  assert.equal(tl[1].note, '补记');
  assert.equal(tl[1].anime.titleZh, '作品1');
  assert.equal(tl[2].cmp.band, 'agree');
});

test('diaryTimeline 拿不到作品资料时也要留着 id —— 卡片不许消失', () => {
  const d = addDiaryEntry({}, 777, { rating: 6, at: 1000 }).diary;
  const tl = diaryTimeline(d, () => null);
  assert.equal(tl.length, 1);
  assert.equal(tl[0].id, 777);
  assert.equal(tl[0].anime, null);
});

test('diaryTimeline 的 limit 是「取最近 N 条」而不是「前 N 条」', () => {
  let d = {};
  for (let i = 1; i <= 5; i += 1) d = addDiaryEntry(d, i, { rating: 5, at: i * 1000 }).diary;
  const tl = diaryTimeline(d, () => null, { limit: 2 });
  assert.deepEqual(tl.map((e) => e.at), [5000, 4000], 'limit 要截最近的两条');
});

test('sortByDivergence：分歧最大的浮在最上面，没有可比分的沉底', () => {
  let d = {};
  d = addDiaryEntry(d, 1, { rating: 8, at: 1000 }).diary; // 与 8 差 0
  d = addDiaryEntry(d, 2, { rating: 3, at: 1000 }).diary; // 与 8 差 -5
  d = addDiaryEntry(d, 3, { rating: 9, at: 1000 }).diary; // 无 BGM 分
  const score = { 1: 8, 2: 8 };
  const rows = sortByDivergence(d, (k) => ({ score: score[k] }));

  assert.deepEqual(rows.map((r) => r.key), ['2', '1', '3']);
  assert.equal(rows[0].cmp.diff, -5);
  assert.equal(rows[2].cmp.band, 'unknown');
});

test('describeGap 三种口径都能说清', () => {
  assert.match(describeGap({ comparable: 2, avgMine: 9, avgBgm: 7, gap: 2 }), /大方/);
  assert.match(describeGap({ comparable: 2, avgMine: 5, avgBgm: 7, gap: -2 }), /严格/);
  assert.match(describeGap({ comparable: 2, avgMine: 7, avgBgm: 7, gap: 0 }), /基本一致/);
});

test('时间戳相同的两条不会被吃掉一条', () => {
  let d = {};
  d = addDiaryEntry(d, 1, { rating: 5, at: 1000 }).diary;
  d = addDiaryEntry(d, 1, { rating: 9, at: 1000 }).diary;
  assert.equal(entriesOf(d, 1).length, 2, '同一毫秒的两条都要留着 —— 合并会让「记了几次」丢数');
});
