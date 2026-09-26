/**
 * 跨季快速搜索 —— 把顶栏那个搜索框从「只筛本季」扩到「搜全量名称索引」。
 *
 * 起因是一个很日常的卡点：想找一部番，得先知道它在哪一季。
 * 名称索引里其实已经躺着八千多部（含中文 / 日文 / 英文名），
 * 但那份索引当时只服务「加入补番清单」这一个动作 —— 在老番上点开看一眼、
 * 或者只是想确认「这部是不是我看过的那部」，都没有入口。
 *
 * 本模块只做「把命中结果按在不在本季切开」这一件纯事：
 *   - 本季命中的不用重复列出（主区域本来就按关键词过滤过一遍了）；
 *   - 不在本季的才是这个功能的增量，交给下拉去展示。
 *
 * 不碰 React、不碰平台适配器 —— 全部能被 node --test 守住。
 */

/**
 * 名称索引里的条目只有 y / q（年份、季度号），换成季度键。
 * 拿不到就返回 null：索引里有些条目没有 begin，那它们归不进任何一季，
 * 但**依然应该能被搜到**（只是标签显示为空），所以这里不丢条目，只丢标签。
 */
export function seasonKeyOfEntry(entry) {
  const y = Number(entry?.y);
  const q = Number(entry?.q);
  if (!Number.isFinite(y) || !Number.isFinite(q) || q < 1 || q > 4) return null;
  return `${y}q${q}`;
}

/** 把索引条目整理成下拉要用的形状；字段名收敛到界面真正会用的那几个 */
export function shapeHit(hit) {
  const type = String(hit?.t ?? 'tv').toLowerCase();
  return {
    id: Number(hit?.id),
    zh: String(hit?.zh ?? '').trim(),
    ja: String(hit?.ja ?? '').trim(),
    en: String(hit?.en ?? '').trim(),
    type,
    seasonKey: seasonKeyOfEntry(hit),
    score: Number(hit?.score ?? 0),
  };
}

/**
 * 把 searchNames 的结果切成「本季的」和「其他季度的」。
 *
 * 为什么不是简单地取前 N 条：真实场景里搜「转生」这类高频词，本季可能一下
 * 命中五六部，按分数排序的话别季的老番会被整片挤掉 —— 而下拉存在的理由
 * 恰恰是「本季没有、想找别季」。所以先按季过滤，再取前 N。
 *
 * @param {Array} hits searchNames 的产物（已按相关度排好序）
 * @param {Iterable} seasonIds 本季的 id 集合
 * @param {{othersLimit?:number}} opts
 * @returns {{others:Array, inSeason:number}} inSeason 是本季命中数，界面拿它说一句「另有 N 部在本季」
 */
export function splitHits(hits, seasonIds, { othersLimit = 8 } = {}) {
  const ids = seasonIds instanceof Set ? seasonIds : new Set((seasonIds ?? []).map(Number));
  const others = [];
  let inSeason = 0;

  for (const h of hits ?? []) {
    const id = Number(h?.id);
    if (!Number.isFinite(id)) continue;
    if (ids.has(id)) { inSeason += 1; continue; }
    if (others.length < Math.max(1, othersLimit)) others.push(shapeHit(h));
  }

  return { others, inSeason };
}

/**
 * 命中的条目本地没有完整资料时，用索引里那点信息拼一个「够用」的条目给详情抽屉。
 *
 * 抽屉对空字段是有兜底的（评分显示「评分待补」、剧集区显示「没有可推算的剧集时间」），
 * 所以这里只要把名字、平台、外链填对，用户就能确认「是不是这部」并跳去 Bangumi
 * 看完整资料 —— 比什么都不给、直接显示「条目 12345」强得多。
 *
 * 标了 __stub，界面可以据此说一句「这部只有名字，本地没有详细资料」。
 */
export function stubFromHit(hit) {
  const id = Number(hit?.id);
  const zh = String(hit?.zh ?? '').trim();
  const ja = String(hit?.ja ?? '').trim();
  const title = zh || ja || `条目 ${id}`;
  return {
    id,
    titleZh: zh,
    titleJa: ja || title,
    platform: String(hit?.type ?? 'tv').toUpperCase(),
    season: hit?.seasonKey ?? null,
    eps: null,
    score: null,
    watchers: null,
    studio: null,
    cover: null,
    tags: [],
    summary: '',
    begin: null,
    broadcast: null,
    external: {
      bangumi: `https://bgm.tv/subject/${id}`,
      moegirl: `https://zh.moegirl.org.cn/index.php?search=${encodeURIComponent(title)}`,
    },
    __stub: true,
  };
}
