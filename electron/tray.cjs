'use strict';

/**
 * 托盘常驻。
 *
 * 提醒功能如果只在窗口开着时有效，那基本等于没有 —— 谁会整天把台历摆在
 * 屏幕正中。所以关窗不退进程、最小化进托盘，右键菜单能直接跳视图、
 * 看今天的更新数、切开机自启。
 *
 * 菜单里的动态数字由渲染层通过 tray:state 推过来：主进程不该去理解
 * 「哪部番今天更新」这种业务逻辑。
 */

const path = require('node:path');
const { Tray, Menu, nativeImage, app } = require('electron');
const { badgeIcon } = require('./traybadge.cjs');

const DEFAULT_STATE = {
  view: 'season',
  todayCount: 0,
  followingCount: 0,
  catchupCount: 0,
  overdueCount: 0,
  dataSource: 'builtin',
  themeName: '',
  version: '',
  autoLaunch: false,
  updateText: null,
  // 默认不显示「检查更新」——渲染进程推上来之前先按隐藏处理，避免菜单里闪一下又消失
  showUpdate: false,
  nextUpdate: null,
};

function trayIcon() {
  const file = path.join(__dirname, '..', 'build', 'icons', 'tray.png');
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) return nativeImage.createEmpty();
  return img;
}

/**
 * @param {{ onCommand:(cmd:object)=>void, onQuit:()=>void, onToggleWindow:()=>void, onShowWindow:()=>void, onCheckUpdate:()=>void, onToggleAutoLaunch:(v:boolean)=>void }} hooks
 */
function createTray(hooks = {}) {
  const icon = trayIcon();
  const tray = new Tray(icon);
  tray.setToolTip('次回');

  let state = { ...DEFAULT_STATE };
  let menu = null;

  const item = (label, click, opts = {}) => ({ label, click, ...opts });

  function buildMenu() {
    const nav = (view, label) =>
      item(label, () => hooks.onCommand?.({ type: 'navigate', view }), {
        type: 'radio',
        checked: state.view === view,
      });

    const todayLine = state.todayCount > 0
      ? `今天有 ${state.todayCount} 部更新`
      : '今天没有排播';
    const catchupLine = state.overdueCount > 0
      ? `待补 ${state.catchupCount} 部 · ${state.overdueCount} 部已逾期`
      : `待补 ${state.catchupCount} 部`;

    const template = [
      // 菜单里写的是「打开」，那就只能是打开 —— 用切换的话，窗口开着时点它
      // 反而把窗口收起来了，跟字面意思正好相反
      item('打开主窗口', () => (hooks.onShowWindow ?? hooks.onToggleWindow)?.()),
      { type: 'separator' },
      nav('season', '本季番剧'),
      nav('schedule', '播出时间表'),
      nav('following', `我的追番（${state.followingCount}）`),
      nav('catchup', `补番清单（${state.catchupCount}）`),
      { type: 'separator' },
      item(todayLine, () => (hooks.onShowWindow ?? hooks.onToggleWindow)?.(), { enabled: state.todayCount > 0 }),
      item(catchupLine, () => hooks.onCommand?.({ type: 'navigate', view: 'catchup' }), { enabled: state.catchupCount > 0 }),
    ];

    if (state.updateText) {
      template.push({ type: 'separator' });
      template.push(item(state.updateText, () => hooks.onCommand?.({ type: 'open-update' })));
    }

    template.push(
      { type: 'separator' },
      item('开机自启', (mi) => hooks.onToggleAutoLaunch?.(mi.checked), {
        type: 'checkbox',
        checked: Boolean(state.autoLaunch),
      }),
      // showUpdate 由渲染进程推过来（跟设置面板里那个入口共用 src/core/features.js 的开关）。
      // 主进程是 CJS，读不到那个 ESM 模块，所以不在这里重复定义一遍真假 —— 只认推过来的值。
      ...(state.showUpdate === false ? [] : [item('检查更新', () => hooks.onCheckUpdate?.())]),
      item('设置…', () => hooks.onCommand?.({ type: 'open-settings' })),
      { type: 'separator' },
      item(`退出次回${state.version ? `（v${state.version}）` : ''}`, () => hooks.onQuit?.()),
    );

    return Menu.buildFromTemplate(template);
  }

  function refresh() {
    menu = buildMenu();
    tray.setContextMenu(menu);
    const tip = state.nextUpdate
      ? `次回 · ${state.nextUpdate}`
      : `次回 · 今天 ${state.todayCount} 部更新`;
    tray.setToolTip(tip);
  }

  // Windows 上左键单击直接呼出/收起窗口，比右键找菜单快
  tray.on('click', () => hooks.onToggleWindow?.());
  tray.on('double-click', () => hooks.onToggleWindow?.());

  /**
   * 图标上的数字角标：今天几部更新。
   *
   * 菜单里那行字得先右键才看得见，而角标是**扫一眼就知道有没有事儿**的那层。
   * 画的时候做了两处省事：数字没变就不重画（每次 setState 都重编码一张 PNG 没必要）；
   * 画失败也不抛 —— 角标画不出来最多是「没有角标」，不该把整个托盘弄挂。
   */
  let badgeCount = null;
  function setBadge(count) {
    const n = Number(count) > 0 ? Math.floor(Number(count)) : 0;
    if (n === badgeCount) return;
    badgeCount = n;
    try {
      tray.setImage(badgeIcon(n));
    } catch {
      /* 画不出来就算了，托盘图标本身还在 */
    }
  }

  setBadge(state.todayCount);
  refresh();

  return {
    tray,
    /** 渲染层推来的最新摘要，用来重建菜单 */
    setState(patch) {
      state = { ...state, ...(patch ?? {}) };
      setBadge(state.todayCount);
      refresh();
    },
    /** 给自检用：现在角标上写的是几 */
    getBadge() {
      return badgeCount;
    },
    getState() {
      return { ...state };
    },
    destroy() {
      try { tray.destroy(); } catch { /* 已经没了 */ }
    },
    refresh,
  };
}

module.exports = { createTray };
