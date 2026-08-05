'use strict';

/**
 * 生成一张演示壁纸（纯 Node，零依赖）。
 *
 * 为什么要有这个东西：壁纸功能如果只靠用户自己找图，那在无头环境里就
 * 永远验证不到「不透明度 / 模糊 / 缩放 / 压暗」这几个参数到底有没有生效。
 * 所以自己画一张放进 build/demo/，截图脚本拿它当输入，整条链路才算跑通。
 *
 * 画的是抽象夜海：竖直渐变 + 几团柔光 + 一层确定性星点（同一个种子每次一样）。
 *
 * 用法：node scripts/make-wallpaper.cjs
 */

const fs = require('node:fs');
const path = require('node:path');
const { encodePng, hex, mix, lerp, clamp01 } = require('./lib/png.cjs');

const W = 1600;
const H = 900;

const TOP = hex('#141a33');
const MID = hex('#241a3f');
const BOTTOM = hex('#0b1020');

/** 几团柔光的中心与颜色 */
const GLOWS = [
  { x: 0.18, y: 0.72, r: 0.46, color: hex('#8b7cf6'), power: 0.55 },
  { x: 0.78, y: 0.3, r: 0.4, color: hex('#56d4c4'), power: 0.4 },
  { x: 0.54, y: 0.92, r: 0.52, color: hex('#3b2a6b'), power: 0.5 },
  { x: 0.04, y: 0.12, r: 0.3, color: hex('#ff7ab8'), power: 0.16 },
];

/** 确定性伪随机：保证每次生成的星点位置一致，截图可复现 */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function renderWallpaper(width, height) {
  const out = new Uint8Array(width * height * 4);
  const rand = rng(20260922);

  // 星点：按面积给数量，偏上密下疏
  const stars = [];
  const count = Math.round((width * height) / 5200);
  for (let i = 0; i < count; i += 1) {
    const x = rand();
    const y = Math.pow(rand(), 1.7) * 0.78;
    stars.push({ x, y, r: 0.5 + rand() * 1.6, a: 0.15 + rand() * 0.6 });
  }

  const glowPre = GLOWS.map((g) => ({ ...g, cx: g.x * width, cy: g.y * height, rr: g.r * Math.max(width, height) }));

  for (let y = 0; y < height; y += 1) {
    const ty = y / height;
    // 上 → 中 → 下 三段渐变
    const base = ty < 0.55 ? mix(TOP, MID, ty / 0.55) : mix(MID, BOTTOM, (ty - 0.55) / 0.45);

    for (let x = 0; x < width; x += 1) {
      let r = base[0];
      let g = base[1];
      let b = base[2];

      for (const gl of glowPre) {
        const d = Math.hypot(x - gl.cx, (y - gl.cy) * 1.25) / gl.rr;
        if (d >= 1) continue;
        const falloff = Math.pow(1 - d, 2.2) * gl.power;
        r = lerp(r, gl.color[0], falloff);
        g = lerp(g, gl.color[1], falloff);
        b = lerp(b, gl.color[2], falloff);
      }

      const o = (y * width + x) * 4;
      out[o] = clamp01(r / 255) * 255;
      out[o + 1] = clamp01(g / 255) * 255;
      out[o + 2] = clamp01(b / 255) * 255;
      out[o + 3] = 255;
    }
  }

  // 星点后画，省得被渐变覆盖
  for (const s of stars) {
    const cx = s.x * width;
    const cy = s.y * height;
    const R = Math.ceil(s.r) + 1;
    for (let dy = -R; dy <= R; dy += 1) {
      for (let dx = -R; dx <= R; dx += 1) {
        const px = Math.round(cx + dx);
        const py = Math.round(cy + dy);
        if (px < 0 || py < 0 || px >= width || py >= height) continue;
        const d = Math.hypot(cx - px, cy - py);
        if (d > s.r) continue;
        const a = s.a * (1 - d / (s.r + 0.6));
        const o = (py * width + px) * 4;
        out[o] = lerp(out[o], 255, a);
        out[o + 1] = lerp(out[o + 1], 255, a);
        out[o + 2] = lerp(out[o + 2], 255, a);
      }
    }
  }

  return out;
}

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'build', 'demo');

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const px = renderWallpaper(W, H);
  const png = encodePng(W, H, px);
  const file = path.join(OUT, 'wallpaper-night.png');
  fs.writeFileSync(file, png);
  console.log(`演示壁纸已生成 → ${path.relative(ROOT, file)}  ${W}x${H}  ${png.length} B`);
}

main();
