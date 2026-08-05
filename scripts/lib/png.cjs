'use strict';

/**
 * 极简 PNG 编码器（零依赖）。
 *
 * 为了一个 32×32 的图标去拉 sharp / canvas 这类带原生模块的依赖，
 * 在没网或者架构不匹配的机器上会直接装不上。PNG 的容器格式本身很简单
 * （IHDR + IDAT + IEND），zlib 又是 Node 内置的，于是干脆自己写。
 *
 * 配套的像素工具：圆角矩形距离场、超采样下采样、色值插值。
 */

const zlib = require('node:zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array|Buffer} rgba 长度 width*height*4
 */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  const src = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.length);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type: None
    src.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 画图小工具 ----------

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

const hex = (h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];

const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/** 圆角矩形的有符号距离场：负数在内部 */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/**
 * 预乘 alpha 的下采样：直接平均颜色会让边缘渗出不透明的黑边，
 * 所以先乘上 alpha 再平均，最后除回来。
 */
function downsample(acc, size, ss) {
  const out = new Uint8Array(size * size * 4);
  const block = ss * ss;
  const N = size * ss;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < ss; sy += 1) {
        for (let sx = 0; sx < ss; sx += 1) {
          const i = ((y * ss + sy) * N + (x * ss + sx)) * 4;
          r += acc[i]; g += acc[i + 1]; b += acc[i + 2]; a += acc[i + 3];
        }
      }
      const alpha = a / block;
      const o = (y * size + x) * 4;
      if (alpha > 0) {
        out[o] = Math.min(255, Math.round(r / block / alpha));
        out[o + 1] = Math.min(255, Math.round(g / block / alpha));
        out[o + 2] = Math.min(255, Math.round(b / block / alpha));
      }
      out[o + 3] = Math.min(255, Math.round(alpha * 255));
    }
  }
  return out;
}

module.exports = { encodePng, crc32, hex, mix, lerp, clamp01, sdRoundRect, downsample };
