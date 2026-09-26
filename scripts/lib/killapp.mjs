/**
 * 把「自己开着的这份程序」找出来关掉。
 *
 * 为什么需要它：应用是**单实例**的。用户开着窗口的时候跑自检，第二份起不来、
 * 直接退出，一个字都不打印 —— 报出来的症状是「窗口没起来 / 渲染进程被杀了」，
 * 会让人去查渲染进程，查半天发现只是自己没关窗口。
 * 这一条踩过不止一次，所以从「打印一句提示」改成「真的把它关掉」。
 *
 * ⚠️ 怎么认出「是我们这份程序」：
 * **不靠枚举进程的命令行**。一开始的写法是列 electron.exe 的命令行、挑出带本项目
 * 路径的那些 —— 这条路在本机 sandbox 里走不通（Node spawn 外部 exe 一律 EBUSY，
 * 静默返回空数组，于是「一个都没找到」，看着像功能正常，其实什么都没查）。
 * 换成**程序自己在 userData 里留一份 pid 文件**：不需要枚举，身份由写文件的人自己声明。
 * 代价是得让主进程配合写（见 main.cjs 的 `singleton.json`）。
 *
 * ⚠️ pid 会被系统复用。所以除了「这个 pid 还活着」，还要求「它还叫 electron.exe」
 * （打包之后是可执行体自己的名字）—— 两道一起过才动手。pid 文件是上次**没退干净**
 * 留下的，这种情况下那个 pid 多半早被别的进程占用了。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 程序自己报身份用的文件名（主进程写在 userData 下） */
export const PID_FILE = 'singleton.json';

/**
 * 默认 userData 在哪。
 *
 * 和 Electron 的算法一致：`appData/<package.json 里的 name>`。
 * 只有**默认**那一份会被扫 —— 带 `--profile` 的运行自带一份 userData、
 * 自带一把锁，和用户开着的窗口不冲突，也就不该去动它。
 */
export function defaultUserData(kind = process.platform) {
  if (process.env.JIKAI_KILL_USERDATA) return process.env.JIKAI_KILL_USERDATA;
  const name = 'jikai';
  if (kind === 'win32') return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), name);
  if (kind === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', name);
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), name);
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 清掉程序留下的 pid 文件，返回**有没有被环境拒绝**。
 *
 * 为什么要分出这个返回值：某些沙盒对「一轮里累计删了多少文件」有上限，
 * 超了之后 `rmSync` 一律抛。那种情况下标记会留着 —— 下次自检白跑一趟，
 * 但**不是代码没清**。不区分的话，自检报的是「你没清标记」，
 * 会把人往一个本来正确的实现上去改。
 */
function clearPidFile(dir) {
  try {
    fs.rmSync(path.join(dir, PID_FILE), { force: true });
    return false;
  } catch {
    return true;
  }
}

/** 读程序留下的 pid 文件。读不到 / 内容不像话都回 null */
function readPidFile(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, PID_FILE), 'utf8');
    const info = JSON.parse(raw);
    const pid = Number(info?.pid);
    return Number.isFinite(pid) && pid > 0 ? { pid, at: Number(info?.at) || 0 } : null;
  } catch {
    return null;
  }
}

/**
 * 关掉默认存档目录里那一份程序。
 *
 * @param {string} [root] 项目根目录（只用于打日志，不参与判断）
 * @param {{ quiet?: boolean, graceMs?: number }} [opts]
 * @returns {Promise<{ killed: number, pid: number|null, forced: boolean, reason: string, cleanupFailed?: boolean }>}
 *          `forced` = 它是被强杀的（那一下有可能丢掉最后 400ms 的防抖存档）；
 *          `reason`：`not-running` / `no-pid-file` / `stale-pid` / `killed` / `stubborn`；
 *          `cleanupFailed` = 该清的 pid 文件被环境拒绝删除了（不是「没清」）
 */
export async function closeRunningApp(root, opts = {}) {
  const graceMs = opts.graceMs ?? 1500;
  const dir = defaultUserData();
  const info = readPidFile(dir);

  if (!info) {
    // ⚠️ 这一条**不能**说成「没有实例在跑」：分不清「本来就没开」和
    // 「开了但没留下 pid 文件」（老版本、或文件被清掉了）。说清楚，别编。
    return { killed: 0, pid: null, forced: false, reason: fs.existsSync(dir) ? 'no-pid-file' : 'not-running' };
  }
  if (!alive(info.pid)) {
    // 上次没退干净。顺手把文件清掉，免得下次又白跑一趟
    return { killed: 0, pid: info.pid, forced: false, reason: 'stale-pid', cleanupFailed: clearPidFile(dir) };
  }

  if (!opts.quiet) {
    console.log(`! 有一份本项目的 Electron 还开着（pid ${info.pid}，${dir}），先把它关掉`);
  }

  // 先请它自己退：存档是 400ms 防抖写的，硬杀会丢掉最后一次改动
  try { process.kill(info.pid, 'SIGTERM'); } catch { /* 刚好没了 */ }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && alive(info.pid)) await sleep(150);

  let forced = false;
  if (alive(info.pid)) {
    forced = true;
    if (!opts.quiet) console.log(`  · pid ${info.pid} 没退出，强杀（最后那点改动可能保不住）`);
    try { process.kill(info.pid, 'SIGKILL'); } catch { /* 刚好没了 */ }
    await sleep(400);
  }

  const stubborn = alive(info.pid);
  // 主进程自己退出时也会删这个文件；万一它没删成，才轮到我们，删不掉就记下来
  const cleanupFailed = stubborn ? false : clearPidFile(dir);
  return { killed: stubborn ? 0 : 1, pid: info.pid, forced, reason: stubborn ? 'stubborn' : 'killed', cleanupFailed };
}
