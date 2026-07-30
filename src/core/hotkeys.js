/**
 * 快捷键：一份可枚举的表 + 一个把 KeyboardEvent 归一化的函数。
 *
 * 归一化里有个容易踩的点：可打印字符不要补 shift 前缀。
 * 按 Shift+/ 得到的是 '?'，如果把 shift 也记进去，就会变成 'shift+?'，
 * 于是写 '?' 的绑定永远不触发。所以 shift 只对「非单字符键」生效。
 */

export const HOTKEY_GROUPS = ['视图切换', '操作', '界面', '帮助'];

export const HOTKEYS = [
  { id: 'view-season', spec: '1', label: '本季番剧', group: '视图切换' },
  { id: 'view-schedule', spec: '2', label: '播出时间表', group: '视图切换' },
  { id: 'view-following', spec: '3', label: '我的追番', group: '视图切换' },
  { id: 'view-catchup', spec: '4', label: '补番清单', group: '视图切换' },
  { id: 'focus-search', spec: '/', label: '聚焦搜索框', group: '操作' },
  { id: 'sync', spec: 'r', label: '同步数据', group: '操作' },
  { id: 'clear-search', spec: 'esc', label: '清空搜索 / 关闭弹层', group: '操作' },
  { id: 'cycle-theme', spec: 't', label: '下一套配色', group: '界面' },
  { id: 'toggle-wallpaper', spec: 'b', label: '开关壁纸', group: '界面' },
  { id: 'open-presets', spec: 'l', label: '布局预设', group: '界面' },
  { id: 'open-settings', spec: ',', label: '设置面板', group: '界面' },
  { id: 'open-settings-ctrl', spec: 'ctrl+,', label: '设置面板', group: '界面' },
  { id: 'help', spec: '?', label: '快捷键帮助', group: '帮助' },
  { id: 'reload', spec: 'ctrl+r', label: '刷新界面', group: '帮助' },
];

const KEY_ALIASES = {
  escape: 'esc',
  ' ': 'space',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  enter: 'enter',
  backspace: 'backspace',
  delete: 'del',
};

/** 把事件归一化成 'ctrl+shift+a' 这种形状 */
export function normalizeEvent(e) {
  if (!e || !e.key) return '';
  const parts = [];
  if (e.ctrlKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.metaKey) parts.push('meta');
  const raw = String(e.key);
  // 非单字符键（方向键、Tab、F1…）才把 shift 记进组合
  if (e.shiftKey && raw.length > 1) parts.push('shift');
  const key = KEY_ALIASES[raw.toLowerCase()] ?? raw.toLowerCase();
  parts.push(key);
  return parts.join('+');
}

/** 光标在输入控件里时，单字符快捷键应该让路 */
export function isTypingTarget(el) {
  if (!el) return false;
  const tag = String(el.tagName ?? '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return Boolean(el.isContentEditable);
}

/**
 * 这条组合键此刻该不该被处理。
 * Esc / Ctrl 系组合即使在输入框里也要管用，否则搜索完按 Esc 没反应很恼人。
 */
export function shouldHandle(spec, event, target) {
  const s = String(spec).toLowerCase();
  if (s.includes('ctrl+') || s.includes('meta+') || s === 'esc') return true;
  return !isTypingTarget(target);
}

/** 查这条组合键绑了什么（同一条可以绑多个动作，返回数组） */
export function lookup(spec) {
  const s = String(spec).toLowerCase();
  return HOTKEYS.filter((h) => h.spec === s);
}

export function hotkeysByGroup() {
  return HOTKEY_GROUPS.map((group) => ({ group, items: HOTKEYS.filter((h) => h.group === group) }))
    .filter((g) => g.items.length);
}
