import React, { useState } from 'react';
import { fallbackGradient } from '../core/palette.js';
import { useCoverSrc } from './CoverContext.jsx';

/**
 * 封面。
 *
 * 三条路，按优先级：
 *   1. **本地缓存**（`CoverContext` 里按条目 id 取回来的 dataUrl）——
 *      断网时它还在，所以这是首选；
 *   2. 远端直链（只在 `allowRemote` 时用；桌面壳里关掉，否则浏览器先下一遍、
 *      主进程再下一遍）；
 *   3. 由标题派生一对稳定色相渐变 + 首字 —— 不引用任何外部图片资源。
 *
 * 加载失败一律退回色块，不留破图。记的是「**哪一个地址**失败了」而不是「失败过」：
 * 缓存里的 dataUrl 稍后到位时地址会变，那时得让它再试一次，否则这一格会永远停在色块上。
 *
 * `data-cover` 把「这张图是从哪来的」写进 DOM —— 自动化检查靠它判断降级路径走没走，
 * 光看有没有 `<img>` 是不准的（加载失败后 React 会把它换成色块）。
 *
 * 派生色的算法挪到 `core/palette.js` 了 —— 导出 canvas 那一侧要用同一套颜色，
 * 放组件里的话导出模块就得 import 一个 .jsx。
 */
export { hueOf, fallbackGradient } from '../core/palette.js';

export default function Cover({ anime, className = '', children, style }) {
  const title = anime?.titleZh || anime?.titleJa || '?';
  const glyph = title.slice(0, 1);
  const { cache, remote } = useCoverSrc(anime);
  const [failed, setFailed] = useState(null);
  const wanted = cache || remote;
  const src = wanted && wanted !== failed ? wanted : null;
  const kind = src ? (cache ? 'cache' : 'remote') : 'none';

  return (
    <div
      className={`cover ${className}`.trim()}
      data-cover={kind}
      style={{ background: fallbackGradient(title), ...style }}
    >
      {src ? (
        <img
          className="cover__img"
          src={src}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(src)}
        />
      ) : (
        <span className="cover__glyph">{glyph}</span>
      )}
      {children}
    </div>
  );
}
