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

  // 返回像素而不是 PNG：托盘角标要在这上面继续画东西（见下面的 tray-base.cjs）
  return downsample(acc, size, SS);
}

function renderIconPng(size, opts) {
  return encodePng(size, size, renderIcon(size, opts));
}

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'build', 'icons');

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  /*
   * 应用的图标尺寸要凑够一套：打包成 .exe 用的 .ico 里每个尺寸都得有 ——
   * 只放一张 256 的话，Windows 在小尺寸（任务栏、开始菜单）上自己缩，
   * 缩出来的月牙会糊成一团。托盘那两个是另一套画法，不参与 .ico。
   */
  const targets = [
    ['icon.png', 256, {}],
    ['icon-128.png', 128, {}],
    ['icon-64.png', 64, {}],
    ['icon-48.png', 48, {}],
    ['icon-32.png', 32, {}],
    ['icon-16.png', 16, {}],
    ['tray.png', 32, { radiusRatio: 0.26, insetRatio: 0.04 }],
    ['tray-16.png', 16, { radiusRatio: 0.28, insetRatio: 0.02 }],
  ];
  const rows = [];
  let trayPixels = null;
  for (const [name, size, opts] of targets) {
    const pixels = renderIcon(size, opts);
    const png = encodePng(size, size, pixels);
    fs.writeFileSync(path.join(OUT, name), png);
    rows.push(`${name}  ${size}x${size}  ${png.length} B`);
    if (name === 'tray.png') trayPixels = { size, pixels };
  }

  /*
   * 托盘角标要在这张底图上画数字，而主进程里没有 canvas：
   * 装不了 sharp / canvas（本机没有 MSVC），自己缩图也不行。
   * 所以这里顺手把 32×32 托盘图的**原始 RGBA 像素**落成一份 CJS 模块 ——
   * 主进程 require 它就能直接改像素，再编码回 PNG。
   *
   * 为什么不走 nativeImage.toBitmap()：那个 buffer 的通道顺序是平台相关的
   * （Windows 上是 BGRA），画个红角标在别的平台上就会变成蓝的。
   * 自己存像素，顺序由自己定，不会有这种「换个系统颜色就反了」的毛病。
   */
  if (trayPixels) {
    const text = [
      "'use strict';",
      '',
      '/* 自动生成（node scripts/make-icons.cjs）—— 别手改。 */',
      '',
      `/** 托盘底图的原始像素：${trayPixels.size}×${trayPixels.size}，RGBA 顺序，每像素 4 字节。 */`,
      `const WIDTH = ${trayPixels.size};`,
      `const HEIGHT = ${trayPixels.size};`,
      `const BASE64 = '${Buffer.from(trayPixels.pixels).toString('base64')}';`,
      '',
      'module.exports = {',
      '  WIDTH,',
      '  HEIGHT,',
      '  rgba() {',
      '    return Uint8ClampedArray.from(Buffer.from(BASE64, \'base64\'));',
      '  },',
      '};',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(ROOT, 'electron', 'tray-base.cjs'), text);
    rows.push(`electron/tray-base.cjs  ${trayPixels.size * trayPixels.size * 4} B（角标底图）`);
  }

  // 同时给渲染层一份 favicon，省得浏览器标签页上是个空白图标
  const publicDir = path.join(ROOT, 'public');
  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(path.join(publicDir, 'icon.png'), renderIcon(64, {}));

  console.log('图标已生成 →', path.relative(ROOT, OUT));
  console.log(rows.join('\n'));
}

main();
