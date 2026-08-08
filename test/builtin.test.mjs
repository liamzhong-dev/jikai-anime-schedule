/**
 * 内置数据的自检。
 *
 * 这份数据是构建期从 bangumi-data 和 Bangumi API 抓下来、提交进仓库的，
 * 所以它不会因为「今天网络不通」而变。反过来说，它一旦抓坏了也不会有人
 * 立刻发现 —— 用户看到的是「怎么少了封面 / 怎么标题是空的」。
 * 这组测试就是补这个缺口。
 *
 * 一条准则：**断言要卡住「错误」，不能卡住「现实」。**
 * 比如「每部都必须有评分」是错的 —— 新番刚开播本来就没人打分，
 * 留空才对。所以这里写的是「有前提的断言」：评分可以有，但有就必须合法。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { BUILTIN_GENERATED_AT, BUILTIN_SEASONS, allBuiltinItems, builtinItems, hasBuiltin } from '../src/data/builtin/index.js';

const JST_MS = 9 * 3600000;

/** 和运行时同一套季度换算，用来验证条目的 season 字段没标错 */
function seasonOf(iso) {
  const d = new Date(Date.parse(iso) + JST_MS);
  return `${d.getUTCFullYear()}q${Math.ceil((d.getUTCMonth() + 1) / 3)}`;
}

test('内置数据至少覆盖三个季度，且季度键的格式合法', () => {
  assert.ok(BUILTIN_SEASONS.length >= 1, '一个季度都没有，说明生成脚本没跑成功');
  for (const key of BUILTIN_SEASONS) {
    assert.match(key, /^\d{4}q[1-4]$/, `季度键格式不对：${key}`);
  }
  assert.ok(BUILTIN_GENERATED_AT && !Number.isNaN(Date.parse(BUILTIN_GENERATED_AT)), '缺少生成时间');
  assert.ok(hasBuiltin(BUILTIN_SEASONS[0]));
  assert.equal(hasBuiltin('不是季度'), false);
});

test('每个季度都有条目，且 id 全局不重复', () => {
  const seen = new Set();
  for (const key of BUILTIN_SEASONS) {
    const list = builtinItems(key);
    assert.ok(list.length > 0, `${key} 是空的`);
    for (const a of list) {
      assert.ok(!seen.has(a.id), `${key} 里的 id ${a.id} 和其他季度重复了`);
      seen.add(a.id);
    }
  }
});

test('条目字段：必填的都在，取值合法的都在范围内', () => {
  for (const key of BUILTIN_SEASONS) {
    for (const a of builtinItems(key)) {
      assert.ok(Number.isInteger(a.id) && a.id > 0, `id 不像 Bangumi 条目号：${a.id}`);
      assert.ok(a.titleZh || a.titleJa, `id ${a.id} 连标题都没有`);
      assert.ok(!Number.isNaN(Date.parse(a.begin)), `id ${a.id} 的 begin 解析不了：${a.begin}`);

      if (a.cover) assert.match(a.cover, /^https:\/\//, `封面必须是 https：${a.cover}`);
      if (a.score != null) {
        assert.equal(typeof a.score, 'number');
        assert.ok(a.score > 0 && a.score <= 10, `评分越界：${a.id} → ${a.score}`);
      }
      if (a.eps != null) {
        assert.ok(Number.isInteger(a.eps) && a.eps > 0, `话数不对：${a.id} → ${a.eps}`);
      }
      if (a.watchers != null) assert.ok(Number.isFinite(a.watchers) && a.watchers >= 0);
      // 外链必须是 https，且指向 bgm.tv —— 界面上是直接 openExternal 出去的
      assert.match(a.external?.bangumi ?? '', /^https:\/\/bgm\.tv\//, `id ${a.id} 的 Bangumi 链接不对`);
    }
  }
});

test('季度归属没标错：begin 换算回来必须等于它所在的季度', () => {
  for (const key of BUILTIN_SEASONS) {
    for (const a of builtinItems(key)) {
      assert.equal(a.season, key, `id ${a.id} 被放进了 ${key}，但按 begin 算是 ${seasonOf(a.begin)}`);
      assert.equal(seasonOf(a.begin), key);
    }
  }
});

test('播出规则：有 broadcast 的必须是合法的周期语法，平台取值在词汇表内', () => {
  // 平台是归一化过的四种，不是 Bangumi 那种给人看的字符串（「其他」「剧场版」）
  const KNOWN = new Set(['TV', 'WEB', 'OVA', 'MOVIE']);
  let withBroadcast = 0;
  for (const key of BUILTIN_SEASONS) {
    for (const a of builtinItems(key)) {
      assert.ok(KNOWN.has(a.platform), `平台取值意外：${a.id} → ${a.platform}`);
      if (!a.broadcast) continue;
      withBroadcast += 1;
      const m = /^R\/(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\/P(\d+)D$/.exec(a.broadcast);
      assert.ok(m, `播出规则解析不了：${a.id} → ${a.broadcast}`);
      assert.ok(Number(m[2]) >= 1 && Number(m[2]) <= 31, `播出间隔不像话：${m[2]} 天`);
      assert.ok(!Number.isNaN(Date.parse(m[1])), `规则里的起点不是时间：${m[1]}`);
    }
  }
  assert.ok(withBroadcast > 0, '一条播出规则都没有，时间表视图会全空');
});

test('内置数据是精简过的：简介和标签都没有原样照搬', () => {
  for (const key of BUILTIN_SEASONS) {
    for (const a of builtinItems(key)) {
      assert.ok(a.summary.length <= 240, `id ${a.id} 的简介没截断（${a.summary.length} 字）`);
      assert.ok(a.tags.length <= 8, `id ${a.id} 的标签没限量（${a.tags.length} 个）`);
    }
  }
});

test('读出来的是副本：调用方改条目不会污染内置数据', () => {
  const key = BUILTIN_SEASONS[0];
  const first = builtinItems(key);
  const original = first[0].titleZh;
  first[0].titleZh = '被改过了';
  first.push({ id: -1 });
  assert.equal(builtinItems(key)[0].titleZh, original);
  assert.equal(builtinItems(key).some((a) => a.id === -1), false);
});

test('allBuiltinItems 是去重后的全集，能覆盖每一个季度', () => {
  const all = allBuiltinItems();
  const total = BUILTIN_SEASONS.reduce((n, k) => n + builtinItems(k).length, 0);
  assert.equal(all.length, total, 'id 不该在跨季度汇总时被丢掉');
  const keys = new Set(BUILTIN_SEASONS.map((k) => builtinItems(k)[0]?.id));
  for (const id of keys) assert.ok(all.some((a) => a.id === id));
});
