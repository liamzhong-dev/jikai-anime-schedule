/**
 * 界面流畅度实测（帧间隔 + 长任务）。
 *
 * 「卡」是感觉，没法直接断言，但可以量：主线程一忙，`requestAnimationFrame`
 * 的间隔就被撑开。所以主进程探针在三种典型操作期间采帧间隔（空闲 / 滚动番剧库 /
 * 连续输入搜索词），并记录长任务（>50ms）的条数与总时长。
 *
 * 探针还会把 `backdrop-filter` 全关掉，把同一组场景再跑一遍。**这组对照是这个脚本
 * 存在的主要理由** —— 毛玻璃（尤其好几层叠在一起）值不值这些帧，读代码读不出来，
 * 只有同一台机器上前后各量一次才答得了。优化前后也拿这组数字对比。
 *
 * 用法：
 *   node scripts/perf-check.mjs              # 跑一轮，打表
 *   node scripts/perf-check.mjs --json       # 只吐 JSON（给对比用）
 *
 * ⚠️ 存档目录**不清**（跟 check-desktop.mjs 相反）：这里要的是可比性，
 * 而封面缓存热不热会直接改变帧数。第一次跑会把 2026q3 那一季的封面下下来，
 * 之后每次都读缓存，几轮之间的数字才可比。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const dist = path.join(root, 'dist');
const jsonOnly = process.argv.includes('--json');
const arg = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? '').split('=')[1] || fallback;

const view = arg('view', 'season');
const season = arg('season', '2026q3');
const wait = arg('wait', '14000');

if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('✗ 没有 dist/，先跑一次 npm run build');
  process.exit(2);
}

const exeName = process.platform === 'win32' ? 'electron.exe' : 'electron';
const electron = path.join(root, 'node_modules', 'electron', 'dist', exeName);
if (!fs.existsSync(electron)) {
  console.error('✗ 没找到 electron（node_modules/electron/dist/），先 npm i');
  process.exit(2);
}

const profileDir = path.resolve(arg('profile', 'test/.tmp/profile-perf'));
const shot = path.join(root, 'test', '.tmp', `perf-${view}.png`);
fs.mkdirSync(path.dirname(shot), { recursive: true });
fs.mkdirSync(profileDir, { recursive: true });

/*
 * 只清 state.json，**不删整个目录** —— 封面缓存要留着。
 * （顺带也绕开了「一次删超过 50 个文件要人工确认」那个限制，
 *   Electron 的 userData 里光 Cache/GPUCache 就六七十个文件。）
 */
try { fs.rmSync(path.join(profileDir, 'state.json'), { force: true }); } catch { /* 本来就没有 */ }

const env = { ...process.env };
// 本机 agent shell 预置了它，有它 electron.exe 会退化成纯 Node
delete env.ELECTRON_RUN_AS_NODE;
env.JIKAI_SMOKE = shot;
env.JIKAI_SMOKE_VIEW = view;
env.JIKAI_SMOKE_SEASON = season;
env.JIKAI_SMOKE_WAIT = wait;
env.JIKAI_PERF = '1';
env.JIKAI_USERDATA = profileDir;

const output = await new Promise((resolve, reject) => {
  const child = spawn(electron, ['.'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { err += d.toString(); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
  child.on('close', () => { clearTimeout(timer); resolve({ out, err }); });
  child.on('error', reject);
});

const line = output.out.split(/\r?\n/).find((l) => l.trim().startsWith('SMOKE_OK'));
if (!line) {
  console.error('✗ 桌面壳没有打出 SMOKE_OK');
  for (const l of (output.out + output.err).split(/\r?\n/).filter(Boolean).slice(-15)) {
    console.error(`  ${l.slice(0, 200)}`);
  }
  process.exit(1);
}

let report;
try {
  report = JSON.parse(line.slice(line.indexOf('{')));
} catch {
  console.error(`✗ SMOKE_OK 后面不是合法 JSON：${line.slice(0, 200)}`);
  process.exit(1);
}

const perf = report.perf;
if (!perf) {
  console.error('✗ 探针没带回 perf —— JIKAI_PERF 没传到主进程？');
  process.exit(1);
}

if (jsonOnly) {
  console.log(JSON.stringify(perf));
  process.exit(0);
}

/** 帧间隔换算成「大概多少 fps」，比毫秒直观 */
const fps = (ms) => (ms > 0 ? Math.round(1000 / ms) : 0);

const SCENARIO = { idle: '空闲', scroll: '滚动番剧库', typing: '连续输入搜索词', drawer: '详情抽屉', hover: '鼠标扫过卡片' };
const VARIANT = {
  '': '原样',
  _frostOn: '强行开毛玻璃',
  _noBlur: '全关（理论上限）',
};

const ORDER = ['idle', 'scroll', 'typing', 'drawer', 'hover',
  'scroll_frostOn', 'typing_frostOn', 'drawer_frostOn',
  'scroll_noBlur', 'typing_noBlur', 'drawer_noBlur', 'hover_noBlur'];

/** 中文在等宽字体里占两格，padEnd 按字符数算会歪 —— 自己按显示宽度补 */
const width = (s) => [...String(s)].reduce((n, c) => n + (c.codePointAt(0) > 0x2e80 ? 2 : 1), 0);
const pad = (s, n, right = false) => {
  const fill = ' '.repeat(Math.max(0, n - width(s)));
  return right ? fill + s : s + fill;
};

const label = (key) => {
  for (const suf of ['_frostOn', '_noBlur']) {
    if (key.endsWith(suf)) return `${SCENARIO[key.slice(0, -suf.length)]} · ${VARIANT[suf]}`;
  }
  return SCENARIO[key] ?? key;
};

console.log('');
console.log(`界面流畅度实测 · 视图 ${view} (${season})`);
console.log(`DOM 节点 ${perf.nodes} · 卡片 ${perf.cards} · 封面 ${perf.covers} · 毛玻璃 data-frost=${perf.frost}`);
console.log('');
console.log(`${pad('场景', 26)}${pad('帧数', 7, true)}${pad('p50 帧间隔', 15, true)}${pad('p95', 9, true)}${pad('最长帧', 9, true)}${pad('长任务', 8, true)}${pad('长任务合计', 11, true)}`);
for (const k of ORDER) {
  const s = perf[k];
  if (!s) continue;
  console.log(
    pad(label(k), 26)
    + pad(String(s.frames), 7, true)
    + pad(`${s.p50}ms ${fps(s.p50)}fps`, 15, true)
    + pad(`${s.p95}ms`, 9, true)
    + pad(`${s.max}ms`, 9, true)
    + pad(String(s.longTasks), 8, true)
    + pad(String(s.longSum), 11, true),
  );
}
console.log('');
console.log('（p50 是中位帧间隔 —— 60fps 对应 16.7ms。p95 是最差那 5% 的帧。');
console.log('  长任务 = 单次占用主线程超过 50ms，它一多，交互就顿。）');

/*
 * ---------- 断言 ----------
 *
 * 只断言**结构性**的东西，不断言绝对毫秒数 —— 这台机器上跑出来的 ms
 * 换个环境就不成立，那种红会教人忽略这个脚本（项目里已经有过一次教训）。
 * 真正卡住回归靠的是「优化前 / 优化后」两组数字的人工对比，
 * 而这个脚本负责把数字稳定地打出来。
 */
const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };

check(perf.nodes > 200, `DOM 节点只有 ${perf.nodes} 个 —— 界面多半没画出来，这轮的帧数据不可信`);
check(perf.cards > 0, `一张番剧卡片都没有（${perf.cards}）—— 探针没落到番剧库视图上，帧数据不可信`);
check(Number(perf.idle?.frames) > 5, `空闲场景只采到 ${perf.idle?.frames} 帧，采样太短，结论不成立`);

/*
 * 毛玻璃开关接没接上 —— 这条是**结构性**的，不随机器快慢变，所以敢断言。
 * 一次性档案里没有壁纸、面板也不透明，按 `wantsFrost()` 就该是 off。
 * 哪天有人把「面板不透明也做毛玻璃」改回来，这里会立刻红 ——
 * 而那正是把滚动从 60fps 打到 13fps 的那个改动。
 */
check(perf.frost === 'off', `期望 data-frost=off（无壁纸 + 面板不透明），实际 ${perf.frost} —— 不可见的毛玻璃又被打开了？`);

/*
 * hover 这一组必须量到了东西。
 *
 * ⚠️ 这是最容易变成「空气断言」的一组：扫动是由主进程发真实鼠标事件驱动的，
 * 只要窗口位置、网格位置、坐标系有一处没对上，鼠标就一直在空白处划 ——
 * 帧数据照样很漂亮（因为什么都没干），而结论完全是假的。
 * `hovered` 是渲染层数的「这次扫动换过几次卡片命中」，它才是这一组的前提。
 */
if (perf.hover) {
  check(
    Number(perf.hover.hovered) > 0,
    `鼠标扫过卡片的那一组，一次卡片命中都没有（hovered=0）—— 鼠标划在空白处，这组数字不能说明任何事`,
  );
  check(
    Number(perf.hover.frames) > 10,
    `hover 场景只采到 ${perf.hover.frames} 帧，采样太短`,
  );
} else {
  check(false, '没量到 hover 场景 —— 探针没落回网格上，或者主进程那段扫动没跑起来');
}

if (failures.length) {
  console.error('');
  for (const f of failures) console.error(`✗ ${f}`);
  process.exit(1);
}

console.log('');
console.log('✓ 性能采样完成（数字见上表；优化前后请自行对比，不做绝对阈值断言）');
