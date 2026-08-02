import React from 'react';
import { normalizeWallpaper } from '../theme/applyTheme.js';

/**
 * 壁纸图层。
 *
 * 只负责挂一个 div，具体的不透明度 / 模糊 / 亮度 / 缩放全部由 CSS 变量驱动
 * （--wp-*，见 applyTheme.js）。这样拖滑块改参数时不用重渲染整棵树，
 * 只要变量一变，浏览器自己重画。
 */
export default function WallpaperLayer({ wallpaper }) {
  const wp = normalizeWallpaper(wallpaper);
  if (!wp.enabled) return null;
  return <div className="wallpaper" aria-hidden="true" />;
}
