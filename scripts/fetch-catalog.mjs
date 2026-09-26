#!/usr/bin/env node
/**
 * 抓「全量季度目录」—— 把 bangumi-data 的排播表按季度拆开、逐个补全，
 * 落到 local-data/catalog/ 下。
 *
 * 和 build-builtin.mjs 的分工（两者共用同一套映射与补全，但目标不同）：
 *   - build-builtin **只出随包发布的那几季**，写进 src/data/builtin/，
 *     会进 git、进安装包 —— 所以它必须小；
 *   - 这个脚本出的是**开发用的全量目录**（2020 年至今 28 季、约 2000 部），
 *     只落 local-data/，.gitignore 里整目录排除，不进仓库。
 *     用途是「长跨度下的开发与测试素材」：翻历史季度、跨季搜索、年度统计……
 *     这些都需要远超三季的数据量才看得出问题。
 *
 * 用法：
 *   node scripts/fetch-catalog.mjs                          # 2020q1 ~ 当前季
 *   node scripts/fetch-catalog.mjs --from=2020q1 --to=2026q4
 *   node scripts/fetch-catalog.mjs --only=2020q1,2020q2     # 只抓指定的几季
 *   node scripts/fetch-catalog.mjs --force                  # 已有文件也重抓
 *   node scripts/fetch-catalog.mjs --no-enrich              # 只出排播表，不查 API
 *   node scripts/fetch-catalog.mjs --concurrency=4 --gap=150
 *   node scripts/fetch-catalog.mjs --proxy=http://127.0.0.1:7892
 *
 * 断点续跑：每个季度抓完立刻落盘，重跑时已存在的那一季**只补还缺话数/封面的条目**
 * （needsEnrich 判定）。2000 个请求中途挂了，直接再跑一次即可，不用从头来。
 * 这是这个脚本最要紧的性质 —— 全量抓一次好几分钟，重来一次很贵。
 *
 * api.bgm.tv 国内直连基本不通，脚本会自动扫本机代理端口。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { mapItem } from '../src/data/bangumiData.js';
import {
  DEFAULT_API,
  USER_AGENT,
  mapSubjectToPatch,
  needsEnrich,
} from '../src/data/bangumiApi.js';
import { slimItems } from '../src/data/slim.js';
import { detectProxy, describeProxy, httpGet } from './lib/proxyfetch.mjs';
import { openSessions } from './lib/poolfetch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'local-data', 'catalog');
const SNAPSHOT = path.join(ROOT, 'local-data', 'build', 'bangumi-data.json');
const DATA_URL = 'https://unpkg.com/bangumi-data@0.3/dist/data.json';
const API_BASE = DEFAULT_API.base;

/** 台历关心的是「一周一集的连载」，剧场版和音乐碟不收 —— 与内置数据同口径 */
const KEEP_PLATFORMS = new Set(['TV', 'WEB', 'OVA']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const log = (m) => console.log(m);

// ---------------------------------------------------------------- 参数

function parseArgs(argv) {
  const out = { from: '2020q1', to: null, only: null, proxy: null, force: false, enrich: true, concurrency: 4, gap: 150 };
  for (const a of argv) {
    if (a === '--force') out.force = true;
    else if (a === '--no-enrich') out.enrich = false;
    else if (a.startsWith('--from=')) out.from = a.slice(7).trim();
    else if (a.startsWith('--to=')) out.to = a.slice(5).trim();
    else if (a.startsWith('--only=')) out.only = a.slice(7).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith('--proxy=')) out.proxy = a.slice(8).trim();
    else if (a.startsWith('--concurrency=')) out.concurrency = Math.max(1, Number(a.slice(14)) || 4);
    else if (a.startsWith('--gap=')) out.gap = Math.max(0, Number(a.slice(6)) || 0);
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function parseSeason(key) {
  const m = /^(\d{4})q([1-4])$/.exec(String(key ?? '').trim());
  if (!m) throw new Error(`季度键不合法：${key}（应形如 2020q1）`);
  return [Number(m[1]), Number(m[2])];
}

function currentSeason(nowMs = Date.now()) {
  const d = new Date(nowMs + 9 * 3600000);
  return `${d.getUTCFullYear()}q${Math.ceil((d.getUTCMonth() + 1) / 3)}`;
}

/** 左闭右闭的季度区间 */
function seasonRange(from, to) {
  const [fy, fq] = parseSeason(from);
  const [ty, tq] = parseSeason(to);
  if (fy > ty || (fy === ty && fq > tq)) throw new Error(`区间反了：${from} → ${to}`);
  const out = [];
  let y = fy;
  let q = fq;
  for (;;) {
    out.push(`${y}q${q}`);
    if (y === ty && q === tq) break;
    q += 1;
    if (q > 4) { q = 1; y += 1; }
  }
  return out;
}

// ---------------------------------------------------------------- 取数

/** 跟随重定向的 GET（unpkg 会 302） */
async function getText(url, { proxy, timeoutMs = 120000 } = {}) {
  let target = url;
  for (let hop = 0; hop < 4; hop += 1) {
    const res = await httpGet(target, { proxy, headers: { 'User-Agent': USER_AGENT }, timeoutMs });
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      target = new URL(res.headers.location, target).href;
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}：${target}`);
    return res.text;
  }
  throw new Error(`重定向次数过多：${url}`);
}

async function loadRaw({ proxy }) {
  if (fs.existsSync(SNAPSHOT)) {
    const size = fs.statSync(SNAPSHOT).size;
    log(`用本地快照 ${rel(SNAPSHOT)}（${(size / 1048576).toFixed(1)} MB）`);
    return JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  }
  log(`快照不在，拉取 ${DATA_URL}`);
  const text = await getText(DATA_URL, { proxy });
  fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
  fs.writeFileSync(SNAPSHOT, text);
  log(`已存快照 ${rel(SNAPSHOT)}（${(text.length / 1048576).toFixed(1)} MB）`);
  return JSON.parse(text);
}

/**
 * 补全一季。
 *
 * 没用 bangumiApi 里的 enrichItems，有两个原因：
 *   ① 它每次调用都新起请求、不复用连接 —— 全量抓取时这正是「慢 + 打爆代理」的根源；
 *   ② 它只回报「成功几个、失败几个」，而全量抓取更要知道**哪些失败了**，
 *      好让下一次重跑只看这些 id。失败清单随文件一起落盘。
 *
 * 并发模型：N 个会话，每个会话一条持久连接、串行发请求（见 lib/poolfetch.mjs）。
 * 单条失败先退避重试，仍不行才记进失败清单 —— 两千个请求里偶发几个抖动是常态，
 * 当场放弃的话最后得整轮重跑。
 */
async function enrichSeason(items, { sessions, gapMs, onProgress }) {
  const targets = items.filter(needsEnrich);
  if (!targets.length) return { requested: 0, ok: 0, failures: [] };

  const headers = { 'User-Agent': USER_AGENT };
  const failures = [];
  let cursor = 0;
  let done = 0;
  let ok = 0;

  async function worker(session) {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= targets.length) return;
      const anime = targets[i];

      let patch = null;
      let lastErr = null;
      for (let attempt = 0; attempt <= 3; attempt += 1) {
        if (attempt > 0) await sleep(Math.min(8000, 600 * 2 ** (attempt - 1)));
        try {
          const res = await session.request(`/v0/subjects/${encodeURIComponent(anime.id)}`, { headers });
          if (res.status === 429) { lastErr = new Error('HTTP 429（被限速）'); continue; }
          if (res.status === 404) { lastErr = new Error('HTTP 404（条目不存在）'); break; }
          if (res.status >= 500) { lastErr = new Error(`HTTP ${res.status}`); continue; }
          if (res.status < 200 || res.status >= 300) { lastErr = new Error(`HTTP ${res.status}`); break; }
          patch = mapSubjectToPatch(JSON.parse(res.text));
          break;
        } catch (err) {
          lastErr = err;
        }
      }

      if (patch) { Object.assign(anime, patch); ok += 1; }
      else failures.push({ id: anime.id, title: anime.titleZh, error: lastErr?.message ?? String(lastErr) });

      done += 1;
      onProgress?.(done, targets.length);
      if (gapMs > 0) await sleep(gapMs);
    }
  }

  await Promise.all(sessions.map((s) => worker(s)));
  failures.sort((a, b) => a.id - b.id);
  return { requested: targets.length, ok, failures };
}

// ---------------------------------------------------------------- 输出

function readExisting(file) {
  if (!fs.existsSync(file)) return null;
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(obj?.items) ? obj : null;
  } catch {
    return null;
  }
}

function writeSeason(file, payload) {
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 1)}\n`);
  return fs.statSync(file).size;
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    log('用法：node scripts/fetch-catalog.mjs [--from=2020q1] [--to=2026q4] [--only=2020q1,2020q2]');
    log('      [--force] [--no-enrich] [--concurrency=4] [--gap=150] [--proxy=http://127.0.0.1:7892]');
    return;
  }

  const to = args.to ?? currentSeason();
  const seasons = args.only ?? seasonRange(args.from, to);
  log(`目标季度：${seasons.length} 季（${seasons[0]} ~ ${seasons[seasons.length - 1]}）`);

  let proxy = args.proxy
    ? { host: '127.0.0.1', port: Number(String(args.proxy).split(':').pop()), from: '参数' }
    : null;
  if (!proxy && args.enrich) {
    proxy = await detectProxy();
    log(`代理：${describeProxy(proxy)}`);
    if (!proxy) log('⚠️ 没扫到可用代理，将尝试直连 —— api.bgm.tv 直连多半会超时');
  }

  const raw = await loadRaw({ proxy });
  const all = (raw.items ?? [])
    .filter((it) => it.begin)
    .map(mapItem)
    .filter((a) => KEEP_PLATFORMS.has(a.platform));

  const bySeason = new Map();
  for (const a of all) {
    if (!a.season) continue;
    if (!bySeason.has(a.season)) bySeason.set(a.season, []);
    bySeason.get(a.season).push(a);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 会话池：每个会话一条到 api.bgm.tv 的持久连接，全程复用、跑完关掉。
  // 每个请求各建一条隧道的话（proxyfetch 那条路），实测 1.3 秒/次，
  // 而且并发一高代理侧会直接掐 TLS —— 2000 个请求必须复用连接。
  const apiHost = new URL(API_BASE).hostname;
  const { sessions, closeAll } = args.enrich
    ? await openSessions(args.concurrency, { proxy, host: apiHost, port: 443, timeoutMs: 20000 })
    : { sessions: [], closeAll: () => {} };
  if (args.enrich) log(`会话池：${sessions.length} 条持久连接 → ${apiHost}`);

  const t0 = Date.now();
  const manifest = [];
  let grandTotal = 0;
  let grandFailed = 0;

  for (const key of seasons) {
    const file = path.join(OUT_DIR, `${key}.json`);
    const existing = args.force ? null : readExisting(file);

    // 同一 Bangumi 条目可能被两种方式收进数据集，去个重
    const seed = existing?.items ?? bySeason.get(key) ?? [];
    const seen = new Map();
    for (const a of seed) if (!seen.has(a.id)) seen.set(a.id, a);
    let items = [...seen.values()];

    if (!items.length) {
      log(`· ${key}：没有条目，跳过`);
      continue;
    }

    const restored = Boolean(existing);
    let enrichStats = existing?.enrichStats ?? null;

    if (args.enrich) {
      const pending = items.filter(needsEnrich).length;
      if (pending === 0) {
        enrichStats = { requested: 0, ok: 0, failures: [] };
        log(`· ${key}：${items.length} 部，已全（上次抓的）`);
      } else {
        const res = await enrichSeason(items, {
          sessions,
          gapMs: args.gap,
          onProgress: (d, t) => {
            if (d === t || d % 20 === 0) process.stdout.write(`\r· ${key}：补全 ${d}/${t}…   `);
          },
        });
        process.stdout.write('\r');
        enrichStats = { requested: res.requested, ok: res.ok, failures: res.failures };
        log(
          `· ${key}：${items.length} 部${restored ? '（补上次缺的）' : ''}，`
          + `本次补全 ${res.ok}/${res.requested}`
          + `${res.failures.length ? `，仍缺 ${res.failures.length}` : ''}`,
        );
      }
    } else {
      log(`· ${key}：${items.length} 部（未补全）`);
    }

    items = slimItems(items, { summaryMax: 240 });
    items.sort((a, b) => String(a.begin).localeCompare(String(b.begin)) || a.id - b.id);

    const payload = {
      season: key,
      generatedAt: new Date().toISOString(),
      source: 'bangumi-data@0.3 + api.bgm.tv/v0/subjects/{id}',
      count: items.length,
      enriched: items.filter((a) => !needsEnrich(a)).length,
      enrichStats,
      items,
    };
    const bytes = writeSeason(file, payload);

    const failed = enrichStats?.failures?.length ?? 0;
    grandTotal += items.length;
    grandFailed += failed;
    manifest.push({ season: key, count: items.length, enriched: payload.enriched, failed, bytes });
    log(`  → ${rel(file)}（${(bytes / 1024).toFixed(0)} KB${failed ? ` · 缺 ${failed}` : ''}）`);
  }

  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    seasons: manifest.map((m) => m.season),
    total: grandTotal,
    failed: grandFailed,
    detail: manifest,
  }, null, 1)}\n`);

  const connects = sessions.reduce((n, s) => n + s.stats.connects, 0);
  const reconnects = sessions.reduce((n, s) => n + s.stats.reconnects, 0);
  closeAll();

  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  log(`\n合计 ${grandTotal} 部 · ${manifest.length} 季 · 未补全 ${grandFailed} 部 · 用时 ${secs}s`);
  if (args.enrich) log(`连接：建了 ${connects} 次（重连 ${reconnects}）—— 次数远小于请求数才说明复用生效了`);
  log(`清单 ${rel(path.join(OUT_DIR, 'manifest.json'))}`);
  if (grandFailed) log('想再补一次缺的，直接重跑同一条命令即可（已全的季会自动跳过查询）。');
}

main().catch((err) => {
  console.error(`\n失败：${err?.message ?? err}`);
  process.exit(1);
});
