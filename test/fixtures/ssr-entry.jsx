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
import LibraryPanel from '../../src/components/LibraryPanel.jsx';
import CatchupView from '../../src/components/CatchupView.jsx';
import SettingsPanel from '../../src/components/SettingsPanel.jsx';
import TierListView from '../../src/components/TierListView.jsx';
import { makeDefaultTierlist } from '../../src/core/tierlist.js';
import { load, seedInitialState } from '../../src/core/store.js';
import { SAMPLE_ITEMS, SAMPLE_SEASON, buildSampleUserState } from './sample-state.js';

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

/**
 * 单独渲染本地库面板。
 *
 * 不走 App 是因为设置面板关闭时不渲染，深链也到不了它 ——
 * 而它恰好承载了这次新加的全部开关，不验证等于没验证。
 */
export async function renderLibrary(props = {}) {
  await prepare();
  const base = {
    seasons: [SAMPLE_SEASON, '2026q2', '2026q3'],
    nameIndex: null,
    coverStats: null,
    groups: [],
    running: false,
    progress: null,
    report: null,
  };
  return renderToStaticMarkup(<LibraryPanel {...base} {...props} />);
}

/** 单独渲染补番视图：搜索结果、占位卡片这些新分支要用 props 直接喂进去 */
export async function renderCatchup({ rows = [], ...props } = {}) {
  await prepare();
  return renderToStaticMarkup(<CatchupView rows={rows} now={Date.UTC(2026, 9, 10)} {...props} />);
}

/**
 * 渲染设置面板，只为验证标签栏 —— 尤其是「本地库」这一项真的挂上了。
 * 面板内部那一页由 renderLibrary 单独验。
 */
export async function renderSettingsTabs() {
  await prepare();
  return renderToStaticMarkup(<SettingsPanel open themeId="midnight" settings={{}} />);
}

/**
 * 单独渲染 Tier List 视图。
 *
 * 拖拽本身是 pointer 事件，SSR 下动不了（那部分由纯函数测试守住），
 * 但「档位在不在、素材池筛得对不对、图块有没有画出来」这些**渲染**问题
 * 只能靠真的渲一遍才看得到 —— 尤其是「已排的要从池子里消失」这条。
 */
export async function renderTier(props = {}) {
  await prepare();
  const base = {
    seasonKey: SAMPLE_SEASON,
    tierlist: makeDefaultTierlist(SAMPLE_SEASON),
    pool: SAMPLE_ITEMS,
    images: {},
  };
  return renderToStaticMarkup(<TierListView {...base} {...props} />);
}
