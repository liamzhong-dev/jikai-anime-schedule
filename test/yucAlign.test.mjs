/**
 * 番堂校准季度归属。
 *
 * 这一组守的是「一部番到底算哪一季」。判错了不报错，只在界面上表现为
 * 「这部番在它正在播的那一季里找不到」，所以每条都得能在被破坏时变红。
 *
 * 反面例子就是「上伊那牡丹」：正片 12 集，而 Bangumi 的章节总数是 25
 * （OP / ED / 预告那些单集也算进去）。按话数反推档期，它被当成半年番，
 * 白白多归出一个季度。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { alignSeasonsWithYuc, parseYucEpisodes, seasonsWithHint } from '../src/data/yucAlign.js';
import { groupByAirSeason } from '../src/data/archive.js';

const jst = (date) => Date.parse(`${date}T06:00:00.000Z`);
const iso = (date) => new Date(jst(date)).toISOString();

const anime = (id, titleZh, begin, eps) => ({
  id,
  titleZh,
  begin: iso(begin),
  broadcast: `R/${iso(begin)}/P7D`,
  eps,
  platform: 'TV',
});

/** 造一份番堂缓存：每季一组，组里有若干条目 */
const yucCache = (map) =>
  Object.fromEntries(
    Object.entries(map).map(([season, titles]) => [
      season,
      {
        schema: 1,
        savedAt: Date.now(),
        seasonName: season,
        groups: [
          {
            key: 'mon',
            label: '周一',
            items: titles.map((t, i) => ({
              id: `y${season}${i}`,
              titleZh: typeof t === 'string' ? t : t.title,
              titleJa: '',
              episodes: typeof t === 'string' ? '' : (t.episodes ?? ''),
              cover: null,
            })),
          },
        ],
      },
    ]),
  );

/* ---------- 番堂写的话数 ---------- */

test('番堂的话数：全12话 / 12 / 12话+ 都能读出数字', () => {
  assert.equal(parseYucEpisodes('全12话'), 12);
  assert.equal(parseYucEpisodes('12'), 12);
  assert.equal(parseYucEpisodes('12话+'), 12);
  assert.equal(parseYucEpisodes(''), null);
  assert.equal(parseYucEpisodes(null), null);
});

/* ---------- 对表 ---------- */

test('对表：番堂哪一季有这部，它就归那些季', () => {
  const items = [anime(1, '上伊那牡丹，酒醉身姿似百合花般', '2026-04-10', 25)];
  const cache = yucCache({ '2026q2': [{ title: '上伊那牡丹，酒醉身姿似百合花般', episodes: '全12话' }] });
  const align = alignSeasonsWithYuc(items, cache);
  const rec = align.get('1');
  assert.ok(rec, '应当认出这条');
  assert.deepEqual(rec.seasons, ['2026q2']);
  assert.equal(rec.episodes, 12);
});

test('对表：番堂两季都列了，就是跨两季', () => {
  const items = [anime(2, '某部半年番', '2026-07-03', 24)];
  const cache = yucCache({
    '2026q3': [{ title: '某部半年番', episodes: '全24话' }],
    '2026q4': [{ title: '某部半年番', episodes: '全24话' }],
  });
  const rec = alignSeasonsWithYuc(items, cache).get('2');
  assert.deepEqual(rec?.seasons, ['2026q3', '2026q4']);
});

/* ---------- 校准档期 ---------- */

test('校准：12 集的番被记成 25 集时，不再被当成半年番', () => {
  // 话数 25 → 老口径会归两季；番堂只在这一季列过它，所以只归一季
  const a = anime(1, '上伊那牡丹', '2026-04-10', 25);
  const hint = { seasons: ['2026q2'], episodes: 12 };
  assert.deepEqual(seasonsWithHint(a, hint), ['2026q2']);
});

test('校准：番堂确实列了两个季，才归两季', () => {
  const a = anime(2, '半年番', '2026-07-03', 24);
  assert.deepEqual(seasonsWithHint(a, { seasons: ['2026q3', '2026q4'] }), ['2026q3', '2026q4']);
});

test('校准：番堂只抓到后面那一季时，从开播季补齐到那一季', () => {
  // 4 月开播、番堂缓存里只剩 10 月那一季 —— 不能因此只归秋番，
  // 春番那一页反而没它了
  const a = anime(3, '长跑番', '2026-04-04', 24);
  assert.deepEqual(seasonsWithHint(a, { seasons: ['2026q4'] }), ['2026q2', '2026q3', '2026q4']);
});

test('校准：最多四节，别把常年番铺满整年之后还往外溢', () => {
  const a = anime(4, '常年番', '2025-01-04', 1000);
  assert.deepEqual(seasonsWithHint(a, { seasons: ['2027q4'] }), ['2025q1', '2025q2', '2025q3', '2025q4']);
});

/*
 * 反向：番堂那几季全在开播之前，多半是同名重播或者误匹配 ——
 * 这时候必须退回开播时间，不然一部老番会被硬塞进它还没开播的季度里。
 */
test('校准：番堂的季早于开播季时听开播时间的', () => {
  const a = anime(5, '重播番', '2026-10-05', 12);
  assert.deepEqual(seasonsWithHint(a, { seasons: ['2026q2'] }), ['2026q4']);
});

test('校准：没有番堂结论时行为跟以前一致', () => {
  const a = anime(6, '没抓过的番', '2026-07-03', 24);
  assert.deepEqual(seasonsWithHint(a, null), ['2026q3', '2026q4']);
  assert.deepEqual(seasonsWithHint(a, { seasons: [] }), ['2026q3', '2026q4']);
});

/* ---------- 落到归档 ---------- */

test('归档接上校准：话数掺了水的那部不再多占一个季度', () => {
  const items = [
    // 正片 12 集，被记成 25 集 —— 原本会同时出现在两季里
    anime(1, '上伊那牡丹，酒醉身姿似百合花般', '2026-04-10', 25),
    // 真·半年番，番堂两季都列了
    anime(2, '真正的半年番', '2026-04-03', 24),
  ];
  const cache = yucCache({
    '2026q2': [
      { title: '上伊那牡丹，酒醉身姿似百合花般', episodes: '全12话' },
      { title: '真正的半年番', episodes: '全24话' },
    ],
    '2026q3': [{ title: '真正的半年番', episodes: '全24话' }],
  });
  const align = alignSeasonsWithYuc(items, cache);
  const grouped = groupByAirSeason(items, { align });

  assert.equal((grouped['2026q2'] ?? []).length, 2);
  // 关键：掺了水那一部不该出现在夏番里
  assert.equal(
    (grouped['2026q3'] ?? []).filter((x) => x.id === 1).length,
    0,
    '12 集的番不该因为章节数被记成 25 就跨到夏番',
  );
  assert.equal((grouped['2026q3'] ?? []).filter((x) => x.id === 2).length, 1, '真半年番仍然要跨季');
});
