// 搜索、筛选、排序

export function matchKeyword(anime, q) {
  if (!q) return true;
  const k = q.trim().toLowerCase();
  if (!k) return true;
  return [anime.titleZh, anime.titleJa, anime.studio, ...(anime.tags || [])]
    .filter(Boolean)
    .some((s) => String(s).toLowerCase().includes(k));
}

export const SORTERS = {
  air: (a, b) => Date.parse(a.begin || 0) - Date.parse(b.begin || 0),
  score: (a, b) => (b.score || 0) - (a.score || 0),
  heat: (a, b) => (b.watchers || 0) - (a.watchers || 0),
  title: (a, b) => String(a.titleZh || a.titleJa).localeCompare(String(b.titleZh || b.titleJa), 'zh-Hans'),
};

export function filterSeason(list, { keyword = '', followedOnly = false, platform = 'all' } = {}, followedIds = new Set()) {
  return list.filter((a) => {
    if (!matchKeyword(a, keyword)) return false;
    if (followedOnly && !followedIds.has(a.id)) return false;
    if (platform !== 'all' && a.platform !== platform) return false;
    return true;
  });
}

export function sortList(list, key = 'air') {
  const fn = SORTERS[key] || SORTERS.air;
  return [...list].sort(fn);
}
