'use strict';

/**
 * Electron 主进程：窗口、托盘、本地落盘、系统通知、外部浏览器、网络通道、
 * 开机自启、全局快捷键。
 *
 * 副作用集中在这里，渲染层只通过 preload 暴露的 window.jikai 调用，
 * 因此把壳换成 Tauri 时只需要再写一份等效实现，业务代码不用动。
 */

const { app, BrowserWindow, Notification, Menu, dialog, globalShortcut, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const netBridge = require('./net.cjs');
const { createTray } = require('./tray.cjs');

const DEV_URL = process.env.JIKAI_DEV_URL || '';
const ICON_PNG = path.join(__dirname, '..', 'build', 'icons', 'icon.png');

const stateFile = () => path.join(app.getPath('userData'), 'state.json');
const wallpaperFile = () => path.join(app.getPath('userData'), 'wallpaper.json');

let mainWindow = null;
let tray = null;
let isQuitting = false;
let lastTrayState = {};
let currentHotkey = '';

// 从托盘启动（开机自启）时不弹窗，直接蹲在托盘里
const START_HIDDEN = process.argv.includes('--hidden');

/** 外链白名单：只允许 http/https，避免被 file:// 或自定义协议劫持 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

function isSafeUrl(url) {
  try {
    return ALLOWED_PROTOCOLS.has(new URL(String(url)).protocol);
  } catch {
    return false;
  }
}

// ---------- 落盘 ----------

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null; // 首次启动或文件损坏都按空状态处理
  }
}

function writeJsonFile(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 先写临时文件再改名，避免写一半断电留下半个 JSON
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value ?? {}), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** 壁纸单独一个文件：它是 base64 大字符串，混进 state.json 会让每次落盘都很重 */
function writeWallpaper(payload) {
  if (!payload) return writeJsonFile(wallpaperFile(), {});
  return writeJsonFile(wallpaperFile(), payload);
}

// ---------- 窗口 ----------

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 660,
    show: false,
    backgroundColor: '#0c0e13',
    title: '次回',
    icon: fs.existsSync(ICON_PNG) ? ICON_PNG : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => {
    if (!START_HIDDEN && !process.argv.includes('--tray')) win.show();
  });

  if (DEV_URL) {
    win.loadURL(DEV_URL);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  // 关窗不退进程：提醒要能继续跑，所以先藏到托盘
  win.on('close', (event) => {
    const closeToTray = lastTrayState?.closeToTray !== false;
    if (!isQuitting && closeToTray && tray) {
      event.preventDefault();
      win.hide();
    }
  });

  win.on('minimize', (event) => {
    if (lastTrayState?.minimizeToTray === false || !tray) return;
    event.preventDefault();
    win.hide();
  });

  // 页面内的普通链接一律交给系统浏览器，不在应用里开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) {
      event.preventDefault();
      if (isSafeUrl(url)) shell.openExternal(url);
    }
  });

  win.on('closed', () => {
    mainWindow = null;
  });

  return win;
}

function showWindow() {
  if (!mainWindow) {
    mainWindow = createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

function toggleWindow() {
  if (mainWindow && mainWindow.isVisible() && !mainWindow.isMinimized()) {
    mainWindow.hide();
    return;
  }
  showWindow();
}

function sendCommand(cmd) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:command', cmd);
  else showWindow();
}

// ---------- 开机自启 ----------

/**
 * 开发模式下要显式带上项目目录，否则注册的是 electron.exe 本身，
 * 开机后会弹出一个空壳。
 */
function autoLaunchArgs() {
  const args = ['--hidden'];
  if (!app.isPackaged) args.unshift(app.getAppPath());
  return args;
}

function getAutoLaunch() {
  try {
    const s = app.getLoginItemSettings({ args: autoLaunchArgs() });
    return { openAtLogin: Boolean(s.openAtLogin), supported: true, args: autoLaunchArgs() };
  } catch (err) {
    return { openAtLogin: false, supported: false, error: err?.message ?? String(err) };
  }
}

function setAutoLaunch(enabled) {
  try {
    const args = autoLaunchArgs();
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      path: process.execPath,
      args,
    });
    const now = getAutoLaunch();
    return { ...now, requested: Boolean(enabled) };
  } catch (err) {
    return { openAtLogin: false, supported: false, error: err?.message ?? String(err) };
  }
}

// ---------- 全局快捷键 ----------

function setGlobalHotkey(spec) {
  const want = String(spec ?? '').trim();
  if (want === currentHotkey) return { ok: Boolean(currentHotkey), spec: currentHotkey, changed: false };

  if (currentHotkey) {
    try { globalShortcut.unregister(currentHotkey); } catch { /* 本来就没注册上 */ }
    currentHotkey = '';
  }
  if (!want) return { ok: true, spec: '', changed: true };

  try {
    const ok = globalShortcut.register(want, () => toggleWindow());
    if (!ok) return { ok: false, spec: '', reason: `${want} 被别的程序占用了`, changed: true };
    currentHotkey = want;
    return { ok: true, spec: want, changed: true };
  } catch (err) {
    return { ok: false, spec: '', reason: err?.message ?? String(err), changed: true };
  }
}

// ---------- 启动 ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Windows 上不设 AppUserModelId，通知会显示成 electron.app.Electron
  app.setAppUserModelId('com.animedesk.app');

  app.on('second-instance', () => showWindow());

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    await netBridge.applyProxy('');

    // ---- IPC ----
    ipcMain.handle('state:read', () => readJsonFile(stateFile()));
    ipcMain.handle('state:write', (_e, state) => writeJsonFile(stateFile(), state));

    ipcMain.handle('wallpaper:read', () => readJsonFile(wallpaperFile()));
    ipcMain.handle('wallpaper:write', (_e, payload) => writeWallpaper(payload));
    ipcMain.handle('wallpaper:clear', () => writeWallpaper(null));

    ipcMain.handle('shell:open', (_e, url) => {
      if (!isSafeUrl(url)) return false;
      shell.openExternal(url);
      return true;
    });

    ipcMain.handle('notify', (_e, { title, body } = {}) => {
      if (!Notification.isSupported()) return false;
      new Notification({ title: String(title ?? '次回'), body: String(body ?? ''), icon: ICON_PNG }).show();
      return true;
    });

    ipcMain.handle('http:json', (_e, payload = {}) => netBridge.fetchJson(payload));

    // 检查更新：只负责把更新源 JSON 取回来，比版本号在渲染层（core/update.js）
    ipcMain.handle('update:check', (_e, payload = {}) => updater.checkUpdate(payload));

    // 代理变了要立刻生效，同时把结果回给设置面板
    ipcMain.handle('net:proxy', async (_e, proxy) => netBridge.applyProxy(proxy));

    ipcMain.handle('app:info', () => ({
      version: app.getVersion(),
      name: app.getName(),
      platform: process.platform,
      isDesktop: true,
      userData: app.getPath('userData'),
      packaged: app.isPackaged,
    }));

    ipcMain.handle('autolaunch:get', () => getAutoLaunch());
    ipcMain.handle('autolaunch:set', (_e, on) => setAutoLaunch(on));

    ipcMain.handle('hotkey:set', (_e, spec) => setGlobalHotkey(spec));

    ipcMain.handle('tray:state', (_e, payload) => {
      lastTrayState = { ...lastTrayState, ...(payload ?? {}) };
      tray?.setState({
        view: lastTrayState.view,
        todayCount: lastTrayState.todayCount ?? 0,
        followingCount: lastTrayState.followingCount ?? 0,
        catchupCount: lastTrayState.catchupCount ?? 0,
        overdueCount: lastTrayState.overdueCount ?? 0,
        version: lastTrayState.version ?? app.getVersion(),
        autoLaunch: lastTrayState.autoLaunch,
        updateText: lastTrayState.updateText ?? null,
      });
      return true;
    });

    ipcMain.handle('file:save-text', async (_e, { name = 'jikai.json', text = '' } = {}) => {
      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow ?? undefined, {
        title: '保存文件',
        defaultPath: path.join(app.getPath('downloads'), name),
        filters: [{ name: 'JSON', extensions: ['json'] }, { name: '所有文件', extensions: ['*'] }],
      });
      if (canceled || !filePath) return { ok: false, error: '已取消' };
      try {
        fs.writeFileSync(filePath, String(text), 'utf8');
        return { ok: true, path: filePath };
      } catch (err) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    });

    // ---- 托盘 ----
    tray = createTray({
      onToggleWindow: toggleWindow,
      onCommand: (cmd) => {
        if (cmd?.type === 'navigate') {
          showWindow();
          sendCommand({ type: 'navigate', view: cmd.view });
        } else {
          showWindow();
          sendCommand(cmd);
        }
      },
      onCheckUpdate: () => { showWindow(); sendCommand({ type: 'check-update' }); },
      onToggleAutoLaunch: (on) => { setAutoLaunch(on); sendCommand({ type: 'autolaunch-changed', value: Boolean(on) }); },
      onQuit: () => { isQuitting = true; app.quit(); },
    });

    const initial = getAutoLaunch();
    tray.setState({ version: app.getVersion(), autoLaunch: initial.openAtLogin });

    mainWindow = createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
      else showWindow();
    });
  });

  app.on('before-quit', () => {
    isQuitting = true;
  });

  // 托盘常驻是有意为之：关掉所有窗口也不退出
  app.on('window-all-closed', () => {
    if (!tray && process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    try { tray?.destroy(); } catch { /* 已经没了 */ }
  });
}
