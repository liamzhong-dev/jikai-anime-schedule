import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import SideNav from './components/SideNav.jsx';
import TopBar from './components/TopBar.jsx';
import WindowCard from './components/WindowCard.jsx';
import SeasonView from './components/SeasonView.jsx';
import ScheduleView from './components/ScheduleView.jsx';
import FollowingView from './components/FollowingView.jsx';
import CatchupView from './components/CatchupView.jsx';
import TierListView from './components/TierListView.jsx';
import DiaryView from './components/DiaryView.jsx';
import DiaryRatingInput from './components/DiaryRatingInput.jsx';
import HistoryView from './components/HistoryView.jsx';
import ReportView from './components/ReportView.jsx';
import YucView from './components/YucView.jsx';
import YucDetail from './components/YucDetail.jsx';
import { CoverProvider } from './components/CoverContext.jsx';
import ScaleDock, { ScaleDockProvider } from './components/ScaleDock.jsx';
import DetailDrawer from './components/DetailDrawer.jsx';
import SettingsPanel from './components/SettingsPanel.jsx';
import ShortcutsOverlay from './components/ShortcutsOverlay.jsx';
import WallpaperLayer from './components/WallpaperLayer.jsx';
import Toasts from './components/Toasts.jsx';
import { useStoreState } from './core/useStore.js';
import { searchNames } from './core/library.js';
import { splitHits, stubFromHit } from './core/search.js';
import {
  addCatchup, archiveSubjects, exportLayoutPresets, flush, listGroups, load as loadStore, markEpisode,
  patchCatchup, patchFollowing, patchSettingSection, patchSettings, readSeasonCacheRaw,
  isFollowing, removeCatchup, toggleFollow, unfollow, writeSeasonCache,
  ensureTierlist, patchTierlist, resetTierlist,
  addDiaryEntry, removeDiaryEntry, readDiary, myRatingOf, readLatestRated, readDiaryOf,
  ensureReport, setReportBlocks, resetReport,
  exportableState, importState,
} from './core/store.js';
import { compareToBangumi } from './core/diary.js';
import { useYuc } from './core/useYuc.js';
import { matchLibrary, nextAirMs, yucSeasonKeys } from './data/yuc.js';
import { buildTransfer, bundleFolderName, bundleReadme, describeCounts, parseTransfer, transferCounts, transferFileName } from './core/transfer.js';
import { autoRankByScore } from './core/tierlist.js';
import { collectImages, exportTierlistPng } from './core/tierExport.js';
import {
  WALL_DEFAULT_COUNT, WALL_MAX,
  addBlock, autoWallSubjects, blockById, makeBlock, moveBlock, nextBlockId, patchBlock, removeBlock,
} from './core/report.js';
import { buildReportHtml, canvasHtmlOf, collectStyles } from './core/reportHtml.js';
import { coverScaleFromCardMin } from './core/layout.js';
import { COVER_SCALE_OUT, FONT_SCALE_OUT, canvasScale, cardMinScaled, mixScale, spacingScale, uiScale } from './core/scale.js';
import CanvasScaleProvider from './components/CanvasScale.jsx';
import { SEASON_STATS_H, SEASON_STATS_GAP } from './core/layoutPresets.js';
import { DISPLAY_VARIANT, EXPORT_VARIANT, coverCoverage, coverEntries, coverVariant } from './core/covers.js';
import { useCovers } from './core/useCovers.js';
import { platform } from './platform/index.js';
import { allBuiltinItems, builtinItems, BUILTIN_SEASONS } from './data/builtin/index.js';
import { currentSeason, fetchCatalog } from './data/bangumiData.js';
import { describeSyncReport, syncLibrary } from './data/sync.js';
import { degradedText, loadSeason } from './data/sources.js';
import { archiveSeason, mergeArchive, mergeItems } from './data/archive.js';
import { diagnose, probeSubject } from './data/bangumiApi.js';
import { readImageFile } from './core/wallpaper.js';
import { evaluateUpdate, resolveManifestUrl } from './core/update.js';
import { isVisible } from './core/features.js';
import { lookup, normalizeEvent, shouldHandle } from './core/hotkeys.js';
import { THEMES } from './theme/themes.js';
import { applyTheme } from './theme/applyTheme.js';
import { MS_PER_DAY, allSeasons, clockCST, countdown, countdownLabel, seasonLabel, seasonOf, watchState } from './core/time.js';
import { buildWeek, upcomingWithin } from './core/schedule.js';
import { deadlineStatus, progress, sortCatchup } from './core/catchup.js';

// 这个常量和 SideNav 里的 ITEMS 是两处各写一份的 —— 加视图时两边都要改，
// 只改一处会出现「导航能点到、但深链刷新就跳回来」。
const VIEWS = ['season', 'schedule', 'yuc', 'following', 'catchup', 'diary', 'history', 'tier', 'report'];

/** 同步指示的最短显示时长（毫秒）：只为防「一闪而过」，不影响取数 */
const MIN_SYNC_MS = 480;

/**
 * 深链解析：#following、#schedule?q=2026q4
 *
 * 把「视图」和「季度」都放进 hash，有三个用处：刷新不会跳回默认页；
 * 桌面壳的托盘可以直接跳某个视图；截图与渲染测试能钉住一个季度，
 * 不受跑测试那天是几月影响。
 */
function hashState() {
  const raw = String(globalThis.location?.hash ?? '')
    .replace(/^#/, '')
    .replace(/^\//, '');
  const [view, query] = raw.split('?');
  let q = null;
  try {
    q = new URLSearchParams(query ?? '').get('q');
  } catch {
    q = null;
  }
  return {
    view: VIEWS.includes(view) ? view : 'season',
    seasonKey: /^\d{4}q[1-4]$/.test(q ?? '') ? q : null,
  };
}

export default function App() {
  const st = useStoreState();
  // 镜像最新状态，避免定时器与异步回调读到旧闭包
  const stRef = useRef(st);
  stRef.current = st;
  const booted = useRef(false);

  const [ready, setReady] = useState(false);
  // 深链只读一次，后面都是状态说了算
  const [boot] = useState(hashState);
  const initialSeason = boot.seasonKey ?? currentSeason();
  const [view, setView] = useState(boot.view);
  const [seasonKey, setSeasonKey] = useState(initialSeason);
  // 首屏先用内置数据顶上，不等异步：这样从冷启动到看见番剧表之间没有空白期，
  // 断网时也不会有。真正的数据由下面的 loadData 按当前数据源决定。
  // 注意要和 seasonKey 取同一季 —— 否则深链指定了别的季度时，首屏会闪一下当季。
  const [season, setSeason] = useState(() => builtinItems(initialSeason));
  /*
   * 本地季度归档：每导入一批就按开播月份分组存一份。
   * 每日放送原来只吃当季那一批，过季即丢 —— 往季新番在时间表里整片消失。
   * 归档是可再生的（重新同步一次就有），所以不进 state.json，单独一个文件。
   *
   * 用 ref 存最新值：写归档是异步的，而 loadData 可能连着跑两次（切季度），
   * 只读 state 会拿到上一轮的旧值，把刚导进来的那批冲掉。
   */
  const [airArchive, setAirArchive] = useState(null);
  const airRef = useRef(null);
  const [syncing, setSyncing] = useState(false);
  const [progressPct, setProgressPct] = useState(0);
  const [progressLabel, setProgressLabel] = useState('');
  const [degraded, setDegraded] = useState(null);
  const [enrichNote, setEnrichNote] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const [drawer, setDrawer] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [keyword, setKeyword] = useState('');

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState('look');
  const [helpOpen, setHelpOpen] = useState(false);

  const [appInfo, setAppInfo] = useState(null);
  const [wallpaper, setWallpaper] = useState(null);
  const [wallpaperBusy, setWallpaperBusy] = useState(false);
  const [autoLaunch, setAutoLaunch] = useState(null);
  const [hotkeyInfo, setHotkeyInfo] = useState(null);
  const [updateState, setUpdateState] = useState({ checking: false, result: null });
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnoseResult, setDiagnoseResult] = useState(null);
  const [apiTest, setApiTest] = useState(null);
  const [testingApi, setTestingApi] = useState(false);

  // ---- 本地库 ----
  // nameIndex 单独一个文件（约 1MB），不混进 state.json ——
  // 每次 state 落盘都要 stringify 一遍，塞进去会让改任何设置都变重。
  const [nameIndex, setNameIndex] = useState(null);
  const [coverStats, setCoverStats] = useState(null);
  const [libraryRunning, setLibraryRunning] = useState(false);
  const [libraryProgress, setLibraryProgress] = useState(null);
  const [libraryReport, setLibraryReport] = useState(null);
  // 补番页顶部的「按名字搜」
  const [catchupQuery, setCatchupQuery] = useState('');

  // ---- Tier List（按季度各存一份）----
  const [tierExporting, setTierExporting] = useState(false);
  const [tierNote, setTierNote] = useState('');

  // ---- 季度报告长图（同样按季度各存一份）----
  // 选中块与素材搜索都提到这里：SSR 断言要能指定「选中一块之后属性面板显示什么」，
  // 组件内部 state 外面灌不进去，怎么测都是初始态。
  const [reportExporting, setReportExporting] = useState(false);
  const [reportNote, setReportNote] = useState('');
  // 导出进度：{pct, label}。长图导出要走几十秒，没有进度的话
  // 「还在拼」和「卡死了」在界面上长得一模一样。
  const [reportProgress, setReportProgress] = useState(null);
  const [reportSel, setReportSel] = useState(null);
  const [reportKeyword, setReportKeyword] = useState('');
  /*
   * 备份与迁移的三个状态。
   * `transferPending` 是「文件读进来了、但还没覆盖」的那一步 ——
   * 覆盖是破坏性的，中间停下来让用户看一眼两边的条数，比事后道歉管用。
   */
  const [transferBusy, setTransferBusy] = useState('');
  const [transferNote, setTransferNote] = useState('');
  const [transferPending, setTransferPending] = useState(null);
  /*
   * 右下角那个「内容大小」浮盘开没开。
   * 不进 store：它是一次性的界面状态，写进 state.json 只会让下次启动凭空多一块面板。
   */
  const [scaleOpen, setScaleOpen] = useState(false);

  const notified = useRef(new Set());

  const pushToast = useCallback((title, body) => {
    const t = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, title, body };
    setToasts((list) => [...list, t]);
    setTimeout(() => setToasts((list) => list.filter((x) => x.id !== t.id)), 5200);
  }, []);

  // ---------- 启动：读 store、读壁纸、拿应用信息 ----------
  useEffect(() => {
    let alive = true;
    (async () => {
      await loadStore();
      const [info, wp, al, ni, cs] = await Promise.all([
        platform.appInfo().catch(() => null),
        platform.readWallpaper().catch(() => null),
        platform.getAutoLaunch().catch(() => null),
        platform.readNameIndex().catch(() => null),
        platform.coverCacheStats().catch(() => null),
      ]);
      if (!alive) return;
      setAppInfo(info);
      setAutoLaunch(al);
      setNameIndex(ni);
      setCoverStats(cs);
      if (wp?.dataUrl) setWallpaper(wp);
      setReady(true);
      booted.current = true;
    })();
    return () => { alive = false; };
  }, []);

  // 关窗前把最后 400ms 的改动落盘
  useEffect(() => {
    const onUnload = () => { flush(); };
    globalThis.window?.addEventListener('beforeunload', onUnload);
    return () => globalThis.window?.removeEventListener('beforeunload', onUnload);
  }, []);

  // ---------- 主题与壁纸：任何一项变化就重算 CSS 变量 ----------
  useEffect(() => {
    applyTheme(st.settings.theme, {
      wallpaper: { ...st.settings.wallpaper, dataUrl: wallpaper?.dataUrl ?? null },
      panelAlpha: st.settings.panelAlpha,
    });
  }, [st.settings.theme, st.settings.wallpaper, st.settings.panelAlpha, wallpaper]);

  /*
   * 窗口尺寸 → 界面倍率。这是「最大化之后界面纹丝不动」的根。
   *
   * 原来 `--fs` / `--cs` 只来自手动档位，跟窗口多大一点关系都没有 ——
   * 于是从 1440 拉到 1920：列数多了两列、两边留白，而字、封面、间距
   * 一个像素都不动。现在倍率是**两段相乘**：
   *
   *     最终 = 手动档位（个人偏好）× 窗口自适应倍率（下面这一段算）
   *
   * 手动档位留着，含义变成「在自动的基础上再偏一点」：有人就是想字再大一号，
   * 那是偏好，不是让他去补自动化的缺。
   *
   * ⚠️ 用 JS 算，不用纯 CSS 的 `clamp(… 100vw …)`：CSS 里「长度除长度得数字」
   * 在部分内核上算不出来，一算不出整个 clamp 就静默失效退回 1 —— 恰恰是
   * 「看着没坏、其实没生效」那一类。放在这里算，倍率就是**可断言的纯函数**
   * （单调性与两端夹逼由 test/scale.test.mjs 守着）。
   *
   * ⚠️ 量化到 0.01：改 root 上的变量会触发全站重排，拖窗口时每帧一次就是
   * 几百次。量化之后大约每 14px 才真的变一次，肉眼看还是连续的。
   */
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (globalThis.window === undefined) return undefined;
    let raf = 0;
    const read = () => {
      raf = 0;
      const w = globalThis.window.innerWidth;
      const h = globalThis.window.innerHeight;
      // 小于 8px 的变化不理会：只可能来自滚动条或缩放抖动，为它重排全站不值得
      setViewport((prev) => (Math.abs(prev.w - w) < 8 && Math.abs(prev.h - h) < 8 ? prev : { w, h }));
    };
    const onResize = () => {
      if (!raf) raf = globalThis.requestAnimationFrame(read);
    };
    read();
    globalThis.window.addEventListener('resize', onResize);
    return () => {
      globalThis.window.removeEventListener('resize', onResize);
      if (raf) globalThis.cancelAnimationFrame(raf);
    };
  }, []);

  /*
   * 画布的可用尺寸。**量出来**而不是从窗口宽高减去骨架去算：
   * 侧栏宽度、顶栏高度都是 CSS 里的值（还跟着 `--sp` 一起变），在这儿再抄一份
   * 数字，改样式的时候必然对不上。
   */
  const canvasRef = useRef(null);
  const [canvasBox, setCanvasBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => {
      setCanvasBox({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [view]);

  const uiAuto = useMemo(
    () => (st.settings.autoScale === false ? 1 : uiScale(viewport.w)),
    [st.settings.autoScale, viewport.w],
  );

  /*
   * 卡片摆位的倍率。
   *
   * 摆位存的是 1440×900 下的基准坐标，这里算出「当前画布是基准的几倍」；
   * 定位交给 CSS 的 `calc(基准px * var(--kx))`，所以倍率一变浏览器自己重排，
   * 不用重渲染任何一张卡片。
   */
  const canvasFit = useMemo(
    () => (st.settings.autoScale === false ? { kx: 1, kh: 1 } : canvasScale(canvasBox.w, canvasBox.h)),
    [st.settings.autoScale, canvasBox.w, canvasBox.h],
  );

  useEffect(() => {
    const root = globalThis.document?.documentElement;
    if (!root) return;
    root.style.setProperty('--u', String(uiAuto));
    root.style.setProperty('--sp', String(spacingScale(uiAuto)));
    root.style.setProperty('--kx', String(canvasFit.kx));
    root.style.setProperty('--kh', String(canvasFit.kh));
  }, [uiAuto, canvasFit]);

  /*
   * 卡片里文字的大小。
   *
   * 写在 root 上而不是某一处卡片上：「显示多大」这件事得全局一致 ——
   * 用户调一次，本季 / 时间表 / 追番 / 日记里的字都该跟着变。挂在某个视图上，
   * 表现就是「在这页调好了，翻一页又回去了」，而用户只会觉得是设置没生效。
   *
   * 封面画多大由 `--card-min` 管（在网格那边设），两者分开：
   * 有人想一屏塞更多封面（图和字一起小），也有人只想把字放大看清（图不动）。
   */
  useEffect(() => {
    const root = globalThis.document?.documentElement;
    if (root) root.style.setProperty('--fs', String(mixScale(st.settings.fontScale ?? 1, uiAuto, FONT_SCALE_OUT)));
  }, [st.settings.fontScale, uiAuto]);

  /*
   * 封面画多大的倍率。
   *
   * 和 `--fs` 一样挂在 root 上，理由也一样：**这是一整站的档位**。
   * 之前它只有本季网格认（`--card-min` 就在那个网格上设），
   * 于是用户在本季把封面拉满，切到 TierList 发现图一格没动 ——
   * 页面之间体感不一致，比「没有这个功能」更像坏了。
   *
   * 倍率是从 `cardMin` 派生的（同一个滑块管全站），不是新的一档：
   * 设置里已经有一个「封面尺寸」了，再来一个只会让人不知道拉哪个。
   */
  useEffect(() => {
    const root = globalThis.document?.documentElement;
    if (root) root.style.setProperty('--cs', String(mixScale(coverScaleFromCardMin(st.settings.cardMin), uiAuto, COVER_SCALE_OUT)));
  }, [st.settings.cardMin, uiAuto]);

  // ---------- 代理：设置里一改就让主进程立刻生效 ----------
  useEffect(() => {
    const proxy = st.settings.api?.proxy ?? '';
    if (!ready) return;
    platform.setProxy?.(proxy);
  }, [st.settings.api?.proxy, ready]);

  // ---------- 全局快捷键 ----------
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    platform.setGlobalHotkey(st.settings.globalHotkey).then((r) => {
      if (alive) setHotkeyInfo(r);
    });
    return () => { alive = false; };
  }, [st.settings.globalHotkey, ready]);

  // Web 降级通知走同一条提示通道
  useEffect(() => {
    globalThis.window && (window.__jikaiToast = ({ title, body }) => pushToast(title, body));
    return () => {
      if (globalThis.window) delete window.__jikaiToast;
    };
  }, [pushToast]);

  // ---------- 本地季度归档 ----------
  // 启动时先读回来：往季的数据只有这里还有，读不到就等于从没导过
  useEffect(() => {
    if (!ready) return undefined;
    let alive = true;
    platform.readAirArchive()
      .then((a) => {
        if (!alive || !a) return;
        airRef.current = a;
        setAirArchive(a);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [ready]);

  // ---------- 拉数据 ----------
  const loadData = useCallback(async (key, { live = false } = {}) => {
    const source = stRef.current.settings.dataSource;
    const startedAt = Date.now();
    setSyncing(true);
    setDegraded(null);
    setEnrichNote(null);
    setProgressPct(6);
    setProgressLabel('');

    const res = await loadSeason(source, key, {
      live,
      api: stRef.current.settings.api,
      fetchJson: (url, opts) => platform.fetchJson(url, opts),
      readCache: (k) => readSeasonCacheRaw(k),
      writeCache: (k, payload) => writeSeasonCache(k, payload),
      onProgress: ({ pct, label }) => {
        setProgressPct(pct);
        if (label) setProgressLabel(label);
      },
    });

    // 内置数据是本地读数组，几十毫秒就完了 —— 指示条闪一下反而像没反应。
    // 这里给一个最短显示时长，纯观感问题，不影响数据。
    const elapsed = Date.now() - startedAt;
    if (elapsed < MIN_SYNC_MS) await new Promise((r) => setTimeout(r, MIN_SYNC_MS - elapsed));

    /*
     * 先把这一批按开播月份落进本地归档，再把该季归档里已有的条目并回本次结果。
     * 后半句不是多余动作：联网失败（降级）时 res.items 可能是空的，
     * 而归档里还留着上次导进来的那份 —— 那样时间表不会整片空掉。
     */
    const arch = mergeArchive(airRef.current, res.items);
    airRef.current = arch;
    setAirArchive(arch);
    platform.writeAirArchive(arch).catch(() => {});

    const items = mergeItems(archiveSeason(arch, key), res.items);
    setSeason(items);
    setDegraded(res.degraded);

    if (res.degraded) {
      pushToast('数据源降级', degradedText(res.degraded));
    } else if (res.enrichStats && res.enrichStats.requested > 0) {
      const { ok, failed, requested } = res.enrichStats;
      setEnrichNote(`补全 ${ok}/${requested}${failed ? ` · ${failed} 条失败` : ''}`);
      pushToast('同步完成', `${seasonLabel(key)} 共 ${items.length} 部 · 补全 ${ok}/${requested}`);
    } else if (res.cached) {
      pushToast('用上了本地缓存', `${seasonLabel(key)} 共 ${items.length} 部`);
    } else {
      pushToast('同步完成', `${seasonLabel(key)} 共 ${items.length} 部`);
    }

    setSyncing(false);
    setTimeout(() => { setProgressPct(0); setProgressLabel(''); }, 900);
  }, [pushToast]);

  useEffect(() => {
    if (!ready) return;
    loadData(seasonKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seasonKey, st.settings.dataSource, ready]);

  // ---------- 每 30 秒推进「现在」，顺带检查该不该提醒 ----------
  useEffect(() => {
    const tick = () => {
      const nowMs = Date.now();
      setNow(nowMs);

      const s = stRef.current.settings;
      const hour = new Date(nowMs).getHours();
      const [quietFrom, quietTo] = s.quietHours ?? [23, 8];
      const quiet = quietFrom > quietTo ? hour >= quietFrom || hour < quietTo : hour >= quietFrom && hour < quietTo;
      if (quiet) return;

      const following = stRef.current.following;
      const lead = (s.reminderLeadMin ?? 0) * 60000;
      for (const a of season) {
        const f = following[a.id];
        if (!f || f.notify === false) continue;
        /*
         * 番堂给的「周几 + 几点」比库里推算出来的准：库里是「首播 + 周期」推的，
         * 遇到停播一周、档期微调就会漂。所以有 airHint 的时候优先用番堂那个时刻，
         * 没有的话一切照旧 —— 这条分支不该影响任何没开过提醒的番。
         */
        const hintMs = f.airHint ? nextAirMs(f.airHint, nowMs) : null;
        const ws = watchState(a, f.watchedEps ?? 0, nowMs);
        const nextMs = hintMs ?? ws.next.ms;
        if (nextMs == null || (hintMs == null && ws.finished)) continue;
        const delta = nextMs - nowMs;
        const key = `${a.id}#${ws.next.episode}`;
        if (delta <= lead + 60000 && delta >= -60000 && !notified.current.has(key)) {
          notified.current.add(key);
          platform.notify(
            `${a.titleZh || a.titleJa} 第 ${ws.next.episode} 话`,
            lead > 0 ? `${Math.max(1, Math.round(delta / 60000))} 分钟后更新` : '已更新，可以看了',
          );
        }
      }
    };
    const timer = setInterval(tick, 30000);
    return () => clearInterval(timer);
  }, [season]);

  const goView = useCallback((next) => {
    setView(next);
    if (globalThis.location) globalThis.location.hash = `/${next}`;
  }, []);

  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    globalThis.window?.addEventListener('hashchange', onHash);
    return () => globalThis.window?.removeEventListener('hashchange', onHash);
  }, []);

  // ---------- 设置与外观操作 ----------
  const openSettings = useCallback((tab = 'look') => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  }, []);

  const cycleTheme = useCallback(() => {
    const cur = stRef.current.settings.theme;
    const idx = THEMES.findIndex((t) => t.id === cur);
    const next = THEMES[(idx + 1) % THEMES.length];
    patchSettings({ theme: next.id });
    pushToast('换了一套配色', next.name);
  }, [pushToast]);

  const toggleWallpaper = useCallback(() => {
    const wp = stRef.current.settings.wallpaper;
    if (!wp?.dataUrl) {
      openSettings('look');
      pushToast('还没有壁纸', '在「外观」里选一张图片');
      return;
    }
    const on = !wp.enabled;
    patchSettingSection('wallpaper', { enabled: on });
    pushToast(on ? '壁纸已开' : '壁纸已关', on ? '卡片不透明度可以在设置里调低' : null);
  }, [openSettings, pushToast]);

  const pickWallpaper = useCallback(async (file) => {
    setWallpaperBusy(true);
    try {
      const payload = await readImageFile(file);
      await platform.writeWallpaper(payload);
      setWallpaper(payload);
      // imgW / imgH 是给「取景框」算拖动位移用的（cover 的溢出量要靠原图比例），
      // 顺手存进设置里，之后就算读不到壁纸文件也还知道图有多大。
      // 位置一起回正：换了一张图就是重新构图，沿用上一张的取景位置只会让人莫名其妙。
      patchSettingSection('wallpaper', {
        enabled: true,
        name: payload.name,
        imgW: payload.width,
        imgH: payload.height,
        x: 50,
        y: 50,
      });
      pushToast('壁纸已更新', `${payload.width}×${payload.height} · 约 ${Math.round(payload.bytes / 1024)} KB`);
    } finally {
      setWallpaperBusy(false);
    }
  }, [pushToast]);

  const clearWallpaper = useCallback(async () => {
    await platform.clearWallpaper();
    setWallpaper(null);
    patchSettingSection('wallpaper', { enabled: false, name: null });
    pushToast('壁纸已移除', null);
  }, [pushToast]);

  const handleAutoLaunch = useCallback(async (on) => {
    const res = await platform.setAutoLaunch(on);
    setAutoLaunch(res);
    if (res?.supported === false) {
      pushToast('这个环境不支持开机自启', res.error ?? '需要在桌面版里设置');
      return;
    }
    pushToast(on ? '已开启开机自启' : '已关闭开机自启', on ? '下次开机会静默进托盘' : null);
  }, [pushToast]);

  const handleGlobalHotkey = useCallback(async (spec) => {
    const res = await platform.setGlobalHotkey(spec);
    setHotkeyInfo(res);
    pushToast(res?.ok ? '全局快捷键已生效' : '全局快捷键没注册上', res?.ok ? spec : res?.reason ?? '');
  }, [pushToast]);

  const handleCheckUpdate = useCallback(async () => {
    setUpdateState({ checking: true, result: null });
    const url = resolveManifestUrl(stRef.current.settings.update?.manifestUrl, null);
    if (!url) {
      const result = { error: '还没有配置更新源地址' };
      setUpdateState({ checking: false, result });
      pushToast('无法检查更新', '在设置 → 系统 里填一个更新源地址');
      return;
    }
    try {
      const raw = await platform.checkUpdate({ manifestUrl: url });
      const result = evaluateUpdate(raw, appInfo?.version ?? '0.0.0', {
        skippedVersion: stRef.current.settings.update?.skippedVersion ?? null,
      });
      setUpdateState({ checking: false, result });
      patchSettingSection('update', { lastCheck: Date.now(), lastResult: result });
      if (result.hasUpdate) pushToast('发现新版本', `${result.latest}（当前 ${result.current}）`);
      else pushToast('已是最新版本', result.current);
    } catch (err) {
      const result = { error: err?.message ?? String(err) };
      setUpdateState({ checking: false, result });
      patchSettingSection('update', { lastCheck: Date.now(), lastResult: result });
      pushToast('检查更新失败', result.error);
    }
  }, [appInfo, pushToast]);

  // 启动时自动检查一次（配置了更新源才真的发请求）
  //
  // 注意这里也要看功能开关：入口藏起来了就不能偷偷跑，否则启动时会冒出一句
  // 「无法检查更新 · 在设置 → 系统 里填一个更新源地址」，而设置里根本没有那一项了。
  const autoChecked = useRef(false);
  useEffect(() => {
    if (!isVisible('autoUpdate')) return;
    if (!ready || autoChecked.current) return;
    if (st.settings.update?.autoCheck === false) return;
    autoChecked.current = true;
    handleCheckUpdate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, st.settings.update?.autoCheck]);

  const handleDiagnose = useCallback(async () => {
    setDiagnosing(true);
    setDiagnoseResult(null);
    try {
      const res = await diagnose({
        api: stRef.current.settings.api,
        fetchJson: (url, opts) => platform.fetchJson(url, opts),
      });
      setDiagnoseResult(res);
      const ok = res.rows.filter((r) => r.ok).length;
      pushToast(ok ? `找到 ${ok} 个可用端点` : '所有端点都不通', ok ? null : '被墙时开代理、或填自建反代');
    } catch (err) {
      pushToast('诊断失败', err?.message ?? String(err));
    } finally {
      setDiagnosing(false);
    }
  }, [pushToast]);

  const handleTestApi = useCallback(async (id) => {
    setTestingApi(true);
    setApiTest(null);
    try {
      const res = await probeSubject(id, {
        api: stRef.current.settings.api,
        fetchJson: (url, opts) => platform.fetchJson(url, opts),
      });
      setApiTest({ ok: true, base: res.base, patch: res.patch });
      pushToast('这条拿到了', `${res.patch.titleZh || res.patch.titleJa || '（无标题）'} · ${res.base}`);
    } catch (err) {
      setApiTest({ ok: false, error: err?.message ?? String(err) });
      pushToast('这条请求失败', err?.message ?? String(err));
    } finally {
      setTestingApi(false);
    }
  }, [pushToast]);

  // ---------- 本地库：更新 Bangumi 数据 ----------
  //
  // 一次点击做三件事（顺序在 src/data/sync.js 里）：
  //   ① 拉一次全量数据集；② 派生名称索引 + 各季度分组；
  //   ③ 补番组里「名单上有、档案里没有」的逐个回查 API 补全。
  // 第 ③ 步是「补番名单记住了但补不出来」的唯一解 —— 不联网，
  // 那些条目永远只剩一串数字 id。
  const refreshCoverStats = useCallback(async () => {
    setCoverStats(await platform.coverCacheStats().catch(() => null));
  }, []);

  const runLibrarySync = useCallback(async ({ seasonKeys = [], rebuildIndex = false } = {}) => {
    if (libraryRunning) return;
    setLibraryRunning(true);
    setLibraryProgress({ pct: 4, label: '准备' });
    setLibraryReport(null);

    // 只补「确实缺」的：已经有档案的不重复发请求
    const archive = stRef.current.subjects ?? {};
    const missingIds = [...new Set(
      stRef.current.catchup
        .map((c) => Number(c.subjectId))
        .filter((id) => Number.isFinite(id) && id > 0 && !archive[id]),
    )];

    try {
      const rep = await syncLibrary({
        seasonKeys,
        rebuildIndex,
        catchupIds: missingIds,
        fetchCatalog: ({ signal }) => fetchCatalog({ signal, fetchJson: (url, o) => platform.fetchJson(url, o) }),
        readNameIndex: () => platform.readNameIndex().catch(() => null),
        writeNameIndex: async (payload) => {
          await platform.writeNameIndex(payload);
          setNameIndex(payload);
        },
        writeSeason: (key, items) => writeSeasonCache(key, {
          savedAt: Date.now(), source: 'bangumi-data', enriched: false, enrichStats: null, items,
        }),
        archiveSubjects: (items) => archiveSubjects(items),
        fetchJson: (url, opts) => platform.fetchJson(url, opts),
        api: stRef.current.settings.api,
        onProgress: ({ pct, label }) => setLibraryProgress({ pct, label }),
        nowMs: Date.now(),
      });

      const text = describeSyncReport(rep);
      setLibraryReport({ ok: rep.ok, text });
      setNameIndex(await platform.readNameIndex().catch(() => null));
      if (rep.ok) pushToast('已更新 Bangumi 数据', text);
      else pushToast('更新完了，但有地方出错', text);
    } catch (err) {
      const text = err?.message ?? String(err);
      setLibraryReport({ ok: false, text });
      pushToast('更新失败', text);
    } finally {
      setLibraryRunning(false);
      setLibraryProgress(null);
    }
  }, [libraryRunning, pushToast]);

  const clearNameIndex = useCallback(async () => {
    await platform.clearNameIndex().catch(() => false);
    setNameIndex(null);
  }, []);

  const clearCoverCache = useCallback(async (opts = {}) => {
    const r = await platform.clearCoverCache(opts).catch((err) => ({ error: err?.message ?? String(err) }));
    await refreshCoverStats();
    return r;
  }, [refreshCoverStats]);

  const searchNote = useMemo(() => {
    if (libraryRunning) return '正在更新 Bangumi 数据…';
    if (!nameIndex?.count) return '还没有名称索引 —— 到「设置 → 本地库」点一次更新就能搜了';
    return `在全量 ${nameIndex.count} 部里搜`;
  }, [nameIndex, libraryRunning]);

  const catchupResults = useMemo(() => {
    const q = catchupQuery.trim();
    if (!q || !nameIndex?.entries?.length) return [];
    return searchNames(nameIndex, q, { limit: 12 });
  }, [catchupQuery, nameIndex]);

  /**
   * 从搜索结果里加一部进补番清单。
   *
   * 索引里只有名字，没有封面和话数 —— 所以这里先按已知信息建档，
   * 剩下的等下次「更新 Bangumi 数据」第 ③ 步去补齐。
   * 关键是**先把名字存下来**：这才是「记住补番名单」的意思，
   * 卡片不会再因为切个季度就消失。
   */
  const addFromSearch = useCallback((hit) => {
    const anime = {
      id: hit.id,
      titleZh: hit.zh || '',
      titleJa: hit.ja || '',
      season: hit.y && hit.q ? `${hit.y}q${hit.q}` : null,
      eps: null,
      cover: null,
    };
    addCatchup(hit.id, { anime, targetEps: 12, deadline: Date.now() + 21 * MS_PER_DAY });
    pushToast('已加入补番清单', `${hit.zh || hit.ja} · 默认 21 天内补完 · 封面话数下次更新时补齐`);
    setCatchupQuery('');
  }, [pushToast]);

  // ---------- Tier List ----------
  //
  // 素材池就是当前季度（决定 #1）。按季度各存一份，切季度互不影响；
  // 封面按 group=季度 落在缓存里，所以切回去还是那批图，不用重下。
  const tierlist = useMemo(
    () => ensureTierlist(seasonKey),
    // st.tierlists 每次 patch 都是新对象，靠它触发重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [seasonKey, st.tierlists],
  );

  // 只有切到 Tier 视图才预热封面 —— 而且预热的是**缩略图那一档**（约 2.6MB），
  // 不是原图（约 45MB）。界面上的图块只有 100×120，用原图纯属浪费：
  // 全季总量差 17 倍，还要整份经 IPC 转 base64 送过来。
  // 原图只在「按下导出」那一次去取（见 handleExportTier）。
  // ⚠️ 键是**条目 id**，不是封面地址。地址分变体（界面 `c`、导出 `l`），
  // 拿地址当键的话，存的一侧和查的一侧各推一次，推错一次就是一整屏色块，
  // 而 JS 只给 undefined 不报错。见 `coverEntries` 的注释。
  const poolCoverEntries = useMemo(
    () => coverEntries(season, DISPLAY_VARIANT),
    [season],
  );

  const poolCovers = useCovers({
    group: seasonKey,
    entries: poolCoverEntries,
    enabled: poolCoverEntries.length > 0,
  });

  // 本地缓存通道用不了（浏览器壳），或这次一张都没取到 → 显示退回直连远端地址。
  // 桌面壳里绝不能这么做：那会先由浏览器下一遍 45MB，主进程再下一遍进缓存。
  //
  // `platform.kind` 是**同步**就知道的，所以浏览器壳一上来就走这一条 ——
  // 只等 `useCovers` 那个异步结论的话，首屏会先闪一片色块再换成图。
  const coversRemote = platform.kind === 'web' || !poolCovers.supported || Boolean(poolCovers.error);

  const coversNote = useMemo(() => {
    // 封面预热已改成全视图共用，进度提示在任何视图都显示
    if (!poolCovers.supported) return '浏览器里没有封面缓存，导出高清图请用桌面版';
    if (poolCovers.error) return poolCovers.error;
    if (poolCovers.progress) {
      const { phase, done, total } = poolCovers.progress;
      return `${phase === 'warm' ? '下载封面' : '读取封面'} ${done}/${total}`;
    }
    return '';
  }, [view, poolCovers.supported, poolCovers.error, poolCovers.progress]);

  /*
   * 番堂（yuc.wiki）那一页的数据。
   *
   * ⚠️ `view === 'yuc' ? seasonKey : null` 不是抄近路 —— 传 null 等于「没人看这一页」，
   * 取数层就一个字都不发。写成一直取的话，用户可能一整天都不点这个视图，
   * 却在每次启动时都去拉一遍别人的站点。
   *
   * 配套的还有 `yuc.data` 的值从哪来：**不进 store**（它只读、可再生、
   * 自带 `savedAt`），落盘由取数层直接写 `yucSeasons.json`。所以这里没有
   * patch/持久化的动作，只有「读」和「重新拉」。
   */
  /*
   * 番堂那一页能自己挑季度：默认跟着顶栏那一季，挑过之后就固定住。
   * ⚠️ 可选项只给最近这几季 —— 排播表本来就是「这季要看什么」，
   * 往回翻太多没意义，而列表太长会让「换季」本身变得不好找。
   */
  const [yucSeasonPick, setYucSeasonPick] = useState(null);
  const yucSeasonKey = yucSeasonPick ?? seasonKey;
  /*
   * `include: yucSeasonKey` 不是可有可无的：顶栏切到还没到的下一季时，
   * 番堂这一页也跟着切过去，而「从现在往回的 8 季」里根本没有那一季 ——
   * <select> 的 value 匹配不上任何 option 时会退回显示列表第一项，
   * 于是页面放着十月的排播、下拉框却写着「7 月 · 夏」，看着像季节算错了。
   */
  const yucSeasons = useMemo(
    // ahead 不传（默认 0）：季度边界本身已经把 9 月下半算成秋番，
    // 再叠一层会冒出番堂还没出版的次年 1 月番，点进去是空的
    () => yucSeasonKeys(Date.now(), { back: 8, include: yucSeasonKey }),
    [seasonKey, yucSeasonKey],
  );
  const yuc = useYuc(view === 'yuc' ? yucSeasonKey : null);
  const [yucSel, setYucSel] = useState(null);

  // 番堂的条目 ↔ 我们库里的条目。两边各用各的长处：排播来自番堂、
  // 评分/话数/日记来自 Bangumi，交汇点就是这一张表。
  const yucItems = useMemo(() => (yuc.data?.groups ?? []).flatMap((g) => g.items ?? []), [yuc.data]);

  /*
   * 详情页单独取一张封面。
   *
   * 池子里只有当季那一批，而抽屉里这条可能是往季的追番、也可能是番堂的条目 ——
   * 两者都不在池子里，于是详情页永远是色块，看着像「这个番没有封面」。
   *
   * group 用**它自己那一季**而不是当季：封面缓存按季度分目录，放对位置
   * 下次打开才不用重新下一遍。番堂那条用 `yuc-<季度>`，和番堂列表页同一份缓存。
   */
  const detailCover = useMemo(() => {
    if (drawer?.cover) {
      const ms = Date.parse(drawer.begin ?? '');
      return { group: Number.isNaN(ms) ? seasonKey : seasonOf(ms), entry: drawer };
    }
    if (yucSel?.cover) return { group: `yuc-${seasonKey}`, entry: yucSel };
    return null;
  }, [drawer, yucSel, seasonKey]);

  const detailCovers = useCovers({
    group: detailCover?.group ?? '',
    entries: detailCover ? coverEntries([detailCover.entry], DISPLAY_VARIANT) : [],
    enabled: Boolean(detailCover),
  });

  // 池子 + 详情那一张。键是条目 id，两边的 id 不可能撞（番堂是 y 开头）
  const coverImages = useMemo(
    () => ({ ...poolCovers.images, ...detailCovers.images }),
    [poolCovers.images, detailCovers.images],
  );
  const yucMatched = useMemo(() => matchLibrary(yucItems, season), [yucItems, season]);

  /*
   * 「提醒我这一集」：把番堂的「周几 + 几点」存进关注记录，提醒就照它算。
   *
   * 存的是**规则**不是算好的时刻 —— 存时刻的话下周它还会指着上一周那个点提醒一次，
   * 然后就再也不响了。时刻在每次检查时现算（见上面 tick 里那一段）。
   */
  const handleYucRemind = useCallback((item, lib) => {
    if (!lib?.id) return;
    if (nextAirMs(item) == null) return;
    const hint = { weekday: item.groupKey, time: item.time, start: item.start ?? null };
    if (st.following?.[lib.id]?.airHint) {
      patchFollowing(lib.id, { airHint: null, notify: false });
      return;
    }
    if (isFollowing(lib.id)) patchFollowing(lib.id, { notify: true, airHint: hint });
    else toggleFollow(lib.id, { notify: true, airHint: hint });
  }, [st.following]);


  const handleAutoRank = useCallback(() => {
    const { items, ranked, unranked } = autoRankByScore(tierlist.items, season, tierlist.rows);
    patchTierlist(seasonKey, { items });
    if (!ranked.length) pushToast('一部都没排进去', '这一季还没有评分数据，先手动排着');
    else pushToast('已按评分分档', `${ranked.length} 部进档 · ${unranked.length} 部没评分，留在池子里`);
  }, [seasonKey, tierlist, season, pushToast]);

  const handleResetTier = useCallback(() => {
    // 不传 presetId：档位定义要**留着**（自定义模板下尤其重要），
    // 这个按钮清的是排布，不是模板。
    resetTierlist(seasonKey);
    pushToast('已清空', `${seasonLabel(seasonKey)} 的排布`);
  }, [seasonKey, pushToast]);

  /**
   * 导出 PNG。
   *
   * 图必须走主进程的缓存通道拿 **dataUrl**：直接把远端地址画进 canvas 会被 taint，
   * `toDataURL()` 立刻抛 SecurityError —— 而这个错只在这一步才出现，
   * 前面排得再好也白排。
   */
  const handleExportTier = useCallback(async () => {
    setTierExporting(true);
    setTierNote('');
    try {
      const byId = new Map(season.map((a) => [String(a.id), a]));
      const entries = tierlist.items.map((it) => {
        const a = byId.get(String(it.key));
        // 导出要原图：这里是唯一会去取 `l` 的地方。
        // 同时备一份 `c`（平时浏览缓存下来的那一档）当退路 ——
        // 断网时原图取不到，用缩略图顶上总比整片色块强：150×212 铺进 200×280 只是略软。
        return {
          key: it.key,
          url: a?.cover ? coverVariant(a.cover, EXPORT_VARIANT).url : '',
          fallback: a?.cover ? coverVariant(a.cover, DISPLAY_VARIANT).url : '',
        };
      });

      const fallbackOf = new Map(
        entries.filter((e) => e.url && e.fallback && e.fallback !== e.url).map((e) => [e.url, e.fallback]),
      );
      /** 走了缩略图退路的张数。不说出来的话，用户会以为这张本来就是糊的 */
      let softCount = 0;

      const { images, missing } = await collectImages(entries, {
        group: seasonKey,
        getImage: async ({ group, url }) => {
          let r = null;
          try {
            r = await platform.getCoverImage({ group, url });
          } catch {
            r = null;
          }
          if (r?.dataUrl) return r;

          // 原图没拿到，退到缓存里那一档。这里**故意**用 readOnly：
          // 原图失败多半就是断网，再联网取只会白等一轮超时。
          const fb = fallbackOf.get(url);
          if (!fb) return r;
          try {
            const alt = await platform.getCoverImage({ group, url: fb, readOnly: true });
            if (alt?.dataUrl) softCount += 1;
            return alt;
          } catch {
            return null;
          }
        },
      });

      if (!images.size && !tierlist.items.length) {
        pushToast('还没排过', '先把番剧拖进档位再导出');
        setTierExporting(false);
        return;
      }

      const res = await exportTierlistPng({
        rows: tierlist.rows,
        items: tierlist.items,
        images,
        itemSize: tierlist.itemSize,
        title: `${seasonLabel(seasonKey)} Tier List`,
        subtitle: `共 ${tierlist.items.length} 部 · 次回 jikai`,
        metaOf: (key) => {
          const a = byId.get(String(key));
          const name = a?.titleZh || a?.titleJa || '';
          return { name, seed: name || key };
        },
      });

      if (!res.ok) {
        pushToast('导出失败', res.error ?? '渲染没成功');
        setTierExporting(false);
        return;
      }

      await platform.saveBinaryFile({ name: `jikai-tier-${seasonKey}.png`, dataUrl: res.dataUrl });

      const parts = [];
      if (res.degraded && res.reason) parts.push(res.reason);
      if (softCount) parts.push(`${softCount} 张用的是缩略图（原图没取到）`);
      if (missing.length) parts.push(`${missing.length} 张封面没取到，画成了色块`);
      parts.push(`${res.width}×${res.height} · ${res.scale}x · 约 ${Math.round((res.bytes ?? 0) / 1024)} KB`);
      setTierNote(parts.join(' · '));
      pushToast('已导出 PNG', `${res.width}×${res.height} · ${res.scale}x`);
    } catch (err) {
      pushToast('导出失败', err?.message ?? String(err));
    } finally {
      setTierExporting(false);
    }
  }, [seasonKey, tierlist, season, pushToast]);

  const handleExportPresets = useCallback(async () => {
    const payload = exportLayoutPresets();
    await platform.saveTextFile({ name: 'jikai-layout-presets.json', text: JSON.stringify(payload, null, 2) });
  }, []);

  /**
   * 导出备份。
   *
   * 走和「导出布局预设」同一条通道（弹保存框、渲染层给内容），
   * 所以这里不需要任何新的系统能力；真正要多一条通道的是**导入**（读文件）。
   */
  const handleExportBackup = useCallback(async () => {
    setTransferBusy('export');
    setTransferNote('');
    try {
      const snapshotState = exportableState();
      const payload = buildTransfer(snapshotState, { appVersion: appInfo?.version ?? '' });
      const name = transferFileName();
      await platform.saveTextFile({ name, text: JSON.stringify(payload, null, 2) });
      const line = `已导出 ${name}：${describeCounts(payload.counts)}`;
      setTransferNote(line);
      pushToast('备份已导出', `${describeCounts(payload.counts)} · 在另一台机器上导入即可`);
    } catch (err) {
      const msg = err?.message ?? String(err);
      // 「已取消」不是错误：用户只是改了主意，弹一条红色提示反而莫名其妙
      if (msg.includes('取消')) { setTransferNote('已取消导出'); return; }
      setTransferNote(`导出失败：${msg}`);
      pushToast('导出失败', msg);
    } finally {
      setTransferBusy('');
    }
  }, [appInfo?.version, pushToast]);

  /**
   * 选一份备份读进来。**这一步只读到「待确认」为止，不动数据。**
   *
   * 覆盖是破坏性的，所以拆成两步：先把两边各有多少条摆给用户看（confirmImport），
   * 他点确认才真的写。中途任何一步出问题都停在原地，本机的记录一条不动。
   */
  const handlePickBackup = useCallback(async () => {
    setTransferBusy('import');
    setTransferNote('');
    try {
      const picked = await platform.pickTextFile();
      if (!picked?.ok) {
        if (picked?.error !== '已取消') {
          setTransferNote(`读文件失败：${picked?.error ?? '未知原因'}`);
          pushToast('没能读取这个文件', picked?.error ?? '');
        }
        return;
      }
      const parsed = parseTransfer(picked.text);
      if (!parsed.ok) {
        setTransferNote(`「${picked.name}」不是能用的备份：${parsed.error}`);
        pushToast('这不是一份能用的备份', parsed.error);
        return;
      }
      setTransferPending({
        fileName: picked.name,
        incoming: parsed.payload,
        mine: transferCounts(exportableState()),
        theirs: transferCounts(parsed.payload.state),
      });
    } catch (err) {
      const msg = err?.message ?? String(err);
      setTransferNote(`读文件失败：${msg}`);
      pushToast('读文件失败', msg);
    } finally {
      setTransferBusy('');
    }
  }, [pushToast]);

  /** 用户确认之后才真的写：先自动备份现在的记录，再整份替换 */
  const handleConfirmImport = useCallback(async () => {
    const pending = transferPending;
    if (!pending) return;
    setTransferBusy('import');
    try {
      const snapshotState = exportableState();
      const backup = await platform.writeStateBackup({
        name: `backup-import-${Date.now()}.json`,
        text: JSON.stringify(buildTransfer(snapshotState, { appVersion: appInfo?.version ?? '' }), null, 2),
      });
      if (!backup?.ok) {
        /*
         * ⚠️ 备份没成功就**不许往下走**。
         * 这一步是这次覆盖唯一的退路；退路没铺好还把数据盖掉，
         * 那就是真的丢了。宁可让用户再点一次。
         */
        const msg = backup?.error ?? '写不进去';
        setTransferNote(`导入中止：自动备份没成功（${msg}）—— 记录一条没动，换个地方再试`);
        pushToast('导入中止', '自动备份没成功，为保险起见没有覆盖你的记录');
        return;
      }

      importState(pending.incoming.state);
      setTransferPending(null);
      const where = backup.where ?? backup.path ?? '程序的数据目录';
      const line = `已从「${pending.fileName}」导入：${describeCounts(pending.theirs)}`
        + ` · 覆盖前的记录已另存：${where}`;
      setTransferNote(line);
      pushToast('记录已导入', `${describeCounts(pending.theirs)} · 覆盖前的记录已另存一份`);
    } catch (err) {
      const msg = err?.message ?? String(err);
      setTransferNote(`导入失败：${msg}`);
      pushToast('导入失败', msg);
    } finally {
      setTransferBusy('');
    }
  }, [transferPending, appInfo?.version, pushToast]);

  // ---------- 托盘摘要：每次数据或视图变化就推给主进程 ----------
  useEffect(() => {
    if (!ready) return;
    platform.setTrayState?.({
      view,
      todayCount: todayCount,
      followingCount: Object.keys(st.following).length,
      catchupCount: activeCatchup.length,
      overdueCount: overdueCount,
      version: appInfo?.version,
      autoLaunch: autoLaunch?.openAtLogin,
      closeToTray: st.settings.tray?.closeToTray,
      minimizeToTray: st.settings.tray?.minimizeToTray,
      updateText: updateState.result?.hasUpdate ? `有新版本 ${updateState.result.latest}，点这里看` : null,
      // 托盘菜单里那一项「检查更新」跟设置面板共用同一个开关：
      // 入口藏了，右键菜单里也不该还留着一个点了没用的项。
      showUpdate: isVisible('autoUpdate'),
      nextUpdate: nextUpcomingText,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, view, season, st.following, st.catchup, appInfo, autoLaunch, updateState.result]);

  // ---------- 主进程来的命令（托盘点击等） ----------
  useEffect(() => {
    const off = platform.onCommand?.((cmd) => {
      if (!cmd) return;
      if (cmd.type === 'navigate') goView(cmd.view);
      else if (cmd.type === 'open-settings') openSettings('system');
      else if (cmd.type === 'check-update') handleCheckUpdate();
      else if (cmd.type === 'open-update') {
        const url = updateState.result?.url ?? stRef.current.settings.update?.lastResult?.url;
        if (url) platform.openExternal(url);
        else openSettings('system');
      } else if (cmd.type === 'autolaunch-changed') {
        platform.getAutoLaunch().then(setAutoLaunch);
      }
    });
    return () => off?.();
  }, [goView, openSettings, handleCheckUpdate, updateState.result?.url]);

  // ---------- 快捷键 ----------
  useEffect(() => {
    const onKey = (e) => {
      if (stRef.current.settings.hotkeysEnabled === false) return;
      const spec = normalizeEvent(e);
      if (!spec) return;
      const hits = lookup(spec);
      if (!hits.length) return;
      if (!shouldHandle(spec, e, e.target)) return;

      const id = hits[0].id;
      const actions = {
        'view-season': () => goView('season'),
        'view-schedule': () => goView('schedule'),
        'view-following': () => goView('following'),
        'view-catchup': () => goView('catchup'),
        'focus-search': () => globalThis.document?.querySelector('[data-search-input]')?.focus(),
        sync: () => loadData(seasonKey, { live: true }),
        'clear-search': () => {
          if (drawer) setDrawer(null);
          else if (settingsOpen) setSettingsOpen(false);
          else if (helpOpen) setHelpOpen(false);
          else setKeyword('');
        },
        'cycle-theme': cycleTheme,
        'toggle-wallpaper': toggleWallpaper,
        'open-presets': () => openSettings('layout'),
        'open-settings': () => openSettings('look'),
        'open-settings-ctrl': () => openSettings('look'),
        help: () => setHelpOpen((v) => !v),
        reload: () => globalThis.location?.reload(),
      };
      const run = actions[id];
      if (!run) return;
      e.preventDefault();
      run();
    };
    globalThis.window?.addEventListener('keydown', onKey);
    return () => globalThis.window?.removeEventListener('keydown', onKey);
  }, [goView, loadData, seasonKey, drawer, settingsOpen, helpOpen, cycleTheme, toggleWallpaper, openSettings]);

  // ---------- 派生数据 ----------
  /*
   * 全部可选季度（2000 年至今，新的在前）。
   *
   * ⚠️ 这里原来用的是 `availableSeasons(now)` —— 它**写死只返回 9 季**，
   * 于是顶栏切季度和「更新数据」勾季度都只能选到最近两年，
   * 2011 年 7 月番根本选不到。`availableSeasons` 现在只用来算「最近四季」这类默认值。
   */
  const seasons = useMemo(() => allSeasons(now), [now]);

  const filteredSeason = useMemo(() => {
    const k = keyword.trim().toLowerCase();
    if (!k) return season;
    return season.filter((a) =>
      [a.titleZh, a.titleJa, a.studio, ...(a.tags ?? [])]
        .filter(Boolean)
        .some((s) => String(s).toLowerCase().includes(k)),
    );
  }, [season, keyword]);

  const followingRows = useMemo(() => {
    const list = season.filter((a) => st.following[a.id]);
    return list
      .map((a) => {
        const f = st.following[a.id] ?? {};
        const ws = watchState(a, f.watchedEps ?? 0, now);
        return {
          anime: a,
          watched: f.watchedEps ?? 0,
          status: f.status ?? 'watching',
          ws,
          next: ws.next,
          cd: ws.next.ms != null ? countdown(ws.next.ms, now) : null,
        };
      })
      .sort((x, y) => (x.next.ms ?? Number.MAX_SAFE_INTEGER) - (y.next.ms ?? Number.MAX_SAFE_INTEGER));
  }, [season, st.following, now]);

  const todayItems = useMemo(() => {
    const week = buildWeek(season, now);
    const today = week.find((d) => d.isToday);
    return today ? today.items : [];
  }, [season, now]);
  const todayCount = todayItems.length;

  // 「接下来 7 天」只放还没到的更新；已经播过的属于「该补了」，不该混在这里
  const weekAhead = useMemo(() => upcomingWithin(followingRows, now), [followingRows, now]);

  const nextUpcomingText = useMemo(() => {
    const hit = weekAhead[0];
    if (!hit?.cd) return null;
    const label = countdownLabel(hit.cd);
    return `${label.value}${label.unit}后 ${hit.anime.titleZh || hit.anime.titleJa} 更新`;
  }, [weekAhead]);

  // 补番卡片可能指向别的季度（甚至是内置数据里那几季之外的老番），
  // 所以查条目的池子要放宽到「当前季 + 内置的全部季度」，
  // 否则补番列表里会出现「有卡片、没名字」的行。
  const pool = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const a of [...season, ...allBuiltinItems()]) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      out.push(a);
    }
    return out;
  }, [season]);

  /**
   * 补番卡片 ⟶ 条目。
   *
   * 查不到的情况在过去会让整张卡消失（原来的写法是 .filter(r => r.anime)），
   * 那正是「补番名单记不住」的根因。现在按优先级找：
   *   季度数据（字段最新）→ 作品档案（离线也在）→ 临时占位（至少有名字可显示）
   *
   * 占位不是为了粉饰，是为了让入口不丢：卡片还在，上面写着「待补全」，
   * 用户点一次「更新 Bangumi 数据」就能把它补上。
   */
  const catchupRows = useMemo(
    () => sortCatchup(st.catchup, now)
      .map((item) => {
        const id = Number(item.subjectId);
        const anime = pool.find((a) => a.id === id) ?? st.subjects?.[id] ?? null;
        if (anime) return { item, anime };
        return {
          item,
          anime: { id, titleZh: '', titleJa: `条目 ${id}`, cover: null, eps: null, __missing: true },
        };
      }),
    [st.catchup, st.subjects, pool, now],
  );

  const activeCatchup = catchupRows.filter((r) => !r.item.archived);

  // ---------- 补番日记 ----------

  /**
   * id ⟶ 条目。日记里记的可能是任意一季的番，所以查找范围比 catchupRows 宽：
   * 全量内置数据 + 作品档案。
   *
   * 找不到时**返回占位条目而不是 null**：`compareToBangumi` 靠 `subject.score`
   * 判断有没有 Bangumi 评分，占位条目的 score 是 null，正好落进「还差一边」那一档。
   * 返回 null 也能work，但界面就得在两处各写一遍兜底，迟早漏一处。
   */
  const diaryLookup = useMemo(() => {
    const map = new Map();
    for (const a of pool) map.set(Number(a.id), a);
    for (const [id, a] of Object.entries(st.subjects ?? {})) {
      if (!map.has(Number(id))) map.set(Number(id), a);
    }
    return (key) => map.get(Number(key))
      ?? { id: Number(key), titleZh: '', titleJa: `条目 ${key}`, cover: null, score: null, __missing: true };
  }, [pool, st.subjects]);

  /**
   * 顶栏搜索的「本季之外」补充。
   *
   * 主区域那个列表只按本季过滤，搜一部老番时它通常是空的 —— 而全量名称索引
   * （八千多部，含中/日/英名）早就在本地了，只是以前只服务「加入补番」这一个动作。
   * 这里拿它再搜一遍，把不在本季的命中交给下拉，于是「搜到任何一部番」才成立。
   *
   * limit 给 40 而不是直接取 8：本季命中若排在前面，别季的会被挤掉，
   * 而分开统计正是 splitHits 干的事（它先按季过滤再取前 N）。
   */
  const searchSplit = useMemo(() => {
    const q = keyword.trim();
    if (!q || !nameIndex?.entries?.length) return { others: [], inSeason: 0 };
    const ids = new Set(season.map((a) => Number(a.id)));
    return splitHits(searchNames(nameIndex, q, { limit: 40 }), ids, { othersLimit: 8 });
  }, [keyword, nameIndex, season]);

  const searchReady = Boolean(nameIndex?.entries?.length);

  /**
   * 点开一条跨季搜索结果。
   *
   * 本地有完整条目就用它；没有（老番常常是这种）就用索引里那点信息拼一个最小条目 ——
   * 抽屉对空字段有兜底，名字、平台、外链是对的，够用户确认「是不是这部」并跳去 Bangumi。
   * 直接用 diaryLookup 的话会拿到 `__missing` 占位，界面上只剩一句「条目 12345」。
   */
  const handlePickSearch = useCallback((hit) => {
    const local = diaryLookup(hit.id);
    setDrawer(local?.__missing ? stubFromHit(hit) : local);
  }, [diaryLookup]);

  const diaryData = readDiary();

  const handleSaveDiary = useCallback((id, { rating, note }) => {
    const res = addDiaryEntry(id, { rating, note, at: Date.now() });
    // 失败（既没评分也没内容 / id 不可用）要把理由交给控件显示 ——
    // 静默丢掉用户刚打的字是最不能接受的失败方式
    if (res.ok) pushToast('记进补番日记了', '在「补番日记」里能看到跟 Bangumi 的比对');
    return res;
  }, [pushToast]);

  const handleRemoveDiary = useCallback((id, at) => {
    removeDiaryEntry(id, at);
  }, []);

  /*
   * 番堂那页的日记输入：能对上库的条目，直接在排播表旁边打分写短评。
   *
   * ⚠️ 必须放在 handleSaveDiary / handleRemoveDiary **之后**：它们是用 const 声明的，
   * 而 useMemo 的工厂函数是**当场就跑**的，写在前面会在渲染时踩到暂时性死区
   * （报的错是「Cannot access before initialization」，看不出是顺序问题）。
   *
   * 写在哪都要走 store 那同一套（评分 1-10 整数、一部可以有多条记录），
   * 所以这里只做「把输入接过去」，不另起一套。
   */
  const yucDiary = useMemo(() => {
    const lib = yucSel ? (yucMatched.get(yucSel.id) ?? null) : null;
    if (!lib) return null;
    return (
      <DiaryRatingInput
        id={lib.id}
        rating={myRatingOf(lib.id)}
        note={readLatestRated(lib.id)?.note ?? ''}
        bgmScore={lib.score ?? null}
        count={readDiaryOf(lib.id).length}
        lastEntryAt={readLatestRated(lib.id)?.at ?? null}
        compact
        onSave={(payload) => handleSaveDiary(lib.id, payload)}
        onRemove={(at) => handleRemoveDiary(lib.id, at)}
        onOpenDiary={() => goView('diary')}
      />
    );
  }, [yucSel, yucMatched, handleSaveDiary, handleRemoveDiary, goView]);

  // ---------- 季度报告长图 ----------
  //
  // 存法跟 Tier List 一样：按季度各存一份在 `state.json` 的 `reports` 里，
  // 读的时候过一遍 `normalizeReport`（`readReport` 里做的），所以磁盘上被旧版
  // 写脏、被手改坏的块都进不到界面层。
  //
  // 块的增删改序全部在 `core/report.js` 的纯函数里算完，再用 `setReportBlocks`
  // 一步写回 —— 不用「patchReport({ blocks })」是因为「先读、改、再写」这两步
  // 之间如果被别的地方插进来一次写，改动就悄悄丢了。
  const report = useMemo(
    () => ensureReport(seasonKey),
    // st.reports 每次 patch 都是新对象，靠它触发重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [seasonKey, st.reports],
  );

  /**
   * 报告里真正用到的作品（封面墙 + 奖项关联）。
   *
   * 门槛必须按**报告自己用到的**算，不能拿整季去算：整季 82 部里总有几张
   * 还没缓存，那样每一份报告都会被判成「缺图」而永远导不出去。
   */
  const reportCoverEntries = useMemo(() => {
    const ids = new Set();
    for (const b of report?.blocks ?? []) {
      if (b.type === 'wall') for (const id of b.subjectIds) ids.add(id);
      if (b.type === 'award' && b.subjectId) ids.add(b.subjectId);
    }
    return [...ids].map((key) => {
      const a = diaryLookup(key);
      return { key, url: a?.cover ? coverVariant(a.cover, DISPLAY_VARIANT).url : '' };
    });
  }, [report, diaryLookup]);

  // 没有封面地址的作品（查不到的条目）本来就不该算进缺图 —— 它们画出来就是占位块，
  // 跟「有地址但没缓存下来」是两回事。
  const reportCoverage = useMemo(
    () => coverCoverage(reportCoverEntries.filter((e) => e.url), poolCovers.images),
    [reportCoverEntries, poolCovers.images],
  );

  /**
   * 加一块。
   *
   * 每类都给一个「不那么空」的初值：加一块封面墙出来是 0 张的话，
   * 「空态」和「还没挑」在界面上一模一样，用户不知道该干什么。
   */
  const handleAddBlock = useCallback((type) => {
    const list = report?.blocks ?? [];
    const id = nextBlockId(list);
    const seed = {
      header: { title: `${seasonLabel(seasonKey)} 季度报告`, subtitle: `共 ${season.length} 部 · 次回 jikai` },
      wall: { title: '本季封面墙', subjectIds: autoWallSubjects(season, WALL_DEFAULT_COUNT) },
      award: { title: '最佳作画', body: '' },
      text: { body: '' },
    }[type] ?? {};
    const block = makeBlock(type, { id, ...seed });
    if (!block) return null;
    setReportBlocks(seasonKey, addBlock(list, block));
    setReportSel(block.id);
    return block.id;
  }, [report, seasonKey, season]);

  const handleRemoveBlock = useCallback((id) => {
    setReportBlocks(seasonKey, removeBlock(report?.blocks ?? [], id));
    setReportSel((cur) => (cur === id ? null : cur));
  }, [seasonKey, report]);

  const handlePatchBlock = useCallback((id, patch) => {
    setReportBlocks(seasonKey, patchBlock(report?.blocks ?? [], id, patch));
  }, [seasonKey, report]);

  const handleMoveBlock = useCallback((from, to) => {
    setReportBlocks(seasonKey, moveBlock(report?.blocks ?? [], from, to));
  }, [seasonKey, report]);

  /**
   * 素材面板点一下 = 进封面墙。
   *
   * `wallId` 为空表示「此刻没有选中任何一块封面墙」，那就**新建一堵**再放进去 ——
   * 比弹一句「请先选中一块封面墙」友好得多，而后者正是最常见的第一次点击。
   */
  const handleAddToWall = useCallback((subjectId, wallId) => {
    const list = report?.blocks ?? [];
    const id = String(subjectId);
    const target = wallId ? blockById(list, wallId) : null;

    if (target) {
      if (target.subjectIds.includes(id)) return; // 已经在这堵墙里，点了不该重复
      if (target.subjectIds.length >= WALL_MAX) {
        pushToast('这一墙满了', `一堵最多 ${WALL_MAX} 部，再开一块吧`);
        return;
      }
      setReportBlocks(seasonKey, patchBlock(list, target.id, { subjectIds: [...target.subjectIds, id] }));
      return;
    }

    const block = makeBlock('wall', { id: nextBlockId(list), title: '本季封面墙', subjectIds: [id] });
    if (!block) return;
    setReportBlocks(seasonKey, addBlock(list, block));
    setReportSel(block.id);
  }, [seasonKey, report, pushToast]);

  const handleResetReport = useCallback(() => {
    resetReport(seasonKey);
    setReportSel(null);
    pushToast('已清空', `${seasonLabel(seasonKey)} 的季度报告`);
  }, [seasonKey, pushToast]);

  // 换季度要把选中清掉。不清的话，块的 id 是按「现有最大值 +1」发的 ——
  // 换个季度第一块又是 `b-1`，于是新季度一开局就有一块莫名其妙是选中态。
  useEffect(() => { setReportSel(null); }, [seasonKey]);

  /**
   * 导出长图。
   *
   * 这里只做两件事：把画布那份 DOM + 全部样式拼成一份自包含 HTML，
   * 然后交给主进程。**排版不在这一步发生** —— 导出窗口里渲染的就是画布本身，
   * 所以「预览好看、导出走样」在结构上就不可能。
   *
   * 缺图不让导（按钮直接是灰的，见 ReportView 的 `canExport`）：一张缺了十几张
   * 封面的墙看着只是「没那么好看」，用户会直接发出去，然后被人指出来。
   */
  const handleExportReport = useCallback(async (kind) => {
    setReportExporting(true);
    setReportNote('');
    setReportProgress({ pct: 0.04, label: '准备导出' });
    const offProgress = platform.onReportProgress?.((p) => {
      if (p && Number.isFinite(p.pct)) setReportProgress({ pct: p.pct, label: p.label ?? '' });
    });
    try {
      const canvas = canvasHtmlOf(document);
      if (!canvas) {
        pushToast('找不到画布', '切到「季度报告」再试一次');
        return;
      }
      const { css, unread } = collectStyles();
      const width = report?.width ?? 1220;
      const html = buildReportHtml({
        canvasHtml: canvas,
        css,
        width,
        title: `${seasonLabel(seasonKey)} 季度报告`,
      });

      const res = await platform.reportExport({ kind, html, width, name: `jikai-report-${seasonKey}` });
      if (!res?.ok) {
        pushToast('导出失败', res?.error ?? '主进程没给出结果');
        return;
      }

      const bits = [`${Math.round((res.bytes ?? 0) / 1024)} KB`];
      if (kind === 'png') {
        bits.push(`${res.width}×${res.height}`);
        // 「降过比例」必须说出来：否则用户拿到一张糊图会以为是 bug，
        // 而实际上是因为长图撞了 canvas 的单边上限。
        if (res.degraded) bits.push(`撞到画布单边上限，降到 ${Number(res.scale).toFixed(2)}x`);
      } else {
        bits.push(`${res.contentHeight}px 高 · 单页`);
      }
      if (unread.length) bits.push(`没带上 ${unread.length} 份外链样式`);
      setReportNote([res.path, ...bits].filter(Boolean).join(' · '));
      pushToast(kind === 'png' ? '已导出 PNG' : '已导出 PDF', bits.join(' · '));
    } catch (err) {
      pushToast('导出失败', err?.message ?? String(err));
    } finally {
      if (typeof offProgress === 'function') offProgress();
      setReportProgress(null);
      setReportExporting(false);
    }
  }, [report, seasonKey, pushToast]);

  /**
   * 导出文件包：报告 + 备份 + 说明，收进**一个目录**。
   *
   * 和上面那个「导出备份」的区别只是形状不同，不是功能不同 ——
   * 一个是「一个 json 文件」，一个是「一个可以整个拖走的文件夹」。
   * 要发给别人、或者搬到另一台机器时，后者不用自己记「哪几个文件是这次的」。
   *
   * 报告那一块只有在**报告页正开着**的时候才拿得到：导出的是画布本身，
   * 而画布是当前 DOM 里的东西。拿不到就不带，并且在说明里写清楚为什么 ——
   * 静悄悄少一个文件，用户会以为导出坏了。
   */
  const handleExportBundle = useCallback(async () => {
    setTransferBusy('bundle');
    setTransferNote('');
    try {
      const snapshotState = exportableState();
      const payload = buildTransfer(snapshotState, { appVersion: appInfo?.version ?? '' });
      const counts = payload.counts;

      const canvas = canvasHtmlOf(document);
      const images = [];
      let reportSkipped = '';
      if (canvas && report) {
        const { css } = collectStyles();
        const width = report.width ?? 1220;
        images.push({
          name: `季度报告-${seasonKey}.pdf`,
          kind: 'pdf',
          width,
          html: buildReportHtml({
            canvasHtml: canvas,
            css,
            width,
            title: `${seasonLabel(seasonKey)} 季度报告`,
          }),
        });
      } else {
        reportSkipped = '这份文件包里没有报告长图（导出的时候没在报告页）。想要它，切到「季度报告」那一页再导一次。';
      }

      const folder = bundleFolderName();
      const readme = bundleReadme({
        counts,
        seasonName: seasonLabel(seasonKey),
        hasReport: images.length > 0,
        appVersion: appInfo?.version ?? '',
        note: reportSkipped,
      });

      const res = await platform.exportBundle({
        folder,
        files: [
          { name: '数据备份.json', text: JSON.stringify(payload, null, 2) },
          { name: '说明.txt', text: readme },
        ],
        images,
      });

      if (!res?.ok) {
        const msg = res?.error ?? '主进程没给出结果';
        if (msg.includes('取消')) { setTransferNote('已取消导出'); return; }
        setTransferNote(`导出文件包失败：${msg}`);
        pushToast('导出失败', msg);
        return;
      }

      const line = `已导出到 ${res.dir}\n${describeCounts(counts)} · ${(res.files ?? []).map((f) => f.name).join(' / ')}`;
      setTransferNote(line);
      pushToast('文件包已导出', `${describeCounts(counts)} · ${(res.files ?? []).length} 个文件`);
    } catch (err) {
      const msg = err?.message ?? String(err);
      if (msg.includes('取消')) { setTransferNote('已取消导出'); return; }
      setTransferNote(`导出文件包失败：${msg}`);
      pushToast('导出失败', msg);
    } finally {
      setTransferBusy('');
    }
  }, [appInfo?.version, report, seasonKey, pushToast]);

  const overdueCount = activeCatchup.filter(
    (r) => deadlineStatus(r.item.deadline, now).level === 'overdue',
  ).length;

  const counts = {
    season: filteredSeason.length,
    following: Object.keys(st.following).length,
    catchup: activeCatchup.length,
  };

  const Stat = ({ value, label, tone }) => (
    <div className={`stat${tone ? ` stat--${tone}` : ''}`}>
      <div className="stat__value">{value}</div>
      <div className="stat__label">{label}</div>
    </div>
  );

  return (
    // 封面解析走上下文：七个用到 <Cover> 的地方不用各自去接缓存，
    // 也就不用各自决定「该用哪一档地址」—— 那正是 v1.1 桌面端出错的机制。
    <CanvasScaleProvider value={canvasFit}>
    <CoverProvider images={coverImages} allowRemote={coversRemote}>
    <ScaleDockProvider onToggle={() => setScaleOpen((v) => !v)}>
    <div className="app">
      <WallpaperLayer wallpaper={{ ...st.settings.wallpaper, dataUrl: wallpaper?.dataUrl ?? null }} />

      <SideNav
        view={view}
        onView={goView}
        counts={counts}
        version={appInfo?.version}
        onOpenSettings={() => openSettings('look')}
      />

      <main className="main">
        <TopBar
          view={view}
          seasonKey={seasonKey}
          seasons={seasons}
          onSeason={setSeasonKey}
          keyword={keyword}
          onKeyword={setKeyword}
          searchOthers={searchSplit.others}
          searchInSeason={searchSplit.inSeason}
          searchReady={searchReady}
          onPickSearch={handlePickSearch}
          onRefresh={() => loadData(seasonKey, { live: true })}
          syncing={syncing}
          progress={progressPct}
          dataSource={st.settings.dataSource}
          onDataSource={(v) => {
            patchSettings({ dataSource: v });
            pushToast(
              '数据源已切换',
              v === 'builtin' ? `已切到内置数据（${BUILTIN_SEASONS.join(' / ')}）` : '点「同步数据」拉取最新排播表',
            );
          }}
          onOpenSettings={() => openSettings('look')}
          themeId={st.settings.theme}
          onCycleTheme={cycleTheme}
          wallpaperOn={Boolean(st.settings.wallpaper?.enabled && wallpaper?.dataUrl)}
          onToggleWallpaper={toggleWallpaper}
        />

        {syncing && progressLabel ? <div className="progresslabel">{progressLabel}</div> : null}

        {degraded ? (
          <div className="banner">
            <span className="banner__dot" />
            <span className="banner__text">{degradedText(degraded)}</span>
            <button type="button" className="btn btn--mini" onClick={() => openSettings('data')}>去设置</button>
            <button type="button" className="window__btn" title="知道了" onClick={() => setDegraded(null)}>✕</button>
          </div>
        ) : null}

        {!degraded && enrichNote ? (
          <div className="banner banner--info">
            <span className="banner__dot" />
            <span className="banner__text">{enrichNote}</span>
            <button type="button" className="window__btn" title="知道了" onClick={() => setEnrichNote(null)}>✕</button>
          </div>
        ) : null}

        <div className="canvas" ref={canvasRef}>
          {view === 'season' && (
            <>
              <WindowCard
                id="season-stats"
                title="本季概览"
                hint={seasonLabel(seasonKey)}
                layout={st.layout}
                /*
                 * `fitHeight`：高度由四个统计块撑出来，不滚动、不裁切。
                 * `h` 在这里是**占位**（它同时决定下面那张「番剧库」该从哪开始，
                 * 见 layoutPresets.js 的 SEASON_STATS_H），不是卡片真正的身高。
                 */
                fitHeight
                defaultRect={{ x: 16, y: 16, w: 1260, h: SEASON_STATS_H }}
              >
                <div className="stat-row">
                  <Stat value={filteredSeason.length} label="本季番剧" />
                  <Stat value={counts.following} label="我在追" tone="accent" />
                  <Stat value={todayCount} label="今天更新" tone="teal" />
                  <Stat value={activeCatchup.length} label="待补番剧" />
                </div>
              </WindowCard>

              <WindowCard
                id="season-grid"
                title="番剧库"
                hint="点封面右上角星标追番"
                layout={st.layout}
                defaultRect={{ x: 16, y: 16 + SEASON_STATS_H + SEASON_STATS_GAP, w: 1260, h: 622 }}
              >
                <SeasonView
                  season={filteredSeason}
                  following={st.following}
                  now={now}
                  onToggle={toggleFollow}
                  onOpen={setDrawer}
                  cardMin={cardMinScaled(st.settings.cardMin, uiAuto)}
                  onCardMin={(v) => patchSettings({ cardMin: v })}
                />
              </WindowCard>
            </>
          )}

          {view === 'schedule' && (
            <>
              <WindowCard
                id="sched-week"
                title="播出时间表"
                hint="按北京时间归组"
                layout={st.layout}
                defaultRect={{ x: 16, y: 16, w: 990, h: 660 }}
              >
                <ScheduleView season={filteredSeason} following={st.following} now={now} onOpen={setDrawer} />
              </WindowCard>

              <WindowCard
                id="sched-today"
                title="今日更新"
                hint={`${todayCount} 部`}
                layout={st.layout}
                defaultRect={{ x: 1020, y: 16, w: 256, h: 660 }}
              >
                {todayItems.length === 0 ? (
                  <div className="empty">今天没有排播</div>
                ) : (
                  <div className="day-list">
                    {todayItems.map((it) => (
                      <button
                        key={`${it.anime.id}-${it.episode}`}
                        type="button"
                        className={`day-row${st.following[it.anime.id] ? ' day-row--follow' : ''}`}
                        onClick={() => setDrawer(it.anime)}
                      >
                        <span className="day-row__time">{clockCST(it.ms)}</span>
                        <span className="day-row__main">
                          <span className="day-row__title">{it.anime.titleZh || it.anime.titleJa}</span>
                          <span className="day-row__meta">第 {it.episode} 话</span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </WindowCard>
            </>
          )}

          {/*
            番堂排播：长门番堂（yuc.wiki）整理好的当季全量排播表。
            它**不是**第四个数据源（那份数据没有 bgm id、没有评分），所以单开一页，
            只在能对上的条目上标一个「已收入」，并给一条通回 Bangumi 详情的出口。
          */}
          {view === 'yuc' && (
            <>
              <WindowCard
                id="yuc-board"
                title="番堂排播"
                hint={seasonLabel(seasonKey)}
                layout={st.layout}
                defaultRect={{ x: 16, y: 16, w: 940, h: 660 }}
              >
                <YucView
                  data={yuc.data}
                  status={yuc.status}
                  error={yuc.error}
                  stale={yuc.stale}
                  seasonKey={yucSeasonKey}
                  seasonLabel={seasonLabel(yucSeasonKey)}
                  seasons={yucSeasons}
                  onSeason={setYucSeasonPick}
                  selectedId={yucSel?.id ?? null}
                  onSelect={setYucSel}
                  matched={yucMatched}
                  onReload={yuc.reload}
                />
              </WindowCard>

              <WindowCard
                id="yuc-detail"
                title="作品资料"
                hint={yucSel ? yucSel.groupLabel : '点左边一条'}
                layout={st.layout}
                defaultRect={{ x: 970, y: 16, w: 306, h: 660 }}
              >
                <YucDetail
                  item={yucSel}
                  lib={yucSel ? (yucMatched.get(yucSel.id) ?? null) : null}
                  now={now}
                  remindOn={Boolean(yucSel && st.following?.[(yucMatched.get(yucSel.id) ?? {}).id]?.airHint)}
                  onToggleRemind={handleYucRemind}
                  diarySlot={yucDiary}
                  onOpenLibrary={setDrawer}
                />
              </WindowCard>
            </>
          )}

          {view === 'following' && (
            <>
              <WindowCard
                id="follow-queue"
                title="追番队列"
                hint="按更新时间排序 · 已更新的排最前"
                layout={st.layout}
                defaultRect={{ x: 16, y: 16, w: 940, h: 660 }}
              >
                <FollowingView
                  rows={followingRows}
                  now={now}
                  onOpen={setDrawer}
                  onMark={markEpisode}
                  onSetStatus={(id, status) => patchFollowing(id, { status })}
                  onUnfollow={unfollow}
                  onExternal={(url) => url && platform.openExternal(url)}
                />
              </WindowCard>

              <WindowCard
                id="follow-summary"
                title="接下来 7 天"
                hint="待看提醒"
                layout={st.layout}
                defaultRect={{ x: 970, y: 16, w: 306, h: 420 }}
              >
                {weekAhead.length === 0 ? (
                  <div className="empty">未来一周没有更新</div>
                ) : (
                  <div className="day-list">
                    {weekAhead.slice(0, 8).map((r) => {
                      const label = r.cd ? countdownLabel(r.cd) : null;
                      return (
                        <button
                          key={r.anime.id}
                          type="button"
                          className={`day-row${r.cd?.overdue ? ' day-row--follow' : ''}`}
                          onClick={() => setDrawer(r.anime)}
                        >
                          <span className="day-row__time">
                            {label ? `${label.value}${label.unit}` : '—'}
                          </span>
                          <span className="day-row__main">
                            <span className="day-row__title">{r.anime.titleZh || r.anime.titleJa}</span>
                            <span className="day-row__meta">第 {r.next.episode} 话</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </WindowCard>

              <WindowCard
                id="follow-next-week"
                title="追番分布"
                hint="本周哪天有更新"
                layout={st.layout}
                defaultRect={{ x: 970, y: 450, w: 306, h: 226 }}
              >
                <div className="weekbar">
                  {buildWeek(season.filter((a) => st.following[a.id]), now).map((d) => (
                    <div key={d.label} className={`weekbar__cell${d.isToday ? ' weekbar__cell--today' : ''}`}>
                      <span className="weekbar__day">{d.label.slice(1)}</span>
                      <span className={`weekbar__count${d.items.length ? ' weekbar__count--on' : ''}`}>
                        {d.items.length || '·'}
                      </span>
                    </div>
                  ))}
                </div>
              </WindowCard>
            </>
          )}

          {view === 'catchup' && (
            <>
              <WindowCard
                id="catchup-board"
                title="补番清单"
                hint={`${activeCatchup.length} 张卡 · 逾期优先`}
                layout={st.layout}
                defaultRect={{ x: 16, y: 16, w: 990, h: 660 }}
              >
                <CatchupView
                  rows={catchupRows}
                  now={now}
                  onOpen={setDrawer}
                  onPatch={patchCatchup}
                  onRemove={removeCatchup}
                  onMark={(id, eps) => patchCatchup(id, { watchedEps: eps })}
                  onExternal={(url) => url && platform.openExternal(url)}
                  searchQuery={catchupQuery}
                  onSearchQuery={setCatchupQuery}
                  results={catchupResults}
                  searchNote={searchNote}
                  onAddHit={addFromSearch}
                  renderDiary={(anime) => (
                    <DiaryRatingInput
                      id={anime.id}
                      rating={myRatingOf(anime.id)}
                      note={readLatestRated(anime.id)?.note ?? ''}
                      bgmScore={anime.score ?? null}
                      count={readDiaryOf(anime.id).length}
                      lastEntryAt={readLatestRated(anime.id)?.at ?? null}
                      onSave={(payload) => handleSaveDiary(anime.id, payload)}
                      onRemove={(at) => handleRemoveDiary(anime.id, at)}
                      onOpenDiary={() => goView('diary')}
                    />
                  )}
                />
              </WindowCard>

              <WindowCard
                id="catchup-summary"
                title="补番概览"
                layout={st.layout}
                defaultRect={{ x: 1020, y: 16, w: 256, h: 470 }}
              >
                <div className="stat-row">
                  <Stat value={activeCatchup.length} label="待补" />
                  <Stat value={overdueCount} label="已逾期" tone="danger" />
                </div>
                <div className="mini-list">
                  {activeCatchup.slice(0, 5).map((r) => {
                    const stx = deadlineStatus(r.item.deadline, now);
                    const left = progress(r.item).remaining;
                    return (
                      <div key={r.item.id} className="mini-row">
                        <div className="mini-row__main">
                          <div className="mini-row__title">{r.anime.titleZh || r.anime.titleJa}</div>
                          <div className="mini-row__meta">{left === 0 ? '已补完' : `还剩 ${left} 话`}</div>
                        </div>
                        <span className={`tag tag--${left === 0 ? 'normal' : stx.level}`}>
                          {left === 0 ? '已完成' : stx.label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </WindowCard>
            </>
          )}
          {view === 'diary' && (
            <WindowCard
              id="diary-book"
              title="补番日记"
              hint={`${Object.keys(diaryData).length} 部 · ${Object.values(diaryData).reduce((n, d) => n + (d?.entries?.length ?? 0), 0)} 条记录`}
              layout={st.layout}
              defaultRect={{ x: 16, y: 16, w: 1000, h: 720 }}
            >
              <DiaryView
                diary={diaryData}
                lookup={diaryLookup}
                now={now}
                onOpen={setDrawer}
                onRemove={handleRemoveDiary}
                onGoCatchup={() => goView('catchup')}
              />
            </WindowCard>
          )}
          {view === 'history' && (
            <WindowCard
              id="history-board"
              title="追番历程"
              hint="加入追番与推进进度时顺手记下的"
              layout={st.layout}
              defaultRect={{ x: 16, y: 16, w: 1000, h: 720 }}
            >
              <HistoryView
                following={st.following}
                diary={diaryData}
                // 复用日记那份「id ⟶ 条目」：历程里的番可能来自任意一季
                lookup={diaryLookup}
                now={now}
                onOpen={setDrawer}
                onGoSeason={() => goView('season')}
              />
            </WindowCard>
          )}
          {view === 'tier' && (
            <WindowCard
              id="tier-board"
              title="Tier List"
              hint={`${seasonLabel(seasonKey)} · 已排 ${tierlist.items.length} 部`}
              layout={st.layout}
              defaultRect={{ x: 16, y: 16, w: 1260, h: 700 }}
            >
              <TierListView
                seasonKey={seasonKey}
                tierlist={tierlist}
                pool={season}
                images={poolCovers.images}
                coversNote={coversNote}
                coversRemote={coversRemote}
                onPatch={(patch) => patchTierlist(seasonKey, patch)}
                onAutoRank={handleAutoRank}
                onReset={handleResetTier}
                onExport={handleExportTier}
                exporting={tierExporting}
                exportNote={tierNote}
              />
            </WindowCard>
          )}
          {view === 'report' && (
            <WindowCard
              id="report-board"
              title="季度报告"
              hint={`${seasonLabel(seasonKey)} · ${report?.blocks?.length ?? 0} 块`}
              layout={st.layout}
              defaultRect={{ x: 16, y: 16, w: 1280, h: 780 }}
            >
              <ReportView
                report={report}
                seasonKey={seasonKey}
                seasonLabel={seasonLabel(seasonKey)}
                pool={season}
                // 复用日记那份「id ⟶ 条目」：范围是全量内置数据 + 作品档案，
                // 所以报告里挂上一季的番也查得到；查不到的给占位条目，不返回 null
                lookup={diaryLookup}
                coverage={reportCoverage}
                note={reportNote}
                exporting={reportExporting}
                progress={reportProgress}
                keyword={reportKeyword}
                onKeyword={setReportKeyword}
                selectedId={reportSel}
                onSelectedId={setReportSel}
                onAddBlock={handleAddBlock}
                onRemoveBlock={handleRemoveBlock}
                onPatchBlock={handlePatchBlock}
                onMoveBlock={handleMoveBlock}
                onAddToWall={handleAddToWall}
                onExportPdf={() => handleExportReport('pdf')}
                onExportPng={() => handleExportReport('png')}
                onReset={handleResetReport}
              />
            </WindowCard>
          )}
        </div>
      </main>

      {drawer && (
        <DetailDrawer
          anime={drawer}
          following={Boolean(st.following[drawer.id])}
          watchedEps={st.following[drawer.id]?.watchedEps ?? 0}
          now={now}
          onClose={() => setDrawer(null)}
          onToggleFollow={() => toggleFollow(drawer.id)}
          onMarkEpisode={markEpisode}
          onAddCatchup={(a) => {
            // 把 anime 一起交给 store：这样这一部会被归档进作品档案并记入补番组，
            // 之后切到别的季度、甚至断网，这张卡也不会消失。
            addCatchup(a.id, { targetEps: a.eps ?? 12, deadline: Date.now() + 21 * MS_PER_DAY, anime: a });
            pushToast('已加入补番清单', `${a.titleZh || a.titleJa} · 默认 21 天内补完`);
          }}
          onOpenExternal={(url) => url && platform.openExternal(url)}
          renderDiary={(a) => (
            // ⚠️ `key` 不能省：抽屉是同一个组件实例装不同的番，
            // 没有 key 的话 React 会复用实例，草稿里的旧评分会跟着换到下一部上去。
            <DiaryRatingInput
              key={a.id}
              id={a.id}
              rating={myRatingOf(a.id)}
              note={readLatestRated(a.id)?.note ?? ''}
              bgmScore={a.score ?? null}
              count={readDiaryOf(a.id).length}
              lastEntryAt={readLatestRated(a.id)?.at ?? null}
              onSave={(payload) => handleSaveDiary(a.id, payload)}
              onRemove={(at) => handleRemoveDiary(a.id, at)}
              onOpenDiary={() => { setDrawer(null); goView('diary'); }}
            />
          )}
        />
      )}

      <SettingsPanel
        key={settingsTab}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        themeId={st.settings.theme}
        onTheme={(id) => patchSettings({ theme: id })}
        wallpaper={wallpaper}
        onPickWallpaper={pickWallpaper}
        onClearWallpaper={clearWallpaper}
        wallpaperBusy={wallpaperBusy}
        settings={st.settings}
        onDiagnose={handleDiagnose}
        diagnosing={diagnosing}
        diagnoseResult={diagnoseResult}
        apiTest={apiTest}
        onTestApi={handleTestApi}
        testingApi={testingApi}
        onApplyProxy={(proxy) => platform.setProxy?.(proxy)}
        updateState={updateState}
        onCheckUpdate={handleCheckUpdate}
        onOpenUpdate={() => {
          const url = updateState.result?.url;
          if (url) platform.openExternal(url);
          else pushToast('没有下载地址', '更新源里没给 url / assets');
        }}
        onExportPresets={handleExportPresets}
        appInfo={appInfo}
        autoLaunch={autoLaunch}
        onAutoLaunch={handleAutoLaunch}
        /*
         * 点了之后主进程会清掉降级标记再自己重启，所以这里不需要做任何收尾 ——
         * 但失败（比如浏览器壳）得让用户看见原因，不然就是「按了没反应」。
         */
        onRetryHardware={async () => {
          const r = await platform.retryHardware?.();
          if (r && r.ok === false) pushToast('没能换回硬件加速', r.error || '这个环境不支持');
        }}
        hotkeyInfo={hotkeyInfo}
        onGlobalHotkey={handleGlobalHotkey}
        onToast={pushToast}
        library={{
          seasons,
          nameIndex,
          coverStats,
          groups: listGroups(),
          running: libraryRunning,
          progress: libraryProgress,
          report: libraryReport,
          onRun: runLibrarySync,
          onClearCovers: clearCoverCache,
          onClearNameIndex: clearNameIndex,
        }}
        transfer={{
          busy: transferBusy,
          note: transferNote,
          pending: transferPending,
          onExport: handleExportBackup,
          onBundle: handleExportBundle,
          onImport: handlePickBackup,
          onConfirmImport: handleConfirmImport,
          onCancelImport: () => { setTransferPending(null); setTransferNote('已取消导入，本机记录一条没动'); },
        }}
      />

      <ShortcutsOverlay
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        globalHotkey={hotkeyInfo?.ok ? st.settings.globalHotkey : ''}
      />

      <Toasts toasts={toasts} />

      {/*
        浮在整窗右下角，而不是塞进某张卡片：这两个档位对所有页面的卡片一视同仁，
        放进哪张卡都会让人以为它只管那一张。
      */}
      <ScaleDock
        open={scaleOpen}
        cardMin={st.settings.cardMin}
        fontScale={st.settings.fontScale}
        onChange={(patch) => patchSettings(patch)}
        onClose={() => setScaleOpen(false)}
      />
    </div>
    </ScaleDockProvider>
    </CoverProvider>
    </CanvasScaleProvider>
  );
}
