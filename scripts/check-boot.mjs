/**
 * `boot.json` 状态机的端到端自检。
 *
 * 为什么单独立一项：这套状态机只有「真的崩一次」才会走到下一格，而崩溃不能按需重演，
 * 于是它从开发到发版**一次都没被跑过** —— 「`degrade` 一旦写进去就永久生效」那个毛病
 * 就是这么漏到用户手上的：他那边只表现为「有点卡、发涩」，而没有任何线索指向这份文件。
 *
 * 这里用 `JIKAI_BOOT_PROBE` 把「一次启动」拆成可以单步执行的一格，
 * 再配上 `JIKAI_USERDATA` 指一个用一次就丢的目录，把整条链一次走完：
 *
 *   干净 → 健康 ×2 → 崩一次 → 健康（这次被降级、次数清零）
 *        → 又崩一次（次数要重新数）→ 健康 ×2（这次该自动恢复）→ 健康（恢复正常）
 *        → 恢复次数到顶（认了，不再折腾）
 *
 * ⚠️ 判据一律从**磁盘上的 boot.json** 读，不从进程的 stdout 读 ——
 * 打印出来的东西只能证明「它觉得自己写了什么」，而这份 bug 的形态恰恰是
 * 「它以为自己写对了、其实把用户永久锁在软件渲染上」。
 * 唯一只能从 stdout 拿的是 `shouldDegrade`（＝这一次启动到底关没关 GPU），
 * 因为磁盘上不记录「这一次跑在哪种模式」，所以那一项在断言里标了来源。
 *
 * 用法：`node scripts/check-boot.mjs`
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

const dir = path.join(root, 'test', '.tmp', 'boot-profile');
// `app.setPath('userData', dir)` 之后，这份档案就长在 dir 里
const bootFile = path.join(dir, 'boot.json');

/*
 * 起点必须是干净的：这份文件要是在，第一次启动的期望值就全错了。
 * 某些沙盒环境对「一轮里累计删了多少文件」有上限，整个目录可能删不掉 ——
 * 那时至少要把这份档案本身清掉，它才是唯一影响断言的东西。
 */
try {
  fs.rmSync(dir, { recursive: true, force: true });
} catch (err) {
  console.warn(`! 一次性档案没整个删掉（${err?.code ?? err?.name ?? 'ERR'}），改为只清 boot.json`);
}
fs.mkdirSync(dir, { recursive: true });
try {
  fs.rmSync(bootFile, { force: true });
} catch { /* 删不掉也不要紧：第一次启动会把它整个覆盖掉 */ }

const readBoot = () => {
  try {
    return JSON.parse(fs.readFileSync(bootFile, 'utf8'));
  } catch {
    return null;
  }
};
const writeBoot = (obj) => fs.writeFileSync(bootFile, JSON.stringify(obj), 'utf8');

/**
 * 跑一次「一步启动」。`probe` 是 `healthy`（走一次正常启动该走的收尾）
 * 或 `crash`（什么都不做就退出，留下 `phase: 'started'`）。
 *
 * 每次都现起一个 electron 进程，所以慢 —— 10 步大概十几秒，换来的是
 * 「这条链真的能自己走完」，而不是「我读代码觉得它能走完」。
 */
async function bootStep(probe) {
  const env = { ...process.env };
  // ⚠️ 本机 agent shell 预置了它：带这个变量 electron.exe 会退化成纯 Node
  delete env.ELECTRON_RUN_AS_NODE;
  // 探针要跟别的自检模式隔开，免得它们各自的副作用混进来
  delete env.JIKAI_SMOKE;
  delete env.JIKAI_IPC_SMOKE;
  delete env.JIKAI_PERF;
  delete env.JIKAI_CRASH_TEST;
  env.JIKAI_USERDATA = dir;
  env.JIKAI_BOOT_PROBE = probe;

  const r = await new Promise((resolve, reject) => {
    const child = spawn(electron, ['.'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    // 探针在 ready 之前就 `app.exit(0)`，正常几百毫秒。挂 20 秒说明它没退 ——
    // 那本身就是「自检会卡住」这个坏消息，得让脚本自己报出来。
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ out, err, code }); });
    child.on('error', reject);
  });

  const line = r.out.split(/\r?\n/).find((l) => l.startsWith('BOOT_PROBE '));
  let probeInfo = null;
  if (line) {
    try { probeInfo = JSON.parse(line.slice('BOOT_PROBE '.length)); } catch { /* 下面按缺失处理 */ }
  }
  return { ...r, probeInfo };
}

const results = [];
function check(ok, msg) {
  results.push([Boolean(ok), msg]);
}
/** 只比我们关心的那几个字段：整体比的话，多出一个内部字段就整条红，分不清是不是关键那格错了 */
function expect(label, gotObj, want) {
  for (const k of Object.keys(want)) {
    const g = gotObj ? gotObj[k] : undefined;
    const w = want[k];
    const same = w === '__absent__' ? g === undefined : g === w;
    check(same, `${label} · ${k} 应为 ${w === '__absent__' ? '不存在' : JSON.stringify(w)}，实际 ${JSON.stringify(g)}`);
  }
}
/** 「这一次启动到底关没关 GPU」只能从进程自己的 stdout 拿，磁盘上不记 —— 单独包一层标出来源 */
function expectDegrade(label, step, want) {
  check(
    step.probeInfo && step.probeInfo.shouldDegrade === want,
    `${label} · 这次启动应当${want ? '降级' : '不降级'}（来源是 stdout 的 shouldDegrade=${step.probeInfo?.shouldDegrade}）`,
  );
}

console.log('boot.json 状态机：一步一步走');
console.log(`  profile: ${dir}\n`);

// ---- 1 & 2. 干净档案连着健康两次：只该攒健康次数，不该冒出 degrade ----
let r = await bootStep('healthy');
check(r.probeInfo, '第一次启动没打出 BOOT_PROBE —— 探针没生效，这一整轮的结论都不成立');
expectDegrade('第 1 次健康启动', r, false);
let b = readBoot();
check(b !== null, '第一次健康启动之后应该有 boot.json 了');
expect('第 1 次健康启动', b, { phase: 'healthy', healthyStreak: 1, degrade: '__absent__' });

r = await bootStep('healthy');
b = readBoot();
expect('第 2 次健康启动', b, { phase: 'healthy', healthyStreak: 2 });

// ---- 3. 崩一次：只留 started，还不该降级（写下它的是「下次启动」）----
r = await bootStep('crash');
expectDegrade('崩之前本来没降级，不该因为这次退出而降', r, false);
b = readBoot();
expect('崩一次之后（还没重启）', b, { phase: 'started', healthyStreak: 2 });
check(b && b.degrade === undefined, `只崩一次还不该写 degrade，实际 ${JSON.stringify(b)}`);

// ---- 4. 再启动：上次留着 started，这一次该被降级，并且健康次数要归零重数 ----
r = await bootStep('healthy');
expectDegrade('上次没起来就死，这一次必须降级', r, true);
b = readBoot();
expect('崩后第一次重启', b, { phase: 'healthy', healthyStreak: 1, degrade: true });
check(
  b && Number(b.healthyStreak) === 1,
  '★ 降级的那一刻健康次数必须清零再数 —— 不清的话 streak 是「这辈子一共健康过几次」，'
    + '装久了的老档早就 ≥ 2，于是「崩 → 降级 → 立刻恢复 → 又崩」会变成每次开机都闪一下',
);

// ---- 5. 降级还没消化掉又崩一次 ----
r = await bootStep('crash');
expectDegrade('degrade 还在，这次仍然降级', r, true);
b = readBoot();
expect('降级期间又崩一次', b, { phase: 'started', healthyStreak: 1, degrade: true });

// ---- 6. 又崩过：次数要从头数，而不是接着攒 ----
r = await bootStep('healthy');
expectDegrade('又崩过，这次继续降级', r, true);
b = readBoot();
expect('又崩一次之后的重启', b, { phase: 'healthy', healthyStreak: 1, degrade: true });
check(
  b && Number(b.healthyStreak) === 1,
  '★ 又崩一次之后，健康次数得重新从 0 数起（这里只攒到 1）—— '
    + '否则「崩得越多反而越快恢复」，HEALTHY_TO_RECOVER 那套「攒够才敢信」就是白写的',
);

// ---- 7. ★ 关键那一格：降级期间连续健康两次，degrade 必须被清掉 ----
r = await bootStep('healthy');
expectDegrade('degrade 还在，这一次仍然降级', r, true);
b = readBoot();
expect('降级状态下第二次健康启动', b, { phase: 'healthy', healthyStreak: 0, degrade: false, recoveries: 1 });
check(
  b && b.degrade === false,
  '★ 攒够健康次数之后 degrade 必须被清掉 —— 修之前这里会永远停在 true，'
    + '用户从此一直软件渲染，而没有任何地方能把它改回来',
);
check(b && Number(b.recoveries) === 1, '每恢复一次要记一笔，否则「试过 3 次就认了」那个上限算不出来');

// ---- 8. 清掉之后：恢复正常，不再降级 ----
r = await bootStep('healthy');
expectDegrade('degrade 已经清掉了，这一次该走硬件加速', r, false);
b = readBoot();
expect('恢复之后', b, { phase: 'healthy', healthyStreak: 1, degrade: false, recoveries: 1 });

// ---- 9 & 10. 恢复次数到顶：不许再自动折腾 ----
// 直接手写一份「已经试回来 3 次了」的档案。用写的而不是再崩 3 轮：
// 那样要 9 次启动，而这里要证的只有「到顶了就不动」这一格。
writeBoot({ phase: 'healthy', degrade: true, healthyStreak: 1, recoveries: 3 });
r = await bootStep('healthy');
b = readBoot();
check(
  b && b.degrade === true,
  `自动恢复已经失败 3 次，就该认了（继续降级），实际 ${JSON.stringify(b)} —— `
    + '没有这个上限会变成「恢复 → 崩 → 降级 → 恢复」来回折腾，每三轮浪费用户两次启动',
);
expect('到顶之后健康一次', b, { phase: 'healthy', healthyStreak: 2, degrade: true, recoveries: 3 });

// 再来一次：确认它稳定停在降级上，不会因为多开几次就自己抖回来
writeBoot({ phase: 'healthy', degrade: true, healthyStreak: 1, recoveries: 3 });
r = await bootStep('healthy');
b = readBoot();
expect('到顶之后再健康一次', b, { phase: 'healthy', healthyStreak: 2, degrade: true, recoveries: 3 });

// ---- 收尾 ----
const bad = results.filter(([ok]) => !ok);
for (const [ok, msg] of results) {
  if (ok) console.log(`  PASS ${msg}`);
  else console.error(`  FAIL ${msg}`);
}

if (bad.length) {
  console.error(`\n✗ boot 状态机自检失败：${bad.length} 条`);
  process.exit(1);
}

console.log(`\n✓ boot 状态机自检通过`);
console.log(`  ${results.length} 条断言 · 10 次真实启动 · 判据读自磁盘上的 ${path.relative(root, bootFile)}`);

// 跑完把一次性档案删掉，别留一堆 electron 的缓存目录在仓库里
try {
  fs.rmSync(dir, { recursive: true, force: true });
} catch { /* Windows 上偶发占用，不值得为此报错 */ }
