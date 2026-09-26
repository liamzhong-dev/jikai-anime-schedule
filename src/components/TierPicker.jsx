import React from 'react';
import TierItem from './TierItem.jsx';

/**
 * 素材池：**跟随当前季度**（决定 #1）。
 *
 * 只显示「还没排进档位」的条目 —— 已经在表里的要从池子里消失，
 * 否则同一个图块能被拖两次，拖出来两个一模一样的。
 *
 * 点「+」加到第一档，拖到任意一档放手也行。
 */
export default function TierPicker({
  pool = [],
  images = {},
  keyword = '',
  onKeyword,
  registerPool,
  onBeginDrag,
  onPick,
  hint = '',
  dropping = false,   // 有图块正被拖到池子上 —— 高亮出来，让人知道松手会发生什么
  remote = false,     // 没有缓存通道时允许直连远端封面，见 TierItem 里的说明
}) {
  return (
    <aside className="tier-pool">
      <div className="tier-pool__head">
        <div className="tier-pool__title">素材池</div>
        <div className="tier-pool__count">{pool.length} 部</div>
      </div>

      <input
        className="input tier-pool__search"
        placeholder="搜名字 / 制作公司"
        value={keyword}
        onChange={(e) => onKeyword?.(e.target.value)}
        data-search-input
      />

      {hint ? <div className="tier-pool__hint">{hint}</div> : null}

      <div className={`tier-pool__grid${dropping ? ' is-dropping' : ''}`} ref={registerPool}>
        {pool.length === 0 ? (
          <div className="empty">这一季的番剧都排进去了</div>
        ) : (
          pool.map((a) => (
            <TierItem
              key={a.id}
              anime={a}
              image={images[String(a.id)] ?? null}
              remote={remote}
              onPointerDown={(e) => onBeginDrag?.(e, { key: String(a.id), rowId: null })}
              onPick={() => onPick?.(a)}
            />
          ))
        )}
      </div>
    </aside>
  );
}
