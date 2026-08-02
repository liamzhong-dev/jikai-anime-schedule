import React, { useState } from 'react';

/**
 * 封面。
 *
 * 两条路：
 *   - 真实数据源给了封面地址 → 直接 <img>，加载失败再退回色块，不留破图；
 *   - 没有封面（条目还没图、或联网补全没跑到）→ 由标题派生一对稳定色相渐变 + 首字。
 * 用派生色而不是占位图，是为了不引用任何外部图片资源。
 */

/** 由字符串派生稳定的色相；同一个名字每次算出来都一样 */
export function hueOf(seed) {
  let h = 0;
  const s = String(seed ?? '');
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

export function fallbackGradient(seed) {
  const h = hueOf(seed);
  return `linear-gradient(150deg, hsl(${h} 62% 46%), hsl(${(h + 48) % 360} 58% 32%))`;
}

export default function Cover({ anime, className = '', children, style }) {
  const title = anime?.titleZh || anime?.titleJa || '?';
  const glyph = title.slice(0, 1);
  const url = typeof anime?.cover === 'string' && anime.cover ? anime.cover : null;
  const [broken, setBroken] = useState(false);
  const showImg = Boolean(url) && !broken;

  return (
    <div
      className={`cover ${className}`.trim()}
      style={{ background: fallbackGradient(title), ...style }}
    >
      {showImg ? (
        <img
          className="cover__img"
          src={url}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setBroken(true)}
        />
      ) : (
        <span className="cover__glyph">{glyph}</span>
      )}
      {children}
    </div>
  );
}
