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
import DetailDrawer from './components/DetailDrawer.jsx';
import SettingsPanel from './components/SettingsPanel.jsx';
import ShortcutsOverlay from './components/ShortcutsOverlay.jsx';
import WallpaperLayer from './components/WallpaperLayer.jsx';
import Toasts from './components/Toasts.jsx';
import { useStoreState } from './core/useStore.js';
import { searchNames } from './core/library.js';
import {
  addCatchup, archiveSubjects, exportLayoutPresets, flush, listGroups, load as loadStore, markEpisode,
  patchCatchup, patchFollowing, patchSettingSection, patchSettings, readSeasonCacheRaw,
  removeCatchup, toggleFollow, unfollow, writeSeasonCache,
  ensureTierlist, patchTierlist, resetTierlist,
  addDiaryEntry, removeDiaryEntry, readDiary, myRatingOf, readLatestRated, readDiaryOf,
} from './core/store.js';
import { compareToBangumi } from './core/diary.js';
import { autoRankByScore } from './core/tierlist.js';
import { collectImages, exportTierlistPng } from './core/tierExport.js';
import { DISPLAY_VARIANT, EXPORT_VARIANT, coverEntries, coverVariant } from './core/covers.js';
import { useCovers } from './core/useCovers.js';
import { platform } from './platform/index.js';
import { allBuiltinItems, builtinItems, BUILTIN_SEASONS } from './data/builtin/index.js';
import { availableSeasons, currentSeason, fetchCatalog } from './data/bangumiData.js';
import { describeSyncReport, syncLibrary } from './data/sync.js';
import { degradedText, loadSeason } from './data/sources.js';
import { diagnose, probeSubject } from './data/bangumiApi.js';
import { readImageFile } from './core/wallpaper.js';
import { evaluateUpdate, resolveManifestUrl } from './core/update.js';
import { isVisible } from './core/features.js';
import { lookup, normalizeEvent, shouldHandle } from './core/hotkeys.js';
import { THEMES } from './theme/themes.js';
import { applyTheme } from './theme/applyTheme.js';
import { MS_PER_DAY, clockCST, countdown, countdownLabel, seasonLabel, watchState } from './core/time.js';
import { buildWeek, upcomingWithin } from './core/schedule.js';
import { deadlineStatus, progress, sortCatchup } from './core/catchup.js';

// 这个常量和 SideNav 里的 ITEMS 是两处各写一份的 —— 加视图时两边都要改，
// 只改一处会出现「导航能点到、但深链刷新就跳回来」。
const VIEWS = ['season', 'schedule', 'following', 'catchup', 'diary', 'tier'];

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

    setSeason(res.items);
    setDegraded(res.degraded);

    if (res.degraded) {
      pushToast('数据源降级', degradedText(res.degraded));
    } else if (res.enrichStats && res.enrichStats.requested > 0) {
      const { ok, failed, requested } = res.enrichStats;
      setEnrichNote(`补全 ${ok}/${requested}${failed ? ` · ${failed} 条失败` : ''}`);
      pushToast('同步完成', `${seasonLabel(key)} 共 ${res.items.length} 部 · 补全 ${ok}/${requested}`);
    } else if (res.cached) {
      pushToast('用上了本地缓存', `${seasonLabel(key)} 共 ${res.items.length} 部`);
    } else {
      pushToast('同步完成', `${seasonLabel(key)} 共 ${res.items.length} 部`);
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
        const ws = watchState(a, f.watchedEps ?? 0, nowMs);
        if (ws.next.ms == null || ws.finished) continue;
        const delta = ws.next.ms - nowMs;
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
      patchSettingSection('wallpaper', { enabled: true, name: payload.name });
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
  const tierCoverEntries = useMemo(
    () => (view === 'tier' ? coverEntries(season, DISPLAY_VARIANT) : []),
    [season, view],
  );

  const tierCovers = useCovers({
    group: seasonKey,
    entries: tierCoverEntries,
    enabled: view === 'tier',
  });

  // 本地缓存通道用不了（浏览器壳），或这次一张都没取到 → 显示退回直连远端地址。
  // 桌面壳里绝不能这么做：那会先由浏览器下一遍 45MB，主进程再下一遍进缓存。
  //
  // `platform.kind` 是**同步**就知道的，所以浏览器壳一上来就走这一条 ——
  // 只等 `useCovers` 那个异步结论的话，首屏会先闪一片色块再换成图。
  const coversRemote = platform.kind === 'web' || !tierCovers.supported || Boolean(tierCovers.error);

  const coversNote = useMemo(() => {
    if (view !== 'tier') return '';
    if (!tierCovers.supported) return '浏览器里没有封面缓存，导出高清图请用桌面版';
    if (tierCovers.error) return tierCovers.error;
    if (tierCovers.progress) {
      const { phase, done, total } = tierCovers.progress;
      return `${phase === 'warm' ? '下载封面' : '读取封面'} ${done}/${total}`;
    }
    return '';
  }, [view, tierCovers.supported, tierCovers.error, tierCovers.progress]);

  const handleAutoRank = useCallback(() => {
    const { items, ranked, unranked } = autoRankByScore(tierlist.items, season, tierlist.rows);
    patchTierlist(seasonKey, { items });
    if (!ranked.length) pushToast('一部都没排进去', '这一季还没有评分数据，先手动排着');
    else pushToast('已按评分分档', `${ranked.length} 部进档 · ${unranked.length} 部没评分，留在池子里`);
  }, [seasonKey, tierlist, season, pushToast]);

  const handleResetTier = useCallback(() => {
    resetTierlist(seasonKey, { presetId: tierlist.presetId });
    pushToast('已清空', `${seasonLabel(seasonKey)} 的排布`);
  }, [seasonKey, tierlist.presetId, pushToast]);

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
  const seasons = useMemo(() => availableSeasons(now), [now]);

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
  }, []);  const overdueCount = activeCatchup.filter(
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

        <div className="canvas">
          {view === 'season' && (
            <>
              <WindowCard
                id="season-stats"
                title="本季概览"
                hint={seasonLabel(seasonKey)}
                layout={st.layout}
                defaultRect={{ x: 16, y: 16, w: 1260, h: 112 }}
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
                defaultRect={{ x: 16, y: 142, w: 1260, h: 660 }}
              >
                <SeasonView
                  season={filteredSeason}
                  following={st.following}
                  now={now}
                  onToggle={toggleFollow}
                  onOpen={setDrawer}
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
                images={tierCovers.images}
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
      />

      <ShortcutsOverlay
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        globalHotkey={hotkeyInfo?.ok ? st.settings.globalHotkey : ''}
      />

      <Toasts toasts={toasts} />
    </div>
  );
}
