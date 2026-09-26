/**
 * 追番历程的纯函数测试。
 *
 * 这一层之所以值得写这么多：历程里**没有一个数字是用户填的**，
 * 全是推出来的。推错了不会报错，只会安静地显示一个像模像样的假日期 ——
 * 所以每一条推导规则都要有断言守着，尤其是「拿不到就空着，不许猜」这类。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  describeHistory,
  formatSpan,
  historyEvents,
  historyStats,
  isFinished,
} from '../src/core/history.js';

const DAY = 86400000;
const T0 = Date.UTC(2026, 8, 1); // 2026-09-01

const ANIME = {
  1: { id: 1, titleZh: '甲', eps: 12 },
  2: { id: 2, titleZh: '乙', eps: 12 },
  3: { id: 3, titleZh: '丙', eps: 24 },
};
const lookup = (map) => (id) => map[String(id)] ?? null;

// ---------- 「看完」的判定 ----------

test('isFinished：只认「已看 ≥ 总集数」，拿不到总集数一律不判', () => {
  assert.equal(isFinished({ watchedEps: 12 }, { eps: 12 }), true);
  assert.equal(isFinished({ watchedEps: 13 }, { eps: 12 }), true, '超前看也算看完');
  assert.equal(isFinished({ watchedEps: 11 }, { eps: 12 }), false);

  // 这三条是重点：拿不到 eps 时**不许猜**。猜的话每一部都会在某一刻
  // 突然变成「已看完」，而用户从没做过这个动作。
  assert.equal(isFinished({ watchedEps: 12 }, { eps: null }), false, 'eps 为 null');
  assert.equal(isFinished({ watchedEps: 12 }, { eps: undefined }), false, 'eps 缺失');
  assert.equal(isFinished({ watchedEps: 12 }, null), false, '条目查不到');
  assert.equal(isFinished({ watchedEps: 12 }, { eps: 0 }), false, 'eps 为 0 不是「共 0 集」');
  // 占位条目的定义就是「什么都没查到」，所以它没有 eps —— 判定要落在 eps 上，
  // 而不是靠一个 `__missing` 标记。⚠️ 别在这里给占位条目编一个 eps:12 出来测，
  // 那是自相矛盾的输入，测出来的结论说明不了任何真实情况。
  assert.equal(isFinished({ watchedEps: 12 }, { id: 1, titleJa: '条目 1', cover: null, __missing: true }), false, '占位条目');
  assert.equal(isFinished(null, { eps: 12 }), false, '没有追番记录');
});

// ---------- 事件流 ----------

test('事件流：只出「开始追」和「看完了」两类，按时间倒序', () => {
  const following = {
    1: { watchedEps: 12, followedAt: T0, lastAt: T0 + 5 * DAY },
    2: { watchedEps: 5, followedAt: T0 + 3 * DAY, lastAt: T0 + 4 * DAY },
  };
  const events = historyEvents({ following, lookup: lookup(ANIME) });

  assert.equal(events.length, 3, '没看完的那部只该有一条「开始追」');
  assert.deepEqual(
    events.map((e) => `${e.key}:${e.kind}`),
    ['1:finish', '2:follow', '1:follow'],
    '要按时间倒序',
  );
  assert.equal(events[0].days, 5, '耗时要能算出来');
  assert.equal(events[0].atKnown, true);
  assert.equal(events[2].days, null, '「开始追」没有耗时');
});

test('中间的进度不单独成事件 —— 12 集的番不能刷出 12 条', () => {
  const following = { 2: { watchedEps: 5, followedAt: T0, lastAt: T0 + 4 * DAY } };
  const events = historyEvents({ following, lookup: lookup(ANIME) });
  assert.equal(events.length, 1, '看到第 5 集不该产生 5 条事件');
  assert.equal(events[0].kind, 'follow');
});

test('没有时间戳的作品不出现在时间轴上，看完了也不出现假日期', () => {
  const following = {
    3: { watchedEps: 24 },              // 看完了，但没有任何时间
    1: { watchedEps: 0, followedAt: T0 },
  };
  const events = historyEvents({ following, lookup: lookup(ANIME) });

  assert.equal(events.length, 2);
  const last = events[events.length - 1];
  assert.equal(last.at, null, '没有时间的事件要沉底');
  assert.equal(last.atKnown, false, '要标出来「这个日期不是真的」');
  assert.equal(last.days, null);
});

test('完成时间缺失时退回加入时间，但 atKnown 要说实话', () => {
  const following = { 1: { watchedEps: 12, followedAt: T0 } }; // 有开始、没有 lastAt
  const events = historyEvents({ following, lookup: lookup(ANIME) });
  const fin = events.find((e) => e.kind === 'finish');
  assert.equal(fin.at, T0, '至少还排得进时间线');
  assert.equal(fin.atKnown, false, '但它不是完成日，界面得能说清');
  assert.equal(fin.days, null, '耗时不允许编');
});

test('同一时刻的两条：完成后发生，排在「开始追」前面', () => {
  const following = { 1: { watchedEps: 12, followedAt: T0, lastAt: T0 } };
  const events = historyEvents({ following, lookup: lookup(ANIME) });
  assert.deepEqual(events.map((e) => e.kind), ['finish', 'follow'], '当天看完也要先显示看完');
});

test('空输入与脏输入都不许抛', () => {
  assert.deepEqual(historyEvents({}), []);
  assert.deepEqual(historyEvents({ following: null }), []);
  assert.deepEqual(historyEvents({ following: { 1: null, 2: 'x' } }), [], '脏记录跳过而不是崩');
  // lookup 缺省也不能崩
  assert.deepEqual(historyEvents({ following: { 1: { watchedEps: 0, followedAt: T0 } } }).length, 1);
});

// ---------- 汇总 ----------

test('汇总：有时间与没时间必须分开给，否则平均天数是个假数', () => {
  const following = {
    1: { watchedEps: 12, followedAt: T0, lastAt: T0 + 5 * DAY },        // 看完，5 天
    2: { watchedEps: 5, followedAt: T0 + 3 * DAY, lastAt: T0 + 4 * DAY }, // 没看完
    3: { watchedEps: 24, followedAt: T0 + 10 * DAY, lastAt: T0 + 1 * DAY }, // 看完但时间倒挂
    4: { watchedEps: 0 },                                                // 没有时间戳
  };
  const stats = historyStats({ following, diary: {}, lookup: lookup(ANIME), nowMs: T0 + 20 * DAY });

  assert.equal(stats.total, 4);
  assert.equal(stats.tracking, 3, '有时间戳的');
  assert.equal(stats.untimed, 1, '没有时间戳的');
  assert.equal(stats.finished, 2, '「已看完」不依赖有没有时间戳');
  assert.equal(stats.timed, 1, '算得出耗时的只有 1 部');
  assert.equal(stats.avgDays, 5, '倒挂那条不许混进平均');
  assert.equal(stats.spanDays, 20);
});

test('时间倒挂（lastAt 早于 followedAt）不算耗时 —— 「-3 天看完」比不显示更让人困惑', () => {
  const following = { 1: { watchedEps: 12, followedAt: T0 + 10 * DAY, lastAt: T0 } };
  const stats = historyStats({ following, lookup: lookup(ANIME) });
  assert.equal(stats.finished, 1);
  assert.equal(stats.timed, 0);
  assert.equal(stats.avgDays, null);
});

test('一部都没看完时 avgDays 是 null，不是 0', () => {
  const following = { 2: { watchedEps: 5, followedAt: T0, lastAt: T0 + DAY } };
  const stats = historyStats({ following, lookup: lookup(ANIME) });
  assert.equal(stats.finished, 0);
  assert.equal(stats.avgDays, null, '0 会被读成「平均 0 天」，那是另一回事');
});

test('空状态给出 null 而不是 0/NaN', () => {
  const stats = historyStats({});
  assert.equal(stats.total, 0);
  assert.equal(stats.tracking, 0);
  assert.equal(stats.avgDays, null);
  assert.equal(stats.firstAt, null);
  assert.equal(stats.spanDays, null);
  assert.equal(stats.highlight, null);
});

// ---------- 「哪部最重要」 ----------

test('highlight 取笔记字数最多的那部，没有笔记就返回 null', () => {
  const map = { 1: { id: 1, titleZh: '甲' }, 2: { id: 2, titleZh: '乙' } };
  const long = '很长的一段笔记'.repeat(3);
  const stats = historyStats({
    following: {},
    diary: {
      1: { entries: [{ at: 1, rating: 8, note: '短' }] },
      2: { entries: [{ at: 1, rating: 9, note: long }, { at: 2, note: '再补一句' }] },
    },
    lookup: lookup(map),
  });
  assert.equal(stats.highlight.key, '2');
  assert.equal(stats.highlight.chars, long.length + '再补一句'.length, '多条的笔记要累加');
  assert.equal(stats.highlight.notes, 2, '只数真写了字的条目');
  assert.equal(stats.highlight.anime.titleZh, '乙');

  const none = historyStats({
    following: {},
    diary: { 1: { entries: [{ at: 1, rating: 8, note: '' }] } },
    lookup: lookup(map),
  });
  assert.equal(none.highlight, null, '只有评分没写字，不算「写得最多」—— 硬凑一个出来就是假排行');
});

// ---------- 文案 ----------

test('formatSpan：0 天说「当天」，不是「0 天」', () => {
  assert.equal(formatSpan(0), '当天');
  assert.equal(formatSpan(1), '1 天');
  assert.equal(formatSpan(30), '30 天');
  assert.equal(formatSpan(45), '2 个月');
  assert.equal(formatSpan(400), '1.1 年');
  assert.equal(formatSpan(null), null);
  assert.equal(formatSpan(undefined), null);
  assert.equal(formatSpan('x'), null, '不是数字就不该硬转');
});

test('describeHistory：三种状态各有各的说法，不能都说「还没有数据」', () => {
  assert.match(describeHistory(historyStats({})), /还没有追番/);

  const untimed = historyStats({ following: { 1: { watchedEps: 0 } }, lookup: lookup(ANIME) });
  assert.match(describeHistory(untimed), /还没有时间戳/, '有时间戳和没时间戳要分开说');

  const ok = historyStats({
    following: { 1: { watchedEps: 12, followedAt: T0, lastAt: T0 + 5 * DAY } },
    lookup: lookup(ANIME),
    nowMs: T0 + 20 * DAY,
  });
  const text = describeHistory(ok);
  assert.match(text, /追了 1 部/);
  assert.match(text, /1 部看完了/);
  assert.match(text, /平均 5 天/);
});
