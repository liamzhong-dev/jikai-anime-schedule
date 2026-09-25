/**
 * 本地作品库：名称索引 + 作品档案 + 分组。
 *
 * 为什么要这三样东西，起因是一个真实的毛病：
 * 补番清单里如果有一部番不在当前季度、也不在那几季内置数据里，
 * 原来的写法（App.jsx 里 pool.find(...).filter(r => r.anime)）会让它**整张卡片消失**。
 * 不是「显示不出封面」，是连名字都没了 —— 用户以为自己记的补番名单丢了。
 *
 * 所以这里把「看见过的作品」单独存一份档案：
 *
 *   subjects   { [id]: 番剧条目 }       条目本体，任何来源拿到的都往这里留一份
 *   groups     { [key]: { ids: [] } }   分组，只存 id 列表，不重复存条目
 *   nameIndex  全量番剧名              单独文件（约 1MB），为了让搜索能命中
 *                                      「本季之外」的老番
 *
 * 纯函数层：不碰平台适配器，不碰 React。所有形状变换都在这里，能被测试守住。
 */

import { seasonOf } from './time.js';

/** bangumi-data 里 site==='bangumi' 的那一项才是能回查 API 的 ID */
export function bangumiIdOf(item) {
  const hit = (item?.sites ?? []).find((s) => s?.site === 'bangumi');
  const n = Number(hit?.id);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 取简体中文译名；没有就用原名顶上 */
export function zhNameOf(item) {
  const t = item?.titleTranslate ?? {};
  const list = t['zh-Hans'] ?? [];
  const first = Array.isArray(list) ? list[0] : null;
  return first ? String(first).trim() : '';
}

/**
 * 取英文译名。
 *
 * 这一项是真实数据逼出来的：bangumi-data 的 title 是日文（「鬼滅の刃」），
 * 只存中日文的话，用 latin 字母搜「Demon Slayer」是搜不到的 ——
 * 数据集里另有 2500 条带 `en` 译名，正是给这种搜法用的。
 */
export function enNameOf(item) {
  const t = item?.titleTranslate ?? {};
  const list = t.en ?? [];
  const first = Array.isArray(list) ? list[0] : null;
  return first ? String(first).trim() : '';
}

/** 归一化为可比较的小写串：中英文都按小写比，前后空白不算数 */
const norm = (s) => String(s ?? '').trim().toLowerCase();

/**
 * 由 bangumi-data 的原始条目构建名称索引。
 *
 * 字段名刻意用短的（id/zh/ja/y/q/t）而不是整存取整个条目，是为了压体积：
 * 实测 8833 条 → 0.95 MB，每条 112 字节；如果连 sites、broadcast 一起存会到 7 MB，
 * 那样每次落盘都很难受。
 *
 * 同一部番可能在数据集里出现多次（不同放送窗口），按 id 去重保留第一条。
 *
 * @returns {{builtAt:number, source:string, count:number, span:number[], entries:Array}}
 */
export function buildNameIndex(rawItems, { nowMs = Date.now(), source = 'bangumi-data' } = {}) {
  const seen = new Set();
  const entries = [];
  let minYear = Infinity;
  let maxYear = -Infinity;

  for (const it of rawItems ?? []) {
    const id = bangumiIdOf(it);
    if (!id) continue;              // 没有 bangumi id 的回查不到详情，索引也没意义
    if (seen.has(id)) continue;
    const ja = String(it?.title ?? '').trim();
    const zh = zhNameOf(it);
    const en = enNameOf(it);
    if (!ja && !zh && !en) continue; // 连名字都没有的条目没有任何用途
    seen.add(id);

    let y = null;
    let q = null;
    if (it?.begin) {
      const ms = Date.parse(it.begin);
      if (Number.isFinite(ms)) {
        const key = seasonOf(ms);
        const m = /^(\d{4})q([1-4])$/.exec(key);
        if (m) { y = Number(m[1]); q = Number(m[2]); }
      }
    }
    if (y != null) {
      if (y < minYear) minYear = y;
      if (y > maxYear) maxYear = y;
    }

    entries.push({ id, zh, ja, en, y, q, t: String(it?.type ?? 'tv').toLowerCase() });
  }

  return {
    builtAt: nowMs,
    source,
    count: entries.length,
    span: Number.isFinite(minYear) ? [minYear, maxYear] : [],
    entries,
  };
}

/**
 * 在名称索引里搜关键词。
 *
 * 排序为什么这么排：搜「鬼灭」会命中最早那部《鬼灭之刃》，也会命中
 * 《鬼灭之刃 兄妹的羁绊》这类衍生条目。前缀匹配的应该压过中段匹配的，
 * 名字短的应该压过名字长的（短名通常是本体），否则用户永远找不到正片。
 *
 * @param {object} index buildNameIndex 的产物
 * @param {string} keyword
 * @param {{limit?:number, type?:string|null}} opts
 * @returns {Array<{...entry, matched:string, score:number}>}
 */
export function searchNames(index, keyword, { limit = 20, type = null } = {}) {
  const k = norm(keyword);
  const entries = index?.entries;
  if (!k || !Array.isArray(entries) || !entries.length) return [];

  const hits = [];
  for (const e of entries) {
    const zh = norm(e.zh);
    const ja = norm(e.ja);
    const en = norm(e.en);

    let score = -1;
    let matched = '';
    if (zh && zh.startsWith(k)) { score = 100; matched = e.zh; }
    else if (ja && ja.startsWith(k)) { score = 90; matched = e.ja; }
    else if (en && en.startsWith(k)) { score = 85; matched = e.en; }
    else if (zh && zh.includes(k)) { score = 60; matched = e.zh; }
    else if (ja && ja.includes(k)) { score = 50; matched = e.ja; }
    else if (en && en.includes(k)) { score = 45; matched = e.en; }
    if (score < 0) continue;

    // 名字越短越可能是正片本体。
    // 上限取 48 而不是 24：真实数据里英文译名常常一长串且同前缀
    // （Demon Slayer: Kimetsu no Yaiba / … Hashira Training Arc），
    // 加成太小就分不开，最后落到「平手按新作品优先」上，正片反而沉底。
    const len = Math.min((matched || '').length, 48);
    score += Math.max(0, 48 - len);
    // 电视动画比剧场版 / OVA 更常是「想补的那部」，给一点偏好
    if (e.t === 'tv') score += 3;

    hits.push({ ...e, matched, score });
  }

  hits.sort((a, b) => b.score - a.score || (b.y ?? 0) - (a.y ?? 0) || String(a.ja).localeCompare(String(b.ja)));

  const typed = type ? hits.filter((h) => h.t === String(type).toLowerCase()) : hits;
  return typed.slice(0, Math.max(1, limit));
}

/**
 * 把作品合并进档案。
 *
 * 已经在档案里的条目**不会被空值覆盖**：新数据常常只补了几个字段
 * （比如只拿到封面），直接 Object.assign 会把原本有的简介、标签抹成空。
 * 只有「非空值」才允许盖上去。
 *
 * @returns {{subjects:object, added:number, updated:number}}
 */
export function mergeSubjects(subjects, items) {
  const out = { ...(subjects ?? {}) };
  let added = 0;
  let updated = 0;

  for (const raw of items ?? []) {
    if (!raw) continue;
    const id = Number(raw.id);
    if (!Number.isFinite(id) || id <= 0) continue;

    const prev = out[id];
    if (!prev) {
      out[id] = { ...raw, archivedAt: Date.now() };
      added += 1;
      continue;
    }

    const next = { ...prev };
    let dirty = false;
    for (const [k, v] of Object.entries(raw)) {
      if (v == null) continue;
      if (v === '' || (Array.isArray(v) && v.length === 0)) continue;
      if (prev[k] === v) continue;
      next[k] = v;
      dirty = true;
    }
    if (dirty) {
      next.archivedAt = Date.now();
      out[id] = next;
      updated += 1;
    }
  }

  return { subjects: out, added, updated };
}

/** 按 id 取一组条目；查不到的会被丢掉（返回 `{found, missing}` 便于界面说清差多少） */
export function pickSubjects(subjects, ids) {
  const map = subjects ?? {};
  const found = [];
  const missing = [];
  for (const id of ids ?? []) {
    const hit = map[Number(id)];
    if (hit) found.push(hit);
    else missing.push(Number(id));
  }
  return { found, missing };
}

// ---------- 分组 ----------

/** 内置分组。补番组是第一个 —— 这是本次需求的起点 */
export const BUILTIN_GROUPS = {
  catchup: { label: '补番组', hint: '搜索后加入补番清单的作品' },
};

export function defaultGroups(nowMs = Date.now()) {
  const out = {};
  for (const [key, meta] of Object.entries(BUILTIN_GROUPS)) {
    out[key] = { label: meta.label, hint: meta.hint, ids: [], updatedAt: nowMs };
  }
  return out;
}

/**
 * 往分组里加 id。
 *
 * 去重是这个函数的重点：同一部番反复加入补番，列表不能越加越长。
 */
export function addToGroup(groups, key, ids, { label, nowMs = Date.now() } = {}) {
  const cleanKey = String(key ?? '').trim();
  if (!cleanKey) return { groups, added: [] };
  const cur = (groups ?? {})[cleanKey] ?? {
    label: label ?? BUILTIN_GROUPS[cleanKey]?.label ?? cleanKey,
    hint: BUILTIN_GROUPS[cleanKey]?.hint ?? '',
    ids: [],
    updatedAt: nowMs,
  };
  const set = new Set(cur.ids ?? []);
  const added = [];
  for (const raw of ids ?? []) {
    const id = Number(raw);
    if (!Number.isFinite(id) || id <= 0) continue;
    if (set.has(id)) continue;
    set.add(id);
    added.push(id);
  }
  if (!added.length) return { groups: groups ?? {}, added: [] };
  return {
    groups: {
      ...(groups ?? {}),
      [cleanKey]: { ...cur, ids: [...set], updatedAt: nowMs },
    },
    added,
  };
}

export function removeFromGroup(groups, key, id, { nowMs = Date.now() } = {}) {
  const cur = (groups ?? {})[String(key)];
  if (!cur) return groups ?? {};
  const target = Number(id);
  const ids = (cur.ids ?? []).filter((x) => Number(x) !== target);
  if (ids.length === (cur.ids ?? []).length) return groups ?? {};
  return { ...(groups ?? {}), [String(key)]: { ...cur, ids, updatedAt: nowMs } };
}

export function groupIds(groups, key) {
  return ((groups ?? {})[String(key)]?.ids ?? []).map(Number);
}

/** 给设置面板展示用的一览 */
export function groupSummary(groups) {
  return Object.entries(groups ?? {}).map(([key, g]) => ({
    key,
    label: g?.label ?? key,
    hint: g?.hint ?? '',
    count: (g?.ids ?? []).length,
    updatedAt: g?.updatedAt ?? 0,
  }));
}

/**
 * 名称索引要不要重建。
 *
 * 索引过期本身不是灾难（名字几乎不变），所以阈值给得很宽松 ——
 * 真正在意的是「一次都没建过」。
 */
export function nameIndexStale(index, { maxAgeMs = 30 * 86400000, nowMs = Date.now() } = {}) {
  if (!index || !Array.isArray(index.entries) || !index.entries.length) return { stale: true, reason: '还没有建过名称索引' };
  const age = nowMs - (index.builtAt ?? 0);
  if (!Number.isFinite(age) || age < 0) return { stale: true, reason: '索引时间不对' };
  if (age > maxAgeMs) return { stale: true, reason: `索引已过期（${Math.round(age / 86400000)} 天前建的）` };
  return { stale: false, ageMs: age };
}
