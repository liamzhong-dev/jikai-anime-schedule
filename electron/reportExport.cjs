/**
 * 季度报告长图的导出通道（PDF / PNG）。
 *
 * 为什么绕一圈在**隐藏窗口**里重新渲染，而不是直接在应用窗口上截：
 *
 * 1. **应用窗口里有壳**。侧栏、工具栏、窗口卡片、选中态的把手都会一起进产物。
 *    与其写一堆 print 媒体查询去藏它们，不如只把画布那份 DOM 拿出来单独渲染 ——
 *    「要藏的东西」变成空集，就没有藏漏的可能。
 * 2. **页面尺寸要严格等于内容尺寸**。长图是「一张很长的图」，
 *    用 A4 之类固定页面切成一页页就完全是另一个东西了。
 *    实测（2026-09-26）：`@page { size: 1220px 9000px }` 能出单页 914.88×6750pt 的 PDF；
 *    但**内容高度必须严格小于页高** —— 9000 装进 9000 里会多出一页空白，装 8900 就只有一页。
 * 3. **PNG 更要绕**：普通窗口的 `capturePage()` 只能拿到视口那一段，
 *    而窗口高度被系统钳在屏幕工作区（本机实测：请求 1220×9000，拿到 1221×1019）。
 *    离屏渲染**同样被钳**（试过了），所以长图 PNG 只能「滚动 → 逐片拍 → 在窗口里拼」。
 *    好在离屏窗口有个额外好处：截图里没有滚动条，宽度正好是 1220。
 *
 * ⚠️ `printToPDF` 的 `pageSize` 对象**单位不是微米**（实测按微米传 32 万，
 * 它当成 32 万英寸算，MediaBox 直接爆掉）。要么走 `preferCSSPageSize` + `@page`，
 * 要么按英寸传。这里统一用前者。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BrowserWindow } = require('electron');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Chromium canvas 的单边硬上限（和渲染层 `tierlist.CANVAS_LIMITS` 是同一个数） */
const MAX_SIDE = 16384;

function writeTempHtml(html, tag) {
  // 报告里的图全是 dataURL，所以这个文件是自包含的，不用担心相对路径
  const file = path.join(os.tmpdir(), `jikai-report-${tag}-${process.pid}-${Date.now()}.html`);
  fs.writeFileSync(file, String(html ?? ''), 'utf8');
  return file;
}

/**
 * 等图真的解码完。
 *
 * `did-finish-load` 只保证 DOM 到位，`<img>` 里的 dataURL 是异步解码的 ——
 * 不等的话会导出一片空框，而且**偶发**：图小的时候看不出来，图大了必现。
 */
async function waitForImages(win) {
  await win.webContents
    .executeJavaScript(
      `Promise.all([...document.images].map((i) => (i.decode ? i.decode().catch(() => {}) : null)))
         .then(() => document.images.length)`,
    )
    .catch(() => 0);
  // 字体和布局落定
  await win.webContents.executeJavaScript('document.fonts ? document.fonts.ready.then(() => true) : true').catch(() => false);
  await wait(220);
}

/** 内容高度：画布自己的高度，不是 document 的（body 可能有额外外边距） */
async function canvasHeight(win) {
  const h = await win.webContents
    .executeJavaScript(
      `(() => { const el = document.querySelector('.report__canvas');
         return el ? Math.ceil(el.getBoundingClientRect().height) : 0; })()`,
    )
    .catch(() => 0);
  return Number(h) || 0;
}

async function openHidden({ html, width, height, offscreen, tag }) {
  const file = writeTempHtml(html, tag);
  const win = new BrowserWindow({
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
    show: false,
    paintWhenInitiallyHidden: true,
    webPreferences: { offscreen: Boolean(offscreen), backgroundThrottling: false },
  });
  if (offscreen) win.webContents.setFrameRate?.(30);
  await win.loadFile(file);
  await waitForImages(win);
  return { win, file };
}

function cleanup(win, file) {
  try { win?.destroy(); } catch { /* 已经没了 */ }
  try { fs.rmSync(file, { force: true }); } catch { /* 删不掉就算了，是临时目录 */ }
}

/**
 * 出一份 PDF。
 *
 * @returns {Promise<{buffer:Buffer, width:number, height:number, contentHeight:number}>}
 */
async function renderPdf({ html, width }) {
  const { win, file } = await openHidden({ html, width, height: 1000, offscreen: false, tag: 'pdf' });
  try {
    const contentH = await canvasHeight(win);
    if (!contentH) throw new Error('打印窗口里没找到画布（.report__canvas）');

    // +2px：见文件头第 2 条。多出来的那 2px 落在 body 背景上，和画布底部同色，看不见
    const pageH = contentH + 2;
    await win.webContents.executeJavaScript(
      `(() => { const s = document.createElement('style');
         s.textContent = '@page { size: ${Math.round(width)}px ${pageH}px; margin: 0; }';
         document.head.appendChild(s); return true; })()`,
    );

    const buffer = await win.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      margins: { marginType: 'none' },
    });
    return { buffer, width: Math.round(width), height: pageH, contentHeight: contentH };
  } finally {
    cleanup(win, file);
  }
}

/**
 * 出一张 PNG。
 *
 * 窗口高度被钳在屏幕工作区，所以只能滚动分片。拼图**在隐藏窗口的渲染进程里做**：
 * 主进程没有图像合成能力（`nativeImage` 只能裁剪、不能叠），
 * 而跨进程来回传几十兆 base64 既慢又容易被参数长度卡住。
 */
async function renderPng({ html, width }) {
  // 离屏窗口：截图里没有滚动条，宽度正好是 1220（阶段 0 实测）。
  const { win, file } = await openHidden({ html, width, height: 1000, offscreen: true, tag: 'png' });
  try {
    const wc = win.webContents;
    // 兜底的去滚动条：离屏本来就没有滚动条，这行是**为了万一**退化成普通窗口时
    // 不带一条灰边进来（普通窗口里滚动条会占 14px，画布就从 1220 变 1206）。
    // 必须在量高度之前注入：可用宽度一变，换行和总高度都跟着变。
    await wc.executeJavaScript(
      `(() => { const s = document.createElement('style');
         s.textContent = '::-webkit-scrollbar { width: 0 !important; height: 0 !important; }';
         document.head.appendChild(s); return true; })()`,
    ).catch(() => false);

    const contentH = await canvasHeight(win);
    if (!contentH) throw new Error('离屏窗口里没找到画布（.report__canvas）');

    const dpr = Number(await wc.executeJavaScript('window.devicePixelRatio')) || 1;
    const viewH = Number(await wc.executeJavaScript('window.innerHeight')) || 1000;

    // 超长时把输出比例降下来，并如实带回去 —— 直接撞上限的话
    // `toDataURL()` **不抛错、只给一张空图**，那才是最难查的
    const scale = Math.min(dpr, MAX_SIDE / contentH);
    const degraded = scale < dpr - 1e-6;

    await wc.executeJavaScript(
      `(() => { const c = document.createElement('canvas');
         c.width = Math.round(${Math.round(width)} * ${scale});
         c.height = Math.round(${contentH} * ${scale});
         globalThis.__jikaiShot = { c, ctx: c.getContext('2d'), scale: ${scale}, dpr: ${dpr} };
         return true; })()`,
    );

    const slices = Math.max(1, Math.ceil(contentH / viewH));
    let drawn = 0;
    for (let k = 0; k < slices; k += 1) {
      // 滚到整数位置：dpr 是 1.5 的时候，小数偏移会让每片交界处糊一条半像素缝
      await wc.executeJavaScript(`(window.scrollTo(0, ${Math.round(k * viewH)}), window.scrollY)`);
      await wait(150);
      // 用**真实**的 scrollY 当落点：最后一片会被浏览器钳住，按请求值画就会双重曝光
      const y = Number(await wc.executeJavaScript('Math.round(window.scrollY)')) || 0;
      const dataUrl = await wc.capturePage().then((img) => img.toDataURL());
      const ok = await wc
        .executeJavaScript(
          `(async () => { const g = globalThis.__jikaiShot;
             const img = new Image(); img.src = ${JSON.stringify(dataUrl)};
             await img.decode();
             const r = g.scale / g.dpr;
             g.ctx.drawImage(img, 0, Math.round(${y} * g.scale), Math.round(img.width * r), Math.round(img.height * r));
             return true; })()`,
        )
        .catch(() => false);
      if (ok) drawn += 1;
      if (drawn > slices + 2) break; // 守卫，别因为某个平台的怪脾气死循环
    }

    const dataUrl = await wc.executeJavaScript(`globalThis.__jikaiShot.c.toDataURL('image/png')`);
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png')) {
      throw new Error('拼出来的不是 PNG（多半是画布超了上限）');
    }
    const m = /^data:image\/png;base64,(.*)$/s.exec(dataUrl);
    return {
      buffer: Buffer.from(m[1], 'base64'),
      width: Math.round(width),
      height: contentH,
      scale,
      degraded,
      slices: drawn,
    };
  } finally {
    cleanup(win, file);
  }
}

module.exports = { renderPdf, renderPng, MAX_SIDE };
