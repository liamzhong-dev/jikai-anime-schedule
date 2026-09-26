/**
 * 封面表的键必须是**条目 id**，不能是封面地址。
 *
 * 为什么值得单开一个文件守着：
 * v1.1 桌面端 82 张封面全退成色块，根因就是「存的一侧用变体地址、查的一侧用原始地址」。
 * 两者都是合法字符串，JS 查不到只给 undefined，211 个测试一个都没拦住。
 * 所以这里钉的是**契约**，不是功能：
 *   1. 对外暴露的键只能是 id；
 *   2. 变体地址只能出现在 `url` 字段里，不许出现在键上。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DISPLAY_VARIANT,
  EXPORT_VARIANT,
  coverEntries,
  coverVariant,
  mapCoversByKey,
} from '../src/core/covers.js';

const COVER_L = 'https://lain.bgm.tv/pic/cover/l/8d/4f/509615_Ui3XChSSh.jpg';
const COVER_C = 'https://lain.bgm.tv/pic/cover/c/8d/4f/509615_Ui3XChSSh.jpg';

const ONE = { id: 509615, cover: COVER_L, titleZh: '示例番剧A' };
const TWO = { id: 12, cover: 'https://lain.bgm.tv/pic/cover/l/aa/bb/12_xyz.jpg', titleZh: '示例番剧B' };

test('coverEntries：键是条目 id，且是字符串', () => {
  const es = coverEntries([ONE, TWO], DISPLAY_VARIANT);
  assert.equal(es.length, 2);
  assert.deepEqual(es.map((e) => e.key), ['509615', '12']);
  // id 是数字也要转成字符串 —— 键的类型不统一，查表时就会一半命中一半不命中
  assert.equal(typeof es[0].key, 'string');
});

test('coverEntries：url 走的是请求那一档，不是条目上的原始地址', () => {
  const es = coverEntries([ONE], DISPLAY_VARIANT);
  assert.equal(es[0].url, COVER_C);
  assert.notEqual(es[0].url, ONE.cover);
  // 和 coverVariant 必须同源 —— 两边各算一次就会分叉
  assert.equal(es[0].url, coverVariant(ONE.cover, DISPLAY_VARIANT).url);
});

test('coverEntries：导出那一档同样能用（原图）', () => {
  const es = coverEntries([ONE], EXPORT_VARIANT);
  assert.equal(es[0].url, COVER_L);
  assert.equal(es[0].key, '509615');
});

test('coverEntries：没有封面地址的条目丢掉，不产生空 url', () => {
  const es = coverEntries([ONE, { id: 7, titleZh: '没封面' }, { id: 8, cover: '' }, null], DISPLAY_VARIANT);
  assert.equal(es.length, 1);
  assert.equal(es[0].key, '509615');
  assert.ok(es.every((e) => typeof e.url === 'string' && e.url.length > 0));
});

test('coverEntries：认不出 Bangumi 图床的地址原样保留（不凭空造链接）', () => {
  const es = coverEntries([{ id: 1, cover: 'https://example.com/a.jpg' }], DISPLAY_VARIANT);
  assert.equal(es.length, 1);
  assert.equal(es[0].url, 'https://example.com/a.jpg');
});

test('coverEntries：非数组 / 空值不崩', () => {
  assert.deepEqual(coverEntries(null, DISPLAY_VARIANT), []);
  assert.deepEqual(coverEntries(undefined, 'c'), []);
  assert.deepEqual(coverEntries([], DISPLAY_VARIANT), []);
  assert.deepEqual(coverEntries('nope', DISPLAY_VARIANT), []);
});

test('mapCoversByKey：按条目 key 组装，取不到的不出现', () => {
  const es = coverEntries([ONE, TWO], DISPLAY_VARIANT);
  const byUrl = { [COVER_C]: 'data:image/png;base64,AAA' };
  const m = mapCoversByKey(es, byUrl);
  assert.deepEqual(Object.keys(m), ['509615']);
  assert.equal(m['509615'], 'data:image/png;base64,AAA');
  assert.equal(m['12'], undefined);
});

test('mapCoversByKey：键是字符串，即使 key 传的是数字', () => {
  const m = mapCoversByKey([{ key: 42, url: 'u' }], { u: 'x' });
  assert.deepEqual(Object.keys(m), ['42']);
});

test('mapCoversByKey：变体地址绝不出现在结果的键里（这条就是 v1.1 那个 bug 的反向断言）', () => {
  const es = coverEntries([ONE], DISPLAY_VARIANT);
  const m = mapCoversByKey(es, { [COVER_C]: 'img' });
  for (const k of Object.keys(m)) {
    assert.ok(!k.startsWith('http'), `键不该是地址：${k}`);
  }
  assert.ok(!(COVER_C in m));
  assert.ok(!(COVER_L in m));
});

test('mapCoversByKey：脏输入不崩', () => {
  assert.deepEqual(mapCoversByKey(null, {}), {});
  assert.deepEqual(mapCoversByKey([], {}), {});
  assert.deepEqual(mapCoversByKey([{ key: '1', url: 'u' }], null), {});
  assert.deepEqual(mapCoversByKey([null, undefined, {}], { undefined: 'x' }), {});
});

test('组合起来：拿条目 id 能查到自己的图（端到端的契约）', () => {
  const list = [ONE, TWO];
  const es = coverEntries(list, DISPLAY_VARIANT);
  const byUrl = {};
  for (const e of es) byUrl[e.url] = `img:${e.key}`;
  const m = mapCoversByKey(es, byUrl);

  // 消费方只拿得到条目，也只能按 id 查 —— 这正是三个组件现在的写法
  for (const a of list) {
    assert.equal(m[String(a.id)], `img:${a.id}`);
  }
});
