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
import { addToGroup as addToGroupPure, defaultGroups, groupSummary, mergeSubjects, pickSubjects, removeFromGroup as removeFromGroupPure } from './library.js';
import { makeDefaultTierlist, normalizeTierlist } from './tierlist.js';
import { makeDefaultReport, normalizeReport } from './report.js';
import {
  addDiaryEntry as addDiaryEntryPure,
  removeDiaryEntry as removeDiaryEntryPure,
  normalizeDiary,
  entriesOf,
  latestEntry,
  latestRated,
  myRating,
} from './diary.js';

const MAX_CACHED_SEASONS = 10;

/**
 * 作品档案的容量上限。
 *
 * 档案里存的是精简过的条目，一条几百字节 —— 但放任它涨也会拖慢每次落盘。
 * 上限取 2000：足够装下「追过的 + 补过的 + 搜过的」，又不至于失控。
 * 淘汰策略按 archivedAt 丢最旧的，因为最能代表「还会用到」的就是最近碰过的。
 */
const MAX_SUBJECTS = 2000;

const DEFAULTS = {
  following: {},      // { [id]: { status, watchedEps, notify } }
  catchup: [],        // [{ id, subjectId, deadline, watchedEps, targetEps, archived }]
  subjects: {},       // { [id]: 番剧条目 } —— 见「作品档案」一节
  groups: defaultGroups(0), // { [key]: { label, hint, ids, updatedAt } }
  layout: {},         // { [cardId]: { x, y, w, h } }
  layoutPresets: [],  // 用户自存预设；内置的从 layoutPresets.js 读，不落盘
  activePreset: null,
  // { [seasonKey]: 一份 tierlist } —— 按季度各存一份，见「Tier List」一节
  tierlists: {},
  // { [番剧id]: { entries: [{at, rating, note}], updatedAt } } —— 见「补番日记」一节
  diary: {},
  // { [seasonKey]: 一份季度报告 } —— 见「季度报告」一节。和 tierlists 一样按季度各存一份
  reports: {},
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
    // 磁盘上的日记可能是旧版本写的、也可能被手改过 —— 读的这一刻就修干净
    diary: normalizeDiary(saved?.diary),
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
    subjects: state.subjects,
    groups: state.groups,
    layout: state.layout,
    layoutPresets: state.layoutPresets,
    activePreset: state.activePreset,
    tierlists: state.tierlists, // ⚠️ 漏了这行就是「看着能用、关掉重开全没了」
    diary: state.diary,         // 同上：漏一行，日记写得再认真也是白写
    reports: state.reports,     // 季度报告：漏一行就是「排了一晚上的长图，关掉重开全没了」
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

/**
 * 加入补番清单。
 *
 * 顺带做两件事，这也是这套改动要解决的根本问题：
 *   1) 把条目归档进 subjects —— 否则一切季度、不在内置数据里的番，
 *      卡片虽然还在，界面却因为没有条目对象而把它整个丢掉；
 *   2) 把 id 记进「补番组」—— 之后离线搜索、封面预热都依赖这份名单。
 *
 * @param {number} subjectId
 * @param {{deadline?:number, targetEps?:number, anime?:object}} opts
 *   anime 可选，但**强烈建议传**：不传的话这一步只登记了 id，
 *   番剧的名字封面要等到下次拉到它才会补上。
 */
export function addCatchup(subjectId, { deadline, targetEps, anime } = {}) {
  const id = Number(subjectId);
  let addedCard = false;
  update((s) => {
    if (s.catchup.some((c) => Number(c.subjectId) === id && !c.archived)) return s;
    const card = {
      id: `catchup-${id}-${Date.now()}`,
      subjectId: id,
      deadline: deadline ?? Date.now() + 21 * 86400000,
      watchedEps: 0,
      targetEps: targetEps ?? anime?.eps ?? 12,
      archived: false,
      createdAt: Date.now(),
    };
    addedCard = true;

    // 可能同 thread 改两处，先算好再一起写回，避免中间状态被 emit 出去
    const merged = anime ? archiveSubjectsRaw(s.subjects, [anime]) : s.subjects;
    const grouped = addToGroupPure(s.groups, 'catchup', [id], { nowMs: Date.now() }).groups;

    return { ...s, catchup: [...s.catchup, card], subjects: merged, groups: grouped };
  });
  return addedCard;
}

export function patchCatchup(id, patch) {
  update((s) => ({
    ...s,
    catchup: s.catchup.map((c) => (c.id === id ? { ...c, ...patch } : c)),
  }));
}

/**
 * 删掉一张补番卡。
 *
 * 注意「删除」和「归档」的差别：
 *   归档 = 还在名单里，只是不催了 → 补番组继续留着；
 *   删除 = 真的不要了          → 补番组里也一并移掉。
 * 两种操作共用 group 的话，用户会发现「归档之后又删掉，名单还在」，很难解释。
 */
export function removeCatchup(id) {
  update((s) => {
    const target = s.catchup.find((c) => c.id === id);
    const catchup = s.catchup.filter((c) => c.id !== id);
    if (!target) return { ...s, catchup };
    // 同一部番可能有两张卡（删掉后又加回来），都删干净才移出分组
    const stillThere = catchup.some((c) => Number(c.subjectId) === Number(target.subjectId));
    const groups = stillThere ? s.groups : removeFromGroupPure(s.groups, 'catchup', target.subjectId, { nowMs: Date.now() });
    return { ...s, catchup, groups };
  });
}

// ---------- 作品档案与分组 ----------
//
// subjects：所有看见过的番剧条目，按 id 存一份精简副本。
// groups：分组，只存 id 列表（补番组就是其中一组）。
//
// 为什么要分开存：条目本体可能几百字节，而分组只是几个数字。
// 把它们绑在一起会让「加一组」变成「复制一遍全部条目」。

export function readSubjects() {
  return state.subjects ?? {};
}

export function subjectById(id) {
  return state.subjects?.[Number(id)] ?? null;
}

/**
 * 把条目写进作品档案。空值不覆盖已有内容（规则在 library.js 里，这里只管调用）。
 * @returns {{added:number, updated:number}}
 */
export function archiveSubjects(items) {
  let stats = { added: 0, updated: 0 };
  update((s) => {
    const r = archiveSubjectsRaw(s.subjects, items);
    stats = { added: r.added, updated: r.updated };
    return { ...s, subjects: r.subjects };
  });
  return stats;
}

/** archiveSubjects 的纯计算部分：不动 state，方便在另一个 mutator 里复用 */
function archiveSubjectsRaw(subjects, items) {
  const { subjects: merged, added, updated } = mergeSubjects(subjects, items);
  // 超容量时丢最旧的：archivedAt 不存在的一律排在最前面（视为最旧）
  const keys = Object.keys(merged);
  if (keys.length <= MAX_SUBJECTS) return { subjects: merged, added, updated };
  const sorted = keys.sort((a, b) => (merged[a]?.archivedAt ?? 0) - (merged[b]?.archivedAt ?? 0));
  const trimmed = {};
  for (const k of sorted.slice(sorted.length - MAX_SUBJECTS)) trimmed[k] = merged[k];
  return { subjects: trimmed, added, updated };
}

export function addGroupIds(key, ids, opts = {}) {
  let added = [];
  update((s) => {
    const r = addToGroupPure(s.groups, key, ids, { nowMs: Date.now(), ...opts });
    added = r.added;
    return r.added.length ? { ...s, groups: r.groups } : s;
  });
  return added;
}

export function removeGroupId(key, id) {
  update((s) => ({ ...s, groups: removeFromGroupPure(s.groups, key, id, { nowMs: Date.now() }) }));
}

export function listGroups() {
  return groupSummary(state.groups ?? {});
}

export function idsOfGroup(key) {
  return ((state.groups ?? {})[String(key)]?.ids ?? []).map(Number);
}

/**
 * 取补番组里的完整条目。
 * @returns {{found:Array, missing:number[]}}
 *   missing 非空说明「名单里有、档案里没有」—— 这时候要联网补全，不能假装没事。
 */
export function catchupGroupItems() {
  const ids = idsOfGroup('catchup');
  return pickSubjects(state.subjects ?? {}, ids);
}

// ---------- Tier List ----------
//
// 按季度各存一份，key 就是季度（'2026q3'）。
// 不设容量上限：一份只有 7 行档位加几十个图块，一两 KB，
// 一年也只涨四份 —— 不像 subjects 那种会随搜索无限增长的字段，用不着淘汰策略。
//
// 读写都过 normalizeTierlist：状态文件是手写到磁盘上的，
// 旧版本写过、手改过、写坏了都得能在读的这一刻修好，不能让界面层去兜底。

export function readTierlist(key) {
  const k = String(key ?? '');
  if (!k) return null;
  const raw = (state.tierlists ?? {})[k];
  // 没排过的季度返回 null（而不是一份空表）—— 界面要靠这个区分
  // 「还没开始排」和「排了又全拖回池子」，两种状态的提示文案不一样。
  if (!raw) return null;
  return normalizeTierlist(raw, { seasonKey: k });
}

/** 取一份，没有就现场造一份（**不落盘**，要留着请用 patchTierlist） */
export function ensureTierlist(key, { presetId } = {}) {
  const k = String(key ?? '');
  if (!k) return null;
  const existing = readTierlist(k);
  if (existing) return existing;
  return makeDefaultTierlist(k, presetId ? { presetId } : {});
}

/**
 * 改一份 tierlist。传进来的 patch 会先过一遍 normalize，脏数据在写入前就被拦下。
 * @returns {object|null} 写入后的完整结构
 */
export function patchTierlist(key, patch, { nowMs = Date.now() } = {}) {
  const k = String(key ?? '');
  if (!k) return null;
  const base = readTierlist(k) ?? makeDefaultTierlist(k, { nowMs });
  const next = normalizeTierlist({ ...base, ...(patch ?? {}), updatedAt: nowMs }, { seasonKey: k, nowMs });

  update((s) => ({ ...s, tierlists: { ...(s.tierlists ?? {}), [k]: next } }));
  return next;
}

/** 清空一季度的排布（保留档位定义，只清图块） */
export function resetTierlist(key, { presetId, nowMs = Date.now() } = {}) {
  const k = String(key ?? '');
  if (!k) return null;
  const fresh = makeDefaultTierlist(k, { presetId, nowMs });
  update((s) => ({ ...s, tierlists: { ...(s.tierlists ?? {}), [k]: fresh } }));
  return fresh;
}

/** 哪些季度排过（界面上给个「已排 N 个季度」用） */
export function listTierlists() {
  return Object.keys(state.tierlists ?? {}).sort();
}

// ---------- 季度报告 ----------
//
// 和 tierlists 完全同一套规矩，不另立一份：
//   - 按季度各存一份，key 是季度（'2026q3'）；
//   - **读的时候**过 normalizeReport，而不是在 load() 里统一修 ——
//     一年四份、每份几十个块，没必要每次启动都把所有季度修一遍；
//   - 没排过的季度返回 null（而不是一份空报告），界面靠它区分
//     「还没开始做」和「删空了」，两种状态的提示文案不一样。

export function readReport(key) {
  const k = String(key ?? '');
  if (!k) return null;
  const raw = (state.reports ?? {})[k];
  if (!raw) return null;
  return normalizeReport(raw, { seasonKey: k });
}

/** 取一份，没有就现场造一份（**不落盘**，要留着请用 patchReport） */
export function ensureReport(key) {
  const k = String(key ?? '');
  if (!k) return null;
  return readReport(k) ?? makeDefaultReport(k);
}

/**
 * 改一份报告。patch 会先过一遍 normalize，脏数据在写入前就被拦下。
 * @returns {object|null} 写入后的完整结构
 */
export function patchReport(key, patch, { nowMs = Date.now() } = {}) {
  const k = String(key ?? '');
  if (!k) return null;
  const base = readReport(k) ?? makeDefaultReport(k, { nowMs });
  const next = normalizeReport({ ...base, ...(patch ?? {}), updatedAt: nowMs }, { seasonKey: k, nowMs });

  update((s) => ({ ...s, reports: { ...(s.reports ?? {}), [k]: next } }));
  return next;
}

/**
 * 整份换掉。块的增删改序都在纯函数层算完，这里只负责写。
 *
 * 为什么单独开一个而不是让调用方拼 `patchReport({ blocks })`：
 * 「先读、改、再写」这两步之间如果被别的地方插进来一次写，改动就丢了。
 * 一步到位能少掉一整类「点了没反应」的玄学。
 */
export function setReportBlocks(key, blocks, { nowMs = Date.now() } = {}) {
  return patchReport(key, { blocks }, { nowMs });
}

/** 清空一季度的报告（连标题一起清掉，回到空画布） */
export function resetReport(key, { nowMs = Date.now() } = {}) {
  const k = String(key ?? '');
  if (!k) return null;
  const fresh = makeDefaultReport(k, { nowMs });
  update((s) => ({ ...s, reports: { ...(s.reports ?? {}), [k]: fresh } }));
  return fresh;
}

/** 哪些季度有报告 */
export function listReports() {
  return Object.keys(state.reports ?? {}).sort();
}

// ---------- 补番日记 ----------
//
// 存法见 diary.js 的文件头（评分用 1–10 整数、一部可以有多条、我的评分取最新一条）。
// 这里只做两件事：把纯函数的产物写进 state，以及给界面提供只读入口。
//
// ⚠️ 只读入口（readDiary / myRatingOf）**不许有副作用**：界面每帧都会调它们，
// 顺手「修一修」或「造一个空的」会让 state 因为一次渲染就变脏，进而触发落盘 ——
// tierlist 那边就是靠这条规矩避开了「只是看一眼也多出一个空季度」。

/** 日记整体（只读） */
export function readDiary() {
  return state.diary ?? {};
}

export function readDiaryOf(id) {
  return entriesOf(state.diary, id);
}

export function readLatestDiary(id) {
  return latestEntry(state.diary, id);
}

/** 最近一条带评分的记录（可能为 null） */
export function readLatestRated(id) {
  return latestRated(state.diary, id);
}

/** 我的评分：数字或 null */
export function myRatingOf(id) {
  return myRating(state.diary, id);
}

/**
 * 追加一条日记。
 * @returns {{ok:boolean, reason?:string, entry?:object}}
 *   `ok:false` 时界面应当给出提示 —— 静默丢弃用户刚写的字是最不能接受的失败方式
 */
export function addDiaryEntry(id, { rating = null, note = '', at = Date.now() } = {}) {
  const key = Number(id);
  if (!Number.isFinite(key) || key <= 0) return { ok: false, reason: '这条作品没有可用的 id，评分存不下来' };

  const { diary, entry } = addDiaryEntryPure(state.diary ?? {}, key, { rating, note, at });
  if (!entry) return { ok: false, reason: '既没有评分也没有内容，没有东西可以记' };

  update((s) => ({ ...s, diary }));
  return { ok: true, entry };
}

/** 删一条；`at` 是那条记录的时间戳 */
export function removeDiaryEntry(id, at) {
  const key = Number(id);
  if (!Number.isFinite(key) || key <= 0) return false;
  const next = removeDiaryEntryPure(state.diary ?? {}, key, at);
  if (next === (state.diary ?? {})) return false;
  update((s) => ({ ...s, diary: next }));
  return true;
}

/** 记录过日记的作品 id 列表 */
export function listDiaryIds() {
  return Object.keys(state.diary ?? {});
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
