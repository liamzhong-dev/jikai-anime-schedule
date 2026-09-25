/**
 * 封面缓存的真机测试（在临时目录里真的写文件）。
 *
 * 为什么不用 mock 掉 fs：这一层的价值全在「文件到底有没有落到对的地方」——
 * 命中判定、按组分目录、清理时只删该删的组。用假的 fs 只能验证调用顺序，
 * 验证不了这些，而这里一旦出错，表现是「缓存看起来在工作，磁盘上其实空的」。
 *
 * fetchBinary 用假的：联网不是这个测试要验的东西，那部分在 net.cjs 里。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CoverCache, hashUrl, extFor, safeGroup, mimeFromExt } = require('../electron/covers.cjs');

/** 一张 1×1 的 PNG base64，用来当假图 */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function makeCache({ responder } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'jikai-covers-'));
  const calls = [];
  const cache = new CoverCache(root, {
    fetchBinary: async ({ url }) => {
      calls.push(url);
      // responder 返回 null 表示「这条走默认响应」，别把 null 当成失败
      const custom = responder ? await responder(url) : null;
      return custom ?? { ok: true, status: 200, data: PNG_B64, mime: 'image/png', bytes: Buffer.from(PNG_B64, 'base64').length };
    },
  });
  return { cache, calls, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const urlOf = (id) => `https://lain.bgm.tv/pic/cover/l/ab/cd/${id}_x.jpg`;

test('第一次取图走网络，第二次直接命中磁盘（不再联网）', async () => {
  const { cache, calls, cleanup } = makeCache();
  try {
    const first = await cache.get({ group: '2026q3', url: urlOf(1) });
    assert.equal(first.status, 'fetched');
    assert.equal(calls.length, 1, '第一次要真的去取');
    assert.ok(first.dataUrl.startsWith('data:image/png;base64,'), '要回一个能直接画进 canvas 的 dataURL');

    const second = await cache.get({ group: '2026q3', url: urlOf(1) });
    assert.equal(second.status, 'hit', '第二次必须命中缓存');
    assert.equal(calls.length, 1, '命中时不能再发请求 —— 否则缓存等于没有');
    assert.ok(second.dataUrl.startsWith('data:'));
  } finally {
    cleanup();
  }
});

test('refresh 会强制重新下载，哪怕本地已经有了', async () => {
  const { cache, calls, cleanup } = makeCache();
  try {
    await cache.get({ group: 'catchup', url: urlOf(2) });
    assert.equal(calls.length, 1);
    const again = await cache.get({ group: 'catchup', url: urlOf(2), refresh: true });
    assert.equal(again.status, 'fetched', 'refresh 时要重新取');
    assert.equal(calls.length, 2);
  } finally {
    cleanup();
  }
});

test('缓存按组分目录 —— 这是「只清一个季度」能做到前提', async () => {
  const { cache, cleanup, root } = makeCache();
  try {
    await cache.get({ group: '2026q3', url: urlOf(1) });
    await cache.get({ group: '2026q4', url: urlOf(2) });
    await cache.get({ group: 'catchup', url: urlOf(3) });

    const dirs = readdirSync(join(root, 'covers')).sort();
    assert.deepEqual(dirs, ['2026q3', '2026q4', 'catchup'], '每个组一个目录');
    assert.equal(readdirSync(join(root, 'covers', 'catchup')).length, 1);
  } finally {
    cleanup();
  }
});

test('warm 只下载缺的那些，已有的一律跳过', async () => {
  const { cache, calls, cleanup } = makeCache();
  try {
    await cache.get({ group: '2026q3', url: urlOf(1) });
    await cache.get({ group: '2026q3', url: urlOf(2) });
    assert.equal(calls.length, 2);

    const r = await cache.warm({ group: '2026q3', urls: [urlOf(1), urlOf(2), urlOf(3), urlOf(4)], concurrency: 4 });
    assert.equal(r.total, 4);
    assert.equal(r.skipped, 2, '已存在的两张要被跳过');
    assert.equal(r.ok, 2, '只下载缺的两张');
    assert.equal(r.failed, 0);
    assert.equal(calls.length, 4, '不该为已有的图再发请求');
  } finally {
    cleanup();
  }
});

test('warm 对重复的 url 去重，且进度回调会走到 100', async () => {
  const { cache, calls, cleanup } = makeCache();
  try {
    const seen = [];
    const r = await cache.warm({
      group: '2026q3',
      urls: [urlOf(1), urlOf(1), urlOf(1), urlOf(2)],
      concurrency: 3,
      onProgress: (p) => seen.push(p.pct),
    });
    assert.equal(calls.length, 2, '同一个 url 只该取一次');
    assert.equal(r.total, 2);
    assert.ok(seen.includes(100), `进度要走到 100（实际收到 ${JSON.stringify(seen)}）`);
  } finally {
    cleanup();
  }
});

test('warm 空列表不炸，也能给到进度', async () => {
  const { cache, cleanup } = makeCache();
  try {
    const seen = [];
    const r = await cache.warm({ group: '2026q3', urls: [], onProgress: (p) => seen.push(p.pct) });
    assert.equal(r.total, 0);
    assert.equal(r.ok, 0);
    assert.ok(seen.includes(100));
  } finally {
    cleanup();
  }
});

test('取图失败要落到 failed 并记录原因，不能把整批拖死', async () => {
  const { cache, cleanup } = makeCache({
    responder: async (url) => (url.includes('bad') ? { ok: false, status: 0, error: '连接超时' } : null),
  });
  try {
    const r = await cache.warm({ group: '2026q3', urls: [urlOf(1), urlOf(2), 'bad'], concurrency: 2 });
    assert.equal(r.failed, 1);
    assert.equal(r.ok, 2, '一张失败不该影响其他的');
    assert.equal(r.errors[0].error, '连接超时', '失败原因要记下来');
  } finally {
    cleanup();
  }
});

test('stats 报出各组占用，clear 能只清一个组', async () => {
  const { cache, cleanup } = makeCache();
  try {
    await cache.get({ group: '2026q3', url: urlOf(1) });
    await cache.get({ group: '2026q4', url: urlOf(2) });

    const before = await cache.stats();
    assert.equal(before.exists, true);
    assert.equal(before.totalFiles, 2);
    assert.equal(before.groups.length, 2);
    assert.ok(before.totalBytes > 0);

    const cleared = await cache.clear({ group: '2026q3' });
    assert.equal(cleared.removed, 1);
    assert.ok(cleared.freedBytes > 0);

    const after = await cache.stats();
    const keys = after.groups.map((g) => g.group);
    assert.deepEqual(keys, ['2026q4'], '只该删掉指定组，另一个组必须完好');
    assert.ok(existsSync(join(after.root, '2026q4')), '2026q4 的目录要还在');
  } finally {
    cleanup();
  }
});

test('整清：目录整个消失', async () => {
  const { cache, cleanup, root } = makeCache();
  try {
    await cache.get({ group: '2026q3', url: urlOf(1) });
    const r = await cache.clear();
    assert.equal(r.removed, 1);
    assert.ok(!existsSync(join(root, 'covers')), '清完整个 covers 目录应该不存在了');
  } finally {
    cleanup();
  }
});

test('没缓存过时 stats 给出安全的空结果，而不是抛', async () => {
  const { cache, cleanup } = makeCache();
  try {
    const s = await cache.stats();
    assert.equal(s.exists, false);
    assert.equal(s.totalBytes, 0);
    assert.deepEqual(s.groups, []);
    const r = await cache.clear({ group: '2026q3' });
    assert.equal(r.removed, 0, '清一个不存在的组不该报错');
  } finally {
    cleanup();
  }
});

test('非法组名一律拒绝 —— 它会变成目录名', async () => {
  const { cache, cleanup } = makeCache();
  try {
    for (const bad of ['../..', 'a/b', '', '   ', 'x'.repeat(80)]) {
      const r = await cache.get({ group: bad, url: urlOf(1) });
      assert.equal(r.status, 'error', `组名 ${JSON.stringify(bad)} 必须被拒`);
    }
    const w = await cache.warm({ group: '../escape', urls: [urlOf(1)] });
    assert.equal(w.failed, 1);
  } finally {
    cleanup();
  }
});

test('没有注入取图能力时明确报错，而不是卡住', async () => {
  const cache = new CoverCache(mkdtempSync(join(tmpdir(), 'jikai-covers-')));
  const r = await cache.get({ group: 'catchup', url: urlOf(1) });
  assert.equal(r.status, 'error');
  assert.match(r.error, /没有注入取图能力/);
});

// ---------- 小工具 ----------

test('hashUrl 稳定且不同 url 不碰撞', () => {
  assert.equal(hashUrl(urlOf(1)), hashUrl(urlOf(1)));
  assert.notEqual(hashUrl(urlOf(1)), hashUrl(urlOf(2)));
});

test('extFor：先看 MIME，MIME 认不出才看 URL 后缀', () => {
  assert.equal(extFor('image/jpeg', 'https://x/a'), '.jpg');
  assert.equal(extFor('image/png', 'https://x/a'), '.png');
  assert.equal(extFor('image/webp', 'https://x/a'), '.webp');
  assert.equal(extFor('application/octet-stream', 'https://x/a.JPG'), '.jpg');
  // MIME 和后缀都认不出时给 .jpg（Bangumi 封面基本都是 jpg）。
  // 这里不会误伤：net.cjs 的 fetchBinary 已经拦掉了非 image/* 的响应，
  // 能走到写盘这一步的一定是图片。
  assert.equal(extFor('text/html', 'https://x/a'), '.jpg');
  assert.equal(extFor('image/png', 'https://x/a.jpg'), '.png', 'MIME 优先于 URL 后缀');
});

test('mimeFromExt 与 safeGroup 的边界', () => {
  assert.equal(mimeFromExt('.jpg'), 'image/jpeg');
  assert.equal(mimeFromExt('.png'), 'image/png');
  assert.equal(mimeFromExt('.bin'), 'application/octet-stream');
  assert.equal(safeGroup('2026q3'), '2026q3');
  assert.equal(safeGroup('catchup'), 'catchup');
  assert.equal(safeGroup('../x'), null);
  assert.equal(safeGroup(''), null);
});
