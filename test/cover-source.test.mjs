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
import {
  DISPLAY_VARIANT,
  THUMB_SUFFIX,
  coverCoverage,
  coverEntries,
  coverThumb,
} from '../src/core/covers.js';
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

/*
 * ---------------------------------------------------------------------------
 * 缩略图后缀：番堂的封面挂在 B 站图床上，原图一季 7 MB，
 * 预热几十秒而界面毫无提示 —— 2026-09-29 那次「封面一个都没渲染出来」就是这么来的。
 * 这几条守的是「压没压」「压错了没有」。
 * ---------------------------------------------------------------------------
 */

const HDSLB = 'https://i0.hdslb.com/bfs/new_dyn/6ec885213a549761b589d00ee2bbd70d512995925.jpg';

test('coverThumb：B 站图床的地址要挂上缩略图后缀', () => {
  const out = coverThumb(HDSLB);
  assert.equal(out, `${HDSLB}${THUMB_SUFFIX}`);
  assert.ok(out.endsWith('.webp'), '后缀里带的是 webp —— 实测它比同尺寸的 jpg 还小三成');
});

test('coverThumb：子域名也算（i0 / i1 / i2 都是同一套图床）', () => {
  assert.ok(coverThumb('https://i2.hdslb.com/bfs/x.jpg').endsWith(THUMB_SUFFIX));
  assert.ok(coverThumb('https://hdslb.com/bfs/x.jpg').endsWith(THUMB_SUFFIX));
});

test('coverThumb：不是这个图床的一个字都不许动（反向断言）', () => {
  // Bangumi 那套是变体路径，往后面叠后缀等于造出一个 404
  assert.equal(coverThumb('https://lain.bgm.tv/pic/cover/c/8a/9e/1.jpg'), 'https://lain.bgm.tv/pic/cover/c/8a/9e/1.jpg');
  assert.equal(coverThumb('https://example.com/a.jpg'), 'https://example.com/a.jpg');
});

test('coverThumb：已经带 @ 处理后缀的不要叠第二遍', () => {
  const once = coverThumb(HDSLB);
  assert.equal(coverThumb(once), once, '叠两次后缀 CDN 会直接 404');
});

test('coverThumb：脏输入原样返回，不抛', () => {
  assert.equal(coverThumb(''), '');
  assert.equal(coverThumb(null), '');
  assert.equal(coverThumb('不是链接'), '不是链接');
});

test('coverEntries：番堂那一路拿到的地址已经是压过的', () => {
  const es = coverEntries([{ id: 'y123', cover: HDSLB }], DISPLAY_VARIANT);
  assert.equal(es.length, 1);
  assert.equal(es[0].url, `${HDSLB}${THUMB_SUFFIX}`);
  assert.equal(es[0].key, 'y123', '键仍然是条目 id —— 换了地址也不许换键');
});
