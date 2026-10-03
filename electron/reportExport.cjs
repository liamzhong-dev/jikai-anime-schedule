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

/**
 * 强制走分片、跳过「一次成图」。
 *
 * 某些机器上离屏窗口一改尺寸就崩（是崩溃不是异常，catch 不住），
 * 留个开关让人能自己绕开，而不是只能等我们发新版。
 */
const NO_SINGLE = Boolean(process.env.JIKAI_PNG_NOSINGLE);

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

async function openHidden({ html, width, height, offscreen, tag, largerThanScreen = false }) {
  const file = writeTempHtml(html, tag);
  const win = new BrowserWindow({
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
    show: false,
    paintWhenInitiallyHidden: true,
    /**
     * 允许窗口比屏幕还高。
     *
     * 默认窗口高度被系统钳在工作区（本机 1019），所以长图只能「滚动 → 逐片拍 → 拼」。
     * 开了这个开关就能把窗口直接拉到内容高度，一张 capturePage 拿全 ——
     * 分片循环里每一片都要把一个几 MB 的 dataURL 当 JS 参数送进渲染进程，
     * 那才是导出卡上几十秒的真正原因。
     */
    enableLargerThanScreen: Boolean(largerThanScreen),
    webPreferences: {
      offscreen: Boolean(offscreen),
      backgroundThrottling: false,
      /**
       * ⚠️ **必须关掉渲染进程沙盒**，跟主窗口保持一致。
       *
       * 沙盒化的渲染进程在本机（以及任何带 AppContainer 式限制的环境）里
       * 加载 `file://` 会被直接拦掉，报的是
       *   ERR_FAILED (-2) loading 'file:///C:\...\jikai-report-pdf-*.html'
       * —— 看上去像「临时文件没写成功 / 路径不对」，跟真正的原因（沙盒拦了协议）
       * 毫无关系。实测（2026-09-26）：同一份内容、同一个 `loadFile`，
       * 项目内路径和临时目录路径**都**失败，而主窗口（`sandbox: false`）加载
       * `dist/index.html` 一切正常 —— 差别只在这个开关上。
       * 症状是「导出功能整个不能用」，所以别把它当成环境噪音放过。
       *
       * 关掉是安全的：这个窗口只加载我们自己拼的自包含 HTML（图全是 dataURL），
       * 不碰任何外部内容，也没有 preload / nodeIntegration。
       */
      sandbox: false,
    },
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
 * 两条路，先快后稳：
 *
 * ① **一次成图**：靠 `enableLargerThanScreen` 把窗口拉到内容高度，
 *    一张 `capturePage()` 拿全。原来卡几十秒的根源不是截图本身，
 *    而是分片循环里每一片都要把一个几 MB 的 dataURL 当 JS 参数送进渲染进程 ——
 *    40 片就是来回搬几十兆字符串。
 *
 * ② **退回分片**：某些环境（没有可用 GPU、或者窗口还是被钳住）下一次拍不全，
 *    这时才走「滚动 → 逐片拍 → 在渲染进程里拼」。拼图放在渲染进程里是因为
 *    主进程没有图像合成能力（`nativeImage` 只能裁剪、不能叠）。
 *
 * 判定 ① 成不成立的依据是**截出来的高度**，不是「有没有报错」：
 * 被钳住时它不抛异常，只是悄悄给你一张 1019 高的半张图。
 *
 * @param {{html:string, width:number, onProgress?:Function}} opts
 */
async function renderPng({ html, width, onProgress }) {
  const report = (pct, label) => {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress({ pct, label });
    } catch {
      /* 界面已经关了就算了，不能让进度回调把导出打断 */
    }
  };
  report(0.06, '准备导出页面');

  // 量出来的这几个要带出 try 块（一次成图没成时分片还要用）
  let contentH = 0;
  let dpr = 1;
  let scale = 1;
  let degraded = false;

  // 离屏窗口：截图里没有滚动条，宽度正好是 1220（阶段 0 实测）。
  const { win, file } = await openHidden({
    html,
    width,
    height: 1000,
    offscreen: true,
    tag: 'png',
    largerThanScreen: true,
  });
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

    report(0.18, '渲染导出页面');
    contentH = await canvasHeight(win);
    if (!contentH) throw new Error('离屏窗口里没找到画布（.report__canvas）');

    dpr = Number(await wc.executeJavaScript('window.devicePixelRatio')) || 1;

    // 超长时把输出比例降下来，并如实带回去 —— 直接撞上限的话
    // `toDataURL()` **不抛错、只给一张空图**，那才是最难查的
    scale = Math.min(dpr, MAX_SIDE / contentH);
    degraded = scale < dpr - 1e-6;
    const wantW = Math.round(width * scale);
    const wantH = Math.round(contentH * scale);

    /*
     * ① 一次成图：把这个窗口拉到内容高度，一张 capturePage 拿全。
     *
     * 创建时传的高度会被工作区钳住，**只有 setSize 才真的能超出屏幕** ——
     * 实测创建 1220×6000 拿到的仍是 1019 高。
     *
     * ⚠️ 判据是**截出来的高度**，不是「有没有抛错」：窗口被钳住时它不报错，
     * 只是悄悄给你一张屏幕那么高的半张图，而那张图照样能通过后面的检查。
     *
     * ⚠️ `JIKAI_PNG_NOSINGLE=1` 可以强制跳过这条路：某些机器上离屏窗口
     * 一改尺寸就崩（是崩溃不是异常，catch 不住），留个开关好让人自己绕开。
     */
    if (wantH <= MAX_SIDE && !NO_SINGLE) {
      try {
        win.setSize(Math.round(width), Math.round(contentH));
        await wait(400);
        const innerH = Number(await wc.executeJavaScript('window.innerHeight')) || 0;
        const img = await wc.capturePage();
        const size = img.getSize(); // JPEG 出来也是同样的像素尺寸，判据不变
        if (innerH >= contentH - 2 && size.height >= Math.round(contentH * dpr) - 4) {
          report(0.9, '整张截图完成');
          const out = size.width === wantW && size.height === wantH
            ? img
            : img.resize({ width: wantW, height: wantH });
          return {
            buffer: out.toPNG(),
            width: Math.round(width),
            height: contentH,
            scale,
            degraded,
            slices: 1,
            mode: 'single',
          };
        }
      } catch {
        /* 一次成图这条路走不通，落到下面的分片 */
      }
      /*
       * ⚠️ 走到这里说明这个窗口已经被改高了。**别 setSize 缩回去** ——
       * 缩小那一次在本机（无可用 GPU）会把渲染进程整个带崩，而且那是崩溃不是异常，
       * catch 不住，连分片的退路都一起没了。直接扔掉这个窗口，下面重开一个干净的。
       */
    }
  } finally {
    cleanup(win, file);
  }

  // ② 分片：另开一个干净的小窗口，滚动 → 逐片拍 → 在渲染进程里拼
  return sliceShot({ html, width, contentH, dpr, scale, degraded, report });
}

/**
 * 分片截图：一次成图走不通时的退路。
 *
 * ⚠️ **必须用自己的新窗口**：一次成图那个窗口已经被拉到内容高度了，
 * 拿它滚动分片的话窗口本来就装得下全部内容，滚动根本不动，会拼出一堆重影。
 *
 * 拼图放在渲染进程里做是因为主进程没有图像合成能力（`nativeImage` 只能裁剪、不能叠）。
 */
async function sliceShot({ html, width, contentH, dpr, scale, degraded, report }) {
  /*
   * ⚠️ 分片这条路**不用离屏窗口**：实测离屏窗口滚动后不会重绘，
   * `capturePage()` 拿到的是一张空图 —— 空图的 data URL 是合法的，
   * 于是 `img.decode()` 不报错、只是永远等不到，表现出来就是导出卡死。
   * 普通隐藏窗口（show:false + paintWhenInitiallyHidden）滚动后能正常出帧。
   */
  const { win, file } = await openHidden({ html, width, height: 1000, offscreen: false, tag: 'png-slice' });
  try {
    const wc = win.webContents;
    await wc
      .executeJavaScript(
        `(() => { const s = document.createElement('style');
           s.textContent = '::-webkit-scrollbar { width: 0 !important; height: 0 !important; }';
           document.head.appendChild(s); return true; })()`,
      )
      .catch(() => false);

    const viewH = Number(await wc.executeJavaScript('window.innerHeight')) || 1000;
    const slices = Math.max(1, Math.ceil(contentH / viewH));
    report(0.35, `分 ${slices} 片截图`);
    await wc.executeJavaScript(
      `(() => { const c = document.createElement('canvas');
         c.width = Math.round(${Math.round(width)} * ${scale});
         c.height = Math.round(${contentH} * ${scale});
         globalThis.__jikaiShot = { c, ctx: c.getContext('2d'), scale: ${scale}, dpr: ${dpr} };
         return true; })()`,
    );

    let drawn = 0;
    for (let k = 0; k < slices; k += 1) {
      // 滚到整数位置：dpr 是 1.5 的时候，小数偏移会让每片交界处糊一条半像素缝
      await wc.executeJavaScript(`(window.scrollTo(0, ${Math.round(k * viewH)}), window.scrollY)`);
      await wait(150);
      // 用**真实**的 scrollY 当落点：最后一片会被浏览器钳住，按请求值画就会双重曝光
      const y = Number(await wc.executeJavaScript('Math.round(window.scrollY)')) || 0;
      /*
       * ⚠️ 中转用 JPEG，不用 PNG。
       *
       * 这一片要当**字符串**塞进 `executeJavaScript` 的参数里送进渲染进程，
       * 而 1830×1529 的 PNG base64 有好几 MB —— 光是解析这个字面量就要几十秒一片，
       * 这正是「导出卡住不动」的真正来源（实测 3 片 90 秒还没走完）。
       * JPEG 92 只有它的十分之一，拼完再统一出 PNG。
       *
       * 代价是最终那张图带一层 JPEG 压缩痕迹；但这条路本来就是「一次成图走不通」
       * 时的退路，能出图比出一张无损但永远出不来更重要。
       */
      const shot = await wc.capturePage();
      // ⚠️ `toJPEG()` 给的是 Buffer 不是 data URL，少拼前缀的话 img.src 就是一串无效字符
      const dataUrl = `data:image/jpeg;base64,${shot.toJPEG(92).toString('base64')}`;
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
      // 分片是慢路，把进度摆出来 —— 一动不动几十秒和「卡死了」在界面上没区别
      report(0.35 + 0.5 * ((k + 1) / slices), `已拼 ${drawn}/${slices} 片`);
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
      mode: 'sliced',
    };
  } finally {
    cleanup(win, file);
  }
}

module.exports = { renderPdf, renderPng, MAX_SIDE };
