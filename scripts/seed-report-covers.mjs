'use strict';
/**
 * 给「报告导出」那条自检准备一批**封面原图**（l 档）。
 *
 * 为什么非要有它：
 *
 * ① 导出按钮在封面没缓存时是**灰的**（界面有意拦着，怕导出一半图还没到）。
 *    而 `check:desktop` 每轮跑之前会把整个自检档案目录删掉重建 —— 封面缓存跟着没了，
 *    于是「导出」那一条用例根本按不下去，报的还是「按钮是灰的」这种看着像功能坏了的话。
 * ② 「导出出来的图里封面一张不少」这条断言，**在没有图的时候 `missing` 永远是 0**
 *    —— 一条空转的断言比没有更坏：它绿着，看上去像验过了。
 *
 * 所以每次跑导出自检之前要先补图。两条来源，能真就真：
 *
 *   - 本机真实缓存（`$APPDATA/jikai/covers/<season>`）里有就**直接搬**，
 *     图是真的封面原图，连「清晰度」那条数字也能一并验到；
 *   - 没有就**合成**一批够大的 PNG（600×900），宽度足以让 `naturalWidth >= 300`
 *     那档判据成立。这时验的是「图有没有进导出」，不是画质 —— 会明说是合成的。
 *
 * 只往自检档案里写（`test/.tmp/...`），不碰用户档案。
 *
 * ⚠️ 做成「导出函数 + CLI 包装」而不是子进程脚本：`check-desktop` 是**同进程调用**
 * 它的。早先走 spawn 那版在 `check:all` 里失败过一次，而且 stdout / stderr **双双为空** ——
 * 子进程起没起来、为什么退出都不知道，只剩一句「补封面失败」。
 *
 * 用法：
 *   node scripts/seed-report-covers.mjs --season=2026q3 --profile=test/.tmp/profile-report
 *   import { seedReportCovers } from './seed-report-covers.mjs'
 */
import { existsSync, mkdirSync, copyFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { coverEntries, EXPORT_VARIANT } from '../src/core/covers.js';

/** 缓存文件名就是 URL 的 sha1 前 20 位，扩展名按 KNOWN_EXTS 逐个试（见 electron/covers.cjs） */
const hashUrl = (url) => createHash('sha1').update(String(url)).digest('hex').slice(0, 20);

// ---- 合成图用的最小 PNG 编码器（本机装不了 sharp/canvas，只能自己来）----

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * 一张够大的纯色 PNG。
 *
 * ⚠️ 宽不能太小：到时候报告里铺 300px，小于它的会留下明显的插值痕迹，
 * 人一眼就知道是假图 —— 那这条自检的「清晰度」数字就没人信了。
 */
function syntheticPng(w, h, seed) {
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  const base = [(seed * 47) % 200 + 40, (seed * 91) % 200 + 40, (seed * 157) % 200 + 40];
  for (let y = 0; y < h; y += 1) {
    const off = y * stride;
    for (let x = 0; x < w; x += 1) {
      raw[off + 1 + x * 3] = (base[0] + ((y / 30) | 0)) % 256;
      raw[off + 2 + x * 3] = (base[1] + ((x / 40) | 0)) % 256;
      raw[off + 3 + x * 3] = base[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 从磁盘上读一张图的真实宽度（PNG/JPEG 都认），用来报「这批图多大」 */
function readWidth(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return buf.readUInt32BE(16);
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return buf.readUInt16BE(i + 7);
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return 0;
}

/**
 * @param {{season:string, profile:string, quiet?:boolean}} opts
 * @returns {Promise<{dir:string, copied:number, made:number, skipped:number,
 *   widths:{min:number, mid:number, max:number}, lines:string[]}>}
 *   `lines` 是要摆到自检输出里的几句话（**合成图那句一定在里面**，不能悄悄略过）。
 */
export async function seedReportCovers({ season, profile, quiet = false } = {}) {
  if (!profile) throw new Error('缺 profile（自检档案目录）');
  if (!season) throw new Error('缺 season（季度键）');

  const dstDir = path.join(profile, 'covers', season);
  mkdirSync(dstDir, { recursive: true });

  const builtin = path.resolve('src', 'data', 'builtin', `${season}.js`);
  if (!existsSync(builtin)) throw new Error(`没有这一季的内置数据：${builtin}`);
  const mod = await import(pathToFileURL(builtin).href);
  const items = (mod.default ?? []).filter((a) => a && a.cover);

  // 真实缓存：electron 的 userData 在 Windows 上是 %APPDATA%/jikai
  const realDir = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'jikai', 'covers', season);
  const realByName = new Map();
  if (existsSync(realDir)) {
    for (const f of readdirSync(realDir)) realByName.set(path.basename(f, path.extname(f)), f);
  }

  let copied = 0;
  let made = 0;
  let skipped = 0;

  // 只补 l 档（报告用那一档）。界面上那些缩略图另有自己的池子，
  // 种子报告这点内容用不到，补了也只是白白多搬一倍数据。
  for (const e of coverEntries(items, EXPORT_VARIANT)) {
    const name = hashUrl(e.url);
    const target = path.join(dstDir, name);
    if (existsSync(`${target}.jpg`) || existsSync(`${target}.png`) || existsSync(`${target}.webp`)) {
      skipped += 1;
      continue;
    }
    const from = realByName.get(name);
    if (from) {
      const ext = path.extname(from) || '.jpg';
      copyFileSync(path.join(realDir, from), `${target}${ext}`);
      copied += 1;
      continue;
    }
    writeFileSync(`${target}.png`, syntheticPng(600, 900, (Number(e.id) || copied + made) % 997));
    made += 1;
  }

  // 报一下这批图到底多大 —— 「图糊不糊」全看这个数字
  const widths = [];
  for (const f of readdirSync(dstDir)) {
    const w = readWidth(readFileSync(path.join(dstDir, f)));
    if (w > 0) widths.push(w);
  }
  widths.sort((a, b) => a - b);
  const summary = {
    min: widths[0] ?? 0,
    mid: widths.length ? widths[Math.floor(widths.length / 2)] : 0,
    max: widths.at(-1) ?? 0,
  };

  const lines = [];
  if (made > 0) {
    lines.push(`有 ${made} 张是**合成**的假图（本机真实缓存里没有对应原图）—— 画质相关数字只作参考`);
  }
  if (!quiet) {
    lines.push(
      `封面就位：${dstDir} · 共 ${widths.length} 张（真实原图 ${copied} · 合成 ${made} · 本来就有 ${skipped}）`
        + ` · 宽度：最小 ${summary.min} · 中位 ${summary.mid} · 最大 ${summary.max}`,
    );
  }
  return { dir: dstDir, copied, made, skipped, widths: summary, lines: lines.reverse() };
}

// ---- CLI ----
const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  const arg = (key, dflt) => {
    const hit = process.argv.slice(2).find((s) => s.startsWith(`--${key}=`));
    return hit ? hit.slice(key.length + 3) : dflt;
  };
  const r = await seedReportCovers({ season: arg('season', '2026q3'), profile: arg('profile', '') });
  for (const line of r.lines) console.log(line);
}
