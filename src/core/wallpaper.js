/**
 * 壁纸：把用户选的一张图压成能塞进本地存储的 dataURL。
 *
 * 为什么要压：state 是要写进 state.json 的，原图动辄 5-10MB，
 * 每 400ms 一次的落盘会变成灾难。所以统一缩到长边 1920、JPEG，
 * 再兜一层体积上限，超了就降质量、降尺寸重来一次。
 */

export const MAX_WALLPAPER_BYTES = 3.2 * 1024 * 1024;
export const WALLPAPER_MAX_EDGE = 1920;

/** dataURL 的字节数（base64 去掉头部后按 3/4 还原） */
export function dataUrlBytes(dataUrl) {
  const s = String(dataUrl ?? '');
  const i = s.indexOf(',');
  if (i < 0) return 0;
  const body = s.slice(i + 1);
  const pad = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((body.length * 3) / 4) - pad);
}

export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(0)} KB`;
  return `${(v / 1024 / 1024).toFixed(2)} MB`;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('这张图读不出来，换一张试试'));
    img.src = src;
  });
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('读取文件失败'));
    fr.readAsDataURL(file);
  });
}

/** 按长边等比缩放，并算出画布尺寸 */
export function fitSize(width, height, maxEdge = WALLPAPER_MAX_EDGE) {
  const w = Math.max(1, Math.round(width || 1));
  const h = Math.max(1, Math.round(height || 1));
  const longest = Math.max(w, h);
  if (longest <= maxEdge) return { w, h, scaled: false };
  const ratio = maxEdge / longest;
  return { w: Math.max(1, Math.round(w * ratio)), h: Math.max(1, Math.round(h * ratio)), scaled: true };
}

/**
 * 读一张本地图片并压到可用尺寸。
 * @param {File|Blob} file
 * @returns {Promise<{dataUrl,width,height,bytes,name,quality}>}
 */
export async function readImageFile(file, { maxEdge = WALLPAPER_MAX_EDGE, maxBytes = MAX_WALLPAPER_BYTES } = {}) {
  if (!file) throw new Error('没有选择文件');
  if (!String(file.type ?? '').startsWith('image/')) throw new Error('这不是图片文件');

  const raw = await readAsDataUrl(file);
  const img = await loadImage(raw);
  const isPng = String(file.type).includes('png');

  let edge = maxEdge;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { w, h } = fitSize(img.naturalWidth || img.width, img.naturalHeight || img.height, edge);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);

    // PNG 想留住透明通道，其余一律 JPEG；体积压不住时强制转 JPEG
    const usePng = isPng && attempt === 0;
    const quality = attempt === 0 ? 0.85 : 0.75;
    const dataUrl = usePng ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', quality);
    const bytes = dataUrlBytes(dataUrl);

    if (bytes <= maxBytes) {
      return { dataUrl, width: w, height: h, bytes, name: String(file.name ?? '壁纸'), quality: usePng ? 'png' : quality };
    }
    edge = Math.round(edge * 0.72);
  }

  throw new Error('这张图太大了，压不到可用的体积，换一张小一点的');
}

/** 供 SSR / 单测用的轻量替身：不做解码，只记录来源 */
export function wallpaperMetaFrom(dataUrl, name) {
  return { dataUrl, name: name ?? '壁纸', bytes: dataUrlBytes(dataUrl) };
}
