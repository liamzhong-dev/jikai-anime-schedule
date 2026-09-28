/**
 * 番堂（yuc.wiki）的取数 + 缓存。
 *
 * 和 `sources.js` 里那三个数据源是同一个套路：**依赖从外面传进来**
 * （`platform.fetchText` / `platform.readYucCache`），
 * 这样这一层能在 `node --test` 里用假的依赖跑完整流程 ——
 * 包括「拿到一半的 HTML」「站点改版解析不出来」「有旧缓存但网断了」这几条
 * 只有真出事时才会走到的分支。
 *
 * 为什么不并进 `sources.js`：那边的三个源都要能回答「这一季有哪些番、话数、
 * 评分、封面」，而番堂给的是**时刻表**（几点播、哪天开播、谁做的、谁配的）。
 * 混进同一个接口只会让依赖 bgm id 的地方（封面/评分/日记/报告）整片塌掉。
 */

import { parseYucPage, slimYuc, yucPageUrl } from './yuc.js';

/**
 * 缓存的结构版本。
 *
 * 改了解析结果的字段就该把它 +1：**站点改版和本地改 schema 是两回事，
 * 但都会让旧缓存变成不能用的东西**，靠版本号才分得清「该重新拉」还是「拉到的东西坏了」。
 */
export const YUC_CACHE_SCHEMA = 1;

/** 最多留几季。一季约 40KB，翻过十几季之后没人会回头看两年前的排播表 */
export const YUC_KEEP_SEASONS = 6;

/**
 * 从缓存里取一季。取不到 / 形状不对 / 版本不对，一律给 null。
 *
 * 不抛异常：调用方拿到 null 就走「去网上拉」，那是正常路径，不是错误。
 */
export function readCachedYuc(map, seasonKey) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
  const entry = map[seasonKey];
  if (!entry || typeof entry !== 'object') return null;
  if (entry.schema !== YUC_CACHE_SCHEMA) return null;
  if (!Number.isFinite(entry.savedAt)) return null;
  if (!Array.isArray(entry.groups) || !entry.groups.length) return null;
  for (const g of entry.groups) {
    if (!g || !Array.isArray(g.items)) return null;
  }
  return entry;
}

/**
 * 写入一季并裁剪到最近 N 季。
 *
 * ⚠️ 返回**新对象**，不改入参：上游是 React 状态，就地改的话
 * `useMemo`/`useEffect` 那套依赖比较认不出变化，界面会停在旧数据上。
 */
export function putCachedYuc(map, seasonKey, data, { keep = YUC_KEEP_SEASONS } = {}) {
  if (!seasonKey || !data) return map && typeof map === 'object' ? map : {};
  const base = map && typeof map === 'object' && !Array.isArray(map) ? { ...map } : {};
  base[seasonKey] = { ...data, schema: YUC_CACHE_SCHEMA };

  // 按 savedAt 从新到旧留前 keep 个。认不出时间的排最后 —— 那种多半是旧版本写的，
  // 该被新数据挤掉，而不是把新数据挤掉。
  const keys = Object.keys(base).sort(
    (a, b) => (Number(base[b]?.savedAt) || 0) - (Number(base[a]?.savedAt) || 0),
  );
  const out = {};
  for (const k of keys.slice(0, Math.max(1, keep))) out[k] = base[k];
  return out;
}

/**
 * 取一季的番堂数据。
 *
 * @param {{seasonKey:string, live?:boolean, platform:object, now?:number}} args
 * @returns {Promise<{
 *   ok:boolean, data?:object, cached?:boolean, stale?:boolean,
 *   error?:string, note?:string, cacheMap?:object,
 * }>}
 *   - `cached:true` 表示这次没联网，用的是上次的结果
 *   - `stale:true`  表示**联网拉了但没拉成**，退回旧缓存 —— 界面必须把这件事说出来，
 *     否则用户会以为看的是最新排播表
 *   - `cacheMap` 只在这次写过缓存时给，调用方据此落盘
 */
export async function loadYucSeason({ seasonKey, live = false, platform, now = Date.now() } = {}) {
  const url = yucPageUrl(seasonKey);
  if (!url) return { ok: false, error: `季度键不认识：${seasonKey}` };

  let map = null;
  try {
    map = await platform.readYucCache();
  } catch {
    map = null;
  }
  const cached = readCachedYuc(map, seasonKey);

  if (!live && cached) {
    return { ok: true, data: cached, cached: true, cacheMap: null };
  }

  let html;
  try {
    html = await platform.fetchText(url, { timeoutMs: 20000 });
  } catch (err) {
    const error = err?.message ?? String(err);
    if (cached) return { ok: true, data: cached, cached: true, stale: true, error, cacheMap: null };
    return { ok: false, error, cacheMap: null };
  }

  const parsed = parseYucPage(html);
  if (!parsed.ok) {
    // 解析不出来有两种：站点改版了（要提示更新），或者那一季还没排（不用说什么）。
    // 前者给 reason 原样带出去，由界面决定措辞。
    if (cached) {
      return { ok: true, data: cached, cached: true, stale: true, error: parsed.reason, cacheMap: null };
    }
    return { ok: false, error: parsed.reason, cacheMap: null };
  }

  const slim = slimYuc(parsed);
  const next = putCachedYuc(map, seasonKey, { ...slim, savedAt: now });

  /*
   * 落盘在这里做，而不是甩给调用方。
   *
   * 甩出去过一次：`loadYucSeason` 返回 `cacheMap`、让界面自己写 ——
   * 结果是「谁记得写」变成一条隐性约定，漏一次的表现是
   * 「这次看得到，重开就没了」，而且不报错。
   *
   * ⚠️ 写失败**必须咽掉**：缓存写不进去是磁盘的事，这次的数据已经拿到了、
   * 界面该正常显示。因为落盘失败而让用户看不到刚拉到的排播表，是本末倒置。
   */
  try {
    await platform.writeYucCache(next);
  } catch {
    /* 落盘失败不影响这次展示 */
  }
  return { ok: true, data: next[seasonKey], cached: false, cacheMap: next };
}
