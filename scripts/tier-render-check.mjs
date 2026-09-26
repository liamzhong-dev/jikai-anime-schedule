/**
 * 界面真机验证（计划 F4）：把**构建产物**喂给无头浏览器，检查 Tier List 真的画出来了。
 *
 * 为什么不能只靠 SSR 字符串断言：
 *   SSR 跑的是 `renderToStaticMarkup`，它不执行 effect、不量 DOM、不会真正排版。
 *   「档位在不在」它能测，「拖拽时的落点量得到吗」「图块到底有没有渲染成 100px 的块」
 *   它测不了。这里用真浏览器跑构建产物，补上这一段。
 *
 * ⚠️ 静态服务和浏览器**必须在同一个脚本里起**：实测把服务放在另一个进程里，
 * 无头浏览器连 `127.0.0.1` 会直接 ERR_CONNECTION_REFUSED（沙盒各进程的网络是隔开的）。
 *
 * 用法：`node scripts/tier-render-check.mjs [--season=2026q3]`
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const dist = path.join(root, 'dist');
const season = (process.argv.find((a) => a.startsWith('--season=')) ?? '--season=2026q3').split('=')[1];

if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('✗ 没有 dist/，先跑一次 npm run build');
  process.exit(2);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

const dragMode = process.argv.includes('--drag');
const probeSrc = fs.readFileSync(path.join(root, 'test/fixtures/tier-drag-probe.js'), 'utf8');

/** 注入拖拽探针：模块脚本是 defer 的，探针先跑、自己轮询等应用挂上来 */
function indexHtml() {
  const raw = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  if (!dragMode) return raw;
  return raw.replace('</body>', '<script src="/drag-probe.js"></script></body>');
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);

  if (url === '/drag-probe.js') {
    res.writeHead(200, { 'content-type': MIME['.js'] });
    res.end(probeSrc);
    return;
  }

  // 深链是 hash 路由，服务端只需要把 / 交给 index.html
  const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
  const file = path.join(dist, rel);
  // 别让 ../ 穿出 dist。（index.html 单独走一支：要注入探针）
  if (rel === 'index.html' || !file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(200, { 'content-type': MIME['.html'] });
    res.end(indexHtml());
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

function findBrowser() {
  const env = process.env;
  const rel = ['Google/Chrome/Application/chrome.exe', 'Microsoft/Edge/Application/msedge.exe'];
  const bases = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
  const list = [env.PUPPETEER_EXECUTABLE_PATH, env.CHROME_PATH];
  for (const b of bases) for (const r of rel) list.push(path.join(b, r));
  list.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  list.push('/usr/bin/google-chrome');
  return list.find((p) => p && fs.existsSync(p));
}

const browser = findBrowser();
if (!browser) {
  console.error('✗ 没找到 Chrome / Edge（可用 CHROME_PATH 指定）');
  server.close();
  process.exit(2);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jikai-render-'));
const target = `http://127.0.0.1:${port}/#/tier?q=${season}`;
const shot = path.join(root, 'test', '.tmp', 'tier-view.png');
fs.mkdirSync(path.dirname(shot), { recursive: true });

// 想真正看到封面的话给个代理（直连 lain.bgm.tv 是不通的）：
//   node scripts/tier-render-check.mjs --proxy=127.0.0.1:7892
const proxy = (process.argv.find((a) => a.startsWith('--proxy=')) ?? '').split('=')[1];

const dom = await new Promise((resolve, reject) => {
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run',
    // ⚠️ 这一步是必须的，不是「顺手加个离线」：
    // `--virtual-time-budget` 的策略是**有网络请求挂着时暂停虚拟时间**，
    // 而这里一屏有 82 张远端封面 —— 连不上又不失败，它们会一直 pending，
    // 虚拟时间就永远走不完，`--dump-dom` 一个字都出不来（表现为「DOM 0 字节」，
    // 看着像应用崩了，其实是浏览器在等）。让外部域名瞬间解析失败即可。
    ...(proxy
      ? [`--proxy-server=http://${proxy}`]
      : ['--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']),
    `--user-data-dir=${profile}`,
    '--window-size=1440,900',
    '--virtual-time-budget=25000',
    // 顺手截一张图：DOM 断言只能说明「节点在」，
    // 版面塌了、图块叠在一起这类问题还是得看一眼才算数。
    `--screenshot=${shot}`,
    '--dump-dom',
    target,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', () => {});
  const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
  child.on('close', () => { clearTimeout(timer); resolve(out); });
  child.on('error', reject);
});

server.close();
if (!process.argv.includes('--keep')) {
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 临时目录 */ }
}

const countOf = (html, needle) => html.split(needle).length - 1;
const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };

check(!dom.includes('ERR_CONNECTION'), '页面没加载起来');
check(countOf(dom, 'tier-row__label') === 7, `档位行应为 7，实际 ${countOf(dom, 'tier-row__label')}`);
for (const label of ['TOP', 'TRASH', 'DRUG']) {
  check(dom.includes(`>${label}<`), `档位名 ${label} 没渲染出来`);
}
check(dom.includes('素材池'), '素材池标题没渲染');
check(countOf(dom, 'tier-item__art') > 5, `素材池里的图块太少（${countOf(dom, 'tier-item__art')} 个）`);
// 浏览器壳没有本地封面缓存通道，必须退回直连 —— 退回失败就是一整屏色块，
// 界面看着「没坏」，其实一张图都没显示。
// 用 data-cover 判断走的是哪条路，不看有没有 <img>：
// 这个脚本默认不走代理，远端封面会加载失败并按 onError 退回色块，
// 那时 `<img>` 已经被 React 换成 `<span>` 了 —— 拿它做断言会假红。
check(countOf(dom, 'data-cover="remote"') > 5, `浏览器壳的封面降级没生效（data-cover="remote" 有 ${countOf(dom, 'data-cover="remote"')} 个）`);
check(countOf(dom, 'data-cover="none"') === 0, `有 ${countOf(dom, 'data-cover="none"')} 个图块既没缓存也没远端地址`);

/**
 * ⚠️ 反向断言（计划 G4）：浏览器壳**不允许**出现 `cache`。
 * 浏览器没有本地封面缓存通道，一旦出现 `cache` 说明「能力判断」错了 ——
 * 界面会在一个拿不到缓存的壳里走缓存分支，结果是一整屏色块，
 * 而且**看起来很像「图还没加载完」**，没有这条断言根本抓不到。
 * 它是 `check:desktop` 里那条「桌面必须 remote === 0」的镜像。
 */
check(
  countOf(dom, 'data-cover="cache"') === 0,
  `浏览器壳不该出现缓存封面，实际 ${countOf(dom, 'data-cover="cache"')} 个 —— 平台能力判断错了`,
);
check(dom.includes('Tier List'), '侧栏没有 Tier List 导航项');
check(dom.includes('导出 PNG'), '工具栏没有导出按钮');
// 拖拽模式跑完之后 TOP 档已经有东西了，空档就只剩 6 个 —— 断言要跟着模式走
const emptyRows = dragMode ? 6 : 7;
check(
  countOf(dom, 'tier-row__empty') === emptyRows,
  `空档提示应有 ${emptyRows} 个，实际 ${countOf(dom, 'tier-row__empty')}`,
);

if (failures.length) {
  console.error('✗ Tier List 真机渲染验证失败：');
  for (const f of failures) console.error(`  · ${f}`);
  if (dragMode) {
    const raw = /<pre id="drag">([\s\S]*?)<\/pre>/.exec(dom);
    if (raw) console.error(`  拖拽探针原文：${raw[1].slice(0, 400)}`);
  }
  process.exit(1);
}

// ---- 拖拽（--drag）----
let dragInfo = null;
if (dragMode) {
  const raw = /<pre id="drag">([\s\S]*?)<\/pre>/.exec(dom);
  const text = raw ? raw[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&') : '';
  if (!text) failures.push('拖拽探针没有输出（脚本可能压根没跑）');
  else if (text.includes('DRAG_FAIL')) failures.push(`拖拽失败：${text}`);
  else {
    dragInfo = JSON.parse(text);
    check(dragInfo.topBefore === 0 && dragInfo.topAfter === 1, `TOP 档应当从 0 变成 1，实际 ${dragInfo.topBefore} → ${dragInfo.topAfter}`);
    check(dragInfo.poolAfter === dragInfo.poolBefore - 1, `素材池应当少一个，实际 ${dragInfo.poolBefore} → ${dragInfo.poolAfter}`);
    check(dragInfo.topTiles === 1, `TOP 档里应当真的多出一个图块，实际 ${dragInfo.topTiles}`);
    check(dragInfo.ghostLeft === 0, '松手之后拖拽影子必须消失');
  }
}

const shotOk = fs.existsSync(shot) && fs.statSync(shot).size > 12 * 1024;
if (!shotOk) {
  console.error('✗ 截图没生成或疑似空白（小于 12KB）');
  process.exit(1);
}

console.log('✓ Tier List 真机渲染验证通过');
console.log(`  浏览器：${browser}`);
console.log(`  页面：${target}`);
console.log(`  档位 7 行 · 素材池图块 ${countOf(dom, 'tier-item__art')} 个 · DOM ${(dom.length / 1024).toFixed(0)} KB`);
if (dragInfo) {
  console.log(`  拖拽：素材池 ${dragInfo.poolBefore} → ${dragInfo.poolAfter} · TOP 档 ${dragInfo.topBefore} → ${dragInfo.topAfter}（真 PointerEvent）`);
}
console.log(`  截图：${path.relative(root, shot)}（${(fs.statSync(shot).size / 1024).toFixed(0)} KB）`);
