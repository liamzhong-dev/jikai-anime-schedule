'use strict';

/**
 * 把一套 PNG 打成 Windows 用的 `.ico`。纯 Node，零依赖。
 *
 * 为什么能这么简单：Vista 之后的 Windows 允许 `.ico` 里**直接塞 PNG**，
 * 不用老老实实写 BMP + 掩码位图。而本机装不了 sharp / canvas（没有 MSVC），
 * 想「先合成一张多尺寸大图再编码」那条路根本走不通 —— 幸好规范留了这个口子。
 *
 * 为什么必须凑齐 6 个尺寸：只带一张 256 的话，Windows 在小尺寸场景
 * （任务栏 16、开始菜单 32、资源管理器 48）自己缩 —— 缩出来的月牙是糊的。
 * 每个尺寸一张自己渲染的图，才都是清楚的。
 *
 * 用法：node scripts/make-ico.cjs
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ICONS = path.join(ROOT, 'build', 'icons');
const OUT = path.join(ICONS, 'icon.ico');

/** 顺序不重要，但习惯从小到大放；Windows 自己会挑合适的 */
const SIZES = [16, 32, 48, 64, 128, 256];

/** 读一张 PNG 并确认尺寸真的是我们要的那个 —— 认错了会得到一张花掉的图标 */
function readPng(size) {
  // 256 那张叫 icon.png（历史命名，渲染层的 favicon 和通知图标都在用它）
  const names = size === 256 ? ['icon.png', 'icon-256.png'] : [`icon-${size}.png`];
  const file = names.map((n) => path.join(ICONS, n)).find((p) => fs.existsSync(p));
  if (!file) return null;
  const buf = fs.readFileSync(file);
  const sig = buf.subarray(0, 8).toString('hex');
  if (sig !== '89504e470d0a1a0a') return null;
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (w !== size || h !== size) return null;
  return buf;
}

function build() {
  const entries = [];
  for (const size of SIZES) {
    const png = readPng(size);
    if (!png) {
      console.error(`✗ 缺 build/icons/icon-${size}.png（或者尺寸不对）—— 先跑 npm run assets`);
      process.exit(1);
    }
    entries.push({ size, png });
  }

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = 图标
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  // 数据紧跟在目录表之后
  let offset = header.length + dir.length;

  entries.forEach((e, i) => {
    const at = i * 16;
    // 256 要写 0 —— 这个字段只有一个字节，256 装不下就是这个约定
    dir[at] = e.size >= 256 ? 0 : e.size;
    dir[at + 1] = e.size >= 256 ? 0 : e.size;
    dir[at + 2] = 0; // 调色板颜色数：真彩图写 0
    dir[at + 3] = 0; // reserved
    dir.writeUInt16LE(1, at + 4); // 颜色平面
    dir.writeUInt16LE(32, at + 6); // 位深
    dir.writeUInt32LE(e.png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += e.png.length;
  });

  const ico = Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
  fs.writeFileSync(OUT, ico);
  return { bytes: ico.length, count: entries.length, sizes: entries.map((e) => e.size) };
}

const r = build();
console.log(`icon.ico 已生成 → ${path.relative(ROOT, OUT).replace(/\\/g, '/')}`);
console.log(`  ${r.count} 个尺寸（${r.sizes.join(' / ')}）· ${(r.bytes / 1024).toFixed(1)} KB`);
