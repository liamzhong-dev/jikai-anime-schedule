/**
 * 追番历程的持久化测试。
 *
 * 只测一件事：**时间戳有没有真的写进 following、有没有真的落到磁盘上**。
 *
 * 为什么值得单独一个文件：时间戳是「追番历程」的全部数据来源，而它是在
 * 用户点星标、点 +1 的时候顺手记的 —— 漏记不会报错、不会白屏，
 * 只会让历程页在几天后看起来「怎么什么都没有」。等到那时候才发现，
 * 那几天的时间已经补不回来了。
 *
 * ⚠️ 时间戳一旦断了就是永久损失（过去的日期补不回来），所以这里
 * 连「起点与最后动作是同一时刻」这种细节都要钉住。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { platform } from '../src/platform/index.js';
import {
  flush, getState, markEpisode, setWatched, toggleFollow, unfollow, update,
} from '../src/core/store.js';

let captured = null;
platform.writeState = async (snap) => {
  captured = snap;
  return true;
};

function resetAll() {
  update((s) => ({ ...s, following: {} }));
}

test('toggleFollow 落下 followedAt / lastAt —— 这是历程的全部数据来源', () => {
  resetAll();
  toggleFollow(1001, { followedAt: 1000, lastAt: 1000 });

  const f = getState().following[1001];
  assert.equal(f.followedAt, 1000);
  assert.equal(f.lastAt, 1000);
  assert.equal(f.status, 'watching', '原有的默认字段不能丢');
  assert.equal(f.watchedEps, 0);
});

test('不传时间就用当下，且起点与最后动作必须是同一个时刻', () => {
  resetAll();
  const before = Date.now();
  toggleFollow(1002);
  const after = Date.now();

  const f = getState().following[1002];
  assert.ok(f.followedAt >= before && f.followedAt <= after, '要落在调用的这一瞬间');
  // 这条盯的是「两次 Date.now()」：分开取会差几毫秒，于是「当天加入、当天看完」
  // 在历程里会算成 0.0001 天而不是 0 天。
  assert.equal(f.followedAt, f.lastAt);
});

test('markEpisode 刷新 lastAt，但 followedAt 不许动', () => {
  resetAll();
  toggleFollow(1001, { followedAt: 1000, lastAt: 1000 });
  markEpisode(1001, 12, { nowMs: 5000 });

  const f = getState().following[1001];
  assert.equal(f.followedAt, 1000, '起点被改写的话，整条历程的起点就漂了');
  assert.equal(f.lastAt, 5000, '最后动作要跟上');
  assert.equal(f.watchedEps, 12);
});

test('setWatched 同样刷 lastAt', () => {
  resetAll();
  toggleFollow(1001, { followedAt: 1000, lastAt: 1000 });
  setWatched(1001, 3, { nowMs: 2000 });

  const f = getState().following[1001];
  assert.equal(f.lastAt, 2000);
  assert.equal(f.watchedEps, 3);
  assert.equal(f.followedAt, 1000);
});

test('对没追过的番直接记进度：补一个起点，而不是留一条没有起点的记录', () => {
  resetAll();
  markEpisode(1003, 2, { nowMs: 7000 });

  const f = getState().following[1003];
  assert.equal(f.watchedEps, 2);
  assert.equal(f.followedAt, 7000, '没有起点这条记录就排不进时间线，等于白记');
  assert.equal(f.lastAt, 7000);
});

test('snapshot() 必须带上 following —— 漏了就是「追了多少天，关掉重开全忘了」', async () => {
  resetAll();
  toggleFollow(1001, { followedAt: 1000, lastAt: 1000 });
  markEpisode(1001, 12, { nowMs: 5000 });
  await flush();

  assert.ok(captured, '拦到写出去的快照了吗');
  assert.ok('following' in captured, 'snapshot() 漏了 following');
  assert.equal(captured.following['1001'].followedAt, 1000, '时间戳没落盘，等于没记');
  assert.equal(captured.following['1001'].lastAt, 5000);
});

test('移出追番后记录整个消失 —— ⚠️ 这是已知取舍，不是 bug', () => {
  /**
   * 追完就点「移出」的人，会在历程里丢掉这一部（连「开始追」「看完了」两个点
   * 一起没）。要做成「移出后仍保留历史」得给 following 之外单开一份快照，
   * 而那会让 `counts.following`、`followingRows` 这些地方的语义全变 ——
   * 这一版**故意不做**。所以把它写成一条断言固定下来：
   * 哪天行为变了，是有人动了这块，得重新想清楚，而不是「顺手修好了」。
   */
  resetAll();
  toggleFollow(1001, { followedAt: 1000, lastAt: 1000 });
  unfollow(1001);
  assert.equal(getState().following[1001], undefined);
});
