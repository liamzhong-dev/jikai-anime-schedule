'use strict';

/**
 * 渲染层唯一能碰到的系统能力入口。
 * 只暴露具体方法，不把 ipcRenderer 整个丢出去。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jikai', {
  // 状态
  readState: () => ipcRenderer.invoke('state:read'),
  writeState: (state) => ipcRenderer.invoke('state:write', state),

  // 壁纸（单独一个文件，避免拖慢每次落盘）
  readWallpaper: () => ipcRenderer.invoke('wallpaper:read'),
  writeWallpaper: (payload) => ipcRenderer.invoke('wallpaper:write', payload),
  clearWallpaper: () => ipcRenderer.invoke('wallpaper:clear'),

  // 系统能力
  notify: (title, body) => ipcRenderer.invoke('notify', { title, body }),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),

  // 网络：走主进程，自动跟随系统代理 / VPN
  fetchJson: (payload) => ipcRenderer.invoke('http:json', payload),
  setProxy: (proxy) => ipcRenderer.invoke('net:proxy', proxy),

  // 自动更新：取更新源 JSON（比版本号在渲染层做）
  checkUpdate: (payload) => ipcRenderer.invoke('update:check', payload),

  // 应用信息与系统集成
  appInfo: () => ipcRenderer.invoke('app:info'),
  getAutoLaunch: () => ipcRenderer.invoke('autolaunch:get'),
  setAutoLaunch: (on) => ipcRenderer.invoke('autolaunch:set', on),
  setGlobalHotkey: (spec) => ipcRenderer.invoke('hotkey:set', spec),
  setTrayState: (payload) => ipcRenderer.invoke('tray:state', payload),
  saveTextFile: (payload) => ipcRenderer.invoke('file:save-text', payload),

  /** 主进程 → 渲染层的命令（托盘点击、检查更新等） */
  onCommand: (cb) => {
    const handler = (_e, cmd) => cb?.(cmd);
    ipcRenderer.on('app:command', handler);
    return () => ipcRenderer.removeListener('app:command', handler);
  },
});
