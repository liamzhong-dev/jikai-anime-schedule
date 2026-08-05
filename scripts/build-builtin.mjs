#!/usr/bin/env node
/**
 * 生成内置季度数据（src/data/builtin/*.js）。
 *
 * 为什么要有这个脚本：
 *   应用默认的数据源是「内置数据」—— 不联网也能看到本季番剧表。
 *   那份数据是真实数据，不该手写，也不该每次启动去网上现拉。
 *   所以做成「构建期拉一次、存进仓库」：用户装上就有内容，断网也能用。
 *
 * 两个数据来源：
 *   1. bangumi-data（CC BY 4.0，github.com/bangumi-data/bangumi-data）
 *      —— 番剧名、中日文标题、首播时刻、播出周期规则；
 *   2. Bangumi API 的 /v0/subjects/{id}（bgm.tv）
 *      —— 补齐话数、评分、封面地址、简介、制作公司、标签。
 *
 * 用法：
 *   node scripts/build-builtin.mjs                          # 默认本季与前后各一季
 *   node scripts/build-builtin.mjs --seasons=2026q3,2026q4  # 指定季度
 *   node scripts/build-builtin.mjs --no-enrich              # 只出排播表，不连 API
 *   node scripts/build-builtin.mjs --offline                # 用本地快照，不出网
 *   node scripts/build-builtin.mjs --proxy=http://127.0.0.1:7892
 *
 * api.bgm.tv 在国内直连基本不通。脚本会自动扫本机代理端口，扫不到就直连重试。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { mapItem } from '../src/data/bangumiData.js';
import { DEFAULT_API, enrichItems, USER_AGENT } from '../src/data/bangumiApi.js';
import { slimItems } from '../src/data/slim.js';
import { detectProxy, describeProxy, httpGet } from './lib/proxyfetch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'src', 'data', 'builtin');
const SNAPSHOT = path.join(ROOT, 'local-data', 'build', 'bangumi-data.json');

const DATA_URL = 'https://unpkg.com/bangumi-data@0.3/dist/data.json';
const UA = USER_AGENT;

/** 台历关心的是「一周一集的连载」，剧场版和音乐碟不收 */
const KEEP_PLATFORMS = new Set(['TV', 'WEB', 'OVA']);

// ---------------------------------------------------------------- 参数

function parseArgs(argv) {
  const out = { seasons: null, proxy: null, offline: false, enrich: true };
  for (const a of argv) {
    if (a === '--offline') out.offline = true;
    else if (a === '--no-enrich') out.enrich = false;
    else if (a.startsWith('--seasons=')) out.seasons = a.slice(10).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith('--proxy=')) out.proxy = a.slice(8).trim();
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

/** 日本时间下的季度键，形如 2026q3 */
function seasonOf(begin) {
  const d = new Date(Date.parse(begin) + 9 * 3600000);
  return `${d.getUTCFullYear()}q${Math.ceil((d.getUTCMonth() + 1) / 3)}`;
}

/**
 * 默认季度：以今天为中心取前三季。
 * 追番的人 9 月底看的是「这一季快完 + 下一季要开」，所以往回两季、往前一季都留着。
 */
function defaultSeasons(nowMs = Date.now()) {
  const d = new Date(nowMs + 9 * 3600000);
  let year = d.getUTCFullYear();
  let q = Math.ceil((d.getUTCMonth() + 1) / 3);
  const out = [];
  for (const shift of [-1, 0, 1]) {
    let y = year;
    let qq = q + shift;
    if (qq < 1) { qq += 4; y -= 1; }
    if (qq > 4) { qq -= 4; y += 1; }
    out.push(`${y}q${qq}`);
  }
  return out;
}

// ---------------------------------------------------------------- 取数

/** 跟随重定向的 GET */
async function get(url, { proxy, timeoutMs = 120000 } = {}) {
  let target = url;
  for (let hop = 0; hop < 4; hop += 1) {
    const res = await httpGet(target, { proxy, headers: { 'User-Agent': UA }, timeoutMs });
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      target = new URL(res.headers.location, target).href;
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}：${target}`);
    return res.text;
  }
  throw new Error(`重定向次数过多：${url}`);
}

async function loadRaw({ offline, proxy }) {
  if (fs.existsSync(SNAPSHOT)) {
    const raw = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
    log(`用本地快照 ${rel(SNAPSHOT)}（${(fs.statSync(SNAPSHOT).size / 1048576).toFixed(1)} MB）`);
    return raw;
  }
  if (offline) throw new Error(`离线模式下缺少本地快照：${rel(SNAPSHOT)}`);
  log(`拉取 ${DATA_URL}`);
  const text = await get(DATA_URL, { proxy });
  fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
  fs.writeFileSync(SNAPSHOT, text);
  log(`已存快照 ${rel(SNAPSHOT)}`);
  return JSON.parse(text);
}

/** 把 fetch 注入进 bangumiApi —— 那边只关心「怎么解析」，发出去由这里决定 */
function apiFetcher(proxy) {
  return async (url, { timeoutMs = 15000, headers = {} } = {}) => {
    const res = await httpGet(url, { proxy, headers, timeoutMs });
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
    return JSON.parse(res.text);
  };
}

// ---------------------------------------------------------------- 输出

function seasonTitle(key) {
  const [y, q] = String(key).split('q');
  return `${y} 年 ${['', '一', '二', '三', '四'][Number(q)] || q} 月期`;
}

function writeSeasonFile(key, items) {
  const body = items.map((a) => JSON.stringify(a)).join(',\n');
  const text = `/**
 * 内置季度数据 · ${seasonTitle(key)}（${key}）
 *
 * 由 scripts/build-builtin.mjs 生成，不要手改 —— 改完下次生成会被覆盖。
 * 数据来源：bangumi-data（CC BY 4.0）＋ Bangumi API（bgm.tv）
 * 收录 ${items.length} 部，已剔除剧场版与音乐碟。
 */

export default [
${body}
];
`;
  fs.writeFileSync(path.join(OUT_DIR, `${key}.js`), text);
  return fs.statSync(path.join(OUT_DIR, `${key}.js`)).size;
}

function writeIndex(entries, generatedAt) {
  const imports = entries
    .map((e) => `import ${varName(e.key)} from './${e.key}.js';`)
    .join('\n');
  const map = entries
    .map((e) => `  '${e.key}': ${varName(e.key)},`)
    .join('\n');

  const text = `/**
 * 内置数据索引 —— 由 scripts/build-builtin.mjs 生成，不要手改。
 *
 * 这里的数据是「随包发布」的：装好就有本季番剧表，不用联网、不用开代理。
 * 想要更新的数据，切到联网数据源点同步即可；联网源挂了会退回到这里。
 */

${imports}

export const BUILTIN_GENERATED_AT = '${generatedAt}';

/** 收录了哪几个季度 */
export const BUILTIN_SEASONS = [${entries.map((e) => `'${e.key}'`).join(', ')}];

const SEASONS = {
${map}
};

/** 内置数据里有没有这一季 */
export function hasBuiltin(seasonKey) {
  return Object.prototype.hasOwnProperty.call(SEASONS, String(seasonKey ?? ''));
}

/** 取一季的条目；没有则返回空数组。返回的是副本，调用方随便改 */
export function builtinItems(seasonKey) {
  const list = SEASONS[String(seasonKey ?? '')];
  return list ? list.map((a) => ({ ...a })) : [];
}

/** 内置数据里所有季度的条目，按 id 去重 —— 补番卡片跨季度找条目时用 */
export function allBuiltinItems() {
  const seen = new Map();
  for (const key of BUILTIN_SEASONS) {
    for (const a of SEASONS[key]) if (!seen.has(a.id)) seen.set(a.id, a);
  }
  return [...seen.values()].map((a) => ({ ...a }));
}

/** 给界面用的一句话说明 */
export const BUILTIN_SUMMARY = ${JSON.stringify(
    `${entries.map((e) => e.key).join(' / ')} · 共 ${entries.reduce((n, e) => n + e.count, 0)} 部`,
  )};
`;
  fs.writeFileSync(path.join(OUT_DIR, 'index.js'), text);
  return fs.statSync(path.join(OUT_DIR, 'index.js')).size;
}

// ---------------------------------------------------------------- 主流程

const varName = (key) => `s${String(key).replace(/[^0-9a-z]/gi, '')}`;
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const log = (msg) => console.log(msg);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    log('用法：node scripts/build-builtin.mjs [--seasons=2026q3,2026q4] [--offline] [--no-enrich] [--proxy=http://127.0.0.1:7892]');
    return;
  }

  const seasons = args.seasons ?? defaultSeasons();
  log(`目标季度：${seasons.join(', ')}`);

  let proxy = args.proxy ? { host: '127.0.0.1', port: Number(String(args.proxy).split(':').pop()), from: '参数' } : null;
  if (!proxy && !args.offline) {
    proxy = await detectProxy();
    log(`代理：${describeProxy(proxy)}`);
  }

  const raw = await loadRaw({ offline: args.offline, proxy });
  const all = (raw.items ?? [])
    .filter((it) => it.begin)
    .map(mapItem)
    .filter((a) => KEEP_PLATFORMS.has(a.platform));

  const entries = [];
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const key of seasons) {
    let items = all.filter((a) => a.season === key);
    // 同一个 Bangumi 条目可能被两种方式收进数据集，去个重
    const seen = new Map();
    for (const a of items) if (!seen.has(a.id)) seen.set(a.id, a);
    items = [...seen.values()];
    if (!items.length) {
      log(`· ${key}：没有条目，跳过`);
      continue;
    }

    if (args.enrich) {
      const cfg = { ...DEFAULT_API, concurrency: 3, gapMs: 150, timeoutMs: 15000, enrichLimit: 10000 };
      const { stats } = await enrichItems(items, {
        api: cfg,
        fetchJson: apiFetcher(proxy),
        onProgress: (d, t) => {
          if (d === t || d % 25 === 0) process.stdout.write(`\r· ${key}：补全 ${d}/${t}…   `);
        },
      });
      process.stdout.write('\r');
      log(`· ${key}：${items.length} 部，补全成功 ${stats.ok}，失败 ${stats.failed}${stats.failed ? '（失败项保留排播信息，只是缺话数/评分/封面）' : ''}`);
    } else {
      log(`· ${key}：${items.length} 部（未补全）`);
    }

    items = slimItems(items, { summaryMax: 240 });
    // 按首播时刻排序，生成的 diff 才稳定
    items.sort((a, b) => String(a.begin).localeCompare(String(b.begin)) || a.id - b.id);

    const bytes = writeSeasonFile(key, items);
    entries.push({ key, count: items.length, bytes });
    log(`  → ${rel(path.join(OUT_DIR, `${key}.js`))}（${(bytes / 1024).toFixed(0)} KB）`);
  }

  if (!entries.length) throw new Error('一个季度都没生成出来，检查季度键或数据源');

  const generatedAt = new Date().toISOString();
  const idxBytes = writeIndex(entries, generatedAt);
  log(`\n索引 ${rel(path.join(OUT_DIR, 'index.js'))}（${(idxBytes / 1024).toFixed(1)} KB）`);
  log(`合计 ${entries.reduce((n, e) => n + e.count, 0)} 部 · ${generatedAt}`);
}

main().catch((err) => {
  console.error(`\n失败：${err?.message ?? err}`);
  process.exit(1);
});
