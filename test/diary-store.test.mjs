/**
 * 补番日记的持久化测试（阶段 B）。
 *
 * 只测一件事：**写进去的能不能原样读回来**，以及「关掉重开会不会全没了」。
 * 后者是 `snapshot()` 漏字段造成的 —— 界面上完全看不出来，只有重启才暴露，
 * 所以必须在这里拦下落盘的快照钉住。
 *
 * 另外钉住两类容易写错的行为：
 *   · 只读入口不许有副作用（界面每帧都调，「看一眼」不该改 state）
 *   · 脏数据（手改过、旧版本写的）在读的那一刻就被修掉
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { platform } from '../src/platform/index.js';
import {
  addDiaryEntry, flush, listDiaryIds, load, myRatingOf, readDiary, readDiaryOf,
  readLatestDiary, readLatestRated, removeDiaryEntry, update,
} from '../src/core/store.js';

let captured = null;
platform.writeState = async (snap) => {
  captured = snap;
  return true;
};

function resetAll() {
  update((s) => ({ ...s, diary: {} }));
}

test('snapshot() 必须带上 diary —— 漏了就是「日记写得再认真也白写」', async () => {
  resetAll();
  addDiaryEntry(1001, { rating: 8, note: '开头闷、后面起飞' });
  await flush();

  assert.ok(captured, '拦到写出去的快照了吗');
  assert.ok('diary' in captured, 'snapshot() 漏了 diary 字段');
  assert.equal(captured.diary['1001'].entries.length, 1);
  assert.equal(captured.diary['1001'].entries[0].rating, 8);
  assert.equal(captured.diary['1001'].entries[0].note, '开头闷、后面起飞');
});

test('追加两条都留着，不是覆盖', () => {
  resetAll();
  addDiaryEntry(1001, { rating: 6, at: 1000 });
  addDiaryEntry(1001, { rating: 9, note: '重看一遍改主意了', at: 2000 });

  assert.equal(readDiaryOf(1001).length, 2);
  assert.equal(myRatingOf(1001), 9, '我的评分取最新，不是平均');
  assert.equal(readLatestDiary(1001).note, '重看一遍改主意了');
  assert.equal(readLatestRated(1001).rating, 9);
});

test('只写短评不打分，不该把已有评分顶掉', () => {
  resetAll();
  addDiaryEntry(1001, { rating: 7, at: 1000 });
  addDiaryEntry(1001, { note: '忘了写为什么', at: 2000 });

  assert.equal(myRatingOf(1001), 7, '只写短评那次没有评分，不该让评分变成空');
  assert.equal(readLatestDiary(1001).note, '忘了写为什么');
});

test('空内容返回 ok:false 并给出理由 —— 静默丢弃用户刚写的字最不能接受', () => {
  resetAll();
  const empty = addDiaryEntry(1001, { rating: null, note: '   ' });
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /没有东西可以记/);
  assert.equal(readDiaryOf(1001).length, 0, '失败时不该留下任何痕迹');

  const badId = addDiaryEntry(0, { rating: 8 });
  assert.equal(badId.ok, false);
  assert.match(badId.reason, /id/);
});

test('不同作品互不干扰', () => {
  resetAll();
  addDiaryEntry(1001, { rating: 8 });
  addDiaryEntry(1002, { rating: 3 });
  assert.equal(myRatingOf(1001), 8);
  assert.equal(myRatingOf(1002), 3);
  assert.deepEqual(listDiaryIds().sort(), ['1001', '1002']);
});

test('删一条：删不到返回 false，删空之后不留空壳', () => {
  resetAll();
  addDiaryEntry(1001, { rating: 8, at: 1000 });
  addDiaryEntry(1001, { rating: 9, at: 2000 });

  assert.equal(removeDiaryEntry(1001, 9999), false, '删不到要返回 false，不能假装成功');
  assert.equal(readDiaryOf(1001).length, 2);

  assert.equal(removeDiaryEntry(1001, 1000), true);
  assert.equal(readDiaryOf(1001).length, 1);

  assert.equal(removeDiaryEntry(1001, 2000), true);
  assert.deepEqual(listDiaryIds(), [], '删空之后不能留一个空壳键，否则统计里会多出一部');
});

test('只读入口没有副作用：连着调十次，state 一点不变', () => {
  resetAll();
  addDiaryEntry(1001, { rating: 8 });

  const before = JSON.stringify(readDiary());
  for (let i = 0; i < 10; i += 1) {
    myRatingOf(1001);
    myRatingOf(9999);      // 不存在的那部
    readDiaryOf(9999);
    readLatestDiary(9999);
    readLatestRated(9999);
  }
  assert.equal(JSON.stringify(readDiary()), before, '「只是看一眼」不该改 state');
  assert.equal(myRatingOf(9999), null);
});

test('脏数据在读盘那一刻被修掉（旧版本写的、手改过的）', async () => {
  /**
   * ⚠️ 必须走真正的读盘入口 `load()`，不能直接 `update()` 塞 state。
   *
   * 修脏数据的地方是 `load()` 里那句 `normalizeDiary(saved?.diary)`；
   * 直接改 state 等于绕过了它，测出来的是「脏数据原样躺着」——
   * 那不是 bug，是测试测错了路径。第一版就是这么写错的。
   */
  platform.readState = async () => ({
    diary: {
      1001: {
        entries: [
          { at: 2000, rating: 99, note: '' },       // 评分越界 → 丢
          { at: 1000, rating: '8', note: ' ok ' },  // 字符串数字要收，空白要折叠
          { at: 'x', rating: 5, note: '没有时间' },  // 没有合法 at → 丢
          { at: 3000, rating: null, note: '' },      // 全空 → 丢
        ],
      },
      1002: { entries: [] },                        // 空作品 → 整个丢掉
      '   ': { entries: [{ at: 1, rating: 5 }] },   // 空键 → 丢
      1003: 'not-an-object',                        // 形状完全不对 → 丢
    },
  });

  await load();

  const d = readDiary();
  assert.deepEqual(Object.keys(d), ['1001'], '只剩 1001 一条有有效记录的');
  assert.deepEqual(readDiaryOf(1001), [{ at: 1000, rating: 8, note: 'ok' }], '越界/无时间/全空的记录都该被丢掉');
  assert.equal(myRatingOf(1001), 8);
  // 记录被打乱顺序时也要按时间排回来，否则「最近一条」会取错
  assert.equal(readLatestDiary(1001).at, 1000);
});
