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
 * 断言按视图分开：档位行数只对 tier 有意义，日记行数只对 diary 有意义。
 * 早先不分的时候，换个视图跑必然红一片 —— 而那种红是脚本自己的问题，
 * 会教人忽略这个脚本。
 *
 * 用法：
 *   node scripts/check-desktop.mjs                       # tier 视图，真实 profile（封面缓存是热的）
 *   node scripts/check-desktop.mjs --view=diary --profile=<空目录> --season=2026q3
 *   node scripts/check-desktop.mjs --view=catchup --profile=<空目录> --season=2026q3 --click=8
 *
 * `--profile` 给这次运行指定一个一次性的存档目录（主进程的 JIKAI_USERDATA），
 * 并往里**播种**好这次要验的数据：要验「磁盘上的数据能不能一路走到界面上」，
 * 就必须能控制磁盘上那份数据，又不能去动用户本人的真实存档。
 *
 * `--click=<n>` 会让界面真的被点一次（打分 n → 记下），跑完再回来读 state.json，
 * 验的是「点了以后到底有没有存进去」—— 这条链的后半段只存在于桌面壳里。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { builtinItems } from '../src/data/builtin/index.js';

const root = process.cwd();
const dist = path.join(root, 'dist');
const arg = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? '').split('=')[1] || fallback;

const view = arg('view', 'tier');
const wait = arg('wait', '6000');
const season = arg('season', '');
const profile = arg('profile', '');
const click = Number(arg('click', '0'));

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

const shot = path.join(root, 'test', '.tmp', `desktop-${view}${profile ? '-temp' : ''}.png`);
fs.mkdirSync(path.dirname(shot), { recursive: true });

const SEEDS = builtinItems('2026q3').filter((it) => Number(it.score) > 0);
const r2 = (n) => Math.round(n * 100) / 100;
const titleOf = (it) => it.titleZh || it.titleJa;

/**
 * 给一次性 profile 播种，并算好「按这份输入应该得到什么」。
 *
 * 期望值是从**输入数据**推出来的（内置番剧的 Bangumi 分 + 我们塞进去的评分），
 * 不是从界面抄回来的 —— 否则这个断言只是把实现又写了一遍，什么都没验。
 */
function seedProfile(dir, forView) {
  if (SEEDS.length < 3) {
    console.error(`✗ 内置数据里凑不出三部有 Bangumi 评分的作品（只有 ${SEEDS.length} 部），没法播种`);
    process.exit(2);
  }
  const state = {};
  let expectation = null;

  if (forView === 'diary') {
    const picked = SEEDS.slice(0, 2);
    const ratings = [9, 4];
    const at = [Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 2)];
    const diary = {};
    picked.forEach((it, i) => {
      diary[String(it.id)] = { entries: [{ at: at[i], rating: ratings[i], note: '' }], updatedAt: at[i] };
    });
    state.diary = diary;
    expectation = {
      rows: picked.length,
      titles: picked.map(titleOf),
      avgMine: r2((ratings[0] + ratings[1]) / 2),
      avgBgm: r2((Number(picked[0].score) + Number(picked[1].score)) / 2),
    };
  } else if (forView === 'catchup') {
    const it = SEEDS[2];
    state.catchup = [{
      id: `catchup-${it.id}`,
      subjectId: it.id,
      deadline: Date.UTC(2026, 9, 10),
      watchedEps: 3,
      targetEps: it.eps ?? 12,
      archived: false,
      createdAt: Date.UTC(2026, 8, 1),
    }];
    expectation = { cards: 1, subjectId: it.id, title: titleOf(it), click: click > 0 ? click : null };
  }

  /*
   * ⚠️ 一定要真的落盘。这一段曾经漏掉过 `writeFileSync`，症状是断言全红、
   * 看着像功能坏了 —— 其实是脚本自己没播种。**脚本自己造出来的红，
   * 比不做测试更坏**：它会让人去改本来正确的代码（这条教训的反面版本在第 17 条）。
   * 所以这里不再按分支各写一次，统一在出口处写。
   */
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2), 'utf8');
  return expectation;
}

const env = { ...process.env };
/**
 * ⚠️ 必须清掉 `ELECTRON_RUN_AS_NODE`：本机 agent shell 里预置了它，
 * 有这个变量时 electron.exe 会退化成纯 Node，`require('electron')` 拿到的
 * `app` / `ipcMain` 全是 undefined，报的错指向代码（「Cannot read properties of
 * undefined」），**完全看不出是环境问题**。用户双击桌面图标不受影响。
 */
delete env.ELECTRON_RUN_AS_NODE;
env.JIKAI_SMOKE = shot;
env.JIKAI_SMOKE_VIEW = view;
env.JIKAI_SMOKE_WAIT = wait;
if (season) env.JIKAI_SMOKE_SEASON = season;
if (click > 0) env.JIKAI_SMOKE_CLICK = String(click);

let expected = null;
let profileDir = '';
if (profile) {
  profileDir = path.resolve(profile);
  fs.rmSync(profileDir, { recursive: true, force: true });
  expected = seedProfile(profileDir, view);
  env.JIKAI_USERDATA = profileDir;
}

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

// ---- 视图本身 ----
check(report.view === view, `视图不对：期望 ${view}，实际 ${report.view}`);

// ---- 界面真的画出来了（tier）----
if (view === 'tier') {
  check(Number(report.rows) === 7, `档位应有 7 行，实际 ${report.rows}`);
  check(Number(report.pool) > 0, `素材池应有图块，实际 ${report.pool}`);

  // ---- 封面到底走的哪条路（这一组就是那次 bug 的守门员）----
  // 只有用真实 profile 时才有意义的断言：一次性 profile 里封面缓存当然是空的，
  // 在这里断言「必须有缓存」等于在考自己刚擦干净的屋子。
  if (!profile) {
    check(Number(report.cached) > 0, `桌面壳一张缓存封面都没显示（cached=${report.cached}）—— 多半是封面表的键又对不上了`);
    check(
      Number(report.remote) === 0,
      `桌面壳绝不能直连远端封面（remote=${report.remote}）—— 那样浏览器会先下一遍 45MB，主进程再下一遍`,
    );
    check(Number(report.coverBytes) > 0, `封面缓存目录是空的（coverBytes=${report.coverBytes}）`);
    if (Number(report.cached) < Number(report.pool)) {
      warnings.push(`还有 ${Number(report.pool) - Number(report.cached)} 个图块没封面（可能是这一季本来就没有，或缓存还没下完）`);
    }
  }
}

// ---- 补番日记：磁盘上的日记要能一路走到界面上 ----
if (view === 'diary') {
  check(Number(report.diaryNav) === 1, `侧栏没有补番日记的导航项（diaryNav=${report.diaryNav}）`);
  check(Number(report.diaryView) === 1, `日记视图没渲染出来（diaryView=${report.diaryView}）`);
  if (expected) {
    check(
      Number(report.diaryRows) === expected.rows,
      `比对表应有 ${expected.rows} 行，实际 ${report.diaryRows} —— 磁盘上的日记没读进来，或者读进来又被丢了`,
    );
    const titles = Array.isArray(report.diaryRowTitles) ? report.diaryRowTitles : [];
    for (const t of expected.titles) {
      check(titles.includes(t), `比对表里缺了「${t}」—— 记了日记却查不到作品资料，卡片不能整条消失`);
    }
    // 这两条是「统计值必须显式带值」的守门员：属性写成裸属性时恒为 "true"
    check(
      String(report.diaryAvgMine) === String(expected.avgMine),
      `我的均分应当是 ${expected.avgMine}，实际 ${JSON.stringify(report.diaryAvgMine)}`,
    );
    check(
      Number(report.diaryAvgBgm) === expected.avgBgm,
      `BGM 均分应当是 ${expected.avgBgm}，实际 ${JSON.stringify(report.diaryAvgBgm)}`,
    );
  } else if (Number(report.diaryRows) === 0) {
    warnings.push('日记是空的（没给 --profile 播种时属正常）');
  }
}

// ---- 补番清单：打分控件在卡片上，且点了真的能存进去 ----
if (view === 'catchup') {
  check(
    Number(report.diaryInputs) === (expected?.cards ?? 1),
    `每张补番卡上都该有打分控件，期望 ${expected?.cards ?? 1} 个，实际 ${report.diaryInputs}`,
  );

  if (expected?.click) {
    // 界面上的即时反馈
    check(
      String(report.diaryLastRating) === String(expected.click),
      `点完 ${expected.click} 分之后卡片上应当显示「我的 ${expected.click}」，实际 ${JSON.stringify(report.diaryLastRating)}`,
    );

    // 真正的落点：磁盘上的 state.json
    const statePath = path.join(profileDir, 'state.json');
    let state = null;
    try {
      state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch (err) {
      check(false, `读不到存档 ${statePath}：${err?.message ?? String(err)}`);
    }
    const entries = state?.diary?.[String(expected.subjectId)]?.entries ?? [];
    const hit = entries.some((e) => Number(e?.rating) === expected.click);
    check(
      hit,
      `点了 ${expected.click} 分，但 state.json 里没有这条记录（该作品现有 ${entries.length} 条）` +
        ' —— 打分没能落到磁盘，重开就没了',
    );
  }
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
console.log(`  视图 ${report.view}${season ? `（季度 ${season}）` : ''}${profile ? ` · 一次性存档 ${path.relative(root, profileDir)}` : ''}`);
if (view === 'tier' && !profile) {
  console.log(`  档位 ${report.rows} 行 · 素材池 ${report.pool} 个`);
  console.log(`  封面：缓存 ${report.cached} · 直连 ${report.remote}（必须为 0）· 已存 ${(Number(report.coverBytes) / 1048576).toFixed(1)} MB`);
}
if (view === 'diary') {
  console.log(`  日记：导航 ${report.diaryNav} · 视图 ${report.diaryView} · 比对行 ${report.diaryRows}`);
  if (expected) {
    console.log(`  统计：我的均分 ${report.diaryAvgMine} / BGM 均分 ${report.diaryAvgBgm}（期望 ${expected.avgMine} / ${expected.avgBgm}）`);
  }
}
if (view === 'catchup') {
  console.log(`  补番卡片 ${report.diaryInputs} 张带打分控件`);
  if (expected?.click) {
    console.log(`  点击 ${expected.click} 分 → 界面显示 ${report.diaryLastRating} → 已确认写进 state.json`);
  }
}
console.log(`  截图：${path.relative(root, shot)}（${(fs.statSync(shot).size / 1024).toFixed(0)} KB）`);
for (const w of warnings) console.log(`  ! ${w}`);
