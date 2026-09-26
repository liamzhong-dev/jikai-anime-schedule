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
import SearchBox from '../../src/components/SearchBox.jsx';
import SeasonPicker from '../../src/components/SeasonPicker.jsx';
import SeasonView from '../../src/components/SeasonView.jsx';
import WindowCard from '../../src/components/WindowCard.jsx';
import WallpaperFrame from '../../src/components/WallpaperFrame.jsx';
import ScaleDock, { ScaleDockProvider } from '../../src/components/ScaleDock.jsx';
import { makeDefaultTierlist } from '../../src/core/tierlist.js';
import { seasonRange } from '../../src/core/time.js';
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
 *
 * `settings` 透传：外观页的「卡片显示」两档要能喂越界值进来，
 * 验的是「界面上显示的是夹过的值」，不是「代码里夹了」。
 */
export async function renderSettingsTabs({ settings = {}, transfer, appInfo, defaultTab = 'look' } = {}) {
  await prepare();
  return renderToStaticMarkup(
    <SettingsPanel
      open
      themeId="midnight"
      settings={settings}
      defaultTab={defaultTab}
      {...(transfer ? { transfer } : {})}
      {...(appInfo ? { appInfo } : {})}
    />,
  );
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
export async function renderCover({ anime, images = {}, allowRemote = true, onOpen, openLabel } = {}) {
  await prepare();
  return renderToStaticMarkup(
    <CoverProvider images={images} allowRemote={allowRemote}>
      <Cover anime={anime} onOpen={onOpen} openLabel={openLabel} />
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

/**
 * 单独渲染顶栏搜索框。
 *
 * 下拉的开关是组件内部 state（输入过就弹、点过某条就收），SSR 下只能取初始值，
 * 所以「输完字之后长什么样」得靠 value 非空直接喂出来 —— 这正是要验的分支。
 * 「命中结果是怎么算出来的」不由这里管（那是 core/search.js 的纯函数测试）。
 */
export async function renderSearchBox(props = {}) {
  await prepare();
  const base = {
    value: '',
    onChange: () => {},
    onPick: () => {},
    others: [],
    inSeason: 0,
    ready: true,
  };
  return renderToStaticMarkup(<SearchBox {...base} {...props} />);
}

/**
 * 单独渲染季度选择器。
 *
 * 展开与否是组件内部 state，SSR 默认只会渲染收起的样子。所以组件留了
 * `initialOpen` / `initialQuery` 两个口子把状态灌进去 —— 否则
 * 「搜 2011 年 7 月能不能落到 2011q3」这条分支在无头环境里根本验不到，
 * 而那正是这个功能存在的全部理由。收起来那一面（显示当前季）由默认参数覆盖。
 */
export async function renderSeasonPicker(props = {}) {
  await prepare();
  const base = {
    seasons: seasonRange('2010q1', '2027q1'),
    value: SAMPLE_SEASON,
    values: [],
    onPick: () => {},
  };
  return renderToStaticMarkup(<SeasonPicker {...base} {...props} />);
}

/**
 * 单独渲染一张卡片窗口。
 *
 * 必须单独渲：缩放把手现在有八个，而「八个都在」这件事在整个 App 的 HTML 里
 * 数起来会混进别的卡片（`% 8` 那种断言看着聪明，其实只要有张卡被折叠 /
 * 最大化就散了）。一张卡正好八条边，数得清楚。
 */
/**
 * 单独渲染一张窗口卡片。
 *
 * 默认外面包着 Provider —— 真实界面里它总是在 Provider 下面的，
 * 我们要验的正是「那颗右上角按钮在不在」。
 * `withProvider: false` 专门给「没有 Provider 时不该冒出按钮」那条断言用。
 */
export async function renderWindowCard({ withProvider = true, ...props } = {}) {
  await prepare();
  const base = {
    id: 'test-card',
    title: '测试窗口',
    hint: '给测试用',
    layout: {},
    defaultRect: { x: 16, y: 16, w: 640, h: 420 },
    children: <div className="probe-body">内容</div>,
  };
  const card = <WindowCard {...base} {...props} />;
  return renderToStaticMarkup(
    withProvider ? <ScaleDockProvider onToggle={() => {}}>{card}</ScaleDockProvider> : card,
  );
}

/**
 * 单独渲染壁纸取景框。
 *
 * 拖动本身是 pointer 事件，SSR 下动不了（换算部分由 core/wallpaper.js 的
 * 纯函数测试守住）；这里要验的是**画出来的那一版和真正铺上去的是不是同一件事**
 * —— 背景定位、比例、以及没图 / 没开的时候长什么样。
 */
export async function renderWallpaperFrame(props = {}) {
  await prepare();
  const base = {
    dataUrl: 'data:image/png;base64,AAAA',
    imgW: 1600,
    imgH: 2400,
    x: 30,
    y: 70,
    position: 'center',
    disabled: false,
    // 比例灌进去而不是读 innerWidth：SSR 里没有窗口，读出来会是兜底值，
    // 那样「框和窗口同比例」这条就变成不可断言的了
    aspect: 2,
    onCommit: () => {},
  };
  return renderToStaticMarkup(<WallpaperFrame {...base} {...props} />);
}

/** 单独渲染番剧网格：验「一格宽」档位真的落到了网格上 */
export async function renderSeasonView(props = {}) {
  await prepare();
  const base = {
    season: SAMPLE_ITEMS,
    following: {},
    now: Date.UTC(2026, 9, 10),
    onToggle: () => {},
    onOpen: () => {},
  };
  return renderToStaticMarkup(<SeasonView {...base} {...props} />);
}

/**
 * 单独渲染右下角那个「内容大小」浮盘。
 *
 * 值与回调都从外面灌：它自己不碰 store，于是「现在调到了多少」在 SSR 里是可断言的 ——
 * 藏在组件内部 state 里的话，SSR 读到的永远是初始态，什么都验不出来。
 */
export async function renderScaleDock(props = {}) {
  const base = {
    open: true,
    cardMin: 112,
    fontScale: 1,
    onChange: () => {},
    onClose: () => {},
  };
  return renderToStaticMarkup(<ScaleDock {...base} {...props} />);
}


