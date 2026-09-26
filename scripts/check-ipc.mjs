/**
 * 桌面端主进程 IPC 冒烟（计划 G3）：挨个真调一遍 `ipcMain.handle` 注册过的 handler。
 *
 * 为什么要单独立一项 —— 因为「桌面专属代码从来没被执行过」这件事本身才是最危险的缝：
 * v1.1 主打功能是「导出 PNG」，而 `file:save-binary`（弹保存框 + 主进程写盘）
 * 在桌面端**一次都没跑过**；`state:write`（用户所有数据落盘的唯一出口）同理。
 * 浏览器壳碰不到这些 handler，所以浏览器里全绿跟它们没关系。
 *
 * 为什么必须是「能失败的脚本」而不是打印给人看：
 * 打印出来的数字要靠人每天用眼睛看，第二天就没人看了。这里解析 good/bad 并给 exit code，
 * 才能真正防止「桌面专属路径再次悄悄烂掉」。
 *
 * 用法：`node scripts/check-ipc.mjs`（包一层是为了跨平台传环境变量 —— Windows 的 npm script
 * 里写不了 `FOO=bar`，而引入 cross-env 只为一个变量不值当）。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

const exeName = process.platform === 'win32' ? 'electron.exe' : 'electron';
const electron = path.join(root, 'node_modules', 'electron', 'dist', exeName);
if (!fs.existsSync(electron)) {
  console.error('✗ 没找到 electron（node_modules/electron/dist/），先 npm i');
  process.exit(2);
}

/**
 * ⚠️ 必须清掉 `ELECTRON_RUN_AS_NODE`：本机 agent shell 里预置了它，
 * 有这个变量时 electron.exe 会退化成纯 Node，`require('electron')` 全是 undefined。
 */
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.JIKAI_IPC_SMOKE = '1';

const res = await new Promise((resolve, reject) => {
  const child = spawn(electron, ['.'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { err += d.toString(); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
  child.on('close', (code) => { clearTimeout(timer); resolve({ out, err, code }); });
  child.on('error', reject);
});

const lines = res.out.split(/\r?\n/);
const passes = lines.filter((l) => l.startsWith('PASS '));
const fails = lines.filter((l) => l.startsWith('FAIL '));
const end = lines.find((l) => l.startsWith('IPC_SMOKE_END'));

if (!end) {
  console.error('✗ 主进程没打出 IPC_SMOKE_END —— handler 注册或冒烟本身挂了');
  const tail = (res.out + res.err).split(/\r?\n/).filter(Boolean).slice(-20);
  for (const l of tail) console.error(`  ${l.slice(0, 220)}`);
  process.exit(1);
}

for (const l of passes) console.log(`  ${l}`);
for (const l of fails) console.error(`  ${l}`);

let summary = {};
try {
  summary = JSON.parse(end.slice(end.indexOf('{')));
} catch {
  console.error(`✗ IPC_SMOKE_END 后面不是合法 JSON：${end.slice(0, 200)}`);
  process.exit(1);
}

// 自己数一遍，不信主进程报的数 —— 两边对不上说明「统计」和「打印」不一致，本身就是 bug
const miscounted = summary.total !== passes.length + fails.length || summary.failed !== fails.length;

if (fails.length || miscounted) {
  console.error(`\n✗ IPC 冒烟失败：${fails.length} 条`);
  if (miscounted) {
    console.error(`  · 汇总数字对不上（报的 ${summary.total}/${summary.failed}，实际数到 ${passes.length + fails.length}/${fails.length}）`);
  }
  process.exit(1);
}

console.log('✓ IPC 冒烟通过');
console.log(`  ${passes.length} 项 · 覆盖的主进程通道全部真跑一遍（包括写盘的 file:save-binary 与 state:write）`);
