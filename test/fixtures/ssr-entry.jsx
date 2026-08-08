/**
 * 无浏览器环境下渲染整个界面，给 SSR 渲染测试用。
 *
 * 前置状态取自内置真实数据（test/fixtures/sample-state.js），季度用深链钉死，
 * 这样渲染出来的四个视图都有内容，且不随「跑测试那天是几月」变化。
 *
 * 放 test/ 下面而不是 src/：它不进应用产物，只服务于测试。
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import App from '../../src/App.jsx';
import { load, seedInitialState } from '../../src/core/store.js';
import { SAMPLE_SEASON, buildSampleUserState } from './sample-state.js';

let prepared = null;

function prepare() {
  if (!prepared) {
    prepared = load().then(() => seedInitialState(buildSampleUserState(SAMPLE_SEASON)));
  }
  return prepared;
}

export async function render({ view = 'season', season = SAMPLE_SEASON } = {}) {
  await prepare();
  // 模拟浏览器的 location.hash（真实浏览器读出来是带 # 的）
  globalThis.location = { hash: `#/${view}?q=${season}` };
  return renderToStaticMarkup(<App />);
}
