import React, { createContext, useContext } from 'react';
import {
  CARD_MIN, FONT_SCALE, clampCardMin, clampFontScale, coverScaleFromCardMin,
} from '../core/layout.js';

/**
 * 「内容大小」的入口。
 *
 * 挂在 context 上而不是从 App 逐个传 props：窗口卡片有十几张，每张都要
 * 补一个 props 才能点开，漏一张就是「这张卡的按钮点了没反应」——
 * 而这种缺漏不会报错，只在用户手上显形。
 */
const ScaleCtx = createContext(null);

export function ScaleDockProvider({ onToggle, children }) {
  return <ScaleCtx.Provider value={{ onToggle }}>{children}</ScaleCtx.Provider>;
}

/**
 * 取「打开内容大小」的动作。
 *
 * 拿不到（组件被单独渲染、测试里没包 Provider）就返回 null —— 调用方据此**不渲染**那个按钮。
 * 宁可没有按钮，也不要一个点了没反应的按钮。
 */
export function useCardScaleToggle() {
  return useContext(ScaleCtx)?.onToggle ?? null;
}

/**
 * 右下角那个浮动调节盘。
 *
 * 为什么放在屏幕角落而不是做进某张卡里：这两个档位是**全站**的。
 * 做进某张卡片，用户会以为它只管那一张 —— 而实际上卡片排列已经是另一套东西，
 * 同一个软件里出现两套「大小」的入口，只会让人不知道该拉哪个。
 * 放在右下角还因为那儿是窗口最空的角落，浮出来不压内容。
 *
 * 值从外面进来（App 从 store 读），不自己去 store 里拉 ——
 * 单测与 SSR 断言要把「现在调到了多少」灌进去，藏在组件里就没法验。
 */
export default function ScaleDock({ open, cardMin, fontScale, onChange, onClose }) {
  if (!open) return null;

  const min = clampCardMin(cardMin);
  const fs = clampFontScale(fontScale);
  const scale = coverScaleFromCardMin(min);
  const isDefault = min === CARD_MIN.def && fs === FONT_SCALE.def;

  return (
    <aside className="scaledock" data-scale-dock="1" role="group" aria-label="内容大小">
      <header className="scaledock__head">
        <span className="scaledock__title">内容大小</span>
        <button
          type="button"
          className="scaledock__x"
          data-scale-close="1"
          title="收起"
          onClick={() => onClose?.()}
        >
          ✕
        </button>
      </header>

      <label className="scaledock__row">
        <span className="scaledock__label">
          封面
          <em data-scale-cover={`${Math.round(scale * 100)}%`}>{min}px</em>
        </span>
        <input
          type="range"
          className="scaledock__range"
          data-scale-cover-range="1"
          min={CARD_MIN.min}
          max={CARD_MIN.max}
          step={4}
          value={min}
          title="往左一屏塞得下更多封面，往右封面更大"
          onChange={(e) => onChange?.({ cardMin: Number(e.target.value) })}
        />
      </label>

      <label className="scaledock__row">
        <span className="scaledock__label">
          文字
          <em data-scale-font={`${Math.round(fs * 100)}%`}>{Math.round(fs * 100)}%</em>
        </span>
        <input
          type="range"
          className="scaledock__range"
          data-scale-font-range="1"
          min={FONT_SCALE.min}
          max={FONT_SCALE.max}
          step={FONT_SCALE.step}
          value={fs}
          title="只改字的大小，封面不动"
          onChange={(e) => onChange?.({ fontScale: Number(e.target.value) })}
        />
      </label>

      <p className="scaledock__note">所有页面的卡片跟着一起变</p>

      <button
        type="button"
        className="scaledock__reset"
        data-scale-reset="1"
        disabled={isDefault}
        onClick={() => onChange?.({ cardMin: CARD_MIN.def, fontScale: FONT_SCALE.def })}
      >
        {isDefault ? '已经是默认大小' : '回到默认'}
      </button>
    </aside>
  );
}
