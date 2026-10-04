import React, { createContext, useContext } from 'react';

/**
 * 画布倍率：卡片摆位是按 1440×900 画的，渲染时各乘一次 `kx` / `kh`。
 *
 * 为什么不直接把缩放后的 px 写进 style：摆位是**存盘的**（`settings` 之外的
 * `layout`），用户拖过的位置下次启动还要在。存缩放后的值，等于把「这次窗口多大」
 * 一起写进了存档 —— 换个屏打开就是另一套摆位，而且不可逆。
 * 存基准值、渲染时乘，两个问题一起没了。
 *
 * 为什么是 React context 而不是让每张卡自己去读 CSS 变量：拖动时要**反过来**
 * 把屏幕位移换算回基准坐标（`dx / kx`），这一步必须拿到数值；而定位本身交给
 * `calc(Npx * var(--kx))`，倍率变了浏览器自己重排，不用重渲染整棵树。
 */
export const CanvasScaleContext = createContext({ kx: 1, kh: 1 });

export function useCanvasScale() {
  return useContext(CanvasScaleContext);
}

export default function CanvasScaleProvider({ value, children }) {
  return <CanvasScaleContext.Provider value={value}>{children}</CanvasScaleContext.Provider>;
}
