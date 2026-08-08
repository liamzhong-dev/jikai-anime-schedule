/**
 * electron/updater.cjs 的输入校验测试。
 *
 * 这个文件本身要 require('electron')（经 net.cjs），所以不能在 Node 里跑
 * 真实请求；但「地址为空 / 协议不对」这两条分支在读网络之前就返回了，
 * 而那恰恰是最容易写错、也最不该出错的地方 —— 用户手填的输入都从这里过。
 *
 * 之所以单独测它：这是二期补上自动更新链路时新加的一层。链路断裂那次
 * 就是因为「每层单独看都像完成了」，所以每一层都要有一个能失败的断言。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { checkUpdate } = require('../electron/updater.cjs');

test('updater.checkUpdate 没配地址时直接拒绝，不去发请求', async () => {
  for (const bad of ['', '   ', null, undefined]) {
    const r = await checkUpdate({ manifestUrl: bad });
    assert.equal(r.ok, false);
    assert.match(r.error, /没有配置更新源地址/);
    assert.equal(r.status, 0);
  }
});

test('updater.checkUpdate 拒绝非 http(s) 地址', async () => {
  for (const bad of ['ftp://a/b.json', 'file:///c:/x.json', 'javascript:alert(1)']) {
    const r = await checkUpdate({ manifestUrl: bad });
    assert.equal(r.ok, false);
    assert.match(r.error, /http:\/\/ 或 https:\/\//);
  }
});

test('updater.checkUpdate 对不存在的参数对象不崩', async () => {
  const r = await checkUpdate();
  assert.equal(r.ok, false);
  assert.equal(typeof r.error, 'string');
});
