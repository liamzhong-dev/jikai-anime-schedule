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
 *   node scripts/check-desktop.mjs --view=search --profile=<空目录> --season=2026q3
 *
 * 报告视图跑两次各有意义：带 `--profile` 那次的 reports 是我们自己塞的（断言的是
 * 「磁盘 → 画布」这条接线），不带 `--profile` 那次断言的是「封面真的走缓存」。
 * `check:desktop:report` 只跑前者（后者要热缓存，放进 npm script 会看运行环境脸色）。
 *
 * `--view=search` 这一路会播种一份**名称索引**（userData 下的 nameIndex.json），
 * 并让主进程探针真的往搜索框里打字，验的是「索引读得到 → 输入 → 下拉弹出来」
 * 这条链。关键词只定义在脚本里的 SEARCH_WORD 一处，经环境变量递给探针 ——
 * 两边各写一份的话，改一处就会不同步，症状是「下拉是空的」，看着像功能坏了。
 *
 * `--profile` 给这次运行指定一个一次性的存档目录（主进程的 JIKAI_USERDATA），
 * 并往里**播种**好这次要验的数据：要验「磁盘上的数据能不能一路走到界面上」，
 * 就必须能控制磁盘上那份数据，又不能去动用户本人的真实存档。
 *
 * `--click=<n>` 会让界面真的被点一次（打分 n → 记下），跑完再回来读 state.json，
 * 验的是「点了以后到底有没有存进去」—— 这条链的后半段只存在于桌面壳里。
 *
 * `--wp` 会播种一张**真的壁纸**（`build/demo/wallpaper-night.png`，PNG 头里读尺寸），
 * 并让探针打开设置面板、在取景框里按真实指针拖一下，跑完再回来读 state.json。
 * 验的是「按住拖 → 像素换算 → store → 防抖 → IPC → 磁盘」整条链 ——
 * 这里面除了「框画出来了」以外的每一环，单测和 SSR 都够不着。
 *
 * `--cardopen` 会让主进程用**真实鼠标事件**点一下封面正中，验「点封面能开详情抽屉」。
 * 它不能用合成 click 代替：合成事件直接派发给元素、绕开命中测试，封面上真盖着东西
 * 也照样成功 —— 「用户点不开」就是这么漏出去的。
 *
 * 程序被自己的窗口占着锁时，这个脚本会**把本项目的 Electron 关掉再来一次**
 * （只认命令行里带本项目路径的进程）。`--no-kill` 可以关掉这个行为。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { builtinItems } from '../src/data/builtin/index.js';
import { closeRunningApp } from './lib/killapp.mjs';

const root = process.cwd();
const dist = path.join(root, 'dist');
const arg = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? '').split('=')[1] || fallback;

const view = arg('view', 'tier');
const wait = arg('wait', '6000');
const season = arg('season', '');
const profile = arg('profile', '');
const click = Number(arg('click', '0'));
const wp = process.argv.includes('--wp');
const cardopen = process.argv.includes('--cardopen');
const retryhw = process.argv.includes('--retryhw');

if (wp && !profile) {
  console.error('✗ --wp 必须同时给 --profile：不给的话这次自检会去拖**用户真实存档**里的壁纸位置');
  process.exit(2);
}

if (retryhw && !profile) {
  console.error('✗ --retryhw 必须同时给 --profile：它要往 boot.json 里写一份降级标记，不能拿用户真实档案试');
  process.exit(2);
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

const shot = path.join(root, 'test', '.tmp', `desktop-${view}${profile ? '-temp' : ''}.png`);
fs.mkdirSync(path.dirname(shot), { recursive: true });

const SEEDS = builtinItems('2026q3').filter((it) => Number(it.score) > 0);
const r2 = (n) => Math.round(n * 100) / 100;
const titleOf = (it) => it.titleZh || it.titleJa;

/**
 * 跨季搜索自检用的名称索引样本。
 *
 * ⚠️ 搜索词只有这一处定义，靠 SEARCH_WORD 经 JIKAI_SMOKE_SEARCH 传给主进程探针。
 * 探针里再硬写一份的话，两边改一处就会不同步，而症状是「下拉是空的」——
 * 看着像功能坏了，其实是脚本自己设定的词对不上。
 *
 * 两条同前缀的跨季老番（都不在当前季，所以必须出现在下拉里）+ 一条当前季的
 * （用来确认它**不会**被重复列进下拉：本季的已经在主区域的列表里了）。
 */
const SEARCH_WORD = '鬼灭';
const SEARCH_INDEX = [
  { id: 900001, zh: '鬼灭之刃', ja: '鬼滅の刃', en: 'Demon Slayer', y: 2019, q: 2, t: 'tv' },
  { id: 900002, zh: '鬼灭之刃 无限列车篇', ja: '鬼滅の刃 無限列車編', en: '', y: 2021, q: 4, t: 'tv' },
  { id: 900003, zh: '本季的测试条目', ja: 'テスト用', en: '', y: 2026, q: 3, t: 'tv' },
];

/**
 * 播种用的壁纸。
 *
 * 直接拿仓库里那一张（`build/demo/wallpaper-night.png`，已入库）——
 * 尺寸从 PNG 头的 IHDR 里读，不写死：写死的话，哪天换了素材，
 * 期望的「拖动余量」就跟着错，而症状是「拖了没反应」，看着像功能坏了。
 *
 * ⚠️ dataURL 是**必须**的：主进程 `readWallpaper` 读的就是它。
 * 少了它、或者键名对不上，取景框就是灰的 —— 那正是这条自检要抓的东西。
 */
function buildWallpaperSeed() {
  const file = path.join(root, 'build/demo/wallpaper-night.png');
  if (!fs.existsSync(file)) {
    console.error(`✗ 找不到播种用的壁纸 ${path.relative(root, file)}（npm run assets 生成过就有）`);
    process.exit(2);
  }
  const buf = fs.readFileSync(file);
  // PNG 签名 + IHDR：宽高是第 16 / 20 字节起的两个大端 32 位
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) {
    console.error(`✗ ${path.relative(root, file)} 不是 PNG，读不出尺寸`);
    process.exit(2);
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return {
    width,
    height,
    payload: {
      dataUrl: `data:image/png;base64,${buf.toString('base64')}`,
      width,
      height,
      bytes: buf.length,
      name: '自检壁纸',
    },
  };
}

/** 给一次性 profile 播种，并算好「按这份输入应该得到什么」。
 *
 * 期望值是从**输入数据**推出来的（内置番剧的 Bangumi 分 + 我们塞进去的评分），
 * 不是从界面抄回来的 —— 否则这个断言只是把实现又写了一遍，什么都没验。
 */
/** 这一轮播种进去的壁纸信息（`--wp` 才有），断言要用它算期望 */
let wallSeed = null;

function seedProfile(dir, forView, withWallpaper) {
  if (SEEDS.length < 3) {
    console.error(`✗ 内置数据里凑不出三部有 Bangumi 评分的作品（只有 ${SEEDS.length} 部），没法播种`);
    process.exit(2);
  }
  const state = {};
  // 名称索引是独立文件（跟真实实现一致：它约 1MB，不跟 state 混在一起）
  let nameIndex = null;
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
  } else if (forView === 'search') {
    /*
     * 跨季搜索的输入是**名称索引**（userData 下的 nameIndex.json），不是 state ——
     * 所以这个分支只写索引，state 留空。
     *
     * 期望值从索引推，不写死数字：命中搜索词的条目里，**不在当前季的**才该进下拉。
     * 这条规则正是这个功能的核心，也让断言顺带守住了「在不在本季」的判定。
     */
    nameIndex = {
      builtAt: Date.now(),
      source: 'smoke',
      count: SEARCH_INDEX.length,
      span: [2019, 2026],
      entries: SEARCH_INDEX,
    };
    const key = season || '2026q3';
    const inSeasonIds = new Set(builtinItems(key).map((a) => Number(a.id)));
    const hit = SEARCH_INDEX.filter((e) => e.zh.includes(SEARCH_WORD));
    const others = hit.filter((e) => !inSeasonIds.has(e.id));
    if (!hit.length) {
      console.error(`✗ 索引样本里没有一条含「${SEARCH_WORD}」，自检没法验命中`);
      process.exit(2);
    }
    expectation = {
      ready: '1',
      items: others.length,
      panel: others.length,
      titles: others.map((e) => e.zh),
    };
  }

  /*
   * 壁纸是**独立文件**（跟真实实现一致：它一两百 KB，不跟 state 混在一起）。
   * 但开关必须写在 `settings.wallpaper` 里 —— 两处都要有：只写文件的话
   * 取景框还是灰的，而「灰的」和「没接上」看起来一模一样。
   */
  if (withWallpaper) {
    wallSeed = buildWallpaperSeed();
    state.settings = {
      ...(state.settings ?? {}),
      wallpaper: { enabled: true, name: '自检壁纸', imgW: wallSeed.width, imgH: wallSeed.height },
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
  // 索引只有当这次自检真的需要时才写 —— 写了一份别的视图用不上的索引，
  // 会顺手把「没有索引时该怎么显示」这条分支从别的自检里遮掉。
  if (nameIndex) fs.writeFileSync(path.join(dir, 'nameIndex.json'), JSON.stringify(nameIndex), 'utf8');
  if (wallSeed) fs.writeFileSync(path.join(dir, 'wallpaper.json'), JSON.stringify(wallSeed.payload), 'utf8');
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
// 只有搜索那一路才给探针递词：探针见到词就会往输入框里打字，
// 别的视图不需要，平白多一步还可能干扰它们自己的断言。
if (view === 'search') env.JIKAI_SMOKE_SEARCH = SEARCH_WORD;
// 壁纸拖动那一路：让探针打开设置、在取景框里真拖一下
if (wp) env.JIKAI_SMOKE_WPDRAG = '1';
/*
 * 封面热区那一路：主进程用**真实鼠标事件**（sendInputEvent）点一下封面正中。
 * 这条不能用合成 click 代替 —— 合成事件直接派发给元素，就算有东西盖在封面上
 * 也照样「成功」，于是「用户点不开」永远查不出来。
 */
if (cardopen) env.JIKAI_SMOKE_CARDOPEN = '1';
/*
 * 「再试一次硬件加速」那一路：靠一个标记文件把重启后的那一份认出来。
 *
 * 为什么非要用文件：新起来的进程**不继承输出管道**，它的 stdout 到不了这里
 * （自愈那条链就是因为这个被误判过一次的）。
 */
const retryMarker = path.join(root, 'test', '.tmp', 'retryhw.marker');
if (retryhw) {
  try { fs.rmSync(retryMarker, { force: true }); } catch { /* 本来就没有 */ }
  env.JIKAI_SMOKE_RETRYHW = retryMarker;
}

let expected = null;
let profileDir = '';
if (profile) {
  profileDir = path.resolve(profile);
  /**
   * 清掉上一轮留下的存档。
   *
   * ⚠️ 「整个目录递归删」在某些沙盒环境里会被拦下来（safe-delete 钩子的批量确认）：
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
  expected = seedProfile(profileDir, view, wp);
  env.JIKAI_USERDATA = profileDir;

  /*
   * 「再试一次」那一路要从**降级态**起步，先往这份档案里写一个 degrade:true。
   * 不写的话这一次本来就是硬件加速，「清掉标记」根本无从验起 ——
   * 那种自检会是绿的，因为压根没有任何东西需要被清掉。
   */
  if (retryhw) {
    fs.writeFileSync(
      path.join(profileDir, 'boot.json'),
      JSON.stringify({ phase: 'healthy', degrade: true, healthyStreak: 0, recoveries: 0 }),
      'utf8',
    );
  }
}

/**
 * 起一次桌面壳，把 stdout / stderr 收回来。
 */
async function runSmoke(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(electron, ['.'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.on('close', () => { clearTimeout(timer); resolve({ out, err }); });
    child.on('error', reject);
  });
}

let output = await runSmoke(env);

/*
 * 被自己的窗口占着锁时，**关掉它再来一次**。
 *
 * 应用是单实例的：用户开着窗口跑自检，第二份起不来就直接退，一个字都不打印 ——
 * 报出来的症状是「窗口没起来」，会让人去查渲染进程。所以这里不再只是打印一句提示。
 *
 * ⚠️ 只在**真的被占锁**时才动手（看主进程打的那行 SMOKE_FAIL），
 * 而不是每次自检都先杀一遍 —— 无故杀掉用户正开着的窗口，是拿用户的数据换测试方便。
 * ⚠️ 给了 `--profile` 的运行自带一份 userData、自带一把锁，跟用户的窗口不冲突，
 * 所以那种情况根本走不到这一步（也不该去动用户的窗口）。
 * ⚠️ 真不想让它动手就加 `--no-kill`。
 */
if (!output.out.includes('SMOKE_OK') && /已有实例在运行/.test(output.out + output.err)) {
  if (process.argv.includes('--no-kill')) {
    console.warn('! 已有一份本项目在运行，--no-kill 让它留在那儿；这次自检多半起不来');
  } else {
    const r = await closeRunningApp(root);
    if (r.killed) {
      if (r.forced) console.warn('  ! 它是被强杀的 —— 那 400ms 防抖里没写盘的改动会丢，别在它正忙的时候跑自检');
      output = await runSmoke(env);
    } else if (r.reason === 'no-pid-file') {
      // ⚠️ 这一支要说清楚：**认不出是谁占着锁**，不是「没人在跑」。
      // 旧版本的程序没有 pid 文件，或者文件被清掉了，都会走到这里。
      console.warn('! 锁被占着，但那个进程没留下身份标记（老版本的程序？），自动关不掉');
    } else if (r.reason === 'stubborn') {
      console.warn(`! pid ${r.pid} 关不掉（两次都没成），请手动结束它`);
    }
  }
}

/*
 * ---------- 「再试一次硬件加速」：这条链只能自己走一遍才知道 ----------
 *
 * 它跟别的自检不一样：**第一份进程注定不会打出 SMOKE_OK** —— 它按完按钮就把自己重启了，
 * 所以不能套下面那套判据，得单独判三件事：
 *   ① 渲染层真的按到了        —— stdout 里有 SMOKE_RETRYHW_CALL，带第一份的 pid
 *   ② 新的一份真的起来了      —— 标记文件里的 pid 跟第一份不一样
 *   ③ 主进程真的清了降级标记  —— boot.json 里的 degrade 不再是 true
 * 少任何一条，用户那边看到的都是「按了没反应」（最难看的是第三条：
 * 程序重启了、界面回来了，可它还是软件渲染，用户只会觉得「按了这个没用」）。
 */
if (retryhw) {
  const bad = [];
  const callLine = output.out.split(/\r?\n/).find((l) => l.startsWith('SMOKE_RETRYHW_CALL'));
  let firstPid = null;
  if (callLine) {
    try {
      firstPid = JSON.parse(callLine.slice('SMOKE_RETRYHW_CALL'.length))?.pid ?? null;
    } catch { /* 下面按「没按到」算 */ }
  }
  if (!firstPid) {
    const tail = output.out.split(/\r?\n/).filter(Boolean).slice(-5).join(' | ').slice(0, 300);
    bad.push(`渲染层没按到「再试一次」—— 没有 SMOKE_RETRYHW_CALL 那一行，按钮/桥/探针有一环没接上（stdout 尾部：${tail}）`);
  }

  // 新的一份是另一个进程，起得比第一份退得晚，所以要等一会儿
  let up = null;
  for (let i = 0; i < 40 && !up; i += 1) {
    try {
      up = JSON.parse(fs.readFileSync(retryMarker, 'utf8'));
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (!up) {
    bad.push(`重启之后的那一份没起来：${retryMarker} 一直没出现 —— 用户按下去的结局会是「程序关了，再也没回来」`);
  } else if (firstPid && Number(up.pid) === Number(firstPid)) {
    bad.push(`标记文件里的 pid 跟第一份一样（${up.pid}）—— 那不是重启，是同一个进程写了两次`);
  }

  let bootAfter = null;
  try {
    bootAfter = JSON.parse(fs.readFileSync(path.join(profileDir, 'boot.json'), 'utf8'));
  } catch { /* 文件没了就是没了，下面顺手报出来 */ }
  if (bootAfter?.degrade === true) {
    bad.push('按了「再试一次」但降级标记还在 —— 下一轮启动照样是软件渲染，这个按钮等于白按');
  }

  if (bad.length) {
    console.error(`\n✗ 「再试一次硬件加速」自检失败：${bad.length} 条`);
    for (const m of bad) console.error(`  · ${m}`);
    process.exit(1);
  }
  console.log('✓ 「再试一次硬件加速」自检通过');
  console.log(`  · 第一份 pid=${firstPid} 按下按钮 → 重启后的 pid=${up.pid} 自己报到了 → boot.json 里 degrade=${JSON.stringify(bootAfter?.degrade)}`);
  process.exit(0);
}

const line = output.out.split(/\r?\n/).find((l) => l.trim().startsWith('SMOKE_OK'));
if (!line) {
  console.error('✗ 桌面壳没有打出 SMOKE_OK（窗口没起来 / 渲染进程被杀了 / 已经有份程序开着）');
  const all = (output.out + output.err).split(/\r?\n/).filter(Boolean);
  for (const l of all.slice(-15)) console.error(`  ${l.slice(0, 200)}`);
  /*
   * ⚠️ 最常见的其实是第三种：**程序本来就开着**。应用是单实例的，第二份起不来就
   * 直接 quit —— 而它一个字都不打印的话，报出来的症状是「窗口没起来」，
   * 会让人去查渲染进程，查半天发现只是自己没关窗口。主进程现在会打一行
   * SMOKE_FAIL 说明原因，这里顺手翻译一下。
   */
  if (all.some((l) => l.includes('已有实例在运行'))) {
    console.error('  → 单实例锁被占：把正在运行的程序关掉再来；或者给 --profile 换一份一次性存档。');
    console.error('     （上面已经试着自动关掉本项目的进程了；`--no-kill` 可以让它别动手）');
  }
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

/*
 * 封面热区那一路的结果走的是**独立一行**（SMOKE_CARDOPEN …），不在 SMOKE_OK 的
 * JSON 里：它是主进程算出来的（sendInputEvent 只有主进程能发），而 SMOKE_OK 装的是
 * 渲染层探针的返回值。两处混在一起的话，探针那边就得反过来等主进程，绕。
 */
let cardReport = null;
{
  const coLine = output.out.split(/\r?\n/).find((l) => l.trim().startsWith('SMOKE_CARDOPEN'));
  if (coLine) {
    try {
      cardReport = JSON.parse(coLine.slice(coLine.indexOf('{')));
    } catch {
      cardReport = { parseError: coLine.slice(0, 200) };
    }
  }
}

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

// ---- 季度报告：画布要缩到横向不用拖 ----
// 这一组守的是「看不全」：光断言画布在、块数对，都验不出它是不是还得横着拖。
if (view === 'report') {
  check(Number(report.reportCanvas) === 1, `画布应有 1 张，实际 ${report.reportCanvas}`);
  check(
    Number(report.reportOverflowX) <= 1,
    `画布横向还得拖滚动条（溢出 ${report.reportOverflowX}px）—— 用户抱怨的就是这个：整幅缩不进可视宽度`,
  );
  const pct = Number(report.reportZoomPct);
  check(pct > 0 && pct <= 100, `界面上的缩放百分比不对（${pct}%）`);
  const zoom = Number(report.reportZoom);
  check(zoom > 0 && zoom <= 1, `预览倍率越界了（${zoom}）—— 上限是 1，放大没有意义，还会让滚动条回来`);
  check(
    Number(report.reportCanvasWidth) > 0,
    `画布的逻辑宽度丢了（${report.reportCanvasWidth}）—— 缩放只能改预览，不能改画布自己`,
  );
  // 反向：缩放一旦落到画布自己身上，导出图就会跟着缩 —— 那比「看不全」严重得多
  check(
    String(report.reportCanvasTransform) === 'none',
    `画布自己身上有 transform（${report.reportCanvasTransform}）—— 导出抓的是它的 outerHTML，会把缩放一起带出去`,
  );
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

// ---- 跨季搜索：能不能真的捞到本季之外的老番 ----
// 这一条守的是整条链：名称索引落到 userData → App 读到 → 在顶栏输入 →
// 下拉弹出来 → 列的是别季的命中。
// 纯函数与 SSR 各守一层，但「真壳里 React 的事件链通不通、索引读不读得到」
// 只有桌面壳能回答 —— 而索引读不到时，界面会安静地什么都不显示，看不出是坏了。
//
// ⚠️ 探针往受控 input 里打字用的是原生 setter（见 electron/main.cjs）——
// 直接赋 value 是走不到 onChange 的，那样这条断言会永远「面板没弹」，
// 而现象看着像功能坏了。
if (view === 'search') {
  check(Number(report.qsearchBox) === 1, `顶栏没有搜索容器（qsearchBox=${report.qsearchBox}）`);
  check(Number(report.searchInput) === 1, `顶栏没有搜索输入框（searchInput=${report.searchInput}）`);

  if (expected) {
    check(
      String(report.qsearchReady) === expected.ready,
      `索引可用状态应当是 ${expected.ready}，实际 ${report.qsearchReady} —— nameIndex.json 没被读到`,
    );
    check(
      Number(report.qsearchPanel) === expected.panel,
      `下拉应当列出 ${expected.panel} 条，实际 ${report.qsearchPanel}`
        + ' —— 关键词没进到组件里，或者别季的命中被当成「本季的」滤掉了',
    );
    check(
      Number(report.qsearchItems) === expected.items,
      `下拉命中项应当是 ${expected.items} 条，实际 ${report.qsearchItems}`,
    );
    check(
      JSON.stringify(report.qsearchNames) === JSON.stringify(expected.titles),
      `命中名应当是 ${JSON.stringify(expected.titles)}，实际 ${JSON.stringify(report.qsearchNames)}`,
    );
  } else {
    warnings.push('没有 --profile 播种名称索引，搜索下拉自然是空的（断言只在播种的那次才有意义）');
  }
}

// ---- 壁纸取景框：按住拖一下，位置要一路走到磁盘上 ----
// 这一条守的是「设置面板 → 指针拖动 → 像素换算 → store → 防抖 → IPC → state.json」。
// 换算本身由 core.test.mjs 的纯函数守着，框画成什么样由 SSR 守着，
// 但**这段中间的路只有真壳走得通** —— 而且它断掉时界面上什么都不报，
// 只是「拖了半天，重开又回去了」。
if (wp) {
  const w = report.wpdrag ?? {};
  check(
    Number(w.frame) === 1,
    `设置面板里没找到取景框（wpdrag=${JSON.stringify(w)}）—— 不是快捷键没打开设置，就是组件没接进外观页`,
  );

  if (Number(w.frame) === 1) {
    check(w.off === false, '取景框是灰的：壁纸文件没被读到，或者 settings.wallpaper.enabled 没升上来');
    check(w.box && !w.box.startsWith('0x'), `取景框量出来的尺寸不对（${w.box}），拖动换算的分母会是 1`);

    const axis = w.axis;
    const other = axis === 'x' ? 'y' : 'x';
    check(
      axis === 'x' || axis === 'y',
      `选不出可拖的轴（余量 x/y = ${w.overflow?.x}/${w.overflow?.y}）`
        + ' —— 这张图在框里几乎铺满了，自检换个尺寸的图再测，不是功能坏了',
    );

    if (axis === 'x' || axis === 'y') {
      // 拖的是「余量的四分之一」，期望位置正好走 25 个百分点。
      // 差得多说明换算的分母用错了（该用溢出量却用了框的边长）——
      // 那种错在界面上只是「拖起来有点飘」，读代码看不出来。
      // 容差按 ±1px 的取整误差折算：余量越小，同样的 1px 折成百分比就越大。
      const tol = Math.max(2, 100 / Number(w.room) + 0.5);
      const moved = Number(w.before?.[axis]) - Number(w.after?.[axis]);
      check(
        Math.abs(moved - 25) <= tol,
        `沿 ${axis} 拖了余量的 1/4（${w.dist}px / 共 ${w.room}px），位置应当走 25 个百分点，`
          + `实际走了 ${moved.toFixed(1)}（容差 ±${tol.toFixed(1)}）`,
      );
      check(moved > 0, `往正方向拖，位置该变小（跟拖地图一样是反的），实际 ${w.before?.[axis]} → ${w.after?.[axis]}`);
    }

    check(
      Number(w.after?.[other]) === Number(w.before?.[other]),
      `只拖了 ${axis} 方向，${other} 不该跟着动：${w.before?.[other]} → ${w.after?.[other]}`,
    );
    check(
      typeof w.hint === 'string' && w.hint.includes('偏'),
      `拖动之后那行人话没跟着变：${JSON.stringify(w.hint)}`,
    );

    // 真正的落点：防抖 → IPC → state.json
    let state = null;
    try {
      state = JSON.parse(fs.readFileSync(path.join(profileDir, 'state.json'), 'utf8'));
    } catch (err) {
      check(false, `读不到存档 ${path.join(profileDir, 'state.json')}：${err?.message ?? String(err)}`);
    }
    const saved = state?.settings?.wallpaper ?? null;
    check(
      saved && Number(saved[axis]) === Number(w.after?.[axis]),
      `拖完之后界面上是 ${w.after?.[axis]}，但 state.json 里存的是 ${saved?.[axis]}`
        + ' —— 没落盘，重开就回到中间了',
    );
    check(
      saved && Number(saved[other]) === Number(w.before?.[other]),
      `state.json 里的 ${other} 被顺带改了：${saved?.[other]}（期望 ${w.before?.[other]}）`,
    );
  }
}

// ---- 封面热区：真的用鼠标点一下，详情抽屉要开 ----
// 这一条守的是「用户点封面」这件最普通的事。它曾经坏过而**没有任何自检报出来**，
// 原因是当时开抽屉的自检写的是 `.card__title.click()` —— 点的是标题，不是封面：
// 断言只覆盖了「有个人能开抽屉」，没覆盖「点封面能开抽屉」。
//
// 更关键的是那句 click() 是**合成事件**：它把事件直接派发给元素，绕开了命中测试。
// 封面上真盖着东西时，合成事件照样成功，于是自检全绿、用户点不开。
// 所以这里用主进程的 sendInputEvent 走真实输入管线，并先把 elementFromPoint
// 的命中链取回来 —— 真出了遮挡，报告里能直接看出是谁盖的。
if (cardopen) {
  const b = cardReport?.before ?? {};
  const a = cardReport?.after ?? {};
  check(
    Number(b.found) === 1,
    `本季视图里没有一张卡片带封面热区（data-cover-open 一个都没有）`
      + `：cardopen=${JSON.stringify(cardReport)}`,
  );
  if (Number(b.found) === 1) {
    check(Number(b.openBefore) === 0, '开始之前抽屉就是开着的，这一次点击说明不了任何问题');
    /*
     * ⚠️ 判据是 `hitOpen`（热区上那个 data 属性），不是类名。
     * 这里原来写的是 `hit.includes('card__open')` —— 热区后来搬进共用的 <Cover>、
     * 类名改成 cover__hot，这条断言就**悄悄失效**了：它不会报错，只会永远红，
     * 而修法看起来像是「把类名改回去」。外观的类名会变，data 属性才是接口。
     */
    check(
      b.hitOpen === true,
      `封面正中点到的不是热区，而是 ${JSON.stringify(b.hit)}`
        + `（命中链 ${JSON.stringify(b.path)}）—— 有东西盖在封面上，用户点不到`,
    );
    check(
      Number(a.panel) === 1,
      `用鼠标真点了封面正中，详情抽屉却没开（after=${JSON.stringify(a)}）`
        + ' —— 热区在 DOM 里，但事件没走通',
    );
    /*
     * 「点的是 A、开出来的是 B」同样是错的，只看抽屉在不在是看不出来的。
     * 这条曾经真的差一点漏掉：每个视图各自把 onOpen 接到 <Cover> 上，
     * 某个视图传错一层（比如传了 map 的下标）就会这样坏。
     */
    if (b.hitOpenId != null) {
      check(
        String(a.drawerId) === String(b.hitOpenId),
        `点的是作品 ${b.hitOpenId}，抽屉里打开的是 ${JSON.stringify(a.drawerId)}（标题「${a.title}」）`
          + ' —— 列表里的 onOpen 接错了一层',
      );
    }
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
  // 打出来是因为「缩没缩」在截图里看不出来 —— 一张缩过的长图和一张原尺寸的，
  // 缩略图级别看上去都是「一块有内容的画布」。只有数字能证明它真的缩了。
  console.log(`  画布缩放：${report.reportZoomPct}%（倍率 ${report.reportZoom}）· 横向溢出 ${report.reportOverflowX}px（应为 0）`);
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
if (view === 'search') {
  console.log(
    `  搜索：输入「${SEARCH_WORD}」→ 下拉 ${report.qsearchPanel} 条 · 索引可用 ${report.qsearchReady}`
    + ` · 命中 ${(report.qsearchNames ?? []).join(' / ') || '(空)'}`,
  );
  if (expected) console.log(`  期望命中：${expected.titles.join(' / ')}`);
}
if (view === 'catchup') {
  console.log(`  补番卡片 ${report.diaryInputs} 张带打分控件`);
  if (expected?.click) {
    console.log(`  点击 ${expected.click} 分 → 界面显示 ${report.diaryLastRating} → 已确认写进 state.json`);
  }
}
if (wp) {
  const w = report.wpdrag ?? {};
  if (Number(w.frame) === 1) {
    console.log(
      `  取景框 ${w.box} · 图 ${wallSeed ? `${wallSeed.width}×${wallSeed.height}` : '?'}`
      + ` · 可挪余量 x/y = ${w.overflow?.x}/${w.overflow?.y}（拖 ${w.axis} 轴）`,
    );
    console.log(
      `  拖 ${w.axis} 方向 ${w.dist}px：${w.before?.[w.axis]}% → ${w.after?.[w.axis]}%`
      + `（期望走 25）· 另一轴 ${w.after?.[w.axis === 'x' ? 'y' : 'x']}% 未动 · 已确认写进 state.json`,
    );
    console.log(`  框里那行人话：${w.hint}`);
  }
}
if (cardopen) {
  const b = cardReport?.before ?? {};
  const a = cardReport?.after ?? {};
  console.log(`  封面热区 ${b.box} · 正中命中 ${JSON.stringify(b.hit)}`);
  console.log(`  真实鼠标点击 → 详情抽屉 ${a.panel ?? '?'} 个${a.title ? ` · 标题「${a.title}」` : ''}`);
  if (Array.isArray(b.path)) console.log(`  命中链：${b.path.join(' < ')}`);
}
console.log(`  截图：${path.relative(root, shot)}（${(fs.statSync(shot).size / 1024).toFixed(0)} KB）`);
for (const w of warnings) console.log(`  ! ${w}`);
