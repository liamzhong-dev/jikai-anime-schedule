import { useCallback, useEffect, useRef, useState } from 'react';
import { insertIndexAt } from './tierlist.js';

/**
 * 拖拽排序：pointer events 自研。
 *
 * 为什么不用 HTML5 的 draggable：
 *   1) 它的 dragover 事件在自定义落点上很难拿到「插到第几个」；
 *   2) 拖起来的影子是浏览器画的，改不了样式，跟版面里的图块对不上；
 *   3) 触摸设备上根本不触发。
 * 自研之后这些都能自己定，代价就是这一百多行。
 *
 * 落点换算交给 `insertIndexAt`（纯函数，已被测试守住）——
 * 这里只负责「把真实鼠标坐标喂进去、把算出的档位与序号吐出来」。
 *
 * 两个刻意的设计：
 *   - **有 4px 启动阈值**：没超过阈值就不算拖，pointerup 时也不触发移动。
 *     否则「点一下移除图块」会被拖拽逻辑吃掉。
 *   - **素材池也是一个落点**（`toRow: null`），拖进去就是「移回池子」。
 *     没有这个，用户只能靠点 ✕ 把图块弄出来。
 */

const START_THRESHOLD = 4;

/**
 * 从注册进来的元素上量出各行的矩形。
 * count 从 `data-count` 上读 —— hook 因此不需要知道 items，量矩形的活全在 DOM 侧。
 */
function rectsOf(rows, poolEl) {
  const rowRects = [];
  for (const [rowId, el] of rows) {
    if (!el || typeof el.getBoundingClientRect !== 'function') continue;
    const r = el.getBoundingClientRect();
    rowRects.push({
      rowId,
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
      count: Number(el.dataset?.count ?? 0) || 0,
    });
  }
  const pool = poolEl && typeof poolEl.getBoundingClientRect === 'function'
    ? poolEl.getBoundingClientRect()
    : null;
  return { rowRects, pool };
}

function inRect(x, y, r) {
  return x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height;
}

export function useDragSort({ itemW = 100, itemH = 140, gap = 8, onDrop, disabled = false } = {}) {
  const [drag, setDrag] = useState(null);
  const rowEls = useRef(new Map());
  const poolEl = useRef(null);
  const dragRef = useRef(null);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  /** 给档位行用的 ref 回调：卸载时要把自己摘掉，否则量矩形会量到已经不存在的行 */
  const registerRow = useCallback((rowId) => (el) => {
    if (el) rowEls.current.set(rowId, el);
    else rowEls.current.delete(rowId);
  }, []);

  const registerPool = useCallback((el) => {
    poolEl.current = el;
  }, []);

  // 卸载时把可能还挂着的监听摘干净 —— 拖到一半组件卸载会留下一个永远不结束的拖
  useEffect(() => () => { dragRef.current = null; }, []);

  const begin = useCallback((e, { key, rowId = null } = {}) => {
    if (disabled || dragRef.current || !key) return;
    if (e.button != null && e.button !== 0) return; // 只认左键

    const startX = e.clientX;
    const startY = e.clientY;
    dragRef.current = { key, fromRow: rowId, started: false };

    const finish = (ev, commit) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      const payload = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!commit || !payload?.started) return;
      const target = payload.target;
      if (!target) return;
      if (target.pool) onDropRef.current?.({ key: payload.key, toRow: null });
      else onDropRef.current?.({ key: payload.key, toRow: target.rowId, index: target.index });
    };

    const onMove = (ev) => {
      const payload = dragRef.current;
      if (!payload) return;
      if (!payload.started) {
        const moved = Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY);
        if (moved < START_THRESHOLD) return;
        payload.started = true;
      }

      const { rowRects, pool } = rectsOf(rowEls.current, poolEl.current);
      let target = null;

      if (pool && inRect(ev.clientX, ev.clientY, pool)) {
        target = { pool: true };
      } else {
        const hit = insertIndexAt({
          x: ev.clientX,
          y: ev.clientY,
          rowRects,
          itemW,
          itemH,
          gap,
        });
        if (hit) target = { rowId: hit.rowId, index: hit.index, pool: false };
      }

      payload.target = target;
      setDrag({
        key: payload.key,
        fromRow: payload.fromRow,
        toRow: target?.pool ? null : target?.rowId ?? null,
        index: target?.index ?? 0,
        overPool: Boolean(target?.pool),
        x: ev.clientX,
        y: ev.clientY,
      });
    };

    const onUp = (ev) => finish(ev, true);

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [disabled, itemW, itemH, gap]);

  return {
    drag,
    begin,
    registerRow,
    registerPool,
    isDragging: Boolean(drag),
  };
}
