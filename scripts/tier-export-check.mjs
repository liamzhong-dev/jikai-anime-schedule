/**
 * Tier List 导出的真机验证（计划 F5）。
 *
 * 「导出」是最容易做成「点了有反应、其实没写文件」的功能：
 *   - canvas 超限时 `toDataURL()` **不抛错**，只给你一张空图；
 *   - 图是远端地址时会直接抛 SecurityError；
 *   - 文件写没写、写了多大、是不是全背景色，光看代码完全看不出来。
 *
 * 所以这里起一个真的浏览器：真 canvas、真 `toDataURL()`、真 PNG 字节，
 * 再把字节 POST 回本地服务器落盘，最后按 PNG 头解析出真实宽高来核对。
 *
 * 用法：`node scripts/tier-export-check.mjs [--keep]`
 * 需要本机有 Chrome 或 Edge（或用 PUPPETEER_EXECUTABLE_PATH / CHROME_PATH 指定）。
 */

import { build } from 'esbuild';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const tmpDir = path.join(root, 'test', '.tmp');
const outJs = path.join(tmpDir, 'tier-export-page.js');
const outPng = path.join(tmpDir, 'tier-export-real.png');

fs.mkdirSync(tmpDir, { recursive: true });

// ---------- 1. 打包验证页 ----------
await build({
  entryPoints: [path.join(root, 'test/fixtures/tier-export-page.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  outfile: outJs,
  logLevel: 'silent',
});

const html = `<!doctype html><meta charset="utf-8"><title>tier export</title><body></body>
<script src="/page.js"></script>`;

// ---------- 2. 起本地服务（同源，绕开 CORS；顺便收 PNG 字节） ----------
let savedBytes = 0;
let savedBuf = null;
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  if (req.url === '/page.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    res.end(fs.readFileSync(outJs));
    return;
  }
  if (req.method === 'POST' && req.url === '/save.png') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      savedBuf = Buffer.concat(chunks);
      savedBytes = savedBuf.length;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    return;
  }
  res.writeHead(404);
  res.end('no');
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/`;

// ---------- 3. 找浏览器（不写死用户目录） ----------
function findBrowser() {
  const env = process.env;
  const rel = ['Google/Chrome/Application/chrome.exe', 'Microsoft/Edge/Application/msedge.exe'];
  const bases = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
  const list = [env.PUPPETEER_EXECUTABLE_PATH, env.CHROME_PATH];
  for (const b of bases) for (const r of rel) list.push(path.join(b, r));
  list.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  list.push('/usr/bin/google-chrome');
  list.push('/usr/bin/chromium');
  return list.find((p) => p && fs.existsSync(p));
}

const browser = findBrowser();
if (!browser) {
  console.error('✗ 没找到 Chrome / Edge，跳过真机导出验证（可用 CHROME_PATH 指定）');
  server.close();
  process.exit(2);
}

// ---------- 4. 跑 ----------
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jikai-export-'));
const args = [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-proxy-server',
  `--user-data-dir=${profile}`,
  '--virtual-time-budget=25000',
  '--dump-dom',
  url,
];

const dom = await new Promise((resolve, reject) => {
  const child = spawn(browser, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { err += d.toString(); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
  child.on('close', () => { clearTimeout(timer); resolve({ out, err }); });
  child.on('error', reject);
});

server.close();

// ---------- 5. 解析结果 ----------
const m = /<pre id="result">([\s\S]*?)<\/pre>/.exec(dom.out);
const text = m ? m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : '';

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  if (text) console.error(`  页面输出：${text.slice(0, 400)}`);
  process.exit(1);
};

if (!text) fail(`没拿到页面输出（DOM ${dom.out.length} 字节）`);
if (text.includes('EXPORT_FAIL')) fail(`页面里导出失败：${text.slice(0, 300)}`);

const jsonLine = text.split('\n').find((l) => l.trim().startsWith('{'));
if (!jsonLine) fail(`页面输出里没有结果 JSON：${text.slice(0, 300)}`);
const info = JSON.parse(jsonLine.trim());

if (info.status !== 'EXPORT_OK') fail(`状态不是 EXPORT_OK：${info.status}`);

// ---------- 6. 落盘的 PNG 要真的能解析 ----------
if (!savedBuf || savedBytes < 1000) fail(`PNG 没落盘或太小（${savedBytes} 字节）`);
fs.writeFileSync(outPng, savedBuf);

const isPng = savedBuf[0] === 0x89 && savedBuf[1] === 0x50 && savedBuf[2] === 0x4e && savedBuf[3] === 0x47;
if (!isPng) fail('落盘的文件不是 PNG（魔数不对）');

// PNG 头：8 字节签名 + 4 长度 + 4 类型(IHDR) + 4 宽 + 4 高
const pngW = savedBuf.readUInt32BE(16);
const pngH = savedBuf.readUInt32BE(20);
if (pngW !== info.width || pngH !== info.height) {
  fail(`PNG 里的宽高（${pngW}×${pngH}）和布局算出来的（${info.width}×${info.height}）不一致`);
}

// ---------- 7. 不是空白 ----------
const ratio = info.nonBgRatio ?? 0;
if (ratio < 0.05) fail(`导出图几乎是空白（非背景像素只占 ${(ratio * 100).toFixed(2)}%）`);

console.log('✓ 真机导出验证通过');
console.log(`  浏览器：${browser}`);
console.log(`  画布：${info.width}×${info.height} @ ${info.scale}x${info.degraded ? ` · 降级：${info.reason}` : ''}`);
console.log(`  PNG：${(savedBytes / 1024).toFixed(1)} KB · 落盘 ${path.relative(root, outPng)}`);
console.log(`  像素：非背景 ${(ratio * 100).toFixed(1)}% · 颜色数 ${info.pixels?.colors ?? '?'}`);
console.log(`  缺图：${info.missing} 张（应当为 0）`);

if (!process.argv.includes('--keep')) {
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 临时目录，清不掉无所谓 */ }
}
