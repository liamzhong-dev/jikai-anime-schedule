/**
 * 本地作品库与封面处理的纯函数测试。
 *
 * 这一批的重点是「容易记反的直觉」：
 *   - 补番卡片能不能在所有情况下都找得到名字（原来的 bug 就出在这儿）
 *   - 排序会不会让衍生条目压过正片
 *   - 变体地址改写会不会误伤别家域名
 *   - coverCrop 会不会算出越界的源矩形
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addToGroup, bangumiIdOf, buildNameIndex, defaultGroups, groupIds, groupSummary,
  mergeSubjects, nameIndexStale, pickSubjects, removeFromGroup, searchNames, zhNameOf,
} from '../src/core/library.js';
import { coverCrop, coverVariant, currentVariant, safeGroupKey } from '../src/core/covers.js';

/** 造一条 bangumi-data 形状的原条目 */
function rawRow({ id, ja, zh, begin, type = 'tv', site = 'bangumi' }) {
  return {
    title: ja,
    titleTranslate: zh ? { 'zh-Hans': [zh] } : {},
    begin,
    type,
    sites: id == null ? [] : [{ site, id: String(id) }],
  };
}

// ===================== 名称索引 =====================

test('buildNameIndex：去重、跳过没有 bangumi id 的、算出季度', () => {
  const index = buildNameIndex(
    [
      rawRow({ id: 1001, ja: 'ぼっち・ざ・ろっく！', zh: '孤独摇滚', begin: '2022-10-08T15:00:00.000Z' }),
      rawRow({ id: 1001, ja: 'ぼっち・ざ・ろっく！（重複）', zh: '孤独摇滚 重复', begin: '2022-10-08T15:00:00.000Z' }),
      rawRow({ id: null, ja: '没有 bangumi id 的条目', zh: '查不到的', begin: '2020-01-01T00:00:00.000Z' }),
      rawRow({ id: 1002, ja: '名前のない作品', zh: '', begin: '2023-01-06T00:00:00.000Z' }),
    ],
    { nowMs: 1_700_000_000_000, source: 'bangumi-data' },
  );

  assert.equal(index.count, 2, '1001 重复一次、无 id 的那条被丢弃，应剩 2 条');
  assert.equal(index.source, 'bangumi-data');
  assert.equal(index.entries[0].id, 1001);
  assert.equal(index.entries[0].zh, '孤独摇滚');
  // 2022-10-08 15:00Z → JST 已是 10/09，属 10 月 → q4
  assert.equal(index.entries[0].y, 2022);
  assert.equal(index.entries[0].q, 4);
  assert.equal(index.entries[1].zh, '', '没有中文名的条目也要收进来，ja 还能被搜到');
});

test('buildNameIndex：空输入不会炸，给出一个能用的空索引', () => {
  const empty = buildNameIndex([], { nowMs: 1 });
  assert.equal(empty.count, 0);
  assert.deepEqual(empty.span, []);
  assert.deepEqual(searchNames(empty, '鬼灭'), []);
  assert.equal(searchNames(null, '鬼灭').length, 0, '索引是 null 时也要稳，不能抛');
});

// ===================== 搜索排序 =====================

test('searchNames：正片要压过同名的衍生条目', () => {
  const index = buildNameIndex([
    rawRow({ id: 1, ja: '鬼滅の刃', zh: '鬼灭之刃', begin: '2019-04-06T00:00:00.000Z' }),
    rawRow({ id: 2, ja: '鬼滅の刃 兄妹の絆', zh: '鬼灭之刃 兄妹的羁绊', begin: '2020-10-01T00:00:00.000Z' }),
    rawRow({ id: 3, ja: '鬼滅の刃 那田蜘蛛山編', zh: '鬼灭之刃 那田蜘蛛山篇', begin: '2020-10-01T00:00:00.000Z' }),
  ], { nowMs: 1 });

  const hits = searchNames(index, '鬼灭');
  assert.equal(hits.length, 3);
  assert.equal(hits[0].id, 1, '短名本体必须排第一，否则用户永远找不到正片');
  assert.equal(hits[0].matched, '鬼灭之刃');
});

test('searchNames：中日文都能搜，大小写不敏感', () => {
  const index = buildNameIndex([
    rawRow({ id: 11, ja: 'BOCCHI THE ROCK!', zh: '孤独摇滚', begin: '2022-10-08T00:00:00.000Z' }),
  ], { nowMs: 1 });

  assert.equal(searchNames(index, '孤独')[0]?.id, 11, '中文命中');
  assert.equal(searchNames(index, 'bocchi')[0]?.id, 11, '英文小写能命中大写的原名');
  assert.equal(searchNames(index, 'BOCCHI')[0]?.id, 11, '英文大写也能命中');
  assert.equal(searchNames(index, 'ROCK')[0]?.id, 11, '中段匹配也应该找到');
});

test('searchNames：英文译名也能搜 —— 真实数据的 title 是日文，光靠日文搜不到 latin 写法', () => {
  const index = buildNameIndex([
    { title: '鬼滅の刃', titleTranslate: { 'zh-Hans': ['鬼灭之刃'], en: ['Demon Slayer: Kimetsu no Yaiba'] }, begin: '2019-04-06T00:00:00.000Z', type: 'tv', sites: [{ site: 'bangumi', id: '1' }] },
  ], { nowMs: 1 });

  assert.equal(index.entries[0].en, 'Demon Slayer: Kimetsu no Yaiba', '英文译名要进索引');
  assert.equal(searchNames(index, 'demon')[0]?.id, 1, '小写搜大写的英文名');
  assert.equal(searchNames(index, 'Kimetsu')[0]?.id, 1);
  assert.equal(searchNames(index, '鬼灭')[0]?.id, 1, '中文照样能搜到');
  assert.equal(searchNames(index, '鬼滅')[0]?.id, 1, '日文原名照样能搜到');
});

test('searchNames：只有英文名的条目也要能被搜到', () => {
  const index = buildNameIndex([
    { title: '', titleTranslate: { en: ['Some Obscure Title'] }, begin: '2015-01-01T00:00:00.000Z', type: 'tv', sites: [{ site: 'bangumi', id: '9' }] },
  ], { nowMs: 1 });
  assert.equal(index.count, 1, '只有英文名也算有名字，不该被丢掉');
  assert.equal(searchNames(index, 'obscure')[0]?.id, 9);
});

test('searchNames：空关键词返回空，不要返回全部', () => {
  const index = buildNameIndex([rawRow({ id: 1, ja: 'A', zh: '甲', begin: '2020-01-01T00:00:00.000Z' })], { nowMs: 1 });
  assert.deepEqual(searchNames(index, ''), []);
  assert.deepEqual(searchNames(index, '   '), [], '纯空格不该等于「搜全部」');
});

test('searchNames：limit 生效，且可以按类型过滤', () => {
  const rows = [];
  for (let i = 0; i < 30; i += 1) {
    rows.push(rawRow({ id: 200 + i, ja: `テスト${i}`, zh: `测试${i}`, begin: '2020-01-01T00:00:00.000Z', type: i % 2 ? 'tv' : 'movie' }));
  }
  const index = buildNameIndex(rows, { nowMs: 1 });

  assert.equal(searchNames(index, '测试', { limit: 5 }).length, 5);
  const tv = searchNames(index, '测试', { limit: 30, type: 'tv' });
  assert.ok(tv.length > 0);
  assert.ok(tv.every((h) => h.t === 'tv'), '按类型过滤后不该混进别的类型');
});

// ===================== 名称新鲜度 =====================

test('nameIndexStale：没建过算旧，刚建的不算旧', () => {
  const now = 1_700_000_000_000;
  assert.equal(nameIndexStale(null, { nowMs: now }).stale, true);
  assert.equal(nameIndexStale({ entries: [] }, { nowMs: now }).stale, true, '空索引等同没建过');

  const fresh = { entries: [{ id: 1 }], builtAt: now - 1000 };
  assert.equal(nameIndexStale(fresh, { nowMs: now }).stale, false);

  const old = { entries: [{ id: 1 }], builtAt: now - 60 * 86400000 };
  assert.equal(nameIndexStale(old, { nowMs: now }).stale, true);
});

// ===================== 作品档案 =====================

test('mergeSubjects：新数据里的空值不能把旧字段抹掉', () => {
  const first = mergeSubjects({}, [{ id: 5, titleZh: '孤独摇滚', summary: '後藤ひとり…', tags: ['音乐'] }]);
  assert.equal(first.added, 1);

  const second = mergeSubjects(first.subjects, [{ id: 5, cover: 'https://example.com/a.jpg', summary: '', tags: [] }]);
  const merged = second.subjects[5];
  assert.equal(merged.cover, 'https://example.com/a.jpg', '有值的字段要更新');
  assert.equal(merged.summary, '後藤ひとり…', '空字符串不该把已有的简介抹掉');
  assert.deepEqual(merged.tags, ['音乐'], '空数组不该把已有的标签抹掉');
  assert.equal(second.updated, 1);
  assert.equal(second.added, 0);
});

test('mergeSubjects：脏数据被跳过而不是写进档案', () => {
  const r = mergeSubjects({}, [null, undefined, { id: NaN }, { id: -3 }, { id: 0 }]);
  assert.equal(r.added, 0, '非法 id 一律不收');
  assert.deepEqual(Object.keys(r.subjects), []);
});

test('pickSubjects：分清「找到了」和「还缺」', () => {
  const subjects = { 1: { id: 1, titleZh: 'A' }, 2: { id: 2, titleZh: 'B' } };
  const { found, missing } = pickSubjects(subjects, [1, 2, 999]);
  assert.equal(found.length, 2);
  assert.deepEqual(missing, [999], '缺的 id 要说清楚是哪个，界面才能提示');
});

// ===================== 分组 =====================

test('默认分组里有补番组，且每次调用都是新对象', () => {
  const a = defaultGroups(1);
  const b = defaultGroups(1);
  assert.equal(a.catchup.label, '补番组');
  assert.deepEqual(a.catchup.ids, []);
  assert.notEqual(a, b, '两次 defaultGroups 不能共用同一个对象，否则改一处脏两处');
  assert.notEqual(a.catchup.ids, b.catchup.ids);
});

test('addToGroup：去重要彻底，重复加不涨长度', () => {
  const base = defaultGroups(1);
  const once = addToGroup(base, 'catchup', [1, 2, 3], { nowMs: 100 });
  assert.deepEqual(once.added, [1, 2, 3]);

  const twice = addToGroup(once.groups, 'catchup', [2, 3, 4], { nowMs: 200 });
  assert.deepEqual(twice.added, [4], '只有新加的那一个该被记为 added');
  assert.deepEqual(groupIds(twice.groups, 'catchup'), [1, 2, 3, 4]);
  assert.equal(twice.groups.catchup.updatedAt, 200, '有新东西进来才更新时间');

  const again = addToGroup(twice.groups, 'catchup', [1], { nowMs: 300 });
  assert.deepEqual(again.added, [], '重复加不算新');
  assert.equal(again.groups.catchup.updatedAt, 200, '没加进新 id 时不该刷新 updatedAt');
});

test('addToGroup：非法 id 静默过滤，组名空则整体不动', () => {
  const base = defaultGroups(1);
  const r = addToGroup(base, 'catchup', [null, NaN, -1, 0, 7], { nowMs: 1 });
  assert.deepEqual(r.added, [7]);

  const noop = addToGroup(base, '', [1], { nowMs: 1 });
  assert.deepEqual(noop.added, []);
  assert.equal(noop.groups, base, '组名为空时不应该产生新对象');
});

test('addToGroup：给不存在的组加东西会顺手建出来', () => {
  const r = addToGroup(defaultGroups(1), 'watchlater', [9], { nowMs: 1, label: '待看组' });
  assert.equal(r.groups.watchlater.label, '待看组');
  assert.deepEqual(groupIds(r.groups, 'watchlater'), [9]);
});

test('removeFromGroup：删掉之后其他组不受影响', () => {
  let groups = defaultGroups(1);
  groups = addToGroup(groups, 'catchup', [1, 2, 3], { nowMs: 1 }).groups;
  groups = addToGroup(groups, 'watchlater', [1], { nowMs: 1, label: '待看组' }).groups;

  const after = removeFromGroup(groups, 'catchup', 2, { nowMs: 2 });
  assert.deepEqual(groupIds(after, 'catchup'), [1, 3]);
  assert.deepEqual(groupIds(after, 'watchlater'), [1], '同一个 id 在别的组里要留着');

  const missing = removeFromGroup(after, 'catchup', 404, { nowMs: 3 });
  assert.equal(missing, after, '删一个不存在的 id 不该产生新对象');
});

test('groupSummary：给界面用的一览要带上数量', () => {
  const groups = addToGroup(defaultGroups(1), 'catchup', [1, 2], { nowMs: 5 }).groups;
  const rows = groupSummary(groups);
  const hit = rows.find((r) => r.key === 'catchup');
  assert.equal(hit.count, 2);
  assert.equal(hit.label, '补番组');
  assert.equal(hit.updatedAt, 5);
});

// ===================== 辅助取值 =====================

test('bangumiIdOf / zhNameOf：取不到的情况要给默认值而不是抛', () => {
  assert.equal(bangumiIdOf({ sites: [{ site: 'bangumi', id: '123' }] }), 123);
  assert.equal(bangumiIdOf({ sites: [{ site: 'anicobin', id: '9' }] }), null, '别的站点 id 不能拿来当 bangumi id');
  assert.equal(bangumiIdOf({}), null);
  assert.equal(bangumiIdOf(null), null);
  assert.equal(zhNameOf({ titleTranslate: { 'zh-Hans': ['译名'] } }), '译名');
  assert.equal(zhNameOf({ titleTranslate: { 'zh-Hans': [] } }), '');
  assert.equal(zhNameOf({}), '');
});

// ===================== 封面变体 =====================

test('coverVariant：只认 Bangumi 图床，别家域名原样返回', () => {
  const url = 'https://lain.bgm.tv/pic/cover/l/ab/cd/123456_abcdef.jpg';
  const c = coverVariant(url, 'c');
  assert.equal(c.changed, true);
  assert.equal(c.url, 'https://lain.bgm.tv/pic/cover/c/ab/cd/123456_abcdef.jpg');

  const other = coverVariant('https://example.com/pic/cover/l/ab/cd/x.jpg', 'c');
  assert.equal(other.changed, false, '别家的路径只是长得像，不能跟着改');
  assert.equal(other.url, 'https://example.com/pic/cover/l/ab/cd/x.jpg');

  const notCover = coverVariant('https://lain.bgm.tv/somewhere/else/l/x.jpg', 'c');
  assert.equal(notCover.changed, false, '不是 /pic/cover/ 的路径不该被误伤');

  const same = coverVariant(url, 'l');
  assert.equal(same.changed, false, '本来就是目标变体时不重写');
  assert.equal(same.variant, 'l');
});

test('coverVariant：畸形输入一律原样返回，不抛也不返回空串', () => {
  assert.equal(coverVariant('', 'c').changed, false);
  assert.equal(coverVariant(null, 'c').changed, false);
  assert.equal(coverVariant('https://lain.bgm.tv/pic/cover/l/x.jpg', '').changed, false);
  assert.equal(coverVariant('https://lain.bgm.tv/pic/cover/l/x.jpg', null).url, 'https://lain.bgm.tv/pic/cover/l/x.jpg');
});

test('currentVariant：反推当前变体', () => {
  assert.equal(currentVariant('https://lain.bgm.tv/pic/cover/m/ab/cd/1.jpg'), 'm');
  assert.equal(currentVariant('https://lain.bgm.tv/pic/cover/l/ab/cd/1.jpg'), 'l');
  assert.equal(currentVariant('https://example.com/a.jpg'), null);
  assert.equal(currentVariant(''), null);
});

// ===================== coverCrop =====================

test('coverCrop：不同比例的源图都居中裁到目标比例，且不越界', () => {
  // 目标 1:1.4（海报比例）
  const dst = { dstW: 128, dstH: 180 };
  const cases = [
    { srcW: 1460, srcH: 2064, name: '接近目标比例的原图' },
    { srcW: 1079, srcH: 1680, name: '偏瘦的长图' },
    { srcW: 714, srcH: 1000, name: '过小的图' },
    { srcW: 2907, srcH: 4096, name: '超大的图' },
    { srcW: 4000, srcH: 1000, name: '极扁的横图' },
    { srcW: 1000, srcH: 4000, name: '极高的竖图' },
  ];

  for (const c of cases) {
    const r = coverCrop({ ...c, ...dst });
    assert.ok(r.sx >= 0 && r.sy >= 0, `${c.name}：起点不能是负数`);
    assert.ok(r.sw > 0 && r.sh > 0, `${c.name}：尺寸不能是零或负`);
    assert.ok(r.sx + r.sw <= c.srcW + 0.5, `${c.name}：右边越界了`);
    assert.ok(r.sy + r.sh <= c.srcH + 0.5, `${c.name}：下边越界了`);
    const ratio = r.sw / r.sh;
    assert.ok(Math.abs(ratio - dst.dstW / dst.dstH) < 0.02, `${c.name}：裁出来的宽高比要贴住目标（实际 ${ratio.toFixed(3)}）`);
  }
});

test('coverCrop：非法输入给零值而不是负数', () => {
  const r = coverCrop({ srcW: 0, srcH: 0, dstW: 128, dstH: 180 });
  assert.equal(r.sx, 0);
  assert.equal(r.sw, 0);
  const r2 = coverCrop({ srcW: 100, srcH: 200, dstW: 0, dstH: 0 });
  assert.equal(r2.sx, 0);
  assert.ok(r2.sw >= 0);
});

// ===================== 组名安全 =====================

test('safeGroupKey：会被当目录名用，必须卡死', () => {
  assert.equal(safeGroupKey('2026q3'), '2026q3');
  assert.equal(safeGroupKey('catchup'), 'catchup');
  assert.equal(safeGroupKey('..'), null, '不能让人通过 .. 穿越到别的目录去');
  assert.equal(safeGroupKey('../../etc'), null);
  assert.equal(safeGroupKey('a/b'), null);
  assert.equal(safeGroupKey(''), null);
  assert.equal(safeGroupKey('过长的组名'.repeat(20)), null);
  assert.equal(safeGroupKey(' 2026q4 '), '2026q4', '前后空格可以去掉');
});
