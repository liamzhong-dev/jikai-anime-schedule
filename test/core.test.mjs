import test from 'node:test';
import assert from 'node:assert/strict';

import {
  airingsInRange, allSeasons, clockCST, countdown, countdownLabel, dateCST, isLateNight,
  matchSeasons, nextSeasonOf, parsePeriodDays, parseSeason, seasonLabel, seasonOf, seasonRange,
  sinceLabel, toCST, toJST, watchState, weekdayJST,
} from '../src/core/time.js';
import { buildNight, buildWeek, upcomingWithin } from '../src/core/schedule.js';
import { deadlineStatus, daysUntil, progress, sortCatchup } from '../src/core/catchup.js';
import { filterSeason, matchKeyword, sortList } from '../src/core/filters.js';
import {
  POSITION_STEP, clampPercent, coverOverflow, describePosition, dragToPercent,
  positionToPercent, resolvePosition,
} from '../src/core/wallpaper.js';
import {
  CARD_MIN, RESIZE_CURSOR, RESIZE_DIRS, clampCardMin, fitRect, resizeRect,
} from '../src/core/layout.js';
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

/* ---------------- 季度范围与搜索（顶栏 / 更新数据共用） ---------------- */

test('季度区间：闭区间、新的在前、端点写反也认', () => {
  const asc = seasonRange('2020q1', '2020q4');
  assert.deepEqual(asc, ['2020q4', '2020q3', '2020q2', '2020q1']);
  // 期望值从输入推：跨越的年数 × 4，不是写死的数字
  const years = 2020 - 2020;
  assert.equal(asc.length, years * 4 + 4);

  // 夸年：2025q4 → 2026q1 中间不该断
  assert.deepEqual(seasonRange('2025q4', '2026q1'), ['2026q1', '2025q4']);
  // 写反了自动换过来，不报错 —— 端点多半是从界面上拿的
  assert.deepEqual(seasonRange('2020q4', '2020q1'), asc);
  // 认不出来的 key 给空数组，不要给一个「看着像结果」的东西
  assert.deepEqual(seasonRange('乱七八糟', '2020q1'), []);
});

test('下一季：跨年进位', () => {
  assert.equal(nextSeasonOf(Date.parse('2026-10-07T04:00:00.000Z')), '2027q1'); // 2026q4 → 下一季
  assert.equal(nextSeasonOf(Date.parse('2026-01-07T04:00:00.000Z')), '2026q2'); // 2026q1 → 下一季
  assert.equal(parseSeason('2027q1').year, 2027);
  assert.equal(parseSeason('乱七八糟'), null);
});

test('全部季度：从 2000 年铺到下一季，2011 年 7 月番在里面', () => {
  const list = allSeasons(ANCHOR);
  assert.equal(list[0], nextSeasonOf(ANCHOR), '最新的应该是下一季（和 availableSeasons 口径一致）');
  assert.equal(list[list.length - 1], '2000q1', '最早的是 fromYear 的冬季');
  assert.equal(new Set(list).size, list.length, '不该有重复');

  // 条数从两端现算，不手写
  const span = Number(list[0].slice(0, 4)) - Number(list[list.length - 1].slice(0, 4));
  assert.equal(list.length, span * 4 + 1);

  // ⚠️ 这条就是这次要修的那个问题本身：老番以前**根本选不到**
  assert.ok(list.includes('2011q3'), '2011 年 7 月番必须在可选列表里');
  assert.ok(list.includes(currentSeason(ANCHOR)), '当前季当然也要在');
});

test('季度搜索：年份 / qN / 月份 / 季节名都能落到同一季', () => {
  const LIST = ['2012q1', '2011q4', '2011q3', '2011q2', '2011q1', '2010q4'];

  assert.deepEqual(matchSeasons(LIST, '2011q3'), ['2011q3'], 'qN 直接定位');
  assert.deepEqual(matchSeasons(LIST, '2011Q3'), ['2011q3'], '大小写不敏感');
  assert.deepEqual(matchSeasons(LIST, '2011'), ['2011q4', '2011q3', '2011q2', '2011q1'], '只给年份 = 那一年四季');
  assert.deepEqual(matchSeasons(LIST, '2011 年 7 月'), ['2011q3'], '7 月开播 = 第三季');
  assert.deepEqual(matchSeasons(LIST, '2011-07'), ['2011q3'], '月份不带「月」也认');
  assert.deepEqual(matchSeasons(LIST, '2011 3'), ['2011q3'], '第二个数 1~4 当季度号');
  assert.deepEqual(matchSeasons(LIST, '秋'), ['2011q4', '2010q4'], '季节名 = 所有年的那一季');
  assert.deepEqual(matchSeasons(LIST, '2011 10'), ['2011q4'], '10 月开播 = 第四季');

  // 空关键词给全部；limit 只截前 N 个
  assert.deepEqual(matchSeasons(LIST, ''), LIST);
  assert.deepEqual(matchSeasons(LIST, '', { limit: 2 }), ['2012q1', '2011q4']);
});

test('季度搜索：反向用例 —— 认不出来时必须给空，不能装作匹配上了', () => {
  const LIST = ['2011q4', '2011q3', '2011q2', '2011q1'];
  // 这是最要紧的一条：打错字却弹出一长串无关季度，比明确说「没匹配上」更让人困惑
  assert.deepEqual(matchSeasons(LIST, 'zzz'), []);
  assert.deepEqual(matchSeasons(LIST, '两千一十一'), []);
  // 年份对不上、季度对得上 → 仍然为空（两个条件是和的关系，不是或）
  assert.deepEqual(matchSeasons(LIST, '1999q3'), []);
  // 不合法输入不该把整个界面搞崩
  assert.deepEqual(matchSeasons(null, '2011'), []);
  assert.deepEqual(matchSeasons(LIST, null).length, LIST.length);
});

/* ═══════════════════════════════════════════════════════════
 * 壁纸取景框的几何
 *
 * 这一段是「设置里那个框拖起来对不对」的全部依据 —— 拖动只有在真机上才动得起来，
 * 换算错了表现成「拖起来怪怪的」，不会报错，所以只能在这一层钉死。
 * ═══════════════════════════════════════════════════════════ */

test('壁纸位置：老关键字能升上来，新字段优先', () => {
  assert.deepEqual(positionToPercent('top'), [50, 0]);
  assert.deepEqual(positionToPercent('right'), [100, 50]);
  assert.deepEqual(positionToPercent('center'), [50, 50]);
  assert.deepEqual(positionToPercent('  LEFT  '), [0, 50], '大小写和空格不该影响');
  assert.deepEqual(positionToPercent('斜着'), [50, 50], '认不出来按居中');
  assert.deepEqual(positionToPercent(undefined), [50, 50]);
  assert.deepEqual(positionToPercent(null), [50, 50]);

  assert.deepEqual(resolvePosition({}), { x: 50, y: 50 });
  assert.deepEqual(resolvePosition({ position: 'bottom' }), { x: 50, y: 100 });
  // ⚠️ 两个都有时新字段赢。反过来（升上来的老关键字把新位置顶掉）会表现成
  //    「拖好位置、一动别的设置就弹回去」，而且完全看不出是哪一步干的
  assert.deepEqual(resolvePosition({ x: 12, y: 88, position: 'top' }), { x: 12, y: 88 });
  // 只给一个轴：另一个轴按居中，不回落到关键字 —— 半套坐标本来就是坏数据，
  // 一条规则（缺就居中）比两条规则（缺就看关键字）好预测
  assert.deepEqual(resolvePosition({ x: 12, position: 'top' }), { x: 12, y: 50 });
  assert.deepEqual(resolvePosition({ x: 999, y: -5 }), { x: 100, y: 0 });
});

test('百分比夹取：非数字一律走居中，不吐 NaN', () => {
  assert.equal(clampPercent(0), 0);
  assert.equal(clampPercent(100), 100);
  assert.equal(clampPercent(150), 100);
  assert.equal(clampPercent(-20), 0);
  assert.equal(clampPercent(12.34), 12.3, '留一位小数就够了，多了是噪声');
  assert.equal(clampPercent('abc'), 50);
  assert.equal(clampPercent(NaN), 50);
  assert.equal(clampPercent(null), 50);
});

test('cover 溢出量：分母是「图比框大出来的那一块」，不是框的边长', () => {
  // 竖图铺进横框：宽度正好铺满（溢出 0 → 取 1 避免除零），高度溢出 600
  assert.deepEqual(
    coverOverflow({ imgW: 1600, imgH: 2400, boxW: 800, boxH: 600 }),
    { x: 1, y: 600, known: true },
  );
  // 横图铺进同一个框：反过来，宽度溢出 100、高度正好铺满
  assert.deepEqual(
    coverOverflow({ imgW: 2400, imgH: 1600, boxW: 800, boxH: 600 }),
    { x: 100, y: 1, known: true },
  );
  // 同比例：两个方向都不溢出
  assert.deepEqual(
    coverOverflow({ imgW: 1600, imgH: 1200, boxW: 800, boxH: 600 }),
    { x: 1, y: 1, known: true },
  );
  // 不知道原图尺寸（老存档没存 imgW/imgH）：退化成按框的边长算，标记成 known=false
  const unknown = coverOverflow({ imgW: null, imgH: null, boxW: 800, boxH: 600 });
  assert.equal(unknown.known, false);
  assert.deepEqual([unknown.x, unknown.y], [800, 600]);
  assert.ok(Number.isFinite(unknown.x) && unknown.x > 0, '除零守卫必须在，否则位移会放大成无穷');
});

test('拖动换算：方向是反的 —— 把图往右拖，X 要变小', () => {
  const base = { x: 50, y: 50, overflowX: 400, overflowY: 400 };
  const right = dragToPercent({ ...base, dx: 100, dy: 0 });
  assert.equal(right.x, 25, '往右拖 100px = 溢出量的 1/4 → X 减 25（跟拖地图一样，方向是反的）');
  assert.equal(right.y, 50, '只拖水平方向，Y 不该动');

  const up = dragToPercent({ ...base, dx: 0, dy: -200 });
  assert.equal(up.y, 100, '往上拖 → 想看更靠下的部分 → Y 变大（同样是反的）');

  // 夹住：拖出框外不该得到 -300% 这种值
  assert.deepEqual(dragToPercent({ ...base, dx: 99999, dy: 99999 }), { x: 0, y: 0 });
  assert.deepEqual(dragToPercent({ ...base, dx: -99999, dy: -99999 }), { x: 100, y: 100 });

  // 溢出为 0 的维度不能除零 —— 出现 NaN 的话位置会直接飞掉，而界面上只是「图不见了」
  const flat = dragToPercent({ x: 50, y: 50, dx: 10, dy: 10, overflowX: 0, overflowY: 0 });
  assert.ok(Number.isFinite(flat.x) && Number.isFinite(flat.y), '不能出现 NaN');
});

test('位置说人话：三档 × 三档，坏值不吐 NaN', () => {
  assert.equal(describePosition(50, 50), '水平居中 · 垂直居中');
  assert.equal(describePosition(0, 0), '偏左 · 偏上');
  assert.equal(describePosition(100, 100), '偏右 · 偏下');
  assert.equal(describePosition(34, 66), '水平居中 · 垂直居中', '34 / 66 是分界点，落在「居中」这一档');
  assert.equal(describePosition(33, 67), '偏左 · 偏下');
  assert.equal(describePosition(NaN, 'x'), '水平居中 · 垂直居中');
  assert.equal(POSITION_STEP, 2, '方向键一次的步长');
});

/* ═══════════════════════════════════════════════════════════
 * 卡片窗口的缩放几何
 * ═══════════════════════════════════════════════════════════ */

test('缩放把手：八个方向齐、指针样式齐（斜角的命名是反的）', () => {
  assert.equal(RESIZE_DIRS.length, 8);
  assert.equal(new Set(RESIZE_DIRS).size, 8, '不能有重复方向');
  for (const d of RESIZE_DIRS) assert.ok(RESIZE_CURSOR[d], `${d} 没有配鼠标指针`);
  // ↗↙ 是一条对角线（ne / sw），↖↘ 是另一条（nw / se）—— 按直觉写必错
  assert.equal(RESIZE_CURSOR.ne, RESIZE_CURSOR.sw);
  assert.equal(RESIZE_CURSOR.nw, RESIZE_CURSOR.se);
  assert.notEqual(RESIZE_CURSOR.ne, RESIZE_CURSOR.nw);
});

test('缩放：八条边各拖一次，方向都要对', () => {
  const base = { x: 100, y: 100, w: 400, h: 300 };
  assert.deepEqual(resizeRect({ base, dx: 50, dy: 30, dir: 'se' }), { x: 100, y: 100, w: 450, h: 330 });
  assert.deepEqual(resizeRect({ base, dx: 50, dir: 'e' }), { x: 100, y: 100, w: 450, h: 300 }, 'e 只改宽');
  assert.deepEqual(resizeRect({ base, dy: 30, dir: 's' }), { x: 100, y: 100, w: 400, h: 330 }, 's 只改高');

  // 西侧：往左拖是变大，而且**右边缘必须钉住**（400+100=500）
  const westOut = resizeRect({ base, dx: -50, dir: 'w' });
  assert.deepEqual(westOut, { x: 50, y: 100, w: 450, h: 300 });
  assert.equal(westOut.x + westOut.w, 500, '右边缘不动才是「往外拉」');
  const westIn = resizeRect({ base, dx: 50, dir: 'w' });
  assert.deepEqual(westIn, { x: 150, y: 100, w: 350, h: 300 }, '往右拖是变小，右边缘仍在 500');

  // 北侧同理：100+300=400 是钉住的下边缘
  const northOut = resizeRect({ base, dy: -50, dir: 'n' });
  assert.deepEqual(northOut, { x: 100, y: 50, w: 400, h: 350 });
  assert.equal(northOut.y + northOut.h, 400);

  assert.deepEqual(resizeRect({ base, dx: -50, dy: -50, dir: 'nw' }), { x: 50, y: 50, w: 450, h: 350 });
  assert.deepEqual(resizeRect({ base, dx: 50, dy: -50, dir: 'ne' }), { x: 100, y: 50, w: 450, h: 350 });
  assert.deepEqual(resizeRect({ base, dx: -50, dy: 50, dir: 'sw' }), { x: 50, y: 100, w: 450, h: 350 });
});

test('缩放：夹到最小尺寸时，西 / 北侧的边缘不许跟着飘', () => {
  const base = { x: 100, y: 100, w: 400, h: 300 };

  const narrow = resizeRect({ base, dx: 500, dir: 'w' });
  assert.equal(narrow.w, 300, '宽度到最小就该停住');
  // ⚠️ 这是本段的重点：只写 `Math.max(minW, ...)` 而没把吃掉的那部分还给 x，
  //    会得到 x=600 —— 表现成「宽度已经到底了，卡片还在往左飘」
  assert.equal(narrow.x, 200, 'x 要正好等于「原右边缘 - 最小宽」');
  assert.equal(narrow.x + narrow.w, 500, '任何时候右边缘都不该动');

  const short = resizeRect({ base, dy: 500, dir: 'n' });
  assert.equal(short.h, 160);
  assert.equal(short.y, 240);
  assert.equal(short.y + short.h, 400);

  // 东南两侧不需要还 x / y：拉过头只是回到最小尺寸、原位不动
  assert.deepEqual(resizeRect({ base, dx: -500, dy: -500, dir: 'se' }), { x: 100, y: 100, w: 300, h: 160 });
});

test('缩放：西 / 北侧不许越过画布左上角，东 / 南侧不限', () => {
  const base = { x: 0, y: 0, w: 500, h: 400 };

  const west = resizeRect({ base, dx: -300, dir: 'w' });
  assert.equal(west.x, 0, 'x 不能变成负数（卡片会跑到画布外面去）');
  assert.equal(west.w, 500, 'x 到 0 之后宽度就不该再涨');
  assert.equal(west.x + west.w, 500, '右边缘始终不动');

  const north = resizeRect({ base, dy: -300, dir: 'n' });
  assert.equal(north.y, 0);
  assert.equal(north.h, 400);

  // 反向：东 / 南侧**不能**被夹 —— 用户就是要更大的卡片，画布会跟着滚。
  // 顺手在这里也夹一刀的话，表现成「怎么拖都到不了底」，很难联想到是这里
  const big = resizeRect({ base, dx: 2000, dy: 2000, dir: 'se' });
  assert.deepEqual(big, { x: 0, y: 0, w: 2500, h: 2400 });
});

test('缩放：缺参数不崩，坏方向退化成右下角', () => {
  assert.equal(resizeRect({}).w, 300, '没有 base 时给一套最小值，别吐 undefined');
  const base = { x: 10, y: 10, w: 400, h: 300 };
  assert.deepEqual(resizeRect({ base, dx: 50, dy: 50 }), resizeRect({ base, dx: 50, dy: 50, dir: 'se' }));
  assert.deepEqual(resizeRect({ base, dx: 50, dy: 50, dir: '乱七八糟' }), resizeRect({ base, dx: 50, dy: 50, dir: 'se' }));
});

test('首次适配：装不下就缩进来，装得下就一个字段都不动', () => {
  const r = { x: 16, y: 142, w: 1260, h: 660 };

  const narrow = fitRect(r, { availW: 900, availH: 700 });
  assert.equal(narrow.w, 900, '宽度要缩到画布里');
  assert.equal(narrow.h, 660, '高度装得下就别动');
  assert.equal(narrow.x, 16, '只改大小，不改摆位');
  assert.equal(narrow.y, 142);

  // 装得下的时候必须原样返回：每次挂载都偷偷缩一点的话，切几次视图卡片就没了
  assert.deepEqual(fitRect(r, { availW: 1400, availH: 900 }), r);

  // 极端窄窗：不能缩到比最小尺寸还小，否则卡片变成一条缝、把手也叠在一起
  const tiny = fitRect(r, { availW: 120, availH: 80 });
  assert.equal(tiny.w, 300);
  assert.equal(tiny.h, 160);

  // 量不出可用空间时原样返回（宁可摆大一点，也不要因为一次读不到尺寸就永久缩小）
  assert.deepEqual(fitRect(r, {}), r);
  assert.deepEqual(fitRect(r, { availW: NaN, availH: 0 }), r);
});

test('一格宽档位：越界夹回，坏值用默认', () => {
  assert.equal(clampCardMin(160), 160);
  assert.equal(clampCardMin('160'), 160, '存档里可能是字符串');
  assert.equal(clampCardMin(undefined), CARD_MIN.def, '老存档里没这个字段');
  assert.equal(clampCardMin('abc'), CARD_MIN.def);
  assert.equal(clampCardMin(1), CARD_MIN.min);
  assert.equal(clampCardMin(9999), CARD_MIN.max);
  assert.ok(CARD_MIN.min < CARD_MIN.def && CARD_MIN.def < CARD_MIN.max, '默认值要落在范围里');
});
