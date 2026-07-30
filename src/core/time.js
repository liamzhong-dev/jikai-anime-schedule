/**
 * 播出时间推算 —— 整个工具的命门。
 *
 * 数据前提（来自 M0 实测）：
 *   begin     = "2026-10-07T15:00:00.000Z"        首播时刻，UTC 绝对时间，精确到分钟
 *   broadcast = "R/2026-10-07T15:00:00.000Z/P7D"  RFC 5545 重复规则，末尾是周期
 *
 * 三个必须记住的坑：
 *   1. begin 是 UTC，直接按它取日期会错 —— 15:00Z 在日本是次日 00:00（深夜档）。
 *   2. 所以「星期几」必须先换算到 JST(+09:00) 再取，否则整张时间表集体错一天。
 *   3. 显示给用户的是北京时间 CST(+08:00)，比 JST 早一小时。
 */

export const MS_PER_DAY = 86400000;
export const JST_OFFSET_MS = 9 * 3600000; // UTC+09:00
export const CST_OFFSET_MS = 8 * 3600000; // UTC+08:00

const WEEKDAY_JST = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 解析 broadcast 的周期，返回天数；无法识别则返回 null。
 * 实测全库只出现 P7D / P1D / P2D / P1M / P0D，没有 EXDATE 之类复杂规则。
 */
export function parsePeriodDays(broadcast) {
  if (typeof broadcast !== 'string' || !broadcast) return null;
  const period = broadcast.split('/').pop();
  if (!period) return null;
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:(\d+)M)?$/.exec(period);
  if (!m) return null;
  const [, w, d, mo] = m;
  const days = (w ? Number(w) * 7 : 0) + (d ? Number(d) : 0) + (mo ? Number(mo) * 30 : 0);
  return days > 0 ? days : null;
}

/** 把 UTC 时刻搬到某个时区后取「当地日历分量」 */
function shifted(utcMs, offsetMs) {
  const d = new Date(utcMs + offsetMs);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: d.getUTCDay(),
  };
}

export const toJST = (utcMs) => shifted(utcMs, JST_OFFSET_MS);
export const toCST = (utcMs) => shifted(utcMs, CST_OFFSET_MS);

/** 星期按日本首播时间算（深夜档 25:30 归属次日） */
export function weekdayJST(utcMs) {
  return WEEKDAY_JST[toJST(utcMs).weekday];
}

/** 北京时间 HH:mm */
export function clockCST(utcMs) {
  const p = toCST(utcMs);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** 北京时间 M月D日 */
export function dateCST(utcMs) {
  const p = toCST(utcMs);
  return `${p.month}月${p.day}日`;
}

/** 北京时间 M月D日 HH:mm */
export function dateTimeCST(utcMs) {
  return `${dateCST(utcMs)} ${clockCST(utcMs)}`;
}

/**
 * 一部番的追番状态 —— 界面真正需要的那几个数。
 *
 * 之所以不只用「下一集」一个值：用户落后三话和番本身停更是两回事，
 * 前者该催他补、后者才该提示异常。这两件事必须分开，否则界面会瞎报警。
 *
 * @param {object} anime  { begin, broadcast, eps }
 * @param {number} watchedEps 已看集数
 * @param {number} nowMs
 * @returns {{
 *   next: {ms:number|null, episode:number, precision:'exact'|'date'|'none', finished:boolean},
 *   airedCount: number,          // 按时间推算已经播出的集数
 *   latest: {ms:number, episode:number}|null,  // 已播出的最后一集
 *   behind: number,              // 已播但还没看的集数
 *   finished: boolean,           // 整部已经播完
 * }}
 */
export function watchState(anime, watchedEps, nowMs = Date.now()) {
  const watched = Math.max(0, Number(watchedEps) || 0);
  const beginMs = Date.parse(anime?.begin ?? '');
  const episode = watched + 1;

  if (Number.isNaN(beginMs)) {
    return {
      next: { ms: null, episode, precision: 'none', finished: false },
      airedCount: 0, latest: null, behind: 0, finished: false,
    };
  }

  const total = Number.isFinite(anime.eps) && anime.eps > 0 ? anime.eps : null;
  const periodDays = parsePeriodDays(anime.broadcast);

  if (periodDays === null) {
    // 没有重复规则（老番常见）：只知道首播那一刻。
    // 首播已过就不再瞎猜「下一集」——宁可显示待定，也不要报一个错的时间去打扰用户。
    const aired = beginMs <= nowMs;
    return {
      next: { ms: aired ? null : beginMs, episode: 1, precision: 'date', finished: false },
      airedCount: aired ? 1 : 0,
      latest: aired ? { ms: beginMs, episode: 1 } : null,
      behind: aired ? 1 : 0,
      finished: false,
    };
  }

  const step = periodDays * MS_PER_DAY;

  // 按时间推算「本该播到第几话」，再夹到总话数之内
  const raw = Math.floor((nowMs - beginMs) / step) + 1;
  const airedCount = Math.max(0, total != null ? Math.min(raw, total) : raw);
  const latest = airedCount > 0 ? { ms: beginMs + (airedCount - 1) * step, episode: airedCount } : null;
  const finished = total != null && airedCount >= total;

  const nextMs = finished && episode > total ? null : beginMs + (episode - 1) * step;

  return {
    next: { ms: nextMs, episode, precision: 'exact', finished },
    airedCount,
    latest,
    behind: Math.max(0, airedCount - watched),
    finished,
  };
}

/**
 * 列出某部番在 [fromMs, toMs) 内的所有播出时刻，用于时间表。
 * 无 broadcast 时只在首播日落一次，并标记 uncertain（时刻待定）。
 */
export function airingsInRange(anime, fromMs, toMs, maxCount = 60) {
  const beginMs = Date.parse(anime.begin ?? '');
  if (Number.isNaN(beginMs)) return [];

  const periodDays = parsePeriodDays(anime.broadcast);
  if (periodDays === null) {
    return beginMs >= fromMs && beginMs < toMs ? [{ ms: beginMs, episode: 1, uncertain: true }] : [];
  }

  const step = periodDays * MS_PER_DAY;
  // 从「本窗口之前最近一次播出」开始，避免漏掉起点前的那一集
  let index = Math.floor((fromMs - beginMs) / step);
  if (index < 0) index = 0;

  const out = [];
  for (let i = index; out.length < maxCount; i += 1) {
    const ms = beginMs + i * step;
    if (ms >= toMs) break;
    const episode = i + 1;
    if (Number.isFinite(anime.eps) && anime.eps > 0 && episode > anime.eps) break;
    if (ms >= fromMs) out.push({ ms, episode, uncertain: false });
  }
  return out;
}

/** 倒计时拆分 */
export function countdown(targetMs, nowMs = Date.now()) {
  const diff = targetMs - nowMs;
  const overdue = diff < 0;
  const abs = Math.abs(diff);
  return {
    diff,
    overdue,
    days: Math.floor(abs / MS_PER_DAY),
    hours: Math.floor((abs % MS_PER_DAY) / 3600000),
    minutes: Math.floor((abs % 3600000) / 60000),
  };
}

/** 倒计时主显示：两天以上按天，一天以内按小时，一小时内按分钟 */
export function countdownLabel(cd) {
  if (cd.days >= 1) return { value: cd.days, unit: cd.days >= 2 ? '天后' : '明天' };
  if (cd.hours >= 1) return { value: cd.hours, unit: '小时后' };
  return { value: Math.max(cd.minutes, 1), unit: '分钟后' };
}

/** 「已更新多久」的短描述 */
export function sinceLabel(targetMs, nowMs = Date.now()) {
  const cd = countdown(targetMs, nowMs);
  if (cd.days >= 1) return `${cd.days} 天前已更新`;
  if (cd.hours >= 1) return `${cd.hours} 小时前已更新`;
  return `${Math.max(cd.minutes, 1)} 分钟前已更新`;
}

/** 北京时间当天 00:00 对应的 UTC 时刻 */
export function startOfCSTDay(nowMs = Date.now()) {
  const p = toCST(nowMs);
  return Date.UTC(p.year, p.month - 1, p.day) - CST_OFFSET_MS;
}

/**
 * 深夜档判定：北京时间 00:00–06:00 的播出。
 * 这一段是番剧党真正的作息时间，界面上会单独标出来。
 */
export function isLateNight(utcMs) {
  const h = toCST(utcMs).hour;
  return h >= 0 && h < 6;
}

/** 某时刻所属季度（按 JST 归季），如 2026q4 */
export function seasonOf(utcMs) {
  const p = toJST(utcMs);
  return `${p.year}q${Math.ceil(p.month / 3)}`;
}

// 季度在 ACG 圈按「冬春夏秋」称呼，正好对应 1/4/7/10 月开播
const SEASON_NAME = { 1: '冬', 2: '春', 3: '夏', 4: '秋' };

/** "2026q4" → "2026 年 10 月 · 秋" */
export function seasonLabel(key) {
  const m = /^(\d{4})q([1-4])$/.exec(String(key ?? ''));
  if (!m) return String(key ?? '');
  const year = m[1];
  const q = Number(m[2]);
  return `${year} 年 ${q * 3 - 2} 月 · ${SEASON_NAME[q]}`;
}
