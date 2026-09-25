/**
 * 同步编排的测试。
 *
 * 这里刻意不联网：sync.js 的副作用全是注入进来的，用假实现就能验证编排本身 ——
 * 「调用了几次写入」「失败的那一步有没有被记下来」「补番组有没有真的被补全」。
 * 这些正是最容易出假 vaccinated 现象的地方（界面显示完成，其实什么都没写）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { describeSyncReport, subjectFromApi, syncLibrary } from '../src/data/sync.js';

function rawRow({ id, ja, zh, begin, type = 'tv' }) {
  return {
    title: ja,
    titleTranslate: zh ? { 'zh-Hans': [zh] } : {},
    begin,
    type,
    sites: [{ site: 'bangumi', id: String(id) }],
  };
}

/** 拼一套最小够用的注入实现，并把每次调用记下来 */
function harness({ raws = [], apiResponder = null, storedIndex = null } = {}) {
  const calls = { nameIndex: [], seasons: [], archived: [], api: [] };
  return {
    calls,
    opts: {
      fetchCatalog: async () => raws,
      readNameIndex: async () => storedIndex,
      writeNameIndex: async (p) => { calls.nameIndex.push(p); },
      writeSeason: (key, items) => { calls.seasons.push({ key, items }); },
      archiveSubjects: (items) => { calls.archived.push(...items); return { added: items.length, updated: 0 }; },
      fetchJson: async (url) => {
        calls.api.push(url);
        if (apiResponder) return apiResponder(url);
        throw new Error('假实现：没有配 apiResponder');
      },
      api: { base: 'https://api.bgm.tv', timeoutMs: 2000 },
      nowMs: 1_700_000_000_000,
    },
  };
}

test('拉全量失败时，报告要说清楚失败在下载这一步', async () => {
  const r = await syncLibrary({
    fetchCatalog: async () => { throw new Error('连接超时（网络不通）'); },
    seasonKeys: ['2026q3'],
  });
  assert.equal(r.ok, false);
  assert.equal(r.downloaded, 0);
  assert.equal(r.errors[0].stage, 'catalog');
  assert.match(describeSyncReport(r), /检查一下 VPN/);
  assert.equal(r.seasons.length, 0, '下载失败就不该有任何季度被写入');
});

test('名称索引：没建过就建，刚建过的跳过', async () => {
  const raws = [rawRow({ id: 1, ja: 'A', zh: '甲', begin: '2026-10-01T00:00:00.000Z' })];

  const freshMissing = harness({ raws, storedIndex: null });
  const r1 = await syncLibrary({ ...freshMissing.opts, seasonKeys: [] });
  assert.equal(r1.index.built, true, '没有旧索引时必须建');
  assert.equal(freshMissing.calls.nameIndex.length, 1);
  assert.equal(freshMissing.calls.nameIndex[0].count, 1);

  const freshEnough = harness({
    raws,
    storedIndex: { builtAt: 1_700_000_000_000 - 1000, entries: [{ id: 1 }] },
  });
  const r2 = await syncLibrary({ ...freshEnough.opts, seasonKeys: [] });
  assert.equal(r2.index.built, false, '索引还是新的，不该重复建');
  assert.equal(r2.index.skipped, true);
  assert.equal(freshEnough.calls.nameIndex.length, 0);

  const forced = harness({ raws, storedIndex: { builtAt: 1_700_000_000_000 - 1000, entries: [{ id: 1 }] } });
  await syncLibrary({ ...forced.opts, seasonKeys: [], rebuildIndex: true });
  assert.equal(forced.calls.nameIndex.length, 1, '用户手点「重建」时必须无视新鲜度');
});

test('季度分组：每一季都写入，且 Season 跟着归档到作品档案', async () => {
  const raws = [
    rawRow({ id: 1, ja: 'A', zh: '甲', begin: '2026-10-01T00:00:00.000Z' }),
    rawRow({ id: 2, ja: 'B', zh: '乙', begin: '2026-10-05T00:00:00.000Z' }),
    rawRow({ id: 3, ja: 'C', zh: '丙', begin: '2026-07-02T00:00:00.000Z' }),
    rawRow({ id: 4, ja: 'D', zh: '丁', begin: '2020-01-02T00:00:00.000Z' }),
  ];
  const h = harness({ raws });
  const r = await syncLibrary({ ...h.opts, seasonKeys: ['2026q4', '2026q3'] });

  const keys = h.calls.seasons.map((s) => s.key).sort();
  assert.deepEqual(keys, ['2026q3', '2026q4'], '只更新指定的季度，2020q1 不该被拉进来');
  assert.equal(h.calls.seasons.find((s) => s.key === '2026q4').items.length, 2);
  assert.equal(r.seasons.reduce((n, s) => n + s.count, 0), 3);
  assert.ok(h.calls.archived.length >= 3, '同步到的条目要归档，否则换季就找不到名字了');
});

test('补番组：名单里有、档案里没有的作品会逐个回查 API', async () => {
  const ids = new Set([101, 202]);
  const h = harness({
    raws: [],
    apiResponder: (url) => {
      const m = /\/v0\/subjects\/(\d+)/.exec(url);
      const id = Number(m?.[1]);
      if (!ids.has(id)) throw new Error('查不到这条');
      return {
        name: `作品${id}`,
        name_cn: `Work ${id}`,
        rating: { score: 7.5, total: 1234 },
        total_episodes: 12,
        images: { large: `https://lain.bgm.tv/pic/cover/l/ab/cd/${id}_x.jpg` },
      };
    },
  });

  const r = await syncLibrary({ ...h.opts, seasonKeys: [], catchupIds: [101, 202] });
  assert.equal(h.calls.api.length, 2, '两个缺档案的 id，要发两次请求');
  assert.equal(r.catchup.requested, 2);
  assert.equal(r.catchup.ok, 2);
  assert.equal(r.catchup.failed, 0);

  const archived = h.calls.archived;
  assert.equal(archived.length, 2);
  const hit = archived.find((a) => a.id === 101);
  assert.equal(hit.titleZh, 'Work 101');
  assert.equal(hit.score, 7.5);
  assert.ok(hit.external.bangumi.includes('101'), '要带上 Bangumi 链接，界面才有得点');
});

test('补番组：查不到的那条要记进失败数，不能假装成功', async () => {
  const h = harness({
    raws: [rawRow({ id: 1, ja: 'A', zh: '甲', begin: '2026-10-01T00:00:00.000Z' })],
    apiResponder: () => { throw new Error('HTTP 404'); },
  });
  const r = await syncLibrary({ ...h.opts, seasonKeys: [], catchupIds: [999] });
  assert.equal(r.catchup.requested, 1);
  assert.equal(r.catchup.ok, 0);
  assert.equal(r.catchup.failed, 1);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.stage === 'subject:999'), '失败要带上是哪一条');
  assert.match(describeSyncReport(r), /1 处出错/);
});

test('subjectFromApi：拿不到的字段留空，不许编造', () => {
  const none = subjectFromApi(55, { name: 'のタイトル' });
  assert.equal(none.id, 55);
  assert.equal(none.titleJa, 'のタイトル');
  assert.equal(none.titleZh, '');
  assert.equal(none.score, undefined, '连 rating 都没有时，不该凭空出现评分');
  assert.equal(none.watchers, undefined, '同上，评分人数也不该出现');

  // 评分为 0 是「还没人打分」，跟「没这个字段」不是一回事：
  // 写成 0.0 显示出来会让人以为这部番被打成零分，所以这里必须留空。
  // watchers 相反 —— 0 是真实取到的值（0 人标记），照实保留。
  const zero = subjectFromApi(55, { rating: { score: 0, total: 0 } });
  assert.equal(zero.score, undefined);
  assert.equal(zero.watchers, 0);
});

test('describeSyncReport：部分失败也要如实报告', async () => {
  const raws = [rawRow({ id: 1, ja: 'A', zh: '甲', begin: '2026-10-01T00:00:00.000Z' })];
  const h = harness({ raws, apiResponder: () => { throw new Error('超时'); } });
  const r = await syncLibrary({ ...h.opts, seasonKeys: ['2026q4'], catchupIds: [7] });
  const text = describeSyncReport(r);
  assert.match(text, /名称索引/);
  assert.match(text, /1 个季度/);
  assert.match(text, /补番组补全 0\/1/);
  assert.match(text, /出错/);
});
