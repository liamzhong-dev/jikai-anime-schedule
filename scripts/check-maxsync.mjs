/**
 * 「全屏的卡片要不要跟着布局预设走」—— 真桌面壳里跑一遍（计划 G4 / 用户报的第二个现象）。
 *
 * 现象：某张卡点了全屏，再去「布局预设」里套一套模板，别的卡都排好了，
 * 就那张全屏的一动没动。
 *
 * 为什么必须真跑：修复改的是 useEffect 的时序 —— 外部摆位变了要顺手退出全屏。
 * SSR 读到的永远是初始态，单元测试里也没有真的 React 运行时，
 * 两边都只能证明「代码写好了」，证明不了「界面真的动了」。
 *
 * 怎么验的：
 *   1. 播种一份 userData，把 season-grid 的摆位摆成一个明显跟预设不同的矩形
 *      （否则换成同一套预设时值没变，effect 不触发，断言会假绿 —— 这一步是前提）
 *   2. 真起一份 Electron，让它自己去点最大化
 *   3. 让它打开设置、切到布局页、套用另一套预设 —— 就是用户报的那几步
 *   4. 回来读那张卡的 data-maxed 与实际几何
 *
 * 用法：node scripts/check-maxsync.mjs [--no-kill]
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { presetById } from '../src/core/layoutPresets.js';
import { closeRunningApp } from './lib/killapp.mjs';

const root = process.cwd();
const dist = path.join(root, 'dist');
const profileDir = path.join(root, 'test', '.tmp', 'profile-maxsync');
const shot = path.join(root, 'test', '.tmp', 'desktop-maxsync.png');

const CARD = 'season-grid';
const PRESET = 'builtin-focus';

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
}
function ok(msg) {
  console.log(`  ✓ ${msg}`);
}

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

const target = presetById(PRESET);
if (!target) {
  console.error(`✗ 找不到预设 ${PRESET}`);
  process.exit(2);
}
const want = target.layout[CARD];

/*
 * 播种一个**跟目标预设明显不同**的矩形：
 * 摆位一模一样的话，套用预设时 saved 的值没变 → effect 不触发 → 全屏不会被拉下来，
 * 而断言却会绿。这种「因为前提没成立而通过」的测试比不测更坏。
 */
const SEEDED = { x: 220, y: 180, w: 720, h: 430 };
if (want.x === SEEDED.x && want.y === SEEDED.y && want.w === SEEDED.w && want.h === SEEDED.h) {
  console.error('✗ 播种的矩形和目标预设一样了，这条自检会假绿 —— 换一组数字');
  process.exit(2);
}

fs.mkdirSync(profileDir, { recursive: true });
fs.writeFileSync(path.join(profileDir, 'state.json'), JSON.stringify({ layout: { [CARD]: SEEDED } }));
fs.mkdirSync(path.dirname(shot), { recursive: true });

const env = { ...process.env };
// ⚠️ 环境里预置了 ELECTRON_RUN_AS_NODE，electron.exe 就退化成纯 Node —— app / ipcMain 全 undefined
delete env.ELECTRON_RUN_AS_NODE;
env.JIKAI_USERDATA = profileDir;
env.JIKAI_SMOKE = shot;
env.JIKAI_SMOKE_VIEW = 'season';
env.JIKAI_SMOKE_WAIT = '7000';
env.JIKAI_SMOKE_MAXSYNC = '1';
env.JIKAI_SMOKE_MAXSYNC_CARD = CARD;
env.JIKAI_SMOKE_MAXSYNC_PRESET = PRESET;

function run() {
  return new Promise((resolve, reject) => {
    const child = spawn(electron, ['.'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 150000);
    child.on('close', () => { clearTimeout(timer); resolve({ out, err }); });
    child.on('error', reject);
  });
}

console.log('起真桌面壳（季节视图）…');
let output = await run();

// 被本项目自己的窗口占着锁时关掉它再来一次（跟 check-desktop 同一套规矩）
if (!/SMOKE_MAXSYNC /.test(output.out) && /已有实例在运行/.test(output.out + output.err)) {
  if (process.argv.includes('--no-kill')) {
    console.warn('! 已有一份本项目在运行，--no-kill 让它留在那儿');
  } else {
    const r = await closeRunningApp(root);
    if (r.killed) {
      console.log(`  已关掉占着的那份（pid ${r.pid}），重跑一次`);
      output = await run();
    } else {
      console.warn(`! 占锁的那个进程没能自动关掉（${r.reason}），这次自检起不来`);
    }
  }
}

const line = output.out.split(/\r?\n/).find((l) => l.trim().startsWith('SMOKE_MAXSYNC '));
if (!line) {
  console.error('✗ 主进程没打出 SMOKE_MAXSYNC —— 探针没跑到，下面这些数字一个都不能信');
  console.error(output.err ? `stderr: ${output.err.slice(0, 600)}` : `stdout: ${output.out.slice(0, 600)}`);
  process.exit(1);
}

const r = JSON.parse(line.trim().slice('SMOKE_MAXSYNC '.length));
console.log(`\n读到：${JSON.stringify(r)}`);

console.log('\n断言：');

// 前提：卡真的在，且一开始不是全屏（否则后面几步验的是别的东西）
if (!r.before?.found) fail(`找不到 [data-window-id="${CARD}"] —— 视图没停在季番页（${JSON.stringify(r.before)}）`);
else if (r.before.maxed !== '0') fail(`一开始就不该是全屏（maxed=${r.before.maxed}）`);
else ok(`起点：${r.before.w}x${r.before.h} @ (${r.before.left},${r.before.top})，不是全屏`);

if (r.maxed !== 1) {
  fail('最大化按钮没点到（title 改名了？）—— 后面几条断言失去意义');
} else if (r.afterMax?.maxed !== '1') {
  fail(`点了最大化，data-maxed 还是 ${r.afterMax?.maxed}`);
} else if (r.opened !== 1 || r.tabbed !== 1 || r.applied !== 1) {
  fail(`套用预设那几步没走完（开面板=${r.opened} 切布局页=${r.tabbed} 套用=${r.applied}）`);
} else {
  ok(`放大后是全屏态（maxed=1，${r.afterMax.w}x${r.afterMax.h}）`);

  const a = r.afterPreset ?? {};
  if (a.maxed !== '0') fail(`套了布局预设之后，它还是全屏态（maxed=${a.maxed}）—— 正是用户报的那个现象`);
  else ok('套完预设后退出全屏 —— 修复生效');

  const got = `${a.left},${a.top} ${a.w}x${a.h}`;
  const expect = `${want.x},${want.y} ${want.w}x${want.h}`;
  if (got !== expect) fail(`摆位没跟上预设：现在是 ${got}，预设里是 ${expect}`);
  else ok(`摆位跟上了预设：${got}`);
}

if (process.exitCode) {
  console.error(`\n✗ 没过。截图在 ${shot}`);
} else {
  console.log(`\n✓ 通过（截图 ${shot}）`);
}
