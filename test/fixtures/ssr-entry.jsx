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
import DiaryView from '../../src/components/DiaryView.jsx';
import DiaryRatingInput from '../../src/components/DiaryRatingInput.jsx';
import Cover from '../../src/components/Cover.jsx';
import { CoverProvider } from '../../src/components/CoverContext.jsx';
import ReportView from '../../src/components/ReportView.jsx';
import HistoryView from '../../src/components/HistoryView.jsx';
import { makeDefaultTierlist } from '../../src/core/tierlist.js';
import { makeDefaultReport } from '../../src/core/report.js';
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

/** 单独渲染补番日记视图：空态、有记录、缺 BGM 分三种分支要能用 props 直接喂 */
export async function renderDiary(props = {}) {
  await prepare();
  // `onGoCatchup` 要给：空态那个「去补番清单打分」的按钮只在有回调时才渲染，
  // 不给就成了「测空态文案」顺带把空态唯一的出口测没了。
  const base = {
    diary: {},
    lookup: () => null,
    now: Date.UTC(2026, 9, 10),
    onGoCatchup: () => {},
    onOpen: () => {},
    onRemove: () => {},
  };
  return renderToStaticMarkup(<DiaryView {...base} {...props} />);
}

/** 单独渲染打分控件 */
export async function renderDiaryInput(props = {}) {
  await prepare();
  const base = { id: 1001, rating: null, note: '', bgmScore: null, count: 0 };
  return renderToStaticMarkup(<DiaryRatingInput {...base} {...props} />);
}

/**
 * 补番卡片 + 真实打分控件的组合渲染。
 *
 * 为什么要单独一个入口：`render.test.mjs` 是纯 `.mjs`，**不能写 JSX**，
 * 所以「把控件塞进卡片」这件事没法在测试文件里直接表达。
 * 放在这里还有个额外好处：验的是真控件，不是测试里现造的一个替身。
 *
 * 打分用 `ratingOf(anime)` 喂，不往 anime 对象上偷偷挂一个字段 ——
 * 挂字段的写法会让「这份数据里有这个字段」变成一件要靠记忆才知道的事。
 */
export async function renderCatchupWithDiary(rows = [], { ratingOf = () => null, noteOf = () => '' } = {}) {
  await prepare();
  return renderToStaticMarkup(
    <CatchupView
      rows={rows}
      now={Date.UTC(2026, 9, 10)}
      renderDiary={(anime) => (
        <DiaryRatingInput
          id={anime.id}
          rating={ratingOf(anime)}
          note={noteOf(anime)}
          bgmScore={anime.score ?? null}
        />
      )}
    />,
  );
}

/**
 * 单独渲染一张封面 —— 验的是「同一张图，缓存里有 / 没有 / 不许直连时会怎样」。
 *
 * 为什么要专门一个入口：封面现在从上下文里按**条目 id** 取图，而这件事
 * 在桌面壳和浏览器壳里的行为**故意不一样**（桌面壳不许退回直连，否则会下两遍）。
 * 这个分叉只能靠真的渲一遍才看得出来。
 */
export async function renderCover({ anime, images = {}, allowRemote = true } = {}) {
  await prepare();
  return renderToStaticMarkup(
    <CoverProvider images={images} allowRemote={allowRemote}>
      <Cover anime={anime} />
    </CoverProvider>,
  );
}

/**
 * 单独渲染季度报告画布。
 *
 * 块的内容用 props 直接喂（上层拼 `report.blocks`），不经过 store：
 * 报告这一层是「纯函数 + 受控组件」，块在不在、顺序对不对、空画布有没有出口，
 * 只跟 props 有关；走整个 App 反而要绕开异步取数和封面预热。
 *
 * 但**接通 App 那一步另外要验**（见 render.test.mjs 的深链用例）——
 * 组件自己好用 ≠ 它接进了 App，而 v1.1 在桌面端翻车翻的正是接通那一步。
 */
export async function renderReport(props = {}) {
  await prepare();
  const base = {
    report: makeDefaultReport(SAMPLE_SEASON),
    seasonKey: SAMPLE_SEASON,
    seasonLabel: '2026 秋',
    pool: SAMPLE_ITEMS,
    // 查不到就给占位条目（和 App 里 diaryLookup 的约定一致），返回 null 会让
    // 「查不到的作品」在两种渲染路径下表现不一样。
    lookup: (id) => SAMPLE_ITEMS.find((a) => String(a.id) === String(id))
      ?? { id: Number(id), titleZh: '', titleJa: `条目 ${id}`, cover: null, __missing: true },
    onExportPdf: () => {},
    onExportPng: () => {},
  };
  return renderToStaticMarkup(<ReportView {...base} {...props} />);
}

/**
 * 单独渲染追番历程视图。
 *
 * 时间戳用固定值喂进去，不经过 store：这一层要验的是「把时间戳摊成时间线」
 * 这件事本身，跟「时间戳是怎么记下来的」无关 —— 后者由 history-store.test.mjs
 * 守着。混在一起测的话，时间轴画错了会先让人怀疑是记时间戳记错了。
 */
export async function renderHistory(props = {}) {
  await prepare();
  const base = {
    following: {},
    diary: {},
    lookup: () => null,
    now: Date.UTC(2026, 9, 10),
    onOpen: () => {},
    onGoSeason: () => {},
  };
  return renderToStaticMarkup(<HistoryView {...base} {...props} />);
}
