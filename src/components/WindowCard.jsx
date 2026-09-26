import React, { useEffect, useRef, useState } from 'react';
import { setLayout } from '../core/store.js';
import { RESIZE_CURSOR, RESIZE_DIRS, fitRect, resizeRect } from '../core/layout.js';

/**
 * 卡片式窗口：拖标题栏移动、拖**八条边**缩放、双击标题栏最大化、按钮折叠。
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
  const rootRef = useRef(null);
  const fitted = useRef(false);

  // 外部（例如换视图后 store 被重置）改了布局时同步一次
  useEffect(() => {
    if (saved && !mode) setRect(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved?.x, saved?.y, saved?.w, saved?.h]);

  /*
   * 首次挂载：默认摆位装不下就缩进来。
   *
   * 只在「这张卡用户还没摆过」时做一次（`saved` 为空）—— 已经摆过的是用户的
   * 选择，哪怕他把卡片拖到画布外面也不该被纠正（多屏、临时挪开都很正常）。
   * 不落盘：窗口重新变宽之后，默认摆位又该是原来的大小。
   */
  useEffect(() => {
    if (fitted.current || saved) return;
    fitted.current = true;
    const parent = rootRef.current?.parentElement;
    if (!parent) return;
    setRect((r) => {
      // 画布有 16px 内边距，而 absolute 定位的参照是 padding box，所以要减掉
      const next = fitRect(r, {
        availW: parent.clientWidth - r.x - 16,
        availH: parent.clientHeight - r.y - 16,
      });
      return next.w === r.w && next.h === r.h ? r : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

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
        setRect(resizeRect({ base: d.base, dx, dy, dir: d.dir }));
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

  const start = (m, dir = 'se') => (e) => {
    e.preventDefault();
    e.stopPropagation();
    drag.current = { sx: e.clientX, sy: e.clientY, base: { ...rect }, dir };
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
    <section className={cls.join(' ')} style={style} ref={rootRef}>
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
      {/*
        八条边都能拖。原来只有右下角一个把手，想把卡片加宽就得先摸到那个角 ——
        卡片比画布宽的时候，那个角还得先把滚动条拖过去才够得着。
      */}
      {!collapsed && !maxed
        ? RESIZE_DIRS.map((d) => (
            <div
              key={d}
              className={`window__edge window__edge--${d}`}
              data-window-resize={d}
              title="拖动缩放"
              style={{ cursor: RESIZE_CURSOR[d] }}
              onPointerDown={start('resize', d)}
            />
          ))
        : null}
    </section>
  );
}
