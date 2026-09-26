import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

import { SAMPLE_ITEMS, SAMPLE_SEASON } from './fixtures/sample-state.js';
import { makeDefaultTierlist } from '../src/core/tierlist.js';
import { makeBlock, makeDefaultReport } from '../src/core/report.js';

/**
 * 没有浏览器也要能验证界面确实渲染得出来：
 * 先把 JSX 打包成 ESM（react 走外部依赖），再用 renderToStaticMarkup 出字符串。
 * 这样四个视图的渲染在 CI 里就能兜住回归。
 *
 * 数据用的是随包发布的真实数据（内置季度），所以这里断言的是结构，
 * 不是某一个具体番剧名 —— 那个名字会随内置数据重新生成而变，
 * 钉死它只会换来一次假红。数据本身由 builtin.test.mjs 管。
 */

const outDir = path.resolve('test/.tmp');
mkdirSync(outDir, { recursive: true });
const outfile = path.join(outDir, 'ssr.mjs');

await build({
  entryPoints: [path.resolve('test/fixtures/ssr-entry.jsx')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  outfile,
  external: ['react', 'react-dom', 'react-dom/server', 'react/jsx-runtime'],
  logLevel: 'silent',
});

const { render, renderLibrary, renderCatchup, renderSettingsTabs, renderTier, renderDiary, renderDiaryInput, renderCatchupWithDiary, renderCover, renderReport, renderHistory, renderSearchBox, renderSeasonPicker, renderWindowCard, renderWallpaperFrame, renderSeasonView } = await import(pathToFileURL(outfile).href);

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// 有些约定只存在于样式表里（比如「取景框和壁纸用同一种铺法」），
// SSR 出来的 HTML 里看不到 —— 那种断言只能直接读这个文件
const CSS = readFileSync(path.resolve('src/styles.css'), 'utf8');
const titles = SAMPLE_ITEMS.map((a) => escapeHtml(a.titleZh || a.titleJa));
const countOf = (html, needle) => html.split(needle).length - 1;

/** 本地库测试里用作「刚才」的基准时刻；年龄文案要能稳定断言，不能跟着跑测试的时间漂 */
const NOW_MS = Date.UTC(2026, 9, 10, 12, 0, 0);

test('默认视图：骨架、卡片窗口、进度条都在', async () => {
  const html = await render();
  assert.ok(html.length > 2000, '渲染结果不应为空');

  for (const text of ['本季番剧', '时间表', '我的追番', '补番清单']) {
    assert.ok(html.includes(text), `侧栏应有导航项：${text}`);
  }
  assert.ok(html.includes('本季概览'), '应渲染统计窗口');
  assert.ok(html.includes('番剧库'), '应渲染番剧库窗口');

  // 卡片式窗口的拖拽 / 缩放把手
  assert.ok(html.includes('window__bar'), '窗口应有可拖拽标题栏');
  // 2026-09-26：原来只有右下角一个把手（类名 window__resize），
  // 加宽卡片得先摸到那个角 —— 卡片比画布宽时那个角还在滚动条外面。改成八条边。
  for (const dir of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
    assert.ok(html.includes(`data-window-resize="${dir}"`), `窗口应有 ${dir} 方向的缩放把手`);
  }

  // 加载进度条
  assert.ok(html.includes('progressbar'), '顶栏应有进度条节点');
});

test('深链里的季度确实生效了，且内置数据真的渲染成了卡片', async () => {
  const html = await render();
  /*
   * 原来断言的是 `value="2026q3"` —— 那会儿顶栏是个原生 `<select>`，选中项靠 value 表达。
   * 现在换成了可搜索的季度选择器（可选季度从 9 个扩到一百多个，原生下拉滚不动），
   * 当前季度改由 `data-season-current` 报出来。
   * 断言的**意图没变**：深链里那个季度要真的落到界面上，而不是被默认值顶掉。
   */
  assert.ok(
    html.includes(`data-season-current="${SAMPLE_SEASON}"`),
    `季度选择器应报出当前季 ${SAMPLE_SEASON}`,
  );
  assert.ok(html.includes(`${SAMPLE_SEASON.slice(0, 4)} 年`), '当前季的日期文案要显示出来');
  // 卡片真的铺开了：光有容器不算
  assert.ok(countOf(html, 'card__title') > 5, '番剧卡片数量太少，内置数据可能没被用上');
  assert.ok(
    titles.some((t) => html.includes(t)),
    '至少应该渲染出一部内置数据里的番剧名',
  );
});

test('番剧卡片：星期徽标、追番星标、评分、封面位', async () => {
  const html = await render();
  assert.ok(html.includes('card__badge'), '卡片应有星期徽标');
  assert.ok(html.includes('card__follow'), '卡片应有追番按钮');
  assert.ok(/周[一二三四五六日]/.test(html), '徽标应显示周几');
  assert.ok(html.includes('card__score'), '卡片应显示评分');
});

test('时间表视图：周一起排的七列 + 今日更新', async () => {
  const html = await render({ view: 'schedule' });
  assert.ok(html.includes('播出时间表'), '应渲染时间表窗口');
  assert.ok(html.includes('今日更新'), '应渲染今日更新窗口');
  for (const d of ['周一', '周二', '周三', '周四', '周五', '周六', '周日']) {
    assert.ok(html.includes(d), `周视图应有 ${d} 列`);
  }
  assert.ok(html.includes('weekcol--today'), '应标出今天那一列');
  assert.ok(html.includes('本周') && html.includes('次更新'), '应给出本周更新次数');
});

test('追番视图：队列 + 倒计时 + 一周分布', async () => {
  const html = await render({ view: 'following' });
  assert.ok(html.includes('追番队列'), '应渲染追番队列');
  assert.ok(html.includes('接下来 7 天'), '应渲染未来一周提醒');
  assert.ok(html.includes('追番分布'), '应渲染本周分布');
  assert.ok(html.includes('queue__value'), '应渲染倒计时数值');
  assert.ok(
    /天后|小时后|分钟后|已更新|完结|待定/.test(html),
    '倒计时区应给出可读状态而不仅仅是数字',
  );
  assert.ok(html.includes('queue__cover'), '队列行应有封面');
});

test('补番视图：deadline 卡片、进度条、分档标签', async () => {
  const html = await render({ view: 'catchup' });
  assert.ok(html.includes('补番清单'), '应渲染补番清单');
  assert.ok(html.includes('补番概览'), '应渲染补番概览');
  assert.ok(html.includes('bar__fill'), '卡片应有进度条');
  assert.ok(html.includes('date-input'), '卡片应可改截止日期');
  assert.ok(/逾期|还剩|已归档/.test(html), '应有 deadline 文案');
  assert.ok(/catchup--(overdue|urgent|normal)/.test(html), '卡片应带分档配色类名');
});

test('详情抽屉不在初始渲染里出现（点开才渲染）', async () => {
  const html = await render();
  assert.ok(!html.includes('drawer__panel'), '未点开时不应渲染抽屉');
});

test('切到一个没有内置数据的季度：界面不崩，也不会把别的季度的卡片带过来', async () => {
  const html = await render({ season: '1999q1' });
  assert.ok(html.length > 1000, '拿到空季度也应正常渲染');
  assert.ok(html.includes('本季概览'), '骨架要在');
  assert.equal(
    titles.some((t) => html.includes(t)),
    false,
    '空季度不该继续显示别的季度的番剧',
  );
});

// ===================== 本地库面板 =====================
//
// 这一批验证的是「界面真的画出来了」，而不是「代码写了」。
// 尤其值得注意的是：这里的组件走 props，绕开了 SSR 状态下 zustand
// 只读到初始状态那个坑（具体陷阱记在项目记忆里第 24 条）。

test('设置面板的标签栏里有「本地库」这一项', async () => {
  const html = await renderSettingsTabs();
  for (const t of ['外观', '数据源', '本地库', '布局', '提醒', '系统', '联系']) {
    assert.ok(html.includes(t), `标签栏应有：${t}`);
  }
});

test('本地库面板：更新按钮、季度勾选、索引状态都在', async () => {
  const html = await renderLibrary();
  assert.ok(html.includes('更新 Bangumi 数据'), '主按钮必须在');
  assert.ok(html.includes('要更新的季度'), '季度勾选项在');
  assert.ok(html.includes('重建名称索引'), '索引开关在');
  assert.ok(html.includes('本地库存'), '库存一览在');
  assert.ok(html.includes('名称索引'), '索引状态行在');
  assert.ok(html.includes('封面缓存'), '封面缓存在');
  assert.ok(html.includes('还没有建立'), '没有索引时要说清楚，别留一个看不懂的空面板');
  assert.ok(html.includes('本地还没有缓存任何封面'), '缓存为空时要有空态文案');
});

test('本地库面板：有索引、有缓存、有分组时能把数字显示出来', async () => {
  const html = await renderLibrary({
    nameIndex: { builtAt: NOW_MS, count: 8833, span: [1943, 2026], entries: [] },
    coverStats: {
      totalFiles: 100, totalBytes: 47_185_920,
      groups: [{ group: SAMPLE_SEASON, files: 82, bytes: 45_612_000 }, { group: 'catchup', files: 18, bytes: 1_573_920 }],
    },
    groups: [{ key: 'catchup', label: '补番组', hint: '搜索后加入补番清单的作品', count: 7, updatedAt: NOW_MS }],
  });
  assert.ok(html.includes('8833 部'), '索引条目数要显示');
  assert.ok(html.includes('1943–2026'), '覆盖年份要显示');
  assert.ok(html.includes('补番组'), '分组名要显示');
  assert.ok(html.includes('7 部'), '分组数量要显示');
  // 别手写换算结果 —— 45,612,000 字节是 43.50 MB（不是 45.02，以为差一点点的正好会算错）
  const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;
  assert.ok(html.includes(mb(45_612_000)), '封面占用要按 MB 显示（季度组）');
  assert.ok(html.includes(mb(1_573_920)), '补番组的占用也要显示');
  assert.ok(html.includes('100'), '总张数要显示');
});

test('本地库面板：更新中显示进度，结束后显示结果', async () => {
  const running = await renderLibrary({ running: true, progress: { pct: 42, label: '写入季度分组 2/4' } });
  assert.ok(running.includes('更新中 42%'), '按钮上要显示百分比');
  assert.ok(running.includes('写入季度分组 2/4'), '要显示当前在做什么');
  assert.ok(running.includes('bar__fill'), '要有进度条');

  const done = await renderLibrary({ report: { ok: true, text: '名称索引 8833 条 · 4 个季度共 219 部' } });
  assert.ok(done.includes('名称索引 8833 条'), '结果要显示出来');
  assert.ok(done.includes('report__row is-ok'), '成功要用绿色那一行样式');
});

// ===================== 补番视图的新分支 =====================

test('补番视图：按名字搜入口在，且没有索引时给出可执行的提示', async () => {
  const html = await renderCatchup({ rows: [], searchNote: '还没有名称索引 —— 到「设置 → 本地库」点一次更新就能搜了' });
  assert.ok(html.includes('catchup__search'), '搜索区要在');
  assert.ok(html.includes('还没有名称索引'), '提示要在');
  assert.ok(html.includes('设置 → 本地库'), '要告诉用户去哪儿解决，不能只说失败');
});

test('补番视图：搜索结果渲染成可点的「加入补番」列表', async () => {
  const html = await renderCatchup({
    rows: [],
    searchQuery: '孤独',
    results: [
      { id: 400602, zh: '孤独摇滚', ja: 'ぼっち・ざ・ろっく！', y: 2022, q: 4, t: 'tv', matched: '孤独摇滚', score: 100 },
    ],
  });
  assert.ok(html.includes('孤独摇滚'), '中文名要显示');
  assert.ok(html.includes('ぼっち・ざ・ろっく！'), '原名也要显示（有人习惯用原名搜）');
  assert.ok(html.includes('2022 年 第 4 季'), '年份季度要显示，方便分辨重名作品');
  assert.ok(html.includes('加入补番'), '每一条都要能加');
});

test('补番视图：查不到资料的卡片要留着并显示「待补全」', async () => {
  const rows = [{
    item: { id: 'c-1', subjectId: 999999, deadline: Date.UTC(2026, 9, 1), watchedEps: 0, targetEps: 12, archived: false },
    anime: { id: 999999, titleZh: '', titleJa: '条目 999999', cover: null, eps: null, __missing: true },
  }];
  const html = await renderCatchup({ rows });
  assert.ok(html.includes('条目 999999'), '至少名字要显示出来，卡片不能整张消失');
  assert.ok(html.includes('待补全'), '要显式标记这条还没资料');
  assert.ok(!html.includes('补番清单是空的'), '有卡片时不该显示空态');
});

test('补番视图：没有卡片时给的空态指向两种加入方式', async () => {
  const html = await renderCatchup({ rows: [] });
  assert.ok(html.includes('补番清单是空的'), '空态要在');
  assert.ok(html.includes('在上面搜一部番加进来'), '要指向新的搜索入口');
});

// ===================== Tier List（v1.1 阶段 D） =====================

const TIER_ROWS = ['TOP', 'A', 'B', 'C', 'D', 'TRASH', 'DRUG'];

test('Tier List：七档都在，档位名按预设来', async () => {
  const html = await renderTier();
  for (const label of TIER_ROWS) {
    assert.ok(html.includes(`>${label}<`), `档位表里应有 ${label}`);
  }
  assert.equal(countOf(html, 'tier-row__label'), 7, '应当是 7 档');
  assert.ok(html.includes('tier-pool'), '应渲染素材池');
});

test('Tier List：素材池里的番剧渲染成了图块，且排进档位后就从池子里消失', async () => {
  const all = await renderTier();
  assert.ok(countOf(all, 'tier-item') > 5, '素材池里应有多部番剧');

  const first = SAMPLE_ITEMS[0];
  assert.ok(all.includes(escapeHtml(first.titleZh || first.titleJa)), '池子里应能看到番剧名');

  // 把第一部排进 TOP
  const placed = await renderTier({
    tierlist: {
      ...makeDefaultTierlist(SAMPLE_SEASON),
      items: [{ key: String(first.id), rowId: 'r1' }],
    },
  });
  const poolPart = placed.split('tier-pool__grid')[1]?.split('</aside>')[0] ?? '';
  assert.equal(
    poolPart.includes(escapeHtml(first.titleZh || first.titleJa)),
    false,
    '排进档位的番剧不该还留在素材池里 —— 否则同一部能被拖两次',
  );
  assert.ok(placed.includes(escapeHtml(first.titleZh || first.titleJa)), '它应当在档位表里出现');
  assert.ok(placed.includes('>1</span>') || placed.includes('data-count="1"'), 'TOP 档的计数应为 1');
});

test('Tier List：搜索能过滤素材池', async () => {
  const poolOf = (html) => html.split('tier-pool__grid')[1]?.split('</aside>')[0] ?? '';

  const none = await renderTier({ pool: SAMPLE_ITEMS, keyword: '绝对搜不到的番剧名xyzzy' });
  assert.equal(countOf(poolOf(none), 'tier-item'), 0, '搜不到时应为空');
  assert.ok(poolOf(none).includes('empty'), '空态要有提示');

  // 搜一个真名：应当只剩它一个
  const one = SAMPLE_ITEMS[0];
  const hit = await renderTier({ pool: SAMPLE_ITEMS, keyword: one.titleZh || one.titleJa });
  assert.ok(countOf(poolOf(hit), 'tier-item') > 0, '搜真名应当有结果');
  assert.ok(poolOf(hit).includes(escapeHtml(one.titleZh || one.titleJa)), '命中的那部要在池子里');
  assert.ok(
    countOf(poolOf(hit), 'tier-item') < countOf(poolOf(await renderTier({ pool: SAMPLE_ITEMS })), 'tier-item'),
    '搜索之后池子应当变少',
  );
});

test('Tier List：封面走缓存还是直连，写在 data-cover 里', async () => {
  // 桌面壳：不许直连（会先由浏览器下一遍 45MB），没缓存就是「还没到」
  const desk = await renderTier({ pool: SAMPLE_ITEMS, coversRemote: false });
  assert.equal(countOf(desk, 'data-cover="none"'), countOf(desk, 'tier-item__art'), '桌面壳在缓存到位前应当是 none');
  assert.equal(countOf(desk, 'data-cover="remote"'), 0, '桌面壳绝不能退回直连');

  // 浏览器壳：没有缓存通道，必须退回直连
  const web = await renderTier({ pool: SAMPLE_ITEMS, coversRemote: true });
  assert.ok(countOf(web, 'data-cover="remote"') > 5, '浏览器壳应当退回直连');

  // 缓存里已经有图时才算 cache。
  // ⚠️ 键是**条目 id** 不是封面地址 —— 这条断言顺手就把新契约钉住了：
  // 拿地址当键的话这里会是 0，测试会红。
  const withImg = await renderTier({
    pool: SAMPLE_ITEMS,
    coversRemote: true,
    images: { [String(SAMPLE_ITEMS[0].id)]: 'data:image/jpeg;base64,AAAA' },
  });
  assert.equal(countOf(withImg, 'data-cover="cache"'), 1, '缓存里有图时应当算 cache');

  // 反向：拿地址当键必须查不到（v1.1 桌面端那个 bug 的形状）
  const byCover = await renderTier({
    pool: SAMPLE_ITEMS,
    coversRemote: true,
    images: { [SAMPLE_ITEMS[0].cover]: 'data:image/jpeg;base64,AAAA' },
  });
  assert.equal(countOf(byCover, 'data-cover="cache"'), 0, '拿封面地址当键不该命中');
});

test('Tier List：档位可改色（色值渲染进去了）、空的档位有占位提示', async () => {
  const html = await renderTier();
  assert.ok(html.includes('#ff7f7f'), '默认档位颜色应渲染出来');
  assert.ok(html.includes('type="color"'), '每一档应有改色入口');
  assert.ok(html.includes('拖到这里'), '空档要有落点提示');
});

test('Tier List：没有拖拽时不渲染影子，导出按钮在', async () => {
  const html = await renderTier();
  assert.equal(html.includes('tier-ghost'), false, '没拖就不该有影子');
  assert.ok(html.includes('导出 PNG'), '工具栏应有导出按钮');
  assert.ok(html.includes('按评分自动分档'), '工具栏应有自动分档按钮');
});

test('App 的 tier 视图与侧栏导航都挂上了', async () => {
  const html = await render({ view: 'tier' });
  assert.ok(html.includes('Tier List'), '侧栏应有 Tier List 导航项');
  assert.ok(html.includes('tier__board') || html.includes('tier-row'), 'tier 视图应真的渲染出档位表');
  for (const label of TIER_ROWS) {
    assert.ok(html.includes(label), `tier 视图里应有 ${label} 档`);
  }
});

// ---------- 补番日记 + 评分比对 ----------

const SAMPLE_DIARY = {
  1001: { entries: [{ at: Date.UTC(2026, 9, 1), rating: 9, note: '后半段起飞了' }], updatedAt: 0 },
  1002: { entries: [{ at: Date.UTC(2026, 9, 2), rating: 4, note: '' }], updatedAt: 0 },
  1003: { entries: [{ at: Date.UTC(2026, 9, 3), rating: 7, note: '没查到 Bangumi 评分的一部' }], updatedAt: 0 },
};

const SAMPLE_SCORES = { 1001: 7.4, 1002: 7.4, 1003: null };

function diaryLookupOf(scores) {
  return (key) => ({
    id: Number(key),
    score: Number(key) in scores ? scores[key] : null,
    titleZh: `作品 ${key}`,
    titleJa: `作品 ${key}`,
  });
}

test('补番日记：空态不是一块空白，要说清去哪儿才能有内容', async () => {
  const html = await renderDiary({ diary: {} });
  assert.ok(html.includes('data-diary-view="1"'), '日记视图应该渲染出来');
  assert.ok(html.includes('补番日记还是空的'), '空态要有文案');
  assert.ok(html.includes('去补番清单打分'), '空态要有去补番清单的入口');
  assert.equal(html.includes('data-diary-row'), false, '空的时候不该有比对行');
});

test('补番日记：比对表按分歧降序 —— 分歧最大的浮在最上面', async () => {
  const html = await renderDiary({ diary: SAMPLE_DIARY, lookup: diaryLookupOf(SAMPLE_SCORES) });
  const order = [...html.matchAll(/data-diary-row="(\d+)"/g)].map((m) => m[1]);
  // 1002 差 -3.4（分歧明显）、1001 差 +1.6（略偏）、1003 没有 BGM 分（沉底）
  assert.deepEqual(order, ['1002', '1001', '1003'], '排序必须是「分歧大的在前、不可比的沉底」');
});

test('补番日记：三档徽章都要能出现，且缺 BGM 分的走 unknown 而不是当成 0 分', async () => {
  const html = await renderDiary({ diary: SAMPLE_DIARY, lookup: diaryLookupOf(SAMPLE_SCORES) });
  assert.ok(html.includes('diary-cmp--apart'), '差 3.4 应当渲染成分歧');
  assert.ok(html.includes('diary-cmp--near'), '差 1.6 应当渲染成略偏');
  assert.ok(html.includes('diary-cmp--unknown'), '没有 BGM 分的要走 unknown');
  assert.ok(html.includes('BGM 未知'), '要明说 BGM 未知，不能显示成 0');
});

test('补番日记：均分只算两边都有分的，并把「有多少部没法比」说出来', async () => {
  // 1001 我给 9 / BGM 7.4；1002 我给 4 / BGM 7.4；1003 没有 BGM 分 → 不入均值
  const html = await renderDiary({ diary: SAMPLE_DIARY, lookup: diaryLookupOf(SAMPLE_SCORES) });
  // 读的是**属性值**不是文本：一开始这几个 data-* 写成了不带 `=` 的裸属性，
  // 渲染出来恒为 "true"，参数化自检就永远读到 true 还一切正常。这里顺带钉死。
  assert.ok(html.includes('data-diary-avg-mine="6.5"'), '我的均分应当是 6.5（(9+4)/2）');
  assert.ok(html.includes('data-diary-avg-bgm="7.4"'), 'BGM 均分应当是 7.4');
  assert.equal(html.includes('data-diary-avg-mine="true"'), false, '统计值必须显式带值，裸属性会退化成 true');
  assert.ok(/另有 1 部还差一边/.test(html), '必须写出「有几部没法比」，否则均分会被当成全部作品的均分');
});

test('补番日记：时间线页签在，短评能渲染出来', async () => {
  // 页签是受控 prop，不这么做的话这里永远是「否」，而那个「否」跟功能对不对无关
  const html = await renderDiary({
    diary: SAMPLE_DIARY,
    lookup: diaryLookupOf(SAMPLE_SCORES),
    tabProp: 'timeline',
  });
  assert.ok(html.includes('data-diary-tab="timeline"'), '要有时间线页签');
  assert.ok(html.includes('data-diary-panel="timeline"'), '受控页签应当真的切到时间线');
  assert.ok(html.includes('后半段起飞了'), '短评要渲染出来');
});

test('补番日记：同一部记了多条时给出「几条」的入口', async () => {
  const multi = {
    ...SAMPLE_DIARY,
    1001: {
      entries: [
        { at: Date.UTC(2026, 8, 1), rating: 6, note: '开头有点闷' },
        { at: Date.UTC(2026, 9, 1), rating: 9, note: '后半段起飞了' },
      ],
      updatedAt: 0,
    },
  };
  const html = await renderDiary({ diary: multi, lookup: diaryLookupOf(SAMPLE_SCORES) });
  assert.ok(html.includes('2 条'), '多条记录要有展开入口');
});

test('打分控件：1–10 十个按钮都在、没打分时不显示比对行', async () => {
  const html = await renderDiaryInput({ id: 1001 });
  const nums = [...html.matchAll(/data-diary-rate="(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(nums, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], '1–10 一个都不能少');
  assert.equal(html.includes('data-diary-cmp'), false, '没打分时不该有比对行');
  // ⚠️ 不能用 window.prompt：Electron 里它存在但一调用就抛
  assert.equal(/prompt\(/.test(html), false, '不许出现 prompt');
});

test('打分控件：已打分时显示「我的 / BGM / 差值」三段', async () => {
  const html = await renderDiaryInput({ id: 1001, rating: 9, note: '好看', bgmScore: 7.4, count: 1, lastEntryAt: 123 });
  assert.ok(html.includes('我的 9'));
  assert.ok(html.includes('BGM 7.4'));
  assert.ok(html.includes('+1.6'), '差值要带符号');
  assert.ok(html.includes('data-diary-cmp="near"'), '差 1.6 应当落在 near');
  assert.ok(html.includes('已记 1 次'), '记过之后要能看出记了几次');
});

test('打分控件：没有 BGM 分时不许显示成 0', async () => {
  const html = await renderDiaryInput({ id: 1001, rating: 9, bgmScore: null });
  assert.ok(html.includes('BGM 评分未知'));
  assert.equal(html.includes('BGM 0'), false, '缺评分绝不能显示成 0');
});

test('App 的 diary 视图与侧栏导航都挂上了', async () => {
  const html = await render({ view: 'diary' });
  // 用 data-nav 而不是「补番日记」四个字：页面上同名的小标题不止一处，
  // 按文字断言只能证明「这几个字出现过」，证明不了导航项存在。
  assert.ok(html.includes('data-nav="diary"'), '侧栏应有补番日记导航项');
  assert.ok(html.includes('data-diary-view="1"'), 'diary 视图应真的渲染出来');
});

test('App 的补番视图：打分控件是 App 自己接上去的，不是 fixture 外挂的', async () => {
  // 这个用例刻意走真正的 <App />。上面那个 renderCatchupWithDiary 是把控件
  // 从外面塞进 CatchupView 的，它证明「控件能被塞进去」，证明不了
  // 「App 真的塞了」—— 而漏接线正是最典型的、看起来哪儿都写了的失败。
  const html = await render({ view: 'catchup' });
  const cards = [...html.matchAll(/data-diary-for="(\d+)"/g)].map((m) => m[1]);
  assert.ok(cards.length >= 1, `App 得把打分控件真的接到补番卡片上（找到 ${cards.length} 个）`);
  assert.ok(html.includes('data-diary-note='), '卡片上要有短评输入口');
  assert.ok(html.includes('data-diary-save='), '卡片上要有保存按钮');
});

test('补番清单卡片上要出现打分控件（入口在清单上，不藏在详情里）', async () => {
  const rows = [{
    item: { id: 1, deadline: Date.UTC(2026, 9, 10), watchedEps: 3, targetEps: 12 },
    anime: { ...SAMPLE_ITEMS[0], score: 7.4 },
  }];
  // 分两种状态各渲一遍：没打过分时只有十个按钮，打过分之后要多出「我的 / BGM / 差值」那行。
  // 只测没打分的那一种，「打完分能看见跟 Bangumi 差多少」这个卖点就是没验过的。
  const fresh = await renderCatchupWithDiary(rows);
  assert.ok(fresh.includes(`data-diary-for="${SAMPLE_ITEMS[0].id}"`), '卡片上应当有打分口');
  assert.ok(fresh.includes('data-diary-rate="10"'), '卡片上的打分口要真的是那十个按钮，不能只是个占位');
  assert.equal(fresh.includes('data-diary-cmp='), false, '没打过分时不该有比对行');

  const rated = await renderCatchupWithDiary(rows, { ratingOf: () => 9 });
  assert.ok(rated.includes('BGM 7.4'), '卡片上要直接显示出 Bangumi 的分');
  assert.ok(rated.includes('+1.6'), '卡片上要直接给出差值，而不是让人去别的页面查');
});

/* ── 封面：同一张图，缓存里有 / 没有 / 不许直连 ────────────── */

const COVER_DATA_URL = 'data:image/jpeg;base64,AAAA';
const FIRST_ID = String(SAMPLE_ITEMS[0].id);

test('封面：缓存里有图就用缓存，并标明来源', async () => {
  const html = await renderCover({ anime: SAMPLE_ITEMS[0], images: { [FIRST_ID]: COVER_DATA_URL } });
  assert.ok(html.includes('data-cover="cache"'), '应当标成 cache');
  assert.ok(html.includes(COVER_DATA_URL), 'src 应当是缓存里的 dataUrl');
});

test('封面：缓存没有、且允许直连时退回远端地址（浏览器壳）', async () => {
  const html = await renderCover({ anime: SAMPLE_ITEMS[0], images: {}, allowRemote: true });
  assert.ok(html.includes('data-cover="remote"'));
  assert.ok(html.includes(SAMPLE_ITEMS[0].cover), 'src 应当是条目自己的封面地址');
});

test('封面：桌面壳不许直连 —— 取不到就退回色块，而不是偷着连网', async () => {
  const html = await renderCover({ anime: SAMPLE_ITEMS[0], images: {}, allowRemote: false });
  assert.ok(html.includes('data-cover="none"'));
  assert.ok(!html.includes(SAMPLE_ITEMS[0].cover), '关掉直连之后不该还留着远端地址');
  assert.ok(html.includes('cover__glyph'), '应当退回由标题派生的色块');
});

test('封面：两边都有时优先缓存（断网时才有图）', async () => {
  const html = await renderCover({
    anime: SAMPLE_ITEMS[0],
    images: { [FIRST_ID]: COVER_DATA_URL },
    allowRemote: true,
  });
  assert.ok(html.includes('data-cover="cache"'));
  assert.ok(!html.includes(SAMPLE_ITEMS[0].cover), '有缓存时不该再去碰远端地址');
});

test('封面：本季视图里每一张封面都写明「图是从哪来的」', async () => {
  const html = await render({ view: 'season' });
  const covers = (html.match(/class="cover[ "]/g) || []).length;
  const marked = countOf(html, 'data-cover="');
  assert.ok(covers > 5, `本季应当渲染出几张封面，实际 ${covers}`);
  assert.equal(marked, covers, '每张封面都要带来源标记，否则自动化没法判断降级路径走没走');
});

/*
 * 这里刻意**没有**「App 里缓存命中」的用例：
 * `renderToStaticMarkup` 不跑 useEffect，而封面是 useCovers 在 effect 里去取的，
 * 所以从 `<App />` 这一层永远拿不到缓存结果 —— 硬写就成了「验了个恒为空的东西」。
 * 缓存分支由 `renderCover`（直接喂 images）和桌面壳自检各守一半。
 */

/* ── 季度报告长图 ────────────────────────────────────────────
 *
 * 这一层刻意用 props 直接喂块，不走 store：块的排序/归一化在 report.test.mjs
 * 里由纯函数守着，这里守的是「块真的渲出来了、顺序跟数据一致、空态有出口」——
 * 三类问题在截图里长得一模一样（一片空白），只有数得出来的东西能区分。
 */

const A0 = SAMPLE_ITEMS[0];
const A1 = SAMPLE_ITEMS[1];

/** 造一份带块的报告；块都过 makeBlock 归一化，跟运行时的形状一致 */
const reportOf = (blocks, extra = {}) => ({
  ...makeDefaultReport(SAMPLE_SEASON),
  blocks,
  ...extra,
});

const FULL_COVERAGE = { total: 3, cached: 3, missing: 0, ratio: 1, missingKeys: [] };

test('季度报告：空画布要给出四个入口，且导出按钮是灰的', async () => {
  const html = await renderReport();
  assert.ok(html.includes('data-report-view="1"'), '报告视图的根节点标记');
  assert.ok(html.includes('data-report-empty="1"'), '空画布要有空态');
  for (const t of ['header', 'wall', 'award', 'text']) {
    assert.ok(html.includes(`data-report-add="${t}"`), `空态要有「加一块 ${t}」的入口`);
  }
  // 空报告底下那些按钮也都在（两个位置各一份，是故意的：空态里在画布中间，
  // 有内容时在底部工具条里）
  assert.ok(countOf(html, 'data-report-add="wall"') >= 2, '加块入口在空态和工具条里各有一份');
  assert.ok(html.includes('disabled'), '没内容时导出按钮必须是灰的，不能点了没反应');
  assert.ok(html.includes('data-report-no-selection="1"'), '没选中任何块时属性面板要有指路文案');
});

test('季度报告：四类块都渲得出来，且顺序跟数据一致', async () => {
  const blocks = [
    makeBlock('header', { id: 'b-1', title: '2026 秋 · 本季', subtitle: '共 82 部' }),
    makeBlock('wall', { id: 'b-2', title: '封面墙', subjectIds: [String(A0.id), String(A1.id)] }),
    makeBlock('award', { id: 'b-3', title: '最佳作画', body: '线条克制，动作戏不出戏', subjectId: String(A0.id) }),
    makeBlock('text', { id: 'b-4', body: '第一段\n第二段' }),
  ];
  const html = await renderReport({ report: reportOf(blocks), coverage: FULL_COVERAGE });

  for (const [id, type] of [['b-1', 'header'], ['b-2', 'wall'], ['b-3', 'award'], ['b-4', 'text']]) {
    assert.ok(
      html.includes(`data-report-block="${id}" data-block-type="${type}"`),
      `应当渲出 ${id}（${type}）`,
    );
  }

  // 顺序：块的先后就是产物的先后，错了长图上下颠倒，截图上完全看不出来
  const at = (id) => html.indexOf(`data-report-block="${id}"`);
  assert.ok(at('b-1') < at('b-2') && at('b-2') < at('b-3') && at('b-3') < at('b-4'), '块的顺序要与 blocks 一致');

  assert.ok(html.includes('2026 秋 · 本季'), '标题块要出现标题文字');
  assert.ok(html.includes('共 82 部'), '副标题也要出来');
  assert.ok(html.includes('data-report-wall-tiles="2"'), '封面墙要有两张图块');
  assert.ok(html.includes('data-report-body'), '正文块要有正文节点');
  assert.ok(countOf(html, 'data-report-wall-tile="') === 2, '图块数量要跟 subjectIds 一致');
  assert.ok(html.includes('最佳作画'), '奖项块的标题要出来');
});

test('季度报告：墙上查不到的作品要留占位，不能静默少一格', async () => {
  const ghost = '99999999';
  const blocks = [makeBlock('wall', { id: 'b-1', subjectIds: [String(A0.id), ghost] })];
  const html = await renderReport({ report: reportOf(blocks), coverage: FULL_COVERAGE });
  // 静默丢掉的话，用户会以为「这堵墙本来就只放了一部」—— 找不到的必须看得见
  assert.ok(html.includes(`data-report-wall-missing="${ghost}"`), '查不到的条目要有显式占位');
  assert.ok(html.includes('查不到'), '占位上要写清楚为什么是个问号');
  assert.ok(html.includes(`data-report-wall-tiles="1"`), '真实条目只算查得到的那一张');
});

test('季度报告：缺封面时拦住导出，并且说明原因', async () => {
  const blocks = [makeBlock('wall', { id: 'b-1', subjectIds: [String(A0.id), String(A1.id)] })];
  const html = await renderReport({
    report: reportOf(blocks),
    coverage: { total: 2, cached: 1, missing: 1, ratio: 0.5, missingKeys: [String(A1.id)] },
  });
  assert.ok(html.includes('data-report-gate="1"'), '缺图要说出来');
  assert.ok(html.includes('data-report-cover-cached="1" data-report-cover-total="2"'), '要给出缓存进度');
  // 两个导出按钮都必须是灰的 —— 一张缺了封面的墙，用户会直接发出去再被人指出来
  const pdfBtn = html.slice(html.indexOf('data-report-export-pdf="1"') - 260, html.indexOf('data-report-export-pdf="1"'));
  assert.ok(pdfBtn.includes('disabled'), '缺图时 PDF 按钮要灰掉');
});

test('季度报告：素材面板能筛，并且能看出哪些已经在墙里', async () => {
  const blocks = [makeBlock('wall', { id: 'b-1', subjectIds: [String(A0.id)] })];
  const html = await renderReport({ report: reportOf(blocks), pool: SAMPLE_ITEMS, coverage: FULL_COVERAGE });
  assert.ok(html.includes(`data-report-pool-rows="${SAMPLE_ITEMS.length}"`), '不带关键字时池子要给全部素材');
  assert.ok(
    html.includes(`data-report-pool-item="${A0.id}" data-report-pool-used="1"`),
    '已经在墙里的那一部要标出来，否则用户会一直点、以为是没生效',
  );

  // 关键字是受控的：组件内部 state 外面灌不进去，这一类「筛完剩几部」就只能这么测
  const none = await renderReport({ report: reportOf(blocks), pool: SAMPLE_ITEMS, keyword: '这个关键字肯定没有' });
  assert.ok(none.includes('data-report-pool-rows="0"'), '筛不到时应当是 0 行');
  assert.ok(none.includes('这个关键字下没有作品'), '筛不到要给一句人话');
});

test('季度报告：深链 #/report 能进到画布（组件好用 ≠ 接进了 App）', async () => {
  const html = await render({ view: 'report' });
  assert.ok(html.includes('data-nav="report"'), '侧栏要有季度报告这一项');
  assert.ok(html.includes('data-report-view="1"'), 'App 得把报告视图真的渲出来');
  assert.ok(html.includes('data-report-canvas="1"'), '画布节点要在');
  assert.ok(html.includes('data-report-canvas-width="1220"'), '画布宽度的默认值应当是 1220');
  assert.ok(html.includes('季度报告'), '窗口卡片标题要在');
});

// ---------- 追番历程 ----------

const DAY_MS = 86400000;
const T_HIST = Date.UTC(2026, 8, 1); // 2026-09-01
const histLookup = (id) => SAMPLE_ITEMS.find((a) => String(a.id) === String(id)) ?? null;

test('追番历程：一部都没有时，空态要说清「从今天起会自己长出来」', async () => {
  const html = await renderHistory();
  assert.ok(html.includes('data-history-view="1"'), '历程视图的根节点标记');
  assert.ok(html.includes('data-history-total="0"'));
  assert.ok(html.includes('还没有追番'), '一句话说清去哪儿才有内容');
  assert.ok(html.includes('去本季番剧'), '空态要有出口，不能只留一块空白');
  assert.ok(!html.includes('data-history-events'), '没有事件时不该渲染列表容器');
});

test('追番历程：开始追与看完了都画得出来，耗时按天算', async () => {
  // ⚠️ 必须挑**真的有集数**的条目：`isFinished` 只认「已看 ≥ 总集数」，
  // 而内置数据里不少条目没有 eps —— 拿它去测会得到「看完了 0 部」，
  // 看着像渲染坏了，其实是测试挑错了素材。筛不出来就是数据出了问题，要红。
  const pool = SAMPLE_ITEMS.filter((a) => Number(a.eps) > 0);
  assert.ok(pool.length >= 2, `内置数据里挑不出两部有集数的番（只有 ${pool.length} 部），历程断言没法验`);
  const [A, B] = pool;

  const html = await renderHistory({
    following: {
      [A.id]: { status: 'watching', watchedEps: A.eps, followedAt: T_HIST, lastAt: T_HIST + 5 * DAY_MS },
      [B.id]: { status: 'watching', watchedEps: 1, followedAt: T_HIST + 3 * DAY_MS, lastAt: T_HIST + 4 * DAY_MS },
    },
    lookup: histLookup,
  });

  assert.ok(html.includes('data-history-total="2"'), '两部都要算进总数');
  assert.ok(html.includes('data-history-finished="1"'), '只看完了 A 一部');
  assert.ok(html.includes('data-history-events="3"'), 'A 两条 + B 一条');
  assert.equal(countOf(html, 'data-history-event="follow"'), 2);
  assert.equal(countOf(html, 'data-history-event="finish"'), 1);
  assert.ok(html.includes('data-history-finish-days="5"'), '耗时算出来了');
  assert.ok(html.includes('用了 5 天'), '耗时要有中文说法 —— 光一个数字看不出单位');
  assert.ok(html.includes('data-history-avg="5"'));
  assert.ok(html.includes('data-history-untimed="0"'), '两部都有时间戳');
  assert.ok(html.includes('开始追') && html.includes('看完了'), '两类事件都要有标签');
});

test('追番历程：没有时间戳的作品算进总数，但要明说它排不进时间轴', async () => {
  const A = SAMPLE_ITEMS[0];
  const html = await renderHistory({
    following: { [A.id]: { status: 'watching', watchedEps: 1 } },
    lookup: histLookup,
  });

  assert.ok(html.includes('data-history-total="1"'), '没有时间戳也要算进追番总数');
  assert.ok(html.includes('data-history-tracking="0"'));
  assert.ok(html.includes('data-history-untimed="1"'));
  assert.ok(html.includes('没有时间戳'), '得说清为什么时间轴是空的，否则会被当成功能坏了');
  assert.ok(!html.includes('data-history-events'), '没有事件就不该有列表');
});

test('追番历程：写过笔记的点出「你为它写得最多」，没写字的绝不硬凑', async () => {
  const A = SAMPLE_ITEMS[0];
  const long = '这一部的节奏我很喜欢'.repeat(2);
  const html = await renderHistory({
    diary: { [A.id]: { entries: [{ at: 1, rating: 9, note: long }] } },
    lookup: histLookup,
  });
  assert.ok(html.includes(`data-history-highlight="${A.id}"`));
  assert.ok(html.includes('你为它写得最多'));
  assert.ok(html.includes(`${long.length} 字`), '要给个用户自己能核对的理由，而不是一个凭空的分数');

  const none = await renderHistory({
    diary: { [A.id]: { entries: [{ at: 1, rating: 9, note: '' }] } },
    lookup: histLookup,
  });
  assert.ok(!none.includes('data-history-highlight'), '只有评分没写字，不算「写得最多」');
});

test('App 的 history 视图与侧栏导航都挂上了（组件好用 ≠ 接进了 App）', async () => {
  const html = await render({ view: 'history' });
  assert.ok(html.includes('data-nav="history"'), '侧栏要有追番历程这一项');
  assert.ok(html.includes('data-history-view="1"'), 'App 得把历程视图真的渲出来');
  assert.ok(html.includes('追番历程'), '窗口卡片标题要在');
  // 播种的 6 部追番**没有时间戳** —— 这正是老用户升级后的第一眼。
  // 数字要对（6 部都在总数里），但不能假装它们有时间。
  assert.ok(html.includes('data-history-total="6"'), '播种的 6 部要算进总数');
  assert.ok(html.includes('data-history-untimed="6"'), '没有时间戳就如实说 6 部都未知');
});

// ---------------- 跨季搜索（v1.4）----------------

test('跨季搜索：下拉列出别季的命中，且标出是哪一季', async () => {
  const html = await renderSearchBox({
    value: '鬼灭',
    others: [
      { id: 1, zh: '鬼灭之刃', ja: '鬼滅の刃', type: 'tv', seasonKey: '2019q2', score: 100 },
      { id: 2, zh: '鬼灭之刃 无限列车篇', ja: '鬼滅の刃 無限列車編', type: 'tv', seasonKey: '2021q4', score: 90 },
    ],
    inSeason: 2,
  });

  assert.ok(html.includes('data-qsearch-panel="2"'), '下拉要在，条数写进属性便于自检');
  assert.equal(countOf(html, 'data-qsearch-item='), 2, '两条命中都要列出来');
  assert.ok(html.includes('鬼灭之刃'), '名字要在');
  assert.ok(html.includes('data-qsearch-in-season="2"'), '本季命中数要写进属性');
  // 光给一个名字、不说是哪一季，用户没法判断要找的是不是这一部
  assert.ok(html.includes('2019 年 4 月'), '别季的要标出年份和月份');
  assert.ok(html.includes('本季另有 2 部'), '本季命中的要去重说明，避免用户以为漏了');
});

test('跨季搜索：输入为空时一个面板都不弹（免得一进界面就挂一块东西）', async () => {
  const html = await renderSearchBox({
    value: '',
    others: [{ id: 1, zh: '鬼灭之刃', ja: 'x', type: 'tv', seasonKey: '2019q2' }],
  });
  assert.equal(countOf(html, 'data-qsearch-panel='), 0, '空关键词不弹面板');
  assert.equal(countOf(html, 'data-qsearch-item='), 0);
  assert.ok(html.includes('data-search-input="1"'), '输入框本身要在');
});

test('跨季搜索：还没有名称索引时给一句说明，而不是一个空下拉', async () => {
  // 索引要在「设置 → 本地库」手动更新一次才会建。没建时直接给空结果的话，
  // 用户只会以为「搜不到」，不会想到是自己还没建索引。
  const html = await renderSearchBox({ value: '鬼灭', ready: false });

  assert.ok(html.includes('data-qsearch-ready="0"'), '要把「索引不可用」这个状态说出来');
  assert.ok(html.includes('名称索引'), '文案要提到索引');
  assert.ok(html.includes('本地库'), '要告诉用户去哪儿建');
  assert.equal(countOf(html, 'data-qsearch-item='), 0, '没索引时不该有命中项');
});

test('跨季搜索：别季没命中但本季有时，说清「已经在下面列表里」', async () => {
  const html = await renderSearchBox({ value: '转生', others: [], inSeason: 5 });
  assert.ok(html.includes('data-qsearch-panel="0"'), '面板要在（用来交代情况）');
  assert.equal(countOf(html, 'data-qsearch-item='), 0, '没有别季命中就不该有列表项');
  assert.ok(html.includes('本季有 5 部匹配'), '数字要带上，让用户知道不是搜不到');
});

test('跨季搜索：顶栏真的挂上了（组件好用 ≠ 接进了 App）', async () => {
  const html = await render({});
  assert.ok(html.includes('data-qsearch="1"'), 'App 顶栏要有搜索容器');
  // 快捷键「/」靠这个属性找输入框，换掉的话快捷键会静默失效 —— 一并钉住
  assert.ok(html.includes('data-search-input="1"'), '快捷键「/」找的就是这个属性');
  assert.ok(html.includes('搜番剧名'), 'placeholder 要在');
});

/* ── 季度选择器 ────────────────────────────────────────────
 *
 * 这个功能存在的全部理由是「2011 年 7 月番以前选不到」，
 * 所以断言必须**真的落到 2011q3 上**，而不是只验「面板画出来了」。
 */

test('季度选择器：收起时报出当前季', async () => {
  const html = await renderSeasonPicker();
  // 用 SAMPLE_SEASON 而不是写死 '2026q3' —— 内置季度表换一份，写死的那条就变成假红
  assert.ok(html.includes(`data-season-current="${SAMPLE_SEASON}"`), '收起时要报出当前季');
  assert.ok(html.includes(`${SAMPLE_SEASON.slice(0, 4)} 年`), '要显示人话的季度名，不是 key');
  assert.equal(html.includes('data-season-panel='), false, '收起时不该有面板');
});

test('季度选择器：搜「2011 年 7 月」能落到 2011q3，且只落这一季', async () => {
  const html = await renderSeasonPicker({ initialOpen: true, initialQuery: '2011 年 7 月' });
  assert.ok(html.includes('data-season-item="2011q3"'), '7 月开播 = 2011q3，必须出现在结果里');
  assert.equal(countOf(html, 'data-season-item='), 1, '7 月只对应一季，多列了就是季度换算错了');
  assert.ok(html.includes('data-season-count="1"'), '计数要跟列表一致');
});

test('季度选择器：几种写法都要落到同一季（年份 / qN / 月份）', async () => {
  // 「2011」放宽到全年四季：这不是错误，是「先看看那一年」
  const year = await renderSeasonPicker({ initialOpen: true, initialQuery: '2011' });
  assert.equal(countOf(year, 'data-season-item='), 4, '只给年份时应列出那一年四季');

  // 这几种都得落到 2011q3。⚠️ 别把「秋」写进来 —— 它对应 **q4**，
  // 放进来会得到一条「测试自己算错了季度」的红，而不是功能坏了
  for (const w of ['2011q3', '2011-07', '2011 7', '2011 年 7 月']) {
    const html = await renderSeasonPicker({ initialOpen: true, initialQuery: w });
    assert.ok(html.includes('data-season-item="2011q3"'), `「${w}」应该能定位到 2011q3`);
  }

  // 季节名单独验：秋 = q4，所以该落在 2011q4 上
  const autumn = await renderSeasonPicker({ initialOpen: true, initialQuery: '2011 秋' });
  assert.ok(autumn.includes('data-season-item="2011q4"'), '「秋」要落到第四季');
  assert.ok(!autumn.includes('data-season-item="2011q3"'), '「秋」不该把夏季也算进来');
});

test('季度选择器：搜不到就说没匹配上，绝不弹一堆无关季度', async () => {
  const html = await renderSeasonPicker({ initialOpen: true, initialQuery: 'zzz' });
  assert.ok(html.includes('data-season-empty="1"'), '要有「没匹配上」的说明');
  assert.equal(countOf(html, 'data-season-item='), 0, '解析不出关键词时不该列出任何季度');
});

test('季度选择器：多选模式报出已选个数，并把勾中的标出来', async () => {
  const html = await renderSeasonPicker({
    mode: 'multi',
    initialOpen: true,
    initialQuery: '2011',
    values: ['2026q3', '2011q3'],
  });
  assert.ok(html.includes('data-season-picked="2"'), '要在页脚报出已选个数');
  assert.ok(html.includes('已选 2 个'), '数字也要说给人看');
  // 「2011q3」在候选里且已选 → 要带选中样式；同一次搜索里的 2011q1 不该被标成选中
  assert.equal(countOf(html, 'spick__item is-on'), 1, '只有已选的那条该带 is-on');
  assert.ok(html.includes('data-season-recent="1"'), '多选模式要有「最近四季」快捷键');
});

/* ── 卡片：点封面 = 打开详情 ───────────────────────────── */

test('番剧卡片：封面整块都是打开详情的入口，星标仍在它上面', async () => {
  const html = await render({});
  const cards = countOf(html, 'card__title');
  assert.ok(cards > 5, '先得有卡片，才谈得上点');
  assert.equal(
    countOf(html, 'data-card-open='),
    cards,
    '每张卡都该有一个封面热区 —— 数量对不上就是有卡片漏了（以前只有标题能点）',
  );
  // 星标必须还在，且压在热区上面（z-index 三层：热区 1、徽标 2、星标 3）
  assert.ok(countOf(html, 'card__follow') >= cards, '星标不能因为加了热区就没了');
  assert.ok(html.includes('card__open'), '热区的类名要在，样式靠它定位');
});

/* ── 卡片窗口：八方向缩放 ─────────────────────────────── */

test('卡片窗口：八个方向都有缩放把手，最多化和折叠时收起来', async () => {
  const html = await renderWindowCard();
  for (const dir of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
    assert.ok(html.includes(`data-window-resize="${dir}"`), `缺了 ${dir} 方向的把手`);
  }
  // 一张卡正好八个。多出来的多半是把手被渲了两遍（那样命中判定会互相抢）
  assert.equal(countOf(html, 'data-window-resize='), 8, '一张卡应该正好 8 个把手');
  // 反向：旧的那个孤零零的角把手类名不该再出现，否则会多出一层和边条重叠的热区
  assert.equal(html.includes('window__resize'), false, '旧的单角把手类名要彻底换掉');
  // 把手要能挡住指针事件才算数（z-index 写在 CSS 里，这里只钉住它挂了类）
  assert.equal(countOf(html, 'window__edge '), 8, '每条边都要有 window__edge 基类');
});

/* ── 壁纸取景框 ───────────────────────────────────────── */

test('壁纸取景框：画出来的构图和真正铺上去的必须是同一件事', async () => {
  const html = await renderWallpaperFrame();
  // 位置：百分比直接进 background-position，跟 .wallpaper 那条规则同义
  assert.ok(html.includes('background-position:30% 70%'), '取景框要按当前 x/y 画背景');
  assert.ok(html.includes('data-wp-x="30"'), '当前 x 要报出来，自检靠它');
  assert.ok(html.includes('data-wp-y="70"'), '当前 y 要报出来');
  // 比例：框和窗口同比例，不然「框里看着正好」的构图铺上去就偏了
  assert.ok(html.includes('data-wp-aspect="2"'), '比例要能从 props 灌进来');
  assert.ok(html.includes('aspect-ratio:2'), '比例要真的落到行内样式上');
  // 人话提示 + 回正
  assert.ok(html.includes('偏左 · 偏下'), '要把位置说成人话（x=30 偏左、y=70 偏下）');
  assert.ok(html.includes('data-wp-reset'), '要给一个一键回正的出口');

  /*
   * 「取景框和真壁纸用的是同一套铺法」这件事在 HTML 里看不到 —— 它在样式表里。
   * 所以只能直接读样式表。这条看着笨，守的是最要命的一处不一致：
   * 一边 cover 一边 contain 的话，框里挑好的构图铺到窗口上就会整个变形，
   * 而界面上没有任何地方会报错。
   */
  for (const sel of ['.wallpaper {', '.wpframe {']) {
    const i = CSS.indexOf(sel);
    assert.ok(i >= 0, `样式表里找不到 ${sel}`);
    const block = CSS.slice(i, CSS.indexOf('}', i));
    assert.match(block, /background-size:\s*cover/, `${sel} 应该用 cover 铺满（跟另一边一致）`);
  }
});

test('壁纸取景框：老存档只有关键字时也能升上来', async () => {
  const html = await renderWallpaperFrame({ x: null, y: null, position: 'top' });
  assert.ok(html.includes('data-wp-x="50"'), 'top → x 居中');
  assert.ok(html.includes('data-wp-y="0"'), 'top → y 靠顶');
  assert.ok(html.includes('background-position:50% 0%'), '升上来的结果要真的画出来');
});

test('壁纸取景框：没图 / 没开的时候是灰的，不给一个拖了没反应的框', async () => {
  const empty = await renderWallpaperFrame({ dataUrl: null, disabled: false });
  assert.ok(empty.includes('is-off'), '没选图时要标成不可交互');
  assert.ok(empty.includes('选一张图片之后就能拖'), '要说清楚为什么拖不动');
  assert.ok(empty.includes('tabindex="-1"'), '不可交互时不该进 Tab 序列');

  const off = await renderWallpaperFrame({ disabled: true });
  assert.ok(off.includes('is-off'), '壁纸关掉时同样不该能拖');
});

test('设置面板的外观页：五关键字下拉已被取景框取代', async () => {
  const html = await renderSettingsTabs();
  assert.ok(html.includes('data-wp-frame'), '外观页要有取景框');
  assert.equal(
    html.includes('<option value="center">居中</option>'),
    false,
    '旧的「对齐」下拉该换掉了 —— 五个关键字选不了中间那一大片位置',
  );
});

/* ── 番剧网格：一格宽 ─────────────────────────────────── */

test('番剧网格：一格宽档位落到网格的列宽上', async () => {
  const loose = await renderSeasonView({ cardMin: 160 });
  assert.ok(loose.includes('data-card-min="160"'), '档位要报出来');
  assert.ok(loose.includes('--card-min:160px'), '列宽要真的跟着变，不然滑块是个摆设');
  // 反向：档位没变的时候不能是上一轮的残留
  assert.equal(loose.includes('--card-min:112px'), false, '160 的时候不该还写着 112');

  const dflt = await renderSeasonView();
  assert.ok(dflt.includes('--card-min:112px'), '没给值时用默认 112');

  // 越界的档位要夹回来（老存档被手改过、或以后改了范围）
  const wild = await renderSeasonView({ cardMin: 9999 });
  assert.ok(wild.includes('--card-min:220px'), '超大档位要夹到上限');
  const tiny = await renderSeasonView({ cardMin: 1 });
  assert.ok(tiny.includes('--card-min:76px'), '过小的档位要夹到下限');
});
