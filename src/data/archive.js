/**
 * 本地季度归档。
 *
 * 为什么要有这一层：每日放送原来只吃「当季那一批」数据，而过季之后那一批就没了
 * ——不是界面算错，是**数据根本不在本地**。bangumi 的每日放送接口只给当周，
 * 过季即丢失，往季新番在时间表里整片消失，这正是要绕开的地方。
 *
 * 办法：导入（内置/联网同步）拿到一批条目时，按**开播月份**分组落到本地，
 * 之后时间表从归档里读。半年番会同时落进起始季和后续季，所以它过了一半
 * 仍然出现在当前这一季的放送里。
 *
 * 归档是**可再生**的（重新同步一次就有），所以不进 state.json：
 * 那边每次改动都要整体 stringify，塞几百 KB 进去会拖慢每一次落盘。
 */

import { seasonsWithHint } from './yucAlign.js';

/** 一条归档记录最少要有的字段 —— 没有 id 的条目没法去重、也没法取封面 */
function usable(item) {
  return Boolean(item) && item.id != null && String(item.id) !== '';
}

/**
 * 按开播月份把一批条目分到季度桶里。
 *
 * ⚠️ 半年番返回**两个**季度，所以同一条会进两个桶 ——
 * 这是有意的：7 月开播的 24 集番，在 10 月那一页里也要看得见。
 *
 * @param {Array} items
 * @returns {Record<string, Array>} 形如 { '2026q3': [...], '2026q4': [...] }
 */
export function groupByAirSeason(items, { align } = {}) {
  const out = {};
  for (const it of items ?? []) {
    if (!usable(it)) continue;
    // 有番堂结论就听番堂的（它按季度出版，比我们从话数反推准）；
    // 没有才退回「开播时间 + 话数」那套启发式
    const keys = seasonsWithHint(it, align?.get(String(it.id)));
    // 认不出来（没有 begin）时退回数据自带的 season 字段，
    // 否则联网同步回来的一整批会被静默丢掉
    const fallback = typeof it.season === 'string' && /^\d{4}q[1-4]$/.test(it.season) ? [it.season] : [];
    for (const key of keys.length ? keys : fallback) {
      (out[key] ??= []).push(it);
    }
  }
  return out;
}

/**
 * 合并两批条目：同 id 只留一份。
 *
 * 覆盖规则是**字段多者胜**，不是「后来的胜」：联网同步回来的一批里，
 * 有的条目只有排播信息（没有评分 / 简介），而本地那份是补全过的 ——
 * 无条件用新的覆盖，会把已经补好的简介冲掉。
 *
 * @param {Array} existing 已有
 * @param {Array} incoming 新来的
 */
export function mergeItems(existing = [], incoming = []) {
  const byId = new Map();
  const score = (it) => {
    let n = 0;
    if (it.summary) n += 4;
    if (it.score != null) n += 2;
    if (it.cover) n += 2;
    if (it.eps != null) n += 1;
    if (it.studio) n += 1;
    return n;
  };
  for (const it of existing ?? []) {
    if (usable(it)) byId.set(String(it.id), it);
  }
  for (const it of incoming ?? []) {
    if (!usable(it)) continue;
    const k = String(it.id);
    const old = byId.get(k);
    if (!old || score(it) >= score(old)) byId.set(k, it);
  }
  return [...byId.values()];
}

/** 把新的一批并进已有归档，返回新的归档（不改入参） */
export function mergeArchive(archive, items, { nowMs = Date.now(), align } = {}) {
  const grouped = groupByAirSeason(items, { align });
  const seasons = { ...(archive?.seasons ?? {}) };
  for (const [key, list] of Object.entries(grouped)) {
    seasons[key] = mergeItems(seasons[key], list);
  }
  return { builtAt: nowMs, seasons };
}

/** 取某一季的归档条目 */
export function archiveSeason(archive, key) {
  if (!key) return [];
  return archive?.seasons?.[key] ?? [];
}

/** 归档里都有哪些季度（新的在前） */
export function archiveKeys(archive) {
  return Object.keys(archive?.seasons ?? {}).sort().reverse();
}
