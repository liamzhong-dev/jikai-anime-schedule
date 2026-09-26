import test from 'node:test';
import assert from 'node:assert/strict';

import { buildReportHtml, canvasHtmlOf, collectStyles } from '../src/core/reportHtml.js';

/**
 * 导出用的那份 HTML 的拼装。
 *
 * 为什么值得单独一层断言：这份字符串是**送进隐藏窗口的唯一输入**，
 * 拼错一个字（少个 class、宽度没跟上）的后果是「导出的长图不对」——
 * 而在窗口里预览永远正常，因为预览根本没经过这个函数。
 * 这类「产物错了、预览没问题」的 bug，只有靠数产物本身才抓得到。
 */

const MIN_HTML = '<div class="report__canvas" data-report-canvas="1">画布</div>';

test('拼装：画布 DOM 与样式文本都要原样带进去', () => {
  const html = buildReportHtml({ canvasHtml: MIN_HTML, css: '.rb { color: red }', width: 1220 });
  assert.ok(html.includes(MIN_HTML), '画布 DOM 要在');
  assert.ok(html.includes('.rb { color: red }'), '样式要内联进去（隐藏窗口取不到相对路径的外链）');
  assert.ok(html.startsWith('<!doctype html>'), '要是完整文档');
  assert.ok(html.trimEnd().endsWith('</html>'), '文档要闭合');
  assert.equal((html.match(/<style>/g) || []).length, 1, '只应有一个 style 块');
  assert.ok(html.includes('</style>'), 'style 块要闭合');
});

test('拼装：body 必须带 print 类，否则编辑器痕迹会跟着进产物', () => {
  const html = buildReportHtml({ canvasHtml: MIN_HTML, css: '' });
  // `.rb__grip`（拖拽把手）、`.rb__x`（删除按钮）、选中态描边全靠 `body.print` 关掉。
  // 少了这个类名，导出的长图里会出现「⋮⋮」和一堆虚线框 —— 而且只在产物里。
  assert.ok(/<body class="print">/.test(html), 'body 上要有 print 类');
});

test('拼装：画布外面必须再包一层 .report（配色变量靠它继承）', () => {
  const html = buildReportHtml({ canvasHtml: MIN_HTML, css: '' });
  // `--rp-bg` 这些变量定义在 `.report` 上。只拿 `.report__canvas` 的话变量没地方继承，
  // 整张图掉回默认色，而 `getComputedStyle` 在父文档里一切正常（父文档里有 .report）。
  assert.ok(/<div class="report">/.test(html), '画布外面要包 .report');
  assert.ok(html.includes('body.print .report { display: block'), '三栏网格要塌成一栏，否则画布被塞进 208px 那栏');
});

test('拼装：宽度要写进导出页，且非法值退回 1220', () => {
  const wide = buildReportHtml({ canvasHtml: MIN_HTML, css: '', width: 1600 });
  assert.ok(wide.includes('width: 1600px'), '宽度要按传进来的走');
  assert.equal((wide.match(/1600px/g) || []).length, 2, '外层容器和画布都要锁到同一个宽度，不然一个撑一个缩');

  for (const bad of [0, -100, Number.NaN, null, undefined, 'abc']) {
    const html = buildReportHtml({ canvasHtml: MIN_HTML, css: '', width: bad });
    assert.ok(html.includes('width: 1220px'), `宽度 ${String(bad)} 应当退回 1220`);
  }
});

test('拼装：标题要转义（标题是用户能改的）', () => {
  const html = buildReportHtml({ title: '<script>alert(1)</script>', canvasHtml: MIN_HTML });
  assert.ok(!html.includes('<script>alert'), '标题里的标签不能被当成真标签');
  assert.ok(html.includes('&lt;script&gt;'), '应当转义后原样显示');
});

test('拼装：什么都不给也能产出合法文档（不能抛）', () => {
  const html = buildReportHtml();
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('class="print"'));
  assert.ok(html.includes('width: 1220px'));
});

test('canvasHtmlOf：拿外层元素（含 padding / 宽度），找不到就给空串', () => {
  const fake = {
    querySelector: (sel) => (sel === '.report__canvas' ? { outerHTML: MIN_HTML } : null),
  };
  assert.equal(canvasHtmlOf(fake), MIN_HTML);
  // 找不到不能抛：导出按钮点下去要能给出「找不到画布」的提示，而不是崩掉
  assert.equal(canvasHtmlOf(null), '');
  assert.equal(canvasHtmlOf({ querySelector: () => null }), '');
});

test('collectStyles：读不到的外链要如实报出来，而不是假装带上了', () => {
  const doc = {
    querySelectorAll: (sel) => (sel === 'style'
      ? [{ textContent: '.a { color: red }' }, { textContent: '   ' }]
      : [
        // cssRules 读得到的那一份
        { sheet: { cssRules: [{ cssText: '.b { color: blue }' }] }, getAttribute: () => 'a.css' },
        // 跨域样式表：读 cssRules 会抛
        {
          get sheet() { throw new Error('SecurityError'); },
          getAttribute: () => 'cross.css',
        },
      ]),
  };
  const { css, unread } = collectStyles(doc);
  assert.ok(css.includes('.a { color: red }'), '内联样式要收进来');
  assert.ok(css.includes('.b { color: blue }'), '可读的外链要展开成文本');
  assert.deepEqual(unread, ['cross.css'], '读不到的要说出来（界面上要提示「样式没带全」）');
  // 空白的 <style> 不该产出空行堆
  assert.equal(css.includes('\n\n\n'), false);
});

test('collectStyles：没有 document 时不抛', () => {
  assert.deepEqual(collectStyles(null), { css: '', unread: [] });
});
