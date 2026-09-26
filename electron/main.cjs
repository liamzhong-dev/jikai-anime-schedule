'use strict';

/**
 * Electron 主进程：窗口、托盘、本地落盘、系统通知、外部浏览器、网络通道、
 * 开机自启、全局快捷键。
 *
 * 副作用集中在这里，渲染层只通过 preload 暴露的 window.jikai 调用，
 * 因此把壳换成 Tauri 时只需要再写一份等效实现，业务代码不用动。
 */

const { app, BrowserWindow, Notification, Menu, dialog, globalShortcut, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const netBridge = require('./net.cjs');
const { createTray } = require('./tray.cjs');
const { CoverCache } = require('./covers.cjs');
/**
 * ⚠️ 这一行是被 IPC 冒烟逼出来的：`update:check` 一直在用 `updater.checkUpdate`，
 * 但这个文件**从来没被 require 过** —— 一点「检查更新」就抛 `ReferenceError`。
 * 藏了这么久是因为自动更新入口默认隐藏（features.js），没人点得到，也就没人触发。
 * 这就是「没跑过的代码」最典型的形状：不是没写，是从没执行。
 */
const updater = require('./updater.cjs');
/**
 * ⚠️ 同一个坑踩第二次：上面那条注释写完的当天，`report:export` 又在用
 * `reportExport.renderPdf` 而忘了在这一行 require。所以这次把「IPC 里用到的
 * 模块名」和「顶部 require 的模块名」一起写下来，改这里的时候对着数一遍。
 */
const reportExport = require('./reportExport.cjs');

const DEV_URL = process.env.JIKAI_DEV_URL || '';

/**
 * 自检模式：`JIKAI_SMOKE=<绝对路径>` —— 加载完截一张图、打一行 JSON 然后退出。
 * 无头环境里这是唯一能区分「窗口开着」和「界面真的画出来了」的办法。
 */
const SMOKE_PNG = process.env.JIKAI_SMOKE || '';

/**
 * IPC 冒烟开关。定义在这么前面，是因为它也要参与下面那个「关不关 GPU」的判断 ——
 * 声明在函数区（原来在 90 行附近），这里就用不上了。
 */
const IPC_SMOKE = process.env.JIKAI_IPC_SMOKE === '1';

/**
 * 「再试一次硬件加速」那条链的自检口子：`JIKAI_SMOKE_RETRYHW=<标记文件路径>`。
 *
 * 这是唯一一个会**主动重启程序**的按钮，而重启这种事没法靠读代码相信 ——
 * 它得真的走完：① 用户点下去 → ② 主进程清掉降级标记 → ③ 新的一份真的起来了。
 * 所以专门给它一条能执行的路：重启后的那一份凭 argv 里的标记认出自己，
 * 往这个文件写一行就退出。
 *
 * ⚠️ 标记文件而不是 stdout：新起来的进程**不继承输出管道**，打出来的字到不了终端
 * —— 自愈那条链就是这么被误判过一次的（见 createWindow 里 CRASH_TEST 那段注释）。
 */
const RETRYHW_PROBE = process.env.JIKAI_SMOKE_RETRYHW || '';

/**
 * 自检模式下把 GPU 关掉。
 *
 * 这台机器（以及大多数无头/远程会话）的 GPU 进程起不来，表现是
 * 「`GPU process exited unexpectedly` 连刷九次 → `FATAL: GPU process isn't usable. Goodbye.`」，
 * 进程活不到截那一刻。正常启动**不关** —— 正常机器上没理由降级。
 */
// IPC 冒烟也算自检：它现在要开隐藏窗口跑一次长图导出（`report:export`），
// 而那股「GPU 进程起不来 → 窗口全白 → 进程退出」的毛病在无头环境里照样会撞上。
if (SMOKE_PNG || IPC_SMOKE) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}

/**
 * 自检可以指定一个一次性的存档目录：`JIKAI_USERDATA=<绝对路径>`。
 *
 * 为什么必须能改：桌面自检要真的读写 `state.json`，而默认 userData 是
 * **用户本人的真实档案** —— 让自动化往里写东西，等于测试在改用户的存档。
 * 有了这个口子，自检就能在一个用完即弃的空 profile 里跑完整的
 * 「落盘 → 重启 → 读回来」链路，而不是只敢验只读的部分。
 *
 * ⚠️ 必须在 app ready 之前调用，晚一步路径就改不动了。
 */
if (process.env.JIKAI_USERDATA) {
  const dir = process.env.JIKAI_USERDATA;
  try {
    fs.mkdirSync(dir, { recursive: true });
    app.setPath('userData', dir);
  } catch (err) {
    console.warn(`[jikai] 指定 userData 失败，退回默认目录：${err?.message ?? String(err)}`);
  }
}

/**
 * IPC 冒烟：`JIKAI_IPC_SMOKE=1` —— 把主进程所有 IPC handler 挨个真跑一遍，
 * 打一张 PASS/FAIL 表然后退出（有 FAIL 就退出码非 0）。
 *
 * 为什么要有这个：
 *   桌面端 25 个 handler 里真正被跑过的只有四五个，剩下的**从来没执行过** ——
 *   其中最刺眼的是 `file:save-binary`：v1.1 主打功能是「导出 PNG」，
 *   而导出真正落盘的那一步在桌面端一次都没跑过（真机导出只验过浏览器壳）。
 *   「没跑过」不等于「没问题」，只是问题还没轮到显形。
 *
 * 为什么用注册表（handlers）而不是在冒烟里另写一份等价实现：
 *   另写一份只能证明「那份复制品是对的」。这里调的就是 ipcMain 真正注册的那个函数。
 */
const CRASH_TEST = process.env.JIKAI_CRASH_TEST === '1';
// `IPC_SMOKE` 声明在文件顶部（它要参与「关不关 GPU」的判断），这里不再重复定义 ——
// 两处各写一份的话，改了一处就会出现「文档说关了、其实没关」。

/**
 * 测试用轨迹标记（只在 `JIKAI_CRASH_TEST=1` 时生效）。
 *
 * 为什么需要它：自愈链路里「没走到」和「走到了但卡住」是两个完全不同的原因，
 * 而 stdout 在重开的子进程里**根本传不回来**（`cmd /c start` 重新拉起的进程不继承管道），
 * 只能靠落地文件。有了分段轨迹，才能一眼看出断在哪一步，不用逐段屏蔽代码去二分。
 */
const trace = (text) => {
  if (!CRASH_TEST || !process.env.JIKAI_CRASH_MARKER) return;
  try {
    fs.appendFileSync(process.env.JIKAI_CRASH_MARKER, `${text}\n`, 'utf8');
  } catch { /* 测试钩子，写不了就算了 */ }
};

/**
 * handler 注册表：注册时顺手存一份，冒烟模式直接调它。
 *
 * 用 `handle()` 而不是直接 `ipcMain.handle()`，就是为了这里 ——
 * 否则冒烟只能绕开 handler 自己重造一遍，那就失去意义了。
 */
const handlers = Object.create(null);
function handle(channel, fn) {
  handlers[channel] = fn;
  ipcMain.handle(channel, fn);
}

const ICON_PNG = path.join(__dirname, '..', 'build', 'icons', 'icon.png');

/** 应用根目录：渲染进程崩溃后重开时要把它作为第一个参数传回去（见 G5 那处注释） */
const APP_ROOT = path.join(__dirname, '..');

const stateFile = () => path.join(app.getPath('userData'), 'state.json');
const wallpaperFile = () => path.join(app.getPath('userData'), 'wallpaper.json');
/**
 * 名称索引单独一个文件，跟壁纸是同一个理由。
 *
 * 它构建完大约 1 MB（实测 8833 条、每条 112 字节），如果混进 state.json，
 * 那每次 flush 都要 stringify 并重写这 1 MB —— 而 state 是 400ms 防抖、
 * 改一次状态就写一遍的。壁纸就是因为 base64 太大被单独拎出去的，
 * 这里不该再犯一次。
 */
const nameIndexFile = () => path.join(app.getPath('userData'), 'nameIndex.json');

let mainWindow = null;
let tray = null;
let isQuitting = false;
let lastTrayState = {};
let currentHotkey = '';

/** 封面缓存实例：等 whenReady 之后才知道 userData 在哪，所以先留空 */
let coverCache = null;

// 从托盘启动（开机自启）时不弹窗，直接蹲在托盘里
const START_HIDDEN = process.argv.includes('--hidden');

/**
 * 渲染进程崩过一次后重开时会带上这个标记（计划 G5）。
 * 它同时承担两个作用：告诉新进程「别再重试了」，以及「这次要把沙盒关掉」。
 */
const RETRY_FLAG = '--no-sandbox-retry';
const RETRIED = process.argv.includes(RETRY_FLAG);

/**
 * 崩过一次之后的这次重开，把 GPU 沙盒也关掉（计划 G5）。
 * 注意这里**只在重试时生效**：正常机器上沙盒该开着，不能为了怕崩就全局降级。
 */
if (RETRIED) {
  // 测试用的落地标记：写在所有东西之前，用来区分「重开的进程压根没起来」
  // 和「起来了但没走到 did-finish-load」—— 两种失败要从头就分得开，否则只能瞎猜。
  if (CRASH_TEST && process.env.JIKAI_CRASH_MARKER) {
    try {
      fs.appendFileSync(process.env.JIKAI_CRASH_MARKER, 'relaunched-process-started\n', 'utf8');
    } catch { /* 测试钩子，写不了就算了 */ }
  }
  if (CRASH_TEST && RETRIED && process.env.JIKAI_CRASH_MARKER) {
    const m = process.env.JIKAI_CRASH_MARKER;
    const note = (t) => { try { fs.appendFileSync(m, `${t}\n`, 'utf8'); } catch { /* 算了 */ } };
    process.on('exit', (code) => note(`exit:${code}`));
    process.on('uncaughtException', (e) => note(`uncaught:${e?.message}`));
    process.on('unhandledRejection', (e) => note(`rejection:${String(e)}`));
  }
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  app.commandLine.appendSwitch('no-sandbox');
}

/**
 * 「再试一次硬件加速」重启出来的那一份，靠这个标记认出自己。
 *
 * ⚠️ 不能复用上面那个 `--no-sandbox-retry`：它带着一整套「自愈重开」的副作用
 * （关 GPU、关沙盒），而这一份要验的恰恰是「换回硬件加速之后能不能起来」——
 * 拿一个自己把 GPU 关掉的进程去验它，等于什么都没验。
 */
const RETRYHW_FLAG = '--retryhw-retried';
const RETRYHW_RETRIED = process.argv.includes(RETRYHW_FLAG);

/**
 * 单实例锁：**在这里拿，不是在文件末尾**。
 *
 * ⚠️ 位置很要紧。抢不到锁的进程会在文件末尾 `app.quit()`，可下面那个
 * 「启动崩溃记忆器」在它之前就写过了 —— 于是「用户本来就开着 → 又启动了一次」
 * 会被记成「**上次启动没起来就死了**」，然后 `degrade: true` 被写进真实档案，
 * 下一次真正的启动就变成软件渲染（界面发涩），而用户什么都没做错。
 *
 * 本机实测踩到过：自检脚本连着跑了三次，真实档案里的 boot.json 就变成
 * `{"phase":"started","degrade":true}` —— 哥哥下次打开会发现「今天好像格外卡」，
 * 而没有任何地方能指向「是那次自检干的」。
 *
 * 必须在 `app.setPath('userData')` 之后拿（同一个目录才能算出同一把锁），
 * 也必须在 ready 之前（这是 Electron 允许的时机）。
 */
const hasSingleInstanceLock = app.requestSingleInstanceLock();

/*
 * 把「这份程序正开着」写进 userData。
 *
 * 自检脚本靠它找到并关掉这个进程：应用是单实例的，用户开着窗口的时候
 * 自检起不来、直接退，报出来的症状却是「窗口没起来」，很容易查错方向。
 *
 * ⚠️ 为什么不用「枚举进程、按命令行认人」：本机 sandbox 里 Node spawn 任何外部
 * 可执行体都是 EBUSY，那条路静默返回空列表 —— 看着像「一个都没找到」，
 * 其实什么都没查。让程序自己声明身份就没有这个问题，也不用去猜路径。
 *
 * ⚠️ 只在**拿到锁**之后写（没拿到锁的那一份马上要退了，不该覆盖真正在跑的那条记录）。
 * 正常退出时删掉；被强杀时留着，下次读到「pid 已经不存在」就顺手清掉。
 */
const PID_FILE = 'singleton.json';
function writePidFile() {
  try {
    fs.writeFileSync(
      path.join(app.getPath('userData'), PID_FILE),
      JSON.stringify({ pid: process.pid, at: Date.now() }),
      'utf8',
    );
  } catch { /* 写不进去只是自检关不掉我们，不该拦住启动 */ }
}
function clearPidFile() {
  try { fs.unlinkSync(path.join(app.getPath('userData'), PID_FILE)); } catch { /* 本来就没有 */ }
}
/*
 * ⚠️ `app.exit()` **不走** will-quit 那套流程，自检和冒烟里全是 `app.exit()` ——
 * 只挂 will-quit 的话，每次跑完自检都会留下一份 pid 文件。
 * 留着本身没害（下次读到「pid 已经不存在」会自己清掉），但它会让人分不清
 * 「真有一份开着」和「上次没清干净」，而这正是这个功能最不该含糊的地方。
 */
process.on('exit', clearPidFile);
process.on('SIGINT', () => { clearPidFile(); process.exit(0); });
process.on('SIGTERM', () => { clearPidFile(); process.exit(0); });

/**
 * 启动崩溃记忆器（计划 G5）。
 *
 * ⚠️ 为什么需要它 —— 本机实测（沙盒内外都试过）：不带任何降级时，
 * Electron 会打出九次 `GPU process exited unexpectedly`，然后
 * `FATAL: gpu_data_manager_impl_private.cc(423)] GPU process isn't usable. Goodbye.`，
 * **进程直接死掉，退出码 3，窗口一个都没出来**。
 * 这种失败发生在 `ready` 之前，渲染层、IPC、`render-process-gone` 全都来不及注册，
 * 只盯着「渲染进程崩了要不要重开」是堵不住它的。
 *
 * 所以这里换个思路：**不猜失败原因，只记结果**。
 *   每次启动先写一个「已开始、还没活」的标记；
 *   窗口真的显示出来了才把这个标记改成「健康」。
 * 于是下一次启动时如果还留着「已开始」，就说明上一次是**没起来就死了** ——
 * 不管原因是什么，这一次都直接降级。比对着具体错误信号处理更稳，
 * 因为 Chromium 内部的致命错误不走 Electron 的事件。
 *
 * 降级结果会被**记住**：否则每次都「先正常试一次 → 崩 → 降级成功 → 又想试正常」，
 * 用户每开一次都要先看一次崩溃。
 */
/**
 * 攒够几次「健康启动」才敢把降级清掉。
 *
 * 一次就清的话，「崩 → 降级 → 起来 → 又试硬件加速 → 又崩」会变成每次开机都演一遍，
 * 用户看到的是「这软件怎么老闪退」。攒两次是个折中：偶发崩溃能自己恢复，
 * 真的起不来的一直留着降级。
 */
const HEALTHY_TO_RECOVER = 2;

/**
 * 最多自动恢复几次。
 *
 * 没有这个上限，「恢复 → 崩 → 降级 → 恢复 → 崩」会一直来回 ——
 * 每三轮浪费用户两次启动。试过 3 次还不行，就认了：这台机器就是只能用软件渲染。
 */
const MAX_GPU_RECOVERIES = 3;

const boot = (() => {
  /*
   * ⚠️ 默认**一个字都不许写**：不带 `--profile` 的那几条自检用的就是**用户的真实档案**
   * （有一条路必须用真实档案 —— 要验「封面到底走没走缓存」）。于是自检崩一次，
   * `degrade: true` 就写进了用户本人的档案：从此他每次打开都是软件渲染、界面发涩，
   * 而没有任何地方能指向「是那次自检干的」。本机真的踩到过。
   *
   * 但判据是「这次跑的是不是一次性档案」，不是「这是不是自检」——
   * 后者连 boot 状态机自己也一起挡死了（`JIKAI_USERDATA` 指的就是一次性目录，
   * 往那儿写再多也不关用户的事），换来的只是**这套状态机彻底没法验证**：
   * 它只有「真崩一次」才会走到下一格，而崩溃不能按需重演。
   * 「degrade 永不复位」这个毛病就是这么漏到用户手上的。
   */
  const HAS_OWN_PROFILE = Boolean(process.env.JIKAI_USERDATA);
  const SELF_CHECK = !HAS_OWN_PROFILE
    && Boolean(SMOKE_PNG || IPC_SMOKE || process.env.JIKAI_PERF
      || process.env.JIKAI_CRASH_TEST || process.env.JIKAI_BOOT_PROBE);

  const tryPath = () => {
    if (SELF_CHECK) return '';
    try {
      return path.join(app.getPath('userData'), 'boot.json');
    } catch {
      return '';
    }
  };
  const file = tryPath();
  const read = () => {
    if (!file) return {};
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    } catch {
      return {};
    }
  };
  /**
   * 这个进程往 boot.json 写过几次。
   *
   * 留着它是为了能断言「自检一个字都没写」—— 判「盘上有没有这个文件」不行，
   * 那依赖跑之前的状态（用户档案里本来就有一份）。次数不依赖任何外部状态。
   */
  let writes = 0;
  const write = (patch) => {
    if (!file) return;
    writes += 1;
    try {
      fs.writeFileSync(file, JSON.stringify({ ...read(), ...patch }), 'utf8');
    } catch { /* 记不住就算了，不影响启动 */ }
  };

  const prev = read();
  // 上一次留着 started（没走到 healthy）＝ 上次没起来就死了
  const crashedLastTime = prev.phase === 'started';
  /*
   * `JIKAI_FORCE_DEGRADE=1`：强制降级跑一次，用来做 A/B ——
   * 「用户觉得卡」和「硬件加速关掉了」这两件事到底是不是同一件事，
   * 只有把同一组性能场景在两种渲染模式下各量一遍才答得了。
   * 只影响这一次运行，不写档。
   */
  const forced = process.env.JIKAI_FORCE_DEGRADE === '1';
  const shouldDegrade = forced || crashedLastTime || prev.degrade === true;
  /*
   * ⚠️ 抢不到锁就**一个字都不许写**：这个进程马上会 quit，它写下的东西
   * 会被下一次真正的启动当成「上次崩了」的证据。见上面单实例锁那一段。
   */
  if (hasSingleInstanceLock) {
    /*
     * 崩过就把健康次数**清零**再数。
     *
     * 不清的话 streak 就成了「这辈子一共健康过几次」：装了半年的档早就 ≥ 2，
     * 于是「崩 → 降级一次 → 立刻恢复 → 又崩 → 又降级一次」会变成每次开机都闪一下，
     * HEALTHY_TO_RECOVER 那一整套「攒够才敢信」等于白写。
     * 清零之后语义才是想要的：**降级期间连续健康两次**才敢把硬件加速放回来。
     */
    if (crashedLastTime) write({ degrade: true, healthyStreak: 0 });
    write({ phase: 'started' });
  }

  return {
    shouldDegrade: shouldDegrade && hasSingleInstanceLock,
    crashedLastTime,
    forced,
    selfCheck: SELF_CHECK,
    writes: () => writes,
    /** 这一次启动用的是不是软件渲染（设置面板要把它显示出来） */
    degradedNow: shouldDegrade && hasSingleInstanceLock,
    /**
     * 窗口真的显示出来了调用一次，把标记抹掉。
     *
     * ⚠️ 这里同时是「降级该怎么退出」的唯一出口。原来只写 `phase: 'healthy'`，
     * 于是一次崩溃留下的 `degrade: true` **永久生效** —— 用户从此一直软件渲染、
     * 界面发涩，而且没有任何地方能把状态改回来。
     */
    healthy: () => {
      if (SELF_CHECK) return;
      const cur = read();
      const streak = (Number(cur.healthyStreak) || 0) + 1;
      const recoveries = Number(cur.recoveries) || 0;
      if (cur.degrade === true && streak >= HEALTHY_TO_RECOVER && recoveries < MAX_GPU_RECOVERIES) {
        write({
          phase: 'healthy',
          degrade: false,
          healthyStreak: 0,
          recoveries: recoveries + 1,
          recoveredAt: Date.now(),
        });
        return;
      }
      write({ phase: 'healthy', healthyStreak: streak });
    },
    /** 让用户手动「再试一次硬件加速」：清掉降级并把恢复次数清零 */
    retryHardware: () => {
      write({ degrade: false, healthyStreak: 0, recoveries: 0, retriedAt: Date.now() });
      return read();
    },
    /** 给设置面板看的当前状态 */
    state: () => read(),
  };
})();

if (boot.shouldDegrade) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}

/**
 * `JIKAI_BOOT_PROBE=<crash|healthy>` —— 把 boot 的状态机从「只有真启动才走一遍」
 * 变成「可以一步一步走」，给 `check:boot` 用（配合 `JIKAI_USERDATA` 指一次性目录）。
 *
 * 为什么非要有这个口子：这套状态机只有真的崩一次才会走到下一格，而崩溃没法按需重演。
 * 于是「degrade 一旦写进去就永久生效」这个毛病从开发到发版一路没人发现 ——
 * 用户那边只表现为「有点卡」，没有任何线索指向 `boot.json`。
 *   crash   —— 什么都不做就退出，留下 `phase: 'started'`（＝模拟「上次没起来就死了」）
 *   healthy —— 走一次正常启动该走的那一步
 */
const BOOT_PROBE = process.env.JIKAI_BOOT_PROBE || '';
if (BOOT_PROBE) {
  if (BOOT_PROBE === 'healthy') boot.healthy();
  console.log(`BOOT_PROBE ${JSON.stringify({
    probe: BOOT_PROBE,
    shouldDegrade: boot.shouldDegrade,
    writes: boot.writes(),
    snap: boot.state(),
  })}`);
  app.exit(0);
}

/** 外链白名单：只允许 http/https，避免被 file:// 或自定义协议劫持 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

function isSafeUrl(url) {
  try {
    return ALLOWED_PROTOCOLS.has(new URL(String(url)).protocol);
  } catch {
    return false;
  }
}

// ---------- 落盘 ----------

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null; // 首次启动或文件损坏都按空状态处理
  }
}

function writeJsonFile(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 先写临时文件再改名，避免写一半断电留下半个 JSON
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value ?? {}), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 启动崩溃记忆器用的轨迹文件（见下面的 `trace`）之外，还有这一组给长图导出兜底的小工具。
 */

/**
 * 正在被使用的「隐藏窗口」数量（长图导出时 +1）。
 *
 * 为什么需要它 —— 这是一条**报错完全指向错方向**的坑（2026-09-26 撞上）：
 * `window-all-closed` 的语义是「用户把所有窗口都关了」，而导出长图是「开一个隐藏窗口、
 * 用完就销毁」。在自检模式里恰好没有别的窗口，于是第一个导出（PDF）销毁窗口的那一刻
 * 触发了「所有窗口都关了」→ `app.quit()`，紧接着第二个导出（PNG）刚建好窗口就
 * 加载失败，报
 *   `ERR_FAILED (-2) loading 'file:///C:\...\jikai-report-png-*.html'`
 * —— 看上去像「临时文件路径不对」，跟真正的原因（进程正在退出）毫无关系。
 *
 * 顺带说明：正常运行时因为托盘常驻，不会走到这条分支；但「导出时用户恰好关了主窗口」
 * 是能出现的，所以修在这里、而不是只改冒烟脚本。
 */
let hiddenExportWindows = 0;

/**
 * 给送进来的导出 HTML 补上样式。
 *
 * 为什么需要兜底：渲染层是从 `document.styleSheets` 里展开 `cssRules` 拿样式的，
 * 而打包后样式是外链、页面走 `file://` —— Chromium 在这个组合下可能把每份文件
 * 当成独立源，读 `cssRules` 直接抛 SecurityError。那条路一断，导出的就是一张
 * **有字没样式**的长图，而窗口里预览完全正常（预览用的是同一份 DOM，
 * 样式由文档自己加载，根本不经过这个函数）。所以这里宁可再读一次磁盘。
 *
 * 判据不用「长度够不够」而用「关键选择器在不在」：样式长度没有可靠阈值，
 * 而 `.report__canvas {` 一定出现在我们的 CSS 里。
 */
function withReportStyles(html) {
  if (/\.report__canvas\s*\{/.test(html)) return html;

  const dir = path.join(__dirname, '..', 'dist', 'assets');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.css')).map((f) => path.join(dir, f));
  } catch {
    return html; // 开发模式（vite 注入 <style>）或还没构建，交给上面那条判据兜着
  }

  let css = '';
  for (const f of files) {
    try {
      css += `\n${fs.readFileSync(f, 'utf8')}`;
    } catch { /* 读不了就跳过这一份 */ }
  }
  if (!css.trim()) return html;

  // 只替换第一处：导出页里只有我们注入的那一个 <style>
  return html.replace('</style>', `${css}\n</style>`);
}

/** 壁纸单独一个文件：它是 base64 大字符串，混进 state.json 会让每次落盘都很重 */
function writeWallpaper(payload) {
  if (!payload) return writeJsonFile(wallpaperFile(), {});
  return writeJsonFile(wallpaperFile(), payload);
}

// ---------- 窗口 ----------

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 660,
    show: false,
    backgroundColor: '#0c0e13',
    title: '次回',
    icon: fs.existsSync(ICON_PNG) ? ICON_PNG : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  trace('c1-browserwindow-ok');

  win.once('ready-to-show', () => {
    // 窗口真的显示出来了 = 这次启动是健康的，把「崩溃记忆」抹掉
    boot.healthy();
    if (!START_HIDDEN && !process.argv.includes('--tray')) win.show();
  });

  /**
   * 自愈链路的测试钩子：`JIKAI_CRASH_TEST=1` 起的应用会主动把渲染进程打死。
   *
   * 为什么需要它：渲染进程崩溃这种事平时不会自己发生，于是自愈代码**永远没被执行过** ——
   * 这正是本项目踩过最大的坑（桌面专属路径从未运行）。光看代码不知道重开会不会被引擎拒绝。
   * 所以这里是唯一一处专为测试写的分支，严格卡在两个条件上：只对 started-by-测试 生效，
   * 且重试那次会立刻打印结果退出，不会打扰真实用户。
   */
  if (CRASH_TEST) {
    /**
     * 标记文件而不是 stdout：`app.relaunch()` 起来的新进程**不会继承这里的输出管道**，
     * 打出来的字根本到不了终端 —— 一开始就因为没有输出而误判成「没重开」。
     * 写文件绕开了 stdio 继承问题，重开到底有没有发生，看文件就知道。
     */
    const marker = process.env.JIKAI_CRASH_MARKER || '';
    const mark = (text) => {
      if (!marker) return;
      try {
        fs.appendFileSync(marker, `${text}\n`, 'utf8');
      } catch { /* 测试钩子，写不了就算了 */ }
    };

    win.webContents.once('did-finish-load', () => {
      mark('r3-loaded');
      setTimeout(() => {
        if (RETRIED) {
          mark('relaunched');
          app.exit(0);
          return;
        }
        mark('crashing');
        win.webContents.forcefullyCrashRenderer();
      }, 1500);
    });

    /**
     * 另一条失败路径：页面**加载失败**时 `did-finish-load` 永远不来，
     * 标记文件里只会停在上一步，只能看出「没走完」却看不出为什么。
     * 把失败码也记下来，省一轮瞎猜。
     */
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      mark(`load-fail:${code}:${desc}:${String(url).slice(0, 60)}`);
    });
  }

  // ---------- 自检：JIKAI_SMOKE=<png 绝对路径> ----------
  //
  // 看不见画面的时候，「窗口开着」不等于「界面画出来了」——
  // 渲染进程可能早就崩了，进程还活得好好的。所以让它自己截一张图再退。
  //
  // 这一段顺带把**主进程那条 IPC 链**也验了：截图前先真的调一次封面缓存，
  // 否则「渲染层拿得到封面」这件事在桌面壳里没有任何自动化覆盖。
  if (SMOKE_PNG) {
    win.webContents.once('did-finish-load', async () => {
      try {
        /*
         * 重启过来的那一份：**认出自己就走人**。
         *
         * ⚠️ 必须排在所有探测之前（截图、点击、性能都不该再跑一遍）——
         * 它唯一的使命是「证明自己起来了」，写一行标记就退。
         */
        if (RETRYHW_PROBE && RETRYHW_RETRIED) {
          try {
            fs.writeFileSync(RETRYHW_PROBE, `${JSON.stringify({ pid: process.pid, up: true })}\n`, 'utf8');
          } catch { /* 写不了就按「没起来」算，脚本会把它报出来 */ }
          app.exit(0);
          return;
        }

        /*
         * 第一份：替用户按一次「再试一次硬件加速」。
         *
         * ⚠️ 这一句是它留在这个世界上的最后一句话：`app.exit()` 是同步的，
         * 主进程一收到这个 invoke 就立刻退，**返回值永远回不到这里**。
         * 所以判据只能是「我按了」＋「外面看到的那些变化」，不能等它的返回值。
         */
        if (RETRYHW_PROBE) {
          console.log(`SMOKE_RETRYHW_CALL ${JSON.stringify({ pid: process.pid })}`);
          win.webContents.executeJavaScript('window.jikai.retryHardware()').catch(() => {});
          await new Promise((r) => setTimeout(r, 3000));
          console.log('SMOKE_FAIL 按了「再试一次」之后程序没有重启（进程还活着）');
          app.exit(1);
          return;
        }

        // 等久一点可以顺便观察封面缓存有没有真的长起来（预热是后台跑的）
        const waitMs = Number(process.env.JIKAI_SMOKE_WAIT || 3000);
        await new Promise((r) => setTimeout(r, Number.isFinite(waitMs) ? waitMs : 3000));

        /*
         * `JIKAI_SMOKE_CLICK=<n>`：先替用户点一次「给 n 分」+「记下」，再取数。
         *
         * 为什么要真的点：这条链是
         *   控件 → 视图的 onSave → store → 防抖落盘 → preload → IPC → state.json
         * 除了最前面两环，后面每一环都**只在桌面壳里存在**。单测和 SSR 覆盖到
         * 「控件画出来了」，剩下的「点了以后到底有没有存进去」只能靠真的点一次。
         * 这个项目里最贵的几个 bug 全都长这样：代码写了，但从没被执行过。
         */
        const clickRate = Number(process.env.JIKAI_SMOKE_CLICK || 0);
        if (clickRate > 0) {
          const pick = await win.webContents
            .executeJavaScript(
              `(() => {
                 const btn = document.querySelector('[data-diary-rate="${clickRate}"]');
                 if (!btn) return false;
                 btn.click();
                 return true;
               })()`,
            )
            .catch(() => false);
          if (!pick) {
            console.warn('[jikai] 冒烟点击没找到打分按钮 —— 界面没到那一步');
          } else {
            // 两次点击之间隔一个宏任务：连着点的话，「保存」那一次可能还拿着
            // 上一帧的草稿值，于是失败看起来像代码坏了，其实是测试手法的问题。
            await new Promise((r) => setTimeout(r, 200));
            const saved = await win.webContents
              .executeJavaScript(
                `(() => {
                   const save = document.querySelector('[data-diary-save]');
                   if (!save) return false;
                   save.click();
                   return true;
                 })()`,
              )
              .catch(() => false);
            if (!saved) console.warn('[jikai] 冒烟点击没找到保存按钮');
          }
          // 等防抖（400ms）真的把状态写出去
          await new Promise((r) => setTimeout(r, 2000));
        }

        /*
         * ---------- 点封面打开详情：JIKAI_SMOKE_CARDOPEN=1 ----------
         *
         * 为什么非得用主进程的 sendInputEvent，而不是在页面里给元素派发一个 click：
         * 前者走 Chromium 真正的命中测试与输入管线 —— 封面上盖着别的东西时，
         * 点到的就是那个东西；后者是「把事件直接塞给这个元素」，哪怕有东西压在上面
         * 也照样成功。于是「用户点不开」这类 bug 在自检里永远是绿的，这正是它漏到现在的原因。
         *
         * 顺带记下 elementFromPoint 的命中链：真出了遮挡，一眼能看出是谁盖的。
         */
        const CARDOPEN = process.env.JIKAI_SMOKE_CARDOPEN || '';
        if (CARDOPEN) {
          const nap = (ms) => new Promise((r) => setTimeout(r, ms));
          const before = await win.webContents
            .executeJavaScript(
              `(() => {
                 const btn = document.querySelector('[data-cover-open]');
                 if (!btn) return { found: 0 };
                 const r = btn.getBoundingClientRect();
                 const cx = Math.round(r.left + r.width / 2);
                 const cy = Math.round(r.top + r.height / 2);
                 const top = document.elementFromPoint(cx, cy);
                 const path = [];
                 let el = top;
                 while (el && path.length < 5) {
                   const cn = (el.className && typeof el.className === 'string')
                     ? '.' + el.className.trim().split(/\\s+/).join('.')
                     : '';
                   path.push(el.tagName.toLowerCase() + cn);
                   el = el.parentElement;
                 }
                 return {
                   found: 1,
                   box: Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height),
                   cx: cx,
                   cy: cy,
                   hit: top ? (typeof top.className === 'string' && top.className ? top.className : top.tagName) : null,
                   /*
                    * ⚠️ 判「点到的是不是热区」**看 data 属性，不看类名**。
                    * 这里原来比的是类名 card__open，后来热区从卡片搬到共用的
                    * <Cover> 上、类名跟着改成 cover__hot，断言就悄悄失效了 ——
                    * 它不会报错，只会永远红（或者更糟：有人把名字改回去让它变绿）。
                    * 类名是给人看的外观，data 属性才是这条自检认的接口。
                    *
                    * ⚠️ 这段是模板字符串，**注释里也不能出现反引号** —— 一出现就把
                    * 整段 JS 提前截断，报的是语法错，看不出是注释的问题。
                    */
                   hitOpen: !!(top && top.closest && top.closest('[data-cover-open]')),
                   hitOpenId: (top && top.closest && top.closest('[data-cover-open]')?.getAttribute('data-cover-open')) || null,
                   path: path,
                   openBefore: document.querySelectorAll('.drawer__panel').length,
                 };
               })()`,
            )
            .catch((e) => ({ error: String(e?.message ?? e) }));

          let after = null;
          if (before && before.found) {
            win.webContents.sendInputEvent({ type: 'mouseMove', x: before.cx, y: before.cy });
            await nap(80);
            win.webContents.sendInputEvent({ type: 'mouseDown', x: before.cx, y: before.cy, button: 'left', clickCount: 1 });
            await nap(80);
            win.webContents.sendInputEvent({ type: 'mouseUp', x: before.cx, y: before.cy, button: 'left', clickCount: 1 });
            await nap(800);
            after = await win.webContents
              .executeJavaScript(
                `(() => {
                   const p = document.querySelector('.drawer__panel');
                   return {
                     panel: document.querySelectorAll('.drawer__panel').length,
                     drawerId: p ? p.getAttribute('data-drawer-id') : null,
                     title: (document.querySelector('.drawer__title') || {}).textContent || null,
                   };
                 })()`,
              )
              .catch((e) => ({ error: String(e?.message ?? e) }));
            // 收拾干净：后面的场景不该在遮罩底下跑
            await win.webContents
              .executeJavaScript(`(() => { const c = document.querySelector('.drawer__close'); if (c) c.click(); return 1; })()`)
              .catch(() => null);
            await nap(300);
          }
          console.log(`SMOKE_CARDOPEN ${JSON.stringify({ before, after })}`);
        }

        /*
         * ---------- 全屏的卡片要不要跟着布局预设走：JIKAI_SMOKE_MAXSYNC=1 ----------
         *
         * 用户报的是：某张卡全屏之后，再去「布局预设」里套一套模板，别的卡都排好了，
         * 就那张全屏的一动没动。根因是最大化那套样式写成 calc(100%)，压根不看 rect ——
         * 新的摆位写进来了，窗口照旧铺满，看着就像预设对它没生效。
         *
         * 这条只能由桌面端来答：它是 useEffect 的时序行为，SSR 读到的是初始态；
         * 单元测试里也没有真的 React 运行时。
         */
        const MAXSYNC = process.env.JIKAI_SMOKE_MAXSYNC || '';
        if (MAXSYNC) {
          const napMs = (ms) => new Promise((r) => setTimeout(r, ms));
          const CARD = process.env.JIKAI_SMOKE_MAXSYNC_CARD || 'season-grid';
          const PRESET = process.env.JIKAI_SMOKE_MAXSYNC_PRESET || 'builtin-focus';
          const sel = '[data-window-id="' + CARD + '"]';

          const readCard = () =>
            win.webContents
              .executeJavaScript(
                '(() => { const el = document.querySelector(' +
                  JSON.stringify(sel) +
                  '); if (!el) return { found: 0 };' +
                  ' const cs = getComputedStyle(el);' +
                  ' return { found: 1, maxed: el.getAttribute("data-maxed"),' +
                  ' left: Math.round(parseFloat(cs.left)), top: Math.round(parseFloat(cs.top)),' +
                  ' w: Math.round(parseFloat(cs.width)), h: Math.round(parseFloat(cs.height)) }; })()',
              )
              .catch((e) => ({ found: 0, error: String(e?.message ?? e) }));

          const clickIn = (js) =>
            win.webContents.executeJavaScript(js).then((v) => v).catch((e) => ({ error: String(e?.message ?? e) }));

          const before = await readCard();

          /*
           * 点最大化。这里用页面内的 click 而不是 sendInputEvent：
           * 要验的是「摆位同步」这条链路，不是「按钮能不能被点到」 ——
           * 后者由 CARDOPEN 那条真鼠标用例守着。混进来只会让失败原因变模糊。
           */
          const maxed =
            before && before.found
              ? await clickIn(
                  '(() => { const el = document.querySelector(' +
                    JSON.stringify(sel) +
                    '); if (!el) return 0;' +
                    ' const btn = Array.from(el.querySelectorAll(".window__btn")).find((b) => b.title === "最大化");' +
                    ' if (!btn) return 0; btn.click(); return 1; })()',
                )
              : 0;
          await napMs(400);
          const afterMax = await readCard();

          // 打开设置 → 切到布局页 → 套一套别的预设（这套动作就是用户报的那几步）
          const opened = await clickIn('(() => { const b = document.querySelector("[data-open-settings]"); if (!b) return 0; b.click(); return 1; })()');
          await napMs(500);
          const tabbed = await clickIn('(() => { const b = document.querySelector("[data-tab=layout]"); if (!b) return 0; b.click(); return 1; })()');
          await napMs(300);
          const applied = await clickIn(
            '(() => { const b = document.querySelector(' +
              JSON.stringify('[data-preset-apply="' + PRESET + '"]') +
              '); if (!b) return 0; b.click(); return 1; })()',
          );
          await napMs(700);
          // 把设置收起来，否则它挡着卡片（不收也能量，但截图会看不清）
          await clickIn('(() => { const c = document.querySelector(".drawer__mask"); if (c) c.click(); return 1; })()');
          await napMs(400);
          const afterPreset = await readCard();

          console.log(
            'SMOKE_MAXSYNC ' +
              JSON.stringify({ card: CARD, preset: PRESET, before, maxed, afterMax, opened, tabbed, applied, afterPreset }),
          );
        }

        /*
         * ---------- 鼠标扫过卡片网格：JIKAI_PERF=1 时才跑 ----------
         *
         * 「卡」最可能藏在两处，而这两处都只能由主进程来量：
         *   ① 卡片 hover 时的 transform + 阴影（82 张卡，每移过去一张就重绘一层）；
         *   ② 徽标与星标上的 backdrop-filter: blur(4px) —— 它们**不在** data-frost 名单里，
         *      理由写在 styles.css 里（底下压着封面原图、模糊看得见、当时实测几乎不花帧）。
         *      「当时」是多久以前？所以这里顺手做一次 A/B：同一段扫动，
         *      把 backdrop-filter 全关掉再量一遍。数字说话，不靠记忆。
         *
         * ⚠️ 不能用派发鼠标事件来假装 hover。CSS 的 :hover 认的是**真实命中状态**，
         * 派发 mouseover 事件改不了它 —— 那样量出来的「hover 场景」里一个卡片都没 hover。
         * 所以扫动由主进程发 `sendInputEvent({type:'mouseMove'})`，采帧的活交给渲染层。
         */
        let perfHover = null;
        if (process.env.JIKAI_PERF) {
          const nap = (ms) => new Promise((r) => setTimeout(r, ms));
          const gridBox = await win.webContents
            .executeJavaScript(
              `(() => {
                 const g = document.querySelector('.cardgrid') || document.querySelector('.queue') || document.querySelector('.board');
                 if (!g) return { ok: 0 };
                 const r = g.getBoundingClientRect();
                 if (r.width < 40 || r.height < 40) return { ok: 0, why: '太小', w: Math.round(r.width), h: Math.round(r.height) };
                 return { ok: 1, left: r.left, top: r.top, width: r.width, height: r.height, cards: g.querySelectorAll('.card, .queue__row, .catchup').length };
               })()`,
            )
            .catch(() => ({ ok: 0 }));

          if (gridBox && gridBox.ok) {
            const install = `(() => {
              const S = { gaps: [], long: [], alive: true };
              window.__hoverPerf = S;
              /*
               * 数一数这次扫动到底换过几次「卡片命中」。
               * 没有这个数就没法判断量到的是什么：如果扫了半天一直在空隙里
               * 或者一直停在同一张卡上，那这些帧数据回答的不是「hover 卡片要多少帧」。
               * 监听 mouseover 是可以的 —— 它是真鼠标事件，会跟着 sendInputEvent 走；
               * （不能用它来**制造** hover，但用它来**数** hover 没问题。）
               */
              const g = document.querySelector('.cardgrid') || document.querySelector('.queue') || document.querySelector('.board');
              if (g && !g.__hoverCounter) {
                g.__hoverCounter = true;
                g.addEventListener('mouseover', function (e) {
                  const c = e.target && e.target.closest ? e.target.closest('.card, .queue__row, .catchup') : null;
                  if (c) window.__hoverHits = (window.__hoverHits || 0) + 1;
                });
              }
              try {
                S.po = new PerformanceObserver(function (l) {
                  const es = l.getEntries();
                  for (let i = 0; i < es.length; i += 1) S.long.push(es[i].duration);
                });
                S.po.observe({ entryTypes: ['longtask'] });
              } catch (e) { S.po = null; }
              let last = performance.now();
              const step = function () {
                const t = performance.now();
                S.gaps.push(t - last);
                last = t;
                if (S.alive) requestAnimationFrame(step);
              };
              requestAnimationFrame(step);
              return 1;
            })()`;

            const collect = `(() => {
              const S = window.__hoverPerf;
              if (!S) return null;
              S.alive = false;
              if (S.po) S.po.disconnect();
              const stat = function (arr) {
                if (!arr.length) return { frames: 0, p50: 0, p95: 0, max: 0 };
                const s = arr.slice().sort(function (a, b) { return a - b; });
                const at = function (p) { return Number(s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(2)); };
                return { frames: s.length, p50: at(0.5), p95: at(0.95), max: Number(s[s.length - 1].toFixed(2)) };
              };
              /* gaps 的第一个是「安装到现在」，把首帧算进去会把 p95 抬高一截 */
              const gaps = S.gaps.slice(1);
              const long = S.long.slice();
              const sum = long.reduce(function (a, b) { return a + b; }, 0);
              const out = stat(gaps);
              out.longTasks = long.length;
              out.longSum = Number(sum.toFixed(1));
              out.longMax = long.length ? Number(Math.max.apply(null, long).toFixed(1)) : 0;
              out.hovered = Number(window.__hoverHits || 0);
              return out;
            })()`;

            /*
             * 扫动路径：横着扫几行。步长取网格宽度的 1/7、行高按高度分 6 行 ——
             * 目的不是「把每一张卡都 hover 一遍」，而是**一直在换命中目标**：
             * hover 的开销大头是「换一张卡 → 旧的撤掉样式、新的加上样式」那一下重绘。
             */
            const sweep = async () => {
              const cols = 7;
              const rows = 6;
              await win.webContents.executeJavaScript(`(() => { window.__hoverHits = 0; return 1; })()`).catch(() => null);
              for (let ri = 0; ri < rows; ri += 1) {
                for (let ci = 0; ci < cols; ci += 1) {
                  const x = Math.round(gridBox.left + (gridBox.width * (ci + 0.5)) / cols);
                  const y = Math.round(gridBox.top + (gridBox.height * (ri + 0.5)) / rows);
                  win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
                  await nap(45);
                }
              }
            };

            const runOnce = async () => {
              await win.webContents.executeJavaScript(install).catch(() => null);
              await nap(120);
              await sweep();
              await nap(160);
              return win.webContents.executeJavaScript(collect).catch(() => null);
            };

            perfHover = await runOnce();
            if (perfHover) perfHover.cards = gridBox.cards;

            /* A/B：把 backdrop-filter 全关掉，同一段扫动再走一遍 */
            const noBlur = await win.webContents
              .executeJavaScript(`(() => {
                const t = document.createElement('style');
                t.id = 'perf-no-blur';
                t.textContent = '*{backdrop-filter:none !important;}'
                document.head.appendChild(t);
                return 1;
              })()`)
              .then(() => runOnce())
              .catch(() => null);
            await win.webContents
              .executeJavaScript(`(() => { const t = document.getElementById('perf-no-blur'); if (t) t.remove(); return 1; })()`)
              .catch(() => null);
            if (perfHover && noBlur) perfHover.noBlur = noBlur;

            // 把鼠标挪回左上角：后面的场景不该在一个「正在 hover 某张卡」的状态下量
            win.webContents.sendInputEvent({ type: 'mouseMove', x: 2, y: 2 });
            await nap(200);
          }
        }

        const st = await coverCache?.stats?.();
        const probe = await win.webContents.executeJavaScript(
          `(async () => {
             // 跨季搜索只在自检**指定了搜索词**时才模拟输入 ——
             // 别的视图也走这段探针，平白往输入框里塞字会干扰它们的断言。
             const KW = ${JSON.stringify(process.env.JIKAI_SMOKE_SEARCH || '')};
             const box = document.querySelector('[data-search-input]');
             if (KW && box) {
               // React 的受控 input 不能直接赋 value —— 那样绕过了 onChange，
               // 界面根本不会更新。要用原型上的原生 setter，再派发一个 input 事件。
               const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
               setter.call(box, KW);
               box.dispatchEvent(new Event('input', { bubbles: true }));
               await new Promise((r) => setTimeout(r, 300));
             }

             /*
              * ---------- 壁纸取景框拖动：JIKAI_SMOKE_WPDRAG=1 ----------
              *
              * 这条链是 设置面板 → 指针拖动 → 像素换算 → store → 防抖落盘 → IPC → 磁盘。
              * 除了「框画出来了」，后面每一环**都只在真壳里存在**：单测和 SSR 只能验到
              * 换算是对的、框渲染出来了，验不了「真的按住拖一下，位置会不会落盘」。
              * 合成 pointer 事件在真 Chromium 里跑得通，所以这一段能真的走到底 ——
              * 桌面端专属的东西，只能由桌面端自己回答。
              *
              * 走「,」快捷键打开设置，不是去点某个按钮：跟用户按一下是同一件事，
              * 也顺带把快捷键那条路一起验了。
              */
             const WPDRAG = ${JSON.stringify(process.env.JIKAI_SMOKE_WPDRAG || '')};
             let wpdrag = null;
             if (WPDRAG) {
               const nap = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
               const attr = function (el, a) { const v = el && el.getAttribute(a); return v == null || v === '' ? null : Number(v); };
               window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', bubbles: true }));
               await nap(600);
               const frame = document.querySelector('[data-wp-frame]');
               if (!frame) {
                 wpdrag = { frame: 0 };
               } else {
                 const r = frame.getBoundingClientRect();
                 const img = (frame.getAttribute('data-wp-img') || '').split('x').map(Number);
                 const before = { x: attr(frame, 'data-wp-x'), y: attr(frame, 'data-wp-y') };
                 const off = frame.classList.contains('is-off');
                 /*
                  * 照着原图比例算出两个方向各还剩多少余量 —— 只有有余量的那个方向拖得动。
                  * 余量太小（这张图在框里几乎铺满）就**不拖**：宁可让脚本报「选不出可拖的轴」，
                  * 也不要拖出一个被取整误差淹没的数字，然后让人去改本来正确的换算。
                  */
                 let over = { x: 0, y: 0 };
                 if (img.length === 2 && img[0] > 0 && img[1] > 0) {
                   const sc = Math.max(r.width / img[0], r.height / img[1]);
                   over = {
                     x: Math.max(0, Math.round((img[0] * sc - r.width) * 10) / 10),
                     y: Math.max(0, Math.round((img[1] * sc - r.height) * 10) / 10),
                   };
                 }
                 const room = Math.max(over.x, over.y);
                 const dragAxis = room < 10 ? 'none' : (over.y > over.x ? 'y' : 'x');
                 // 拖「余量的四分之一」：期望位置正好走 25 个百分点。
                 // 不留最小像素数 —— 留了的话小余量下会拖过头，断言就变成假红。
                 const dist = dragAxis === 'none' ? 0 : Math.round(room * 25) / 100;
                 const vx = dragAxis === 'x' ? dist : 0;
                 const vy = dragAxis === 'y' ? dist : 0;
                 const at = function (dx, dy) {
                   return {
                     bubbles: true, cancelable: true, composed: true,
                     pointerId: 1, pointerType: 'mouse', isPrimary: true,
                     button: 0, buttons: 1,
                     clientX: r.left + r.width / 2 + dx,
                     clientY: r.top + r.height / 2 + dy,
                   };
                 };
                 if (dragAxis !== 'none') {
                   frame.dispatchEvent(new PointerEvent('pointerdown', at(0, 0)));
                   await nap(80);
                   window.dispatchEvent(new PointerEvent('pointermove', at(vx, vy)));
                   await nap(80);
                   window.dispatchEvent(new PointerEvent('pointerup', at(vx, vy)));
                   await nap(1400); // 防抖 400ms 落盘，留足余量
                 }
                 wpdrag = {
                   frame: 1,
                   off: off,
                   box: Math.round(r.width) + 'x' + Math.round(r.height),
                   axis: dragAxis,
                   room: room,
                   dist: dist,
                   overflow: over,
                   before: before,
                   after: { x: attr(frame, 'data-wp-x'), y: attr(frame, 'data-wp-y') },
                   hint: (document.querySelector('[data-wp-hint]') || {}).textContent || null,
                 };
                 // 收拾干净：后面几组场景不该在设置抽屉底下跑
                 const closer = document.querySelector('.settings .window__btn');
                 if (closer) closer.click();
                 await nap(250);
               }
             }

             /*
              * ---------- 性能测量：JIKAI_PERF=1 时才跑 ----------
              *
              * 「卡」是个感觉，没法直接断言，但可以量：主线程一忙，requestAnimationFrame
              * 的间隔就会被撑开。所以这里在几种典型操作期间采帧间隔，再看长任务(>50ms)的
              * 条数与总时长。两处细节是必须的：
              *
              *   ① **必须先量、再改**。凭「哪里看着慢」去优化，改完也不知道有没有用。
              *   ② **要做 A/B**：跑完一遍之后把所有 backdrop-filter 关掉，同一组场景再跑
              *      一遍。毛玻璃（尤其是好几层叠在一起）值不值这些帧，只有这组对照答得了，
              *      读代码读不出来。
              *
              * 注意这整段是塞进 executeJavaScript 的字符串：里面**不能出现反引号**，
              * 模板串会被外层提前截断，而报错长得像「语法错误」，看不出是嵌套问题。
              */
             const PERF = ${JSON.stringify(process.env.JIKAI_PERF || '')};
             let perf = null;
             if (PERF) {
               const scenarios = {};
               const longTasks = [];
               let po = null;
               try {
                 po = new PerformanceObserver(function (l) {
                   const es = l.getEntries();
                   for (let i = 0; i < es.length; i += 1) longTasks.push(es[i].duration);
                 });
                 po.observe({ entryTypes: ['longtask'] });
               } catch (e) { po = null; }

               const stat = function (arr) {
                 if (!arr.length) return { frames: 0, p50: 0, p95: 0, max: 0 };
                 const s = arr.slice().sort(function (a, b) { return a - b; });
                 const at = function (p) { return Number(s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(2)); };
                 return { frames: s.length, p50: at(0.5), p95: at(0.95), max: Number(s[s.length - 1].toFixed(2)) };
               };

               const measure = async function (name, fn) {
                 longTasks.length = 0;
                 const gaps = [];
                 let alive = true;
                 let last = performance.now();
                 const step = function () {
                   const t = performance.now();
                   gaps.push(t - last);
                   last = t;
                   if (alive) requestAnimationFrame(step);
                 };
                 requestAnimationFrame(step);
                 const t0 = performance.now();
                 await fn();
                 await new Promise(function (r) { setTimeout(r, 160); });
                 alive = false;
                 const wall = Math.round(performance.now() - t0);
                 const long = longTasks.slice();
                 const sum = long.reduce(function (a, b) { return a + b; }, 0);
                 scenarios[name] = Object.assign(stat(gaps), {
                   wall: wall,
                   longTasks: long.length,
                   longSum: Number(sum.toFixed(1)),
                   longMax: long.length ? Number(Math.max.apply(null, long).toFixed(1)) : 0,
                 });
               };

               const pbox = document.querySelector('[data-search-input]');
               const pset = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
               const WORDS = ['鬼', '鬼灭', '鬼灭之', '鬼灭之刃', '进', '进击', '进击的', '进击的巨',
                 '刀', '刀剑', '刀剑神', '刀剑神域', '间', '间谍', '间谍过', '赛', '赛马', '赛马娘'];
               const typeOnce = async function () {
                 if (!pbox) return;
                 for (let i = 0; i < WORDS.length; i += 1) {
                   pset.call(pbox, WORDS[i]);
                   pbox.dispatchEvent(new Event('input', { bubbles: true }));
                   await new Promise(function (r) { requestAnimationFrame(r); });
                 }
                 pset.call(pbox, '');
                 pbox.dispatchEvent(new Event('input', { bubbles: true }));
               };

               const pgrid = document.querySelector('.cardgrid');
               const pscroll = pgrid ? (pgrid.closest('.window__body') || pgrid.parentElement) : null;
               const scrollOnce = async function () {
                 if (!pscroll) return;
                 for (let i = 0; i < 26; i += 1) {
                   pscroll.scrollTop = i * 46;
                   await new Promise(function (r) { requestAnimationFrame(r); });
                 }
                 pscroll.scrollTop = 0;
                 await new Promise(function (r) { requestAnimationFrame(r); });
               };

               /* 详情抽屉：点一次标题把抽屉打开，滚它的内容区，再关掉 */
               const drawerOnce = async function () {
                 const t = document.querySelector('.card__title');
                 if (t) t.click();
                 await new Promise(function (r) { setTimeout(r, 450); });
                 const body = document.querySelector('.drawer__body');
                 if (body) {
                   for (let i = 0; i < 22; i += 1) {
                     body.scrollTop = i * 44;
                     await new Promise(function (r) { requestAnimationFrame(r); });
                   }
                 }
                 // ⚠️ 必须关掉再走：留着抽屉的话，后面那几组「滚动 / 输入」
                 // 全都是在遮罩底下跑的，量出来的根本不是同一件事。
                 const close = document.querySelector('.drawer__close');
                 if (close) close.click();
                 await new Promise(function (r) { setTimeout(r, 300); });
               };

               /*
                 ⚠️ 只跑一遍。这里原来写了两遍（第一遍没有 drawer），
                 而 scenarios 是按名字存的 —— 第二遍把第一遍整个盖掉，
                 第一遍纯粹是白跑两秒多。性能自检自己拖时间，最容易让人不想跑它。
               */
               await measure('idle', function () { return new Promise(function (r) { setTimeout(r, 1200); }); });
               await measure('scroll', scrollOnce);
               await measure('typing', typeOnce);
               await measure('drawer', drawerOnce);

               /*
                 鼠标扫过卡片网格（数字由主进程量，走 sendInputEvent）。
                 为什么这一条不能像别的场景一样在这里量：CSS 的 :hover 只认
                 **真实命中状态**，派发 mouseover 事件不会让它变 ——
                 而卡片 hover 时有 transform + 阴影，82 张卡里每一张还压着一个
                 backdrop-filter 的徽标，移动时每一帧都可能重绘两层模糊。
                 所以这一段由主进程发真鼠标事件、这里只负责采帧。
               */
               const hoverPerf = ${JSON.stringify(perfHover || null)};
               if (hoverPerf) {
                 scenarios.hover = hoverPerf;
                 if (hoverPerf.noBlur) scenarios.hover_noBlur = hoverPerf.noBlur;
               }

               /*
                 A/B 组。全关那条回答「毛玻璃一共值多少帧」，
                 另外两条回答「是哪一层的锅」—— 只关窗口卡片、只关侧栏顶栏。
                 不分开量的话，修的时候只能整片砍掉，观感白白牺牲。
                 （注意这段注释里不能出现反引号：外层就是反引号模板串，
                   多一个反引号会把字符串劈成两半，拼出 字符串*字符串 这种合法但错的
                   表达式，结果是 SMOKE_OK NaN —— 连语法检查都发现不了。）
               */
               const frostWas = document.documentElement.dataset.frost;
               const VARIANTS = [
                 { suffix: '_frostOn', attr: 'on', css: '' },
                 { suffix: '_noBlur', attr: null, css: '*{backdrop-filter:none !important;}' },
               ];
               for (let vi = 0; vi < VARIANTS.length; vi += 1) {
                 const v = VARIANTS[vi];
                 const tag = document.createElement('style');
                 tag.textContent = v.css;
                 if (v.css) document.head.appendChild(tag);
                 if (v.attr) document.documentElement.dataset.frost = v.attr;
                 await new Promise(function (r) { setTimeout(r, 220); });
                 await measure('scroll' + v.suffix, scrollOnce);
                 await measure('typing' + v.suffix, typeOnce);
                 await measure('drawer' + v.suffix, drawerOnce);
                 if (tag.parentNode) tag.remove();
                 document.documentElement.dataset.frost = frostWas;
                 await new Promise(function (r) { setTimeout(r, 220); });
               }

               if (po) po.disconnect();
               perf = Object.assign({
                 nodes: document.querySelectorAll('*').length,
                 covers: document.querySelectorAll('.cover').length,
                 cards: document.querySelectorAll('.card').length,
                 // 毛玻璃到底开没开 —— 这是「卡顿修好了没有」的**结构性**判据：
                 // 不可见的那几层该关掉，而不是靠帧数去倒推（帧数随机器变，属性不随）。
                 frost: document.documentElement.dataset.frost || '(没设)',
               }, scenarios);
             }

             return JSON.stringify({
             view: (globalThis.location?.hash || '').replace(/^#\\//, '').split('?')[0],
             rows: document.querySelectorAll('.tier-row__label').length,
             tiles: document.querySelectorAll('.tier-item__art').length,
             pool: document.querySelectorAll('.tier-pool__grid .tier-item').length,
             cached: document.querySelectorAll('.tier-item[data-cover="cache"]').length,
             remote: document.querySelectorAll('.tier-item[data-cover="remote"]').length,
             // 通用封面计数（本季 / 时间表 / 追番 / 补番 / 日记都用 <Cover>，不是 tier-item）。
             // 分三档数：缓存 / 直连 / 色块 —— 「图还没加载完」和「压根没取到」长得一样，
             // 只有分开数才能判断降级路径到底走没走。
             coverCache: document.querySelectorAll('.cover[data-cover="cache"]').length,
             coverRemote: document.querySelectorAll('.cover[data-cover="remote"]').length,
             coverNone: document.querySelectorAll('.cover[data-cover="none"]').length,
             library: (window.jikai && typeof window.jikai.getCover === 'function') ? 'yes' : 'no',
             coverGroups: ${JSON.stringify((st?.groups ?? []).length)},
             coverBytes: ${JSON.stringify(st?.totalBytes ?? 0)},
             diaryNav: document.querySelectorAll('.sidenav__item[data-nav="diary"]').length,
             diaryView: document.querySelectorAll('[data-diary-view]').length,
             diaryRows: document.querySelectorAll('[data-diary-row]').length,
             diaryEntries: document.querySelectorAll('[data-diary-at]').length,
             diaryInputs: document.querySelectorAll('[data-diary-for]').length,
             diaryAvgMine: document.querySelector('[data-diary-avg-mine]')?.getAttribute('data-diary-avg-mine') ?? null,
             diaryAvgBgm: document.querySelector('[data-diary-avg-bgm]')?.getAttribute('data-diary-avg-bgm') ?? null,
             diaryRowTitles: [...document.querySelectorAll('[data-diary-row] .diary__title')].map((e) => e.textContent),
             diaryLastRating: (document.querySelector('.diary-input__cmp .diary-input__mine')?.textContent ?? '').replace(/[^0-9]/g, '') || null,
             // 季度报告：块数 / 封面墙的图块数 / 素材面板行数。
             // 这三样在截图里「空白」和「没渲染」长得一模一样，只有数得出来才判得了。
             reportNav: document.querySelectorAll('.sidenav__item[data-nav="report"]').length,
             reportView: document.querySelectorAll('[data-report-view]').length,
             reportCanvas: document.querySelectorAll('[data-report-canvas]').length,
             reportCanvasWidth: document.querySelector('[data-report-canvas]')?.getAttribute('data-report-canvas-width') ?? null,
             reportBlocks: document.querySelectorAll('[data-report-block]').length,
             reportWallTiles: document.querySelectorAll('[data-report-wall-tile]').length,
             reportPool: Number(document.querySelector('[data-report-pool-rows]')?.getAttribute('data-report-pool-rows') ?? -1),
             reportAddButtons: document.querySelectorAll('[data-report-add]').length,
             // 追番历程：总数 / 有时间戳的 / 没时间戳的 / 事件条数。
             // 「时间轴是空的」和「时间戳一条都没记上」在截图里长得一模一样 ——
             // 只有把 untimed 单独数出来，才分得清是「还没到那天」还是「记漏了」。
             historyNav: document.querySelectorAll('.sidenav__item[data-nav="history"]').length,
             historyView: document.querySelectorAll('[data-history-view]').length,
             historyTotal: Number(document.querySelector('[data-history-total]')?.getAttribute('data-history-total') ?? -1),
             historyTracking: Number(document.querySelector('[data-history-tracking]')?.getAttribute('data-history-tracking') ?? -1),
             historyUntimed: Number(document.querySelector('[data-history-untimed]')?.getAttribute('data-history-untimed') ?? -1),
             historyFinished: Number(document.querySelector('[data-history-finished]')?.getAttribute('data-history-finished') ?? -1),
             historyEvents: document.querySelectorAll('[data-history-event]').length,
             historyDays: [...document.querySelectorAll('[data-history-finish-days]')].map((e) => Number(e.getAttribute('data-history-finish-days'))),
             // 跨季搜索：输入框在不在 / 面板条数 / 索引可用状态 / 命中名。
             // 「下拉没弹」和「搜出来是空的」在截图里长得一模一样，只有分开数才判得了。
             searchInput: document.querySelectorAll('[data-search-input]').length,
             qsearchBox: document.querySelectorAll('[data-qsearch]').length,
             qsearchPanel: Number(document.querySelector('[data-qsearch-panel]')?.getAttribute('data-qsearch-panel') ?? -1),
             qsearchReady: document.querySelector('[data-qsearch-panel]')?.getAttribute('data-qsearch-ready') ?? null,
             qsearchItems: document.querySelectorAll('[data-qsearch-item]').length,
             qsearchNames: [...document.querySelectorAll('[data-qsearch-item] .qsearch__name')].map((e) => e.textContent),
             wpdrag: wpdrag,
             perf: perf,
           });
          })()`,
        ).catch((e) => `{"error":${JSON.stringify(String(e?.message ?? e))}}`);
        const img = await win.webContents.capturePage();
        fs.writeFileSync(SMOKE_PNG, img.toPNG());
        /*
         * ⚠️ 这一层判断不是多余的：探针字符串本身有问题时（比如注释里混进反引号，
         * 把模板串劈成两半），`executeJavaScript` 会**成功返回一个数字**（字符串相乘
         * 得到 NaN），于是日志是 `SMOKE_OK NaN`，看着像探针坏了却指不到原因。
         * 而 `node --check` 也拦不住 —— 劈出来的
         * `字符串 * 字符串` 是合法 JS。只有在这里卡一道「必须是字符串」才说得清。
         */
        if (typeof probe !== 'string') {
          console.log(`SMOKE_FAIL 探针没有返回字符串（拿到 ${typeof probe}：${String(probe)}）—— 检查探针源码里有没有多余的反引号`);
        } else {
          console.log(`SMOKE_OK ${probe}`);
        }
      } catch (err) {
        console.log(`SMOKE_FAIL ${err?.message ?? String(err)}`);
      } finally {
        isQuitting = true;
        app.exit(0);
      }
    });
  }

  // 自检时会指定视图（hash 路由），不然只会停在默认的本季番剧页
  const smokeView = SMOKE_PNG ? (process.env.JIKAI_SMOKE_VIEW || 'tier') : '';
  const smokeSeason = process.env.JIKAI_SMOKE_SEASON || '';
  const hash = smokeView ? `/${smokeView}${smokeSeason ? `?q=${smokeSeason}` : ''}` : null;

  if (DEV_URL) {
    win.loadURL(hash ? `${DEV_URL.replace(/\/$/, '')}/#${hash}` : DEV_URL);
  } else {
    const file = path.join(__dirname, '..', 'dist', 'index.html');
    trace(`c2-load-file:${fs.existsSync(file) ? 'exists' : 'MISSING'}`);
    win.loadFile(file, hash ? { hash } : undefined);
  }

  // 关窗不退进程：提醒要能继续跑，所以先藏到托盘
  win.on('close', (event) => {
    const closeToTray = lastTrayState?.closeToTray !== false;
    if (!isQuitting && closeToTray && tray) {
      event.preventDefault();
      win.hide();
    }
  });

  win.on('minimize', (event) => {
    if (lastTrayState?.minimizeToTray === false || !tray) return;
    event.preventDefault();
    win.hide();
  });

  // 页面内的普通链接一律交给系统浏览器，不在应用里开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) {
      event.preventDefault();
      if (isSafeUrl(url)) shell.openExternal(url);
    }
  });

  win.on('closed', () => {
    mainWindow = null;
  });

  /**
   * 渲染进程没了就自愈一次（计划 G5）。
   *
   * 症状是「窗口开着、里面全白」—— 用户看到的是一个活着的空壳，
   * 而控制台里只有一句 `Renderer process killed`。这种故障在浏览器壳里不存在
   * （浏览器会重新加载标签页），所以它是**桌面端独有的盲区**。
   *
   * 三条不能省的细节：
   *  1. 重开前必须 `releaseSingleInstanceLock()` —— 否则新进程认为自己是第二份，直接退出，
   *     表现是「点了没反应」，比崩了还难查。
   *  2. **只重试一次**（用 argv 里的标记判断）。不设上限会在起不来的机器上无限重启。
   *  3. 降级不等于默认：`--no-sandbox` 只在**已经崩过一次**之后才加，正常机器保持沙盒开着。
   */
  win.webContents.on('render-process-gone', (_e, details) => {
    trace(`gone:${details?.reason}`);
    // clean-exit 是正常关闭（比如关闭窗口），不该触发重启
    if (details?.reason === 'clean-exit') return;
    if (isQuitting || SMOKE_PNG || IPC_SMOKE) return;
    if (process.argv.includes(RETRY_FLAG)) {
      console.warn(`[jikai] 渲染进程再次崩溃（${details?.reason}），降级后仍起不来，不再重试`);
      return;
    }
    console.warn(`[jikai] 渲染进程崩溃（${details?.reason}），关沙盒重开一次`);
    app.releaseSingleInstanceLock();
    isQuitting = true;
    try {
      /**
       * 用 `app.relaunch()`，不要自己 `spawn`。
       *
       * 这里绕过一大圈弯路，把结论钉住：
       *   自己 spawn（无论 `detached` 还是包一层 `cmd /c start`）**都会失败** ——
       *   `detached` 的那份会跟着父进程的作业链一起被硬杀，
       *   `cmd /c start` 那套在这个环境里压根拉不起进程（标记文件是空的）。
       *   Electron 自带的 relaunch 是唯一能走的：它等当前实例退干净了才起新实例。
       *
       * ⚠️ 但**不能同时又 spawn 又 relaunch** —— 两个实例会去抢单实例锁，
       *   症状是重开的进程只跑完主脚本第一行就没了，看着像 relaunch 坏了。
       *   这个假象让我一度把正确写法改掉，绕了很久。
       *
       * `releaseSingleInstanceLock()` 必须在前面：新实例要能拿到锁，
       * 否则它认为自己是「第二份」，直接退出。
       */
      trace('will-relaunch');
      app.relaunch({ args: [APP_ROOT, RETRY_FLAG] });
      trace('after-relaunch-call');
    } catch (err) {
      console.warn(`[jikai] 重开失败：${err?.message ?? String(err)}`);
    }
    app.quit();
  });

  return win;
}

function showWindow() {
  if (!mainWindow) {
    mainWindow = createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

function toggleWindow() {
  if (mainWindow && mainWindow.isVisible() && !mainWindow.isMinimized()) {
    mainWindow.hide();
    return;
  }
  showWindow();
}

function sendCommand(cmd) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:command', cmd);
  else showWindow();
}

// ---------- 开机自启 ----------

/**
 * 开发模式下要显式带上项目目录，否则注册的是 electron.exe 本身，
 * 开机后会弹出一个空壳。
 */
function autoLaunchArgs() {
  const args = ['--hidden'];
  if (!app.isPackaged) args.unshift(app.getAppPath());
  return args;
}

function getAutoLaunch() {
  try {
    const s = app.getLoginItemSettings({ args: autoLaunchArgs() });
    return { openAtLogin: Boolean(s.openAtLogin), supported: true, args: autoLaunchArgs() };
  } catch (err) {
    return { openAtLogin: false, supported: false, error: err?.message ?? String(err) };
  }
}

function setAutoLaunch(enabled) {
  try {
    const args = autoLaunchArgs();
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      path: process.execPath,
      args,
    });
    const now = getAutoLaunch();
    return { ...now, requested: Boolean(enabled) };
  } catch (err) {
    return { openAtLogin: false, supported: false, error: err?.message ?? String(err) };
  }
}

// ---------- 全局快捷键 ----------

function setGlobalHotkey(spec) {
  const want = String(spec ?? '').trim();
  if (want === currentHotkey) return { ok: Boolean(currentHotkey), spec: currentHotkey, changed: false };

  if (currentHotkey) {
    try { globalShortcut.unregister(currentHotkey); } catch { /* 本来就没注册上 */ }
    currentHotkey = '';
  }
  if (!want) return { ok: true, spec: '', changed: true };

  try {
    const ok = globalShortcut.register(want, () => toggleWindow());
    if (!ok) return { ok: false, spec: '', reason: `${want} 被别的程序占用了`, changed: true };
    currentHotkey = want;
    return { ok: true, spec: want, changed: true };
  } catch (err) {
    return { ok: false, spec: '', reason: err?.message ?? String(err), changed: true };
  }
}

// ---------- IPC 冒烟 ----------

/** 1×1 的 PNG，用来验「导出落盘」这条链路：够小，但仍是合法 PNG（会校验文件头） */
const SMOKE_PNG_DATAURL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

/**
 * 一张 1×1 的最小 JPEG，给本地 HTTP 服务当「远端封面」用。
 * 必须是**真能解码的图** —— cover:warm 里若存的图无法解码，
 * 界面读出来就是一张黑框，而 handler 全程不报错，这条断言就失去意义了。
 */
const SMOKE_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDs0NDP/wAALCAABAAEBAREA/8QAFAABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAA/AKgA/9k=',
  'base64',
);

/**
 * 把主进程所有 IPC handler 真跑一遍。
 *
 * 三条铁律：
 *   1. **不碰真实数据** —— 会改 state / wallpaper / nameIndex 的，先备份到临时目录，
 *      测完全部还原。冒烟跑崩了也不能把用户的档位排布弄没。
 *   2. **有副作用的只验形状不真执行** —— 开机自启（写注册表）、全局快捷键、
 *      自动更新（要联网）都只走「肯定安全」的那条分支。
 *   3. **不真开外部浏览器** —— `shell:open` 只测「危险协议被挡住」，
 *      挡住了就等于这条链路是通的（真开一次浏览器对冒烟没有任何额外信息量）。
 */
async function runIpcSmoke() {
  const results = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jikai-ipc-'));

  const record = (name, ok, note = '') => results.push({ name, ok: Boolean(ok), note: String(note) });

  /** 调真实 handler；抛异常算 FAIL 而不是让整个冒烟崩掉 */
  const call = async (channel, ...args) => handlers[channel](null, ...args);

  const step = async (name, fn) => {
    if (typeof fn !== 'function') {
      record(name, false, 'handler 没注册');
      return null;
    }
    try {
      const r = await fn();
      return r;
    } catch (err) {
      record(name, false, err?.message ?? String(err));
      return null;
    }
  };

  // ---- 会把真实文件改掉的，先备份 ----
  const backup = (file) => {
    try {
      if (fs.existsSync(file)) fs.copyFileSync(file, path.join(tmp, `backup-${path.basename(file)}`));
      return true;
    } catch {
      return false;
    }
  };
  const restore = (file) => {
    try {
      const b = path.join(tmp, `backup-${path.basename(file)}`);
      if (fs.existsSync(b)) fs.copyFileSync(b, file);
      return true;
    } catch {
      return false;
    }
  };

  const statePath = stateFile();
  const wallPath = wallpaperFile();
  const indexPath = nameIndexFile();
  backup(statePath);
  backup(wallPath);
  backup(indexPath);

  // ---- 1. 只读的，随便跑 ----
  await step('app:info', async () => {
    const r = await call('app:info');
    record('app:info', r && r.isDesktop === true && typeof r.version === 'string', JSON.stringify(r?.platform));
    /*
     * 自检一定会把 GPU 关掉（文件顶部那一处），所以这里**必须**是 software。
     * 写成「hardware 也行」就成了一条恒真的空气断言 —— 而这个字段的全部价值
     * 恰恰在于它说的跟真实情况一致。
     */
    record('app:info(渲染模式)', r?.render === 'software', `render=${r?.render} 恢复次数=${r?.gpuRecoveries}`);
  });

  await step('app:retry-hardware(自检里必须拒绝重启)', async () => {
    // 测的是**这个按钮不会把自检弄死**：它要真重启，脚本这边看到的是「没反应」，
    // 报出来会是「没打出 IPC_SMOKE_END」，指向一个完全错误的方向。
    const r = await call('app:retry-hardware');
    record('app:retry-hardware(自检里拒绝)', r?.ok === false && /自检/.test(String(r?.error)), `ok=${r?.ok} err=${r?.error}`);
  });

  await step('自检不许碰用户的 boot.json', async () => {
    /*
     * ⚠️ 这个文件里最该有的一条反向断言。
     *
     * 自检的默认 userData 就是**用户本人的档案**（有一条路必须用真实档案，
     * 才能验「封面到底走没走缓存」）。本机真的发生过：自检跑了几次崩溃路径，
     * 就把 `{"phase":"started","degrade":true}` 写进了用户本人的 boot.json，
     * 从此他每次打开都是软件渲染、界面发涩，而没有一条线索指向「是自检干的」。
     *
     * 断言的是「文件根本不该被创建」—— 内容对不对是另一回事，**写了就算污染**。
     */
    /*
     * 判据用「这个进程往 boot.json 写过几次」，而不是「盘上有没有这个文件」——
     * 后者依赖跑之前的状态（用户档案里本来就有一份、而且是脏的），
     * 那样这条断言就变成「跑之前得先干净」，自检不该有这种前提。
     * 次数不依赖任何外部状态：0 就是 0。
     */
    const f = path.join(app.getPath('userData'), 'boot.json');
    const onDisk = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '（没有这个文件）';
    const info = await call('app:info');
    record('自检不许碰用户的 boot.json', Number(info?.bootWrites) === 0, `写盘次数=${info?.bootWrites}；盘上现在是 ${onDisk}`);
  });

  await step('cover:stats', async () => {
    const r = await call('cover:stats');
    record('cover:stats', r && typeof r.totalFiles === 'number', `${r?.totalFiles} 个 / ${r?.totalBytes} 字节`);
  });

  await step('autolaunch:get', async () => {
    const r = await call('autolaunch:get');
    record('autolaunch:get', r && typeof r.openAtLogin === 'boolean', `supported=${r?.supported}`);
  });

  // ---- 2. 封面缓存：只读模式取一张肯定没有的，验证它「不发网络、也不崩」----
  /*
   * 先把冒烟专用的那个组清干净，保证起点是空的。
   *
   * 为什么必须先清：下面有一条「空 group 清理应当返回 removed=0」的断言，
   * 而上一轮若在 warm 之后被打断（超时 / 崩溃 / 手工中断），
   * `covers/__ipc_smoke__` 就会残留一条 —— 于是这次断言红成 removed=1，
   * 看着像清理逻辑坏了，其实是上一轮留下的脏状态（实测真撞上了一次）。
   * **一次测试的结果不该取决于上一次有没有跑干净。**
   */
  await call('cover:clear', { group: '__ipc_smoke__' });

  await step('cover:get(readOnly)', async () => {
    const r = await call('cover:get', {
      group: '__ipc_smoke__',
      url: 'https://lain.bgm.tv/pic/cover/c/00/00/smoke_none.jpg',
      readOnly: true,
    });
    // readOnly 的核心约定是「绝不联网」，所以这里必然是 miss，不能是 hit
    record('cover:get(readOnly)', r && (r.status === 'miss' || r.status === 'error'), `status=${r?.status}`);
  });

  await step('cover:clear(空 group)', async () => {
    const r = await call('cover:clear', { group: '__ipc_smoke__' });
    record('cover:clear(空 group)', r && Number(r.removed) === 0, `removed=${r?.removed}`);
  });

  // ---- 3. 落盘：这是整份冒烟里最值钱的一条 ----
  // v1.1 主打功能是「导出 PNG」，而这一步（弹保存框 + 主进程写盘）在桌面端从未跑过。
  // 这里把 dialog 换成「直接给一个临时路径」，handler 里其余代码原样执行。
  const saveBinTo = path.join(tmp, 'smoke-export.png');
  const realSaveDialog = dialog.showSaveDialog;
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: saveBinTo });

  await step('file:save-binary', async () => {
    const r = await call('file:save-binary', { name: 'smoke-export.png', dataUrl: SMOKE_PNG_DATAURL });
    const onDisk = fs.existsSync(saveBinTo);
    const magic = onDisk ? fs.readFileSync(saveBinTo).subarray(0, 8).toString('hex') : '';
    // PNG 文件头是 89 50 4E 47 0D 0A 1A 0A
    const isPng = magic === '89504e470d0a1a0a';
    record(
      'file:save-binary',
      r?.ok === true && onDisk && isPng,
      `ok=${r?.ok} bytes=${r?.bytes} 落盘=${onDisk} PNG头=${isPng}`,
    );
  });

  await step('file:save-binary(坏 dataUrl)', async () => {
    const r = await call('file:save-binary', { name: 'bad.png', dataUrl: 'not-a-dataurl' });
    // 给坏数据必须明确报失败，不能假装成功 —— 静默成功就是「点了有反应、其实没写文件」
    record('file:save-binary(坏 dataUrl)', r?.ok === false, `error=${r?.error}`);
  });

  const saveTextTo = path.join(tmp, 'smoke-export.json');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: saveTextTo });
  await step('file:save-text', async () => {
    const r = await call('file:save-text', { name: 'smoke.json', text: '{"smoke":1}' });
    const txt = fs.existsSync(saveTextTo) ? fs.readFileSync(saveTextTo, 'utf8') : '';
    record('file:save-text', r?.ok === true && txt === '{"smoke":1}', `落盘内容=${txt.slice(0, 20)}`);
  });

  // 取消保存也要如实回给渲染层（不然界面会一直转圈）
  dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' });
  await step('file:save-text(取消)', async () => {
    const r = await call('file:save-text', { name: 'x.json', text: '{}' });
    record('file:save-text(取消)', r?.ok === false, `error=${r?.error}`);
  });
  dialog.showSaveDialog = realSaveDialog;

  /*
   * 读文件（导入备份用）。
   * 这一条要真读一次盘：`showOpenDialog` 换成「直接给一个临时路径」，
   * handler 里读文件那段原样执行 —— 只验「handler 在不在」是验不出
   * 「路径接没接对、编码对不对」的，而那两种错都要到用户导备份那天才显形。
   */
  const realOpenDialog = dialog.showOpenDialog;
  const readFrom = path.join(tmp, 'smoke-import.json');
  fs.writeFileSync(readFrom, '{"app":"smoke","format":1}', 'utf8');
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [readFrom] });
  await step('file:read-text', async () => {
    const r = await call('file:read-text');
    record(
      'file:read-text',
      r?.ok === true && r?.text === '{"app":"smoke","format":1}' && r?.name === 'smoke-import.json',
      `ok=${r?.ok} name=${r?.name} 内容=${String(r?.text ?? '').slice(0, 24)}`,
    );
  });

  // 取消也要如实回，且**不能**是抛出来的错 —— 取消不是错误
  dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  await step('file:read-text(取消)', async () => {
    const r = await call('file:read-text');
    record('file:read-text(取消)', r?.ok === false && r?.error === '已取消', `error=${r?.error}`);
  });
  dialog.showOpenDialog = realOpenDialog;

  // 太大的文件要拦下来：一口气 readFileSync 会把主进程卡住
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.join(tmp, 'smoke-huge.json')] });
  await step('file:read-text(超大)', async () => {
    fs.writeFileSync(path.join(tmp, 'smoke-huge.json'), Buffer.alloc(33 * 1024 * 1024, 0x20));
    const r = await call('file:read-text');
    record('file:read-text(超大)', r?.ok === false && /太大/.test(String(r?.error)), `error=${String(r?.error).slice(0, 40)}`);
  });
  dialog.showOpenDialog = realOpenDialog;

  /*
   * 导入前的自动备份：路径由主进程定，**不弹框** ——
   * 这一步的意义就是在用户还没反应过来时把状态存住，问他挑哪个目录就来不及了。
   * 文件名要过一遍 basename，别让渲染层用路径穿越写到 userData 外面。
   */
  await step('file:write-backup', async () => {
    const r = await call('file:write-backup', { name: '../../escaped.json', text: '{"pre":1}' });
    const inside = r?.ok === true && typeof r.path === 'string'
      && path.resolve(r.path).startsWith(path.resolve(app.getPath('userData')));
    const wrote = r?.ok === true && fs.existsSync(r.path) && fs.readFileSync(r.path, 'utf8') === '{"pre":1}';
    record('file:write-backup', inside && wrote, `路径=${r?.path} 越界=${!inside} 内容对=${wrote}`);
    try { fs.rmSync(path.dirname(r.path), { recursive: true, force: true }); } catch { /* 清理失败不影响断言 */ }
  });

  // ---- 4. 会改真实文件的：测完还原 ----
  /**
   * ⚠️ 这一条**不能跳过**。
   * `state:write` 是用户所有数据（档位排布、补番进度、设置）落盘的**唯一出口** ——
   * 它坏了的表现不是报错，而是「关掉重开，昨天排的东西全没了」。
   * 之前这里写的是「没有 state.json 就跳过」，等于**最容易坏的这条路永远不测**。
   * 现在改成：原来没有就临时造一个、测完删掉；原来有就原样还原。
   */
  const stateExisted = fs.existsSync(statePath);
  await step('state:read / state:write', async () => {
    const before = await call('state:read');
    const base = before && typeof before === 'object' ? before : {};
    const probe = { ...base, _smokeProbe: { tierlists: { '2026q2': { templateId: 'smoke' } } } };
    const w = await call('state:write', probe);
    const after = await call('state:read');
    const roundTrip = JSON.stringify(after) === JSON.stringify(probe);

    // 还原：原来有就写回去，原来没有就删掉（不能凭空留一个文件）
    // ⚠️ `writeJsonFile(file, null)` 落的是 `{}` 而不是删除 —— 要真删必须自己 rm
    if (stateExisted) await call('state:write', base);
    else
      try {
        fs.rmSync(statePath, { force: true });
      } catch {
        /* 本来就没有 */
      }
    const stillThere = fs.existsSync(statePath);

    record(
      'state:read / state:write',
      w === true && roundTrip && stillThere === stateExisted,
      `写=${w} 往返一致=${roundTrip} 原文件${stateExisted ? '已还原' : `已删除(残留=${stillThere})`}`,
    );
  });

  await step('wallpaper 写 / 清 / 还原', async () => {
    const w = await call('wallpaper:write', { _smoke: true });
    const got = await call('wallpaper:read');
    const cleared = await call('wallpaper:clear');
    const after = await call('wallpaper:read');
    // clear 写的是 {}（不是 null）—— 断言要跟着实现走，别写成「必须是 null」
    const empty = !after || Object.keys(after).length === 0;
    record('wallpaper 写 / 清 / 还原', w === true && got?._smoke === true && cleared === true && empty, `写=${w} 读回=${got?._smoke} 清空=${empty}`);
  });

  await step('nameindex 写 / 清 / 还原', async () => {
    const w = await call('nameindex:write', { _smoke: true, items: [] });
    const got = await call('nameindex:read');
    const cleared = await call('nameindex:clear');
    const after = await call('nameindex:read');
    const empty = !after || Object.keys(after).length === 0;
    record('nameindex 写 / 清 / 还原', w === true && got?._smoke === true && cleared === true && empty, `写=${w} 清空=${empty}`);
  });

  restore(statePath);
  restore(wallPath);
  restore(indexPath);
  record('真实数据已还原', true, `state / wallpaper / nameIndex 各还原一次（备份在 ${tmp}）`);

  // ---- 5. 有副作用的：只走安全的那条分支 ----
  await step('shell:open(危险协议必须被挡)', async () => {
    const bad = await call('shell:open', 'javascript:alert(1)');
    const bad2 = await call('shell:open', 'file:///C:/Windows/win.ini');
    // 真开浏览器对冒烟没额外信息量，但「危险协议被挡住」必须验 —— 这是安全边界
    record('shell:open(危险协议必须被挡)', bad === false && bad2 === false, `js=${bad} file=${bad2}`);
  });

  await step('notify', async () => {
    const r = await call('notify', { title: '冒烟', body: '这条通知可以无视' });
    // 无头环境里通知往往不支持，返回 false 也是**正确**的 —— 这里只要求它不抛
    record('notify', typeof r === 'boolean', `返回值=${r}`);
  });

  await step('hotkey:set(空=解绑，不注册)', async () => {
    const r = await call('hotkey:set', '');
    record('hotkey:set(空=解绑，不注册)', r && typeof r.ok === 'boolean', `ok=${r?.ok} spec=${r?.spec}`);
  });

  await step('update:check(没配地址必须直接拒绝)', async () => {
    const r = await call('update:check', { url: '' });
    // 没配地址还去发请求的话，冒烟就会卡在联网上 —— 这条同时也是「不发请求」的断言
    record('update:check(没配地址必须直接拒绝)', r && (r.ok === false || r.rejected === true), JSON.stringify(r).slice(0, 80));
  });

  await step('net:proxy(设回空)', async () => {
    const r = await call('net:proxy', '');
    record('net:proxy(设回空)', r !== undefined, `返回值=${typeof r}`);
  });

  // ---- 6. 网络：起一个本地服务，让 handler 走完整的网络栈 ----
  // 不本地起服务就只能拿假 URL 测「报错对不对」，那等于没测主路径 ——
  // 而 http:json 正是「更新番剧数据」那条路，一天不用它，用户看到的就是三季前的旧数据。
  let port = 0;
  let server = null;
  try {
    server = await new Promise((resolve, reject) => {
      const s = require('node:http').createServer((req, res) => {
        if (req.url === '/json') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, from: 'smoke' }));
        } else if (req.url === '/img') {
          res.writeHead(200, { 'Content-Type': 'image/jpeg' });
          res.end(SMOKE_JPEG);
        } else {
          res.writeHead(404).end('nope');
        }
      });
      s.on('error', reject);
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    port = server.address().port;
  } catch (err) {
    record('本地 HTTP 服务起得来', false, String(err?.message ?? err));
  }

  if (server) {
    const base = `http://127.0.0.1:${port}`;

    await step('http:json', async () => {
      const r = await call('http:json', { url: `${base}/json`, timeoutMs: 5000 });
      // ⚠️ 成功字段是 `data` 不是 `json`（net.cjs 里两个 fetch 都用 data）
      record('http:json', r?.ok === true && r?.data?.from === 'smoke', `ok=${r?.ok} from=${r?.data?.from}`);
    });

    await step('http:json(404 必须明确失败，不能给空对象)', async () => {
      const r = await call('http:json', { url: `${base}/nope`, timeoutMs: 5000 });
      record('http:json(404)', r && (r.ok === false || r.json === undefined), `ok=${r?.ok}`);
    });

    await step('http:binary(必须能解回原图)', async () => {
      const r = await call('http:binary', { url: `${base}/img`, timeoutMs: 5000 });
      // fetchBinary 给的是 base64（`data`），不是 dataURL —— 拼 dataURL 是 covers.cjs 的事。
      // 所以这里断言「解回的字节与原图逐字节一致」：这才证明二进制没被 UTF-8 解码毁掉。
      // ⚠️ net.cjs 那条注释说的正是这个坑：JPEG 里全是非法 UTF-8 序列，一 toString 图就废了。
      const back = typeof r?.data === 'string' ? Buffer.from(r.data, 'base64') : Buffer.alloc(0);
      const same = back.length === SMOKE_JPEG.length && back.equals(SMOKE_JPEG);
      const isJpeg = back.subarray(0, 2).toString('hex') === 'ffd8' && back.subarray(-2).toString('hex') === 'ffd9';
      record(
        'http:binary(必须能解回原图)',
        r?.ok === true && same && isJpeg,
        `ok=${r?.ok} bytes=${r?.bytes} mime=${r?.mime} 逐字节一致=${same} JPEG结构=${isJpeg}`,
      );
    });

    await step('cover:warm(真下载 + 缓存)', async () => {
      const g = '__ipc_smoke__';
      await call('cover:clear', { group: g });
      const r = await call('cover:warm', {
        group: g,
        urls: [`${base}/img`],
        readOnly: false,
      });
      const got = await call('cover:get', { group: g, url: `${base}/img`, readOnly: true });
      await call('cover:clear', { group: g });
      // warm 完必须能 readOnly 命中 —— 这就是「不断网也能出图」的那条链路
      record('cover:warm(真下载 + 缓存)', !!got?.dataUrl, `warm=${JSON.stringify(r).slice(0, 40)} 只读命中=${!!got?.dataUrl}`);
    });

    await step('tray:state(托盘未建也不能抛)', async () => {
      // 冒烟模式不建托盘，`tray` 是 null —— 这里验的正是那个可选链没漏
      const r = await call('tray:state', { view: 'tier', todayCount: 3 });
      record('tray:state(托盘未建也不能抛)', r === true, `返回值=${r}`);
    });

    await step('autolaunch:set(写回原值)', async () => {
      const cur = await call('autolaunch:get');
      // 写同一个值：语义上是空操作，但**整条写注册表路径都真跑了一遍**
      const r = await call('autolaunch:set', cur?.enabled === true);
      record('autolaunch:set(写回原值)', r !== undefined, `原值=${cur?.enabled} 返回=${JSON.stringify(r).slice(0, 40)}`);
    });

    await step('report:export(隐藏窗口出 PDF 与 PNG)', async () => {
      // 这是桌面专属里最"新"的一条链路：渲染层拼自包含 HTML → 隐藏窗口重新排版 →
      // printToPDF / 分片拼图 → 落盘。链路里任何一环断了都只表现为「点了导出没反应」，
      // 而浏览器壳碰不到它，所以只有在这里真跑一遍才算验过。
      //
      // 喂的是一份最小报告：排版对不对由渲染层的 SSR 断言守着（`render.test.mjs`），
      // 这里要证的只有「真能产出文件，且文件是那个格式」。
      const css = 'body.print{margin:0;background:#101820}'
        + '.report__canvas{width:1220px;box-sizing:border-box;background:#101820;color:#eef2f8;padding:40px;font-size:18px}'
        + '.rb-wall__grid{display:grid;grid-template-columns:repeat(6,1fr);gap:8px}'
        + 'h1{font-size:40px}div.t{height:60px;background:#23324a}';
      const tiles = Array.from({ length: 12 }, () => '<div class="t"></div>').join('');
      const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>冒烟</title>`
        + `<style>${css}</style></head><body class="print"><div class="report">`
        + `<div class="report__canvas" data-report-canvas="1"><h1>季度报告冒烟</h1>`
        + `<div class="rb-wall__grid">${tiles}</div></div></div></body></html>`;

      const prev = process.env.JIKAI_EXPORT_PATH;
      try {
        for (const kind of ['pdf', 'png']) {
          const out = path.join(tmp, `report.${kind}`);
          process.env.JIKAI_EXPORT_PATH = out;
          const r = await call('report:export', { kind, html, width: 1220, name: 'smoke-report' });
          let buf = null;
          try {
            buf = r?.ok ? fs.readFileSync(out) : null;
          } catch { /* 没写出来，下面按失败记 */ }

          // 只看「文件存在且够大」是不够的：写了一半的、或者写成了别的东西，
          // 都能过那一条。文件头才是「这确实是那个格式」的证据。
          const sigOk = kind === 'pdf'
            ? Boolean(buf && buf.subarray(0, 5).toString('latin1') === '%PDF-')
            : Boolean(buf && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47);
          const size = buf?.length ?? 0;
          record(
            `report:export(${kind})`,
            Boolean(r?.ok) && sigOk && size > 1000,
            r?.ok
              ? `${size} 字节 · 文件头${sigOk ? '对' : '不对'} · ${kind === 'pdf'
                ? `内容高 ${r.contentHeight}px`
                : `${r.width}×${r.height} · ${r.slices} 片`}`
              : (r?.error ?? '没有返回'),
          );
        }
      } finally {
        // 这个变量会让**所有**保存跳过对话框，留着会污染后面的步骤
        if (prev === undefined) delete process.env.JIKAI_EXPORT_PATH;
        else process.env.JIKAI_EXPORT_PATH = prev;
      }
    });

    await new Promise((resolve) => server.close(resolve));
  }

  // ⚠️ 反向自检：故意造一条假 FAIL，确认它**真的会被统计进去**。
  // 没有这一条的危害是隐蔽的 —— 如果哪天 `record` 被改坏、所有结果都算 PASS，
  // 冒烟会永远绿着骗人。这里先自证一次「FAIL 是会暴露的」，再把这条从结果里摘掉。
  // 用「前后差值」而不是绝对等于 1 —— 前面若已有真 FAIL，写死 1 会误判自身失效
  const failsBefore = results.filter((r) => !r.ok).length;
  const idx = results.length;
  record('__自检__', false, '这条必须被算成失败');
  const selfCheckCaught = results.filter((r) => !r.ok).length === failsBefore + 1;
  results.splice(idx, 1);
  record(
    '冒烟自身的失败检测',
    selfCheckCaught,
    selfCheckCaught ? '假 FAIL 已被计入，断言是真的' : '❌ 假 FAIL 没被统计，这套断言可能是空的',
  );

  // ---- 汇总 ----
  const failed = results.filter((r) => !r.ok);
  console.log('IPC_SMOKE_BEGIN');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.note ? ` — ${r.note}` : ''}`);
  console.log(`IPC_SMOKE_END ${JSON.stringify({ total: results.length, failed: failed.length })}`);

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch { /* 临时目录 */ }

  return failed.length;
}

// ---------- 启动 ----------

if (!hasSingleInstanceLock) {
  if (CRASH_TEST && process.env.JIKAI_CRASH_MARKER) {
    try {
      fs.appendFileSync(process.env.JIKAI_CRASH_MARKER, 'second-instance-quit\n', 'utf8');
    } catch { /* 测试钩子 */ }
  }
  /*
   * 自检时必须**说清为什么一个字都没打印就走了**。
   * 不说的话，脚本只会报「桌面壳没有打出 SMOKE_OK」，把人往「窗口起不来」
   * 「渲染进程被杀了」那个方向带 —— 而真相是「你有一份还开着的程序」，
   * 只要关掉再来一次就好。本机实测被这条误导过一轮。
   */
  if (SMOKE_PNG) {
    console.log('SMOKE_FAIL 已有实例在运行（单实例锁被占）：自检前先把开着的程序关掉');
  } else if (IPC_SMOKE) {
    // 报成一条 FAIL 而不是「0 条结果」——0 条会被脚本算成「全都过了」，
    // 那是最坏的一种假绿：什么都没验，报表却是绿的。
    console.log('FAIL 单实例锁被占：已有实例在运行，冒烟前先把它关掉');
    console.log('IPC_SMOKE_END {"total":1,"failed":1}');
  }
  app.quit();
} else {
  // Windows 上不设 AppUserModelId，通知会显示成 electron.app.Electron
  app.setAppUserModelId('com.jikai.app');
  writePidFile();
  app.on('will-quit', clearPidFile);

  app.on('second-instance', () => showWindow());

  app.whenReady().then(async () => {
    if (CRASH_TEST && process.env.JIKAI_CRASH_MARKER) {
      try {
        fs.appendFileSync(process.env.JIKAI_CRASH_MARKER, 'r2-ready\n', 'utf8');
      } catch { /* 测试钩子 */ }
    }
    Menu.setApplicationMenu(null);
    trace('p1-menu');
    await netBridge.applyProxy('');
    trace('p2-proxy');

    // ---- IPC ----
    handle('state:read', () => readJsonFile(stateFile()));
    handle('state:write', (_e, state) => writeJsonFile(stateFile(), state));

    handle('wallpaper:read', () => readJsonFile(wallpaperFile()));
    handle('wallpaper:write', (_e, payload) => writeWallpaper(payload));
    handle('wallpaper:clear', () => writeWallpaper(null));

    handle('shell:open', (_e, url) => {
      if (!isSafeUrl(url)) return false;
      shell.openExternal(url);
      return true;
    });

    handle('notify', (_e, { title, body } = {}) => {
      if (!Notification.isSupported()) return false;
      new Notification({ title: String(title ?? '次回'), body: String(body ?? ''), icon: ICON_PNG }).show();
      return true;
    });

    handle('http:json', (_e, payload = {}) => netBridge.fetchJson(payload));
    handle('http:binary', (_e, payload = {}) => netBridge.fetchBinary(payload));

    // ---- 封面缓存 ----
    coverCache = new CoverCache(app.getPath('userData'), {
      fetchBinary: (opts) => netBridge.fetchBinary(opts),
    });

    handle('cover:get', (_e, payload = {}) => coverCache.get(payload));
    handle('cover:stats', () => coverCache.stats());
    handle('cover:clear', (_e, payload = {}) => coverCache.clear(payload || {}));
    handle('cover:warm', async (_e, payload = {}) => {
      return coverCache.warm({
        ...payload,
        // 预热一季动辄几十张，一次性 invoke 会让界面干等；
        // 这里把进度推回去，界面才有得显示。
        onProgress: (p) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('cover:warm-progress', p);
          }
        },
      });
    });

    // ---- 名称索引（单独文件） ----
    handle('nameindex:read', () => readJsonFile(nameIndexFile()));
    handle('nameindex:write', (_e, payload) => writeJsonFile(nameIndexFile(), payload));
    handle('nameindex:clear', () => writeJsonFile(nameIndexFile(), null));

    // 保存二进制文件：导出 PNG 用。渲染层给的是 dataURL，这里剥掉前缀再解码。
    handle('file:save-binary', async (_e, { name = 'jikai.png', dataUrl = '' } = {}) => {
      const m = /^data:([^;,]+)?(;charset=[^;,]+)?;base64,(.*)$/s.exec(String(dataUrl));
      if (!m) return { ok: false, error: '不是合法的 dataURL' };
      const mime = m[1] || 'application/octet-stream';
      const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' })[mime] || 'png';
      const fallback = name.includes('.') ? name : `${name}.${ext}`;
      try {
        const { canceled, filePath } = await dialog.showSaveDialog(mainWindow ?? undefined, {
          title: '导出图片',
          defaultPath: path.join(app.getPath('downloads'), fallback),
          filters: [
            { name: 'PNG 图片', extensions: ['png'] },
            { name: 'JPEG 图片', extensions: ['jpg'] },
            { name: '所有文件', extensions: ['*'] },
          ],
        });
        if (canceled || !filePath) return { ok: false, error: '已取消' };
        fs.writeFileSync(filePath, Buffer.from(m[3], 'base64'));
        return { ok: true, path: filePath, bytes: fs.statSync(filePath).size };
      } catch (err) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    });

    // 检查更新：只负责把更新源 JSON 取回来，比版本号在渲染层（core/update.js）
    handle('update:check', (_e, payload = {}) => updater.checkUpdate(payload));

    // ---- 季度报告长图导出 ----
    // 渲染层负责把「画布那份 DOM + 全部样式」拼成一份自包含的 HTML（图都是 dataURL），
    // 这里负责在隐藏窗口里重新渲染、出 PDF 或 PNG，然后落到磁盘。
    // 真正的活在同目录的 `reportExport.cjs`，主进程只做参数校验与存盘。
    handle('report:export', async (_e, { kind = 'pdf', html = '', width = 1220, name = 'jikai-report' } = {}) => {
      const text = String(html);
      if (text.length < 200) return { ok: false, error: '报告内容为空，没什么可导出的' };
      const w = Number(width);
      if (!Number.isFinite(w) || w < 200 || w > 4000) return { ok: false, error: `画布宽度不合理：${width}` };

      try {
        const isPdf = kind === 'pdf';
        const full = withReportStyles(text);
        // 这一段会开隐藏窗口，销毁时不能让「所有窗口都关闭」把整个应用带走
        hiddenExportWindows += 1;
        let out;
        try {
          out = isPdf
            ? await reportExport.renderPdf({ html: full, width: w })
            : await reportExport.renderPng({ html: full, width: w });
        } finally {
          hiddenExportWindows -= 1;
        }

        const ext = isPdf ? 'pdf' : 'png';
        const base = String(name).replace(/[\\/:*?"<>|]/g, '_');
        const fallback = `${base}.${ext}`;

        // 自检用的一次性出口：有它就跳过保存对话框，直接写到指定路径。
        // 没这个口子的话，「导出真的能出图」这件事只能靠人手点一遍。
        const forced = process.env.JIKAI_EXPORT_PATH;
        let target = forced ? path.resolve(forced) : '';
        if (!target) {
          const { canceled, filePath } = await dialog.showSaveDialog(mainWindow ?? undefined, {
            title: isPdf ? '导出报告 PDF' : '导出报告 PNG',
            defaultPath: path.join(app.getPath('downloads'), fallback),
            filters: isPdf
              ? [{ name: 'PDF 文档', extensions: ['pdf'] }, { name: '所有文件', extensions: ['*'] }]
              : [{ name: 'PNG 图片', extensions: ['png'] }, { name: '所有文件', extensions: ['*'] }],
          });
          if (canceled || !filePath) return { ok: false, error: '已取消' };
          target = filePath;
        }

        fs.writeFileSync(target, out.buffer);
        return {
          ok: true,
          path: target,
          bytes: out.buffer.length,
          kind,
          width: out.width,
          height: out.height,
          contentHeight: out.contentHeight ?? null,
          scale: out.scale ?? null,
          degraded: Boolean(out.degraded),
          slices: out.slices ?? null,
        };
      } catch (err) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    });

    // 代理变了要立刻生效，同时把结果回给设置面板
    handle('net:proxy', async (_e, proxy) => netBridge.applyProxy(proxy));

    handle('app:info', () => ({
      version: app.getVersion(),
      name: app.getName(),
      platform: process.platform,
      isDesktop: true,
      userData: app.getPath('userData'),
      packaged: app.isPackaged,
      /**
       * 这一次启动跑在硬件加速还是软件渲染上。
       *
       * 摆出来的理由：用户反馈「还是有点卡」，而最像的解释是这台机器早就被记成降级了
       * —— `boot.json` 里那个 `degrade: true` 以前一旦写进去就永久生效，谁也没法改回来。
       * 没有这个字段，两种模式下界面长得一模一样，说不清到底跑在哪一种上。
       *
       * 「现在是软件渲染吗」= 两处关 GPU 的入口合起来看：文件顶部自检那一处
       * （`SMOKE_PNG || IPC_SMOKE`）和 boot 那一处。只判 boot 的话，自检里会报
       * 「硬件加速」而其实 GPU 早就关了 —— 那种字段看着一切正常、其实在骗人。
       */
      render: (boot.degradedNow || SMOKE_PNG || IPC_SMOKE) ? 'software' : 'hardware',
      gpuRecoveries: Number(boot.state().recoveries) || 0,
      /** 这个进程往 boot.json 写过几次 —— 自检里必须是 0 */
      bootWrites: boot.writes(),
    }));

    /**
     * 手动「再试一次硬件加速」。
     *
     * `disableHardwareAcceleration()` 只在 ready 之前调用才有效，所以清掉标记之后
     * 必须重启才可能有意义 —— 这也是它为什么是个要用户自己按的按钮：
     * 重启会关掉他手上的窗口，不能替他决定。
     */
    handle('app:retry-hardware', async () => {
      /*
       * 冒烟/自检里默认不许重启：脚本正等着看输出，一重启就成了「没反应」。
       * 例外是 `JIKAI_SMOKE_RETRYHW` —— 那一档本来就是专门来测这次重启的。
       */
      if ((SMOKE_PNG || IPC_SMOKE) && !RETRYHW_PROBE) {
        return { ok: false, error: '自检模式不重启' };
      }
      boot.retryHardware();
      /*
       * 标记是给重启后那一份的：它一睁眼就得知道自己不是第一份，否则会再按一次
       * 这个按钮 —— 无限重启，用户那边看起来就是「程序反复闪退」。
       */
      app.relaunch({ args: [...process.argv.slice(1), RETRYHW_FLAG] });
      app.exit(0);
      return { ok: true };
    });

    handle('autolaunch:get', () => getAutoLaunch());
    handle('autolaunch:set', (_e, on) => setAutoLaunch(on));

    handle('hotkey:set', (_e, spec) => setGlobalHotkey(spec));

    handle('tray:state', (_e, payload) => {
      lastTrayState = { ...lastTrayState, ...(payload ?? {}) };
      tray?.setState({
        view: lastTrayState.view,
        todayCount: lastTrayState.todayCount ?? 0,
        followingCount: lastTrayState.followingCount ?? 0,
        catchupCount: lastTrayState.catchupCount ?? 0,
        overdueCount: lastTrayState.overdueCount ?? 0,
        version: lastTrayState.version ?? app.getVersion(),
        autoLaunch: lastTrayState.autoLaunch,
        updateText: lastTrayState.updateText ?? null,
      });
      return true;
    });

    handle('file:save-text', async (_e, { name = 'jikai.json', text = '' } = {}) => {
      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow ?? undefined, {
        title: '保存文件',
        defaultPath: path.join(app.getPath('downloads'), name),
        filters: [{ name: 'JSON', extensions: ['json'] }, { name: '所有文件', extensions: ['*'] }],
      });
      if (canceled || !filePath) return { ok: false, error: '已取消' };
      try {
        fs.writeFileSync(filePath, String(text), 'utf8');
        return { ok: true, path: filePath };
      } catch (err) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    });

    /*
     * 读一个文本文件进来（导入备份用）。
     *
     * ⚠️ 取消要回 `{ok:false, error:'已取消'}` 而不是抛：取消不是错误，
     * 界面接到 '已取消' 就什么都不做。抛出去的话用户会看到一条红色的失败提示 ——
     * 他明明只是改了主意。
     *
     * ⚠️ 大小上限 32MB。备份是纯文本、正常几十 KB，几十 MB 的那种几乎一定是
     * 「选错了文件」（比如挑到一个视频或数据库），一口气 readFileSync 会把主进程卡住。
     */
    handle('file:read-text', async () => {
      const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow ?? undefined, {
        title: '选择备份文件',
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }, { name: '所有文件', extensions: ['*'] }],
      });
      if (canceled || !filePaths?.length) return { ok: false, error: '已取消' };
      const filePath = filePaths[0];
      try {
        const st = fs.statSync(filePath);
        if (st.size > 32 * 1024 * 1024) {
          return { ok: false, error: `文件太大了（${(st.size / 1048576).toFixed(1)} MB），备份文件不该有这么大` };
        }
        return { ok: true, name: path.basename(filePath), path: filePath, text: fs.readFileSync(filePath, 'utf8') };
      } catch (err) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    });

    /*
     * 往 userData 下的 backups/ 里写一份东西（导入前的自动备份用）。
     *
     * 为什么不复用 `file:save-text`：那个会弹保存框，而这一步的意义正是
     * **在用户还没反应过来之前**把现在的状态存住 —— 等他挑目录的时候，
     * 数据已经快被覆盖了。所以路径由主进程定，一次都不问。
     *
     * ⚠️ 文件名只取 basename，别让渲染层用 `../` 写到 userData 外面去。
     */
    handle('file:write-backup', async (_e, { name = 'backup.json', text = '' } = {}) => {
      try {
        const dir = path.join(app.getPath('userData'), 'backups');
        fs.mkdirSync(dir, { recursive: true });
        const safe = path.basename(String(name)).replace(/[^\w.-]+/g, '_') || 'backup.json';
        const file = path.join(dir, safe);
        fs.writeFileSync(file, String(text), 'utf8');
        return { ok: true, path: file, name: safe, bytes: Buffer.byteLength(String(text), 'utf8') };
      } catch (err) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    });

    // IPC 冒烟：跑完就退。不建托盘也不开窗口 ——
    // 那两部分由 check:desktop 管，这里只关心「主进程这 25 个 handler 到底能不能跑」。
    if (IPC_SMOKE) {
      const failed = await runIpcSmoke();
      app.exit(failed ? 1 : 0);
      return;
    }

    // ---- 托盘 ----
    trace('p3-tray-start');
    tray = createTray({
      onToggleWindow: toggleWindow,
      onCommand: (cmd) => {
        if (cmd?.type === 'navigate') {
          showWindow();
          sendCommand({ type: 'navigate', view: cmd.view });
        } else {
          showWindow();
          sendCommand(cmd);
        }
      },
      onCheckUpdate: () => { showWindow(); sendCommand({ type: 'check-update' }); },
      onToggleAutoLaunch: (on) => { setAutoLaunch(on); sendCommand({ type: 'autolaunch-changed', value: Boolean(on) }); },
      onQuit: () => { isQuitting = true; app.quit(); },
    });

    const initial = getAutoLaunch();
    tray.setState({ version: app.getVersion(), autoLaunch: initial.openAtLogin });

    trace('p3-tray-done');
    mainWindow = createWindow();
    trace('p4-window-created');

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
      else showWindow();
    });
  });

  app.on('before-quit', () => {
    isQuitting = true;
  });

  // 托盘常驻是有意为之：关掉所有窗口也不退出
  app.on('window-all-closed', () => {
    // 导出长图用的隐藏窗口也会走到这里，那不算「用户把窗口关光了」。
    // 不排掉的话，连续导出两次时第二次必挂（见 hiddenExportWindows 的注释）。
    if (hiddenExportWindows > 0) return;
    if (!tray && process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    try { tray?.destroy(); } catch { /* 已经没了 */ }
  });
}
