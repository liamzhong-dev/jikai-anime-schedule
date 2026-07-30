/**
 * 配色主题表。
 *
 * 每套主题只声明「原始色值」，派生量（RGB 三元组、soft 背景、阴影、圆角）
 * 统一在 applyTheme.js 里算出来注入 CSS 变量。这样加一套主题只需要往这个
 * 数组里加一条，不用碰样式文件。
 *
 * 字段说明：
 *   bg/bg2        页面底色、侧栏与顶栏底色
 *   panel/panel2  卡片面板、面板内层（列表行、统计格）
 *   text/text2/text3  正文 / 次要 / 微弱
 *   accent        主强调色（行动召唤），accent2 副强调色（时间、数字）
 *   warn/danger/ok  deadline 三档与「已更新」提示
 *   border/border2 分隔线与加重分隔线（带透明度的色值，直接写 rgba）
 *   onAccent      压在 accent 底色上的文字色（浅色强调色必须配深字，否则读不清）
 *   radius        圆角三档，萌系主题会更大
 *   scheme        'dark' | 'light'，用于原生控件配色（select / 日期选择器 / 滚动条）
 */

export const THEMES = [
  {
    id: 'night',
    name: '夜航',
    group: '本作默认',
    desc: '深蓝黑底 + 紫青双点缀。夜里等更新时看不刺眼，也是最初那版。',
    scene: '默认主题 · 长时间夜间使用',
    scheme: 'dark',
    preview: ['#0c0e13', '#151922', '#8b7cf6', '#56d4c4', '#e9ebf1'],
    colors: {
      bg: '#0c0e13', bg2: '#101319', panel: '#151922', panel2: '#1b2029',
      text: '#e9ebf1', text2: '#98a0b3', text3: '#666e80',
      accent: '#8b7cf6', accent2: '#56d4c4',
      warn: '#f0a24b', danger: '#f2647a', ok: '#63c98d',
      border: 'rgba(255,255,255,0.07)', border2: 'rgba(255,255,255,0.14)',
      onAccent: '#0c0e13',
      radius: { lg: 14, r: 10, sm: 8 },
    },
  },
  {
    id: 'linear',
    name: 'Linear 极客黑',
    group: '主流简洁',
    desc: '纯黑到深灰的层次递进，单一紫色作为行动召唤色，视觉极度克制。',
    scene: '项目管理 · 开发者工具 · SaaS 后台',
    scheme: 'dark',
    preview: ['#0f0f10', '#1c1c1f', '#8b5cf6', '#60a5fa', '#e4e4e7'],
    colors: {
      bg: '#0f0f10', bg2: '#161618', panel: '#1c1c1f', panel2: '#2c2c31',
      text: '#e4e4e7', text2: '#a1a1aa', text3: '#71717a',
      accent: '#8b5cf6', accent2: '#60a5fa',
      warn: '#fbbf24', danger: '#f87171', ok: '#4ade80',
      border: 'rgba(255,255,255,0.08)', border2: 'rgba(255,255,255,0.16)',
      onAccent: '#ffffff',
      radius: { lg: 12, r: 9, sm: 7 },
    },
  },
  {
    id: 'notion',
    name: 'Notion 柔和白',
    group: '主流简洁',
    desc: '暖调米白替代冷白，降低长时间阅读的视觉疲劳，蓝色点缀克制不张扬。',
    scene: '笔记应用 · 文档协作 · 知识库',
    scheme: 'light',
    preview: ['#ffffff', '#f7f7f5', '#2383e2', '#0f9b8e', '#37352f'],
    colors: {
      bg: '#ffffff', bg2: '#f7f7f5', panel: '#ffffff', panel2: '#f7f7f5',
      text: '#37352f', text2: '#6b6b66', text3: '#9b9a97',
      accent: '#2383e2', accent2: '#0f9b8e',
      warn: '#d9730d', danger: '#e03e3e', ok: '#0f7b6c',
      border: 'rgba(15,15,15,0.09)', border2: 'rgba(15,15,15,0.18)',
      onAccent: '#ffffff',
      radius: { lg: 12, r: 9, sm: 7 },
    },
  },
  {
    id: 'raycast',
    name: 'Raycast 深邃蓝',
    group: '主流简洁',
    desc: '偏蓝调的深色背景比纯黑更有层次感，苹果蓝作为唯一强调色，科技感十足。',
    scene: '快捷启动器 · 命令面板 · 终端美化',
    scheme: 'dark',
    preview: ['#0b0f19', '#1a1f2e', '#007aff', '#00d1ff', '#f5f5f7'],
    colors: {
      bg: '#0b0f19', bg2: '#121726', panel: '#1a1f2e', panel2: '#2a3040',
      text: '#f5f5f7', text2: '#a8b0c0', text3: '#86868b',
      accent: '#007aff', accent2: '#00d1ff',
      warn: '#ffb020', danger: '#ff453a', ok: '#30d158',
      border: 'rgba(255,255,255,0.08)', border2: 'rgba(255,255,255,0.16)',
      onAccent: '#ffffff',
      radius: { lg: 13, r: 10, sm: 8 },
    },
  },
  {
    id: 'stripe',
    name: 'Stripe 清爽紫',
    group: '主流简洁',
    desc: '冷调灰白底配品牌紫，文字用深藏青而非纯黑，专业感与现代感兼具。',
    scene: 'SaaS 产品 · 支付平台 · 企业官网',
    scheme: 'light',
    preview: ['#ffffff', '#f6f9fc', '#635bff', '#0ba5c9', '#0a2540'],
    colors: {
      bg: '#ffffff', bg2: '#f6f9fc', panel: '#ffffff', panel2: '#f6f9fc',
      text: '#0a2540', text2: '#425466', text3: '#8792a2',
      accent: '#635bff', accent2: '#0ba5c9',
      warn: '#c96a00', danger: '#cd3d64', ok: '#1c8b6a',
      border: 'rgba(10,37,64,0.09)', border2: 'rgba(10,37,64,0.18)',
      onAccent: '#ffffff',
      radius: { lg: 14, r: 10, sm: 8 },
    },
  },
  {
    id: 'cyber',
    name: '赛博霓虹',
    group: 'ACG 风格',
    desc: '霓虹粉与电青形成撞色，深紫黑底衬托发光效果，自带 2077 氛围感。',
    scene: '游戏启动器 · 二次元社区 · 虚拟主播工具',
    scheme: 'dark',
    preview: ['#0d0a1a', '#1a1033', '#ff2d75', '#00e5ff', '#e0e0ff'],
    colors: {
      bg: '#0d0a1a', bg2: '#150c2b', panel: '#1a1033', panel2: '#2a1a4a',
      text: '#e0e0ff', text2: '#a89fd0', text3: '#7a6fa8',
      accent: '#ff2d75', accent2: '#00e5ff',
      warn: '#ffb020', danger: '#ff5c5c', ok: '#3ce8a0',
      border: 'rgba(255,45,117,0.16)', border2: 'rgba(255,45,117,0.32)',
      onAccent: '#ffffff',
      radius: { lg: 12, r: 9, sm: 7 },
    },
  },
  {
    id: 'sakura',
    name: '樱雪和风',
    group: 'ACG 风格',
    desc: '低饱和樱粉配灰蓝，文字用暖棕而非纯黑，整体柔和治愈，像春日和纸。',
    scene: '二次元阅读 · 手账应用 · 和风游戏',
    scheme: 'light',
    preview: ['#faf7f5', '#f0e6e6', '#f4a7b9', '#7ba7c7', '#5c4033'],
    colors: {
      bg: '#faf7f5', bg2: '#f5eeec', panel: '#fffdfc', panel2: '#f0e6e6',
      text: '#5c4033', text2: '#8a7466', text3: '#b8a99a',
      accent: '#f4a7b9', accent2: '#7ba7c7',
      warn: '#d98d3a', danger: '#d9737f', ok: '#7fb69a',
      border: 'rgba(92,64,51,0.10)', border2: 'rgba(92,64,51,0.20)',
      onAccent: '#4a2b2b',
      radius: { lg: 18, r: 13, sm: 10 },
    },
  },
  {
    id: 'macaron',
    name: '马卡龙萌系',
    group: 'ACG 风格',
    desc: '高明度低饱和的马卡龙色系，圆角偏大、色彩柔和，甜而不腻。',
    scene: '萌系社交 · 换装游戏 · 壁纸应用',
    scheme: 'light',
    preview: ['#fff9f5', '#ffe4ec', '#ffb6c9', '#a8d8ea', '#6b5b73'],
    colors: {
      bg: '#fff9f5', bg2: '#fff1f5', panel: '#fffdfb', panel2: '#ffe4ec',
      text: '#6b5b73', text2: '#94849c', text3: '#b9a9bf',
      accent: '#ffb6c9', accent2: '#a8d8ea',
      warn: '#e2a04f', danger: '#ef8b9b', ok: '#7fc9a8',
      border: 'rgba(107,91,115,0.10)', border2: 'rgba(107,91,115,0.20)',
      onAccent: '#5a3a45',
      radius: { lg: 20, r: 14, sm: 11 },
    },
  },
  {
    id: 'mecha',
    name: '机甲战术风',
    group: 'ACG 风格',
    desc: '冷灰金属底色配荧光绿 HUD 色，橙色用于警示，战术仪表盘感强烈。',
    scene: '机甲游戏 · 军事模拟 · 数据监控面板',
    scheme: 'dark',
    preview: ['#12161c', '#1e242e', '#00ff88', '#ff6b1a', '#c8d0d8'],
    colors: {
      bg: '#12161c', bg2: '#191e26', panel: '#1e242e', panel2: '#2d3540',
      text: '#c8d0d8', text2: '#8e9aa6', text3: '#616d7a',
      accent: '#00ff88', accent2: '#ff6b1a',
      warn: '#ffb020', danger: '#ff4d4d', ok: '#38d39f',
      border: 'rgba(0,255,136,0.14)', border2: 'rgba(0,255,136,0.28)',
      onAccent: '#08120c',
      radius: { lg: 6, r: 4, sm: 3 },
    },
  },
];

export const DEFAULT_THEME = 'night';

export const THEME_GROUPS = ['本作默认', '主流简洁', 'ACG 风格'];

export function getTheme(id) {
  return THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_THEME);
}
