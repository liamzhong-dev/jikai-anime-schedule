/**
 * 补番日记：给自己的评分与短评留档，并跟 Bangumi 的真实评分比对。
 *
 * 三条决定，都不是随手定的（细节见实施计划 §1）：
 *
 *  1. **评分用 1–10 的整数**。Bangumi 就是 1–10 整数；允许半分看着更精细，
 *     但代价是差值变得不可比 —— 而「可比」正是这个功能的全部意义。
 *  2. **一部作品可以有多条记录**。「日记」这个词本身意味着按时间累积，
 *     不是一格一格的属性；重看之后改主意、隔几天补记都很正常。
 *  3. **「我的评分」取最近一条带评分的记录，不是平均**。平均会把
 *     「从 7 改成 9」算成 8 —— 那不是任何一次真实的判断。
 *
 * 纯函数层：不碰平台适配器、不碰 React，所有形状变换都能被测试守住。
 */

export const RATING_MIN = 1;
export const RATING_MAX = 10;

/** 短评长度上限。够写两句话，又不至于把 state.json 撑起来 */
export const NOTE_MAX = 500;

/** 分档阈值：Bangumi 评分实际分布很窄（多数 5.5–8.5），差 1 分已是明显的取向差异 */
export const DIFF_AGREE = 1;
export const DIFF_NEAR = 2;

/**
 * 把用户输入揉成合法评分，非法一律返回 `null`。
 *
 * 为什么连「字符串数字」也收：输入框给回来的一律是字符串，
 * 这里不收就得让每个调用方各写一遍 `Number()`，迟早有一处忘掉，
 * 于是同一份数据里混进 `'8'` 和 `8`，`===` 比较全错。
 *
 * 不做四舍五入到半分、也不接受 8.5：见文件头第 1 条。
 */
export function normalizeRating(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) return null;
  const i = Math.round(n);
  if (i < RATING_MIN || i > RATING_MAX) return null;
  return i;
}

/** 短评规范化：去首尾空白、折叠连续空白、截断到上限 */
export function normalizeNote(value) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > NOTE_MAX ? s.slice(0, NOTE_MAX) : s;
}

/**
 * 造一条日记记录。
 *
 * `rating` 与 `note` 全空时返回 `null` —— 一条什么都不含的记录没有任何价值，
 * 存进去只会让「记了几次」这个数字虚高。
 */
export function makeEntry({ rating = null, note = '', at = Date.now() } = {}) {
  const r = normalizeRating(rating);
  const n = normalizeNote(note);
  if (r === null && !n) return null;
  const t = Number(at);
  return { at: Number.isFinite(t) ? t : Date.now(), rating: r, note: n };
}

/** 取某部作品的记录数组（永远返回数组，调用方不用自己兜底） */
export function entriesOf(diary, id) {
  const list = (diary ?? {})[String(id)]?.entries;
  return Array.isArray(list) ? list : [];
}

/**
 * 最近一条**带评分**的记录。
 *
 * 注意跟「最近一条记录」不是一回事：只写短评没打分的记录不该把已有评分顶掉。
 */
export function latestRated(diary, id) {
  const list = entriesOf(diary, id);
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.rating != null) return list[i];
  }
  return null;
}

/** 最近一条记录（有短评没评分也算） */
export function latestEntry(diary, id) {
  const list = entriesOf(diary, id);
  return list.length ? list[list.length - 1] : null;
}

/** 我的评分（数字或 null） */
export function myRating(diary, id) {
  return latestRated(diary, id)?.rating ?? null;
}

/**
 * 往日记里追加一条。
 *
 * 同一毫秒的两条不再合并 —— 合并会让「记了几次」丢失，而时间戳撞车
 * 在真实使用里几乎不会发生（人不会同一毫秒写两条）。
 */
export function addDiaryEntry(diary, id, { rating = null, note = '', at = Date.now() } = {}) {
  const key = String(id ?? '').trim();
  if (!key) return { diary: diary ?? {}, entry: null };
  const entry = makeEntry({ rating, note, at });
  if (!entry) return { diary: diary ?? {}, entry: null };

  const prev = (diary ?? {})[key] ?? { entries: [], updatedAt: 0 };
  const entries = [...(Array.isArray(prev.entries) ? prev.entries : []), entry];
  return {
    diary: {
      ...(diary ?? {}),
      [key]: { ...prev, entries, updatedAt: entry.at },
    },
    entry,
  };
}

/** 按 `at` 删一条；删不到就原样返回（便于调用方判断有没有变） */
export function removeDiaryEntry(diary, id, at) {
  const key = String(id ?? '');
  const cur = (diary ?? {})[key];
  if (!cur) return diary ?? {};
  const target = Number(at);
  const entries = (cur.entries ?? []).filter((e) => Number(e?.at) !== target);
  if (entries.length === (cur.entries ?? []).length) return diary ?? {};

  const next = { ...(diary ?? {}) };
  if (!entries.length) delete next[key]; // 删空就把这部一起清掉，别留一个空壳
  else next[key] = { ...cur, entries, updatedAt: Date.now() };
  return next;
}

/**
 * 把磁盘上读回来的 diary 修干净。
 *
 * 状态文件是手写在磁盘上的：旧版本写过、手改过、写坏了都得能在**读的这一刻**修好，
 * 不能让界面层去兜底 —— 界面层兜底的结果是「某一部番的日记点开就白屏」，
 * 而不是「脏数据被丢掉」。
 *
 * 丢弃规则：没有合法 `at` 的记录、连 id 都没有的键、内容全空的记录。
 * 丢弃是安全的做法 —— 一条没有时间的记录本来也没法按时间排。
 */
export function normalizeDiary(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const k = String(key).trim();
    if (!k) continue;
    const list = Array.isArray(value?.entries) ? value.entries : [];
    const entries = [];
    for (const e of list) {
      const at = Number(e?.at);
      if (!Number.isFinite(at)) continue;
      const rating = normalizeRating(e?.rating);
      const note = normalizeNote(e?.note);
      if (rating === null && !note) continue;
      entries.push({ at, rating, note });
    }
    if (!entries.length) continue;
    entries.sort((a, b) => a.at - b.at);
    out[k] = { entries, updatedAt: Number(value?.updatedAt) || entries[entries.length - 1].at };
  }
  return out;
}

// ---------- 与 Bangumi 比对 ----------
/**
 * 跟 Bangumi 的评分比一比。
 *
 * ⚠️ **拿不到 Bangumi 分就返回 `unknown`，绝不把它当成 0 或「跳过」悄悄算掉。**
 * 补番清单里一大半是老番，本地没有它们的评分；硬凑会让「口味偏差」这个
 * 汇总数字彻底失真 —— 而失真的统计比没有统计更坏，因为它看起来是对的。
 */
export function compareToBangumi(rating, bgmScore, { agree = DIFF_AGREE, near = DIFF_NEAR } = {}) {
  const mine = normalizeRating(rating);
  const bgm = Number(bgmScore);
  const hasBgm = Number.isFinite(bgm) && bgm > 0;

  if (mine === null || !hasBgm) {
    const missing = mine === null && !hasBgm ? 'both' : mine === null ? 'mine' : 'bgm';
    return {
      mine,
      bgm: hasBgm ? Math.round(bgm * 10) / 10 : null,
      diff: null,
      band: 'unknown',
      missing,
      label: missing === 'bgm' ? 'BGM 评分未知' : missing === 'mine' ? '还没打分' : '还差一边',
    };
  }

  const diff = Math.round((mine - bgm) * 10) / 10;
  const abs = Math.abs(diff);
  const band = abs <= agree ? 'agree' : abs <= near ? 'near' : 'apart';
  const sign = diff > 0 ? '+' : '';
  const word = band === 'agree' ? '合拍' : band === 'near' ? '略偏' : '分歧明显';
  return { mine, bgm: Math.round(bgm * 10) / 10, diff, band, missing: null, label: `${sign}${diff.toFixed(1)} ${word}` };
}

/**
 * 全量汇总。
 *
 * 均分只统计**两边都有分**的作品 —— 这是整个函数里唯一容易写错的地方：
 * 如果「我的均分」按全部记录算、「BGM 均分」按有分的算，两个数字就来自不同的样本，
 * 相减得到的「口味偏差」是个假的。
 */
export function diaryStats(diary, lookup = () => null) {
  const keys = Object.keys(diary ?? {});
  let entries = 0;
  let rated = 0;
  let bothCount = 0;
  let mineSum = 0;
  let bgmSum = 0;
  const bands = { agree: 0, near: 0, apart: 0, unknown: 0 };

  for (const key of keys) {
    const list = entriesOf(diary, key);
    entries += list.length;
    const mine = myRating(diary, key);
    if (mine === null) continue;
    rated += 1;

    const subject = lookup(key);
    const cmp = compareToBangumi(mine, subject?.score);
    bands[cmp.band] += 1;
    if (cmp.diff === null) continue;
    bothCount += 1;
    mineSum += cmp.mine;
    bgmSum += cmp.bgm;
  }

  const avg = (sum, n) => (n > 0 ? Math.round((sum / n) * 100) / 100 : null);
  return {
    works: keys.length,
    entries,
    rated,
    comparable: bothCount,
    avgMine: avg(mineSum, bothCount),
    avgBgm: avg(bgmSum, bothCount),
    gap: bothCount > 0 ? Math.round((mineSum - bgmSum) * 100 / bothCount) / 100 : null,
    bands,
    agreeRatio: bothCount > 0 ? Math.round((bands.agree / bothCount) * 100) / 100 : null,
  };
}

/**
 * 时间线：所有记录摊平，按时间倒序。
 *
 * `lookup` 用来补作品资料（标题/封面）。取不到就留 id —— 卡片不能消失，
 * 这条规矩在补番清单那边已经吃过一次亏。
 */
export function diaryTimeline(diary, lookup = () => null, { limit = 0 } = {}) {
  const out = [];
  for (const key of Object.keys(diary ?? {})) {
    const subject = lookup(key);
    for (const e of entriesOf(diary, key)) {
      out.push({
        id: Number(key) || key,
        key,
        at: e.at,
        rating: e.rating ?? null,
        note: e.note ?? '',
        anime: subject,
        cmp: compareToBangumi(e.rating, subject?.score),
      });
    }
  }
  out.sort((a, b) => b.at - a.at || String(a.key).localeCompare(String(b.key)));
  return limit > 0 ? out.slice(0, limit) : out;
}

/**
 * 按分歧程度排序 —— 分歧最大的浮在最上面，这正是这个视图存在的意义。
 * 没有可比分的沉底（不是排在中间：它们的信息量本来就少）。
 */
export function sortByDivergence(diary, lookup = () => null) {
  const rows = [];
  for (const key of Object.keys(diary ?? {})) {
    const mine = myRating(diary, key);
    const subject = lookup(key);
    const cmp = compareToBangumi(mine, subject?.score);
    rows.push({ id: Number(key) || key, key, my: mine, bgm: cmp.bgm, cmp, anime: subject });
  }
  rows.sort((a, b) => {
    const da = a.cmp.diff === null ? -1 : Math.abs(a.cmp.diff);
    const db = b.cmp.diff === null ? -1 : Math.abs(b.cmp.diff);
    if (da !== db) return db - da;
    return String(a.key).localeCompare(String(b.key));
  });
  return rows;
}

/** 给界面用的一句话汇总，避免组件里拼字符串 */
export function describeGap(stats) {
  if (!stats || stats.comparable === 0) return '还没有可比的作品 —— 先去补番清单里打几个分';
  const { gap } = stats;
  const dir = gap > 0.2 ? '你比 Bangumi 大方' : gap < -0.2 ? '你比 Bangumi 严格' : '你跟 Bangumi 基本一致';
  return `${stats.comparable} 部可比 · 均分你 ${stats.avgMine} / BGM ${stats.avgBgm} · ${dir}`;
}
