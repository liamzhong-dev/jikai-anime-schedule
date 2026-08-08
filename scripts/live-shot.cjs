#!/usr/bin/env node
/**
 * 用真实网络截一张图，证明「真实数据真的能渲染出来」。
 *
 * 这张图**不进仓库** —— 输出到 local-data/live/（整目录已 gitignore）。
 * 原因有两个：① 图里是真实番剧条目；② 它依赖网络，不适合当回归产物。
 * 仓库里 screenshots/ 那批仍然是全虚构的演示数据。
 *
 * 关键点：**无头浏览器不会自动读系统代理**，必须显式 `--proxy-server`。
 * 这跟 Electron 主进程（走 Chromium net 栈、自动跟随系统代理）是两回事。
 *
 * 用法：node scripts/live-shot.cjs [--proxy=127.0.0.1:7892] [--wait=90000]
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUT_DIR = path.join(ROOT, 'local-data', 'live');
const OUT = path.join(OUT_DIR, 'shot-live.png');
const STATE_KEY = 'jikai/state/v1';
const WALLPAPER_KEY = 'jikai/wallpaper/v1';

const argOf = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const WAIT_MS = Number(argOf('wait', 90000));
const CANDIDATES = [argOf('proxy', null), process.env.ANIME_DESK_PROXY, '127.0.0.1:7892', '127.0.0.1:7890']
  .filter(Boolean)
  .map((s) => s.replace(/^https?:\/\//, '').replace(/\/.*$/, ''));

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

function portAlive(hostPort, timeoutMs = 1200) {
  const [host, port] = hostPort.split(':');
  return new Promise((resolve) => {
    const s = net.connect({ host, port: Number(port) }, () => { s.destroy(); resolve(true); });
    s.setTimeout(timeoutMs);
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
  });
}

/** 浏览器路径不写死用户目录 */
function findBrowser() {
  const env = process.env;
  const cands = [env.PUPPETEER_EXECUTABLE_PATH, env.CHROME_PATH];
  const rel = ['Google/Chrome/Application/chrome.exe', 'Microsoft/Edge/Application/msedge.exe'];
  for (const base of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean)) {
    for (const r of rel) cands.push(path.join(base, r));
  }
  cands.push('/usr/bin/google-chrome', '/usr/bin/chromium');
  const hit = cands.filter(Boolean).find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (!hit) throw new Error('没找到 Chrome / Edge，用 PUPPETEER_EXECUTABLE_PATH 指定');
  return hit;
}

function serveDist() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
    const file = path.join(DIST, rel || 'index.html');
    if (!file.startsWith(DIST)) return res.writeHead(403).end();
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end('not found');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port })));
}

(async () => {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.error('找不到 dist/index.html，先跑 npm run build');
    process.exit(1);
  }

  let proxy = null;
  for (const c of CANDIDATES) {
    if (await portAlive(c)) { proxy = c; break; }
  }
  if (!proxy) {
    console.error('没探测到可用代理端口。先开 VPN，或用 --proxy=host:port 指定。');
    process.exit(1);
  }
  console.log(`代理：${proxy}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { server, port } = await serveDist();

  const browser = await puppeteer.launch({
    executablePath: findBrowser(),
    headless: true,
    userDataDir: path.join(OUT_DIR, 'chrome-profile'),
    defaultViewport: { width: 1440, height: 900 },
    args: [
      '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
      '--no-default-browser-check', '--hide-scrollbars', '--force-color-profile=srgb',
      // 关键：显式把无头浏览器挂到本地代理上，否则它根本不读系统代理
      `--proxy-server=http://${proxy}`,
    ],
  });

  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [页面错误]', m.text().slice(0, 160)); });

  // 播种：选「补全」源，并把补全上限压到 24 部，让它在截图前能跑完
  await page.evaluateOnNewDocument((sk, wk, seed) => {
    try {
      localStorage.removeItem(sk);
      localStorage.removeItem(wk);
      localStorage.setItem(sk, JSON.stringify({ settings: seed }));
    } catch { /* 播种失败就用默认，下面的探针会看出来 */ }
  }, STATE_KEY, WALLPAPER_KEY, { dataSource: 'bangumi-api', api: { enrichLimit: 24 } });

  await page.goto(`http://127.0.0.1:${port}/#/season`, { waitUntil: 'load' });
  await page.waitForSelector('.window', { timeout: 20000 });

  // 轮询等同步结束：进度条消失即认为收工（超时就按当前状态拍）
  const t0 = Date.now();
  let done = false;
  while (Date.now() - t0 < WAIT_MS) {
    await new Promise((r) => setTimeout(r, 800));
    const busy = await page.evaluate(() => {
      const bar = document.querySelector('.progressbar');
      return Boolean(bar && !bar.classList.contains('progressbar--hidden'));
    });
    if (!busy) { done = true; break; }
    if ((Date.now() - t0) % 8000 < 800) {
      console.log(`  同步中… ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  }
  console.log(done ? `同步完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s` : '等待超时，按当前状态截图');

  // 等封面图真的加载出来。24 张图过代理有好几 MB，不等的话截到的是渐变色占位 ——
  // 图元素在、像素没到，探针数「img 有几个」是数不出来的。
  const tImg = Date.now();
  let imgStat = { total: 0, done: 0 };
  for (;;) {
    imgStat = await page.evaluate(() => {
      const imgs = [...document.querySelectorAll('img')].filter((i) => /bgm\.tv/.test(i.src));
      return { total: imgs.length, done: imgs.filter((i) => i.complete && i.naturalWidth > 0).length };
    });
    if (imgStat.total === 0 || imgStat.done === imgStat.total || Date.now() - tImg > 30000) break;
    await new Promise((r) => setTimeout(r, 700));
  }
  console.log(`封面加载 ${imgStat.done}/${imgStat.total}（用时 ${((Date.now() - tImg) / 1000).toFixed(1)}s）`);
  await new Promise((r) => setTimeout(r, 900));

  const probe = await page.evaluate(() => ({
    cards: document.querySelectorAll('.card').length,
    banner: document.querySelector('.banner')?.textContent?.slice(0, 120) ?? null,
    // 抓一张卡上的标题，确认是真实数据还是回退后的演示数据
    firstTitle: document.querySelector('.card__title, .card .title, .card h3')?.textContent?.trim() ?? null,
    coverImgs: [...document.querySelectorAll('img')].filter((i) => /bgm\.tv/.test(i.src)).length,
  }));

  await page.screenshot({ path: OUT, type: 'png' });
  await browser.close();
  server.close();

  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`\n已保存 ${path.relative(ROOT, OUT)}（${kb} KB）`);
  console.log(`  卡片 ${probe.cards} 张 · 封面 img ${probe.coverImgs} 张 · 实际加载出像素 ${imgStat.done} 张`);
  console.log(`  首张卡标题：${probe.firstTitle ?? '(取不到)'}`);
  console.log(probe.banner ? `  [注意] 顶部有横幅：${probe.banner}` : '  顶部没有警告横幅 —— 数据是真的');
  if (probe.coverImgs === 0) console.log('  [注意] 一张 bgm.tv 封面都没有，可能没真的连上');
  else if (imgStat.done === 0) console.log('  [注意] 封面元素建了但一张像素都没加载出来，检查代理是否覆盖 lain.bgm.tv');
})().catch((e) => {
  console.error('失败：', e.message);
  process.exit(1);
});
