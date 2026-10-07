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

/*
 * 逐步留痕：`JIKAI_EXPORT_TRACE=<文件>` 时把每一步的时间戳写进去。
 *
 * 为什么非要写到文件而不是打日志：导出是在**隐藏窗口**里跑的，界面上只有一个
 * 进度条，「卡住了」和「还在跑」在用户眼里长得一模一样 —— 而且它不报错，
 * 于是连「哪一步慢」都只能靠猜。留痕之后「卡在第几步」是一个能读出来的数字。
 */
const TRACE_FILE = process.env.JIKAI_EXPORT_TRACE || '';
const T0 = Date.now();
function mark(what) {
  if (!TRACE_FILE) return;
  try {
    fs.appendFileSync(TRACE_FILE, `${new Date().toISOString()} +${Date.now() - T0}ms ${what}\n`, 'utf8');
  } catch {
    /* 写不了就算了，不能让留痕本身把导出搞砸 */
  }
}

/** Chromium canvas 的单边硬上限（和渲染层 `tierlist.CANVAS_LIMITS` 是同一个数） */
const MAX_SIDE = 16384;

/**
 * 给滚动条留的余量。
 *
 * 滚动条会占掉 14px，而画布是**固定 1220px** 的 —— 窗口正好开 1220 的话，
 * 可用宽度只有 1206，画布右边那一条就被挤到视口外，截出来的图少一块
 * （实测截出 1809 而不是 1830）。试过 `::-webkit-scrollbar{display:none}`，
 * 没用：主滚动条不吃那套。
 *
 * 所以窗口开宽一点（让画布完整放下），截图之后再按画布宽度裁回来。
 */
const GUTTER = 24;

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
  /*
   * ⚠️ 下面每一步都套了超时 —— 这不是保险起见，是踩出来的：
   *
   * `img.decode()` 会**永远不 settle**（既不 resolve 也不 reject）。图没开始加载时
   * 它就一直挂着，而 `Promise.all` 于是永远 pending，`executeJavaScript` 也就
   * 永远不返回 —— 导出静静地卡在「准备导出页面」，界面上只有一个不动的进度条。
   * 自检里那份最小报告**一张图都没有**，所以这条路径从来没被走到过。
   *
   * 超时之后不视为失败：图没解码完最多是导出图里少几张封面，
   * 而卡住是「这个功能整个不能用」，两害相权很清楚。
   */
  const race = (p, ms, tag) => Promise.race([p, wait(ms).then(() => `timeout(${tag})`)]);
  const run = (js, ms, tag) =>
    race(win.webContents.executeJavaScript(js).catch((e) => `throw:${e?.message ?? e}`), ms, tag);

  /*
   * 封面在界面里是**懒加载**的（`Cover` 上写着 loading="lazy"）。
   * 界面上这是对的 —— 一屏之外的图没必要先下；但导出窗口里那一屏之外
   * 根本不存在「滚过去」这回事，于是它们永远停在 pending，
   * 导出图里对应位置就是一块空。所以先手动把它们全部叫起来。
   */
  const woken = await run(
    `(() => { let n = 0;
       for (const i of document.images) {
         if (i.loading === 'lazy') i.loading = 'eager';
         if (!i.complete && i.src) { const s = i.src; i.src = ''; i.src = s; n += 1; }
       }
       return n; })()`,
    6000,
    'wake',
  );
  mark(`叫起懒加载的图：${woken}`);

  /*
   * 等它们真的解码完：轮询「已经解码出来的张数」，不再增长就认为到位。
   *
   * 不用 `Promise.all(decode())` —— 它会**永远不 settle**（既不 resolve 也不 reject），
   * `executeJavaScript` 于是永远不返回，导出静静地停在「准备导出页面」，
   * 界面上只剩一个不动的进度条。而自检喂的那份最小报告一张图都没有，
   * 所以这条路径从来没被走到过。
   */
  let ready = -1;
  let stable = 0;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const n = await run(
      `[...document.images].filter((i) => i.complete && i.naturalWidth > 0).length`,
      5000,
      'poll',
    );
    if (typeof n === 'number') {
      if (n === ready) {
        stable += 1;
        // 连着两次一样就认为不会再多了；给两次是为了躲开「刚好这一拍没变化」
        if (stable >= 2) break;
      } else {
        stable = 0;
        ready = n;
      }
    }
    await wait(400);
  }
  mark(`等图：解码出 ${ready} 张`);

  // 字体和布局落定
  const fonts = await race(
    win.webContents.executeJavaScript('document.fonts ? document.fonts.ready.then(() => true) : true').catch(() => false),
    5000,
    'fonts',
  );
  mark(`等字体：${fonts}`);

  // 不管上面等没等到，都如实报一下每张图的状态 —— 「导出图里空了几块」靠这个定位
  const state = await race(
    win.webContents
      .executeJavaScript(
        `[...document.images].map((i) => (i.complete ? (i.naturalWidth > 0 ? 'ok' : 'empty') : 'pending')).join(',')`,
      )
      .catch(() => 'throw'),
    4000,
    'state',
  );
  mark(`图状态：${state}`);

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
  mark(`openHidden(${tag}) 建窗口 offscreen=${offscreen} larger=${largerThanScreen} ${width}x${height}`);
  await win.loadFile(file);
  mark(`openHidden(${tag}) loadFile 完成`);
  await waitForImages(win);
  mark(`openHidden(${tag}) 等图完成`);
  return { win, file };
}

function cleanup(win, file) {
  mark(`cleanup：销毁 ${win?.getSize?.() ? `${win.getSize()[0]}x${win.getSize()[1]}` : '?'} 窗口`);
  try { win?.destroy(); } catch { /* 已经没了 */ }
  mark('cleanup：窗口已销毁');
  try { fs.rmSync(file, { force: true }); } catch { /* 删不掉就算了，是临时目录 */ }
  mark('cleanup：临时文件已删');
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

  /*
   * ⚠️ 量出来的这几个**必须声明在 try 外面**。
   *
   * 下面 `sliceShot(...)` 那个调用在 try 块之外，它要用到 `wantW`。
   * 之前 `wantW` 是在 try 里 `const` 的，于是那行一执行就抛
   * `ReferenceError: wantW is not defined` —— 而它抛在「转分片」这句留痕之后、
   * `sliceShot` 第一句留痕之前，所以留痕上看着就像**导出凭空停住**，
   * 完全看不出是作用域的问题。分片那条退路于是从来没真正跑到过。
   */
  let contentH = 0;
  let dpr = 1;
  let scale = 1;
  let degraded = false;
  let wantW = 0;

  /*
   * ⚠️ 不用离屏窗口（offscreen）。
   *
   * 离屏窗口里 `<img>` **不会真的去解码**：`img.decode()` 永远不 settle，
   * `Promise.all` 于是永远挂着，`executeJavaScript` 也就永远不返回 ——
   * 导出静静地停在「准备导出页面」，界面上只剩一个不动的进度条。
   * 报告里嵌着几十张封面 dataURL，所以**只要报告有封面就必卡**；
   * 而自检喂的那份最小报告一张图都没有，这条路从来没被走到过。
   *
   * 用普通隐藏窗口（show:false + paintWhenInitiallyHidden），图片正常走加载流程。
   * 代价是可能带滚动条，下面注入的隐藏滚动条样式就是为这个准备的。
   */
  const { win, file } = await openHidden({
    html,
    width: width + GUTTER,
    height: 1000,
    offscreen: false,
    tag: 'png',
    largerThanScreen: true,
  });
  try {
    const wc = win.webContents;
    /*
     * 去滚动条。⚠️ 光写 width/height 为 0 不够 —— 实测仍然占 14px
     * （截出来是 1809 而不是 1830，导出图右侧多一条空白、内容还被压窄），
     * 得连 display 一起干掉。
     *
     * 必须在量高度之前注入：可用宽度一变，换行和总高度都跟着变。
     */
    await wc.executeJavaScript(
      `(() => { const s = document.createElement('style');
         s.textContent = '::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }'
           + ' html { scrollbar-width: none !important; }';
         document.head.appendChild(s); return true; })()`,
    ).catch(() => false);

    report(0.18, '渲染导出页面');
    contentH = await canvasHeight(win);
    if (!contentH) throw new Error('离屏窗口里没找到画布（.report__canvas）');
    mark(`内容高 ${contentH}px`);

    dpr = Number(await wc.executeJavaScript('window.devicePixelRatio')) || 1;

    // 超长时把输出比例降下来，并如实带回去 —— 直接撞上限的话
    // `toDataURL()` **不抛错、只给一张空图**，那才是最难查的
    scale = Math.min(dpr, MAX_SIDE / contentH);
    degraded = scale < dpr - 1e-6;
    wantW = Math.round(width * scale);
    const wantH = Math.round(contentH * scale);

    /*
     * ① 一次成图：把这个窗口拉到内容高度，一张 capturePage 拿全。
     *
     * 创建时传的高度会被工作区钳住，**只有建好之后再改尺寸才真的能超出屏幕** ——
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
        /*
         * ⚠️ **必须用 `setContentSize`，不能用 `setSize`**。
         *
         * `setSize` 设的是**外框**的尺寸。实测内容要 5049，`setSize(w, 5049)`
         * 之后 `window.innerHeight` 只有 5012 —— 窗框吃掉了 37px。
         * 于是下面那条高度判据永远差这一点点，本来能一次拍完的报告
         * 每次都静悄悄地掉到分片那条慢路上。它既不报错也不失败，
         * 看上去只是「导出莫名变慢」，没有半点线索指向这里。
         *
         * `setContentSize` 设的是**页面**的尺寸，正是我们要的那个数。
         */
        mark(`① 一次成图：setContentSize ${Math.round(width + GUTTER)}x${Math.round(contentH)}`);
        win.setContentSize(Math.round(width + GUTTER), Math.round(contentH));
        await wait(400);
        let innerH = Number(await wc.executeJavaScript('window.innerHeight')) || 0;
        // 万一某个平台的窗口比量出来的还要吃掉几个像素，按真实差值补一次再试。
        // 不这么做的话只会表现为「导出莫名变慢」，没有任何线索指向这里。
        if (innerH > 0 && innerH < contentH - 2) {
          const delta = Math.round(contentH - innerH);
          mark(`① 补 ${delta}px 窗框`);
          win.setContentSize(Math.round(width + GUTTER), Math.round(contentH + delta));
          await wait(400);
          innerH = Number(await wc.executeJavaScript('window.innerHeight')) || 0;
        }
        mark(`① innerHeight=${innerH}（要 ${contentH}）`);
        const img = await wc.capturePage();
        mark(`① capturePage 完成`);
        const size = img.getSize(); // JPEG 出来也是同样的像素尺寸，判据不变
        mark(`① 截出来 ${size.width}x${size.height}（要 ${wantW}x${wantH}）`);
        if (innerH >= contentH - 2 && size.height >= Math.round(contentH * dpr) - 4) {
          report(0.9, '整张截图完成');
          // 裁掉右边给滚动条留的那条，只留画布本身
          const out = size.width === wantW && size.height === wantH
            ? img
            : img.crop({ x: 0, y: 0, width: Math.min(wantW, size.width), height: Math.min(wantH, size.height) });
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
      } catch (e) {
        mark(`① 失败：${e?.message ?? String(e)}`);
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

  mark(`① 没成，转分片（contentH=${contentH} scale=${scale} dpr=${dpr}）`);
  // ② 分片：另开一个干净的小窗口，滚动 → 逐片拍 → 在渲染进程里拼
  return sliceShot({ html, width, contentH, dpr, scale, degraded, report, wantW });
}

/**
 * 分片截图：一次成图走不通时的退路。
 *
 * ⚠️ **必须用自己的新窗口**：一次成图那个窗口已经被拉到内容高度了，
 * 拿它滚动分片的话窗口本来就装得下全部内容，滚动根本不动，会拼出一堆重影。
 *
 * 拼图放在渲染进程里做是因为主进程没有图像合成能力（`nativeImage` 只能裁剪、不能叠）。
 */
async function sliceShot({ html, width, contentH, dpr, scale, degraded, report, wantW: wantWIn }) {
  /*
   * ⚠️ 分片这条路**不用离屏窗口**：实测离屏窗口滚动后不会重绘，
   * `capturePage()` 拿到的是一张空图 —— 空图的 data URL 是合法的，
   * 于是 `img.decode()` 不报错、只是永远等不到，表现出来就是导出卡死。
   * 普通隐藏窗口（show:false + paintWhenInitiallyHidden）滚动后能正常出帧。
   */
  mark(`② 分片：另开窗口 ${width + GUTTER}x1000`);
  const { win, file } = await openHidden({
    html,
    width: width + GUTTER,
    height: 1000,
    offscreen: false,
    tag: 'png-slice',
  });
  try {
    const wc = win.webContents;
    await wc
      .executeJavaScript(
        /*
         * 去滚动条。⚠️ 光写 width/height 为 0 **不够**（实测仍然占 14px：
         * 截出来是 1809 而不是 1830，导出图右侧多一条空白、内容还被压窄），
         * 得连 display 一起干掉。
         */
        `(() => { const s = document.createElement('style');
           s.textContent = '::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }'
             + ' html { scrollbar-width: none !important; }';
           document.head.appendChild(s); return true; })()`,
      )
      .catch(() => false);

    const viewH = Number(await wc.executeJavaScript('window.innerHeight')) || 1000;
    const wantW = Number(wantWIn) > 0 ? Math.round(wantWIn) : Math.round(width * scale);
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
      mark(`② 第 ${k + 1}/${slices} 片：scrollY=${y}`);
      const shot = await wc.capturePage();
      mark(`② 第 ${k + 1}/${slices} 片：拍完`);
      // ⚠️ `toJPEG()` 给的是 Buffer 不是 data URL，少拼前缀的话 img.src 就是一串无效字符
      const dataUrl = `data:image/jpeg;base64,${shot.toJPEG(92).toString('base64')}`;
      const ok = await wc
        .executeJavaScript(
          `(async () => { const g = globalThis.__jikaiShot;
             const img = new Image(); img.src = ${JSON.stringify(dataUrl)};
             await img.decode();
             const r = g.scale / g.dpr;
             // 源那边只取画布那么宽：右边多出的是给滚动条留的余量，不能画进来
             g.ctx.drawImage(img, 0, 0, Math.min(img.width, ${wantW}), img.height,
                             0, Math.round(${y} * g.scale), ${wantW}, Math.round(img.height * r));
             return true; })()`,
        )
        .catch(() => false);
      if (ok) drawn += 1;
      // 分片是慢路，把进度摆出来 —— 一动不动几十秒和「卡死了」在界面上没区别
      report(0.35 + 0.5 * ((k + 1) / slices), `已拼 ${drawn}/${slices} 片`);
      if (drawn > slices + 2) break; // 守卫，别因为某个平台的怪脾气死循环
    }

    mark('② 全部拼完，出 PNG');
    const dataUrl = await wc.executeJavaScript(`globalThis.__jikaiShot.c.toDataURL('image/png')`);
    mark(`② toDataURL 完成 ${typeof dataUrl === 'string' ? dataUrl.length : '非字符串'} 字符`);
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
