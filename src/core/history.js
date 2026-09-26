/**
 * 追番历程：把「什么时候开始追、多久追完」摊成一条时间线。
 *
 * ⚠️ 时间戳是从 2026-09-26 才开始记的（`following[id].followedAt` / `lastAt`）。
 * 在那之前加进追番的作品**没有时间**，这里一律按「时间未知」处理 ——
 * 编一个假时间比空着更坏：用户会拿它当真的，然后拿它去回忆。
 *
 * 这个模块里**没有一个数字是用户填的**，全是从 following 与 diary 推出来的。
 * 既然是推的，就该待在纯函数层 —— 能进 `node --test`，不用靠「跑一遍看看」验。
 */

import { MS_PER_DAY, dateCST } from './time.js';

/**
 * 「看完」的判定：只认「已看集数 ≥ 总集数」，**拿不到总集数就一律不判**。
 *
 * 为什么不猜：`eps` 拿不到时（条目不在库里、或条目本身没写集数）如果按
 * 「看了几集就算几集」去推，每一部都会在某一刻突然变成「已看完」，
 * 而用户从没做过这个动作。宁可这一部不出现「看完」事件，
 * 也不要一条假事件 —— 历程的全部价值都在时间点上。
 */
export function isFinished(f, anime) {
  const eps = Number(anime?.eps);
  const watched = Number(f?.watchedEps) || 0;
  return Number.isFinite(eps) && eps > 0 && watched >= eps;
}

/** 时间戳归一：不是有限正数就当「没有」。0 和 NaN 都走这条路 */
function timeOf(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 事件流，按时间倒序。
 *
 * 只出两类事件：`follow`（加入追番）与 `finish`（看完）。
 * 中间的「看到第几集」不单独成事件 —— 一部 12 集的番会刷出 12 条，
 * 时间线立刻变成流水账，而用户想看的恰恰是两端的两个点。
 *
 * @returns {Array<{id,key,kind:'follow'|'finish',at:number|null,atKnown:boolean,days:number|null,anime:object|null}>}
 */
export function historyEvents({ following = {}, lookup = () => null } = {}) {
  const out = [];

  for (const [key, f] of Object.entries(following ?? {})) {
    if (!f || typeof f !== 'object') continue;
    const anime = lookup?.(key) ?? null;
    const id = Number(key) || key;
    const followedAt = timeOf(f.followedAt);
    const lastAt = timeOf(f.lastAt);

    if (followedAt) {
      out.push({ id, key, kind: 'follow', at: followedAt, atKnown: true, days: null, anime });
    }

    if (isFinished(f, anime)) {
      // 完成时间取 `lastAt`（最后一次推进进度的时刻 —— 看完了那次就是它）。
      // 拿不到就退回加入时间：至少这条还排得进时间线，而不是整条从图上消失。
      // `atKnown` 记下这个退回，界面要能说清「这个日期其实不是完成日」。
      out.push({
        id,
        key,
        kind: 'finish',
        at: lastAt ?? followedAt,
        atKnown: lastAt !== null,
        days: followedAt && lastAt ? Math.max(0, Math.round((lastAt - followedAt) / MS_PER_DAY)) : null,
        anime,
      });
    }
  }

  // 时间倒序；同一天的「看完」排在「开始追」之前（那是后发生的事）。
  // `at` 为 null 的一律沉底 —— 它们没有位置可排，混在中间会让人以为那天真出了事。
  out.sort((a, b) => {
    if (a.at === null || b.at === null) {
      if (a.at === b.at) return String(a.key).localeCompare(String(b.key));
      return a.at === null ? 1 : -1;
    }
    if (a.at !== b.at) return b.at - a.at;
    if (a.kind !== b.kind) return a.kind === 'finish' ? -1 : 1;
    return String(a.key).localeCompare(String(b.key));
  });

  return out;
}

/**
 * 「哪部对我最重要」—— 用**笔记写了多少字**来定。
 *
 * 为什么用这个而不是「追番次数」「出度」之类：笔记是用户唯一一处
 * 主动花时间留下来的东西。为一部番写 300 字的人，跟只点了个星标的人，
 * 差别是真实的；而「因为这部去追了那部」的次数只反映它有多热门。
 *
 * ⚠️ 没有笔记时返回 null，**不硬凑一部出来** —— 凑出来的「最重要」是假的，
 * 而假的排行榜比没有排行榜更坏。
 */
function highlightOf(diary, lookup) {
  let best = null;
  for (const [key, rec] of Object.entries(diary ?? {})) {
    const list = Array.isArray(rec?.entries) ? rec.entries : [];
    const notes = list.filter((e) => String(e?.note ?? '').length > 0);
    const chars = notes.reduce((n, e) => n + String(e.note).length, 0);
    if (chars <= 0) continue;
    if (!best || chars > best.chars) {
      best = { id: Number(key) || key, key, chars, notes: notes.length, anime: lookup?.(key) ?? null };
    }
  }
  return best;
}

/**
 * 汇总。
 *
 * `tracking` 与 `untimed` 一定要分开给：界面必须能说出「这几个数字里
 * 有多少是估算的」。合成一个总数字看着整齐，但那个数字根本不成立 ——
 * 没有时间戳的作品对「平均多少天追完」毫无贡献，混进分母就是造假。
 */
export function historyStats({ following = {}, diary = {}, lookup = () => null, nowMs = Date.now() } = {}) {
  const list = Object.entries(following ?? {}).filter(([, f]) => f && typeof f === 'object');

  let tracking = 0;   // 有 followedAt 的
  let untimed = 0;    // 没有时间戳的
  let finished = 0;   // 判定为看完的
  const spans = [];
  let firstAt = null;

  for (const [key, f] of list) {
    const followedAt = timeOf(f.followedAt);
    const lastAt = timeOf(f.lastAt);

    if (followedAt) {
      tracking += 1;
      if (firstAt === null || followedAt < firstAt) firstAt = followedAt;
    } else {
      untimed += 1;
    }

    if (isFinished(f, lookup?.(key) ?? null)) {
      finished += 1;
      // 只有两端时间都在、且不倒挂，才算得出耗时。倒挂说明数据被手改过，
      // 这时候算出来的是负数，「-3 天看完」比不显示更让人困惑。
      if (followedAt && lastAt && lastAt >= followedAt) {
        spans.push(Math.round((lastAt - followedAt) / MS_PER_DAY));
      }
    }
  }

  const avgDays = spans.length
    ? Math.round((spans.reduce((a, b) => a + b, 0) / spans.length) * 10) / 10
    : null;

  return {
    total: list.length,
    tracking,
    untimed,
    finished,
    timed: spans.length,
    avgDays,
    fastest: spans.length ? Math.min(...spans) : null,
    slowest: spans.length ? Math.max(...spans) : null,
    firstAt,
    spanDays: firstAt ? Math.max(0, Math.floor((nowMs - firstAt) / MS_PER_DAY)) : null,
    highlight: highlightOf(diary, lookup),
  };
}

/** 给界面用的一句话汇总（组件里不拼字符串，跟 diary.js 的 describeGap 一个道理） */
export function describeHistory(stats) {
  if (!stats || !stats.total) return '还没有追番 —— 去「本季番剧」点封面右上角的星星';
  if (!stats.tracking) {
    return `追着 ${stats.total} 部，但都还没有时间戳。从今天起新加的追番才会出现在时间线上。`;
  }
  const head = `从 ${dateCST(stats.firstAt)} 起，追了 ${stats.total} 部`;
  const mid = stats.finished ? `，其中 ${stats.finished} 部看完了` : '，还没看完过一部';
  const tail = stats.avgDays != null ? `，平均 ${formatSpan(stats.avgDays)} 看掉一部` : '';
  return head + mid + tail;
}

/** 天数转成人话。0 天要说「当天」而不是「0 天」 */
export function formatSpan(days) {
  if (days === null || days === undefined || days === '') return null;
  const n = Number(days);
  if (!Number.isFinite(n)) return null;
  const d = Math.max(0, Math.round(n));
  if (d === 0) return '当天';
  if (d < 31) return `${d} 天`;
  if (d < 365) return `${Math.round(d / 30)} 个月`;
  return `${(d / 365).toFixed(1)} 年`;
}
