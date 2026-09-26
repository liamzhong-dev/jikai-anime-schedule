import React, { useState } from 'react';
import { seasonLabel } from '../core/time.js';

/**
 * 顶栏搜索框 + 跨季结果下拉。
 *
 * 输入框本体沿用原来的 class 与 data-search-input —— 快捷键「/」靠那个属性聚焦，
 * 样式也挂在 .topbar__search 上，换掉的话两处都会静默失效。
 *
 * 下拉只列**不在本季**的命中：本季的已经在主区域按关键词过滤过一遍了，
 * 再列一遍是重复；而用户搜一部老番时，主区域往往是空的，下拉正是补这个空。
 */
export default function SearchBox({
  value, onChange, onPick,
  others = [], inSeason = 0,
  ready = false, hint = '',
}) {
  const [dismissed, setDismissed] = useState(false);
  const q = String(value ?? '').trim();
  const show = Boolean(q) && !dismissed;

  return (
    <div className="qsearch" data-qsearch="1">
      <input
        className="topbar__search"
        value={value}
        placeholder="搜番剧名（不限本季）"
        onChange={(e) => {
          onChange(e.target.value);
          setDismissed(false);
        }}
        data-search-input="1"
      />

      {show ? (
        <div
          className="qsearch__panel"
          data-qsearch-panel={others.length}
          data-qsearch-in-season={inSeason}
          data-qsearch-ready={ready ? '1' : '0'}
        >
          {!ready ? (
            <div className="qsearch__note">{hint || '还没有名称索引，「设置 → 本地库」更新一次就能搜全量'}</div>
          ) : others.length === 0 ? (
            <div className="qsearch__note">
              {inSeason > 0
                ? `本季有 ${inSeason} 部匹配，已经在下面的列表里`
                : '全量索引里也没有匹配的番剧名'}
            </div>
          ) : (
            <>
              <div className="qsearch__head">全量索引里的匹配 · 共 {others.length} 部</div>
              {others.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  className="qsearch__item"
                  data-qsearch-item={h.id}
                  onClick={() => {
                    setDismissed(true);
                    onPick(h);
                  }}
                >
                  <span className="qsearch__name">{h.zh || h.ja}</span>
                  <span className="qsearch__meta">
                    {h.seasonKey ? seasonLabel(h.seasonKey) : '时间未知'} · {String(h.type).toUpperCase()}
                  </span>
                </button>
              ))}
              {inSeason > 0 ? (
                <div className="qsearch__note">本季另有 {inSeason} 部，已经在下面的列表里</div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
