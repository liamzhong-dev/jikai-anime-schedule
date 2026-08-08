#!/usr/bin/env node
/**
 * 真实网络验证：拿 Bangumi 官方 API 的**实际响应**，跑一遍项目里的补全逻辑。
 *
 * 和 test/api.test.mjs 的区别要说清楚 ——
 *   - 那边用本地假服务器返回「形状正确」的 JSON，验证的是**解析代码写得对不对**；
 *   - 这边连真的 api.bgm.tv，验证的是**这条路在你这台机器上走不走得通**、
 *     真实数据里的字段是不是和文档写的一样、封面图能不能真的加载出来。
 * 两者不能互相替代。网络这件事，假服务器永远验不出来。
 *
 * 用法：
 *   node scripts/live-check.mjs                  # 自动探测代理，跑完整验证
 *   node scripts/live-check.mjs --limit=8        # 多补几部
 *   node scripts/live-check.mjs --offline        # 只用本地快照，不联网（回归解析用）
 *   ANIME_DESK_PROXY=http://127.0.0.1:7890 node scripts/live-check.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { httpGet, detectProxy, describeProxy } from './lib/proxyfetch.mjs';
import {
  USER_AGENT,
  diagnose,
  enrichItems,
  needsEnrich,
  probeSubject,
} from '../src/data/bangumiApi.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE_DIR = path.join(ROOT, 'local-data', 'live');

function arg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

const LIMIT = Number(arg('limit', 6));
const OFFLINE = hasFlag('offline');

function log(...a) {
  console.log(...a);
}
function rule(title) {
  log(`\n${'─'.repeat(4)} ${title} ${'─'.repeat(Math.max(0, 62 - title.length))}`);
}

/** 把请求结果包成项目里期望的 fetchJson 形状 */
function makeFetchJson(proxy) {
  return async function fetchJson(url, { timeoutMs = 15000, headers = {} } = {}) {
    const res = await httpGet(url, { proxy, headers, timeoutMs });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`HTTP ${res.status}`);
    }
    try {
      return JSON.parse(res.text);
    } catch {
      throw new Error(`返回的不是合法 JSON（前 60 字：${res.text.slice(0, 60)}）`);
    }
  };
}

function readSnapshot(name) {
  const p = path.join(LIVE_DIR, name);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function writeSnapshot(name, json) {
  fs.mkdirSync(LIVE_DIR, { recursive: true });
  fs.writeFileSync(path.join(LIVE_DIR, name), JSON.stringify(json, null, 2), 'utf8');
}

/** 把 /calendar 摊平成 [{id, name, air}] */
function flattenCalendar(cal) {
  const out = [];
  for (const day of cal ?? []) {
    for (const it of day.items ?? []) {
      out.push({
        id: Number(it.id),
        name: it.name_cn || it.name || `#${it.id}`,
        air: day.weekday?.cn ?? '',
      });
    }
  }
  return out;
}

const problems = [];
const check = (cond, msg) => {
  if (!cond) problems.push(msg);
  return cond;
};

async function main() {
  log('次回 · 真实数据通路验证');
  log(`时间：${new Date().toLocaleString('zh-CN')}`);
  log(`模式：${OFFLINE ? '离线（只用本地快照）' : '联网（真实 api.bgm.tv）'}`);

  let proxy = null;
  let fetchJson;

  if (OFFLINE) {
    // 离线模式下所有请求都从 local-data/live 里读，用来回归解析逻辑
    fetchJson = async (url) => {
      const m = /\/v0\/subjects\/(\d+)/.exec(url);
      if (m) {
        const snap = readSnapshot(`subject-${m[1]}.json`);
        if (snap) return snap;
      }
      throw new Error(`离线模式：本地没有 ${url} 的快照`);
    };
    log('代理：不需要');
  } else {
    rule('1. 代理探测');
    proxy = await detectProxy();
    log(`  结果：${describeProxy(proxy)}`);
    fetchJson = makeFetchJson(proxy);

    rule('2. 端点连通性（项目里的 diagnose）');
    const diag = await diagnose({ fetchJson });
    for (const r of diag.rows) {
      log(`  ${r.ok ? '[ok]' : '[失败]'} ${r.base}  ${r.ok ? `${r.ms} ms · 样例「${r.sample}」` : r.error}`);
    }
    if (!check(diag.ok, '所有端点都不通，补全功能在这台机器上不可用')) {
      report();
      return;
    }

    rule('3. 取真实番剧列表（/calendar）');
    let cal;
    try {
      cal = await fetchJson('https://api.bgm.tv/calendar', { headers: { 'User-Agent': USER_AGENT } });
      writeSnapshot('calendar.json', cal);
    } catch (err) {
      cal = readSnapshot('calendar.json');
      log(`  实时拉取失败（${err.message}），改用上次快照`);
    }
    const list = flattenCalendar(cal);
    log(`  拿到 ${list.length} 部在放番剧，取前 ${LIMIT} 部做补全`);
  }

  // 构造「像 bangumi-data 那样只有 id 和标题」的条目 —— 这才是真实的补全场景
  const seeds = flattenCalendar(readSnapshot('calendar.json')).slice(0, LIMIT);
  if (!seeds.length) {
    log('  没有可用的番剧种子数据，无法继续');
    report();
    return;
  }

  const items = seeds.map((s) => ({ id: s.id, title: s.name, eps: null, cover: null }));
  const before = items.filter((a) => needsEnrich(a)).length;
  log(`  补全前：${before}/${items.length} 部缺话数或封面`);

  rule('4. 真实补全（项目里的 enrichItems）');
  const t0 = Date.now();
  const { stats } = await enrichItems(items, {
    fetchJson,
    onProgress: (d, t) => process.stdout.write(`\r  进度 ${d}/${t}…`),
  });
  process.stdout.write('\r');
  log(`  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s · 请求 ${stats.requested} 部，成功 ${stats.ok}，失败 ${stats.failed}`);
  check(stats.failed === 0, `有 ${stats.failed} 部补全失败`);

  rule('5. 补全结果');
  const head = ['ID', '标题', '话数', '评分', '评分人数', '制作', '封面'];
  log('  ' + head.join(' | '));
  for (const a of items) {
    const cover = a.cover ? '有' : '—';
    log(
      '  ' +
        [
          a.id,
          String(a.titleZh || a.title || '').slice(0, 18),
          a.eps ?? '—',
          a.score ?? '—',
          a.watchers ?? '—',
          String(a.studio ?? '—').slice(0, 14),
          cover,
        ].join(' | '),
    );
  }

  rule('6. 逐项断言');
  const withStudio = items.filter((a) => a.studio).length;
  const withCover = items.filter((a) => a.cover).length;
  const withEps = items.filter((a) => Number(a.eps) > 0).length;
  const withScore = items.filter((a) => Number(a.score) > 0).length;

  check(withEps === items.length, `话数：只有 ${withEps}/${items.length} 部拿到`);
  check(withCover === items.length, `封面：只有 ${withCover}/${items.length} 部拿到`);

  // 评分有可能真的拿不到 —— 刚开播的番还没人打分，rating.total 就是 0。
  // 这种情况留空是对的（不编数据）；但「明明有人打分却没解析出评分」就是 bug。
  const scoreMissed = items.filter((a) => !(Number(a.score) > 0) && Number(a.watchers) > 0);
  check(
    scoreMissed.length === 0,
    `有 ${scoreMissed.length} 部明明有人打分却没解析出评分：${scoreMissed.map((a) => a.id).join('、')}`,
  );

  // 制作公司覆盖率真实情况就不高：不少条目 infobox 里根本没有「动画制作」这项。
  // 所以只要求「解析出来的都是对的」，不要求每部都有。
  check(withStudio > 0, '制作公司一部都没解析出来，parseStudio 可能对不上新版 infobox');

  for (const a of items) {
    if (a.cover && !/^https:\/\//.test(a.cover)) problems.push(`封面不是 https：${a.cover}`);
    if (a.score != null && (a.score < 0 || a.score > 10)) problems.push(`评分超出 0-10：${a.score}`);
  }
  log(`  话数 ${withEps}/${items.length} · 封面 ${withCover}/${items.length}`);
  log(`  评分 ${withScore}/${items.length}（其余是还没人打分的新番，留空是对的）`);
  log(`  制作 ${withStudio}/${items.length}（真实条目常常没这项，不代表解析有问题）`);

  // 封面图能不能真的加载 —— 这条最容易被忽略：URL 拿到了，图挂了一样白搭
  if (!OFFLINE && items[0]?.cover) {
    rule('7. 封面图直链可加载性');
    const url = items[0].cover;
    try {
      const res = await httpGet(url, { proxy, timeoutMs: 15000 });
      const ct = res.headers['content-type'] || '';
      log(`  ${res.status} ${ct} · ${(res.bytes / 1024).toFixed(1)} KB`);
      check(res.status === 200, `封面返回 HTTP ${res.status}`);
      check(/^image\//.test(ct), `封面 content-type 不是图片：${ct}`);
      check(res.bytes > 1024, `封面只有 ${res.bytes} 字节，像是占位图`);
    } catch (err) {
      problems.push(`封面图拉不下来：${err.message}`);
      log(`  [失败] ${err.message}`);
    }
  }

  // 存快照，方便以后离线回归
  if (!OFFLINE) {
    for (const a of items.slice(0, LIMIT)) {
      try {
        const one = await probeSubject(a.id, { fetchJson });
        writeSnapshot(`subject-${a.id}.json`, one.raw);
      } catch {
        /* 快照存不下不影响结论 */
      }
    }
    fs.mkdirSync(LIVE_DIR, { recursive: true });
    fs.writeFileSync(path.join(LIVE_DIR, 'last-run.json'), JSON.stringify({
      at: new Date().toISOString(),
      proxy: proxy ? `${proxy.host}:${proxy.port}` : null,
      stats,
      items: items.map((a) => ({ id: a.id, titleZh: a.titleZh, eps: a.eps, score: a.score, studio: a.studio, cover: a.cover })),
    }, null, 2), 'utf8');
    log(`\n  快照已存到 ${path.relative(ROOT, LIVE_DIR)}/（该目录已被 .gitignore 排除）`);
  }

  report();
}

function report() {
  rule('结论');
  if (!problems.length) {
    log('  [ok] 全部通过 —— 真实 API 的字段、解析、并发补全、封面直链都验证过了');
  } else {
    log(`  [失败] ${problems.length} 项没通过：`);
    for (const p of problems) log(`     · ${p}`);
  }
  log('');
  process.exitCode = problems.length ? 1 : 0;
}

main().catch((err) => {
  console.error('\n脚本崩了：', err);
  process.exitCode = 2;
});
