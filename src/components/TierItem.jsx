import React, { useState } from 'react';
import { fallbackGradient } from '../core/palette.js';

/**
 * 一个图块。
 *
 * 封面优先用**本地缓存取回来的 dataUrl**（`image`），拿不到才退回派生色块。
 * 不直接写 `<img src={远端地址}>`：断网时那是一片空白，而缓存里的图还在。
 *
 * `remote` = 允许直接用远端封面地址。
 * 桌面壳里**不要**开这个：那样会先由浏览器下一遍 45MB，主进程再下一遍进缓存。
 * 但浏览器壳没有缓存通道，不开就永远只能是色块 —— 两害相权，那边让它直连。
 *
 * 名字只显示一行、超出打点 —— 档位表里一行可能十几个，
 * 名字换行会把整行撑高，版面就散了。
 */
export default function TierItem({
  anime,
  image = null,
  remote = false,
  dragging = false,
  ghost = false,
  onPointerDown,
  onRemove,
  onPick,
}) {
  const title = anime?.titleZh || anime?.titleJa || `条目 ${anime?.id ?? '?'}`;
  const score = Number(anime?.score);
  // 加载失败要退回色块，别留破图 —— 和 Cover.jsx 一个规矩。
  // 断网时远端封面必然加载失败，一屏破图比一屏色块难看多了。
  //
  // 记的是「哪一个地址失败了」，不是「失败过」：缓存里的 dataUrl 稍后到位时
  // 地址会变，那时得让它再试一次，否则这一格会永远停在色块上。
  const [failed, setFailed] = useState(null);
  const wanted = image || (remote && typeof anime?.cover === 'string' ? anime.cover : null);
  const src = wanted && wanted !== failed ? wanted : null;

  return (
    <div
      className={`tier-item${dragging ? ' is-dragging' : ''}${ghost ? ' tier-item--ghost' : ''}`}
      // 图上哪来的，写在 DOM 里：自动化检查才能判断「降级路径到底走没走」——
      // 光看有没有 <img> 是不准的，加载失败后 React 会把它换成色块。
      data-cover={image ? 'cache' : (wanted ? 'remote' : 'none')}
      onPointerDown={onPointerDown}
      title={title}
    >
      <div className="tier-item__art" style={{ background: fallbackGradient(title) }}>
        {src ? (
          <img
            className="tier-item__img"
            src={src}
            alt=""
            draggable={false}
            referrerPolicy="no-referrer"
            onError={() => setFailed(src)}
          />
        ) : (
          <span className="tier-item__glyph">{title.slice(0, 1)}</span>
        )}
        {Number.isFinite(score) && score > 0 ? (
          <span className="tier-item__score">{score.toFixed(1)}</span>
        ) : null}
      </div>
      <div className="tier-item__name">{title}</div>

      {onRemove ? (
        <button
          type="button"
          className="tier-item__x"
          title="移回素材池"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
        >
          ✕
        </button>
      ) : null}
      {onPick ? (
        <button
          type="button"
          className="tier-item__add"
          title="加到 TOP"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onPick(); }}
        >
          +
        </button>
      ) : null}
    </div>
  );
}
