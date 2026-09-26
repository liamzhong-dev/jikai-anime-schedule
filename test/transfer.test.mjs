/**
 * 备份与迁移的纯函数层测试。
 *
 * 这一批守的是「导出得全不全、认得出认不出、会不会把别人的文件当成自己的」——
 * 前两类出问题的症状都是**安静的**：导出少一个集合，用户以为备份好了，
 * 换机器才发现日记没跟过来；而认错的后果更重：随便挑个 json 也能导进去，
 * 本机的记录当场被一片空白覆盖。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXPORTED_KEYS, SKIPPED_KEYS, TRANSFER_APP, TRANSFER_FORMAT,
  buildTransfer, describeCounts, parseTransfer, transferCounts, transferFileName,
} from '../src/core/transfer.js';
import { exportableState, importState } from '../src/core/store.js';
import {
  addCatchup, addDiaryEntry, markEpisode, patchSettings, patchTierlist, toggleFollow, update,
} from '../src/core/store.js';

/** 造一份「样样都有点东西」的状态 */
async function makeRichState() {
  update((s) => ({
    ...s,
    following: {},
    catchup: [],
    subjects: {},
    groups: {},
    tierlists: {},
    diary: {},
    reports: {},
    settings: { ...s.settings },
  }));
  toggleFollow(600001);
  toggleFollow(600002);
  markEpisode(600001, 3);
  addCatchup({ subjectId: 600003, deadline: Date.UTC(2026, 9, 20), targetEps: 12 });
  addDiaryEntry(600001, { rating: 9, note: '挺好的' });
  patchTierlist('2026q3', { items: [{ key: '600001', rowId: 'r1' }] });
  patchSettings({ panelAlpha: 0.42 });
  return exportableState();
}

// ===================== 导出 =====================

test('导出清单和 snapshot 是同一批字段', async () => {
  const state = await makeRichState();
  const payload = buildTransfer(state);
  /*
   * 这条是「导出得全不全」的守门员：`snapshot()` 多一个字段而这里没跟上，
   * 症状就是「备份里少一块」，而用户要换机器那天才发现。
   * 对着实际落盘的快照比，比对着 DEFAULTS 比更准 —— DEFAULTS 里还有 cache 那种不该导的。
   */
  for (const k of EXPORTED_KEYS) {
    assert.ok(k in payload.state, `导出里少了 ${k}`);
    assert.ok(k in state, `导出的 ${k} 在 snapshot 里根本不存在 —— 这两个清单已经对不上了`);
  }
  assert.deepEqual(
    Object.keys(payload.state).sort(),
    EXPORTED_KEYS.filter((k) => k in state).sort(),
    '导出多带了清单之外的东西',
  );
});

test('导出不带封面缓存和壁纸', async () => {
  const state = await makeRichState();
  state.cache = { huge: 'x'.repeat(100) };
  state.settings.wallpaper = { enabled: true, dataUrl: 'data:image/png;base64,AAAA' };
  const payload = buildTransfer(state);

  // SKIPPED_KEYS 里 `settings.wallpaper` 是带点的，按段取
  assert.deepEqual(SKIPPED_KEYS, ['cache', 'settings.wallpaper'], '不导的清单变了就顺手把这条改掉');
  assert.equal('cache' in payload.state, false, 'cache 描述的是「这台机器装了什么」，不是用户的记录');
  assert.equal('wallpaper' in payload.state.settings, false, '壁纸图片是几十 KB 的二进制，不跟着走');
  // 反向：不导它的同时，别的设置项别跟着一起丢
  assert.equal(payload.state.settings.panelAlpha, 0.42, '别的设置要照常导出');
});

test('导出带得走真的记录，不是空壳', async () => {
  const payload = buildTransfer(await makeRichState());
  assert.deepEqual(Object.keys(payload.state.following).sort(), ['600001', '600002']);
  assert.equal(payload.state.following['600001'].watchedEps, 3, '看到第几话要跟着走');
  assert.ok(payload.state.following['600001'].followedAt > 0, '时间戳是追番历程的全部数据来源，不能丢');
  assert.equal(payload.state.diary['600001'].entries.length, 1);
  assert.equal(payload.state.tierlists['2026q3'].items[0].rowId, 'r1');
  assert.equal(payload.counts.following, 2);
  assert.equal(payload.counts.diary, 1);
});

test('导出要深拷：备份造好之后再改状态，备份不该跟着变', async () => {
  const state = await makeRichState();
  const payload = buildTransfer(state);
  const before = JSON.stringify(payload);
  // 模拟「用户接着又在界面上点了几下」
  toggleFollow(600009);
  patchSettings({ panelAlpha: 1 });
  assert.equal(JSON.stringify(payload), before, '导出的是引用的话，备份会跟着状态一起漂');
});

test('文件名带日期，同一个时刻必然同名', () => {
  const t = Date.UTC(2026, 8, 26, 7, 5);
  const name = transferFileName(t);
  assert.match(name, /^jikai-backup-\d{8}-\d{4}\.json$/);
  assert.equal(name, transferFileName(t));
  assert.notEqual(name, transferFileName(t + 60000), '差一分钟就该是另一个名字');
});

// ===================== 条数与说人话 =====================

test('条数统计：日记要数到「条」，不是数到「作品」', () => {
  const counts = transferCounts({
    following: { a: {}, b: {} },
    catchup: [1, 2, 3],
    diary: { a: { entries: [{}, {}] }, b: { entries: [{}] } },
    tierlists: { '2026q3': {} },
    reports: {},
    subjects: {},
    groups: {},
  });
  assert.equal(counts.following, 2);
  assert.equal(counts.catchup, 3);
  assert.equal(counts.diary, 3, '一个作品可以写好几条日记，说「日记 2 条」会让人以为记录少了');
  assert.equal(counts.tierlists, 1);
});

test('条数为零也要说人话，不能是空字符串', () => {
  assert.equal(describeCounts({}), '空空如也');
  assert.equal(describeCounts({ following: 0, catchup: 0, diary: 0, tierlists: 0, reports: 0 }), '空空如也');
  const line = describeCounts({ following: 3, catchup: 0, diary: 5, tierlists: 1, reports: 0 });
  assert.ok(line.includes('追番 3') && line.includes('日记 5') && line.includes('档位表 1'));
  assert.equal(line.includes('补番'), false, '为 0 的那几项不该占地方');
});

// ===================== 认文件 =====================

test('认得出自己家的备份', () => {
  const payload = buildTransfer({ following: {} });
  const r = parseTransfer(JSON.stringify(payload));
  assert.equal(r.ok, true);
  assert.equal(r.payload.app, TRANSFER_APP);
});

test('别的文件一律拒绝，并把原因说清楚', () => {
  const cases = [
    ['', '文件是空的'],
    ['   ', '文件是空的'],
    ['{ 这不是 json', '不是合法的 JSON —— 是不是选错文件了？'],
    ['[1,2,3]', '文件内容不是一个对象'],
    ['{"hello":"world"}', '这不是本程序导出的备份文件'],
    ['{"app":"jikai"}', '备份文件没写格式版本'],
    ['{"app":"jikai","format":1}', '备份文件里没有记录数据（state 缺失）'],
    ['{"app":"jikai","format":1,"state":[]}', '备份文件里没有记录数据（state 缺失）'],
    ['{"app":"jikai","format":1,"state":{}}', '备份文件里没有可识别的记录（像是被截断过）'],
  ];
  for (const [text, want] of cases) {
    const r = parseTransfer(text);
    assert.equal(r.ok, false, `「${text.slice(0, 30)}」本该被拒绝`);
    assert.equal(r.error, want);
  }
});

test('⚠️ 别的程序的 json 必须挡住 —— 放过去就是把用户记录覆盖成空白', () => {
  // 这是这个功能最危险的一条：用户随手挑了个别的 json
  const other = JSON.stringify({ version: 2, items: [{ a: 1 }], settings: { theme: 'dark' } });
  const r = parseTransfer(other);
  assert.equal(r.ok, false);
  assert.ok(/不是本程序/.test(r.error));

  // 连「长得像 state」的也不行，只要没有 app 标记就不认
  const lookalike = JSON.stringify({ state: { following: { 1: {} } }, format: 1 });
  assert.equal(parseTransfer(lookalike).ok, false);
});

test('更新版本导出的文件要拒绝，旧版本的照收', () => {
  const future = JSON.stringify({ app: TRANSFER_APP, format: TRANSFER_FORMAT + 1, state: { settings: {} } });
  const r = parseTransfer(future);
  assert.equal(r.ok, false);
  assert.ok(r.error.includes(String(TRANSFER_FORMAT + 1)), '要把版本号说出来，不然用户不知道该升级谁');

  // 往下的版本收下：认不出的字段自然会走 DEFAULTS，不影响能认出来的部分
  const older = JSON.stringify({ app: TRANSFER_APP, format: 1, state: { settings: {}, following: {} } });
  assert.equal(parseTransfer(older).ok, true);
});

test('认不出的集合名不报错、也不会被当成记录', () => {
  const payload = JSON.stringify({
    app: TRANSFER_APP,
    format: 1,
    state: { settings: {}, somethingNew: { a: 1 } },
  });
  const r = parseTransfer(payload);
  assert.equal(r.ok, true, '多出来的字段不该让整份文件不可用');
  assert.equal('somethingNew' in r.payload.state, true, '解析这一层不做裁剪，裁不裁由 importState 决定');
});

// ===================== 导入 =====================

test('导入是把文件里的东西搬过来：进度、时间戳、日记条目都在', async () => {
  const source = await makeRichState();
  const payload = buildTransfer(source);

  // 换一台机器：这边的记录和那边完全不一样
  await makeRichState();
  toggleFollow(777001);
  markEpisode(777001, 11);
  addDiaryEntry(777001, { rating: 2, note: '本机原来的' });

  importState(payload.state);
  const after = exportableState();

  assert.deepEqual(Object.keys(after.following).sort(), ['600001', '600002'], '本机原来那条记录该没了 —— 导入是整份替换');
  assert.equal(after.following['600001'].watchedEps, 3, '看到第几话要跟着过来');
  assert.ok(after.following['600001'].followedAt > 0, '追番时间是历程的全部数据来源，丢了就补不回来');
  assert.equal(after.diary['600001'].entries[0].rating, 9);
  assert.equal(after.diary['777001'], undefined, '本机自己的日记不该留下来');
  assert.equal(after.tierlists['2026q3'].items[0].rowId, 'r1');
});

test('导入会清掉本机代理地址，并把它写进默认值', async () => {
  const payload = buildTransfer({
    following: {},
    settings: { api: { proxy: 'http://127.0.0.1:7890', customBase: 'https://mirror.example' } },
  });
  importState(payload.state);
  const s = exportableState().settings;
  assert.equal(s.api.proxy, '', '本机代理是「这台机器上的那个口」，跟着走会让新设备每个请求都连不上');
  assert.equal(s.api.customBase, 'https://mirror.example', '反代地址是用户的偏好，要跟着走');
});

test('导入：文件里没有的字段回默认值，不回本机的值', async () => {
  // 只带 settings 的一份（比如手工裁过的文件）
  const payload = { app: TRANSFER_APP, format: 1, state: { settings: { panelAlpha: 0.5 } } };
  toggleFollow(888001);
  markEpisode(888001, 4);

  importState(payload.state);
  const after = exportableState();
  assert.deepEqual(after.following, {}, '「文件里没有」不等于「悄悄留着本机的旧数据」');
  assert.equal(after.settings.panelAlpha, 0.5);
  // 文件里没给的设置项走默认，不该是一串 undefined
  assert.equal(typeof after.settings.fontScale, 'number');
  assert.equal(after.settings.dataSource, 'builtin');
});

test('导入：脏东西进不来（悬空档位、越界评分、认不出的颜色）', async () => {
  const dirty = {
    following: {},
    settings: {},
    // 一条好的 + 一条评分越界的：好的要留下，坏的要被丢掉
    diary: {
      600001: { entries: [{ at: 111, rating: 8 }, { at: 222, rating: 99 }] },
      600002: { entries: [{ at: 333, rating: 99 }] }, // 全是坏条目，整条记录会被丢掉
    },
    tierlists: { '2026q3': { rows: [{ id: 'r1', label: 'S', color: '不是颜色' }], items: [{ key: '1', rowId: '不存在的档' }] } },
  };
  importState(dirty);
  const after = exportableState();

  assert.equal(after.diary['600001'].entries.length, 1, '越界的评分要在写入前就被拦下，好的那条要留下');
  assert.equal(after.diary['600001'].entries[0].rating, 8);
  assert.equal(after.diary['600002'], undefined, '一条能用的都没有时，整条记录不留 —— 留着是个查不到作品的空壳');
  assert.deepEqual(after.tierlists['2026q3'].items, [], '指向不存在档位的图块不该进 state —— 读盘时会被静默丢掉，那更看不出问题');
  assert.equal(after.tierlists['2026q3'].rows[0].color, '#9aa0a6', '认不出的颜色给中性灰');
});

test('导出 → 导入 → 再导出：内容一致（这条守住整条链的对称）', async () => {
  const payload = buildTransfer(await makeRichState());
  importState(payload.state);
  const again = buildTransfer(exportableState());
  assert.deepEqual(again.state, payload.state, '来回一趟内容不该变');
  assert.deepEqual(again.counts, payload.counts);
});
