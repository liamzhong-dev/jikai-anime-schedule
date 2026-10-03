/**
 * 季度归档与本地归档存储。
 *
 * 这一组断言守的是「哪些番该出现在哪一季」—— 判错了不会报错，
 * 只会让某些番在界面上整片消失，所以每条都要能在被破坏时变红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { seasonOf, seasonSpan, seasonsOfAnime } from '../src/core/time.js';
import {
  archiveKeys,
  archiveSeason,
  groupByAirSeason,
  mergeArchive,
  mergeItems,
} from '../src/data/archive.js';

/** 日本时间某一天的中午，避开「UTC 减 9 小时后跨到前一天」的干扰 */
const jst = (date) => Date.parse(`${date}T06:00:00.000Z`);

const item = (id, begin, eps, platform = 'TV') => ({
  id,
  titleZh: `番${id}`,
  begin,
  broadcast: `R/${begin}/P7D`,
  eps,
  platform,
});

/* ---------- 季度边界：按半月切，不是按整月 ---------- */

test('季度边界按半月：每一季的开头是上一季末月的下半', () => {
  // 冬番：上年 12 月下半 到 当年 3 月上半
  assert.equal(seasonOf(jst('2025-12-20')), '2026q1');
  assert.equal(seasonOf(jst('2026-03-15')), '2026q1');
  // 春番：3 月下半 到 6 月上半
  assert.equal(seasonOf(jst('2026-03-20')), '2026q2');
  assert.equal(seasonOf(jst('2026-06-15')), '2026q2');
  // 夏番：6 月下半 到 9 月上半
  assert.equal(seasonOf(jst('2026-06-20')), '2026q3');
  assert.equal(seasonOf(jst('2026-09-15')), '2026q3');
  // 秋番：9 月下半 到 12 月上半
  assert.equal(seasonOf(jst('2026-09-20')), '2026q4');
  assert.equal(seasonOf(jst('2026-12-15')), '2026q4');
});

/*
 * 反向：这条要能真的失败。
 * 按整月切（Math.ceil(month/3)）时，12 月 20 日会被算成 2025q4、3 月 20 日算成 2026q1，
 * 与上面全部相反 —— 同一批番在两种口径下落进不同的季，过季就整片消失。
 */
test('季度边界：12 月下半必须是明年冬番，不是当年秋番', () => {
  const key = seasonOf(jst('2026-12-20'));
  assert.equal(key, '2027q1');
  assert.notEqual(key, '2026q4', '12 月下半不能再算进当年秋番');
});

/* ---------- 半年番跨季 ---------- */

test('seasonSpan：一季番 1 季、半年番 2 季、年番 4 季', () => {
  assert.equal(seasonSpan(12), 1);
  assert.equal(seasonSpan(13), 1);
  assert.equal(seasonSpan(14), 1, '14 话还是一季番，别按 13 话一份去进');
  assert.equal(seasonSpan(24), 2);
  assert.equal(seasonSpan(26), 2);
  assert.equal(seasonSpan(48), 4);
});

test('seasonSpan：话数未知按一季算，不许扩', () => {
  for (const bad of [null, undefined, 0, -3, NaN]) {
    assert.equal(seasonSpan(bad), 1, `${String(bad)} 不该被当成半年番`);
  }
});

test('seasonsOfAnime：半年番同时归入起始季与后续季', () => {
  // 7 月开播、24 话 —— 播到 12 月，所以夏番和秋番两页都要有它
  assert.deepEqual(seasonsOfAnime(item(1, '2026-07-01T12:00:00.000Z', 24)), ['2026q3', '2026q4']);
  // 4 月开播、24 话 —— 春番和夏番
  assert.deepEqual(seasonsOfAnime(item(2, '2026-04-01T12:00:00.000Z', 24)), ['2026q2', '2026q3']);
});

test('seasonsOfAnime：一季番只归开播那一季，不往后溢', () => {
  assert.deepEqual(seasonsOfAnime(item(3, '2026-01-05T12:00:00.000Z', 12)), ['2026q1']);
  // 反向：1 月番播满 12 话会落到 3 月下半，但不能因此被算成 4 月番
  assert.equal(seasonsOfAnime(item(3, '2026-01-05T12:00:00.000Z', 12)).includes('2026q2'), false);
});

test('seasonsOfAnime：跨年要进位（2026q4 之后是 2027q1）', () => {
  assert.deepEqual(seasonsOfAnime(item(4, '2026-10-01T12:00:00.000Z', 24)), ['2026q4', '2027q1']);
});

test('seasonsOfAnime：没有首播时间的一律不归档，而不是硬塞进当季', () => {
  assert.deepEqual(seasonsOfAnime({ id: 5, eps: 12 }), []);
  assert.deepEqual(seasonsOfAnime({}), []);
});

/* ---------- 按开播月份分组 ---------- */

test('groupByAirSeason：半年番同时落进两个桶', () => {
  const g = groupByAirSeason([item(1, '2026-07-01T12:00:00.000Z', 24)]);
  assert.deepEqual(Object.keys(g).sort(), ['2026q3', '2026q4']);
  assert.equal(g['2026q3'].length, 1);
  assert.equal(g['2026q4'].length, 1, '半年番要能在秋番那一页里也排到');
});

test('groupByAirSeason：网络放送番一样计入，不单列也不漏', () => {
  const g = groupByAirSeason([item(9, '2026-10-06T12:00:00.000Z', 12, 'WEB')]);
  assert.deepEqual(Object.keys(g), ['2026q4'], 'WEB 番就是当季新番，别漏掉');
});

test('groupByAirSeason：没写 begin 的退回数据自带的 season 字段', () => {
  const g = groupByAirSeason([{ id: 7, season: '2026q2' }]);
  assert.deepEqual(Object.keys(g), ['2026q2'], '整批被静默丢掉的话，同步等于白做');
});

test('groupByAirSeason：没有 id 的条目不进归档（没法去重也没法取封面）', () => {
  assert.deepEqual(groupByAirSeason([{ titleZh: '没 id', begin: '2026-10-01T12:00:00.000Z' }]), {});
});

/* ---------- 合并 ---------- */

test('mergeItems：同 id 只留一份，且是字段更全的那份', () => {
  const thin = { id: 1, titleZh: '薄', eps: 12 };
  const rich = { id: 1, titleZh: '厚', eps: 12, summary: '简介', score: 7.5, cover: 'x' };
  // 反向：无条件用新的覆盖，会把已经补好的简介冲掉
  assert.equal(mergeItems([rich], [thin])[0].summary, '简介', '补全过的那份不能被冲掉');
  assert.equal(mergeItems([thin], [rich])[0].summary, '简介', '新的更全时当然用新的');
  assert.equal(mergeItems([thin], [rich]).length, 1);
});

test('mergeArchive：多次导入会累积，不同季度各归各的', () => {
  let arch = null;
  arch = mergeArchive(arch, [item(1, '2026-07-01T12:00:00.000Z', 12)], { nowMs: 1000 });
  arch = mergeArchive(arch, [item(2, '2026-10-01T12:00:00.000Z', 12)], { nowMs: 2000 });
  assert.deepEqual(archiveKeys(arch), ['2026q4', '2026q3']);
  assert.equal(archiveSeason(arch, '2026q3').length, 1);
  assert.equal(archiveSeason(arch, '2026q4').length, 1);
  assert.equal(archiveSeason(arch, '2026q1').length, 0);
});

test('mergeArchive：重复导入同一批不会翻倍', () => {
  const batch = [item(1, '2026-10-01T12:00:00.000Z', 12), item(2, '2026-10-01T12:00:00.000Z', 24)];
  let arch = mergeArchive(null, batch, { nowMs: 1 });
  arch = mergeArchive(arch, batch, { nowMs: 2 });
  assert.equal(archiveSeason(arch, '2026q4').length, 2, '导两次不该变成 4 部');
});
