/**
 * 数据源抽象：把「从哪儿拿番剧表」收成一个 loadSeason()。
 *
 * 三个源的差别被压在下面：界面只提供进度回调与一句降级说明，
 * 不关心背后是读一个本地数组还是发几十个请求。
 *
 * 默认源是「内置数据」—— 数据随包发布，装好就有本季番剧表。
 * 这不是为了省流量，而是因为 api.bgm.tv 在国内很多网络下直连不通：
 * 如果把「能看见内容」这件事绑在网络条件上，这个台历大概率一打开就是空的。
 */

import { builtinItems, hasBuiltin, BUILTIN_SEASONS, BUILTIN_SUMMARY } from './builtin/index.js';
import { fetchSeason as fetchStaticSeason, availableSeasons as staticSeasons } from './bangumiData.js';
import { DEFAULT_API, enrichItems, needsEnrich } from './bangumiApi.js';
import { slimItems } from './slim.js';

export { slimItems, BUILTIN_SEASONS, BUILTIN_SUMMARY };

/**
 * 三个数据源。
 *
 * needProxy 是给界面用的：后两个源都要连 api.bgm.tv，而国内直连基本不通
 * （实测过，DNS 能解析、TCP 直接超时）。界面据此在选中项后面挂一条
 * 「先开 VPN / 代理」的提示 —— 不写清楚的话，用户只会觉得「同步坏了」。
 */
export const SOURCES = [
  {
    id: 'builtin',
    label: '内置数据（离线）',
    hint: '随包内置的真实番剧表 · 含话数 / 评分 / 封面 · 不需要联网',
    network: false,
    needProxy: false,
    enrich: false,
  },
  {
    id: 'bangumi-data',
    label: '联网 · 排播表',
    hint: '从 bangumi-data 拉全量排播表 · 不含话数 / 评分 / 封面',
    network: true,
    needProxy: true,
    enrich: false,
  },
  {
    id: 'bangumi-api',
    label: '联网 · 排播表 + 补全',
    hint: '拉排播表并用 Bangumi API 补齐话数、评分、封面、简介',
    network: true,
    needProxy: true,
    enrich: true,
  },
];

export const DEFAULT_SOURCE = SOURCES[0].id;

export function sourceMeta(id) {
  return SOURCES.find((s) => s.id === id) ?? SOURCES[0];
}

/** 内置数据里有哪些季度，用来给界面补一句「哪些季度离线可看」 */
export function builtinSeasonHint() {
  return BUILTIN_SEASONS.join(' / ');
}

/**
 * 取一个季度的番剧表。
 *
 * @returns {{ items, source, cached, degraded, enrichStats }}
 *   degraded 非空时说明「没能按预期拿到，退到了什么」—— 界面必须把这句话显示出来，
 *   否则用户会以为看到的是真实数据。
 */
export async function loadSeason(sourceId, seasonKey, ctx = {}) {
  const {
    live = false,
    api = {},
    fetchJson,
    readCache,
    writeCache,
    onProgress,
    signal,
    builtinReader,
    staticFetcher,
    enricher,
  } = ctx;

  const meta = sourceMeta(sourceId);
  const report = (pct, label) => onProgress?.({ pct, label });

  // ---------- 内置数据 ----------
  if (!meta.network) {
    report(40, '读内置数据');
    const read = builtinReader ?? builtinItems;
    const items = read(seasonKey, { hasBuiltin }) ?? [];
    if (!items.length) {
      report(100, '内置数据不含这一季');
      return {
        items: [],
        source: meta.id,
        cached: false,
        degraded: { kind: 'builtin-missing', seasonKey },
        enrichStats: null,
      };
    }
    report(100, `共 ${items.length} 部`);
    return { items, source: meta.id, cached: false, degraded: null, enrichStats: null };
  }

  const cfg = { ...DEFAULT_API, ...api };
  report(8, '检查本地缓存');

  // ---------- 读缓存 ----------
  let cached = null;
  try {
    cached = readCache ? await readCache(seasonKey) : null;
  } catch {
    cached = null;
  }
  const cacheUsable = cached && cached.source === meta.id && Array.isArray(cached.items);
  const cacheComplete = cacheUsable && (!meta.enrich || cached.enriched);

  if (!live && cacheComplete) {
    report(100, `缓存命中 · ${cached.items.length} 部`);
    return { items: cached.items, source: meta.id, cached: true, degraded: null, enrichStats: cached.enrichStats ?? null };
  }

  // ---------- 拉列表 ----------
  // 只有「非 live」时才复用缓存里的列表：
  //   - live（用户手点同步）必须真的去网上拿一次，拿不到再退到旧缓存；
  //   - 非 live 且缓存只有列表、还没补全时，复用列表可以省掉一次大请求。
  // 早先这里没加 !live 判断，结果「同步」按钮点了等于没点，只是把缓存又读了一遍。
  let items = (!live && cacheUsable) ? cached.items : null;
  let degraded = null;
  let listFromCache = Boolean(items);

  if (!items) {
    report(22, '拉取真实排播表');
    try {
      const fetcher = staticFetcher ?? fetchStaticSeason;
      items = await fetcher(seasonKey, { signal });
      items = slimItems(items);
    } catch (err) {
      const reason = err?.message ?? String(err);
      // 退的顺序：旧缓存 → 内置数据 → 空表。每一步都要说清楚退到了哪儿。
      if (cacheUsable) {
        items = cached.items;
        listFromCache = true;
        degraded = { kind: 'stale-cache', reason };
      } else {
        const fallback = (builtinReader ?? builtinItems)(seasonKey, { hasBuiltin }) ?? [];
        report(100, fallback.length ? '联网失败，改用内置数据' : '联网失败，这一季没有内置数据');
        return {
          items: fallback,
          source: meta.id,
          cached: false,
          degraded: fallback.length
            ? { kind: 'builtin-fallback', reason }
            : { kind: 'builtin-missing', reason, seasonKey },
          enrichStats: null,
        };
      }
    }
  }

  // ---------- 补全 ----------
  let enrichStats = meta.enrich && cacheUsable ? cached.enrichStats ?? null : null;
  if (meta.enrich) {
    const pending = items.filter(needsEnrich).length;
    if (pending === 0) {
      enrichStats = { requested: 0, ok: 0, failed: 0, skipped: items.length };
      report(100, '已是最全');
    } else {
      report(45, `补全中 · 待查 ${Math.min(pending, cfg.enrichLimit)} 部`);
      try {
        const run = enricher ?? enrichItems;
        const res = await run(items, {
          api: cfg,
          fetchJson,
          signal,
          onProgress: (done, total) => report(45 + Math.round((done / total) * 52), `补全中 ${done}/${total}`),
        });
        items = slimItems(res.items);
        enrichStats = res.stats;
        if (res.stats.failed > 0 && res.stats.ok === 0) {
          degraded = { kind: 'enrich-failed', reason: 'Bangumi API 请求全部失败' };
        }
      } catch (err) {
        enrichStats = null;
        degraded = { kind: 'enrich-failed', reason: err?.message ?? String(err) };
      }
    }
  } else {
    report(90, '整理番剧表');
  }

  // ---------- 写缓存 ----------
  const payload = {
    savedAt: Date.now(),
    source: meta.id,
    enriched: Boolean(meta.enrich && enrichStats && enrichStats.ok > 0),
    enrichStats,
    items,
  };
  if (!degraded && writeCache) {
    try {
      await writeCache(seasonKey, payload);
    } catch {
      /* 缓存写失败不影响这次展示 */
    }
  }

  report(100, `共 ${items.length} 部`);
  return { items, source: meta.id, cached: listFromCache, degraded, enrichStats };
}

/**
 * 把降级情况翻译成人能读的一句话。
 *
 * 只涉及联网源的几条，一律把「开 VPN / 代理」写进文案里 ——
 * 不然用户看到「同步失败」只会以为是程序坏了。实测过：这台机器上
 * api.bgm.tv 直连必超时，挂了代理 1.5 秒就回来了。
 * 内置数据那两条不带这个提示：那是本地的事，跟网络无关。
 */
export function degradedText(degraded) {
  if (!degraded) return null;
  if (degraded.kind === 'stale-cache') {
    return `网络不可用，暂用上次缓存（${degraded.reason}）· 检查一下 VPN / 代理有没有开`;
  }
  if (degraded.kind === 'builtin-fallback') {
    return `联网失败，已改用内置数据（${degraded.reason}）· 想拿最新数据就先开 VPN / 代理再点同步`;
  }
  if (degraded.kind === 'builtin-missing') {
    const which = degraded.seasonKey ? `${degraded.seasonKey} 这一季` : '这一季';
    const why = degraded.reason ? `（${degraded.reason}）` : '';
    return `拿不到 ${which}的数据${why} · 内置数据只含 ${BUILTIN_SEASONS.join(' / ')}，其他季度请开 VPN / 代理后点同步`;
  }
  if (degraded.kind === 'enrich-failed') {
    return `补全失败，只拿到了排播表（${degraded.reason}）· 补全要连 api.bgm.tv，确认 VPN / 代理已生效`;
  }
  return degraded.reason ?? '数据源异常';
}

export { staticSeasons as availableSeasons };
