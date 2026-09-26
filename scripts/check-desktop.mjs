/**
 * 桌面壳真机验证（计划 G2）：起真的 Electron，让它自己截图 + 报数，然后**脚本自己断言**。
 *
 * 为什么必须有这一条，而不是只用无头 Chrome：
 *   无头 Chrome 验的是**浏览器壳**，而浏览器壳的封面走「直连远端」降级 ——
 *   它压根不查本地封面缓存那张表。v1.1 桌面端 82 张封面全退成色块那个 bug，
 *   在无头 Chrome 里一个都复现不出来（同一个 commit，浏览器里一切正常）。
 *   所以「桌面端到底对不对」只能由桌面端自己回答。
 *
 * 为什么断言要**打数字**而不是只看截图：
 *   截图里「有色块的界面」和「图还没加载完」长得一模一样，区分不了。
 *   能区分「是缓存还是直连」「是没取到还是本来没有」的只有计数。
 *   那次就是靠 `cached: 0` + `coverBytes: 13074393` 这一对数字把 bug 逼出来的。
 *
 * 用法：`node scripts/check-desktop.mjs [--view=tier] [--wait=6000] [--season=2026q3]`
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const dist = path.join(root, 'dist');
const arg = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? '').split('=')[1] || fallback;

const view = arg('view', 'tier');
const wait = arg('wait', '6000');
const season = arg('season', '');

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

const shot = path.join(root, 'test', '.tmp', `desktop-${view}.png`);
fs.mkdirSync(path.dirname(shot), { recursive: true });

/**
 * ⚠️ 必须清掉 `ELECTRON_RUN_AS_NODE`：本机 agent shell 里预置了它，
 * 有这个变量时 electron.exe 会退化成纯 Node，`require('electron')` 拿到的
 * `app` / `ipcMain` 全是 undefined，报的错指向代码（「Cannot read properties of
 * undefined」），**完全看不出是环境问题**。用户双击桌面图标不受影响。
 */
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.JIKAI_SMOKE = shot;
env.JIKAI_SMOKE_VIEW = view;
env.JIKAI_SMOKE_WAIT = wait;
if (season) env.JIKAI_SMOKE_SEASON = season;

const output = await new Promise((resolve, reject) => {
  const child = spawn(electron, ['.'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { err += d.toString(); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
  child.on('close', () => { clearTimeout(timer); resolve({ out, err }); });
  child.on('error', reject);
});

const line = output.out.split(/\r?\n/).find((l) => l.trim().startsWith('SMOKE_OK'));
if (!line) {
  console.error('✗ 桌面壳没有打出 SMOKE_OK（窗口没起来、还是渲染进程被杀了）');
  const tail = (output.out + output.err).split(/\r?\n/).filter(Boolean).slice(-15);
  for (const l of tail) console.error(`  ${l.slice(0, 200)}`);
  process.exit(1);
}

let report;
try {
  report = JSON.parse(line.slice(line.indexOf('{')));
} catch {
  console.error(`✗ SMOKE_OK 后面不是合法 JSON：${line.slice(0, 200)}`);
  process.exit(1);
}

const failures = [];
const warnings = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };

// ---- 界面真的画出来了 ----
check(report.view === view, `视图不对：期望 ${view}，实际 ${report.view}`);
check(Number(report.rows) === 7, `档位应有 7 行，实际 ${report.rows}`);
check(Number(report.pool) > 0, `素材池应有图块，实际 ${report.pool}`);

// ---- 封面到底走的哪条路（这一组就是那次 bug 的守门员）----
check(Number(report.cached) > 0, `桌面壳一张缓存封面都没显示（cached=${report.cached}）—— 多半是封面表的键又对不上了`);
check(
  Number(report.remote) === 0,
  `桌面壳绝不能直连远端封面（remote=${report.remote}）—— 那样浏览器会先下一遍 45MB，主进程再下一遍`,
);
check(Number(report.coverBytes) > 0, `封面缓存目录是空的（coverBytes=${report.coverBytes}）`);
if (Number(report.cached) < Number(report.pool)) {
  warnings.push(`还有 ${Number(report.pool) - Number(report.cached)} 个图块没封面（可能是这一季本来就没有，或缓存还没下完）`);
}

// ---- 内置数据在（离线开箱可用的前提）----
check(report.library === 'yes', `内置作品库没加载（library=${report.library}），离线就开不了箱了`);

// ---- 截图不是空白 ----
const shotOk = fs.existsSync(shot) && fs.statSync(shot).size > 12 * 1024;
check(shotOk, `截图没生成或疑似空白（小于 12KB）：${shot}`);

if (failures.length) {
  console.error('✗ 桌面壳验证失败：');
  for (const f of failures) console.error(`  · ${f}`);
  for (const w of warnings) console.error(`  ! ${w}`);
  console.error(`  原始报告：${JSON.stringify(report)}`);
  process.exit(1);
}

console.log('✓ 桌面壳验证通过');
console.log(`  Electron：${electron}`);
console.log(`  视图 ${report.view} · 档位 ${report.rows} 行 · 素材池 ${report.pool} 个`);
console.log(`  封面：缓存 ${report.cached} · 直连 ${report.remote}（必须为 0）· 已存 ${(Number(report.coverBytes) / 1048576).toFixed(1)} MB`);
console.log(`  截图：${path.relative(root, shot)}（${(fs.statSync(shot).size / 1024).toFixed(0)} KB）`);
for (const w of warnings) console.log(`  ! ${w}`);
