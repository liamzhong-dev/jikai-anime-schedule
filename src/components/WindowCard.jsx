import React, { useEffect, useRef, useState } from 'react';
import { setLayout } from '../core/store.js';

const MIN_W = 300;
const MIN_H = 160;

/**
 * 卡片式窗口：拖标题栏移动、拖右下角缩放、双击标题栏最大化、按钮折叠。
 *
 * 拖动期间只动本地 state，松手才写回 store —— 否则每帧都会触发一次全局重渲染
 * 与一次落盘，拖起来会发涩。
 */
export default function WindowCard({ id, title, hint, actions, children, defaultRect, layout }) {
  const saved = layout?.[id];
  const initial = saved ?? defaultRect ?? { x: 16, y: 16, w: 640, h: 420 };

  const [rect, setRect] = useState(initial);
  const [mode, setMode] = useState(null); // move | resize | null
  const [maxed, setMaxed] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const drag = useRef(null);
  const restore = useRef(null);

  // 外部（例如换视图后 store 被重置）改了布局时同步一次
  useEffect(() => {
    if (saved && !mode) setRect(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved?.x, saved?.y, saved?.w, saved?.h]);

  useEffect(() => {
    if (!mode) return undefined;

    const onMove = (e) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (mode === 'move') {
        setRect({ ...d.base, x: Math.max(0, d.base.x + dx), y: Math.max(0, d.base.y + dy) });
      } else {
        setRect({
          ...d.base,
          w: Math.max(MIN_W, d.base.w + dx),
          h: Math.max(MIN_H, d.base.h + dy),
        });
      }
    };
    const onUp = () => {
      setMode(null);
      setRect((r) => {
        setLayout(id, r);
        return r;
      });
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [mode, id]);

  const start = (m) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    drag.current = { sx: e.clientX, sy: e.clientY, base: { ...rect } };
    setMode(m);
  };

  const toggleMax = () => {
    if (maxed && restore.current) {
      setRect(restore.current);
      setLayout(id, restore.current);
      restore.current = null;
      setMaxed(false);
    } else {
      restore.current = { ...rect };
      setMaxed(true);
    }
  };

  const style = maxed
    ? { left: 12, top: 12, width: 'calc(100% - 24px)', height: 'calc(100% - 24px)' }
    : { left: rect.x, top: rect.y, width: rect.w, height: collapsed ? 44 : rect.h };

  const cls = ['window'];
  if (maxed) cls.push('window--max');
  if (mode) cls.push('window--dragging');

  return (
    <section className={cls.join(' ')} style={style}>
      <header
        className="window__bar"
        onPointerDown={start('move')}
        onDoubleClick={toggleMax}
      >
        <span className="window__title">{title}</span>
        {hint ? <span className="window__hint">{hint}</span> : null}
        <div className="window__actions" onPointerDown={(e) => e.stopPropagation()}>
          {actions}
          <button
            type="button"
            className="window__btn"
            title={collapsed ? '展开' : '折叠'}
            onClick={() => setCollapsed((v) => !v)}
          >
            {collapsed ? '▣' : '—'}
          </button>
          <button type="button" className="window__btn" title={maxed ? '还原' : '最大化'} onClick={toggleMax}>
            {maxed ? '❐' : '□'}
          </button>
        </div>
      </header>

      {!collapsed && <div className="window__body">{children}</div>}
      {!collapsed && !maxed && (
        <div className="window__resize" title="拖动缩放" onPointerDown={start('resize')} />
      )}
    </section>
  );
}
