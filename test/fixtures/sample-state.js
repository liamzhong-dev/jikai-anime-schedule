/**
 * 从内置真实数据里挑几部，拼一份「有追番、有补番」的用户状态。
 *
 * 给 SSR 渲染测试和截图脚本用。它要的是「界面在有内容时长得对不对」——
 * 具体是哪几部、哪一天更新都无所谓，所以直接拿随包发布的真实数据来用，
 * 不必再维护一份平行的假数据（那样两份还会随时间各走各的）。
 *
 * 两条规矩：
 *   1) 不看「今天」。默认用内置数据里最后一季，跑的那天是几月都一样；
 *   2) 追番的条目必须来自传进来的那一季 —— 否则界面上会出现「追了 6 部、
 *      一部都看不见」。截图脚本就踩过这个：它按当季截图，数据却取自末季。
 */

import { BUILTIN_SEASONS, builtinItems } from '../../src/data/builtin/index.js';

const DAY_MS = 86400000;

/** 默认看这一季（内置数据里最新的一季） */
export const SAMPLE_SEASON = BUILTIN_SEASONS[BUILTIN_SEASONS.length - 1];

/** 默认季的条目 */
export const SAMPLE_ITEMS = builtinItems(SAMPLE_SEASON);

/** 上一季的条目，拿来当补番卡片的目标 —— 补番本来就是追老番 */
function backlogOf(seasonKey) {
  const other = BUILTIN_SEASONS.filter((k) => k !== seasonKey);
  return builtinItems(other[0] ?? seasonKey);
}

/**
 * @param {string} seasonKey 追番挂在哪一季上（必须和界面当前显示的一致）
 */
export function buildSampleUserState(seasonKey = SAMPLE_SEASON, nowMs = Date.now()) {
  const seasonItems = builtinItems(seasonKey);

  // 追 6 部，进度各不相同（含一部搁置）
  const following = {};
  seasonItems.slice(0, 6).forEach((a, i) => {
    const total = a.eps ?? 12;
    following[a.id] = {
      status: i === 4 ? 'on_hold' : 'watching',
      watchedEps: Math.min(total - 1, 1 + i),
      notify: true,
    };
  });

  // 补番 4 张卡：已逾期 / 今天到期 / 三天内 / 宽裕
  const offsets = [-3, 0, 2, 12];
  const catchup = backlogOf(seasonKey).slice(0, offsets.length).map((a, i) => {
    const total = a.eps ?? 12;
    return {
      id: `catchup-${a.id}`,
      subjectId: a.id,
      deadline: nowMs + offsets[i] * DAY_MS,
      watchedEps: Math.max(0, Math.min(total, Math.floor(total / 3) + i)),
      targetEps: total,
      archived: false,
      createdAt: nowMs - (offsets.length - i) * DAY_MS,
    };
  });

  return { following, catchup };
}
