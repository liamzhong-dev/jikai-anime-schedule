/**
 * 内置布局预设。
 *
 * 卡片窗口是可以自由拖放的，但「拖乱了想回到能用」这件事必须有出路，
 * 所以除了用户自存的预设，这里放几套开箱可用的。
 *
 * 每个预设是一张 { 卡片 id: {x,y,w,h} } 的平铺表，四个视图共用一套表
 * —— 因为卡片 id 本身是全局唯一的，切视图不会互相干扰。
 */

/** 四个视图实际用到的卡片 id，导出给「整理排列」和测试用 */
export const CARD_IDS = {
  season: ['season-stats', 'season-grid'],
  schedule: ['sched-week', 'sched-today'],
  yuc: ['yuc-board', 'yuc-detail'],
  following: ['follow-queue', 'follow-summary', 'follow-next-week'],
  catchup: ['catchup-board', 'catchup-summary'],
};

export const ALL_CARD_IDS = Object.values(CARD_IDS).flat();

/**
 * 「本季概览」那张卡**占**的高度。
 *
 * ⚠️ 它不是真正的卡片高度 —— 那张卡用的是 `fitHeight`（高度由内容撑，见 WindowCard），
 * 摆位里的 `h` 对它不起作用。这个数只干一件事：**给下面的「番剧库」留位置**，
 * 预设里 `season-grid` 的 `y` 就按 `y + SEASON_STATS_H + SEASON_STATS_GAP` 算。
 *
 * 实测值：卡片真实高度是 **143px**（42 标题栏 + 2 上下边框 + 28 内边距 + 71 的统计块），
 * 这里取 148 是留了 5px 余量 —— 宁可多留，它是「不叠在一起」这条的唯一保险，
 * 少算一点点就会盖住番剧库的标题栏。
 * ⚠️ 动了 `.stat` / `.stat__value` / `.stat__label` 的字号或内边距就要重新量
 * （桌面探针的 `statsFit.cardH` 就是现成的读数）。
 * 少算了的表现是**概览条盖住番剧库的标题栏**，而这件事在代码里一个字都看不出来 ——
 * 桌面自检里那条「两张卡不许叠」（`gridGap >= 0`）就是为它准备的。
 */
export const SEASON_STATS_H = 148;

/** 概览条和它下面那张卡之间留的空隙 */
export const SEASON_STATS_GAP = 16;

export const BUILTIN_PRESETS = [
  {
    id: 'builtin-default',
    name: '默认 · 宽屏双栏',
    desc: '主视图占左，信息栏贴右。1440 宽的窗口下正好铺满。',
    layout: {
      'season-stats': { x: 16, y: 16, w: 1260, h: SEASON_STATS_H },
      'season-grid': { x: 16, y: 16 + SEASON_STATS_H + SEASON_STATS_GAP, w: 1260, h: 622 },
      'sched-week': { x: 16, y: 16, w: 990, h: 660 },
      'sched-today': { x: 1020, y: 16, w: 256, h: 660 },
      'yuc-board': { x: 16, y: 16, w: 940, h: 660 },
      'yuc-detail': { x: 970, y: 16, w: 306, h: 660 },
      'follow-queue': { x: 16, y: 16, w: 940, h: 660 },
      'follow-summary': { x: 970, y: 16, w: 306, h: 420 },
      'follow-next-week': { x: 970, y: 450, w: 306, h: 226 },
      'catchup-board': { x: 16, y: 16, w: 990, h: 660 },
      'catchup-summary': { x: 1020, y: 16, w: 256, h: 470 },
    },
  },
  {
    id: 'builtin-focus',
    name: '专注 · 主卡优先',
    desc: '右边的信息栏压到最窄，把宽度全让给番剧网格和时间表。',
    layout: {
      'season-stats': { x: 16, y: 16, w: 1400, h: SEASON_STATS_H },
      'season-grid': { x: 16, y: 16 + SEASON_STATS_H + SEASON_STATS_GAP, w: 1400, h: 650 },
      'sched-week': { x: 16, y: 16, w: 1160, h: 700 },
      'sched-today': { x: 1190, y: 16, w: 226, h: 700 },
      'yuc-board': { x: 16, y: 16, w: 1160, h: 700 },
      'yuc-detail': { x: 1190, y: 16, w: 226, h: 700 },
      'follow-queue': { x: 16, y: 16, w: 1160, h: 700 },
      'follow-summary': { x: 1190, y: 16, w: 226, h: 392 },
      'follow-next-week': { x: 1190, y: 418, w: 226, h: 298 },
      'catchup-board': { x: 16, y: 16, w: 1160, h: 700 },
      'catchup-summary': { x: 1190, y: 16, w: 226, h: 486 },
    },
  },
  {
    id: 'builtin-stack',
    name: '纵向堆叠 · 窄屏友好',
    desc: '一列往下排，适合把窗口拉窄或者摆到竖屏副屏上。',
    layout: {
      'season-stats': { x: 12, y: 12, w: 660, h: SEASON_STATS_H },
      'season-grid': { x: 12, y: 12 + SEASON_STATS_H + SEASON_STATS_GAP, w: 660, h: 400 },
      'sched-week': { x: 12, y: 12, w: 660, h: 470 },
      'sched-today': { x: 12, y: 494, w: 660, h: 300 },
      'yuc-board': { x: 12, y: 12, w: 660, h: 430 },
      'yuc-detail': { x: 12, y: 454, w: 660, h: 300 },
      'follow-queue': { x: 12, y: 12, w: 660, h: 430 },
      'follow-summary': { x: 12, y: 454, w: 660, h: 300 },
      'follow-next-week': { x: 12, y: 766, w: 660, h: 180 },
      'catchup-board': { x: 12, y: 12, w: 660, h: 450 },
      'catchup-summary': { x: 12, y: 474, w: 660, h: 280 },
    },
  },
  {
    id: 'builtin-compact',
    name: '紧凑 · 小窗总览',
    desc: '所有卡片缩小塞进一屏，适合把台历常驻在屏幕角落扫一眼。',
    layout: {
      'season-stats': { x: 12, y: 12, w: 880, h: SEASON_STATS_H },
      'season-grid': { x: 12, y: 12 + SEASON_STATS_H + SEASON_STATS_GAP, w: 880, h: 462 },
      'sched-week': { x: 12, y: 12, w: 660, h: 520 },
      'sched-today': { x: 684, y: 12, w: 210, h: 520 },
      'yuc-board': { x: 12, y: 12, w: 620, h: 520 },
      'yuc-detail': { x: 644, y: 12, w: 250, h: 520 },
      'follow-queue': { x: 12, y: 12, w: 620, h: 520 },
      'follow-summary': { x: 644, y: 12, w: 250, h: 340 },
      'follow-next-week': { x: 644, y: 364, w: 250, h: 168 },
      'catchup-board': { x: 12, y: 12, w: 660, h: 520 },
      'catchup-summary': { x: 684, y: 12, w: 210, h: 400 },
    },
  },
];

export function presetById(id) {
  return BUILTIN_PRESETS.find((p) => p.id === id) ?? null;
}

/**
 * 把某张卡的当前摆位从布局里抹掉，让它回到 defaultRect。
 * 用户拖坏了单张卡片时，比整体重置更不打扰。
 */
export function dropCardFromLayout(layout, cardId) {
  const next = { ...(layout ?? {}) };
  delete next[cardId];
  return next;
}
