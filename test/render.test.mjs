import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

import { SAMPLE_ITEMS, SAMPLE_SEASON } from './fixtures/sample-state.js';
import { makeDefaultTierlist } from '../src/core/tierlist.js';

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

const { render, renderLibrary, renderCatchup, renderSettingsTabs, renderTier } = await import(pathToFileURL(outfile).href);

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
  assert.ok(html.includes('window__resize'), '窗口应有缩放把手');

  // 加载进度条
  assert.ok(html.includes('progressbar'), '顶栏应有进度条节点');
});

test('深链里的季度确实生效了，且内置数据真的渲染成了卡片', async () => {
  const html = await render();
  assert.ok(html.includes(`value="${SAMPLE_SEASON}"`), `季度选择器里应有 ${SAMPLE_SEASON}`);
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
