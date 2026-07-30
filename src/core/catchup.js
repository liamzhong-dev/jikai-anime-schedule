import { MS_PER_DAY } from './time.js';

/**
 * 补番清单：deadline 状态与进度。
 * 三档配色：已逾期（红）／三天内（黄）／时间宽裕（灰）／已补完（暗）。
 */

export function daysUntil(deadlineMs, nowMs = Date.now()) {
  const today = Math.floor(nowMs / MS_PER_DAY);
  const target = Math.floor(deadlineMs / MS_PER_DAY);
  return target - today;
}

export function deadlineStatus(deadlineMs, nowMs = Date.now()) {
  const days = daysUntil(deadlineMs, nowMs);
  if (days < 0) return { level: 'overdue', days, label: `逾期 ${Math.abs(days)} 天` };
  if (days === 0) return { level: 'urgent', days, label: '今天到期' };
  if (days <= 3) return { level: 'urgent', days, label: `还剩 ${days} 天` };
  return { level: 'normal', days, label: `还剩 ${days} 天` };
}

export function progress(item) {
  const total = Number(item.targetEps) || 0;
  const done = Math.min(Number(item.watchedEps) || 0, total);
  return {
    done,
    total,
    ratio: total > 0 ? done / total : 0,
    remaining: Math.max(total - done, 0),
  };
}

/** 补番清单排序：逾期优先，其次 deadline 近的，已归档沉底 */
export function sortCatchup(items, nowMs = Date.now()) {
  const rank = { overdue: 0, urgent: 1, normal: 2 };
  return [...items].sort((a, b) => {
    if (a.archived !== b.archived) return a.archived ? 1 : -1;
    const sa = rank[deadlineStatus(a.deadline, nowMs).level] ?? 3;
    const sb = rank[deadlineStatus(b.deadline, nowMs).level] ?? 3;
    if (sa !== sb) return sa - sb;
    return a.deadline - b.deadline;
  });
}
