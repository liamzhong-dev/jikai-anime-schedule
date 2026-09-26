import React, { useEffect, useRef, useState } from 'react';
import {
  POSITION_STEP,
  clampPercent,
  coverOverflow,
  describePosition,
  dragToPercent,
  resolvePosition,
} from '../core/wallpaper.js';

/** 拿不到窗口尺寸时用的比例（SSR、极端窄窗） */
const FALLBACK_ASPECT = 16 / 10;

/**
 * 预览框要和**真实窗口**同比例。
 *
 * 这不是审美问题：框和窗口比例不一样的话，「框里看着正好」的构图铺到窗口上
 * 就会偏 —— 而用户来这里就是为了把构图对准。SSR 没有 innerWidth，
 * 所以尺寸可从 props 灌进来；不灌就退到 16:10。
 */
function defaultAspect() {
  const w = Number(globalThis.innerWidth) || 0;
  const h = Number(globalThis.innerHeight) || 0;
  if (w > 4 && h > 4) return w / h;
  return FALLBACK_ASPECT;
}

/**
 * 壁纸取景框：一个和窗口同比例的缩略预览，拖里面的图就能改构图。
 *
 * 为什么要有它：原来是五个关键字（居中/顶/底/左/右），中间那一大片位置**选不了** ——
 * 竖构图的立绘想把脸放在偏上三分之一，五个关键字一个都够不着。
 * 现在存的是两个百分比（`background-position` 的语义），框里拖到哪儿就是哪儿。
 *
 * 拖动期间只动本地 state、松手才落盘：store 每次写入都会重渲染整棵树 + 400ms 后
 * 落一次盘，跟着 pointermove 走会发涩（这条在卡片窗口那边已经吃过一次）。
 */
export default function WallpaperFrame({
  dataUrl = null,
  imgW = null,
  imgH = null,
  x = null,
  y = null,
  position = 'center',
  disabled = false,
  aspect = null,
  onCommit,
}) {
  const boxRef = useRef(null);
  const drag = useRef(null);
  const [dragging, setDragging] = useState(false);
  // 拖动中的临时位置；null 表示「跟着 props 走」
  const [local, setLocal] = useState(null);
  // 「这张图在这个比例下已经铺满了」——拖了没反应最容易让人以为功能坏了，
  // 所以按下那一刻就说清楚
  const [noRoom, setNoRoom] = useState(false);

  const pos = local ?? resolvePosition({ x, y, position });
  const rawRatio = Number(aspect);
  const ratio = Number.isFinite(rawRatio) && rawRatio > 0 ? rawRatio : defaultAspect();

  // props 一改就把临时值清掉，重新跟着存档走。
  // 用函数式更新：值本来就没错时直接返回原值，React 会跳过这次重渲染。
  useEffect(() => {
    setLocal((cur) => (cur === null ? cur : null));
  }, [x, y]);

  useEffect(() => {
    if (!dragging) return undefined;

    const result = (e) => {
      const d = drag.current;
      if (!d) return null;
      const dx = Number.isFinite(e.clientX) ? e.clientX - d.sx : 0;
      const dy = Number.isFinite(e.clientY) ? e.clientY - d.sy : 0;
      return dragToPercent({ x: d.base.x, y: d.base.y, dx, dy, overflowX: d.ox, overflowY: d.oy });
    };

    const onMove = (e) => {
      const next = result(e);
      if (next) setLocal(next);
    };
    const onUp = (e) => {
      const next = result(e);
      drag.current = null;
      setDragging(false);
      if (next) {
        setLocal(next);
        onCommit?.(next);
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [dragging, onCommit]);

  const start = (e) => {
    if (disabled || !dataUrl) return;
    e.preventDefault();
    const box = boxRef.current?.getBoundingClientRect?.();
    const bw = Number(box?.width) || 0;
    const bh = Number(box?.height) || 0;
    /*
     * 框还没排完版（宽高为 0）时别开始拖：拿 0 去算溢出量会得到 1px 的分母，
     * 拖一下位置就直接飞到 0% 或 100% —— 看起来像「这个框坏了」，
     * 而真正的毛病只是「量尺寸的那一刻它还没上屏」。
     */
    if (bw < 4 || bh < 4) return;
    /*
     * `background-position` 的百分比说的是「在图片比框大出来的那一块里的位置」，
     * 所以换算位移的分母是**溢出量**而不是框的边长。预览框是缩小的，
     * 但溢出量同样按比例缩小 —— 两边都是像素、比值不变，所以算出来的百分比是对的。
     */
    const over = coverOverflow({ imgW, imgH, boxW: bw, boxH: bh });
    setNoRoom(over.known && over.x <= 1 && over.y <= 1);
    drag.current = { sx: e.clientX, sy: e.clientY, base: { ...pos }, ox: over.x, oy: over.y };
    setDragging(true);
    // 指针捕获让「拖出框外再松手」也算在这一次拖动里。合成事件（自检）没有真实
    // 指针，这里会抛，但不该因此把整次拖动弄坏 —— 包一层就好。
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      /* 没有真实指针可以捕获，忽略 */
    }
  };

  const onKeyDown = (e) => {
    if (disabled || !dataUrl) return;
    const d = {
      ArrowLeft: [-POSITION_STEP, 0],
      ArrowRight: [POSITION_STEP, 0],
      ArrowUp: [0, -POSITION_STEP],
      ArrowDown: [0, POSITION_STEP],
    }[e.key];
    if (!d) return;
    e.preventDefault();
    onCommit?.({ x: clampPercent(pos.x + d[0]), y: clampPercent(pos.y + d[1]) });
  };

  const cls = ['wpframe'];
  if (disabled || !dataUrl) cls.push('is-off');
  if (dragging) cls.push('is-dragging');

  return (
    <div className="wpframe-wrap">
      {/* data-wp-img 把原图尺寸也报出来：桌面端自检要照着它算「这个方向还有多少
          余量可挪」，才知道该往哪边拖、拖多远 —— 不然只能瞎拖，然后怪功能坏了 */}
      <div
        ref={boxRef}
        className={cls.join(' ')}
        data-wp-frame
        data-wp-x={pos.x}
        data-wp-y={pos.y}
        data-wp-aspect={Math.round(ratio * 10000) / 10000}
        data-wp-img={imgW && imgH ? `${imgW}x${imgH}` : ''}
        role="group"
        aria-label="壁纸取景框：拖里面的图换位置，也可以用方向键微调"
        tabIndex={disabled || !dataUrl ? -1 : 0}
        onPointerDown={start}
        onKeyDown={onKeyDown}
        style={{
          aspectRatio: String(Math.round(ratio * 10000) / 10000),
          backgroundImage: dataUrl ? `url("${dataUrl}")` : 'none',
          backgroundPosition: `${pos.x}% ${pos.y}%`,
        }}
      >
        <span className="wpframe__grid" aria-hidden="true" />
      </div>

      <div className="wpframe__row">
        <span className="wpframe__pos" data-wp-hint>
          {dataUrl ? describePosition(pos.x, pos.y) : '选一张图片之后就能拖'}
        </span>
        <button
          type="button"
          className="btn btn--mini"
          data-wp-reset
          disabled={disabled || !dataUrl}
          onClick={() => onCommit?.({ x: 50, y: 50 })}
        >
          回正
        </button>
      </div>

      {/* 模糊和缩放不画进框里：模糊不影响构图，缩放只挪个把像素，
          画上去反而让「框里」和「铺上去」看起来不是同一件事。 */}
      <em className="wpframe__note">
        {noRoom
          ? '这张图在这个比例下已经铺满了，上下左右都没有可挪的余量 —— 换一张比例差得多的图才动得了'
          : '框和窗口同比例 · 拖框里的图换位置，也可以用方向键微调'}
      </em>
    </div>
  );
}
