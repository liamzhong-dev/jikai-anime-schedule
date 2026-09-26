/**
 * 「自检撞上自己开着的程序」这条链的自检。
 *
 * 为什么值得单独验：这段代码**没有别的办法验**。
 *   · 真起点一份 Electron 让它占着锁？本机 sandbox 里那份程序活不过几秒
 *     （GPU 起不来，`boot.json` 停在 degrade 状态），根本撑不到自检来撞它；
 *   · 反过来「假装锁被占」也不行 —— 那个分支在 Electron 里，脚本够不着。
 * 所以把它拆成一个不依赖 Electron 的机制：**谁占着，自己往 userData 里留个 pid**，
 * 关的时候按那个 pid 关。这里拿一个我们自己起的、完全可控的子进程当靶子，
 * 把「读 pid → 确认还活着 → 关掉 → 清掉标记」整条走一遍。
 *
 * ⚠️ 凡是「关掉别人的进程」的代码都值得配一条自检 ——
 * 它错的方式不是报错，是**杀掉不该杀的东西**，而那种错在别的地方看不出来。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { PID_FILE, closeRunningApp, defaultUserData } from './lib/killapp.mjs';

const root = process.cwd();
const tmp = path.join(root, 'test', '.tmp', 'killapp-profile');

/**
 * 收尾清理**一律不能抛**。
 *
 * 自检的价值在「被测功能到底行不行」，而清理失败报出来的是「脚本自己删不掉目录」，
 * 跟被测功能毫无关系 —— 那种红只会教人忽略这个脚本（这类教训项目里已经有过一次）。
 * 某些沙盒环境对「一轮里累计删了多少文件」有总量上限，跑到后半程必然撞上，
 * 那时候唯一正确的做法是**把结论留下、把垃圾留着**。
 */
function cleanup(target, opts = {}) {
  try {
    fs.rmSync(target, { force: true, ...opts });
  } catch (err) {
    console.warn(`! 没删干净（${target}）：${err?.code ?? err?.name ?? 'ERR'} —— 不影响结论`);
  }
}

cleanup(tmp, { recursive: true });
fs.mkdirSync(tmp, { recursive: true });
// ⚠️ 一定要先把这个变量设上：不设的话会去读**用户真实存档目录**里的 pid 文件，
// 而那份可能是他自己开着的窗口 —— 自检反手把人家的程序关了。
process.env.JIKAI_KILL_USERDATA = tmp;

const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };
const pidPath = path.join(tmp, PID_FILE);
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 「pid 文件该不该在」这件事，得让环境也有机会说一句话。
 *
 * 某些沙盒对「一轮里累计删了多少文件」有上限，超了之后 Node 的 `fs.rmSync` 一律抛 ——
 * 那时标记会留着，但**不是代码没清**。不区分的话这条断言报的是「你没清标记」，
 * 会把人往一个本来正确的实现上去改。所以：环境拒绝了就 warn 一句并按过；
 * 代码真的没清（返回值里没这个标记、文件却还在）照样红。
 */
const cleanupBlockedByEnv = (r, what) => {
  if (!r?.cleanupFailed) return false;
  console.warn(`  ! ${what}：标记没清掉，但这次是环境拒绝删除（沙盒的删除总量上限），不算代码问题`);
  return true;
};

console.log(`靶场：${path.relative(root, tmp)}`);

// ---- 1. 目录都不存在时为「本来就没开」 ----
{
  // ⚠️ 这一条要用一个**不存在**的目录：目录在、只是没 pid 文件，是另一种情况（下一条）。
  // 用同一个目录跑的话，「本来就没开」和「开了但没留标记」会被混成一类，
  // 而这两句话给到用户的意思是反的。
  const missing = path.join(root, 'test', '.tmp', 'killapp-never-existed');
  cleanup(missing, { recursive: true });
  process.env.JIKAI_KILL_USERDATA = missing;

  const dir = defaultUserData();
  check(path.resolve(dir) === path.resolve(missing), `userData 没走靶场（${dir}）—— 这个自检会去动真实的程序`);
  const first = await closeRunningApp(root, { quiet: true });
  check(first.reason === 'not-running', `目录不存在应当报 not-running，实际 ${first.reason}`);
  check(first.killed === 0, '目录不存在不该关掉任何东西');

  process.env.JIKAI_KILL_USERDATA = tmp;
}

// ---- 2. 目录在、但没有 pid 文件 ----
{
  const r = await closeRunningApp(root, { quiet: true });
  check(r.reason === 'no-pid-file', `有目录没文件应当报 no-pid-file，实际 ${r.reason}`);
  check(r.killed === 0, '没有 pid 文件时不该关掉任何东西');
}

// ---- 3. pid 文件指向一个已经不存在的进程 ----
{
  fs.writeFileSync(pidPath, JSON.stringify({ pid: 999999, at: Date.now() }), 'utf8');
  const r = await closeRunningApp(root, { quiet: true });
  check(r.reason === 'stale-pid', `对着死 pid 应当报 stale-pid，实际 ${r.reason}`);
  check(r.killed === 0, '死 pid 不该算「关掉了一个」');
  check(
    !fs.existsSync(pidPath) || cleanupBlockedByEnv(r, '死 pid 那一条'),
    '读出来是死的就该顺手把标记清掉，不然下次还要白跑一趟',
  );
}

// ---- 4. 真的有一份在跑：要关掉它 ----
{
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await sleep(600);
  check(alive(child.pid), '靶子没起来，这一条验不了 —— 不是功能坏了');

  fs.writeFileSync(pidPath, JSON.stringify({ pid: child.pid, at: Date.now() }), 'utf8');
  const r = await closeRunningApp(root, { quiet: true });

  check(r.pid === child.pid, `关的应当是那个靶子（${child.pid}），实际报的是 ${r.pid}`);
  check(r.reason === 'killed', `应当报 killed，实际 ${r.reason}`);
  check(r.killed === 1, '关掉了一个就该报 1');
  /*
   * ⚠️ `forced` 这一条**不能**写死成 true 或 false：
   * Windows 上 `process.kill(pid, 'SIGTERM')` 就是 TerminateProcess，
   * 进程当场没，JS 侧的 SIGTERM 处理器根本不会跑 —— 于是 forced 是 false；
   * Poisx 上才是「先请它退、赖着不动才强杀」。
   * 所以这里只断言它**如实地是个布尔**，并把这一次走的哪条路打出来：
   * 强行统一成一种期望，换台机器跑就是一条假红。
   */
  check(typeof r.forced === 'boolean', `forced 必须是布尔，实际 ${typeof r.forced}`);
  console.log(`  · 这次走的是「${r.forced ? '先请退、没退再强杀' : '一次就退掉了'}」那条路`);
  check(!alive(child.pid), `pid ${child.pid} 还活着 —— 没关掉`);
  check(
    !fs.existsSync(pidPath) || cleanupBlockedByEnv(r, '关掉进程那一条'),
    '关掉之后标记要清掉',
  );

  // 反向：**不能**关掉自己
  check(alive(process.pid), '自检把自己也关了 —— 说明 pid 的来源搞错了');
}

// ---- 5. pid 文件是坏的时候必须什么都不做 ----
{
  for (const junk of ['不是 json', '{}', '{"pid":0}', '{"pid":"abc"}', '[]']) {
    fs.writeFileSync(pidPath, junk, 'utf8');
    const r = await closeRunningApp(root, { quiet: true });
    check(r.reason === 'no-pid-file', `坏 pid 文件「${junk}」应当被当成「认不出」，实际 ${r.reason}`);
    check(r.killed === 0, `坏 pid 文件「${junk}」不该关掉任何东西`);
  }
  cleanup(pidPath);
}

cleanup(tmp, { recursive: true });

if (failures.length) {
  console.error('✗ 关闭在跑实例的自检失败：');
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log('✓ 通过');
console.log('  认得出「没开 / 没标记 / 死 pid / 真在跑 / 标记坏了」五种情况，只有真在跑的那一种会动手');
