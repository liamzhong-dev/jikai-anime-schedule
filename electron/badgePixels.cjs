'use strict';

/**
 * 托盘角标的像素合成 —— 纯函数，不碰 Electron，所以能直接进单测。
 *
 * 为什么自己画而不是用 nativeImage / canvas：
 *   本机没有 MSVC，装不了 canvas 和 sharp；而 `nativeImage.toBitmap()` 出来的
 *   buffer 通道顺序是平台相关的（Windows 上 BGRA），画个红角标换个系统就变蓝。
 *   底图像素由 make-icons.cjs 落成 CJS 模块（顺序我们自己定：RGBA），
 *   这里在上面改像素，再自己编码回 PNG —— 全程字节顺序可控。
 *
 * 尺寸按 32×32 画：托盘在普通 DPI 下按 16 显示、高 DPI 下按 32。
 * 画 32 再让系统缩，比直接画 16 清楚。
 */

const { WIDTH, HEIGHT, rgba } = require('./tray-base.cjs');

/** 徽章底色：与界面上的「危险/逾期」同一个红 */
const BADGE_BG = [229, 72, 77];
const BADGE_FG = [255, 255, 255];

/** 5×7 点阵。1 是落笔 */
const GLYPHS = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
};

/**
 * 角标上要写的字。
 *
 * `0` 和「不是数」都返回 null —— **没有更新就不画角标**，
 * 一个空红点比没有更烦人：它会让人以为「有东西要我看」。
 * 超过 99 显示 99：32px 上放不下三位，写「99+」更是糊成一团。
 *
 * @returns {string|null}
 */
function badgeText(count) {
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return null;
  const v = Math.floor(n);
  if (v <= 0) return null;
  return String(Math.min(v, 99));
}

/** 圆角矩形内部判定：四角各留 r×r 的四分之一圆 */
function inRoundRect(x, y, rx, ry, rw, rh, r) {
  if (x < rx || y < ry || x >= rx + rw || y >= ry + rh) return false;
  const cxL = rx + r;
  const cxR = rx + rw - 1 - r;
  const cyT = ry + r;
  const cyB = ry + rh - 1 - r;
  if (x < cxL && y < cyT) return Math.hypot(cxL - x, cyT - y) <= r;
  if (x > cxR && y < cyT) return Math.hypot(x - cxR, cyT - y) <= r;
  if (x < cxL && y > cyB) return Math.hypot(cxL - x, y - cyB) <= r;
  if (x > cxR && y > cyB) return Math.hypot(x - cxR, y - cyB) <= r;
  return true;
}

/**
 * 合成一张带角标的托盘图（原始 RGBA 像素）。
 *
 * @param {number} count 今天的更新部数；<=0 表示不画角标
 * @returns {{width:number, height:number, pixels:Uint8ClampedArray, badge:Rect|null}}
 *   `badge` 是角标占的矩形，给测试断言用（不然测试得自己猜画在哪）
 */
function badgePixels(count) {
  const pixels = rgba();
  const text = badgeText(count);
  if (!text) return { width: WIDTH, height: HEIGHT, pixels, badge: null };

  const glyphW = 5;
  const glyphH = 7;
  const gap = 1;
  /*
   * 留边至少 2px：**没有留边的角标等于「一排白字」**。
   * 第一版给红底加了一圈 1px 白描边，看着更精致 —— 结果 32px 的图上
   * 描边 + 白字把红底吃到只剩两道细线，整体变成白底红字，谁是底谁是字都反了。
   * 小尺寸下的优先级是「一眼能认出这是个角标」，不是精致。
   */
  const padX = 3;
  const padY = 2;

  const textW = text.length * glyphW + (text.length - 1) * gap;
  const w = textW + padX * 2;
  const h = glyphH + padY * 2;

  // 右上角，离边 1px —— 贴边 0 的话高 DPI 下会被窗口裁掉一点
  const x0 = WIDTH - w - 1;
  const y0 = 1;

  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) {
      if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) continue;
      if (!inRoundRect(x, y, x0, y0, w, h, 3)) continue;
      const i = (y * WIDTH + x) * 4;
      pixels[i] = BADGE_BG[0];
      pixels[i + 1] = BADGE_BG[1];
      pixels[i + 2] = BADGE_BG[2];
      pixels[i + 3] = 255;
    }
  }

  // 数字：白字压在红底上
  const sx = x0 + padX;
  const sy = y0 + padY;
  for (let g = 0; g < text.length; g += 1) {
    const rows = GLYPHS[text[g]];
    if (!rows) continue;
    const ox = sx + g * (glyphW + gap);
    for (let r = 0; r < rows.length; r += 1) {
      for (let c = 0; c < rows[r].length; c += 1) {
        if (rows[r][c] !== '1') continue;
        const px = ox + c;
        const py = sy + r;
        if (px < 0 || py < 0 || px >= WIDTH || py >= HEIGHT) continue;
        const i = (py * WIDTH + px) * 4;
        pixels[i] = BADGE_FG[0];
        pixels[i + 1] = BADGE_FG[1];
        pixels[i + 2] = BADGE_FG[2];
        pixels[i + 3] = 255;
      }
    }
  }

  return { width: WIDTH, height: HEIGHT, pixels, badge: { x: x0, y: y0, w, h } };
}

module.exports = { badgePixels, badgeText, BADGE_BG, BADGE_FG, WIDTH, HEIGHT };
