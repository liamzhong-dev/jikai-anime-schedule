/**
 * 真实 canvas 上的导出验证（给 scripts/tier-export-check.mjs 用）。
 *
 * 为什么非要起一个浏览器跑一遍：Node 里没有 canvas，
 * 而「导出」这个功能最典型的失败方式恰恰是 **点了有反应、其实没写文件** ——
 * canvas 超限时 `toDataURL()` 不抛错，只给你一张空图；
 * 图是远端地址时还会直接抛 SecurityError。
 * 这两种用假 canvas 都测不出来，只有真浏览器 + 真像素能兜住。
 *
 * 图不用联网：这里自己画几张**比例不一的假封面**（714×1000、1079×1680 等，
 * 就是实测里那几种真实尺寸）当输入，顺便把 tileCrop 一起验了。
 */

import { exportTierlistPng } from '../../src/core/tierExport.js';
import { DEFAULT_ROWS, makeDefaultTierlist } from '../../src/core/tierlist.js';

/** 画一张指定尺寸的假封面，返回 dataURL（同源，不会 taint canvas） */
function fakeCover(w, h, seed) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = `hsl(${(seed * 47) % 360} 60% 45%)`;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 ${Math.round(h * 0.12)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`#${seed}`, w / 2, h / 2);
  return c.toDataURL('image/jpeg', 0.7);
}

function out(text) {
  const el = document.createElement('pre');
  el.id = 'result';
  el.textContent = text;
  document.body.appendChild(el);
}

/**
 * 把导出结果再画回 canvas，数一数到底有多少像素不是背景色。
 * 「文件存在」不等于「图不是空白」 —— 这一步才是真正的验收。
 */
async function inspect(dataUrl) {
  const img = new Image();
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = rej;
    img.src = dataUrl;
  });
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, c.width, c.height);

  const colors = new Set();
  let nonBg = 0;
  // 背景是 #14181f
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (Math.abs(r - 0x14) > 6 || Math.abs(g - 0x18) > 6 || Math.abs(b - 0x1f) > 6) nonBg += 1;
    if (colors.size < 5000) colors.add((r << 16) | (g << 8) | b);
  }
  return { w: img.width, h: img.height, nonBg, total: c.width * c.height, colors: colors.size };
}

async function main() {
  const sizes = [[714, 1000], [1079, 1680], [2907, 4096], [1000, 1000]];
  const list = makeDefaultTierlist('2026q3');
  const items = [];
  const images = new Map();

  // 七档各放几个，凑 12 个图块
  for (let i = 0; i < 12; i += 1) {
    const row = DEFAULT_ROWS[i % DEFAULT_ROWS.length];
    items.push({ key: `s${i}`, rowId: row.id });
    const [w, h] = sizes[i % sizes.length];
    images.set(`s${i}`, fakeCover(w, h, i));
  }

  const res = await exportTierlistPng({
    rows: list.rows,
    items,
    images,
    title: '2026年7月新番 Tier List',
    subtitle: '共 12 部',
    metaOf: (key) => ({ name: `示例番剧 ${key}`, seed: `示例番剧 ${key}` }),
  });

  if (!res.ok) {
    out(`EXPORT_FAIL ${res.error}`);
    return;
  }

  // 真的落一次盘：走 blob → 下载在浏览器里做不到静默，这里退一步，
  // 把 dataURL 还原成字节后报出大小，脚本侧再写成文件。
  const base64 = res.dataUrl.slice('data:image/png;base64,'.length);
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);

  // 真的把字节送出去落盘 —— 「文件存在」和「图不是空白」是两件事，
  // 脚本侧还会按 PNG 头解析宽高来核对，光看 dataUrl 长度不算数。
  const sent = await fetch('/save.png', { method: 'POST', body: bytes })
    .then((r) => r.text())
    .catch((e) => `POST 失败：${e?.message ?? e}`);
  if (sent !== 'ok') {
    out(`EXPORT_FAIL ${sent}`);
    return;
  }

  const px = await inspect(res.dataUrl);
  const ratio = px.nonBg / px.total;
  out(JSON.stringify({
    status: 'EXPORT_OK',
    scale: res.scale,
    width: res.width,
    height: res.height,
    degraded: res.degraded,
    reason: res.reason ?? null,
    missing: res.missing?.length ?? 0,
    bytes: bytes.length,
    pixels: px,
    nonBgRatio: Math.round(ratio * 1000) / 1000,
  }));
  out(`PNG_B64_LEN ${base64.length}`);
  if (bytes.length > 0) out(`PNG_MAGIC ${bytes[0]} ${bytes[1]} ${bytes[2]} ${bytes[3]}`);
}

main().catch((err) => out(`EXPORT_FAIL ${err?.message ?? String(err)}`));
