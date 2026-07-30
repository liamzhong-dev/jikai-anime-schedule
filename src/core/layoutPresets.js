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
  following: ['follow-queue', 'follow-summary', 'follow-next-week'],
  catchup: ['catchup-board', 'catchup-summary'],
};

export const ALL_CARD_IDS = Object.values(CARD_IDS).flat();

export const BUILTIN_PRESETS = [
  {
    id: 'builtin-default',
    name: '默认 · 宽屏双栏',
    desc: '主视图占左，信息栏贴右。1440 宽的窗口下正好铺满。',
    layout: {
      'season-stats': { x: 16, y: 16, w: 1260, h: 112 },
      'season-grid': { x: 16, y: 142, w: 1260, h: 660 },
      'sched-week': { x: 16, y: 16, w: 990, h: 660 },
      'sched-today': { x: 1020, y: 16, w: 256, h: 660 },
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
      'season-stats': { x: 16, y: 16, w: 1400, h: 100 },
      'season-grid': { x: 16, y: 130, w: 1400, h: 700 },
      'sched-week': { x: 16, y: 16, w: 1160, h: 700 },
      'sched-today': { x: 1190, y: 16, w: 226, h: 700 },
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
      'season-stats': { x: 12, y: 12, w: 660, h: 100 },
      'season-grid': { x: 12, y: 124, w: 660, h: 440 },
      'sched-week': { x: 12, y: 12, w: 660, h: 470 },
      'sched-today': { x: 12, y: 494, w: 660, h: 300 },
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
      'season-stats': { x: 12, y: 12, w: 880, h: 96 },
      'season-grid': { x: 12, y: 118, w: 880, h: 520 },
      'sched-week': { x: 12, y: 12, w: 660, h: 520 },
      'sched-today': { x: 684, y: 12, w: 210, h: 520 },
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
