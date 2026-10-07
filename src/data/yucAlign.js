/**
 * 用番堂（长门有C）的季度表来校准我们自己的季度归属。
 *
 * 为什么要有这一层：自己判「一部番跨几季」只能靠话数，而话数是靠不住的 ——
 * Bangumi 那边把 OP / ED / 预告那些单集也算作章节，一部 12 集的番会被记成 25 集，
 * 于是它被当成半年番，多归出一个季度；反过来真正的半年番倒可能因为话数没写
 * 而只归了一季。
 *
 * 番堂是**按季度出版的现成库**：一部番出现在哪几季的排播表里，它就是那几季的番。
 * 这个分类是人做出来的，比我们从话数反推准得多 —— 而且它天然知道
 * 「这部跨不跨季」，不用我们猜。
 *
 * 所以这里的分工是：**起始季仍由开播时间定**（半月边界，那个是硬的），
 * **跨几季听番堂的**。番堂没看过这部（老番、没抓过的季）才退回话数。
 */

import { parseSeason, seasonsOfAnime } from '../core/time.js';
import { matchLibrary } from './yuc.js';

/** `2026q4` → 一个可比较的整数，用来算两季之间隔了几季 */
function idxOf(key) {
  const s = parseSeason(key);
  return s ? s.year * 4 + (s.q - 1) : null;
}

/** 番堂写的是「全12话」「12」「12话+」这类，取第一个数字 */
export function parseYucEpisodes(text) {
  const m = /(\d+)/.exec(String(text ?? ''));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 把番堂缓存里每一季的条目，和我们要归档的这批条目对上。
 *
 * @param {Array} items 要归档的本地条目
 * @param {object} yucMap `yucSeasons.json` 的内容，形如 { '2026q4': { groups: [...] } }
 * @returns {Map<string, {seasons:string[], episodes:number|null, title:string}>}
 *          键是本地条目的 id（字符串化过）
 */
export function alignSeasonsWithYuc(items, yucMap) {
  const out = new Map();
  if (!yucMap || typeof yucMap !== 'object' || !Array.isArray(items) || !items.length) return out;

  for (const [seasonKey, entry] of Object.entries(yucMap)) {
    if (!/^\d{4}q[1-4]$/.test(String(seasonKey))) continue;
    if (!entry || !Array.isArray(entry.groups)) continue;
    const yucItems = entry.groups.flatMap((g) => (Array.isArray(g?.items) ? g.items : []));
    if (!yucItems.length) continue;

    const byYuc = new Map();
    for (const it of yucItems) if (it?.id != null) byYuc.set(it.id, it);

    // 对表用的是番堂那一侧的三道闸门（归一化相等 → 包含 → 模糊），
    // 认不出就不认 —— 宁可让它退回话数，也不要拿一条误匹配去改季度归属。
    const matched = matchLibrary(yucItems, items);
    for (const [yucId, lib] of matched) {
      if (!lib || lib.id == null) continue;
      const key = String(lib.id);
      const rec = out.get(key) ?? { seasons: [], episodes: null, title: lib.titleZh ?? lib.titleJa ?? '' };
      if (!rec.seasons.includes(seasonKey)) rec.seasons.push(seasonKey);
      const ep = parseYucEpisodes(byYuc.get(yucId)?.episodes);
      if (ep != null) rec.episodes = rec.episodes == null ? ep : Math.max(rec.episodes, ep);
      out.set(key, rec);
    }
  }

  for (const rec of out.values()) rec.seasons.sort();
  return out;
}

/**
 * 一部番到底属于哪几季 —— 有番堂结论时听番堂的。
 *
 * 为什么不是直接拿番堂那几季来用：番堂缓存只有最近几季（默认 6 季，
 * 而且只存用户真去看过的）。一部 4 月开播、跨到 10 月的番，番堂缓存里
 * 可能只剩 10 月那一季 —— 直接用的话它就只归秋番，春番那一页反而没它了。
 *
 * 所以取的是**从开播季到番堂最后一次列它的那一季**这段连续区间：
 * 起点由开播时间定（硬），终点由番堂定（准）。
 *
 * @param {object} anime 本地条目
 * @param {{seasons?:string[]}|undefined} hint `alignSeasonsWithYuc` 给的那一条
 * @returns {string[]}
 */
export function seasonsWithHint(anime, hint) {
  const base = seasonsOfAnime(anime);
  const ys = (hint?.seasons ?? []).slice().sort();
  if (!ys.length) return base;
  if (!base.length) return ys; // 连开播时间都没有，只能全听番堂的

  const from = idxOf(base[0]);
  const to = idxOf(ys[ys.length - 1]);
  if (from == null) return ys;
  // 番堂那几季全在开播之前：多半是误匹配（同名重播 / 先行上映），听开播时间的
  if (to == null || to < from) return base;

  const span = Math.min(4, to - from + 1);
  const out = [];
  for (let i = from; i < from + span; i += 1) out.push(`${Math.floor(i / 4)}q${(i % 4) + 1}`);
  return out;
}
