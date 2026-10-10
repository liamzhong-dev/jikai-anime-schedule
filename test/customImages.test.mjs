/**
 * 自定义图片的纯函数层：键的约定、元数据清洗、假条目的形状。
 *
 * 这一层是被「三处消费方 + 两种壳」逼出来的 —— 封面墙、奖项、Tier List 都按
 * **条目 key** 取图，桌面壳和浏览器壳存的地方又不一样（磁盘 / localStorage）。
 * 键怎么编、名字怎么截、没有图时假条目长什么样，这些必须在两边一致，
 * 否则症状永远是「某一边图出不来」，而线索指向的是取图那一层。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CUSTOM_PREFIX,
  customAnimeList,
  customAnimeOf,
  customKeyOf,
  fileOfCustomKey,
  imageName,
  isCustomFile,
  isCustomKey,
  normalizeImageList,
  normalizeImageMeta,
} from '../src/core/customImages.js';

const FILE = 'ci-0123456789ab.png';
const KEY = `${CUSTOM_PREFIX}${FILE}`;

test('键：编得出去也解得回来，形状不对的一律不认', () => {
  assert.equal(customKeyOf(FILE), KEY);
  assert.equal(fileOfCustomKey(KEY), FILE);
  assert.equal(isCustomKey(KEY), true);

  // 数字 id 是 Bangumi 的番，绝不能被当成自定义图 ——
  // 认错的话这些番会被送去「本地图片」那条路，结果是一整屏色块
  assert.equal(isCustomKey('558064'), false);
  assert.equal(isCustomKey(`img:../${FILE}`), false, '路径穿越不能认');
  assert.equal(isCustomKey('img:'), false);
  assert.equal(isCustomKey(''), false);
  assert.equal(isCustomKey(null), false);
  assert.equal(fileOfCustomKey('558064'), '');
});

test('文件名：只认 ci-<hex12>.<ext>', () => {
  assert.equal(isCustomFile(FILE), true);
  assert.equal(isCustomFile('ci-0123456789ab.jpg'), true);
  for (const bad of ['ci-0123456789a.png', 'ci-0123456789abc.png', 'x-0123456789ab.png', `${FILE}.tmp`, '../../a.png', '']) {
    assert.equal(isCustomFile(bad), false, `${bad} 不该被认成合法文件名`);
  }
});

test('元数据：不合法的丢掉，重名的只留一个，新的排前面', () => {
  const list = normalizeImageList([
    { file: FILE, name: '  一张  插画  ', bytes: 1024, addedAt: 100 },
    { file: FILE, name: '重复的那条', addedAt: 200 },
    { file: '../escape.png', name: '越界的' },
    { file: 'ci-aaaabbbbcccc.webp', name: '', bytes: 10, addedAt: 300 },
    null,
  ]);
  assert.equal(list.length, 2);
  assert.equal(list[0].file, 'ci-aaaabbbbcccc.webp', '新加的排最前');
  assert.equal(list[0].name, 'ci-aaaabbbbcccc.webp', '没名字就用文件名顶上');
  assert.equal(list[1].name, '一张 插画', '名字里的空白要压成一个');
});

test('元数据：bytes 是脏值时给 0，不能变成 NaN 混进界面', () => {
  assert.equal(normalizeImageMeta({ file: FILE, bytes: 'x' }).bytes, 0);
  assert.equal(normalizeImageMeta({ file: FILE }).addedAt, 0);
  assert.equal(normalizeImageMeta({ file: 'nope.png' }), null);
});

test('名字：超长的截掉，全空白的给兜底', () => {
  assert.equal(imageName('x'.repeat(100)).length, 40);
  assert.equal(imageName('   '), '自定义图片');
  assert.equal(imageName(undefined, 'fallback'), 'fallback');
});

test('假条目：只有下游真正会读的那几个字段，且评分是 0', () => {
  const a = customAnimeOf({ file: FILE, name: '一张插画', dataUrl: 'data:image/png;base64,AAA' });
  assert.equal(a.id, KEY);
  assert.equal(a.titleZh, '一张插画');
  assert.equal(a.cover, 'data:image/png;base64,AAA');
  // score 给 0 是有意的：Tier List 的「按评分自动分档」遇到 0 分会把它留在素材池，
  // 而不是替用户塞进最后一档 —— 自定义图没有评分，谁也不该替它做这个判断
  assert.equal(a.score, 0);
  assert.equal(a.__custom, true);

  // 文件名不合法时返回 null，而不是造一个 id 是空的条目
  assert.equal(customAnimeOf({ file: 'nope.png' }), null);
});

test('假条目清单：dataUrl 还没读出来时 cover 是空串，不能是 undefined', () => {
  const list = customAnimeList([{ file: FILE, name: '一张插画' }], {});
  assert.equal(list.length, 1);
  // 空串意味着「没有图」，`Cover` 会据此退成派生色块；
  // 给 undefined 的话 `<img src={undefined}>` 会渲染出一个破图图标
  assert.equal(list[0].cover, '');

  const loaded = customAnimeList([{ file: FILE, name: '一张插画' }], { [FILE]: 'data:image/png;base64,AAA' });
  assert.equal(loaded[0].cover, 'data:image/png;base64,AAA');
  assert.deepEqual(customAnimeList([{ file: 'bad.png' }], {}), []);
});
