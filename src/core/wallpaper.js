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

/* ---------------- 壁纸定位（自由拖动） ----------------
 *
 * 原来是五个关键字（居中/顶/底/左/右），问题在于**中间的任意位置选不了** ——
 * 一张竖构图的人物图，想把脸放在偏上三分之一处，五个关键字一个都对不上。
 * 改成 `x / y` 两个百分比（跟 CSS `background-position` 同义）之后，
 * 界面那边就是一个能拖的预览框，想放哪儿放哪儿。
 *
 * 老存档里存的是关键字，所以要能升上来：见 `positionToPercent`。
 */

/** 旧关键字 → 百分比；认不出来按居中。给老 state.json 升级用 */
export function positionToPercent(pos) {
  const map = {
    center: [50, 50],
    top: [50, 0],
    bottom: [50, 100],
    left: [0, 50],
    right: [100, 50],
  };
  return map[String(pos ?? '').trim().toLowerCase()] ?? [50, 50];
}

/**
 * 夹到 0~100。
 *
 * ⚠️ `null` / `''` 一律当「没设」而不是「0」：`Number(null) === 0`，
 * 照直写会把「没设」理解成「靠左」，而靠左是个**有意义的位置**——
 * 于是这种错永远看不出来（画面只是偏了一点），只是「明明没动过，位置却不在中间」。
 */
export function clampPercent(v) {
  if (v === null || v === undefined || v === '') return 50;
  const n = Number(v);
  if (!Number.isFinite(n)) return 50;
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

/**
 * 从一份壁纸配置里取出**实际会用**的 x / y。
 *
 * 规则只有一条：有 x/y 就用 x/y，没有才把老关键字升上来。
 * 抽成函数是因为有三个地方要问同一件事 —— 写 CSS 变量、画设置里的预览框、
 * 单测。各抄一遍的话，改了这条规则必然有一处忘改，而忘了的那处不报错，
 * 只是表现成「预览框里的构图和真正铺上去的不一样」。
 *
 * @param {{x?:number, y?:number, position?:string}} wp
 * @returns {{x:number, y:number}}
 */
export function resolvePosition(wp = {}) {
  const hasXY = wp.x != null || wp.y != null;
  const fromKeyword = positionToPercent(wp.position);
  return {
    x: clampPercent(hasXY ? wp.x ?? 50 : fromKeyword[0]),
    y: clampPercent(hasXY ? wp.y ?? 50 : fromKeyword[1]),
  };
}

/**
 * `cover` 之后「图片比框大出来的那一块」有多大。
 *
 * 拖动要把**像素**位移换算成**百分比**，分母就是这个溢出量而不是框的边长：
 * `background-position: X%` 里的 X 指的是「在溢出的那一块里的位置」——
 * 图正好铺满那一维时（溢出 0）X 怎么变都看不出来，所以取 1 避免除零。
 */
export function coverOverflow({ imgW, imgH, boxW, boxH }) {
  const iw = Number(imgW) || 0;
  const ih = Number(imgH) || 0;
  const bw = Math.max(1, Number(boxW) || 1);
  const bh = Math.max(1, Number(boxH) || 1);
  if (iw <= 0 || ih <= 0) {
    // 不知道原图尺寸（老存档里没存）时退化成「按框的边长算」，拖起来会偏快，但不会失控
    return { x: bw, y: bh, known: false };
  }
  const scale = Math.max(bw / iw, bh / ih);
  return { x: Math.max(1, iw * scale - bw), y: Math.max(1, ih * scale - bh), known: true };
}

/**
 * 拖了多少像素 → 新的 X / Y。
 *
 * ⚠️ 方向是**反的**：把图往右拖，是想看它更靠左的部分，所以 X 要变小 ——
 * 这是拖图片这种交互的常识（跟拖地图一样），写成正的会觉得「拖反了」。
 */
export function dragToPercent({ x, y, dx, dy, overflowX, overflowY }) {
  const ox = Math.max(1, Number(overflowX) || 1);
  const oy = Math.max(1, Number(overflowY) || 1);
  return {
    x: clampPercent(Number(x || 0) - (Number(dx || 0) / ox) * 100),
    y: clampPercent(Number(y || 0) - (Number(dy || 0) / oy) * 100),
  };
}

/** 方向键微调：一次 2% */
export const POSITION_STEP = 2;

/** 把一张图的 X/Y 说成人话，给预览框下面那行字用 */
export function describePosition(x, y) {
  const px = clampPercent(x);
  const py = clampPercent(y);
  const h = px < 34 ? '偏左' : px > 66 ? '偏右' : '水平居中';
  const v = py < 34 ? '偏上' : py > 66 ? '偏下' : '垂直居中';
  return `${h} · ${v}`;
}
