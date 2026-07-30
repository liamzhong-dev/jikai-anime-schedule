/**
 * 应用状态：用户数据（追番 / 进度 / 补番 / 布局 / 设置）与季度数据缓存。
 * 只通过 platform 适配器落盘，业务层不关心存到哪儿。
 *
 * 缓存单独放在 cache 字段里，和用户数据分开：
 * 用户数据丢了是灾难，缓存丢了只是重下一遍，所以清理缓存可以很放心。
 */

import { platform } from '../platform/index.js';
import { DEFAULT_THEME } from '../theme/themes.js';
import { DEFAULT_WALLPAPER } from '../theme/applyTheme.js';
import { DEFAULT_API } from '../data/bangumiApi.js';
import { DEFAULT_SOURCE } from '../data/sources.js';
import { BUILTIN_PRESETS, presetById } from './layoutPresets.js';

const MAX_CACHED_SEASONS = 10;

const DEFAULTS = {
  following: {},      // { [id]: { status, watchedEps, notify } }
  catchup: [],        // [{ id, subjectId, deadline, watchedEps, targetEps, archived }]
  layout: {},         // { [cardId]: { x, y, w, h } }
  layoutPresets: [],  // 用户自存预设；内置的从 layoutPresets.js 读，不落盘
  activePreset: null,
  settings: {
    dataSource: DEFAULT_SOURCE, // 'builtin' | 'bangumi-data' | 'bangumi-api'
    reminderLeadMin: 0,   // 提前多少分钟提醒
    quietHours: [23, 8],  // 免打扰时段
    seededOnce: false,    // 是否已灌过一份初始追番（测试构造前置状态时用）

    theme: DEFAULT_THEME, // 配色主题
    panelAlpha: 1,        // 卡片不透明度（壁纸要透出来时调低）
    wallpaper: { ...DEFAULT_WALLPAPER },

    api: { ...DEFAULT_API },

    hotkeysEnabled: true,
    globalHotkey: 'CommandOrControl+Shift+A', // 全局显示/隐藏

    tray: { enabled: true, minimizeToTray: true, closeToTray: true },
    autoLaunch: false,

    update: {
      autoCheck: true,
      manifestUrl: '',    // 留空则视为「未配置更新源」
      lastCheck: 0,
      lastResult: null,   // { version, hasUpdate, error, at }
      skippedVersion: '',
    },
  },
  cache: {},          // { [seasonKey]: { savedAt, source, enriched, enrichStats, items } }
};

let state = structuredClone(DEFAULTS);
let listeners = new Set();
let saveTimer = null;

export function getState() {
  return state;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) fn(state);
}

/** 深合并设置：新增字段一定会有默认值，老 state.json 也能平滑升上来 */
function mergeSettings(saved) {
  const s = saved ?? {};
  return {
    ...DEFAULTS.settings,
    ...s,
    wallpaper: { ...DEFAULT_WALLPAPER, ...(s.wallpaper ?? {}) },
    api: { ...DEFAULT_API, ...(s.api ?? {}) },
    tray: { ...DEFAULTS.settings.tray, ...(s.tray ?? {}) },
    update: { ...DEFAULTS.settings.update, ...(s.update ?? {}) },
  };
}

export async function load() {
  const saved = await platform.readState();
  state = {
    ...structuredClone(DEFAULTS),
    ...(saved ?? {}),
    settings: mergeSettings(saved?.settings),
  };
  emit();
  return state;
}

/** 修改状态；写入后延迟落盘（合并连续改动） */
export function update(mutator) {
  const next = mutator(state);
  state = next ?? state;
  emit();
  scheduleSave();
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    platform.writeState(snapshot());
  }, 400);
}

/** 立即落盘（关窗前调用，免得最后 400ms 的改动丢掉） */
export function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  return platform.writeState(snapshot());
}

function snapshot() {
  return {
    following: state.following,
    catchup: state.catchup,
    layout: state.layout,
    layoutPresets: state.layoutPresets,
    activePreset: state.activePreset,
    settings: state.settings,
    cache: state.cache,
  };
}

// ---------- 追番 ----------

export function isFollowing(id) {
  return Boolean(state.following[id]);
}

export function toggleFollow(id, seed = {}) {
  update((s) => {
    const following = { ...s.following };
    if (following[id]) delete following[id];
    else following[id] = { status: 'watching', watchedEps: 0, notify: true, ...seed };
    return { ...s, following };
  });
}

export function setWatched(id, eps) {
  update((s) => {
    const cur = s.following[id] ?? { status: 'watching', watchedEps: 0, notify: true };
    return { ...s, following: { ...s.following, [id]: { ...cur, watchedEps: Math.max(0, eps) } } };
  });
}

export function markEpisode(id, episodeNumber) {
  update((s) => {
    const cur = s.following[id] ?? { status: 'watching', watchedEps: 0, notify: true };
    return { ...s, following: { ...s.following, [id]: { ...cur, watchedEps: episodeNumber } } };
  });
}

/** 改「在看 / 想看 / 搁置 / 弃了」这类状态；顺手关掉已弃番的提醒 */
export function patchFollowing(id, patch) {
  update((s) => {
    const cur = s.following[id];
    if (!cur) return s;
    const next = { ...cur, ...patch };
    if (next.status === 'dropped' || next.status === 'on_hold') next.notify = false;
    return { ...s, following: { ...s.following, [id]: next } };
  });
}

export function unfollow(id) {
  update((s) => {
    const following = { ...s.following };
    delete following[id];
    return { ...s, following };
  });
}

// ---------- 补番 ----------

export function addCatchup(subjectId, { deadline, targetEps }) {
  update((s) => {
    if (s.catchup.some((c) => c.subjectId === subjectId && !c.archived)) return s;
    const card = {
      id: `catchup-${subjectId}-${Date.now()}`,
      subjectId,
      deadline: deadline ?? Date.now() + 21 * 86400000,
      watchedEps: 0,
      targetEps: targetEps ?? 12,
      archived: false,
      createdAt: Date.now(),
    };
    return { ...s, catchup: [...s.catchup, card] };
  });
}

export function patchCatchup(id, patch) {
  update((s) => ({
    ...s,
    catchup: s.catchup.map((c) => (c.id === id ? { ...c, ...patch } : c)),
  }));
}

export function removeCatchup(id) {
  update((s) => ({ ...s, catchup: s.catchup.filter((c) => c.id !== id) }));
}

// ---------- 布局 ----------

export function setLayout(cardId, rect) {
  update((s) => ({ ...s, layout: { ...s.layout, [cardId]: rect } }));
}

/** 批量替换布局（套用预设时用，避免逐张卡片触发十几次重渲染） */
export function setLayouts(layout, { presetId = null } = {}) {
  update((s) => ({ ...s, layout: { ...layout }, activePreset: presetId }));
}

export function resetLayout() {
  update((s) => ({ ...s, layout: {}, activePreset: null }));
}

// ---------- 布局预设 ----------

export function listPresets() {
  const custom = (state.layoutPresets ?? []).map((p) => ({ ...p, builtin: false }));
  return [...BUILTIN_PRESETS.map((p) => ({ ...p, builtin: true })), ...custom];
}

export function findPreset(id) {
  return presetById(id) ?? (state.layoutPresets ?? []).find((p) => p.id === id) ?? null;
}

export function saveLayoutPreset(name) {
  const id = `preset-${Date.now().toString(36)}`;
  const preset = {
    id,
    name: String(name ?? '').trim() || `布局 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    layout: { ...state.layout },
    createdAt: Date.now(),
  };
  update((s) => ({ ...s, layoutPresets: [...(s.layoutPresets ?? []), preset], activePreset: id }));
  return preset;
}

export function applyLayoutPreset(id) {
  const preset = findPreset(id);
  if (!preset) return null;
  setLayouts(preset.layout, { presetId: preset.id });
  return preset;
}

export function renameLayoutPreset(id, name) {
  update((s) => ({
    ...s,
    layoutPresets: (s.layoutPresets ?? []).map((p) => (p.id === id ? { ...p, name: String(name).trim() || p.name } : p)),
  }));
}

export function deleteLayoutPreset(id) {
  update((s) => ({
    ...s,
    layoutPresets: (s.layoutPresets ?? []).filter((p) => p.id !== id),
    activePreset: s.activePreset === id ? null : s.activePreset,
  }));
}

export function importLayoutPresets(payload) {
  const list = Array.isArray(payload) ? payload : payload?.presets;
  if (!Array.isArray(list)) throw new Error('预设文件格式不对：应该是一个数组或 { presets: [] }');
  const cleaned = list
    .filter((p) => p && typeof p === 'object' && p.layout && typeof p.layout === 'object')
    .map((p) => ({
      id: `preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: String(p.name ?? '导入的布局').slice(0, 40),
      layout: p.layout,
      createdAt: Date.now(),
    }));
  if (!cleaned.length) throw new Error('预设文件里没有可用的布局');
  update((s) => ({ ...s, layoutPresets: [...(s.layoutPresets ?? []), ...cleaned] }));
  return cleaned.length;
}

export function exportLayoutPresets() {
  return {
    app: 'jikai',
    kind: 'layout-presets',
    version: 1,
    exportedAt: new Date().toISOString(),
    presets: (state.layoutPresets ?? []).map(({ id, name, layout, createdAt }) => ({ id, name, layout, createdAt })),
  };
}

// ---------- 设置 ----------

export function patchSettings(patch) {
  update((s) => ({ ...s, settings: { ...s.settings, ...patch } }));
}

/** 设置里的嵌套对象（壁纸 / API / 托盘 / 更新）用这个改，免得整块覆盖 */
export function patchSettingSection(section, patch) {
  update((s) => ({
    ...s,
    settings: { ...s.settings, [section]: { ...(s.settings[section] ?? {}), ...patch } },
  }));
}

// ---------- 季度缓存 ----------

export function writeSeasonCache(seasonKey, payload) {
  update((s) => {
    const cache = { ...s.cache, [seasonKey]: payload };
    // 只留最近 N 个季度，防止无限膨胀
    const keys = Object.keys(cache).sort((a, b) => (cache[b]?.savedAt ?? 0) - (cache[a]?.savedAt ?? 0));
    for (const k of keys.slice(MAX_CACHED_SEASONS)) delete cache[k];
    return { ...s, cache };
  });
}

/** 原始读取：不做过期判断，调用方自己决定要不要用旧缓存 */
export function readSeasonCacheRaw(seasonKey) {
  return state.cache?.[seasonKey] ?? null;
}

/** 兼容旧调用：带最大存活时间的读取 */
export function readSeasonCache(seasonKey, maxAgeMs = 12 * 3600000) {
  const hit = readSeasonCacheRaw(seasonKey);
  if (!hit) return null;
  if (Date.now() - (hit.savedAt ?? 0) > maxAgeMs) return null;
  return hit.items ?? null;
}

export function cacheSeason(seasonKey, items) {
  writeSeasonCache(seasonKey, { savedAt: Date.now(), source: 'legacy', enriched: false, items });
}

/** 缓存清单，给设置面板展示用 */
export function listCache(nowMs = Date.now()) {
  return Object.entries(state.cache ?? {})
    .map(([seasonKey, v]) => ({
      seasonKey,
      source: v?.source ?? 'unknown',
      enriched: Boolean(v?.enriched),
      savedAt: v?.savedAt ?? 0,
      ageMs: nowMs - (v?.savedAt ?? 0),
      count: Array.isArray(v?.items) ? v.items.length : 0,
      bytes: roughBytes(v),
    }))
    .sort((a, b) => b.savedAt - a.savedAt);
}

export function cacheSummary(nowMs = Date.now()) {
  const rows = listCache(nowMs);
  return {
    seasons: rows.length,
    items: rows.reduce((n, r) => n + r.count, 0),
    bytes: rows.reduce((n, r) => n + r.bytes, 0),
    oldest: rows.length ? rows[rows.length - 1].savedAt : 0,
    rows,
  };
}

/**
 * 清缓存。key 省略表示全清；olderThanMs 给定时只清过期的。
 * @returns {{ cleared: string[], freedBytes: number }}
 */
export function clearSeasonCache({ key = null, olderThanMs = 0, nowMs = Date.now() } = {}) {
  const before = cacheSummary(nowMs);
  const targets = before.rows.filter((r) => {
    if (key && r.seasonKey !== key) return false;
    if (olderThanMs > 0 && r.ageMs <= olderThanMs) return false;
    return true;
  });
  if (!targets.length) return { cleared: [], freedBytes: 0 };
  const drop = new Set(targets.map((t) => t.seasonKey));
  update((s) => {
    const cache = { ...s.cache };
    for (const k of drop) delete cache[k];
    return { ...s, cache };
  });
  return { cleared: [...drop], freedBytes: targets.reduce((n, t) => n + t.bytes, 0) };
}

/** 估算单条缓存在 state.json 里占多少字节 */
function roughBytes(entry) {
  try {
    return JSON.stringify(entry ?? {}).length;
  } catch {
    return 0;
  }
}

export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 灌一份初始追番与补番，只在状态里还什么都没有时生效（认 seededOnce 标记）。
 *
 * 应用本身不调用它 —— 首次启动就是干净的：本季番剧表在，追番列表空着，
 * 点星标自己加。需要「一打开就有内容」的地方是测试：SSR 渲染测试靠它
 * 构造前置状态，否则渲染出来的四个视图全是空态，等于什么都没验。
 */
export function seedInitialState({ following, catchup }) {
  update((s) => {
    if (s.settings.seededOnce) return s;
    return {
      ...s,
      following: Object.keys(s.following).length ? s.following : following,
      catchup: s.catchup.length ? s.catchup : catchup,
      settings: { ...s.settings, seededOnce: true },
    };
  });
}
