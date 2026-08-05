'use strict';

/**
 * 生成应用与托盘图标（纯 Node，零依赖）。
 *
 * 画法：4 倍超采样 + 预乘 alpha 下采样，小尺寸下边缘才不糊。
 * 图案是主题色渐变圆角方块 + 一弯月牙 —— 夜里等更新的那点意思。
 *
 * 用法：node scripts/make-icons.cjs
 */

const fs = require('node:fs');
const path = require('node:path');
const { encodePng, hex, lerp, clamp01, sdRoundRect, downsample } = require('./lib/png.cjs');

const COLOR_TOP = hex('#8b7cf6');    // 与默认主题的主强调色一致
const COLOR_BOTTOM = hex('#56d4c4'); // 副强调色

const SS = 4;

function renderIcon(size, { radiusRatio = 0.235, insetRatio = 0.055 } = {}) {
  const N = size * SS;
  const acc = new Float64Array(N * N * 4);

  const inset = N * insetRatio;
  const cx = N / 2;
  const cy = N / 2;
  const hw = N / 2 - inset;
  const hh = N / 2 - inset;
  const r = N * radiusRatio;

  // 月牙 = 大白圆挖掉一个偏移的小圆
  const moonR = N * 0.245;
  const cutR = N * 0.215;
  const cutX = cx + N * 0.1;
  const cutY = cy - N * 0.045;

  for (let y = 0; y < N; y += 1) {
    for (let x = 0; x < N; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;

      const aBase = clamp01(0.5 - sdRoundRect(px, py, cx, cy, hw, hh, r));
      if (aBase <= 0) continue;

      const t = clamp01((py - inset) / (N - inset * 2));
      const col = [
        lerp(COLOR_TOP[0], COLOR_BOTTOM[0], t),
        lerp(COLOR_TOP[1], COLOR_BOTTOM[1], t),
        lerp(COLOR_TOP[2], COLOR_BOTTOM[2], t),
      ];

      const inMoon = Math.hypot(px - cx, py - cy) <= moonR;
      const inCut = Math.hypot(px - cutX, py - cutY) <= cutR;
      const m = inMoon && !inCut ? 0.96 : 0;

      const idx = (y * N + x) * 4;
      acc[idx] += lerp(col[0], 255, m) * aBase;
      acc[idx + 1] += lerp(col[1], 255, m) * aBase;
      acc[idx + 2] += lerp(col[2], 255, m) * aBase;
      acc[idx + 3] += aBase;
    }
  }

  return encodePng(size, size, downsample(acc, size, SS));
}

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'build', 'icons');

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const targets = [
    ['icon.png', 256, {}],
    ['icon-128.png', 128, {}],
    ['icon-64.png', 64, {}],
    ['tray.png', 32, { radiusRatio: 0.26, insetRatio: 0.04 }],
    ['tray-16.png', 16, { radiusRatio: 0.28, insetRatio: 0.02 }],
  ];
  const rows = [];
  for (const [name, size, opts] of targets) {
    const png = renderIcon(size, opts);
    fs.writeFileSync(path.join(OUT, name), png);
    rows.push(`${name}  ${size}x${size}  ${png.length} B`);
  }

  // 同时给渲染层一份 favicon，省得浏览器标签页上是个空白图标
  const publicDir = path.join(ROOT, 'public');
  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(path.join(publicDir, 'icon.png'), renderIcon(64, {}));

  console.log('图标已生成 →', path.relative(ROOT, OUT));
  console.log(rows.join('\n'));
}

main();
