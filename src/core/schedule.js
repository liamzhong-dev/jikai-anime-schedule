import { MS_PER_DAY, airingsInRange, startOfCSTDay, toCST } from './time.js';

/**
 * 时间表构建。
 *
 * 分组口径：按**北京时间**的日期归组，而不是日本时间。
 * 理由：用户是在北京时间的夜里看更新，日本 25:30 的档期在他这里就是次日 00:30，
 * 按 JST 归组会让这张表和他真正熬夜的时间对不上。
 */

const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]; // 周一 … 周日

/**
 * 周视图：返回七天，每天含该日（北京时间）的播出条目。
 * @param {Array} animes
 * @param {number} anchorMs 周内的任一天，用来定位这一周
 */
export function buildWeek(animes, anchorMs = Date.now()) {
  const dayStart = startOfCSTDay(anchorMs);
  // 把 anchor 所在周对齐到周一（北京时间）
  const anchorWeekday = toCST(anchorMs).weekday; // 0=周日
  const backDays = (anchorWeekday + 6) % 7;
  const mondayStart = dayStart - backDays * MS_PER_DAY;

  return WEEK_ORDER.map((weekday, i) => {
    const from = mondayStart + i * MS_PER_DAY;
    const to = from + MS_PER_DAY;
    const items = [];
    for (const anime of animes) {
      for (const air of airingsInRange(anime, from, to)) {
        items.push({ anime, ms: air.ms, episode: air.episode, uncertain: air.uncertain });
      }
    }
    items.sort((a, b) => a.ms - b.ms);
    const cst = toCST(from);
    return {
      weekday,
      from,
      to,
      label: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][weekday],
      dateLabel: `${cst.month}/${cst.day}`,
      // 与 anchor 比，而不是与真实当下比 —— 否则传进来的锚点会被无视
      isToday: from === dayStart,
      items,
    };
  });
}

/** 深夜档窗口的起点：当天 18:00（北京时间） */
export const NIGHT_START_HOUR = 18;
const NIGHT_HOURS = 12; // 18:00 → 次日 06:00

/**
 * 深夜档窗口：当天 18:00 到次日 06:00 之间会播什么。
 *
 * 之所以不从 00:00 起算：番剧党真正会守着看的就是这段，
 * 日本 25:30 这类档期换算过来正好落在凌晨，切掉就看不见了。
 */
export function buildNight(animes, nowMs = Date.now()) {
  const from = startOfCSTDay(nowMs) + NIGHT_START_HOUR * 3600000;
  const to = from + NIGHT_HOURS * 3600000;

  const items = [];
  for (const anime of animes) {
    for (const air of airingsInRange(anime, from, to, 3)) {
      items.push({ anime, ms: air.ms, episode: air.episode, uncertain: air.uncertain });
    }
  }
  items.sort((a, b) => a.ms - b.ms);
  return { from, to, items };
}

/**
 * 「接下来 N 天」该列哪些。
 *
 * 只收还没到的更新：已经播过的属于「该补了」，混进倒计时列表会被读成
 * 「3 小时后更新」，而实际上那是 3 小时前。负的时间差一律排除。
 *
 * @param {Array<{next:{ms:number|null}}>} rows
 */
export function upcomingWithin(rows, nowMs = Date.now(), windowMs = 7 * MS_PER_DAY) {
  return rows
    .filter((r) => {
      const ms = r.next?.ms;
      return ms != null && ms > nowMs && ms - nowMs < windowMs;
    })
    .sort((a, b) => a.next.ms - b.next.ms);
}
