/**
 * 内置数据索引 —— 由 scripts/build-builtin.mjs 生成，不要手改。
 *
 * 这里的数据是「随包发布」的：装好就有本季番剧表，不用联网、不用开代理。
 * 想要更新的数据，切到联网数据源点同步即可；联网源挂了会退回到这里。
 */

import s2026q2 from './2026q2.js';
import s2026q3 from './2026q3.js';
import s2026q4 from './2026q4.js';

export const BUILTIN_GENERATED_AT = '2026-09-22T03:36:46.017Z';

/** 收录了哪几个季度 */
export const BUILTIN_SEASONS = ['2026q2', '2026q3', '2026q4'];

const SEASONS = {
  '2026q2': s2026q2,
  '2026q3': s2026q3,
  '2026q4': s2026q4,
};

/** 内置数据里有没有这一季 */
export function hasBuiltin(seasonKey) {
  return Object.prototype.hasOwnProperty.call(SEASONS, String(seasonKey ?? ''));
}

/** 取一季的条目；没有则返回空数组。返回的是副本，调用方随便改 */
export function builtinItems(seasonKey) {
  const list = SEASONS[String(seasonKey ?? '')];
  return list ? list.map((a) => ({ ...a })) : [];
}

/** 内置数据里所有季度的条目，按 id 去重 —— 补番卡片跨季度找条目时用 */
export function allBuiltinItems() {
  const seen = new Map();
  for (const key of BUILTIN_SEASONS) {
    for (const a of SEASONS[key]) if (!seen.has(a.id)) seen.set(a.id, a);
  }
  return [...seen.values()].map((a) => ({ ...a }));
}

/** 给界面用的一句话说明 */
export const BUILTIN_SUMMARY = "2026q2 / 2026q3 / 2026q4 · 共 219 部";
