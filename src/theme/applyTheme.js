/**
 * 把主题色 + 壁纸参数换算成一组 CSS 变量，写到 :root 上。
 *
 * 拆成「计算」和「写入」两步：computeThemeVars 是纯函数（不碰 DOM），
 * 所以单测和无头环境都能直接断言变量值，不用起浏览器。
 */

import { DEFAULT_THEME, getTheme } from './themes.js';

/** '#0c0e13' 或 'rgba(...)' / 'rgb(...)' 都吃 */
function toRgb(color) {
  const s = String(color ?? '').trim();
  if (s.startsWith('#')) {
    let hex = s.slice(1);
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    if (hex.length !== 6) return { r: 0, g: 0, b: 0 };
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }
  const m = s.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
  return { r: 0, g: 0, b: 0 };
}

const triple = (color) => {
  const { r, g, b } = toRgb(color);
  return `${Math.round(r)},${Math.round(g)},${Math.round(b)}`;
};

const soft = (color, alpha) => `rgba(${triple(color)},${alpha})`;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(+v) ? +v : lo));

/** 壁纸默认参数；用户改的每一项都会覆盖到这里 */
export const DEFAULT_WALLPAPER = {
  enabled: false,
  dataUrl: null,
  name: null,
  opacity: 0.55,     // 壁纸图层不透明度
  blur: 0,           // 模糊半径 px
  brightness: 1,     // 亮度倍数
  scale: 1.04,       // 轻微放大，避免模糊时露出边缘
  position: 'center',
  dim: 0.22,         // 压在壁纸上的暗角，保证文字可读
};

export function normalizeWallpaper(wp) {
  const w = { ...DEFAULT_WALLPAPER, ...(wp ?? {}) };
  return {
    ...w,
    enabled: Boolean(w.enabled && w.dataUrl),
    opacity: clamp(w.opacity, 0, 1),
    blur: clamp(w.blur, 0, 40),
    brightness: clamp(w.brightness, 0.2, 2),
    scale: clamp(w.scale, 1, 3),
    dim: clamp(w.dim, 0, 0.85),
    position: ['center', 'top', 'bottom', 'left', 'right'].includes(w.position) ? w.position : 'center',
  };
}

/**
 * 纯计算：返回要注入的 CSS 变量表。
 * @param {string} themeId
 * @param {{ wallpaper?: object, panelAlpha?: number, density?: number }} opts
 */
export function computeThemeVars(themeId, opts = {}) {
  const theme = getTheme(themeId ?? DEFAULT_THEME);
  const c = theme.colors;
  const light = theme.scheme === 'light';
  const wp = normalizeWallpaper(opts.wallpaper);
  const panelAlpha = clamp(opts.panelAlpha ?? 1, 0.3, 1);

  // 侧栏与顶栏比卡片更“实”一点，否则壁纸一开整个界面就飘了
  // 两位小数是必要的：浮点相加会算出 0.5800000000000001 这种值，
  // 直接塞进 CSS 既难看又会让断言难写。
  const round2 = (v) => Math.round(v * 100) / 100;
  const chromeAlpha = round2(clamp(panelAlpha + 0.18, 0.45, 1));
  // 面板内层（列表行、统计格）再压一层，保证层次还分得清
  const innerAlpha = round2(clamp(panelAlpha + 0.08, 0.35, 1));

  const shadow = light
    ? { sm: '0 6px 18px rgba(15,23,42,0.10)', lg: '0 18px 44px rgba(15,23,42,0.16)' }
    : { sm: '0 8px 24px rgba(0,0,0,0.34)', lg: '0 18px 44px rgba(0,0,0,0.5)' };

  return {
    // 底色
    '--bg': c.bg,
    '--bg-rgb': triple(c.bg),
    '--bg-2': c.bg2,
    '--bg-2-rgb': triple(c.bg2),
    '--panel-rgb': triple(c.panel),
    '--panel-2-rgb': triple(c.panel2),
    '--panel': `rgba(${triple(c.panel)},${panelAlpha})`,
    '--panel-2': `rgba(${triple(c.panel2)},${innerAlpha})`,
    '--chrome': `rgba(${triple(c.bg2)},${chromeAlpha})`,
    '--panel-alpha': String(panelAlpha),

    // 线与字
    '--line': c.border,
    '--line-2': c.border2,
    '--text': c.text,
    '--text-rgb': triple(c.text),
    '--text-2': c.text2,
    '--text-3': c.text3,

    // 强调色
    '--accent': c.accent,
    '--accent-rgb': triple(c.accent),
    '--accent-soft': soft(c.accent, light ? 0.14 : 0.16),
    '--accent-2': c.accent2,
    '--accent-2-rgb': triple(c.accent2),
    '--accent-2-soft': soft(c.accent2, light ? 0.12 : 0.13),
    '--on-accent': c.onAccent,

    // 语义色
    '--warn': c.warn,
    '--warn-rgb': triple(c.warn),
    '--warn-soft': soft(c.warn, 0.14),
    '--danger': c.danger,
    '--danger-rgb': triple(c.danger),
    '--danger-soft': soft(c.danger, 0.13),
    '--ok': c.ok,
    '--ok-rgb': triple(c.ok),
    '--ok-soft': soft(c.ok, 0.12),

    // 形状与阴影
    '--r-lg': `${c.radius.lg}px`,
    '--r': `${c.radius.r}px`,
    '--r-sm': `${c.radius.sm}px`,
    '--shadow': shadow.sm,
    '--shadow-lg': shadow.lg,

    // 壁纸
    '--wp-url': wp.dataUrl ? `url("${wp.dataUrl}")` : 'none',
    '--wp-opacity': String(wp.opacity),
    '--wp-blur': `${wp.blur}px`,
    '--wp-brightness': String(wp.brightness),
    '--wp-scale': String(wp.scale),
    '--wp-position': wp.position,
    '--wp-dim': String(wp.dim),

    // 覆盖层与原生控件
    '--scrim': light ? 'rgba(15,23,42,0.42)' : 'rgba(5,7,11,0.58)',
    '--on-cover': '#ffffff',
    '--scheme': theme.scheme,
  };
}

/** 把变量写到 root；非浏览器环境（SSR / 单测）直接跳过 */
export function applyTheme(themeId, opts = {}) {
  const vars = computeThemeVars(themeId, opts);
  const root = globalThis.document?.documentElement;
  if (!root) return vars;
  const theme = getTheme(themeId ?? DEFAULT_THEME);
  root.dataset.theme = theme.id;
  root.dataset.scheme = theme.scheme;
  root.style.colorScheme = theme.scheme;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  return vars;
}
