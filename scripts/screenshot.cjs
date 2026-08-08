'use strict';

/**
 * 截图脚本：构建产物起本地静态服务，用本机 Chrome/Edge 无头逐视图截图。
 * 运行：npm run shoot
 *
 * 画面用的是随包发布的真实番剧数据（内置季度），界面上的追番与补番由
 * test/fixtures/sample-state.js 从同一份数据里挑出来 —— 不写死番剧名，
 * 内置数据重新生成后截图不会失真。不含任何个人信息或本机路径。
 * 不用 Electron 的 capturePage，是因为它在无 GPU 的环境里不稳定。
 *
 * 三个刻意的设计：
 *   1) 主题与壁纸「通过 localStorage 播种设置」驱动，而不是从外部直接改 CSS
 *      变量 —— 这样走的是真实路径：设置 → applyTheme → 变量 → 壁纸图层，
 *      中间任何一环断了，截图和探针都会立刻不对。
 *   2) 每张图开拍前把本地存储清空再播种。不这样做的话，上一张设的壁纸和主题
 *      会顺着同一个浏览器 profile 漏到后面每一张（头一次就踩了这个坑：
 *      只有 07 开了壁纸，结果 09 到 19 全带着壁纸）。
 *   3) 季度用深链钉住，不看「今天是几月」。否则跨季度那天跑一次，卡片会全变，
 *      而截图里的探针断言还是照着老数据写的。
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUT_DIR = path.join(ROOT, 'screenshots');
const PROFILE = path.join(os.tmpdir(), 'jikai-shots');
const DEMO_WALLPAPER = path.join(ROOT, 'build', 'demo', 'wallpaper-night.png');

const STATE_KEY = 'jikai/state/v1';
const WALLPAPER_KEY = 'jikai/wallpaper/v1';

/** 本机代理：探测到就给无头浏览器也挂上，封面图才拉得下来 */
async function detectProxyArg() {
  try {
    const { detectProxy } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'proxyfetch.mjs')).href);
    const p = await detectProxy();
    return p ? `http://${p.host}:${p.port}` : null;
  } catch {
    return null;
  }
}

/** 壁纸一组通用参数；各张图按需要覆盖其中几项 */
const WALL = { opacity: 0.72, blur: 5, brightness: 0.92, scale: 1.06, position: 'center', dim: 0.3 };

const SHOTS = [
  { name: '01-season', hash: 'season' },
  { name: '02-schedule', hash: 'schedule' },
  { name: '03-following', hash: 'following' },
  { name: '04-catchup', hash: 'catchup' },
  { name: '05-detail', hash: 'following', action: 'openDetail' },
  { name: '06-syncing', hash: 'season', action: 'sync' },

  // 壁纸 + 卡片半透明：验证「壁纸能透出来」这条链路
  {
    name: '07-wallpaper',
    hash: 'following',
    seed: { panelAlpha: 0.52, wallpaper: { enabled: true, name: '示例壁纸', ...WALL } },
    wallpaperAsset: true,
  },
  {
    name: '08-wallpaper-blur',
    hash: 'schedule',
    seed: { panelAlpha: 0.62, wallpaper: { enabled: true, name: '示例壁纸', ...WALL, blur: 22, dim: 0.15 } },
    wallpaperAsset: true,
  },

  // 设置面板的五个页签
  { name: '09-settings-look', hash: 'season', action: 'openSettings' },
  // 数据源这张特意选中「补全」源：只有选中的是需要联网的源，那条「先开 VPN」提示才该出现
  {
    name: '10-settings-data',
    hash: 'season',
    action: 'openSettings',
    tab: '数据源',
    seed: { dataSource: 'bangumi-api' },
    expectHintbar: true,
  },
  { name: '11-settings-layout', hash: 'season', action: 'openSettings', tab: '布局' },
  { name: '12-settings-remind', hash: 'season', action: 'openSettings', tab: '提醒' },
  { name: '13-settings-system', hash: 'season', action: 'openSettings', tab: '系统' },
  { name: '14-shortcuts', hash: 'season', action: 'help' },

  // 几套主题各来一张（浅色 / 和风 / 机甲 / 赛博），确认配色换得动
  { name: '15-theme-notion', hash: 'season', seed: { theme: 'notion' } },
  {
    name: '16-theme-sakura',
    hash: 'following',
    seed: { theme: 'sakura', panelAlpha: 0.7, wallpaper: { enabled: true, name: '示例壁纸', ...WALL, opacity: 0.5, dim: 0.1 } },
    wallpaperAsset: true,
  },
  { name: '17-theme-mecha', hash: 'schedule', seed: { theme: 'mecha' } },
  { name: '18-theme-cyber', hash: 'catchup', seed: { theme: 'cyber' } },

  // 窄窗口：卡片窗口应改成纵向堆叠
  { name: '19-narrow', hash: 'schedule', w: 1024, h: 700 },

  // 预设改名：确认切成了行内输入框，而不是那个在 Electron 里一调用就抛异常的 window.prompt
  {
    name: '20-preset-rename',
    hash: 'season',
    action: 'openSettings',
    tab: '布局',
    then: ['makePreset', 'clickRename'],
    expectRenameInput: true,
  },
];

const VIEW = { w: 1440, h: 900 };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

/**
 * 浏览器位置不写死用户目录：优先读环境变量，其次按 Windows 的公共环境变量拼装，
 * 这样仓库里不会残留任何本机用户名或绝对路径。
 */
function browserCandidates() {
  const env = process.env;
  const list = [];
  const push = (p) => { if (p) list.push(p); };

  push(env.PUPPETEER_EXECUTABLE_PATH);
  push(env.CHROME_PATH);

  const rel = [
    'Google/Chrome/Application/chrome.exe',
    'Microsoft/Edge/Application/msedge.exe',
  ];
  const bases = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
  for (const base of bases) {
    for (const r of rel) push(path.join(base, r));
  }

  // 非 Windows（macOS / Linux）上的常见位置，便于跨平台跑
  push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  push('/usr/bin/google-chrome');
  push('/usr/bin/chromium');

  return list;
}

function findBrowser() {
  const hit = browserCandidates().find((p) => {
    try { return fs.existsSync(p); } catch { return false; }
  });
  if (!hit) {
    throw new Error(
      '没找到可用的 Chrome 或 Edge。请安装其一，或用 PUPPETEER_EXECUTABLE_PATH 指定浏览器路径后重试。',
    );
  }
  return hit;
}

/** 只服务 dist 目录的静态服务器：file:// 在无头环境里不可靠 */
function serveDist() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/+/, '');
    const file = path.join(DIST, rel || 'index.html');
    if (!file.startsWith(DIST)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/**
 * 页面内动作。只负责「点到」，成没成由后面的探针判定 ——
 * 在同一个 evaluate 里立刻查 DOM 是查不到的，React 还没重渲染。
 */
const ACTIONS = {
  openDetail: () => {
    const btn = [...document.querySelectorAll('.queue__ops .btn')]
      .find((b) => b.textContent.trim() === '详情');
    if (btn) { btn.click(); return 'ok'; }
    return '找不到「详情」按钮';
  },
  sync: () => {
    const btn = [...document.querySelectorAll('.topbar .btn')]
      .find((b) => /同步数据|同步中/.test(b.textContent));
    if (btn) { btn.click(); return 'ok'; }
    return '找不到同步按钮';
  },
  openSettings: () => {
    const entry = document.querySelector('.sidenav__item--foot');
    if (!entry) return '侧栏没有设置入口';
    entry.click();
    return 'ok';
  },
  pickTab: (label) => {
    const btn = [...document.querySelectorAll('.tabs__btn')].find((b) => b.textContent.trim() === label);
    if (!btn) return `设置面板里没有「${label}」页签`;
    btn.click();
    return 'ok';
  },
  help: () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
    return 'ok';
  },
  /**
   * 造一个自定义预设，好让「改名」按钮出现（内置的四套不给改名）。
   * React 受控输入不能直接赋 value，得走原生 setter 再派发 input 事件，
   * 否则 React 的内部值不变，点保存时会被当成空字符串。
   */
  makePreset: () => {
    const input = [...document.querySelectorAll('.sact .input')]
      .find((i) => /起个名字/.test(i.placeholder || ''));
    if (!input) return '找不到预设命名输入框';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '截图用布局');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const save = [...document.querySelectorAll('.sact .btn')]
      .find((b) => b.textContent.trim() === '保存当前布局');
    if (!save) return '找不到「保存当前布局」按钮';
    save.click();
    return 'ok';
  },
  clickRename: () => {
    const btn = [...document.querySelectorAll('.preset .btn')]
      .find((b) => b.textContent.trim() === '改名');
    if (!btn) return '没有可改名的自定义预设';
    btn.click();
    return 'ok';
  },
};

/** 页面内探针：把「光看图看不出来」的东西变成可断言的数字 */
const PROBE = () => {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const wp = document.querySelector('.wallpaper');
  const canvas = document.querySelector('.canvas');
  const bar = document.querySelector('.progressbar');
  const wpCs = wp ? getComputedStyle(wp) : null;

  // 借一个临时元素把 --bg / --accent 解成真实 RGB，比直接断言字符串可靠
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;width:0;height:0;background:var(--bg);color:var(--accent)';
  root.appendChild(probe);
  const pcs = getComputedStyle(probe);
  const bg = pcs.backgroundColor;
  const accent = pcs.color;
  probe.remove();

  return {
    theme: root.dataset.theme ?? null,
    scheme: root.dataset.scheme ?? null,
    bg,
    accent,
    panelAlpha: cs.getPropertyValue('--panel-alpha').trim(),
    wpOpacity: wpCs ? wpCs.opacity : null,
    wpFilter: wpCs ? wpCs.filter : null,
    wpTransform: wpCs ? wpCs.transform : null,
    wpVisible: wpCs ? Number(wpCs.opacity) > 0.01 : false,
    progressVisible: Boolean(bar && !bar.classList.contains('progressbar--hidden')),
    windows: document.querySelectorAll('.window').length,
    cards: document.querySelectorAll('.card').length,
    // 封面是不是真的解码出来了。用自然宽度判断 —— complete 对加载失败的图也是 true，
    // 只有 naturalWidth > 0 才能说明像素到位了。
    coversLoaded: [...document.querySelectorAll('.card__cover img')].filter((i) => i.naturalWidth > 0).length,
    coversTotal: document.querySelectorAll('.card__cover img').length,
    banner: Boolean(document.querySelector('.banner')),
    // 数据源里那条「先开 VPN」提示（选中需要代理的源时才该出现）
    hintbar: Boolean(document.querySelector('.hintbar')),
    // 预设改名是不是切成了行内输入框 —— 这替代了原来那个在 Electron 里会抛异常的 prompt
    renameInput: Boolean(document.querySelector('.input--rename')),
    panel: document.querySelector('.settings')
      ? 'settings'
      : document.querySelector('.modal')
        ? 'modal'
        : document.querySelector('.drawer__panel')
          ? 'drawer'
          : null,
    overflowX: canvas ? canvas.scrollWidth - canvas.clientWidth : -1,
  };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 等封面图落定（最多等 ms）。
 *
 * 不加这一步会截到「卡片建好了、图还没下完」的中间态 —— 看着像封面功能坏了，
 * 其实只是拍早了。82 部封面走代理要几秒，所以等的时间要放宽。
 * 等不到就照常截，封面会退成渐变占位，不影响其他断言。
 */
async function waitImages(page, ms = 12000) {
  try {
    await page.waitForFunction(
      () => [...document.querySelectorAll('.card__cover img')].every((i) => i.complete),
      { timeout: ms, polling: 250 },
    );
  } catch {
    /* 超时：照现状截 */
  }
}

function dataUrlOf(file) {
  const b = fs.readFileSync(file);
  return { dataUrl: `data:image/png;base64,${b.toString('base64')}`, bytes: b.length };
}

/** 从 matrix(a,b,c,d,e,f) 里取缩放倍数，用来证明 --wp-scale 真的落到像素上 */
function scaleOf(transform) {
  const m = /matrix\(([-\d.]+)/.exec(String(transform ?? ''));
  return m ? Number(m[1]) : null;
}

(async () => {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.error('找不到 dist/index.html，请先执行 npm run build。');
    process.exit(1);
  }

  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const hasWallpaperAsset = fs.existsSync(DEMO_WALLPAPER);
  if (!hasWallpaperAsset) {
    console.warn('提示：build/demo/wallpaper-night.png 不存在，壁纸相关截图会跳过。先跑 npm run assets。');
  }
  const wpAsset = hasWallpaperAsset ? { ...dataUrlOf(DEMO_WALLPAPER), name: '示例壁纸' } : null;

  const { server, port } = await serveDist();

  // 季度钉死：内置数据里选「包含今天」的那一季，没有就退到最新的一季。
  // 这样截图内容不随跑脚本的日期漂。
  const { BUILTIN_SEASONS } = await import(pathToFileURL(path.join(ROOT, 'src', 'data', 'builtin', 'index.js')).href);
  const { currentSeason } = await import(pathToFileURL(path.join(ROOT, 'src', 'data', 'bangumiData.js')).href);
  const today = currentSeason();
  const SEASON = BUILTIN_SEASONS.includes(today) ? today : BUILTIN_SEASONS[BUILTIN_SEASONS.length - 1];

  // 追番与补番从内置数据里长出来，不写死番剧名。
  // 追番必须挂在本轮截图的那一季上，否则界面上「追了 6 部、一部都看不见」。
  const { buildSampleUserState } = await import(pathToFileURL(path.join(ROOT, 'test', 'fixtures', 'sample-state.js')).href);
  const baseState = buildSampleUserState(SEASON);

  const proxy = await detectProxyArg();
  if (proxy) console.log(`封面图走本机代理：${proxy}`);
  else console.log('没探测到本机代理，封面会退成渐变占位（不影响其他截图）');
  console.log(`季度：${SEASON} · 追番 ${Object.keys(baseState.following).length} 部 · 补番 ${baseState.catchup.length} 张\n`);

  const browser = await puppeteer.launch({
    executablePath: findBrowser(),
    headless: true,
    userDataDir: PROFILE,
    defaultViewport: { width: VIEW.w, height: VIEW.h },
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--hide-scrollbars',
      '--force-color-profile=srgb',
      ...(proxy ? [`--proxy-server=${proxy}`] : []),
    ],
  });

  const results = [];

  for (const shot of SHOTS) {
    const name = shot.name;
    const w = shot.w ?? VIEW.w;
    const h = shot.h ?? VIEW.h;
    if (shot.wallpaperAsset && !wpAsset) {
      results.push({ name, skipped: true });
      continue;
    }

    const page = await browser.newPage();
    try {
      await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });

      // 清空本地存储再播种：不留上一张图的主题 / 壁纸。
      // settings 由各张图单独覆盖，追番与补番走同一份样例数据。
      await page.evaluateOnNewDocument((stateKey, wpKey, seed, wp, base) => {
        try {
          localStorage.removeItem(stateKey);
          localStorage.removeItem(wpKey);
          localStorage.setItem(
            stateKey,
            JSON.stringify({ ...base, settings: { ...(base.settings ?? {}), ...seed } }),
          );
          if (wp) localStorage.setItem(wpKey, JSON.stringify(wp));
        } catch (e) { /* 播种失败就用默认值，探针会看出来 */ }
      }, STATE_KEY, WALLPAPER_KEY, shot.seed ?? {}, shot.wallpaperAsset ? wpAsset : null, baseState);

      await page.goto(`http://127.0.0.1:${port}/#/${shot.hash}?q=${SEASON}`, { waitUntil: 'load' });
      await page.waitForSelector('.window', { timeout: 15000 });
      // 等卡片网格铺开、封面下载完、主题变量写入
      await sleep(900);
      await waitImages(page);

      if (shot.action === 'sync') {
        const done = await page.evaluate(ACTIONS.sync);
        if (done !== 'ok') throw new Error(done);
        // 演示数据的同步是「两段各 120ms」，趁进度条还在拍
        await sleep(170);
      } else if (shot.action === 'help') {
        await page.evaluate(ACTIONS.help);
        await sleep(450);
      } else if (shot.action === 'openSettings') {
        const done = await page.evaluate(ACTIONS.openSettings);
        if (done !== 'ok') throw new Error(done);
        await sleep(420);
        if (shot.tab) {
          const t = await page.evaluate(ACTIONS.pickTab, shot.tab);
          if (t !== 'ok') throw new Error(t);
          await sleep(600);
        }
        // 页签之后再补几步交互（比如先造一个自定义预设，再点「改名」）
        for (const step of shot.then ?? []) {
          const r = await page.evaluate(ACTIONS[step]);
          if (r !== 'ok') throw new Error(`${step} 失败：${r}`);
          await sleep(520);
        }
      } else if (shot.action) {
        const done = await page.evaluate(ACTIONS[shot.action]);
        if (done !== 'ok') throw new Error(done);
        await sleep(750);
      }

      const probe = await page.evaluate(PROBE);

      // 探针判定：这几件事坏了只靠看缩略图很难发现
      const problems = [];
      if (probe.overflowX > 2) problems.push(`画布横向溢出 ${probe.overflowX}px`);
      if (shot.wallpaperAsset && !probe.wpVisible) problems.push('壁纸图层没生效');
      if (!shot.wallpaperAsset && probe.wpVisible) problems.push('不该有壁纸却出现了壁纸（状态串了）');
      if (probe.theme !== (shot.seed?.theme ?? 'night')) problems.push(`主题不对：期望 ${shot.seed?.theme ?? 'night'}，实际 ${probe.theme}`);
      if (shot.seed?.panelAlpha != null && Math.abs(Number(probe.panelAlpha) - shot.seed.panelAlpha) > 0.001) {
        problems.push(`卡片不透明度不对：期望 ${shot.seed.panelAlpha}，实际 ${probe.panelAlpha}`);
      }
      if (shot.action === 'openSettings' && probe.panel !== 'settings') problems.push('设置面板没打开');
      if (shot.action === 'help' && probe.panel !== 'modal') problems.push('快捷键浮层没打开');
      if (shot.action === 'openDetail' && probe.panel !== 'drawer') problems.push('详情抽屉没打开');
      if (shot.action === 'sync' && !probe.progressVisible) problems.push('同步时进度条没出现');
      if (shot.expectHintbar && !probe.hintbar) problems.push('「先开 VPN」提示条没有出现');
      if (shot.expectRenameInput && !probe.renameInput) problems.push('预设改名没切成行内输入框');
      if (!shot.expectHintbar && name === '10-settings-data') problems.push('数据源页没选到需要代理的源');
      if (probe.windows === 0) problems.push('一个卡片窗口都没有');
      if (name === '01-season' && probe.cards < 10) problems.push(`番剧卡片只有 ${probe.cards} 张`);

      const file = path.join(OUT_DIR, `${name}.png`);
      await page.screenshot({ path: file, type: 'png' });

      const size = fs.statSync(file).size;
      results.push({ name, size, probe, problems, blank: size < 9000 });
    } catch (err) {
      results.push({ name, error: err.message });
    } finally {
      await page.close();
    }
  }

  await browser.close();
  server.close();

  console.log('\n截图结果：');
  for (const r of results) {
    if (r.skipped) { console.log(`  ${r.name}: 跳过（缺示例壁纸）`); continue; }
    if (r.error) { console.log(`  ${r.name}: 失败 - ${r.error}`); continue; }
    const p = r.probe;
    const scale = scaleOf(p.wpTransform);
    const bits = [
      `${(r.size / 1024).toFixed(0)} KB`,
      `${p.theme}/${p.scheme}`,
      `底 ${p.bg}`,
      `强调 ${p.accent}`,
      `卡片α ${p.panelAlpha}`,
      `窗 ${p.windows}`,
      p.cards ? `番剧卡 ${p.cards}` : null,
      p.coversTotal ? `封面已解码 ${p.coversLoaded}/${p.coversTotal}` : null,
      p.wpOpacity != null ? `壁纸 α${p.wpOpacity}${scale ? ` ×${scale}` : ''} 滤镜[${p.wpFilter}]` : null,
      p.panel ? `浮层 ${p.panel}` : null,
      p.hintbar ? 'VPN 提示条' : null,
      p.renameInput ? '行内改名框' : null,
      p.progressVisible ? '进度条可见' : null,
    ].filter(Boolean);
    console.log(`  ${r.name}: ${bits.join(' · ')}`);
    if (r.blank) console.log('    [注意] 文件小于阈值，疑似空白');
    for (const pb of r.problems) console.log(`    x ${pb}`);
  }

  const bad = results.some((r) => r.error || r.blank || (r.problems ?? []).length);
  console.log(bad ? '\n有需要处理的问题。' : '\n全部通过。');
  process.exit(bad ? 1 : 0);
})().catch((err) => {
  console.error('截图失败：', err.message);
  process.exit(1);
});
