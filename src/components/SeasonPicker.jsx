import React, { useMemo, useState } from 'react';
import { matchSeasons, seasonLabel } from '../core/time.js';

/**
 * 季度选择器。顶栏与「更新 Bangumi 数据」共用同一个 —— 两边要选的是同一批季度，
 * 分开写就会出现「顶栏能选到 2011 年、更新数据那边选不到」这种只有用户才发现的不一致。
 *
 * ## 为什么不是原生 `<select>`
 *
 * 可选季度现在有一百多个（2000 年至今），原生下拉在这种量级下只能靠滚动找；
 * 而用户脑子里的坐标是「2011 年 7 月」这种，不是「列表第 63 项」。所以给一个能打字的框：
 * 输 `2011`、`2011q3`、`2011 年 7 月` 都能落到同一季（见 `matchSeasons`）。
 *
 * 做成「按钮展开面板」而不是「输入框本身就是控件」，是因为后者在 React 受控组件里
 * 要额外处理「收起时显示当前值、聚焦时清空」这一套，稍微没写干净就会出现
 * 「删到一半值又被填回去」的怪现象 —— 而这里根本不需要那种交互。
 *
 * 两种模式：
 *   - `mode="single"`：选一季即收起，`onPick(key)`；
 *   - `mode="multi"`：勾选不收起，`onPick(下一份数组)`（顶栏那种场景用不上，
 *     「更新数据」要一次挑好几个季度）。
 */
export default function SeasonPicker({
  seasons = [],
  mode = 'single',
  value = '',
  values = [],
  onPick,
  disabled = false,
  // 只给 SSR / 截图用：展开态与搜索词是组件内部 state，
  // 不给口子的话「打开面板、搜 2011 年 7 月」这条分支在无头环境里验不到。
  initialOpen = false,
  initialQuery = '',
}) {
  const [open, setOpen] = useState(Boolean(initialOpen));
  const [q, setQ] = useState(initialQuery);
  const multi = mode === 'multi';
  const picked = multi ? values : (value ? [value] : []);

  // 列表按匹配结果收窄；没有关键词时就把全部放出来，但只渲染前 60 条 ——
  // 一百多个按钮全画出来在打开的那一刻会顿一下，而没人会去翻第 60 项之后。
  const matched = useMemo(() => matchSeasons(seasons, q), [seasons, q]);
  const shown = matched.slice(0, 60);
  const hidden = matched.length - shown.length;

  const close = () => { setOpen(false); setQ(''); };
  const isOn = (k) => picked.includes(k);

  const choose = (k) => {
    if (multi) {
      onPick?.(isOn(k) ? picked.filter((x) => x !== k) : [...picked, k]);
      return;
    }
    onPick?.(k);
    close();
  };

  return (
    <div className="spick" data-season-picker={mode}>
      <button
        type="button"
        className="spick__toggle"
        data-season-toggle="1"
        data-season-current={multi ? '' : (value || '')}
        disabled={disabled}
        title={multi ? '选择要更新的季度' : '切换季度'}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className="spick__label">
          {multi
            ? `要更新的季度 · 已选 ${picked.length} 个`
            : (value ? seasonLabel(value) : '选季度')}
        </span>
        <span className="spick__caret" aria-hidden="true">▾</span>
      </button>

      {open ? (
        <>
          <div className="spick__backdrop" onClick={close} />
          <div className="spick__panel" data-season-panel="1">
            <input
              className="spick__input"
              data-season-input="1"
              type="text"
              value={q}
              autoFocus
              placeholder="搜季度：2011 / 2011q3 / 2011 年 7 月"
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') close(); }}
            />

            {multi ? (
              <div className="spick__quick">
                <button
                  type="button"
                  className="btn btn--mini btn--ghost"
                  data-season-recent="1"
                  onClick={() => onPick?.(seasons.slice(0, 4))}
                >
                  最近四季
                </button>
                <button
                  type="button"
                  className="btn btn--mini btn--ghost"
                  data-season-clear="1"
                  onClick={() => onPick?.([])}
                >
                  清空
                </button>
              </div>
            ) : null}

            <div className="spick__list" data-season-count={matched.length}>
              {shown.length === 0 ? (
                <div className="spick__note" data-season-empty="1">
                  没匹配上 —— 试试 2011、2011q3，或者 2011 年 7 月
                </div>
              ) : (
                shown.map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={`spick__item${isOn(k) ? ' is-on' : ''}`}
                    data-season-item={k}
                    aria-pressed={isOn(k)}
                    onClick={() => choose(k)}
                  >
                    {seasonLabel(k)}
                  </button>
                ))
              )}
              {hidden > 0 ? (
                <div className="spick__note">还有 {hidden} 个，输入年份缩小范围</div>
              ) : null}
            </div>

            {multi ? (
              <div className="spick__foot" data-season-picked={picked.length}>
                已选 {picked.length} 个
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
