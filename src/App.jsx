import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import SideNav from './components/SideNav.jsx';
import TopBar from './components/TopBar.jsx';
import WindowCard from './components/WindowCard.jsx';
import SeasonView from './components/SeasonView.jsx';
import ScheduleView from './components/ScheduleView.jsx';
import FollowingView from './components/FollowingView.jsx';
import CatchupView from './components/CatchupView.jsx';
import DetailDrawer from './components/DetailDrawer.jsx';
import SettingsPanel from './components/SettingsPanel.jsx';
import ShortcutsOverlay from './components/ShortcutsOverlay.jsx';
import WallpaperLayer from './components/WallpaperLayer.jsx';
import Toasts from './components/Toasts.jsx';
import { useStoreState } from './core/useStore.js';
import {
  addCatchup, exportLayoutPresets, flush, load as loadStore, markEpisode,
  patchCatchup, patchFollowing, patchSettingSection, patchSettings, readSeasonCacheRaw,
  removeCatchup, toggleFollow, unfollow, writeSeasonCache,
} from './core/store.js';
import { platform } from './platform/index.js';
import { allBuiltinItems, builtinItems, BUILTIN_SEASONS } from './data/builtin/index.js';
import { availableSeasons, currentSeason } from './data/bangumiData.js';
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

const VIEWS = ['season', 'schedule', 'following', 'catchup'];

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
      const [info, wp, al] = await Promise.all([
        platform.appInfo().catch(() => null),
        platform.readWallpaper().catch(() => null),
        platform.getAutoLaunch().catch(() => null),
      ]);
      if (!alive) return;
      setAppInfo(info);
      setAutoLaunch(al);
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

  const catchupRows = useMemo(
    () => sortCatchup(st.catchup, now)
      .map((item) => ({ item, anime: pool.find((a) => a.id === item.subjectId) }))
      .filter((r) => r.anime),
    [st.catchup, pool, now],
  );

  const activeCatchup = catchupRows.filter((r) => !r.item.archived);
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
            addCatchup(a.id, { targetEps: a.eps ?? 12, deadline: Date.now() + 21 * MS_PER_DAY });
            pushToast('已加入补番清单', `${a.titleZh || a.titleJa} · 默认 21 天内补完`);
          }}
          onOpenExternal={(url) => url && platform.openExternal(url)}
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
