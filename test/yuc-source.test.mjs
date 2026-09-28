/**
 * 番堂取数层（`src/data/yucSource.js`）测试。
 *
 * 这一层全是「真出事时才会走到」的分支：断网但手里有旧缓存、
 * 拉到一半的页面、站点改版解析不出来、缓存是上一版格式的。
 * 手工点不到这些路径，所以依赖从外面灌进来，在这里把每一条都走一遍。
 *
 * 最值钱的两条是**反向**的：
 *   - 命中缓存时**一次网络都不该发**（否则「离线可用」是假的）；
 *   - 拉失败退回旧缓存时**必须带 stale 标记**（否则界面会把几天前的排播表
 *     当成最新的显示出来，而且看不出任何异常）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  YUC_CACHE_SCHEMA,
  YUC_KEEP_SEASONS,
  loadYucSeason,
  putCachedYuc,
  readCachedYuc,
} from '../src/data/yucSource.js';

const html = fs.readFileSync(new URL('./fixtures/yuc-schedule.sample.html', import.meta.url), 'utf8');

/** 假的 platform：记下调用次数，缓存与网络的行为由每个用例自己指定 */
function fakePlatform({ text = null, fail = null, cached = null } = {}) {
  const calls = { fetchText: 0, read: 0, write: 0 };
  const p = {
    calls,
    async readYucCache() {
      calls.read += 1;
      return cached;
    },
    async writeYucCache() {
      calls.write += 1;
      return true;
    },
    async fetchText() {
      calls.fetchText += 1;
      if (fail) throw new Error(fail);
      return text;
    },
  };
  return p;
}

function goodCache(savedAt = 1_700_000_000_000) {
  return {
    '2026q4': {
      schema: YUC_CACHE_SCHEMA,
      savedAt,
      seasonName: '秋季档',
      total: 69,
      stats: { items: 2 },
      groups: [{ key: 'mon', label: '周一 (月)', items: [{ id: 'y1', titleZh: '旧数据' }] }],
    },
  };
}

/* ---------- 缓存的形状校验 ---------- */

test('缓存读不出来的一律给 null（调用方据此去网上拉，这不是错误）', () => {
  assert.equal(readCachedYuc(null, '2026q4'), null);
  assert.equal(readCachedYuc([], '2026q4'), null);
  assert.equal(readCachedYuc({}, '2026q4'), null);
  assert.equal(readCachedYuc({ '2026q4': null }, '2026q4'), null);
});

test('⚠️ 结构版本对不上的旧缓存要当没有，不能硬读', () => {
  const old = goodCache();
  old['2026q4'].schema = YUC_CACHE_SCHEMA - 1;
  assert.equal(readCachedYuc(old, '2026q4'), null, '旧 schema 被读出来了 —— 字段可能已经改名了');
});

test('缺 savedAt / 缺 groups / 分组里没有 items 都算坏缓存', () => {
  const a = goodCache(); delete a['2026q4'].savedAt;
  assert.equal(readCachedYuc(a, '2026q4'), null);

  const b = goodCache(); b['2026q4'].groups = [];
  assert.equal(readCachedYuc(b, '2026q4'), null);

  const c = goodCache(); c['2026q4'].groups = [{ key: 'mon' }];
  assert.equal(readCachedYuc(c, '2026q4'), null);
});

test('好缓存原样返回', () => {
  const r = readCachedYuc(goodCache(), '2026q4');
  assert.equal(r.seasonName, '秋季档');
  assert.equal(r.groups[0].items[0].titleZh, '旧数据');
});

/* ---------- 写入与裁剪 ---------- */

test('写入会带上结构版本，且不改入参', () => {
  const before = {};
  const after = putCachedYuc(before, '2026q4', { savedAt: 1, groups: [] });
  assert.equal(after['2026q4'].schema, YUC_CACHE_SCHEMA);
  assert.equal(Object.keys(before).length, 0, '入参被就地改了 —— React 状态这样改会认不出变化');
});

test('写入时按 savedAt 从新到旧裁剪，只留最近几季', () => {
  let map = {};
  for (let i = 0; i < YUC_KEEP_SEASONS + 4; i += 1) {
    map = putCachedYuc(map, `202${i}q1`, { savedAt: 1000 + i, groups: [] });
  }
  const keys = Object.keys(map);
  assert.equal(keys.length, YUC_KEEP_SEASONS, `该留 ${YUC_KEEP_SEASONS} 季，实际 ${keys.length}`);
  // 留下的必须是最新的那几季 —— 反着裁等于把刚拉的扔了
  assert.ok(keys.includes(`202${YUC_KEEP_SEASONS + 3}q1`), '最新那一季被裁掉了');
  assert.ok(!keys.includes('2020q1'), '最旧那一季没被裁掉');
});

test('裁剪阈值至少是 1：配置写歪了也不能把数据全丢掉', () => {
  const out = putCachedYuc({}, '2026q4', { savedAt: 1, groups: [] }, { keep: 0 });
  assert.equal(Object.keys(out).length, 1);
});

/* ---------- 取数流程 ---------- */

test('正常路径：联网拉到、解析成功、给出要落盘的缓存', async () => {
  const p = fakePlatform({ text: html });
  const r = await loadYucSeason({ seasonKey: '2026q4', platform: p, now: 12345 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.cached, false);
  assert.equal(p.calls.fetchText, 1);
  assert.ok(r.data.groups.length > 0);
  assert.equal(r.data.savedAt, 12345, 'savedAt 应该用传进来的 now，不是真实时间');
  assert.ok(r.cacheMap, '该给调用方一份新的缓存表');
  assert.equal(r.cacheMap['2026q4'].schema, YUC_CACHE_SCHEMA);
});

test('⚠️ 命中缓存时一次网络都不发', async () => {
  const p = fakePlatform({ text: html, cached: goodCache() });
  const r = await loadYucSeason({ seasonKey: '2026q4', platform: p });
  assert.equal(r.ok, true);
  assert.equal(r.cached, true);
  assert.equal(p.calls.fetchText, 0, '命中缓存还去联网了 —— 「离线可用」是句空话');
  assert.equal(r.cacheMap, null, '没写缓存就不该给缓存表，否则调用方会白落一次盘');
});

test('点了「更新」就必须真去拉，不能拿缓存糊弄', async () => {
  const p = fakePlatform({ text: html, cached: goodCache() });
  const r = await loadYucSeason({ seasonKey: '2026q4', platform: p, live: true });
  assert.equal(p.calls.fetchText, 1);
  assert.equal(r.cached, false);
  assert.equal(p.calls.write, 1, '拉到新数据之后没落盘 —— 重开一次就白拉了');
});

test('⚠️ 拉失败但有旧缓存：给旧数据，并且必须标 stale', async () => {
  const p = fakePlatform({ fail: '连接超时（网络不通，或被墙 / 需要开代理）', cached: goodCache() });
  const r = await loadYucSeason({ seasonKey: '2026q4', platform: p, live: true });
  assert.equal(r.ok, true);
  assert.equal(r.stale, true, '退回旧缓存却没标 stale —— 界面会把几天前的排播表当成最新的');
  assert.ok(r.error, 'stale 的同时要把原因带出来');
  assert.equal(r.data.groups[0].items[0].titleZh, '旧数据');
});

test('拉失败又没有缓存：明确失败，不能给空数据', async () => {
  const p = fakePlatform({ fail: '没有网络连接' });
  const r = await loadYucSeason({ seasonKey: '2026q4', platform: p });
  assert.equal(r.ok, false);
  assert.match(r.error, /没有网络|网络/);
  assert.equal(r.data, undefined);
});

test('⚠️ 站点改版（页面解析不出来）时，有旧缓存也要标 stale', async () => {
  const p = fakePlatform({ text: '<html><body><div>完全不一样的结构</div></body></html>', cached: goodCache() });
  const r = await loadYucSeason({ seasonKey: '2026q4', platform: p, live: true });
  assert.equal(r.ok, true);
  assert.equal(r.stale, true);
  assert.match(r.error, /结构|分组|介绍/, `理由没指明是结构问题：${r.error}`);
});

test('站点改版又没缓存：失败理由是「结构可能变了」，不是「没有内容」', async () => {
  const p = fakePlatform({ text: '<html><body><div>完全不一样的结构</div></body></html>' });
  const r = await loadYucSeason({ seasonKey: '2026q4', platform: p });
  assert.equal(r.ok, false);
  assert.match(r.error, /结构/);
});

test('季度键不认识：直接失败，不去发请求', async () => {
  const p = fakePlatform({ text: html });
  const r = await loadYucSeason({ seasonKey: '今年秋天', platform: p });
  assert.equal(r.ok, false);
  assert.equal(p.calls.fetchText, 0, '键都不对还发了请求');
});

test('缓存读出来是坏的（上一版格式）：当成没有，去网上拉', async () => {
  const bad = goodCache();
  bad['2026q4'].schema = YUC_CACHE_SCHEMA - 1;
  const p = fakePlatform({ text: html, cached: bad });
  const r = await loadYucSeason({ seasonKey: '2026q4', platform: p });
  assert.equal(p.calls.fetchText, 1, '坏缓存没被忽略，于是这次没去联网');
  assert.equal(r.ok, true);
  assert.equal(r.cached, false);
});

test('readYucCache 自己抛了：不能把整条链带崩', async () => {
  const p = fakePlatform({ text: html });
  p.readYucCache = async () => { throw new Error('磁盘读不了'); };
  const r = await loadYucSeason({ seasonKey: '2026q4', platform: p });
  assert.equal(r.ok, true, '读缓存失败不该让「能联网拉到数据」这件事也失败');
});

test('写缓存失败不该影响这次展示（写盘是尽力而为）', async () => {
  const p = fakePlatform({ text: html });
  p.writeYucCache = async () => { throw new Error('磁盘满了'); };
  const r = await loadYucSeason({ seasonKey: '2026q4', platform: p });
  assert.equal(r.ok, true, '落盘失败把「已经拿到的数据」也弄丢了，是本末倒置');
  assert.ok(r.data.groups.length > 0);
});
