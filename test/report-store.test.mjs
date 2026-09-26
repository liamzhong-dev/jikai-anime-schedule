/**
 * 季度报告的持久化测试。
 *
 * store 是带副作用的，所以这里只测两件事：
 *   1. 写进去的东西能不能原样读回来、脏数据能不能在读的那一刻修干净；
 *   2. **关掉重开会不会全没了** —— 后者是 `snapshot()` 漏字段造成的，
 *      界面上完全看不出来，只有重启才暴露，所以必须用「拦下落盘快照」钉住。
 *
 * 报告比 Tier List 更值得守这条：一份长图是排版出来的，丢了就是真丢了一晚上的活。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { platform } from '../src/platform/index.js';
import {
  ensureReport, flush, listReports, patchReport, patchTierlist, readReport, readTierlist,
  resetReport, setReportBlocks, update,
} from '../src/core/store.js';

/** 拦下落盘的快照，用来验 snapshot() 到底带了哪些字段 */
let captured = null;
platform.writeState = async (snap) => {
  captured = snap;
  return true;
};

function resetAll() {
  update((s) => ({ ...s, reports: {} }));
}

const HEADER = { id: 'b-1', type: 'header', title: '2026 夏季番', subtitle: '七月新番总结' };
const WALL = { id: 'b-2', type: 'wall', title: '本季一览', subjectIds: ['2', '3'], columns: 6 };

test('没做过的季度返回 null —— 「还没开始做」和「删空了」要能区分', () => {
  resetAll();
  assert.equal(readReport('2026q3'), null);
  assert.deepEqual(listReports(), []);
});

test('ensureReport 只造不落盘 —— 否则「只是看一眼」也会多出一个空季度', () => {
  resetAll();
  const made = ensureReport('2026q3');
  assert.deepEqual(made.blocks, []);
  assert.equal(made.width, 1220);
  assert.deepEqual(listReports(), [], 'ensure 不该产生副作用');

  // 连着看十次，也还是不该产生季度
  for (let i = 0; i < 10; i += 1) {
    ensureReport('2026q3');
    readReport('2026q3');
    listReports();
  }
  assert.deepEqual(listReports(), [], '只读入口调多少次都不能让状态变脏');
});

test('patchReport：增量改、updatedAt 会走、两个季度互不覆盖', () => {
  resetAll();
  const first = patchReport('2026q3', { blocks: [HEADER] }, { nowMs: 1000 });
  assert.equal(first.updatedAt, 1000);
  assert.equal(first.blocks.length, 1);

  const second = patchReport('2026q3', { blocks: [HEADER, WALL] }, { nowMs: 2000 });
  assert.equal(second.blocks.length, 2);
  assert.equal(second.updatedAt, 2000);

  patchReport('2026q4', { blocks: [{ id: 'b-1', type: 'text', body: '十月' }] }, { nowMs: 3000 });
  assert.deepEqual(listReports(), ['2026q3', '2026q4']);
  assert.equal(readReport('2026q3').blocks.length, 2, '写另一个季度不能动到这个季度');
  assert.equal(readReport('2026q4').blocks[0].body, '十月');
});

test('setReportBlocks：整份换块，宽度这类设置要留着', () => {
  resetAll();
  patchReport('2026q3', { blocks: [HEADER], width: 1400 });
  setReportBlocks('2026q3', [WALL]);

  const doc = readReport('2026q3');
  assert.deepEqual(doc.blocks.map((b) => b.id), ['b-2']);
  assert.equal(doc.width, 1400, '换块不该顺手把画布宽度也重置了');
});

test('resetReport：回到空画布', () => {
  resetAll();
  patchReport('2026q3', { blocks: [HEADER, WALL] }, { nowMs: 10 });
  const fresh = resetReport('2026q3', { nowMs: 5000 });
  assert.deepEqual(fresh.blocks, []);
  assert.deepEqual(readReport('2026q3').blocks, []);
  assert.equal(readReport('2026q3').updatedAt, 5000);
});

test('读回来时会修脏数据：坏块、重复 id、越界的宽度', () => {
  resetAll();
  // 直接塞一份「手改过」的坏数据，模拟旧版本或被写坏的状态文件
  update((s) => ({
    ...s,
    reports: {
      '2026q3': {
        width: 99999,
        blocks: [HEADER, { type: 'header' }, null, { id: 'b-1', type: 'text', body: '重复 id' }],
      },
    },
  }));

  const doc = readReport('2026q3');
  assert.deepEqual(doc.blocks.map((b) => b.id), ['b-1']);
  assert.equal(doc.blocks[0].title, '2026 夏季番', '重复 id 要留第一个');
  assert.equal(doc.width, 1600, '越界的宽度读的时候就要夹住，不能让界面去兜底');
});

test('报告不吃掉别的字段（跨字段隔离）', () => {
  resetAll();
  // 先在一个季度上排好 Tier List，再往同一个季度写报告
  update((s) => ({ ...s, reports: {} }));
  patchTierlist('2026q3', { items: [{ key: '1', rowId: 'r1' }] }, { nowMs: 1 });
  patchReport('2026q3', { blocks: [HEADER, WALL] });

  const tier = readTierlist('2026q3');
  assert.ok(tier, '写了报告之后 Tier List 不该消失');
  assert.deepEqual(tier.items, [{ key: '1', rowId: 'r1' }]);
  assert.equal(readReport('2026q3').blocks.length, 2);
});

test('snapshot 必须带上 reports —— 漏了就是「排了一晚上的长图，关掉重开全没了」', () => {
  resetAll();
  patchReport('2026q3', { blocks: [HEADER, WALL] });
  captured = null;
  flush();

  assert.equal(captured != null, true, 'flush 应当真的落一次盘');
  assert.equal('reports' in captured, true, '⚠️ snapshot() 漏了 reports 字段');
  assert.equal(captured.reports['2026q3'].blocks.length, 2);
  assert.deepEqual(Object.keys(captured.reports), ['2026q3']);
});
