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
  fetchBinary: (payload) => ipcRenderer.invoke('http:binary', payload),
  setProxy: (proxy) => ipcRenderer.invoke('net:proxy', proxy),

  // 封面缓存：一组一个目录，按需下载（已有的一律跳过）
  getCover: (payload) => ipcRenderer.invoke('cover:get', payload),
  warmCovers: (payload) => ipcRenderer.invoke('cover:warm', payload),
  coverCacheStats: () => ipcRenderer.invoke('cover:stats'),
  clearCoverCache: (payload) => ipcRenderer.invoke('cover:clear', payload || {}),
  onCoverProgress: (cb) => {
    const handler = (_e, p) => cb?.(p);
    ipcRenderer.on('cover:warm-progress', handler);
    return () => ipcRenderer.removeListener('cover:warm-progress', handler);
  },

  // 名称索引：全量番剧名，单独一个文件（约 1MB，不能混进 state）
  readNameIndex: () => ipcRenderer.invoke('nameindex:read'),
  writeNameIndex: (payload) => ipcRenderer.invoke('nameindex:write', payload),
  clearNameIndex: () => ipcRenderer.invoke('nameindex:clear'),

  // 自动更新：取更新源 JSON（比版本号在渲染层做）
  checkUpdate: (payload) => ipcRenderer.invoke('update:check', payload),

  // 应用信息与系统集成
  appInfo: () => ipcRenderer.invoke('app:info'),
  retryHardware: () => ipcRenderer.invoke('app:retry-hardware'),
  getAutoLaunch: () => ipcRenderer.invoke('autolaunch:get'),
  setAutoLaunch: (on) => ipcRenderer.invoke('autolaunch:set', on),
  setGlobalHotkey: (spec) => ipcRenderer.invoke('hotkey:set', spec),
  setTrayState: (payload) => ipcRenderer.invoke('tray:state', payload),
  saveTextFile: (payload) => ipcRenderer.invoke('file:save-text', payload),
  saveBinaryFile: (payload) => ipcRenderer.invoke('file:save-binary', payload),
  readTextFile: () => ipcRenderer.invoke('file:read-text'),
  writeBackup: (payload) => ipcRenderer.invoke('file:write-backup', payload),

  // 季度报告长图：渲染层拼好自包含 HTML，主进程在隐藏窗口里出 PDF / PNG 再落盘
  reportExport: (payload) => ipcRenderer.invoke('report:export', payload),

  /** 主进程 → 渲染层的命令（托盘点击、检查更新等） */
  onCommand: (cb) => {
    const handler = (_e, cmd) => cb?.(cmd);
    ipcRenderer.on('app:command', handler);
    return () => ipcRenderer.removeListener('app:command', handler);
  },
});
