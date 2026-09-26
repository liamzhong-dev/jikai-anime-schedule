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

export default function Cover({ anime, className = '', children, style, onOpen, openLabel }) {
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
      {/*
        整块封面就是「打开详情」的热区 —— 传了 onOpen 才有。
        
        ⚠️ 为什么做进 Cover，而不是在每个视图外面各铺一个按钮：
        它一开始只做在本季卡片（AnimeCard）里，结果**只有那一个视图能点封面** ——
        时间表、追番、补番、日记、历程里的封面全是死的，点上去毫无反应，
        而用户根本不会想到「同样一张封面，换个页面就不能点了」。
        「封面能点开详情」这件事在哪儿都该成立，所以收到这里来。
        
        做成**可选 prop**：不传就没有热区，因此抽屉、报告这些不需要的地方
        （封面在那里只是个装饰/素材）不受影响 —— 早先把它写进组件里、
        一改就顺带改掉其余六处的顾虑，靠这个默认关闭解决了。
        
        必须排在 children **之前**：徽标与星标要压在它上面，否则点星标会连带开详情。
        也必须是**真的 <button>**：`div + onClick` 吃不到 Tab 与回车。
      */}
      {onOpen ? (
        <button
          type="button"
          className="cover__hot"
          data-cover-open={anime?.id ?? ''}
          aria-label={openLabel ?? `打开《${title}》的详情`}
          onClick={() => onOpen(anime)}
        />
      ) : null}
      {children}
    </div>
  );
}
