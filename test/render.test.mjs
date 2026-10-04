import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

import { SAMPLE_ITEMS, SAMPLE_SEASON } from './fixtures/sample-state.js';
import { makeDefaultTierlist, PRESET_ROW_GROUPS } from '../src/core/tierlist.js';
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

const { render, renderLibrary, renderCatchup, renderSettingsTabs, renderTier, renderDiary, renderDiaryInput, renderCatchupWithDiary, renderCover, renderReport, renderHistory, renderSearchBox, renderSeasonPicker, renderWindowCard, renderWallpaperFrame, renderSeasonView, renderScaleDock, renderYuc, renderYucDetail, yucSample } = await import(pathToFileURL(outfile).href);

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

  // 卡片式窗口：拖标题栏移动，**没有**缩放手柄
  assert.ok(html.includes('window__bar'), '窗口应有可拖拽标题栏');
  /*
   * 八条边的把手做过一轮又撤掉了：窗口能拉大、里面的封面和字还是原来那么大，
   * 那不是用户要的（他要的是**内容**的比例，现在归设置里的「封面尺寸 / 文字大小」管）。
   * 反向断言放在这里，是因为「撤掉的功能悄悄回来」比「没做」更难发现。
   */
  assert.equal(countOf(html, 'data-window-resize='), 0, '窗口不该再有缩放把手');

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

/* ── 自定义档位 ───────────────────────────────────────── */

test('档位组下拉：三套预设之外还要有「自定义」', async () => {
  const html = await renderTier();
  for (const p of PRESET_ROW_GROUPS) {
    assert.ok(html.includes(`>${p.name}</option>`), `下拉里少了预设「${p.name}」`);
  }
  assert.ok(html.includes('>自定义</option>'), '下拉里要有「自定义」这一项，否则这个功能等于没入口');
  assert.equal(html.includes('value="custom" selected'), false, '默认还是预设，不能一进来就是自定义');
});

test('预设档位下不露删档入口：那不是用户此刻在做的事', async () => {
  const html = await renderTier();
  assert.equal(countOf(html, 'data-row-del='), 0, '预设是成套的，随手删一档会让 items 里的 rowId 悬空');
  assert.equal(html.includes('+ 加一档'), false, '加档的按钮同理，只在自定义下出现');
});

test('自定义档位：每一档都有删除口，工具栏有加一档', async () => {
  const base = makeDefaultTierlist(SAMPLE_SEASON);
  const html = await renderTier({ tierlist: { ...base, presetId: 'custom' } });

  assert.equal(
    countOf(html, 'data-row-del='),
    base.rows.length,
    '自定义下每一档都该有删除按钮',
  );
  for (const row of base.rows) {
    assert.ok(html.includes(`data-row-del="${row.id}"`), `档位 ${row.id} 上没找到删除按钮`);
  }
  assert.ok(html.includes('+ 加一档'), '自定义下要能加档');
  assert.ok(html.includes('回到素材池'), '删档要说明图块不会丢 —— 不说的话没人敢点');
  // 反向：预设名还在下拉里，但当前选中的是自定义
  assert.ok(html.includes('value="custom" selected'), '此刻下拉里该显示「自定义」');
});

test('自定义档位：只剩两档时删除按钮要禁用，不是点了没反应', async () => {
  const base = makeDefaultTierlist(SAMPLE_SEASON);
  const two = { ...base, presetId: 'custom', rows: base.rows.slice(0, 2) };
  const html = await renderTier({ tierlist: two });
  assert.equal(countOf(html, 'data-row-del='), 2);
  // 卡在「删档按钮自己」上做正则：工具栏以后多一个禁用按钮，不该把这条弄红
  const disabledDel = (s) => (s.match(/data-row-del="[^"]*" disabled=""/g) || []).length;
  assert.equal(disabledDel(html), 2, '到下限要标成禁用（还能再点一次就说明这个下限没生效）');
  const enabled = await renderTier({ tierlist: { ...base, presetId: 'custom' } });
  assert.equal(disabledDel(enabled), 0, '七档的时候不该有任何一档是禁用的');
});

test('自定义档位：改过的名字要真的画在行上', async () => {
  const base = makeDefaultTierlist(SAMPLE_SEASON);
  const rows = base.rows.map((r, i) => (i === 0 ? { ...r, label: '神作' } : r));
  const html = await renderTier({ tierlist: { ...base, presetId: 'custom', rows } });
  assert.ok(html.includes('>神作<'), '改过的档位名要出现在表上');
  assert.equal(html.includes('>TOP<'), false, '改掉的那一档不该还留着旧名字');
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
    countOf(html, 'data-cover-open='),
    cards,
    '每张卡都该有一个封面热区 —— 数量对不上就是有卡片漏了（以前只有标题能点）',
  );
  // 星标必须还在，且压在热区上面（z-index 三层：热区 1、徽标 2、星标 3）
  assert.ok(countOf(html, 'card__follow') >= cards, '星标不能因为加了热区就没了');
  assert.ok(html.includes('cover__hot'), '热区的类名要在，样式靠它定位');
});

/*
 * 热区是 Cover 的**可选**能力：传 onOpen 才有。
 *
 * 这条反向断言是这套改动里最值钱的一条 —— 抽屉、报告画布里的封面只是装饰与素材，
 * 万一顺手给它们也铺上热区，用户点一张素材图会莫名弹出另一部番的详情。
 */
test('封面热区是可选的：没传 onOpen 就不该有', async () => {
  const any = { id: 4242, titleZh: '热区测试条目' };
  const plain = await renderCover({ anime: any });
  assert.equal(plain.includes('cover__hot'), false, '没传 onOpen 的封面不该有热区');
  assert.equal(plain.includes('data-cover-open'), false, '也不该留下热区属性');

  const hot = await renderCover({ anime: any, onOpen: () => {} });
  assert.ok(hot.includes('cover__hot'), '传了 onOpen 就该铺上热区');
  assert.ok(hot.includes('data-cover-open="4242"'), '热区要带条目 id，自检靠它找人');
  assert.ok(hot.includes('aria-label="打开《'), '热区要有无障碍标签 —— Tab 与读屏都靠它');
});

/*
 * 每一个用到封面的列表视图都要真的接上。
 *
 * ⚠️ 这条断言存在的理由就是它上次没有：热区最初只做在本季卡片里，
 * 于是时间表 / 追番 / 补番 / 日记 / 历程的封面全是死的 ——
 * 而当时的测试只验了「本季卡片有热区」，完全看不出别的视图漏了。
 * 用户也不会想到「同一张封面，换个页面就点不开」，只会说「这里点不动」。
 */
test('封面热区：凡是列表视图里的封面都要能点', async () => {
  const REQUIRED = ['season', 'following', 'catchup'];
  for (const view of ['season', 'schedule', 'following', 'catchup', 'diary', 'history']) {
    const html = await render({ view });
    // `data-cover="` 不会命中 `data-cover-open="`（后者在 = 之前多一截），数得准
    const covers = countOf(html, 'data-cover="');
    const hots = countOf(html, 'data-cover-open="');

    /*
     * ⚠️ 断言写「有封面就必须能点」，而不是「每个视图都必须有热区」——
     * 时间表的样例数据里没有夜间排播的条目，那个视图本来就一张封面都没有。
     * 硬要求它会红在「这个视图没数据」上，而那是现实、不是错误
     * （项目里有过教训：断言卡住现实，会让人去改本来正确的代码）。
     *
     * 但 **season / following / catchup 例外：它们必须有封面** ——
     * 不然三条都不满足时这段循环会一路 continue 过去，变成一条永远绿的空气断言。
     */
    if (covers === 0) {
      assert.equal(
        REQUIRED.includes(view),
        false,
        `${view} 视图一张封面都没有 —— 这个视图本该有封面，多半是样例数据或视图本身坏了`,
      );
      continue;
    }
    assert.equal(
      hots,
      covers,
      `${view} 视图里有 ${covers} 张封面，却只有 ${hots} 张能点 —— 同一个封面换个页面就点不开了`,
    );
  }
});

/* ── 卡片窗口：只能移动，不能缩放 ─────────────────────── */

test('卡片窗口：标题栏可拖、有折叠与最大化，但没有任何缩放手柄', async () => {
  const html = await renderWindowCard();
  assert.ok(html.includes('window__bar'), '标题栏要在 —— 移动靠它');
  assert.ok(html.includes('window__btn'), '折叠 / 最大化按钮要在');

  // 反向断言：八方向那套、以及更早的单角把手，一个都不该再出现。
  // 这比当年那条「有 8 个把手」值钱 —— 撤掉一个功能之后，最常发生的就是它悄悄回来。
  assert.equal(countOf(html, 'data-window-resize='), 0, '不该再有缩放把手');
  assert.equal(html.includes('window__edge'), false, '边条那套类名要清干净');
  assert.equal(html.includes('window__resize'), false, '旧的单角把手类名同样不该在');
});

/* ── 「本季概览」那张卡：高度由内容定，不滚动 ────────────── */

/*
 * 现象是「本季概览总是少一节」：卡片高度由摆位预设写死，减掉标题栏和内边距
 * 只剩四十来像素，而四个统计块要七十多 —— 更糟的是窗口不能改大小，
 * 用户看到内容被切掉却没有任何办法。
 *
 * SSR 只能验到这里（类名 + 行内高度），**「真的不滚了」只有桌面端量得到**
 * —— 见 check-desktop.mjs 里那条 scrollHeight/clientHeight 的断言。
 * 但这两条是配套的：类名没了、高度写回固定值，桌面那条也会跟着红。
 */
test('概览卡：fitHeight 时高度交给内容，且正文那一层不滚动', async () => {
  const fit = await renderWindowCard({ fitHeight: true });
  assert.ok(fit.includes('window--fit'), 'fitHeight 的卡片要带上 window--fit —— 不滚动那条规则挂在它下面');
  assert.ok(/style="[^"]*height:auto/.test(fit), `fitHeight 时高度应当交给内容，实际是 ${fit.match(/style="[^"]*"/)?.[0]}`);

  // 反向：普通卡片必须还是那个写死的高度 —— 这个开关不能变成全局行为，
  // 番剧库、时间表都靠固定高度来做内部滚动。
  const plain = await renderWindowCard();
  assert.equal(plain.includes('window--fit'), false, '没传 fitHeight 的卡片不该被改掉');
  // 高度写成 `calc(基准px * var(--kh))`：随画布倍率缩放，但**来源仍然是 defaultRect** ——
  // 这条守的是「高度别变成 auto」，倍率那一层由 core/scale 的测试守。
  assert.ok(/style="[^"]*height:calc\(420px \* var\(--kh, 1\)\)/.test(plain), '普通卡片的高度仍然应当来自 defaultRect');

  /*
   * 「不滚动」这条机制在 CSS 里，SSR 渲染不出计算后的样式 —— 直接查规则本身。
   * `flex: 0 1 auto` 不是可有可无的：默认那条 `flex: 1` 的 flex-basis 是 0%，
   * 父容器高度又是 auto，卡片会塌成只剩标题栏。这两条一起写才算数。
   */
  const rule = /\.window--fit \.window__body\s*\{([^}]*)\}/.exec(CSS);
  assert.ok(rule, 'styles.css 里缺 `.window--fit .window__body` —— 那就等于只有类名、没有行为');
  assert.ok(/overflow:\s*visible/.test(rule[1]), '正文那一层要 overflow: visible，否则滚动条还在');
  assert.ok(/flex:\s*0 1 auto/.test(rule[1]), '正文那一层要 flex: 0 1 auto —— 用默认的 flex: 1 卡片会塌成只剩标题栏');
});

/* ---------- 番堂排播（yuc.wiki） ---------- */

/*
 * 期望值一律从**样本**现算，不手写数字：样本是真实页面裁下来的，
 * 哪天它多裁一组，手写的数字就会红成一句「12 !== 13」，谁也说不清是谁错了。
 */
const yucItems = () => yucSample(true);
const yucGroups = () => yucSample().groups;

test('番堂视图：八组排播、每一条都有可点热区，封面一律不走直连', async () => {
  const html = await renderYuc();
  const groups = yucGroups();
  const items = yucItems();

  assert.equal(
    countOf(html, 'data-yuc-group='),
    groups.length,
    `应当渲染出 ${groups.length} 个分组（周一~周日 + 网络放送）`,
  );
  assert.equal(countOf(html, 'data-yuc-item='), items.length, `应当渲染出 ${items.length} 条排播`);

  /*
   * 「整块可点」不是装饰：以前只有本季那一页的封面能点开详情，
   * 同样的封面换个页面就是死的 —— 所以这里逐条数热区，少一条就是「这条点不开」。
   */
  assert.equal(countOf(html, 'data-yuc-select='), items.length, '每一条都要有可点热区，缺一条就是点不开');

  /*
   * 封面必须走缓存，**一条直连都不许有**（`renderYuc` 默认钉在桌面壳那一档）。
   * 番堂的图挂在 B 站图床（i0.hdslb.com）上，`allowRemote` 一开桌面壳里就是
   * 「浏览器先下一遍、主进程再下一遍」；断网则直接一片色块。
   */
  assert.equal(countOf(html, 'data-cover="remote"'), 0, '桌面壳里番堂的封面不该出现直连远端');
  assert.ok(html.includes('data-yuc-remote="0"'), '番堂页要把「这一档是走缓存」摆出来，自检据此认壳');
  assert.equal(
    countOf(html, 'class="cover yuc-item__cover"'),
    items.length,
    '每条排播都要有封面位（取不到图也留着色块位，不能整块没有）',
  );

  for (const g of groups) {
    // 标题要按 HTML 转义后再比：分组名里有 `&`（「网络放送 & 其他」），
    // React 会渲成 `&amp;` —— 拿原文去 includes 会红成「标题没渲染出来」，
    // 而它其实好好地在那儿
    assert.ok(html.includes(escapeHtml(g.label)), `分组标题「${g.label}」没渲染出来`);
  }
});

/*
 * 「桌面不许直连」和「浏览器必须直连」是**同一条规矩的两半**，必须成对测。
 * 只测前一半时它是绿的，但浏览器那头根本没有本地缓存这回事 ——
 * 关掉直连等于「一片色块、永远不会有图」，那不是降级，是坏了。
 */
test('番堂视图：浏览器壳反过来要允许直连，否则永远一片色块', async () => {
  const items = yucItems();
  const withCover = items.filter((it) => typeof it.cover === 'string' && it.cover);

  const web = await renderYuc({ allowRemote: true });
  assert.ok(web.includes('data-yuc-remote="1"'), '浏览器那一档要显式标出来');
  /*
   * 反向在前：样本里一条封面地址都没有时，下面那条 `=== 0` 照样成立，
   * 断言就空转了 —— 先证明「确实有图要画」。
   */
  assert.ok(withCover.length > 0, `样本里一条封面地址都没有（共 ${items.length} 条），这条断言会空转`);
  assert.equal(
    countOf(web, 'data-cover="remote"'),
    withCover.length,
    '浏览器壳没有本地缓存，不许直连就等于这一页永远没图',
  );

  // 同一份数据、只翻开关：桌面那一档必须一条直连都没有
  const desk = await renderYuc({ allowRemote: false });
  assert.equal(countOf(desk, 'data-cover="remote"'), 0, '桌面壳翻回这一档时，直连要全部收掉');
  assert.equal(
    countOf(desk, 'data-cover="none"'),
    items.length,
    '桌面壳缓存没到位前，每一格都该是色块位（不是破图、也不是空）',
  );
});

test('番堂视图：拿不到数据时给的是原因和出口，不是一张空白卡', async () => {
  const html = await renderYuc({ data: null, status: 'error', error: '连接超时' });
  assert.ok(html.includes('data-yuc-state="error"'), '拉不到数据要有明确的状态位 —— 空白卡看不出是「没数据」还是「坏了」');
  assert.ok(html.includes('连接超时'), '要把原因原样说出来');
  assert.ok(html.includes('data-yuc-reload'), '要留一个再试一次的出口');
  // 反向：这次根本没拿到数据，就不该冒出「看的是上次的」那句话
  assert.equal(html.includes('data-yuc-stale'), false, '没有数据就谈不上陈旧，别挂那条说明');
});

test('番堂视图：有旧数据但没更新上时，必须把这件事说出来', async () => {
  const html = await renderYuc({ stale: true, cached: true, error: '连接超时' });
  assert.ok(html.includes('data-yuc-stale="1"'), 'stale 时必须显式标注');
  assert.ok(/上次拉到/.test(html), '要说清「这是上次的」—— 不说的话用户以为看的是最新排播表');
  // 数据照常显示：陈旧不等于不给看
  assert.equal(countOf(html, 'data-yuc-item='), yucItems().length);
});

test('番堂的作品资料：真资料、真外链、对不上时不装样子', async () => {
  const html = await renderYucDetail();
  assert.match(html, /data-yuc-detail="y[0-9a-f]{8}"/, '要带上条目 id，自检靠它认「现在选的是哪一条」');
  assert.ok(countOf(html, 'yuc-staff__row') > 0, '制作名单要列出来');
  assert.ok(html.includes('yuc-detail__cast'), '声优要列出来');

  // 外链必须带 noopener：应用窗口只有一个，被顶掉就回不来了
  const links = html.match(/<a[^>]*class="btn"[^>]*>/g) ?? [];
  assert.ok(links.length > 0, '官网 / PV 要有链接');
  for (const a of links) {
    assert.match(a, /target="_blank"/, '外链要新开，不能在应用窗口里打开');
    assert.match(a, /rel="[^"]*noopener/, `外链缺 noopener：${a}`);
  }

  // 空壳状态：没选中时说清「点左边一条」，而不是画一堆空标题
  const blank = await renderYucDetail({ item: null });
  assert.ok(blank.includes('data-yuc-detail=""'), '没选中时详情卡要有一个明确的状态位');
  assert.equal(blank.includes('yuc-staff'), false, '没选中就不该有制作的空壳');
});

test('番堂的作品资料：对上了自己的库时给一条回 Bangumi 的出口', async () => {
  const item = yucItems().find((it) => (it.staff ?? []).length);
  const html = await renderYucDetail({ item, lib: { id: 12345, titleZh: item.titleZh } });
  assert.ok(html.includes('data-yuc-own="12345"'), '对上了要标出来');
  assert.ok(html.includes('data-yuc-open-lib="12345"'), '并且要能点回自己的库（评分、话数、日记都在那边）');

  // 反向：没对上时不该瞎标
  const noLib = await renderYucDetail({ item, lib: null });
  assert.equal(noLib.includes('data-yuc-own'), false, '对不上就是没有，不许借一条别的顶上');
});

test('番堂视图：能换季，而且是真 <select> 不是自己画的按钮', async () => {
  const html = await renderYuc({
    seasons: ['2026q4', '2026q3', '2026q2'],
    seasonKey: '2026q3',
  });
  assert.ok(html.includes('data-yuc-season="2026q3"'), '当前季度要报出来');
  assert.ok(html.includes('<select'), '换季要用真 select —— 键盘能翻、读屏器认得');
  // 三个选项都得画出来，少一个就是那一季点不进去
  assert.equal(countOf(html, '<option'), 3);

  /*
   * ⚠️ **当前季度必须在可选项里。**
   * `<select>` 的 value 匹配不上任何 option 时，浏览器会退回显示**列表第一项** ——
   * 页面在放十月的排播、下拉框却写着「7 月 · 夏」，看起来像把季节算错了。
   * 光数 option 的条数是抓不到这一条的（三条都在，只是缺了该在的那一条）。
   */
  const values = [...html.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(
    values.includes('2026q3'),
    `当前那一季（2026q3）不在可选项里，下拉框会显示成别的季节：${values.join(' / ')}`,
  );

  // 反向：一个可选项都没有时也不能崩，得把当前季显示出来
  const flat = await renderYuc({ seasons: [], seasonKey: '2026q4', seasonLabel: '2026 秋' });
  assert.ok(flat.includes('data-yuc-season="2026q4"'), '没有列表时要退回当前这一季，不能空着');
  assert.deepEqual(
    [...flat.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]),
    ['2026q4'],
    '退回模式下列表里也必须是当前那一季 —— 否则一样会显示成别的季节',
  );
});

test('番堂的资料卡：对上了库才给「提醒我」，并且把下一次播的时刻说出来', async () => {
  // 挑一条有星期几又有时刻的 —— 网络放送那组没有固定星期，那条不该出提醒
  const item = yucItems().find((it) => /^(mon|tue|wed|thu|fri|sat|sun)$/.test(it.groupKey ?? '') && /\d{1,2}:\d{2}/.test(it.time ?? ''));
  assert.ok(item, '前提：样本里得有一条带星期几和时刻的排播记录');

  const on = await renderYucDetail({ item, lib: { id: 12345, titleZh: item.titleZh }, now: Date.parse('2026-10-10T12:00:00Z') });
  assert.ok(on.includes('data-yuc-remind="off"'), '没开提醒时状态位要写 off');
  assert.ok(on.includes('data-yuc-remind-btn="12345"'), '按钮要挂在库里那条上 —— 提醒查的是那个 id');
  assert.ok(on.includes('下一次'), '要把下一次播的时刻说出来，光有个按钮等于让用户猜');

  // 反向：没对上库就不该有提醒（提醒查的是库里的 id，对不上就没有可查的对象）
  const noLib = await renderYucDetail({ item, lib: null, now: Date.parse('2026-10-10T12:00:00Z') });
  assert.equal(noLib.includes('data-yuc-remind'), false, '没对上库就没有可提醒的对象');

  // 反向：算不出时刻的（网络放送 / 没写时刻）也不该画一个空按钮
  const net = await renderYucDetail({
    item: { ...item, groupKey: 'net', time: '' },
    lib: { id: 12345, titleZh: item.titleZh },
    now: Date.parse('2026-10-10T12:00:00Z'),
  });
  assert.equal(net.includes('data-yuc-remind'), false, '算不出时刻就别给按钮');
});

test('番堂的资料卡：日记那一块接进来时要标出来', async () => {
  const item = yucItems().find((it) => (it.staff ?? []).length);
  const withSlot = await renderYucDetail({
    item,
    lib: { id: 12345, titleZh: item.titleZh },
    // 直接传字符串：这一条要验的是「槽位接上了、内容画出来了」，
    // 不是日记控件本身（那个由它自己的用例守着）
    diarySlot: 'PROBE-DIARY',
  });
  assert.ok(withSlot.includes('data-yuc-diary="1"'), '有日记槽位时要标出来');
  assert.ok(withSlot.includes('PROBE-DIARY'), '传进来的内容要真的画出来');

  const without = await renderYucDetail({ item, lib: { id: 12345, titleZh: item.titleZh } });
  assert.equal(without.includes('data-yuc-diary'), false, '没有槽位就别画一个空标题');
});

test('番堂那一页接在大界面上：导航、卡片、深链都在', async () => {
  const html = await render({ view: 'yuc' });
  assert.equal(countOf(html, 'data-nav="yuc"'), 1, '侧栏要有番堂这一项');
  assert.equal(countOf(html, 'data-window-id="yuc-board"'), 1, '排播卡要渲染出来');
  assert.equal(countOf(html, 'data-window-id="yuc-detail"'), 1, '资料卡要渲染出来');
  assert.equal(countOf(html, 'data-yuc-view="1"'), 1, '视图根节点要带状态位');
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

  /*
   * 越界的档位要夹回来（老存档被手改过、或以后改了范围）。
   *
   * ⚠️ 上限是 360 不是滑块的 220：组件收到的是**已经乘过窗口倍率的最终格宽**
   * （App 那边 `cardMinScaled` 之后再传进来），拿滑块的区间去夹会把自动缩放
   * 整个吃掉 —— 那就是「开了自适应、封面拉满，最大化后没反应」。
   * 滑块自己的区间由 layout.js 的 CARD_MIN 管，两边各管一段。
   */
  const wild = await renderSeasonView({ cardMin: 9999 });
  assert.ok(wild.includes('--card-min:360px'), '超大格宽要夹到上限');
  const tiny = await renderSeasonView({ cardMin: 1 });
  assert.ok(tiny.includes('--card-min:56px'), '过小的格宽要夹到下限');
});

/* ── 卡片显示：封面尺寸 + 文字大小 ─────────────────────── */

test('设置面板外观页：卡片显示里两档都在，显示的得是夹过的值', async () => {
  const dflt = await renderSettingsTabs();
  assert.ok(dflt.includes('卡片显示'), '外观页要有这一块');
  assert.ok(dflt.includes('封面尺寸'), '一格的宽窄要能调');
  assert.ok(dflt.includes('文字大小'), '卡片里的字要能单独调大 —— 不能只有封面能变');
  assert.ok(dflt.includes('>112px<'), '没设过时封面档显示默认值');
  assert.ok(dflt.includes('>100%<'), '没设过时文字档显示 100%');

  /*
   * ⚠️ 这里特意喂 `fontScale: null` 而不是不喂。
   * `Number(null) === 0`，夹一下会落到**下限** 0.85 —— 而下限是有意义的值，
   * 界面上只表现成「字有点小」，永远不报错；`undefined` 却能正常走默认值。
   * 一半对一半错最容易骗过自测，所以两个都得上。
   */
  const dirty = await renderSettingsTabs({ settings: { cardMin: 9999, fontScale: null } });
  assert.ok(dirty.includes('>220px<'), '越界的封面档要按上限显示');
  assert.equal(dirty.includes('>9999px<'), false, '不能把没夹过的值摆到界面上');
  assert.ok(dirty.includes('>100%<'), 'fontScale 是 null 时该显示默认 100%，不是被抬到下限 85%');
  assert.equal(dirty.includes('>85%<'), false, 'null 不能被当成 0 夹到下限');
});

test('卡片区的字号必须跟着 --fs 走，不许再写死 px', async () => {
  assert.ok(
    /\.cardgrid,\s*\.queue,\s*\.board,\s*\.weekgrid,\s*\.yuc-grid\s*\{\s*font-size:\s*calc\(12\.5px \* var\(--fs, 1\)\)/.test(CSS),
    '五个卡片容器（含番堂那页）上要有基准字号，这是「文字大小」唯一的落点',
  );

  /*
   * 反向断言，比上面那条值钱：以后谁新加一个 `.card__xxx { font-size: 12px }`，
   * 界面上完全看不出来它不跟着滑块走 —— 只有当有人真去拉滑块才会发现。
   * 所以这里把「卡片区出现绝对 px 字号」一律判成错。
   *
   * ⚠️ `yuc-item` 也在名单里：番堂那一页的排版是自成一族的，最容易漏。
   */
  const hard = [...CSS.matchAll(/^\.(?:card|queue|catchup|slot|weekcol|yuc-item)__[\w-]+[^{]*\{[^}]*font-size:\s*[0-9.]+px/gm)];
  assert.equal(
    hard.length,
    0,
    `卡片区不该有写死的字号，改成 em 派生：\n${hard.map((m) => m[0].trim()).join('\n')}`,
  );
});

/* ── 备份与迁移 ───────────────────────────────────────── */

test('设置里的备份与迁移：两个入口都在，且说清「导入不含封面」', async () => {
  const html = await renderSettingsTabs({ defaultTab: 'data' });
  assert.ok(html.includes('备份与迁移'), '数据源页要有这一块');
  assert.ok(html.includes('导出备份…'), '要有导出入口');
  assert.ok(html.includes('从备份导入…'), '要有导入入口');
  assert.ok(html.includes('整份替换'), '要提前说清导入是覆盖，不能等按下去才知道');
  assert.ok(html.includes('backup-import-'), '要说明覆盖前会另存一份，否则用户不敢按');
  assert.equal(html.includes('simport'), false, '没选文件的时候不该有待确认那一块');
});

test('导入待确认：两边的条数都要摆出来', async () => {
  const html = await renderSettingsTabs({
    defaultTab: 'data',
    transfer: {
      busy: '',
      note: '',
      pending: {
        fileName: 'jikai-backup-20260926-1200.json',
        incoming: {},
        // 这两行是整块的意义所在：看不到「会失去什么」，确认按钮就只是个「确定」
        theirs: { following: 42, catchup: 3, diary: 17, tierlists: 2, reports: 1 },
        mine: { following: 5, catchup: 0, diary: 1, tierlists: 0, reports: 0 },
      },
      onExport: () => {},
      onImport: () => {},
      onConfirmImport: () => {},
      onCancelImport: () => {},
    },
  });
  assert.ok(html.includes('jikai-backup-20260926-1200.json'), '要说清导的是哪个文件');
  assert.ok(html.includes('文件里'), '要有「文件里」那一行');
  assert.ok(html.includes('本机现在'), '要有「本机现在」那一行');
  assert.ok(html.includes('追番 42') && html.includes('日记 17'), '文件里的条数要真的算出来');
  assert.ok(html.includes('追番 5') && html.includes('日记 1'), '本机的条数也要算出来');
  assert.ok(html.includes('确认导入并覆盖'), '确认按钮要说清会发生什么');
  assert.ok(html.includes('btn btn--danger'), '这一步是破坏性的，不该长得像个普通按钮');
  assert.ok(html.includes('取消'), '要能退出来');
  // 反向：本机那行不能把文件里的数字又抄一遍
  assert.equal(html.includes('追番 42') && html.includes('本机现在</span><b>追番 42'), false);
});

test('导入待确认：忙的时候按钮要禁用，不是点了没反应', async () => {
  const html = await renderSettingsTabs({
    defaultTab: 'data',
    transfer: {
      busy: 'import',
      note: '',
      pending: { fileName: 'x.json', incoming: {}, theirs: { following: 1 }, mine: { following: 0 } },
    },
  });
  assert.ok(html.includes('正在导入…'), '要显示正在做的事，不然用户会以为卡了');
  assert.equal((html.match(/disabled=""/g) || []).length >= 3, true, '导入中导出/导入/确认都该禁掉');
});

test('导入结果那一行要画出来', async () => {
  const ok = await renderSettingsTabs({ defaultTab: 'data', transfer: { note: '已从「a.json」导入：追番 42 · 覆盖前的记录已另存：C://tmp//backup-import-1.json' } });
  assert.ok(ok.includes('ssec__result'), '结果要有个区别于普通说明的样式钩子');
  assert.ok(ok.includes('覆盖前的记录已另存'));

  const bad = await renderSettingsTabs({ defaultTab: 'data', transfer: { note: '「a.json」不是能用的备份：这不是本程序导出的备份文件' } });
  assert.ok(bad.includes('不是本程序导出的备份文件'), '认不出的文件要把原因说出来，而不是只报「失败」');
});

/* ── 渲染模式那一行 ───────────────────────────────────── */

test('性能那一块：软件渲染要说出来，并给一个能自己按的出口', async () => {
  const html = await renderSettingsTabs({
    appInfo: { isDesktop: true, version: '1.4.0', render: 'software', gpuRecoveries: 0 },
  });
  assert.ok(html.includes('>性能<'), '外观页要有这一块');
  assert.ok(html.includes('软件渲染'), '跑在软件渲染上就得说出来，别让用户自己猜「为什么发涩」');
  assert.ok(html.includes('data-render-mode="software"'), '给它一个能断言的身份，别靠文案去认');
  assert.ok(html.includes('再试一次'), '要有个能自己按的出口 —— 以前那个标记写进去就再也没法改回来');
  assert.ok(html.includes('会把当前窗口关掉重开一次'), '重启是破坏性的，按之前得说清会发生什么');
});

test('性能那一块：硬件加速时不该摆一个没用的按钮', async () => {
  const html = await renderSettingsTabs({
    appInfo: { isDesktop: true, version: '1.4.0', render: 'hardware', gpuRecoveries: 0 },
  });
  assert.ok(html.includes('data-render-mode="hardware"'));
  assert.equal(html.includes('再试一次'), false, '一切正常的时候不该摆个按钮勾着人点');
  // 反向：正常状态不许出现「软件渲染」这几个字
  assert.equal(html.includes('软件渲染'), false);
});

test('性能那一块：浏览器壳和拿不到 appInfo 时整块都不出现', async () => {
  // 浏览器里渲染模式归浏览器管，摆一行「硬件加速」只是好看，点了也没用
  const web = await renderSettingsTabs({ appInfo: { isDesktop: false, version: '1.4.0', platform: 'web' } });
  assert.equal(web.includes('data-render-mode'), false);
  assert.equal(web.includes('再试一次'), false);

  // 反向：面板没给 appInfo 的时候（老壳 / 只渲染面板的测试）也不能凭空冒出来
  const none = await renderSettingsTabs({});
  assert.equal(none.includes('data-render-mode'), false, '拿不到 appInfo 就不该硬画一块空的出来');
  assert.equal(none.includes('再试一次'), false);
});

/* ── 内容大小：所有页面的卡片共用一个档位 ───────────────── */

test('右下角那个浮盘：收起来的时候什么都没有', async () => {
  assert.equal(await renderScaleDock({ open: false }), '', '收起来时不该在页面上留下任何东西');

  const html = await renderScaleDock();
  assert.ok(html.includes('data-scale-dock="1"'), '要有这一块');
  assert.ok(html.includes('data-scale-cover-range="1"'), '封面尺寸那条滑块');
  assert.ok(html.includes('data-scale-font-range="1"'), '文字大小那条滑块');
  assert.ok(html.includes('data-scale-close="1"'), '要能收起来 —— 浮在内容上面，不能只有一个孔洞');
});

test('浮盘上的数字就是当前真正在用的档位', async () => {
  const html = await renderScaleDock({ cardMin: 160, fontScale: 1.2 });
  assert.ok(html.includes('>160px<'), '封面那档按一格宽的 px 显示');
  assert.ok(html.includes('>120%<'), '文字那档按百分比显示');
  // 倍率就是别的页面缩略图实际套用的那个数，摆出来让人知道自己在调什么
  assert.ok(html.includes('data-scale-cover="143%"'), '封面倍率要显示出来（160/112≈143%）');
});

test('浮盘：已经是默认大小时「回到默认」按不下去', async () => {
  const def = await renderScaleDock({ cardMin: 112, fontScale: 1 });
  assert.ok(def.includes('已经是默认大小'));
  assert.ok(/data-scale-reset="1"[^>]*disabled/.test(def), '默认状态该禁用，按下去没有任何变化才是困惑的');

  const moved = await renderScaleDock({ cardMin: 180, fontScale: 1.3 });
  assert.ok(moved.includes('回到默认'), '调过之后这句要变回可点');
  assert.equal(/data-scale-reset="1"[^>]*disabled/.test(moved), false);
});

test('每张窗口卡片右上角都有「内容大小」的入口', async () => {
  const html = await renderWindowCard();
  assert.ok(html.includes('data-card-scale="1"'), '每张卡都得有这个入口 —— 否则又变成「只有某一页能调」');
  assert.ok(html.includes('data-maxed="0"'), '初始不是全屏');

  // 反向：拿不到 Provider 时不给按钮。给了也是点了没反应，那比没有更糟
  const bare = await renderWindowCard({ withProvider: false });
  assert.equal(bare.includes('data-card-scale'), false);
});

/*
 * ⚠️ 反向断言，比上面的正面断言值钱：
 * 这些封面尺寸以前是各自写死的 px，之间没有任何联系 —— 用户在本季把封面调到最大，
 * 切到 TierList 一格没动，看上去就像功能坏了。这种「一半有效」永远不会报错，
 * 只有真去挨个页面拉一遍滑块才会发现。所以这里把「封面容器里出现绝对 px」一律判成错。
 *
 * 报告那几处（`rb-*`、`report__pool-cover`）是**有意不接**的：那是导出长图的版式，
 * 跟着屏幕上的倍率变，预览和导出的图就会不一样 —— 宁可不一致，也不能让稿子对不上。
 */
test('所有页面的封面都接在同一个倍率上，不许再各写各的 px', async () => {
  for (const sel of ['queue__cover', 'catchup__cover', 'diary__cover', 'history__cover', 'drawer__cover', 'tier-item__art']) {
    const re = new RegExp(`\\.${sel}[^{]*\\{[^}]*var\\(--cs`, 'm');
    assert.ok(re.test(CSS), `.${sel} 要用 var(--cs) 派生，否则这一页的封面不跟着「封面尺寸」走`);
  }

  /*
   * ⚠️ 判「值里有没有 var(--」而不是判「值是不是以 calc 开头」——
   * `flex: 0 0 calc(40px * var(--cs, 1))` 这个值里也有 `40px`，
   * 只看开头会把已经接好的写法判成错的。
   */
  const coverPx = (propRe) =>
    [...CSS.matchAll(/^\.(?:queue|catchup|diary|history|drawer)__cover[^{]*\{[^}]*\}/gm)]
      .flatMap((rule) => [...rule[0].matchAll(new RegExp(`(?:${propRe}):([^;}]+)`, 'g'))])
      .filter((m) => /[0-9.]+px/.test(m[1]) && !m[1].includes('var(--'));
  const hard = coverPx('width|height|flex');
  assert.equal(
    hard.length,
    0,
    `封面容器的尺寸要写成 calc(原来的px * var(--cs, 1))：\n${hard.map((m) => m[0].trim()).join('\n')}`,
  );

  // 图块宽度变了，装它的格子也该跟着变，否则封面会戳到格子外面
  const artPx = [...CSS.matchAll(/^\.tier-item__art\s*\{[^}]*\}/gm)]
    .flatMap((rule) => [...rule[0].matchAll(/(?:width|height):([^;}]+)/g)])
    .filter((m) => /[0-9.]+px/.test(m[1]) && !m[1].includes('var(--'));
  assert.equal(artPx.length, 0, `图块的尺寸要跟着倍率：\n${artPx.map((m) => m[0].trim()).join('\n')}`);
});

test('TierList / 日记 / 历程里的字号跟着 --fs 走', async () => {
  /*
   * 这三处以前全是写死的 px —— 也是「只有本季能调」的另一个面：
   * 封面调完了字还是原来那么大，图大字小，看着更像没生效。
   */
  for (const sel of ['tier-item__name', 'tier-row__empty', 'diary__note', 'history__meta', 'drawer__title']) {
    const re = new RegExp(`\\.${sel}[^{]*\\{[^}]*calc\\([0-9.]+px \\* var\\(--fs`, 'm');
    assert.ok(re.test(CSS), `.${sel} 的字号要用 var(--fs) 派生`);
  }

  /*
   * 有两类是**有意留着不接**的：`__del` / `__x` / `__num` / `__undo` 这些是要点准的小控件，
   * 跟着字号长大会错位；`diary-input` 那一组是打分输入区，属于控件不是内容。
   * 把它们写进白名单，是为了以后有人照着这个名单加一处时能看清界线在哪。
   */
  const KEPT_FIXED = /(?:__|-)(?:del|x|undo|num)\b|diary-input/;
  const hard = [
    ...CSS.matchAll(/^\.(?:tier|diary|history|drawer)[-\w]*[^{]*\{[^}]*font-size:(?!\s*calc\()\s*[0-9.]+px/gm),
  ].filter((m) => !KEPT_FIXED.test(m[0].split('{')[0]));
  assert.equal(
    hard.length,
    0,
    `这几处不该有写死的字号（改成 calc(原来的px * var(--fs, 1))）：\n${hard.map((m) => m[0].trim()).join('\n')}`,
  );
});

// ===================== 长图编辑器：画布预览缩放 =====================
// 这一组守的是「整幅看得见」—— 画布在不在、块数对不对都验不出它还得横着拖。

test('长图画布：默认就是「适应」，倍率写在包层上', async () => {
  const html = await renderReport();
  assert.ok(html.includes('data-report-fit="1.00"'), '没量到尺寸之前按原尺寸画，别拿 0 去乘把画布塌掉');
  assert.ok(html.includes('data-report-zoom-pct="100"'), '界面上要写出现在是百分之多少');
  const fitBtn = html.match(/<button[^>]*data-report-zoom-fit="1"[^>]*>/);
  assert.ok(fitBtn, '没找到「适应」按钮');
  assert.ok(fitBtn[0].includes('is-on'), `默认档是「适应」，它得画成选中的样子：${fitBtn[0]}`);
  for (const k of ['data-report-zoom-out', 'data-report-zoom-in', 'data-report-zoom-full']) {
    assert.ok(html.includes(k), `缩放控件少了 ${k} —— 只能「适应」一种档的话，想看细节就没路了`);
  }
});

test('长图画布：给定倍率时按它缩，且不再是「适应」', async () => {
  const html = await renderReport({ zoom: 0.5 });
  assert.ok(html.includes('data-report-fit="0.50"'), '包层上要写明现在的倍率，桌面端自检读这个');
  assert.ok(html.includes('data-report-zoom-pct="50"'));
  assert.ok(html.includes('scale(0.5)'), '缩放要真的落到样式上');
  const fitBtn = /<button[^>]*data-report-zoom-fit="1"[^>]*>/;
  assert.equal(fitBtn.test(html) && /is-on/.test(html.match(fitBtn)[0]), false, '手动定了倍率，「适应」就不该还是选中的');
});

test('长图画布：缩放绝不能落在画布自己身上 —— 导出抓的是它的 outerHTML', async () => {
  const html = await renderReport({ zoom: 0.5 });
  const tag = html.match(/<div class="report__canvas"[^>]*>/);
  assert.ok(tag, '没找到画布元素');
  const style = /style="([^"]*)"/.exec(tag[0])?.[1] ?? '';
  assert.equal(/transform|scale\(/.test(style), false, `画布自己带上了 transform（style="${style}"）—— 导出会把缩放一起带出去，那比看不全严重得多`);
  assert.ok(/width:\s*1220px/.test(style), `画布的逻辑宽度该照旧写在它自己身上（style="${style}"）`);
});

test('备份区里有「导出文件包」这个入口，并且忙的时候会换字', async () => {
  const idle = await renderSettingsTabs({ defaultTab: 'data', transfer: {} });
  assert.ok(idle.includes('data-export-bundle="1"'), '设置里找不到导出文件包的按钮');
  assert.ok(idle.includes('导出文件包'), `按钮文字对不上：${(idle.match(/导出[^<]*/g) ?? []).join(' / ')}`);

  const busy = await renderSettingsTabs({ defaultTab: 'data', transfer: { busy: 'bundle' } });
  assert.ok(busy.includes('正在打包'), '打包中要换掉按钮上的字，否则用户会以为没点上');
  assert.ok(busy.includes('disabled'), '打包中不能让他再点一次');

  // 反向：这一块不该因为有了新按钮就把「从备份导入」挤掉 ——
  // 两条路是配套的，少一个用户就不知道导出来的东西怎么用回去
  assert.ok(idle.includes('从备份导入'), '导入入口被挤掉了');
  assert.ok(idle.includes('导出备份'), '导出备份入口被挤掉了');
});
