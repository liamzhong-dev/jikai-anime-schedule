import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

import { SAMPLE_ITEMS, SAMPLE_SEASON } from './fixtures/sample-state.js';

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

const { render } = await import(pathToFileURL(outfile).href);

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const titles = SAMPLE_ITEMS.map((a) => escapeHtml(a.titleZh || a.titleJa));
const countOf = (html, needle) => html.split(needle).length - 1;

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
