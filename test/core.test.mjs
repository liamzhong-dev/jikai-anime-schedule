import test from 'node:test';
import assert from 'node:assert/strict';

import {
  airingsInRange, clockCST, countdown, countdownLabel, dateCST, isLateNight,
  parsePeriodDays, seasonLabel, seasonOf, sinceLabel, toCST, toJST, watchState, weekdayJST,
} from '../src/core/time.js';
import { buildNight, buildWeek, upcomingWithin } from '../src/core/schedule.js';
import { deadlineStatus, daysUntil, progress, sortCatchup } from '../src/core/catchup.js';
import { filterSeason, matchKeyword, sortList } from '../src/core/filters.js';
import { bangumiIdOf, mapItem, availableSeasons, currentSeason } from '../src/data/bangumiData.js';
import { buildMockArchive, buildMockSeason, buildMockUserState } from './fixtures/fictional-data.js';

// M0 实测的真实字段形态：begin 是 UTC 绝对时刻，broadcast 是 RFC 5545 重复规则
const ANIME = {
  id: 412008,
  begin: '2026-10-07T15:00:00.000Z',
  broadcast: 'R/2026-10-07T15:00:00.000Z/P7D',
  eps: 12,
};
const BEGIN = Date.parse(ANIME.begin);
const DAY = 86400000;

/* ---------------- 时间与时区：整个工具的命门 ---------------- */

test('周期解析：P7D 得 7 天；缺失或非法返回 null', () => {
  assert.equal(parsePeriodDays(ANIME.broadcast), 7);
  assert.equal(parsePeriodDays('R/2026-10-07T15:00:00.000Z/P1D'), 1);
  assert.equal(parsePeriodDays('R/2026-10-07T15:00:00.000Z/P0D'), null);
  assert.equal(parsePeriodDays(undefined), null);
  assert.equal(parsePeriodDays(''), null);
});

test('星期必须按 JST 取：UTC 15:00 在日本已是次日 00:00 周四', () => {
  assert.equal(weekdayJST(BEGIN), '周四');
  assert.equal(toJST(BEGIN).hour, 0);
  assert.equal(toJST(BEGIN).day, 8);
  // 同一时刻北京时间还是 7 日 23:00 —— 差这一小时就是整张表错一天
  assert.equal(toCST(BEGIN).hour, 23);
  assert.equal(toCST(BEGIN).day, 7);
  assert.equal(clockCST(BEGIN), '23:00');
  assert.equal(dateCST(BEGIN), '10月7日');
});

test('北京时间 00:00-06:00 判为深夜档', () => {
  assert.equal(isLateNight(Date.parse('2026-10-07T17:00:00.000Z')), true);  // CST 次日 01:00
  assert.equal(isLateNight(BEGIN), false);                                   // CST 当日 23:00，不算深夜
  assert.equal(isLateNight(Date.parse('2026-10-07T04:00:00.000Z')), false);  // CST 12:00
});

test('下一集 = begin + 已看集数 × 周期', () => {
  const before = watchState(ANIME, 0, BEGIN - DAY);
  assert.equal(before.next.episode, 1);
  assert.equal(before.next.ms, BEGIN);
  assert.equal(before.next.precision, 'exact');
  assert.equal(before.airedCount, 0);
  assert.equal(before.behind, 0);

  const fifth = watchState(ANIME, 4, BEGIN + DAY);
  assert.equal(fifth.next.episode, 5);
  assert.equal(fifth.next.ms, BEGIN + 4 * 7 * DAY);
});

test('「播到第几话」和「我落后几话」是两件事', () => {
  const five = BEGIN + 5 * 7 * DAY;
  const s = watchState(ANIME, 2, five);
  assert.equal(s.airedCount, 6);
  assert.equal(s.latest.episode, 6);
  assert.equal(s.latest.ms, BEGIN + 5 * 7 * DAY);
  assert.equal(s.behind, 4);
  assert.equal(s.finished, false);
  // 下一集（第 3 话）确实已经播过了，界面据此显示「已更新」
  assert.equal(s.next.ms, BEGIN + 2 * 7 * DAY);
  assert.ok(s.next.ms < five);
});

test('整部播完后判为完结，不再给出下一集', () => {
  const end = BEGIN + 12 * 7 * DAY;

  const allSeen = watchState(ANIME, 12, end);
  assert.equal(allSeen.finished, true);
  assert.equal(allSeen.airedCount, 12);
  assert.equal(allSeen.behind, 0);
  assert.equal(allSeen.next.ms, null);

  // 播完了但没看完：仍要能算出还欠几话
  const lagging = watchState(ANIME, 8, end);
  assert.equal(lagging.finished, true);
  assert.equal(lagging.behind, 4);
});

test('播出集数不会超过总话数', () => {
  const s = watchState(ANIME, 0, BEGIN + 999 * DAY);
  assert.equal(s.airedCount, 12);
  assert.equal(s.behind, 12);
});

test('没有 broadcast 时绝不谎报精确时刻', () => {
  const old = { ...ANIME, broadcast: null };

  // 首播还没到：只知道首播日
  const future = watchState(old, 0, BEGIN - DAY);
  assert.equal(future.next.precision, 'date');
  assert.equal(future.next.ms, BEGIN);
  assert.equal(future.behind, 0);

  // 首播已过：无从推算下一集，给 null 而不是编一个时间
  const past = watchState(old, 3, BEGIN + 30 * DAY);
  assert.equal(past.next.precision, 'date');
  assert.equal(past.next.ms, null);
  assert.equal(past.behind, 1);
});

test('时间窗内的播出列表不越界，且尊重总话数', () => {
  const list = airingsInRange(ANIME, BEGIN - DAY, BEGIN + 20 * DAY);
  assert.deepEqual(list.map((x) => x.episode), [1, 2, 3]);
  // 窗开在第三集之后，应从第三集附近开始而不是从第一集
  const later = airingsInRange(ANIME, BEGIN + 7 * DAY, BEGIN + 9 * DAY);
  assert.deepEqual(later.map((x) => x.episode), [2]);
});

test('airingsInRange 在超长窗口下不会超过总话数', () => {
  const list = airingsInRange(ANIME, BEGIN, BEGIN + 400 * DAY, 60);
  assert.equal(list.length, 12);
});

test('倒计时正负与「已更新多久」', () => {
  const now = BEGIN;
  const cd = countdown(BEGIN + 2 * DAY + 15 * 3600000, now);
  assert.equal(cd.overdue, false);
  assert.equal(cd.days, 2);
  assert.equal(cd.hours, 15);
  assert.equal(countdownLabel(cd).value, 2);
  assert.equal(countdownLabel(cd).unit, '天后');

  const soon = countdown(BEGIN + 45 * 60000, now);
  assert.equal(countdownLabel(soon).unit, '分钟后');

  const past = countdown(BEGIN - DAY, now);
  assert.equal(past.overdue, true);
  assert.equal(sinceLabel(BEGIN - DAY, now), '1 天前已更新');
});

test('季度键与季度中文标签', () => {
  assert.equal(seasonOf(BEGIN), '2026q4');
  assert.equal(seasonLabel('2026q4'), '2026 年 10 月 · 秋');
  assert.equal(seasonLabel('2027q1'), '2027 年 1 月 · 冬');
  assert.equal(seasonLabel('乱七八糟'), '乱七八糟');
});

/* ---------------- 时间表 ---------------- */

const ANCHOR = Date.parse('2026-10-07T04:00:00.000Z'); // 北京时间 10/7 12:00，周三

test('周视图固定从周一起排，且标出今天', () => {
  const week = buildWeek([ANIME], ANCHOR);
  assert.equal(week.length, 7);
  assert.deepEqual(week.map((d) => d.label), ['周一', '周二', '周三', '周四', '周五', '周六', '周日']);
  assert.equal(week[0].dateLabel, '10/5');
  assert.equal(week.filter((d) => d.isToday).length, 1);
  assert.equal(week.find((d) => d.isToday).label, '周三');
});

test('深夜档按北京时间归入次日，而不是日本当日', () => {
  // 日本 10/8 00:00 首播 → 北京时间 10/7 23:00，应落在周三而不是周四
  const week = buildWeek([ANIME], ANCHOR);
  const wed = week.find((d) => d.label === '周三');
  const thu = week.find((d) => d.label === '周四');
  assert.equal(wed.items.length, 1);
  assert.equal(wed.items[0].episode, 1);
  assert.equal(thu.items.length, 0);
});

test('深夜档窗口是当天 18:00 到次日 06:00', () => {
  const { from, to, items } = buildNight([ANIME], ANCHOR);
  assert.equal(to - from, 12 * 3600000);
  assert.equal(toCST(from).hour, 18);
  assert.equal(toCST(from).day, 7);
  assert.equal(toCST(to).hour, 6);
  assert.equal(toCST(to).day, 8);
  // 北京时间 23:00 更新，正好落在窗口里；下一集在一周后，不该被算进来
  assert.equal(items.length, 1);
  assert.equal(items[0].episode, 1);
});

test('「接下来 7 天」只收还没到的更新', () => {
  const rows = [
    { id: 'past', next: { ms: NOW - 3 * 3600000 } },
    { id: 'soon', next: { ms: NOW + 2 * DAY } },
    { id: 'later', next: { ms: NOW + 6 * DAY } },
    { id: 'beyond', next: { ms: NOW + 9 * DAY } },
    { id: 'unknown', next: { ms: null } },
  ];
  // 已经播过的不能出现在这里 —— 否则会被读成「3 小时后更新」
  assert.deepEqual(upcomingWithin(rows, NOW).map((r) => r.id), ['soon', 'later']);
  assert.deepEqual(upcomingWithin(rows, NOW, 3 * DAY).map((r) => r.id), ['soon']);
});

/* ---------------- 补番 ---------------- */

const NOW = Date.parse('2026-10-08T00:00:00.000Z');

test('deadline 分档：逾期 / 今天 / 三天内 / 宽裕', () => {
  assert.equal(deadlineStatus(NOW - 3 * DAY, NOW).level, 'overdue');
  assert.equal(deadlineStatus(NOW + 3 * 3600000, NOW).level, 'urgent');
  assert.equal(deadlineStatus(NOW + 2 * DAY, NOW).level, 'urgent');
  assert.equal(deadlineStatus(NOW + 20 * DAY, NOW).level, 'normal');
  assert.match(deadlineStatus(NOW - 2 * DAY, NOW).label, /逾期 2 天/);
});

test('补番进度与剩余天数', () => {
  const pg = progress({ watchedEps: 6, targetEps: 24 });
  assert.equal(pg.done, 6);
  assert.equal(pg.remaining, 18);
  assert.equal(pg.ratio, 0.25);
  // 超出目标不会算成负数
  assert.equal(progress({ watchedEps: 30, targetEps: 24 }).remaining, 0);
  assert.equal(progress({ watchedEps: 0, targetEps: 0 }).ratio, 0);
  assert.equal(daysUntil(NOW + 5 * DAY, NOW), 5);
});

test('补番排序：逾期在前，归档沉底', () => {
  const items = [
    { id: 'c', deadline: NOW + 20 * DAY, archived: false },
    { id: 'a', deadline: NOW - DAY, archived: false },
    { id: 'b', deadline: NOW + DAY, archived: false },
    { id: 'z', deadline: NOW - 999 * DAY, archived: true },
  ];
  assert.deepEqual(sortCatchup(items, NOW).map((i) => i.id), ['a', 'b', 'c', 'z']);
});

/* ---------------- 搜索 / 筛选 / 排序 ---------------- */

const SAMPLE = { titleZh: '雾灯的守夜人', titleJa: 'キリビノモリ', studio: '灯屋工房', tags: ['奇幻', '治愈'] };

test('搜索命中中日文名、制作公司、标签；空串全命中', () => {
  assert.equal(matchKeyword(SAMPLE, '雾灯'), true);
  assert.equal(matchKeyword(SAMPLE, 'キリビ'), true);
  assert.equal(matchKeyword(SAMPLE, '灯屋'), true);
  assert.equal(matchKeyword(SAMPLE, '治愈'), true);
  assert.equal(matchKeyword(SAMPLE, '  '), true);
  assert.equal(matchKeyword(SAMPLE, '不存在的词'), false);
});

test('筛选：只看已追 / 平台', () => {
  const list = [
    { id: 1, platform: 'TV' },
    { id: 2, platform: 'WEB' },
  ];
  assert.deepEqual(filterSeason(list, { followedOnly: true }, new Set([2])).map((x) => x.id), [2]);
  assert.deepEqual(filterSeason(list, { platform: 'WEB' }, new Set()).map((x) => x.id), [2]);
  assert.deepEqual(filterSeason(list, {}, new Set()).map((x) => x.id), [1, 2]);
});

test('排序：放送日 / 评分 / 热度 / 名称', () => {
  const list = [
    { id: 1, titleZh: '丙', begin: ANIME.begin, score: 7.0, watchers: 300 },
    { id: 2, titleZh: '甲', begin: '2026-10-01T15:00:00.000Z', score: 8.5, watchers: 100 },
    { id: 3, titleZh: '乙', begin: '2026-10-04T15:00:00.000Z', score: 6.0, watchers: 900 },
  ];
  assert.deepEqual(sortList(list, 'air').map((x) => x.id), [2, 3, 1]);
  assert.deepEqual(sortList(list, 'score').map((x) => x.id), [2, 1, 3]);
  assert.deepEqual(sortList(list, 'heat').map((x) => x.id), [3, 1, 2]);
  assert.deepEqual(sortList(list, 'title').map((x) => x.id), [1, 2, 3]); // 丙甲乙 按拼音 b/j/y
});

/* ---------------- 数据源适配 ---------------- */

test('bangumi-data 条目：ID 取 sites 里的 bangumi 项，缺 ID 时仍给出可用的搜索链接', () => {
  const raw = {
    title: 'サンプルアニメ',
    titleTranslate: { 'zh-Hans': ['示例动画'] },
    begin: '2026-10-07T15:00:00.000Z',
    broadcast: 'R/2026-10-07T15:00:00.000Z/P7D',
    type: 'tv',
    sites: [{ site: 'bangumi', id: '412008' }, { site: 'bilibili', id: 'xx' }],
  };
  assert.equal(bangumiIdOf(raw), 412008);

  const mapped = mapItem(raw);
  assert.equal(mapped.id, 412008);
  assert.equal(mapped.titleZh, '示例动画');
  assert.equal(mapped.season, '2026q4');
  assert.equal(mapped.platform, 'TV');
  assert.equal(mapped.external.bangumi, 'https://bgm.tv/subject/412008');
  assert.ok(mapped.external.moegirl.includes('zh.moegirl.org.cn'));

  const noId = mapItem({ ...raw, sites: [] });
  assert.ok(noId.id > 0);
  assert.ok(noId.external.bangumi.includes('subject_search'));
});

test('季度列表：下一季在最前，往后排到第 7 季，当前季度在列', () => {
  const list = availableSeasons(ANCHOR);
  assert.equal(currentSeason(ANCHOR), '2026q4');
  assert.equal(list.length, 9);
  assert.equal(list[0], '2027q1', '排在最前的应该是下一季');
  assert.ok(list.includes(currentSeason(ANCHOR)), '当前季度必须在可选列表里');
  assert.deepEqual(list.slice(0, 3), ['2027q1', '2026q4', '2026q3']);
  // 列表里不该出现重复或倒挂
  assert.equal(new Set(list).size, list.length);
});

/* ---------------- 演示数据自洽（全部虚构） ---------------- */

test('演示数据：字段齐全、周期合法、外链是 https', () => {
  const season = buildMockSeason(NOW);
  assert.equal(season.length, 18);
  for (const a of season) {
    assert.ok(a.id && a.titleZh && a.titleJa && a.begin && a.broadcast);
    assert.equal(parsePeriodDays(a.broadcast), 7);
    assert.equal(seasonOf(Date.parse(a.begin)), a.season);
    assert.ok(a.external.bangumi.startsWith('https://'));
    assert.ok(a.external.moegirl.startsWith('https://'));
    assert.ok(a.cover.from.startsWith('hsl('));
  }
  assert.equal(new Set(season.map((a) => a.id)).size, season.length, 'ID 不应重复');
});

test('演示数据覆盖「已更新」与「还没更新」两种状态', () => {
  const season = buildMockSeason(NOW);
  // 演示季度从 5 周前开播，所以每部番的第一集都已经播过了
  const aired = season.filter((a) => watchState(a, 0, NOW).airedCount > 0);
  assert.equal(aired.length, season.length);

  // 追到第 5 话之后，就会有一部分番的下一集还没播 —— 追番页的倒计时有东西可算
  const upcoming = season.filter((a) => {
    const s = watchState(a, 5, NOW);
    return s.next.ms != null && s.next.ms > NOW;
  });
  assert.ok(upcoming.length > 0, '应存在下一集尚未播出的番');
});

test('演示数据均匀铺满一整周，周日档不能是空的', () => {
  const season = buildMockSeason(NOW);
  const days = new Set(season.map((a) => weekdayJST(Date.parse(a.begin))));
  assert.equal(days.size, 7, `七天应都有排播，实际只有：${[...days].join('、')}`);

  const week = buildWeek(season, NOW);
  for (const col of week) {
    assert.ok(col.items.length > 0, `${col.label} 应有排播`);
  }
});

test('演示用户状态：追番与补番卡都能对上真实条目', () => {
  const season = buildMockSeason(NOW);
  const archive = buildMockArchive(NOW);
  assert.equal(archive.length, 5);

  const seed = buildMockUserState(season, archive, NOW);
  assert.equal(Object.keys(seed.following).length, 6);
  assert.equal(seed.catchup.length, 5);

  const seasonIds = new Set(season.map((a) => a.id));
  for (const id of Object.keys(seed.following)) {
    assert.ok(seasonIds.has(Number(id)), `追番 ${id} 应在演示番剧表里`);
  }
  const pool = new Set([...season, ...archive].map((a) => a.id));
  for (const c of seed.catchup) {
    assert.ok(pool.has(c.subjectId), `补番卡 ${c.subjectId} 应能对上条目`);
    assert.ok(c.targetEps > 0);
  }
  // deadline 要覆盖到逾期这一档，补番页才有得演示
  assert.ok(seed.catchup.some((c) => deadlineStatus(c.deadline, NOW).level === 'overdue'));
});
