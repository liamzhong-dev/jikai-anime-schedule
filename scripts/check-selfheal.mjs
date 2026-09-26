/**
 * 自愈链路真机验证（计划 G5）：主动把渲染进程打死，看它能不能自己降级重开。
 *
 * 为什么必须是「真的打死」而不是看代码：
 *   自愈这类代码平时永远不会被走到 —— 它只有在故障时才报销一次，
 *   而这唯一一次如果不灵，用户看到的就是一个白窗口。
 *   `releaseSingleInstanceLock` 少调用一次、`app.exit` 换成 `app.quit` 这种差别，
 *   不真跑一遍是看不出来的（这两处我都踩过）。
 *
 * ⚠️ 为什么用「脱钩起进程 + 轮询标记文件」，而不是「等子进程退出」：
 *   重开的那个进程是 `app.relaunch()` 起的，**不是我们的子进程**，
 *   父进程一退这条命令就结束了，根本等不到它。而且它的 stdout 也不继承回来，
 *   所以结果只能落在标记文件里，由外层轮询。这是唯一测得到的写法。
 *
 * 用法：`node scripts/check-selfheal.mjs`
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const root = process.cwd();
const exeName = process.platform === 'win32' ? 'electron.exe' : 'electron';
const electron = path.join(root, 'node_modules', 'electron', 'dist', exeName);
if (!fs.existsSync(electron)) {
  console.error('✗ 没找到 electron（node_modules/electron/dist/），先 npm i');
  process.exit(2);
}

const marker = path.join(os.tmpdir(), `jikai-selfheal-${process.pid}.txt`);
if (fs.existsSync(marker)) fs.rmSync(marker, { force: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const read = () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.JIKAI_CRASH_TEST = '1';
env.JIKAI_CRASH_MARKER = marker;

const logPath = path.join(root, 'test', '.tmp', 'selfheal-child.log');
fs.mkdirSync(path.dirname(logPath), { recursive: true });
const fd = fs.openSync(logPath, 'w');

const child = spawn(electron, ['.'], { cwd: root, env, detached: true, stdio: ['ignore', fd, fd] });
child.unref();

// 三个阶段：崩溃前的标记 / 新进程起来了 / 新进程把界面加载完了
const lines = () => read().split(/\r?\n/).filter(Boolean);

/**
 * ⚠️ 这里**必须按整行精确匹配**，不能用 `includes('relaunched')`。
 *
 * 踩过的坑：标记里有一行叫 `relaunched-process-started`（新进程刚加载完主脚本时写的），
 * 它**包含** `relaunched` 这个子串。用子串判「跑完了」会在新进程刚起步时提前跳出，
 * 紧接着那句「整行里有 relaunched 吗」又判否 —— 于是链路明明是通的，
 * 报告却每次都说「重开失败」。**假阴性比不测更坏：它会让人去改本来正确的代码。**
 * 我就是因为这个把好好的 `app.relaunch()` 换成了自己 spawn，绕了一大圈。
 */
const DONE = 'relaunched';

const deadline = Date.now() + 60000;
while (Date.now() < deadline) {
  if (lines().includes(DONE)) break;
  await wait(500);
}
const seen = lines();

const failures = [];
if (!seen.includes('crashing')) failures.push('渲染进程没有被打死（连第一步都没走）');
if (!seen.includes('relaunched-process-started')) failures.push('主进程没有把应用重新拉起来');
if (!seen.includes(DONE)) failures.push('重开起来的那个进程没能把页面加载完 —— 很可能降级之后仍然起不来');

/**
 * 数一下还剩几个 electron 进程。
 *
 * 这里**只警告、不自动杀**：本机跑着别的 Electron 应用（比如编辑器本身），
 * 一律按映像名杀掉会把不相干的进程也误伤。捡到数量异常时，人工清一次更稳妥。
 */
function countLeftoverElectron() {
  try {
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq electron.exe', '/NH'], { encoding: 'utf8' });
    return String(r.stdout || '').split(/\r?\n/).filter((l) => /electron\.exe/i.test(l)).length;
  } catch {
    return 0;
  }
}

try {
  fs.rmSync(marker, { force: true });
} catch { /* 临时文件 */ }

if (failures.length) {
  console.error('✗ 自愈链路验证失败：');
  for (const f of failures) console.error(`  · ${f}`);
  console.error(`  标记文件里只有：${JSON.stringify(seen)}`);
  process.exit(1);
}

console.log('✓ 自愈链路验证通过');
console.log('  渲染进程被打死 → 主进程释放单实例锁 → 带 --no-sandbox-retry 重开 → 页面加载完成');
console.log(`  标记齐全：${seen.length} 条（含 crashing / relaunched-process-started / relaunched）`);

const left = countLeftoverElectron();
if (left > 0) {
  console.log(`  ⚠️ 检测到 ${left} 个 electron 进程还在跑 —— 下次跑之前先清掉，否则会占着单实例锁导致莫名其妙的失败`);
}
