/**
 * 封面覆盖率的契约。
 *
 * 为什么值得单开一个文件守着：
 * v1.1 桌面端 82 张封面全退成色块，根因是「存的一侧用变体地址（`c` 档）、
 * 查的一侧用条目上的原始地址（`l` 档）」。两者都是合法字符串，JS 查不到只给
 * `undefined`，211 个测试一个都没拦住。
 *
 * 所以这里钉的是**契约**：对外暴露的键只能是条目 id。
 * 渲染层的分叉（缓存 / 直连 / 色块）在 `render.test.mjs` 里验，那边要打包 JSX。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DISPLAY_VARIANT, coverCoverage, coverEntries } from '../src/core/covers.js';
import { SAMPLE_ITEMS } from './fixtures/sample-state.js';

const ANIME = SAMPLE_ITEMS[0];
const OTHER = SAMPLE_ITEMS[1];
const DATA_URL = 'data:image/jpeg;base64,AAAA';

test('coverCoverage：全拿到就是 100%', () => {
  const es = coverEntries([ANIME, OTHER], DISPLAY_VARIANT);
  const images = Object.fromEntries(es.map((e) => [e.key, DATA_URL]));
  const c = coverCoverage(es, images);
  assert.equal(c.total, 2);
  assert.equal(c.cached, 2);
  assert.equal(c.missing, 0);
  assert.equal(c.ratio, 1);
});

test('coverCoverage：缺的要能指名道姓，缺的是条目 id', () => {
  const es = coverEntries([ANIME, OTHER], DISPLAY_VARIANT);
  const c = coverCoverage(es, { [String(ANIME.id)]: DATA_URL });
  assert.equal(c.cached, 1);
  assert.equal(c.missing, 1);
  assert.deepEqual(c.missingKeys, [String(OTHER.id)]);
  assert.ok(c.ratio < 1 && c.ratio > 0, `比例应当在 0~1 之间，实际 ${c.ratio}`);
});

test('coverCoverage：一张也没有时比例是 0，不是 100%', () => {
  const c = coverCoverage(coverEntries([ANIME], DISPLAY_VARIANT), {});
  assert.equal(c.ratio, 0);
  assert.equal(c.missing, 1);
});

test('coverCoverage：空清单算 100%（没有图要放，本来就不缺图）', () => {
  // 这条是刻意的：判「能不能导出」靠 `missing > 0`，不靠 ratio。
  // 要是一个空报告也被自己的覆盖率拦住，那才是 bug。
  const c = coverCoverage([], {});
  assert.deepEqual({ total: c.total, missing: c.missing, ratio: c.ratio }, { total: 0, missing: 0, ratio: 1 });
});

test('coverCoverage：拿变体地址当键不算命中（反向断言，就是 v1.1 那个 bug）', () => {
  const es = coverEntries([ANIME], DISPLAY_VARIANT);
  assert.ok(es[0].url !== ANIME.cover, '前提：请求的地址和条目上的地址本来就不是一个');
  assert.equal(coverCoverage(es, { [es[0].url]: DATA_URL }).cached, 0, '按地址存的话一张都不该算命中');
  assert.equal(coverCoverage(es, { [String(ANIME.id)]: DATA_URL }).cached, 1);
});

test('coverCoverage：脏输入不崩', () => {
  assert.deepEqual(coverCoverage(null, null), { total: 0, cached: 0, missing: 0, ratio: 1, missingKeys: [] });
  assert.equal(coverCoverage([null, {}], {}).missing, 2, '没有 key 的条目也要算进「没拿到」');
});
