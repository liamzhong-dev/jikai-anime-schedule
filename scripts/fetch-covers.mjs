/**
 * 抓「封面素材图包」：把随包数据里那些作品的封面提前下好，跟着安装包一起发出去。
 *
 * 为什么要有这一包：
 *   第一次打开就断网（或者 bangumi 图床恰好不通）的时候，界面上是一整屏色块。
 *   那个样子很容易被读成「软件坏了」—— 其实只是图还没下来。
 *   跟着安装包带一批图，装完第一次打开**不联网也有图**。
 *
 * 为什么只带 `c` 这一档（150×212，约 12KB）：
 *   界面上显示的正是这一档（见 src/core/covers.js 的 DISPLAY_VARIANT），
 *   而原图 `l` 平均 569KB —— 219 部就是 45MB，跟着安装包发出去太离谱。
 *   导出时才需要原图，那时用户本来就在网上。
 *
 * ⚠️ 文件名必须和运行时算出来的**完全一致**，否则种子一颗都命中不了：
 *   落点是 `covers/<组>/<hash>.<ext>`，hash 来自**请求时那个 URL**（`c` 变体），
 *   不是条目上的原图地址。所以这里直接复用 electron/covers.cjs 的 hashUrl，
 *   不自己再实现一遍 —— 两边各算一次，只要有一处理解不同，
 *   表现是「种子全在，界面一张都没用上」，而 JS 不报错。
 *
 * 用法：node scripts/fetch-covers.mjs [--force]
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { detectProxy, describeProxy } from './lib/proxyfetch.mjs';
import { openSessions, sleep } from './lib/poolfetch.mjs';
import { coverVariant, DISPLAY_VARIANT } from '../src/core/covers.js';

const require = createRequire(import.meta.url);
// 同一个 hash 函数 —— 种子能不能命中全看它
const { hashUrl } = require('../electron/covers.cjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'build', 'covers');
const HOST = 'lain.bgm.tv';
const CONCURRENCY = 6;
const RETRY = 2;
const USER_AGENT = 'jikai-cover-pack/1.0 (+https://github.com/liamzhong-dev/jikai-anime-schedule)';

const force = process.argv.includes('--force');

function log(s) {
  process.stdout.write(`${s}\n`);
}

/**
 * 直接取二进制。poolfetch 的会话只回 text，封面是二进制，
 * 所以这里自己走一遍同样的持久连接 —— 图床是同一个 host，连接复用同样有效。
 */
async function fetchBinary(session, urlPath, timeoutMs = 20000) {
  const res = await session.request(urlPath, { headers: { 'User-Agent': USER_AGENT }, timeoutMs });
  return res;
}

async function main() {
  // Windows 上必须转成 file:// URL 才能 import —— 直接给绝对路径会报
  // ERR_UNSUPPORTED_ESM_URL_SCHEME（收到的协议是 'c:'），看着像路径写错了，
  // 其实是 ESM loader 不认裸的盘符路径。
  const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'data', 'builtin', 'index.js')).href);
  const items = typeof mod.allBuiltinItems === 'function' ? mod.allBuiltinItems() : mod.allBuiltinItems;

  // 组名就是季度 key，跟运行时预热用的 group 一致（App.jsx 里传的是 seasonKey）
  const jobs = [];
  for (const a of items) {
    const url = coverVariant(a?.cover, DISPLAY_VARIANT).url;
    if (!url) continue;
    const u = new URL(url);
    if (u.hostname !== HOST) continue;
    const group = String(a?.season ?? '').trim();
    if (!/^[A-Za-z0-9_-]{1,48}$/.test(group)) continue;
    const ext = /\.png(\?|$)/i.test(url) ? '.png' : '.jpg';
    const file = path.join(OUT_DIR, group, `${hashUrl(url)}${ext}`);
    if (!force && fs.existsSync(file) && fs.statSync(file).size > 0) continue;
    jobs.push({ url, path: `${u.pathname}${u.search}`, file, group });
  }

  log(`随包作品 ${items.length} 部 · 待下载 ${jobs.length} 张（${force ? '全部重下' : '只补缺的'}）`);
  if (!jobs.length) {
    log('图包已经齐了，没事情做。');
    return;
  }

  log('探测代理…');
  const proxy = await detectProxy({ target: HOST });
  log(`代理：${describeProxy(proxy)}`);

  const { sessions, closeAll } = await openSessions(CONCURRENCY, { proxy, host: HOST, port: 443 });
  let ok = 0;
  let failed = 0;
  let bytes = 0;
  let cursor = 0;
  const errors = [];

  async function worker(session, idx) {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= jobs.length) return;
      const job = jobs[i];
      let lastErr = null;
      for (let attempt = 0; attempt <= RETRY; attempt += 1) {
        try {
          const res = await fetchBinary(session, job.path);
          if (res.status !== 200) {
            lastErr = `HTTP ${res.status}`;
            await sleep(300);
            continue;
          }
          // 必须拿原始字节：res.text 是按 utf8 解过码的字符串，图片走它会坏。
          const buf = res.buffer;
          if (!buf.length) {
            lastErr = '空响应';
            await sleep(300);
            continue;
          }
          await fs.promises.mkdir(path.dirname(job.file), { recursive: true });
          const tmp = `${job.file}.tmp`;
          await fs.promises.writeFile(tmp, buf);
          await fs.promises.rename(tmp, job.file);
          ok += 1;
          bytes += buf.length;
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err?.message ?? String(err);
          await sleep(500);
        }
      }
      if (lastErr) {
        failed += 1;
        if (errors.length < 20) errors.push({ url: job.url, error: lastErr });
      }
      const done = ok + failed;
      if (done % 25 === 0 || done === jobs.length) log(`  ${done}/${jobs.length}（成功 ${ok} · 失败 ${failed}）`);
      void idx;
    }
  }

  try {
    await Promise.all(sessions.map((s, i) => worker(s, i)));
  } finally {
    closeAll();
  }

  log(`\n完成：成功 ${ok} · 失败 ${failed} · ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  log(`落在 ${path.relative(ROOT, OUT_DIR).replace(/\\/g, '/')}/`);
  if (errors.length) {
    log('\n失败清单（前 20 条）：');
    for (const e of errors) log(`  - ${e.url} → ${e.error}`);
  }
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`✗ ${err?.stack ?? err}`);
  process.exit(1);
});
