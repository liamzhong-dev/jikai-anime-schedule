/**
 * 把画布那份 DOM 拼成一张自包含的 HTML，交给主进程在隐藏窗口里出 PDF / PNG。
 *
 * ## 为什么必须自包含
 *
 * 主进程是把这份 HTML 写成临时文件、再用 `loadFile` 打开的。那个文档和 app
 * **不同源**，相对路径的 `<link rel="stylesheet">` 一个都取不到 —— 所以
 * **样式必须内联成文本**，封面必须已经是 dataURL（走本地缓存那条路拿到的就是）。
 * 漏掉任何一样，产出的都是一张「有字没样式」或者「有色块没图」的长图，
 * 而窗口里预览看起来完全正常。
 *
 * ## 为什么外层还要包一层 `.report`
 *
 * 画布上的配色变量（`--rp-*`）定义在 `.report` 上。只拿 `.report__canvas` 的话
 * 变量没地方继承，整张图会掉回默认色 —— 而 `getComputedStyle` 在**父文档**里
 * 一切正常（父文档里有 `.report`），不看产物根本发现不了。
 *
 * 拼装是纯函数、是故意的：这层逻辑能被离线断言（`test/report-html.test.mjs`），
 * 只有「取 DOM」「取样式」那两步需要真浏览器。
 */

// 宽度的唯一来源还是 `report.js`：这里再写一份常量，迟早出现
// 「界面按 1220 排版、导出按别的宽度渲染」这种只有产物才看得出的分叉。
import { REPORT_WIDTH, WIDTH_MAX as REPORT_WIDTH_MAX, WIDTH_MIN as REPORT_WIDTH_MIN } from './report.js';

export const REPORT_HTML_TITLE = '次回 · 季度报告';

/** 标题是用户能改的，直接塞进 <title> 会把结构撑坏 */
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {{canvasHtml?:string, css?:string, width?:number, title?:string}} opts
 * @returns {string} 完整 HTML 文档
 */
/**
 * 宽度归一化。
 *
 * 注意「负数、0、NaN 一律退回默认值」，而不是夹到下限 —— 夹的话
 * 传错一个变量（比如把高度传进来、或者某处少了个乘 1000）会静默变成一张
 * 200px 宽的长图，看着「有产出」，实际完全不能用。宁可明显退回默认宽度。
 */
function normWidth(width, fallback = REPORT_WIDTH) {
  const n = Math.round(Number(width));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(REPORT_WIDTH_MAX, Math.max(REPORT_WIDTH_MIN, n));
}

export function buildReportHtml({ canvasHtml = '', css = '', width = REPORT_WIDTH, title = REPORT_HTML_TITLE } = {}) {
  const w = normWidth(width);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
${String(css ?? '')}
/* ---- 导出页自己的三条规矩（放在后面，覆盖 app 的样式） ----
   ① 画布本来是三栏网格里的一栏，这里只有它一个 child，
      留在 grid 里会被塞进第一栏（208px），整张长图全会挤窄；
   ② 页面四周不能有任何留白 —— 留白会算进 @page 的尺寸里，多出一条边；
   ③ 宽度以 renderer 报上来的为准，不用画布上的 inline style 赌。 */
html, body { margin: 0; padding: 0; background: transparent; }
body.print .report { display: block; gap: 0; padding: 0; margin: 0; width: ${w}px; }
body.print .report__canvas { width: ${w}px !important; margin: 0 !important; box-shadow: none !important; }
</style>
</head>
<body class="print">
<div class="report">${String(canvasHtml ?? '')}</div>
</body>
</html>`;
}

/**
 * 取画布那份 DOM。
 *
 * 用 `outerHTML` 而不是 `innerHTML`：画布自己的 padding、宽度、类名都在外层元素上，
 * 只带 children 出去等于把版面参数丢掉一半。
 */
export function canvasHtmlOf(root) {
  const el = root?.querySelector?.('.report__canvas');
  return el ? el.outerHTML : '';
}

/**
 * 收集当前文档里的样式文本。
 *
 * ① `<style>` 直接读 —— 开发模式下 vite 就是这么注入的；
 * ② `<link rel="stylesheet">` 走 `cssRules` —— 打包后是这一条。
 *
 * 读不到的把 href 记进 `unread` 交回去：界面要能看见「样式没带全」，
 * 而不是拿到一张没样式的长图才发现。**不要**在这里抛错 ——
 * 少一份样式也该能导出（顶多难看），总比整个按钮点了没反应强。
 */
export function collectStyles(doc = globalThis.document) {
  const parts = [];
  const unread = [];
  for (const el of doc?.querySelectorAll?.('style') ?? []) {
    const t = el.textContent ?? '';
    if (t.trim()) parts.push(t);
  }
  for (const link of doc?.querySelectorAll?.('link[rel="stylesheet"]') ?? []) {
    try {
      const rules = link.sheet?.cssRules;
      if (!rules) {
        unread.push(link.getAttribute?.('href') ?? '');
        continue;
      }
      const text = Array.from(rules).map((r) => r.cssText).join('\n');
      if (text.trim()) parts.push(text);
      else unread.push(link.getAttribute?.('href') ?? '');
    } catch {
      unread.push(link.getAttribute?.('href') ?? '');
    }
  }
  return { css: parts.join('\n'), unread: unread.filter(Boolean) };
}
