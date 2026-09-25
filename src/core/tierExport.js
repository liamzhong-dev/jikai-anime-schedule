/**
 * Tier List 导出：Canvas 2D 手绘。
 *
 * 为什么不用 html2canvas：
 *   1) 它对 CSS 的支持不全（渐变、object-fit、圆角裁剪都容易画歪）；
 *   2) **同样躲不开跨域** —— 页面上的 `<img>` 只要 src 是远端地址，
 *      画进 canvas 就会 taint，`toBlob()` / `toDataURL()` 直接抛 SecurityError。
 * 所以这里从一开始就不碰 DOM：图全部由调用方以 **dataUrl** 喂进来
 * （dataUrl 是同源的，不会 taint），版面坐标全部由 `measureLayout` 算好。
 *
 * 这一层分成两个可测与不可测的部分：
 *   - `collectImages` —— 纯编排，注入 `getImage` 就能测；
 *   - `draw*`         —— 必须有 canvas，测不了，所以尽量薄，只做「照着坐标画」。
 */

import { EXPORT_DEFAULTS, measureLayout, pickScale, tileCrop } from './tierlist.js';
import { fallbackPair, readableInk } from './palette.js';

/** 顶部标题区高度（1x 单位）。有标题的导出图才像一张能发出去的图 */
export const HEADER_H = 64;

/** 导出图里的兜底色（界面是深色主题，导出也用深色，白底会晃眼） */
const CANVAS_BG = '#14181f';
const CANVAS_INK = '#e9ebf1';
const CANVAS_INK_DIM = '#98a0b3';
const CANVAS_LINE = 'rgba(255,255,255,0.10)';

/**
 * 把需要的封面逐张取回来。
 *
 * 一张都不能静默跳过：少了图的位置会画成色块，用户看不出是「没取到」还是「本来就没封面」。
 * 所以返回 `missing`（取不到的条数），交给界面去说。
 *
 * @param {Array<{key:string,url:string|null}>} entries
 * @param {{group:string, getImage:Function, onProgress?:Function, concurrency?:number}} opts
 * @returns {Promise<{images:Map<string,string>, missing:string[]}>}
 */
export async function collectImages(entries, { group, getImage, onProgress, concurrency = 4 } = {}) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && e.key != null);
  const total = list.length;
  const images = new Map();
  const missing = [];
  let done = 0;
  let cursor = 0;

  const bump = () => {
    done += 1;
    onProgress?.({ done, total });
  };

  async function worker() {
    while (cursor < list.length) {
      const e = list[cursor];
      cursor += 1;
      const url = typeof e.url === 'string' ? e.url : '';
      if (!url || typeof getImage !== 'function') {
        missing.push(String(e.key));
        bump();
        continue;
      }
      try {
        const r = await getImage({ group, url });
        if (r?.dataUrl) images.set(String(e.key), r.dataUrl);
        else missing.push(String(e.key));
      } catch {
        missing.push(String(e.key));
      }
      bump();
    }
  }

  const n = Math.max(1, Math.min(Number(concurrency) || 1, list.length || 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return { images, missing };
}

/** 把 dataUrl 变成可画的 Image；失败返回 null（画的时候会退回色块） */
function loadImage(dataUrl) {
  return new Promise((resolve) => {
    if (!dataUrl || typeof Image === 'undefined') {
      resolve(null);
      return;
    }
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * 画一个图块。
 *
 * 原图比例不齐（§0.1b），所以一律走 `tileCrop` 居中裁切 ——
 * 直接 `drawImage(img, x, y, w, h)` 会把 1:1.56 的封面压扁。
 */
function drawTile(ctx, { x, y, w, h }, { img, seed, itemSize = 'poster' }) {
  ctx.save();
  roundRect(ctx, x, y, w, h, Math.round(w * 0.06));
  ctx.clip();

  if (img) {
    const crop = tileCrop(img.naturalWidth || img.width, img.naturalHeight || img.height, itemSize, 1);
    // tileCrop 算的是 1x 下的源矩形，而源图是原图 —— 只需要这个矩形的**比例**关系，
    // 所以直接把源矩形按原图坐标取出来画到目标矩形上。
    ctx.drawImage(img, crop.sx, crop.sy, crop.sw, crop.sh, x, y, w, h);
  } else {
    const [c1, c2] = fallbackPair(seed);
    const g = ctx.createLinearGradient(x, y, x + w, y + h);
    g.addColorStop(0, c1);
    g.addColorStop(1, c2);
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.86)';
    ctx.font = `600 ${Math.round(h * 0.34)}px system-ui, "Microsoft YaHei", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(seed ?? '?').slice(0, 1), x + w / 2, y + h / 2);
  }

  ctx.restore();
}

/**
 * 渲染整张图。
 *
 * @returns {Promise<{canvas, scale, width, height, degraded, reason, missing}>}
 */
export async function renderTierlist({
  rows,
  items,
  images = new Map(),
  title = '',
  subtitle = '',
  itemSize = 'poster',
  candidates = [2, 1],
  onCreateCanvas,
  metaOf,          // (key) => { name?, seed? } —— 图块下方要写的字，由调用方给
} = {}) {
  const chosen = pickScale(rows, items, {
    candidates,
    itemSize,
    header: title ? HEADER_H : 0,
  });

  const layout = measureLayout(rows, items, {
    scale: chosen.scale,
    itemSize,
    header: title ? HEADER_H : 0,
  });

  const make = typeof onCreateCanvas === 'function'
    ? onCreateCanvas
    : () => globalThis.document?.createElement?.('canvas');
  const canvas = make(layout.width, layout.height);
  if (!canvas || typeof canvas.getContext !== 'function') {
    return { canvas: null, scale: chosen.scale, ...chosen, missing: [], error: '当前环境没有 canvas' };
  }
  canvas.width = layout.width;
  canvas.height = layout.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { canvas: null, scale: chosen.scale, ...chosen, missing: [], error: '拿不到 2d 上下文' };

  // ---- 底 ----
  ctx.fillStyle = CANVAS_BG;
  ctx.fillRect(0, 0, layout.width, layout.height);

  // ---- 标题 ----
  if (title) {
    const pad = EXPORT_DEFAULTS.padding * chosen.scale;
    ctx.fillStyle = CANVAS_INK;
    ctx.font = `700 ${Math.round(28 * chosen.scale)}px system-ui, "Microsoft YaHei", sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(title, pad, pad + Math.round(26 * chosen.scale));
    if (subtitle) {
      ctx.fillStyle = CANVAS_INK_DIM;
      ctx.font = `400 ${Math.round(14 * chosen.scale)}px system-ui, "Microsoft YaHei", sans-serif`;
      ctx.fillText(subtitle, pad, pad + Math.round(48 * chosen.scale));
    }
  }

  // ---- 各档 ----
  const missing = [];
  for (const row of layout.rows) {
    // 标签
    const labelW = EXPORT_DEFAULTS.labelWidth * chosen.scale;
    ctx.fillStyle = row.color;
    roundRect(ctx, row.left, row.top, labelW, row.height, Math.round(8 * chosen.scale));
    ctx.fill();

    ctx.save();
    ctx.fillStyle = readableInk(row.color);
    ctx.font = `700 ${Math.round(20 * chosen.scale)}px system-ui, "Microsoft YaHei", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label = String(row.label ?? '');
    // 长标签缩字号，别顶出格子
    const maxW = labelW - 12 * chosen.scale;
    let size = Math.round(20 * chosen.scale);
    while (size > 10 && ctx.measureText(label).width > maxW) {
      size -= 1;
      ctx.font = `700 ${size}px system-ui, "Microsoft YaHei", sans-serif`;
    }
    ctx.fillText(label, row.left + labelW / 2, row.top + row.height / 2);
    ctx.restore();

    // 行底
    ctx.strokeStyle = CANVAS_LINE;
    ctx.lineWidth = Math.max(1, chosen.scale);
    ctx.strokeRect(row.left + 0.5, row.top + 0.5, row.width - 1, row.height - 1);

    // 图块
    for (const it of row.items) {
      const meta = metaOf?.(String(it.key)) ?? {};
      const seed = meta.seed ?? it.key;
      const dataUrl = images.get(String(it.key));
      const img = await loadImage(dataUrl);
      if (!img && dataUrl) missing.push(String(it.key));
      drawTile(ctx, { x: it.x, y: it.y, w: it.w, h: it.h }, { img, seed, itemSize });

      // 图块下方留一条名字，不然一排封面看不出谁是谁
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(it.x, it.y + it.h - Math.round(18 * chosen.scale), it.w, Math.round(18 * chosen.scale));
      ctx.fillStyle = '#ffffff';
      ctx.font = `500 ${Math.round(10.5 * chosen.scale)}px system-ui, "Microsoft YaHei", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const name = String(it.name ?? seed ?? '');
      ctx.fillText(
        name.length > 12 ? `${name.slice(0, 11)}…` : name,
        it.x + it.w / 2,
        it.y + it.h - Math.round(9 * chosen.scale),
      );
      ctx.restore();
    }
  }

  return {
    canvas,
    scale: chosen.scale,
    width: layout.width,
    height: layout.height,
    degraded: chosen.degraded,
    reason: chosen.reason,
    missing,
  };
}

/**
 * 一步导出：算版面 → 取图 → 画 → 出 dataUrl。
 *
 * @returns {Promise<{ok:boolean, dataUrl?:string, ...}>}
 */
export async function exportTierlistPng(opts = {}) {
  const res = await renderTierlist(opts);
  if (!res.canvas) return { ok: false, error: res.error ?? '渲染失败', scale: res.scale };
  let dataUrl = '';
  try {
    dataUrl = res.canvas.toDataURL('image/png');
  } catch (err) {
    // 走到这儿基本就是 taint 了：说明有图不是 dataUrl，而是远端地址混了进来
    return { ok: false, error: `导出失败（${err?.message ?? '未知原因'}）`, scale: res.scale };
  }
  const bytes = Math.round((dataUrl.length - 'data:image/png;base64,'.length) * 0.75);
  return { ok: true, dataUrl, bytes, ...res };
}
