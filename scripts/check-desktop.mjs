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
 *   node scripts/check-desktop.mjs --view=report --profile=<空目录> --season=2026q3
 *   node scripts/check-desktop.mjs --view=history --profile=<空目录> --season=2026q3
 *
 * 报告视图跑两次各有意义：带 `--profile` 那次的 reports 是我们自己塞的（断言的是
 * 「磁盘 → 画布」这条接线），不带 `--profile` 那次断言的是「封面真的走缓存」。
 * `check:desktop:report` 只跑前者（后者要热缓存，放进 npm script 会看运行环境脸色）。
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
  } else if (forView === 'report') {
    /*
     * 报告是**按季度存在 state.reports 里**的，所以这里塞的 key 必须跟界面当前季度一致，
     * 差一位（2026q3 vs 2026q4）就会看到一张空画布 —— 而「空画布」也是一个合法状态，
     * 断言会以「块数不对」的形式红出来，看着像渲染坏了。所以 key 就用 --season。
     */
    const key = season || '2026q3';
    const picks = SEEDS.slice(0, 6);
    const blocks = [
      { id: 'b-1', type: 'header', title: '季度报告（冒烟）', subtitle: '四类块各放一块' },
      { id: 'b-2', type: 'wall', title: '封面墙', subjectIds: picks.map((it) => String(it.id)), columns: 6 },
      { id: 'b-3', type: 'award', title: '最佳作画', body: '线条克制', subjectId: String(picks[0].id) },
      { id: 'b-4', type: 'text', body: '第一段\n第二段' },
    ];
    state.reports = {
      [key]: { seasonKey: key, width: 1220, theme: 'default', updatedAt: Date.UTC(2026, 9, 5), blocks },
    };
    // 期望值全部从上面那份 seed 推出来，不另写一遍数字。
    // 「奖项块也画一张封面」就是漏算出来的那一次：88 vs 89，差一张，
    // 看上去像渲染多了，其实是断言少算了一处。
    const wallIds = blocks.filter((b) => b.type === 'wall').flatMap((b) => b.subjectIds);
    const awardIds = blocks.filter((b) => b.type === 'award' && b.subjectId).map((b) => b.subjectId);
    expectation = {
      blocks: blocks.length,
      tiles: wallIds.length,
      pool: builtinItems(key).length,
      covers: builtinItems(key).length + wallIds.length + awardIds.length,
    };
  } else if (forView === 'history') {
    /*
     * 历程要的输入是**时间戳**，所以这里塞的是 following。
     *
     * 故意混进一部「没有时间戳」的：老用户升级之后打开这一页就是这副样子 ——
     * 数字必须对（它算在追番总数里），但不能假装它有时间。
     * total / tracking / untimed 三条是配套的，少了 untimed 那条，
     * 「时间戳一条都没落盘」就查不出来了（总数照样是 3）。
     */
    const DAY = 86400000;
    const T = Date.UTC(2026, 8, 1);
    // ⚠️ 必须挑**真有集数**的条目：`isFinished` 只认「已看 ≥ 总集数」，
    // 挑到没有 eps 的，期望值会写成「看完 1 部」而实际永远是 0 部 ——
    // 那是脚本自己造出来的红，会让人去改本来正确的代码。
    const withEps = SEEDS.filter((it) => Number(it.eps) > 0);
    if (withEps.length < 2) {
      console.error(`✗ 内置数据里有集数的作品不足两部（只有 ${withEps.length} 部），历程的耗时断言没法验`);
      process.exit(2);
    }
    const [a, b] = withEps;
    const used = new Set([a.id, b.id]);
    const c = SEEDS.find((it) => !used.has(it.id) && !(Number(it.eps) > 0))
      ?? SEEDS.find((it) => !used.has(it.id));
    if (!c) {
      console.error('✗ 内置数据里凑不出第三部作品来测「没有时间戳」那条路径');
      process.exit(2);
    }

    state.following = {
      [a.id]: { status: 'watching', watchedEps: a.eps, notify: true, followedAt: T, lastAt: T + 12 * DAY },
      [b.id]: { status: 'watching', watchedEps: 1, notify: true, followedAt: T + 4 * DAY, lastAt: T + 6 * DAY },
      [c.id]: { status: 'watching', watchedEps: 0, notify: true }, // 没有时间戳
    };
    expectation = {
      total: 3,
      tracking: 2,
      untimed: 1,
      finished: 1, // 只有 a 看完了
      events: 3,   // a 两条（开始追 + 看完）+ b 一条
      days: [12],
    };
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
  /**
   * 清掉上一轮留下的存档。
   *
   * ⚠️ 「整个目录递归删」在某些环境里会被拦下来（WorkBuddy 沙盒的 safe-delete shim）：
   * 一次删超过 50 个文件就要人工确认，报
   *   [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":64,"threshold":50,…}
   * 而 Electron 的 userData 目录里光 Cache/GPUCache 就六七十个文件，必然超线。
   * 结果就是**第二次跑 `check:all` 必挂**，报的却是「脚本自己删不掉目录」，
   * 跟被测的功能毫无关系 —— 属于会教人忽略这个脚本的那种红。
   *
   * 所以降级：删不动就只删 `state.json`。对这次自检来说 state.json 就是全部 ——
   * 「干净的一次性 profile」要的是「没有上一轮的数据」，不是「没有缓存目录」。
   * （封面缓存留着也影响不到断言：带 --profile 的那几组只禁「直连远端」，不禁缓存命中。）
   */
  try {
    fs.rmSync(profileDir, { recursive: true, force: true });
  } catch (err) {
    fs.mkdirSync(profileDir, { recursive: true });
    try { fs.rmSync(path.join(profileDir, 'state.json'), { force: true }); } catch { /* 本来就没有 */ }
    console.warn(`! 存档目录删不掉（${err?.code ?? err?.name ?? 'ERR'}），已降级为只清 state.json`);
  }
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

// ---- 本季番剧：封面缓存不能只有 tier 视图才用得上 ----
// 阶段 A 之前，封面缓存只接在 Tier List 上；本季 / 时间表 / 追番 / 补番 / 日记
// 的封面走的是远端直链，断网一律退成色块。这条是那次改动的守门员。
if (view === 'season') {
  const total = Number(report.coverCache) + Number(report.coverRemote) + Number(report.coverNone);
  check(total > 5, `本季应当渲染出几张封面，实际 ${total}`);
  if (!profile) {
    check(
      Number(report.coverCache) > 0,
      `本季的封面一张都没走缓存（coverCache=${report.coverCache}）—— 说明 <Cover> 没接上上下文，断网就是一片色块`,
    );
    check(
      Number(report.coverRemote) === 0,
      `本季的封面在直连远端（coverRemote=${report.coverRemote}）—— 桌面壳会先下一遍再进缓存，等于下两遍`,
    );
  }
}

// ---- 季度报告：磁盘上的块能不能一路走到画布上 ----
// 这一条守的是「store.reports → App → ReportView → 画布」这条接线。
// 组件本身由 SSR 断言守着（render.test.mjs），但**接通那一步只有桌面壳能验** ——
// v1.1 的 82 张色块就是「每层都写了、接线没接」的典型。
if (view === 'report') {
  check(Number(report.reportNav) === 1, `侧栏没有季度报告的导航项（reportNav=${report.reportNav}）`);
  check(Number(report.reportView) === 1, `报告视图没渲染出来（reportView=${report.reportView}）`);
  check(Number(report.reportCanvas) === 1, `画布没渲染出来（reportCanvas=${report.reportCanvas}）`);
  check(
    String(report.reportCanvasWidth) === '1220',
    `画布宽度应当是 1220，实际 ${report.reportCanvasWidth} —— 宽度错了，导出的长图就不是预览的那个版式`,
  );
  check(Number(report.reportAddButtons) >= 4, `四种块的「加一块」按钮都要在（实际 ${report.reportAddButtons} 个）`);

  if (expected) {
    check(
      Number(report.reportBlocks) === expected.blocks,
      `画布上应有 ${expected.blocks} 块，实际 ${report.reportBlocks} —— 磁盘上的 reports 没读进来，或者读进来又被丢了`,
    );
    check(
      Number(report.reportWallTiles) === expected.tiles,
      `封面墙应有 ${expected.tiles} 张图块，实际 ${report.reportWallTiles}`,
    );
    check(
      Number(report.reportPool) === expected.pool,
      `素材面板应当列出 ${expected.pool} 部，实际 ${report.reportPool}`,
    );
    // 每一张封面都得是个真的 <img>（或色块占位），不能是空壳。
    // 一次性 profile 里没有封面缓存 → 全都应当是色块；但它们**必须存在**。
    const coverTotal = Number(report.coverCache) + Number(report.coverRemote) + Number(report.coverNone);
    check(
      coverTotal === expected.covers,
      `画布+素材面板应有 ${expected.covers} 张封面节点（素材 ${expected.pool} + 墙 ${expected.tiles} + 奖项 1），实际 ${coverTotal}`,
    );
  }

  if (profile) {
    // 冷存档里没有封面缓存。这时**绝不能**退回直连（桌面的规矩），只能是色块。
    check(
      Number(report.coverRemote) === 0,
      `一次性存档里出现了直连封面（coverRemote=${report.coverRemote}）—— 桌面壳不许退回远端`,
    );
  } else {
    check(
      Number(report.coverCache) > 0,
      `报告里的封面一张都没走缓存（coverCache=${report.coverCache}）—— 长图会带着一片色块被导出去`,
    );
    check(Number(report.coverRemote) === 0, `报告里的封面在直连远端（coverRemote=${report.coverRemote}）`);
  }
}

// ---- 追番历程：磁盘上的时间戳能不能一路走到时间轴上 ----
// 这一条守的是「记时间戳 → 落盘 → 读回来 → 摊成时间线」整条链。
// 组件与纯函数由 SSR 和单测守着，但**时间戳到底有没有落进 state.json**
// 只有桌面壳能回答 —— 而它一旦断了就是永久损失（过去的日期补不回来）。
if (view === 'history') {
  check(Number(report.historyNav) === 1, `侧栏没有追番历程的导航项（historyNav=${report.historyNav}）`);
  check(Number(report.historyView) === 1, `历程视图没渲染出来（historyView=${report.historyView}）`);

  if (expected) {
    check(
      Number(report.historyTotal) === expected.total,
      `追番总数应当是 ${expected.total}，实际 ${report.historyTotal} —— following 没读进来`,
    );
    check(
      Number(report.historyTracking) === expected.tracking,
      `有时间戳的应当是 ${expected.tracking} 部，实际 ${report.historyTracking} —— 时间戳没落盘，或者落盘后被丢掉了`,
    );
    check(
      Number(report.historyUntimed) === expected.untimed,
      `没有时间戳的应当是 ${expected.untimed} 部，实际 ${report.historyUntimed}`
        + ' —— 这个数错说明「有时间戳」和「没有」被混成了一类，界面就没法说清哪些数字是准的',
    );
    check(
      Number(report.historyFinished) === expected.finished,
      `看完的应当是 ${expected.finished} 部，实际 ${report.historyFinished}`,
    );
    check(
      Number(report.historyEvents) === expected.events,
      `时间轴上应当有 ${expected.events} 条事件，实际 ${report.historyEvents}`,
    );
    check(
      JSON.stringify(report.historyDays) === JSON.stringify(expected.days),
      `耗时应当是 ${JSON.stringify(expected.days)} 天，实际 ${JSON.stringify(report.historyDays)}`,
    );
  } else {
    warnings.push('没有 --profile 播种，历程里的时间戳自然是空的（断言只在播种的那次才有意义）');
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
if (view === 'season') {
  console.log(`  封面：缓存 ${report.coverCache} · 直连 ${report.coverRemote}（必须为 0）· 色块 ${report.coverNone}`);
}
if (view === 'diary') {
  console.log(`  日记：导航 ${report.diaryNav} · 视图 ${report.diaryView} · 比对行 ${report.diaryRows}`);
  if (expected) {
    console.log(`  统计：我的均分 ${report.diaryAvgMine} / BGM 均分 ${report.diaryAvgBgm}（期望 ${expected.avgMine} / ${expected.avgBgm}）`);
  }
}
if (view === 'report') {
  console.log(
    `  报告：导航 ${report.reportNav} · 画布 ${report.reportCanvas}（宽 ${report.reportCanvasWidth}）`
    + ` · ${report.reportBlocks} 块（其中封面墙 ${report.reportWallTiles} 张）· 素材 ${report.reportPool} 部`,
  );
  console.log(`  封面：缓存 ${report.coverCache} · 直连 ${report.coverRemote}（必须为 0）· 色块 ${report.coverNone}`);
}
if (view === 'history') {
  console.log(
    `  历程：追番 ${report.historyTotal} 部 · 有时间戳 ${report.historyTracking} · 未知 ${report.historyUntimed}`
    + ` · 看完 ${report.historyFinished} · 时间轴 ${report.historyEvents} 条`,
  );
  if (expected) {
    console.log(`  耗时：${JSON.stringify(report.historyDays)} 天（期望 ${JSON.stringify(expected.days)}）`);
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
