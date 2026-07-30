/**
 * 番剧条目瘦身。
 *
 * 单独一个模块，是因为它有两个调用方：运行时（写缓存前）和构建脚本
 * （生成内置数据时）。放进 sources.js 会绕出一个环 —— 生成脚本要写
 * 内置数据文件，而内置数据文件又被 sources.js 引用。
 *
 * 瘦身的理由：一个季度的简介全文能到几 MB，缓存和内置数据都扛不住。
 * 截断到够看的长度，标签也限量。
 */
export function slimItems(items, { summaryMax = 240, tagMax = 8 } = {}) {
  return (items ?? []).map((a) => ({
    ...a,
    summary: a.summary ? String(a.summary).slice(0, summaryMax) : '',
    tags: Array.isArray(a.tags) ? a.tags.slice(0, tagMax) : [],
  }));
}
