/**
 * 新增能力的纯函数测试：主题令牌、壁纸参数、快捷键归一化、版本比较、
 * 布局预设、缓存清理与预设增删改。
 *
 * 这一批全是「不碰网络、不碰 DOM」的部分，所以能直接在 Node 里断言，
 * 不需要起浏览器 —— 出问题时定位也快得多。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_THEME, THEMES, THEME_GROUPS, getTheme } from '../src/theme/themes.js';
import { computeThemeVars, applyTheme, normalizeWallpaper, DEFAULT_WALLPAPER } from '../src/theme/applyTheme.js';
import { hotkeysByGroup, HOTKEYS, isTypingTarget, lookup, normalizeEvent, shouldHandle } from '../src/core/hotkeys.js';
import { compareVersions, describeUpdate, evaluateUpdate, normalizeManifest, parseVersion, resolveManifestUrl, toApiUrl } from '../src/core/update.js';
import { ALL_CARD_IDS, BUILTIN_PRESETS, dropCardFromLayout, presetById } from '../src/core/layoutPresets.js';
import { FEATURES, hiddenFeatures, hiddenReason, isVisible } from '../src/core/features.js';
import { DEFAULT_SOURCE, SOURCES, degradedText } from '../src/data/sources.js';
import { dataUrlBytes, fitSize, formatBytes as wpBytes } from '../src/core/wallpaper.js';
import {
  applyLayoutPreset, cacheSummary, clearSeasonCache, deleteLayoutPreset, exportLayoutPresets,
  formatBytes, getState, importLayoutPresets, listCache, listPresets, patchSettingSection,
  readSeasonCache, readSeasonCacheRaw, renameLayoutPreset, resetLayout, saveLayoutPreset,
  setLayout, writeSeasonCache,
} from '../src/core/store.js';

// ===================== 主题 =====================

test('主题表：数量、唯一 id、分组合法', () => {
  assert.equal(THEMES.length, 9);
  const ids = THEMES.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, 'id 不能重复');
  assert.ok(ids.includes(DEFAULT_THEME));
  for (const t of THEMES) {
    assert.ok(THEME_GROUPS.includes(t.group), `${t.id} 的分组 ${t.group} 不在列表里`);
    assert.ok(['dark', 'light'].includes(t.scheme), `${t.id} 的 scheme 不合法`);
    assert.equal(t.preview.length, 5, `${t.id} 的预览色应该正好 5 个`);
  }
});

test('每套主题的颜色字段齐全且是合法色值', () => {
  const need = ['bg', 'bg2', 'panel', 'panel2', 'text', 'text2', 'text3', 'accent', 'accent2', 'warn', 'danger', 'ok', 'onAccent'];
  for (const t of THEMES) {
    for (const k of need) {
      const v = t.colors[k];
      assert.ok(typeof v === 'string' && v.length >= 4, `${t.id}.${k} 缺失或不是颜色`);
    }
    assert.match(t.colors.bg, /^#[0-9a-f]{6}$/i, `${t.id}.bg 应该是 6 位 hex`);
    assert.ok(t.colors.radius.lg >= t.colors.radius.r, `${t.id} 圆角大小关系不对`);
  }
});

test('浅色主题必须配深色文字，否则读不清', () => {
  for (const t of THEMES) {
    if (t.scheme !== 'light') continue;
    // 浅色底：正文应当明显比底色深
    const lum = (hexStr) => {
      const n = parseInt(hexStr.slice(1), 16);
      return ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114;
    };
    assert.ok(lum(t.colors.text) < 140, `${t.id} 是浅色主题，但正文色不够深：${t.colors.text}`);
    assert.ok(lum(t.colors.bg) > 200, `${t.id} 是浅色主题，但底色不够浅：${t.colors.bg}`);
  }
});

test('getTheme 对未知 id 回退到默认主题', () => {
  assert.equal(getTheme('不存在的主题').id, DEFAULT_THEME);
  assert.equal(getTheme(undefined).id, DEFAULT_THEME);
  assert.equal(getTheme('cyber').name, '赛博霓虹');
});

// ===================== 主题变量计算 =====================

test('computeThemeVars 产出完整变量表并能解析 RGB 三元组', () => {
  const vars = computeThemeVars('night');
  for (const key of ['--bg', '--panel-rgb', '--text', '--accent', '--accent-soft', '--r-lg', '--shadow', '--wp-url']) {
    assert.ok(key in vars, `缺少变量 ${key}`);
  }
  assert.equal(vars['--bg'], '#0c0e13');
  assert.equal(vars['--bg-rgb'], '12,14,19');
  assert.equal(vars['--panel-rgb'], '21,25,34');
  assert.equal(vars['--r-lg'], '14px');
  assert.equal(vars['--wp-url'], 'none');
  assert.equal(vars['--scheme'], 'dark');
});

test('卡片不透明度会体现在 panel 变量上，并带动侧栏一起变实', () => {
  const solid = computeThemeVars('night', { panelAlpha: 1 });
  const sheer = computeThemeVars('night', { panelAlpha: 0.4 });
  assert.match(solid['--panel'], /,1\)$/);
  assert.match(sheer['--panel'], /,0\.4\)$/);
  // 侧栏比卡片更实：0.4 + 0.18
  assert.match(sheer['--chrome'], /,0\.58\)$/);
  // 越界的值要被夹住
  assert.match(computeThemeVars('night', { panelAlpha: 9 })['--panel'], /,1\)$/);
  assert.match(computeThemeVars('night', { panelAlpha: -3 })['--panel'], /,0\.3\)$/);
});

test('壁纸参数会写进对应变量，且越界值被夹住', () => {
  const vars = computeThemeVars('night', {
    wallpaper: { enabled: true, dataUrl: 'data:image/png;base64,AAAA', opacity: 0.42, blur: 12, brightness: 1.5, scale: 1.2, position: 'top', dim: 0.5 },
  });
  assert.equal(vars['--wp-opacity'], '0.42');
  assert.equal(vars['--wp-blur'], '12px');
  assert.equal(vars['--wp-brightness'], '1.5');
  assert.equal(vars['--wp-scale'], '1.2');
  assert.equal(vars['--wp-position'], 'top');
  assert.equal(vars['--wp-dim'], '0.5');
  assert.match(vars['--wp-url'], /^url\("data:image\/png;base64,AAAA"\)$/);

  const clamped = computeThemeVars('night', {
    wallpaper: { enabled: true, dataUrl: 'data:x', opacity: 5, blur: 999, brightness: 0, scale: 99, position: '斜着', dim: 3 },
  });
  assert.equal(clamped['--wp-opacity'], '1');
  assert.equal(clamped['--wp-blur'], '40px');
  assert.equal(clamped['--wp-brightness'], '0.2');
  assert.equal(clamped['--wp-scale'], '3');
  assert.equal(clamped['--wp-position'], 'center');
  assert.equal(clamped['--wp-dim'], '0.85');
});

test('normalizeWallpaper：没图就等于没开', () => {
  assert.equal(normalizeWallpaper({ enabled: true, dataUrl: null }).enabled, false);
  assert.equal(normalizeWallpaper({}).enabled, false);
  assert.equal(normalizeWallpaper({ enabled: true, dataUrl: 'data:x' }).enabled, true);
  assert.equal(normalizeWallpaper(null).opacity, DEFAULT_WALLPAPER.opacity);
});

test('applyTheme 在没有 DOM 的环境下也不炸，并把变量返回', () => {
  const vars = applyTheme('cyber');
  assert.equal(vars['--bg'], '#0d0a1a');
  assert.equal(vars['--accent'], '#ff2d75');
  assert.equal(vars['--scheme'], 'dark');
});

// ===================== 快捷键 =====================

test('normalizeEvent：可打印字符不补 shift 前缀', () => {
  assert.equal(normalizeEvent({ key: '?' }), '?', 'Shift+/ 出来的是 ?，不该变成 shift+?');
  assert.equal(normalizeEvent({ key: '1' }), '1');
  assert.equal(normalizeEvent({ key: 'A' }), 'a', '字母统一小写');
  assert.equal(normalizeEvent({ key: ',', ctrlKey: true }), 'ctrl+,');
  assert.equal(normalizeEvent({ key: 'Escape' }), 'esc');
  assert.equal(normalizeEvent({ key: ' ' }), 'space');
  assert.equal(normalizeEvent({ key: 'ArrowUp' }), 'up');
  assert.equal(normalizeEvent({ key: 'Tab', shiftKey: true }), 'shift+tab', '非单字符键才记 shift');
  assert.equal(normalizeEvent(null), '');
});

test('HOTKEYS 表里每条的 spec 都能被归一化结果命中', () => {
  assert.ok(HOTKEYS.length >= 12);
  for (const h of HOTKEYS) {
    assert.ok(h.id && h.spec && h.label && h.group, `${h.id ?? '?'} 字段不全`);
    assert.equal(h.spec, h.spec.toLowerCase(), `${h.id} 的 spec 应当小写`);
  }
  // 分组视图不丢条目
  const grouped = hotkeysByGroup().reduce((n, g) => n + g.items.length, 0);
  assert.equal(grouped, HOTKEYS.length);
});

test('lookup 能按 spec 找到绑定', () => {
  assert.equal(lookup('?')[0].id, 'help');
  assert.equal(lookup('ctrl+,')[0].id, 'open-settings-ctrl');
  assert.equal(lookup('没绑过').length, 0);
});

test('输入框里打字时单字符快捷键让路，Esc 与 Ctrl 组合照旧生效', () => {
  const input = { tagName: 'INPUT', isContentEditable: false };
  const div = { tagName: 'DIV', isContentEditable: false };
  assert.equal(isTypingTarget(input), true);
  assert.equal(isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isTypingTarget(div), false);
  assert.equal(isTypingTarget(null), false);

  assert.equal(shouldHandle('1', {}, input), false, '输入框里按 1 不该切视图');
  assert.equal(shouldHandle('esc', {}, input), true, 'Esc 要永远管用');
  assert.equal(shouldHandle('ctrl+r', {}, input), true, 'Ctrl 组合要永远管用');
  assert.equal(shouldHandle('1', {}, div), true);
});

// ===================== 自动更新 =====================

test('parseVersion / compareVersions 处理各种写法', () => {
  assert.deepEqual(parseVersion('v0.2.1'), [0, 2, 1]);
  assert.deepEqual(parseVersion('1.0.0-beta.3'), [1, 0, 0]);
  assert.deepEqual(parseVersion(''), [0]);
  assert.equal(compareVersions('0.2.0', '0.1.9'), 1);
  assert.equal(compareVersions('0.2', '0.2.0'), 0, '长度不同要按 0 补齐');
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1);
  assert.equal(compareVersions('v2.0.0', '1.9.9'), 1);
});

test('normalizeManifest 同时认自定义 manifest 与 GitHub Releases', () => {
  const custom = normalizeManifest({ version: 'v1.2.0', notes: '修了个 bug', url: 'https://example.com/a.exe', mandatory: true });
  assert.equal(custom.version, '1.2.0');
  assert.equal(custom.url, 'https://example.com/a.exe');
  assert.equal(custom.mandatory, true);
  assert.equal(custom.source, 'manifest');

  const gh = normalizeManifest({
    tag_name: 'v1.3.0',
    body: 'changelog',
    html_url: 'https://github.com/o/r/releases/tag/v1.3.0',
    assets: [{ name: 'notes.txt', browser_download_url: 'https://x/notes.txt' }, { name: 'jikai-setup.exe', browser_download_url: 'https://x/setup.exe' }],
  });
  assert.equal(gh.version, '1.3.0');
  assert.equal(gh.url, 'https://x/setup.exe', '优先挑安装包而不是任意附件');
  assert.equal(gh.source, 'github');

  assert.throws(() => normalizeManifest(null), /不是一个 JSON 对象/);
  assert.throws(() => normalizeManifest({ foo: 1 }), /没有版本号字段/);
});

test('evaluateUpdate：判断有无更新、以及被跳过的版本', () => {
  const raw = { version: '0.3.0', url: 'https://example.com/dl' };
  const hit = evaluateUpdate(raw, '0.2.0');
  assert.equal(hit.hasUpdate, true);
  assert.equal(hit.latest, '0.3.0');

  const same = evaluateUpdate({ version: '0.2.0' }, '0.2.0');
  assert.equal(same.hasUpdate, false);

  const older = evaluateUpdate({ version: '0.1.0' }, '0.2.0');
  assert.equal(older.hasUpdate, false, '更新源比本地还旧时不该提示');

  const skipped = evaluateUpdate(raw, '0.2.0', { skippedVersion: '0.3.0' });
  assert.equal(skipped.hasUpdate, false);
  assert.equal(skipped.skipped, true);
});

test('resolveManifestUrl 只接受 http/https，没配就返回 null', () => {
  assert.equal(resolveManifestUrl('', ''), null);
  assert.equal(resolveManifestUrl('ftp://x/y.json', null), null);
  assert.equal(resolveManifestUrl(null, 'https://a/b.json'), 'https://a/b.json');
  assert.equal(resolveManifestUrl(' https://a/b.json ', null), 'https://a/b.json');
});

test('toApiUrl 把 GitHub 网页地址翻成 Releases API 地址', () => {
  // 设置面板里写的就是网页地址，用户不该被要求记住 api.github.com 那一段
  assert.equal(
    toApiUrl('https://github.com/owner/repo/releases/latest'),
    'https://api.github.com/repos/owner/repo/releases/latest',
  );
  assert.equal(
    toApiUrl('https://github.com/owner/repo'),
    'https://api.github.com/repos/owner/repo/releases/latest',
  );
  assert.equal(
    toApiUrl('https://github.com/owner/repo/releases'),
    'https://api.github.com/repos/owner/repo/releases/latest',
  );
  assert.equal(
    toApiUrl('https://github.com/owner/repo/releases/tag/v0.3.0'),
    'https://api.github.com/repos/owner/repo/releases/tag/v0.3.0',
  );
  // 已经写全的 API 地址不能被改坏
  assert.equal(
    toApiUrl('https://api.github.com/repos/owner/repo/releases/latest'),
    'https://api.github.com/repos/owner/repo/releases/latest',
  );
});

test('toApiUrl 对非 GitHub 地址与空值原样处理', () => {
  assert.equal(toApiUrl('https://example.com/jikai/latest.json'), 'https://example.com/jikai/latest.json');
  assert.equal(toApiUrl(''), null);
  assert.equal(toApiUrl(null), null);
  assert.equal(toApiUrl(undefined), null);
  // 仓库下的其它页面不该被误判成 releases
  assert.equal(toApiUrl('https://github.com/owner/repo/issues'), 'https://github.com/owner/repo/issues');
});

test('resolveManifestUrl 输出的是可直接请求的地址', () => {
  assert.equal(
    resolveManifestUrl('https://github.com/owner/repo/releases/latest', null),
    'https://api.github.com/repos/owner/repo/releases/latest',
  );
});

test('describeUpdate 把三种状态说成人话', () => {
  assert.match(describeUpdate(null), /还没检查/);
  assert.match(describeUpdate({ error: '超时' }), /检查失败：超时/);
  assert.match(describeUpdate({ hasUpdate: false, current: '0.2.0' }), /已是最新版本 0\.2\.0/);
  assert.match(describeUpdate({ hasUpdate: true, latest: '0.3.0', current: '0.2.0' }), /发现新版本 0\.3\.0（当前 0\.2\.0）/);
});

// ===================== 布局预设 =====================

test('内置预设覆盖全部卡片，且每个矩形都是合法数字', () => {
  assert.equal(BUILTIN_PRESETS.length, 4);
  assert.equal(ALL_CARD_IDS.length, 9);
  for (const p of BUILTIN_PRESETS) {
    assert.ok(p.name && p.desc, `${p.id} 缺少名称或说明`);
    for (const id of ALL_CARD_IDS) {
      const rect = p.layout[id];
      assert.ok(rect, `${p.id} 少了卡片 ${id}`);
      for (const k of ['x', 'y', 'w', 'h']) {
        assert.equal(typeof rect[k], 'number', `${p.id}.${id}.${k} 不是数字`);
      }
      assert.ok(rect.w >= 200 && rect.h >= 90, `${p.id}.${id} 尺寸太小`);
      assert.ok(rect.x >= 0 && rect.y >= 0, `${p.id}.${id} 坐标为负`);
    }
  }
  assert.equal(presetById('builtin-default').name, '默认 · 宽屏双栏');
  assert.equal(presetById('不存在'), null);
});

test('dropCardFromLayout 只抹掉指定卡片', () => {
  const next = dropCardFromLayout({ a: { x: 1 }, b: { x: 2 } }, 'a');
  assert.deepEqual(Object.keys(next), ['b']);
});

// ===================== 壁纸工具 =====================

test('fitSize 只在超过长边上限时缩放', () => {
  assert.deepEqual(fitSize(1600, 900, 1920), { w: 1600, h: 900, scaled: false });
  const big = fitSize(4000, 2250, 1920);
  assert.equal(big.scaled, true);
  assert.equal(big.w, 1920);
  assert.equal(big.h, 1080);
  // 竖图也一样按长边缩放
  assert.equal(fitSize(1000, 4000, 1920).h, 1920);
});

test('dataUrlBytes 按 base64 还原真实字节数', () => {
  assert.equal(dataUrlBytes('data:image/png;base64,'), 0);
  assert.equal(dataUrlBytes('data:image/png;base64,QUJD'), 3, 'QUJD 解出来是 ABC');
  assert.equal(dataUrlBytes(''), 0);
  assert.equal(wpBytes(2048), '2 KB');
});

// ===================== 缓存与预设（走 store） =====================

test('季度缓存：写入、按新鲜度读取、清单统计', () => {
  const key = 'testq-cache';
  writeSeasonCache(key, { savedAt: Date.now(), source: 'bangumi-data', enriched: false, items: [{ id: 1 }, { id: 2 }] });

  assert.equal(readSeasonCacheRaw(key).items.length, 2);
  assert.equal(readSeasonCache(key, 60_000).length, 2);
  // 把「最大存活时间」设成 0，等价于过期
  assert.equal(readSeasonCache(key, -1), null);
  assert.equal(readSeasonCache('不存在的季度', 60_000), null);

  const row = listCache().find((r) => r.seasonKey === key);
  assert.ok(row);
  assert.equal(row.count, 2);
  assert.equal(row.source, 'bangumi-data');
  assert.ok(row.bytes > 0);
  assert.match(formatBytes(row.bytes), /B|KB|MB/);
});

test('清理缓存：按季度清、只清过期的、全清', () => {
  writeSeasonCache('testq-fresh', { savedAt: Date.now(), source: 'builtin', items: [] });
  writeSeasonCache('testq-old', { savedAt: Date.now() - 10 * 86400000, source: 'builtin', items: [] });

  const one = clearSeasonCache({ key: 'testq-fresh' });
  assert.deepEqual(one.cleared, ['testq-fresh']);
  assert.equal(readSeasonCacheRaw('testq-fresh'), null);

  // 只清 3 天前的：新鲜的还在，旧的被清掉
  writeSeasonCache('testq-fresh', { savedAt: Date.now(), source: 'builtin', items: [] });
  const expired = clearSeasonCache({ olderThanMs: 3 * 86400000 });
  assert.ok(expired.cleared.includes('testq-old'));
  assert.ok(!expired.cleared.includes('testq-fresh'));

  const empty = clearSeasonCache({ key: '根本没这个' });
  assert.deepEqual(empty.cleared, []);
  assert.equal(empty.freedBytes, 0);

  const all = clearSeasonCache({});
  assert.ok(all.cleared.length >= 1);
  assert.equal(cacheSummary().seasons, 0);
});

test('缓存条目数有上限，超了会挤掉最旧的', () => {
  for (let i = 0; i < 13; i += 1) {
    writeSeasonCache(`bulk-${i}`, { savedAt: Date.now() - (13 - i) * 1000, source: 'builtin', items: [] });
  }
  const rows = listCache().filter((r) => r.seasonKey.startsWith('bulk-'));
  assert.equal(rows.length, 10, '最多留 10 个季度');
  // 留下的是最新的那批
  assert.ok(rows.some((r) => r.seasonKey === 'bulk-12'));
  assert.ok(!rows.some((r) => r.seasonKey === 'bulk-0'));
  clearSeasonCache({});
});

test('布局预设：保存、套用、改名、删除、导入导出', () => {
  setLayout('card-a', { x: 5, y: 6, w: 300, h: 200 });
  const saved = saveLayoutPreset('我的布局');
  assert.equal(saved.name, '我的布局');
  assert.deepEqual(saved.layout['card-a'], { x: 5, y: 6, w: 300, h: 200 });
  assert.equal(getState().activePreset, saved.id);

  resetLayout();
  assert.deepEqual(getState().layout, {});
  assert.equal(getState().activePreset, null);

  applyLayoutPreset(saved.id);
  assert.deepEqual(getState().layout['card-a'], { x: 5, y: 6, w: 300, h: 200 });

  // 内置预设也能套用
  applyLayoutPreset('builtin-compact');
  assert.equal(getState().activePreset, 'builtin-compact');
  assert.deepEqual(getState().layout['season-stats'], { x: 12, y: 12, w: 880, h: 96 });
  assert.equal(applyLayoutPreset('没有这个'), null);

  renameLayoutPreset(saved.id, '改名了');
  assert.ok(listPresets().some((p) => p.id === saved.id && p.name === '改名了'));

  const dump = exportLayoutPresets();
  assert.equal(dump.kind, 'layout-presets');
  assert.equal(dump.presets.length, 1);

  const n = importLayoutPresets(dump);
  assert.equal(n, 1);
  assert.equal(listPresets().length, 4 + 2, '4 套内置 + 原来的 1 套 + 导入的 1 套');
  assert.equal(listPresets().filter((p) => p.builtin).length, 4);

  // 脏数据要被挡住
  assert.throws(() => importLayoutPresets({ nope: 1 }), /格式不对/);
  assert.throws(() => importLayoutPresets([{ name: '没有 layout' }]), /没有可用的布局/);

  deleteLayoutPreset(saved.id);
  assert.ok(!listPresets().some((p) => p.id === saved.id));
});

test('patchSettingSection 只改目标区块，其余设置不动', () => {
  const themeBefore = getState().settings.theme;
  const concurrencyBefore = getState().settings.api.concurrency;
  patchSettingSection('api', { concurrency: 6 });
  assert.equal(getState().settings.api.concurrency, 6);
  assert.equal(getState().settings.theme, themeBefore, '改 API 不该碰主题');
  patchSettingSection('wallpaper', { opacity: 0.3 });
  assert.equal(getState().settings.wallpaper.opacity, 0.3);
  assert.equal(getState().settings.api.concurrency, 6);
  patchSettingSection('api', { concurrency: concurrencyBefore });
});

// ---------- 功能开关：藏起来但不删 ----------

test('features 开关默认显示，只有被藏起来的才返回 false', () => {
  assert.equal(isVisible('不存在的功能'), true, '没登记过的按显示处理');
  assert.equal(isVisible('autoUpdate'), false, '自动更新当前是藏起来的');
  assert.equal(hiddenReason('不存在的功能'), null);
  assert.equal(typeof hiddenReason('autoUpdate'), 'string');
});

test('每个功能都要有 label；藏起来的还必须写清原因', () => {
  const ids = Object.keys(FEATURES);
  assert.ok(ids.length > 0);
  for (const id of ids) {
    const f = FEATURES[id];
    assert.ok(f.label, `${id} 缺 label`);
    if (f.visible === false) {
      assert.ok(f.reason && f.reason.length > 6, `${id} 藏起来了却没写原因 —— 半年后没人记得为什么`);
    }
  }
});

test('hiddenFeatures 列出的和实际藏起来的完全一致', () => {
  const listed = hiddenFeatures().map((h) => h.id).sort();
  const expected = Object.entries(FEATURES)
    .filter(([, f]) => f.visible === false)
    .map(([id]) => id)
    .sort();
  assert.deepEqual(listed, expected);
  for (const h of hiddenFeatures()) {
    assert.ok(h.label && h.reason, '这一项没法直接展示给用户');
  }
});

// ---------- 数据源：哪些需要代理 ----------

test('需要联网的数据源都标了 needProxy，离线源不标', () => {
  for (const s of SOURCES) {
    assert.equal(typeof s.needProxy, 'boolean', `${s.id} 缺 needProxy`);
    if (s.network) assert.equal(s.needProxy, true, `${s.id} 要联网却没标 needProxy`);
    else assert.equal(s.needProxy, false, `${s.id} 是离线源，不该标 needProxy`);
  }
  // 恰好两个要代理：bangumi-data 与 bangumi-api
  assert.equal(SOURCES.filter((s) => s.needProxy).length, 2);
  // 默认源必须离线可用 —— 否则断网 / 被墙时打开就是一片空白
  assert.equal(DEFAULT_SOURCE, SOURCES[0].id);
  assert.equal(SOURCES[0].network, false, '默认数据源不该依赖网络');
});

test('降级文案要能让人知道下一步做什么', () => {
  // 联网类：一律要提 VPN，否则用户只会以为程序坏了
  for (const kind of ['stale-cache', 'builtin-fallback', 'enrich-failed', 'builtin-missing']) {
    assert.match(degradedText({ kind, reason: 'timeout' }), /VPN/, `${kind} 的文案里没提 VPN`);
  }
  // 关键词不能丢：界面和别的测试都还依赖它们
  assert.match(degradedText({ kind: 'stale-cache', reason: 'x' }), /上次缓存/);
  assert.match(degradedText({ kind: 'builtin-fallback', reason: 'x' }), /已改用内置数据/);
  assert.match(degradedText({ kind: 'enrich-failed', reason: 'x' }), /只拿到了排播表/);
  assert.match(degradedText({ kind: 'builtin-missing', reason: 'x', seasonKey: '1999q1' }), /内置数据只含/);
  // 没给季度时也不能出现「拿不到  的数据」这种空档
  assert.doesNotMatch(degradedText({ kind: 'builtin-missing' }), /\s{2}/);
  assert.equal(degradedText(null), null);
});
