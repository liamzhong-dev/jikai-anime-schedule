/**
 * Tier List 的持久化测试（阶段 C）。
 *
 * store 是带副作用的，所以这里只测一件事：**写进去的东西能不能原样读回来**，
 * 以及「关掉重开会不会全没了」——
 * 后者是 `snapshot()` 漏字段造成的，界面上完全看不出来，只有重启才暴露，
 * 所以必须在这儿用「拦下落盘的快照」钉住。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { platform } from '../src/platform/index.js';
import {
  ensureTierlist, flush, listTierlists, patchTierlist, readTierlist, resetTierlist, update,
} from '../src/core/store.js';

/** 拦下落盘的快照，用来验 snapshot() 到底带了哪些字段 */
let captured = null;
platform.writeState = async (snap) => {
  captured = snap;
  return true;
};

function resetAll() {
  update((s) => ({ ...s, tierlists: {} }));
}

const ITEMS = [
  { key: '1001', rowId: 'r1' },
  { key: '1002', rowId: 'r2' },
];

test('没排过的季度返回 null —— 「没开始排」和「排了又拖空」要能区分', () => {
  resetAll();
  assert.equal(readTierlist('2026q3'), null);
  assert.deepEqual(listTierlists(), []);
});

test('ensureTierlist 只造不落盘，patchTierlist 才真的写进去', () => {
  resetAll();
  const made = ensureTierlist('2026q3');
  assert.equal(made.rows.length, 7);
  assert.deepEqual(made.items, []);
  assert.deepEqual(listTierlists(), [], 'ensure 不该产生副作用 —— 否则「只是看一眼」也会多出一个空季度');

  patchTierlist('2026q3', { items: ITEMS });
  assert.deepEqual(listTierlists(), ['2026q3']);
  assert.deepEqual(readTierlist('2026q3').items, ITEMS);
});

test('patchTierlist：增量改、updatedAt 会走、两个季度互不覆盖', () => {
  resetAll();
  const first = patchTierlist('2026q3', { items: ITEMS }, { nowMs: 1000 });
  assert.equal(first.updatedAt, 1000);
  assert.equal(first.rows.length, 7);

  const second = patchTierlist('2026q3', { itemSize: 'character' }, { nowMs: 2000 });
  assert.equal(second.itemSize, 'character', 'patch 是增量，之前排好的图块要还在');
  assert.deepEqual(second.items, ITEMS);
  assert.equal(second.updatedAt, 2000);

  patchTierlist('2026q4', { items: [{ key: '2001', rowId: 'r1' }] }, { nowMs: 3000 });
  assert.deepEqual(listTierlists(), ['2026q3', '2026q4']);
  assert.deepEqual(readTierlist('2026q3').items, ITEMS, '写另一个季度不能动到这个季度');
  assert.deepEqual(readTierlist('2026q4').items, [{ key: '2001', rowId: 'r1' }]);
});

test('resetTierlist：清掉图块但留着档位定义', () => {
  resetAll();
  patchTierlist('2026q3', { items: ITEMS, presetId: 'masterpiece' });
  const fresh = resetTierlist('2026q3', { nowMs: 5000 });

  assert.deepEqual(fresh.items, []);
  assert.equal(fresh.rows.length, 7);
  assert.deepEqual(readTierlist('2026q3').items, []);
  assert.equal(readTierlist('2026q3').updatedAt, 5000);
});

test('读回来时会修脏数据：悬空的档位、重复的 key', () => {
  resetAll();
  // 直接用 update 塞一份「手改过」的坏数据进去，模拟旧版本或被写坏的状态文件
  update((s) => ({
    ...s,
    tierlists: {
      '2026q3': {
        rows: [{ id: 'r1', label: 'TOP', color: '#ff7f7f' }],
        items: [
          { key: '1', rowId: 'r1' },
          { key: '1', rowId: 'r1' },
          { key: '2', rowId: '不存在的档' },
        ],
      },
    },
  }));

  const out = readTierlist('2026q3');
  assert.deepEqual(out.items.map((it) => it.key), ['1'], '读的那一刻就该修好，不能让界面层去兜底');
});

test('snapshot 必须带上 tierlists —— 漏了就是「关掉重开全没了」', () => {
  resetAll();
  patchTierlist('2026q3', { items: ITEMS });
  captured = null;
  flush();

  assert.equal(captured != null, true, 'flush 应当真的落一次盘');
  assert.equal('tierlists' in captured, true, '⚠️ snapshot() 漏了 tierlists 字段');
  assert.deepEqual(captured.tierlists['2026q3'].items, ITEMS);
  assert.deepEqual(Object.keys(captured.tierlists), ['2026q3']);
});

test('落盘的那一版也要是干净的（脏数据不能只修在内存里）', () => {
  resetAll();
  update((s) => ({
    ...s,
    tierlists: { '2026q3': { rows: [{ id: 'r1', label: 'TOP' }], items: [{ key: '9', rowId: 'r9' }] } },
  }));
  patchTierlist('2026q3', { items: [{ key: '1', rowId: 'r1' }] }, { nowMs: 9000 });
  captured = null;
  flush();

  assert.deepEqual(captured.tierlists['2026q3'].items, [{ key: '1', rowId: 'r1' }], 'r9 那条不该被写进磁盘');
});
