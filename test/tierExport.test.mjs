/**
 * 导出那一侧的编排测试（阶段 E）。
 *
 * canvas 本身在 Node 里没有，画不出来 —— 所以这里只测**能测的那半**：
 * 取图的编排。真正容易出事的恰好就在这一半：
 *   - 某张图取不到 → 是跳过、还是让整次导出失败？
 *   - 进度会不会走不满？
 *   - 并发跑起来会不会漏掉几条？
 * 这三条错了的表现都是「点了导出，出来一张缺图的 / 什么都没有」，
 * 而 canvas 那一步反而只是照着坐标画，坐标由 measureLayout 的测试守着。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { collectImages } from '../src/core/tierExport.js';
import { fallbackPair, hueOf, readableInk } from '../src/core/palette.js';

const entries = (n, withUrl = true) => Array.from({ length: n }, (_, i) => ({
  key: `k${i}`,
  url: withUrl ? `https://example.com/cover/${i}.jpg` : null,
}));

test('collectImages：全部取到时一个不漏，进度走到满', async () => {
  const seen = [];
  const ticks = [];
  const { images, missing } = await collectImages(entries(9), {
    group: '2026q3',
    concurrency: 4,
    getImage: async ({ group, url }) => {
      seen.push({ group, url });
      return { status: 'fetched', dataUrl: `data:image/jpeg;base64,${url}` };
    },
    onProgress: (p) => ticks.push(p),
  });

  assert.equal(images.size, 9);
  assert.deepEqual(missing, []);
  assert.equal(ticks.at(-1).done, 9, '进度必须走到 total —— 走不满的话界面上的「正在取封面」永远不消失');
  assert.equal(ticks.at(-1).total, 9);
  assert.equal(seen.every((s) => s.group === '2026q3'), true, 'group 要一路传下去，否则缓存会落到别的组里');
});

test('collectImages：取不到的记进 missing，不静默跳过也不中断', async () => {
  const { images, missing } = await collectImages(entries(4), {
    group: 'g',
    concurrency: 2,
    getImage: async ({ url }) => (
      url.endsWith('2.jpg') ? { status: 'error', error: '超时' } : { dataUrl: `d:${url}` }
    ),
  });

  assert.equal(images.size, 3);
  assert.deepEqual(missing, ['k2'], '缺的那条要能报出来 —— 静默跳过的话用户看不出是没取到还是本来没封面');
});

test('collectImages：没有封面地址的条目直接算缺，不去问适配器', async () => {
  let calls = 0;
  const { images, missing } = await collectImages(
    [{ key: 'a', url: null }, { key: 'b', url: '' }, { key: 'c', url: 'https://example.com/x.jpg' }],
    {
      group: 'g',
      getImage: async () => { calls += 1; return { dataUrl: 'd:x' }; },
    },
  );
  assert.equal(calls, 1, '没地址的别去问');
  assert.equal(images.size, 1);
  assert.deepEqual(missing, ['a', 'b']);
});

test('collectImages：取图抛异常要吞掉并记账，不能让整次导出炸掉', async () => {
  const { images, missing } = await collectImages(entries(3), {
    group: 'g',
    getImage: async ({ url }) => {
      if (url.endsWith('1.jpg')) throw new Error('主进程没回应');
      return { dataUrl: 'd' };
    },
  });
  assert.equal(images.size, 2);
  assert.deepEqual(missing, ['k1']);
});

test('collectImages：并发数大于条目数、以及空列表，都不炸', async () => {
  const a = await collectImages(entries(2), { group: 'g', concurrency: 8, getImage: async () => ({ dataUrl: 'd' }) });
  assert.equal(a.images.size, 2);

  const b = await collectImages([], { group: 'g', getImage: async () => ({ dataUrl: 'd' }) });
  assert.equal(b.images.size, 0);
  assert.deepEqual(b.missing, []);

  const c = await collectImages(null, { group: 'g', getImage: async () => ({ dataUrl: 'd' }) });
  assert.equal(c.images.size, 0, '传 null 也要能扛住');
});

test('collectImages：并发不会漏条目（20 条 / 5 并发）', async () => {
  const { images } = await collectImages(entries(20), {
    group: 'g',
    concurrency: 5,
    getImage: async ({ url }) => ({ dataUrl: `d:${url}` }),
  });
  assert.equal(images.size, 20, '并发取数最容易写漏 —— 少一条就是导出图上少一块');
});

// ===================== 派生配色 =====================

test('hueOf / fallbackPair：同一个名字每次算出一样的颜色', () => {
  assert.equal(hueOf('示例番剧'), hueOf('示例番剧'));
  assert.notEqual(hueOf('示例番剧A'), hueOf('示例番剧B'));
  assert.deepEqual(fallbackPair('示例番剧'), fallbackPair('示例番剧'));
  assert.equal(fallbackPair('示例番剧').length, 2);
});

test('readableInk：亮底用深字、暗底用白字，认不出的给个安全值', () => {
  assert.equal(readableInk('#ff7f7f'), '#1a1d24', '亮色档位上要用深字');
  assert.equal(readableInk('#9aa0a6'), '#1a1d24');
  assert.equal(readableInk('#1a1d24'), '#ffffff', '暗色档位上要用白字');
  assert.equal(readableInk('#8b7cf6'), '#ffffff');
  assert.equal(readableInk('#fff'), '#1a1d24', '三位简写也要认');
  assert.equal(readableInk('不是颜色'), '#1a1d24', '认不出时给深字，别给 undefined');
  assert.equal(readableInk(null), '#1a1d24');
});
