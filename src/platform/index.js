/**
 * 平台适配器：把「持久化 / 通知 / 打开外链 / 网络 / 壁纸 / 托盘 / 开机自启 / 更新」
 * 这些系统能力收敛到一个接口后面。
 *
 * 业务层和 UI 只认这个接口，不直接碰 localStorage 或 Electron API。
 * 一期壳用 Electron（本机 Rust 工具链没能装上，Tauri 方案暂时搁置）；
 * 将来若要换 Tauri 壳，只需再补一个适配器，业务代码零改动。
 *
 * fetchJson 之所以也要收进来：浏览器直连 api.bgm.tv 会被 CORS 拦，
 * 桌面端得走主进程的网络通道（顺带还能跟随系统代理 / VPN）。
 */

import { APP_VERSION } from '../core/version.js';

const STORE_KEY = 'jikai/state/v1';
const WALLPAPER_KEY = 'jikai/wallpaper/v1';

const hasLocalStorage = () => {
  try {
    return typeof localStorage !== 'undefined' && localStorage !== null;
  } catch {
    return false;
  }
};

const readJson = (key) => {
  if (!hasLocalStorage()) return null;
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const writeJson = (key, value) => {
  if (!hasLocalStorage()) return false;
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
};

const webAdapter = {
  kind: 'web',
  async readState() {
    return readJson(STORE_KEY);
  },
  async writeState(state) {
    return writeJson(STORE_KEY, state);
  },
  notify(title, body) {
    // Web 下降级为页面内提示（不申请 Notification 权限，避免打扰）
    if (typeof window !== 'undefined' && window.__jikaiToast) {
      window.__jikaiToast({ title, body });
      return true;
    }
    return false;
  },
  openExternal(url) {
    if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener');
  },

  /** 浏览器里直接 fetch；超时靠 AbortController */
  async fetchJson(url, { timeoutMs = 12000, headers } = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers, signal: ac.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (err?.name === 'AbortError') throw new Error(`请求超时（${timeoutMs}ms）`);
      const c = err?.cause?.code;
      if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') throw new Error('域名解析失败，可能是没网或被拦了');
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timer);
    }
  },

  async readWallpaper() {
    return readJson(WALLPAPER_KEY);
  },
  async writeWallpaper(payload) {
    return writeJson(WALLPAPER_KEY, payload);
  },
  async clearWallpaper() {
    if (!hasLocalStorage()) return false;
    try {
      localStorage.removeItem(WALLPAPER_KEY);
      return true;
    } catch {
      return false;
    }
  },

  async appInfo() {
    return { version: APP_VERSION, platform: 'web', isDesktop: false, chrome: null };
  },
  async getAutoLaunch() {
    return { openAtLogin: false, supported: false };
  },
  async setAutoLaunch() {
    return { openAtLogin: false, supported: false };
  },
  async checkUpdate() {
    throw new Error('浏览器里没有自动更新，请用桌面版');
  },
  async setGlobalHotkey() {
    return { ok: false, reason: '浏览器里没有全局快捷键' };
  },
  async setTrayState() {
    return false;
  },
  /** 浏览器导出：直接触发下载 */
  async saveTextFile({ name = 'jikai.txt', text = '' } = {}) {
    if (typeof document === 'undefined') return false;
    const blob = new Blob([text], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return true;
  },
  onCommand() {
    return () => {};
  },
};

const electronAdapter = {
  kind: 'electron',
  async readState() {
    return window.jikai?.readState?.() ?? null;
  },
  async writeState(state) {
    return window.jikai?.writeState?.(state) ?? false;
  },
  notify(title, body) {
    return window.jikai?.notify?.(title, body) ?? false;
  },
  openExternal(url) {
    window.jikai?.openExternal?.(url);
  },
  async fetchJson(url, { timeoutMs = 12000, headers } = {}) {
    const r = await window.jikai?.fetchJson?.({ url, timeoutMs, headers });
    if (!r) throw new Error('主进程网络通道不可用');
    if (!r.ok) throw new Error(r.error || `HTTP ${r.status}`);
    return r.data;
  },
  async readWallpaper() {
    return window.jikai?.readWallpaper?.() ?? null;
  },
  async writeWallpaper(payload) {
    return window.jikai?.writeWallpaper?.(payload) ?? false;
  },
  async clearWallpaper() {
    return window.jikai?.clearWallpaper?.() ?? false;
  },
  async appInfo() {
    return window.jikai?.appInfo?.() ?? { version: '0.0.0', platform: 'unknown', isDesktop: true };
  },
  async getAutoLaunch() {
    return window.jikai?.getAutoLaunch?.() ?? { openAtLogin: false, supported: false };
  },
  async setAutoLaunch(on) {
    return window.jikai?.setAutoLaunch?.(Boolean(on)) ?? { openAtLogin: false, supported: false };
  },
  async checkUpdate(payload) {
    const r = await window.jikai?.checkUpdate?.(payload);
    if (!r) throw new Error('更新检查不可用');
    if (!r.ok) throw new Error(r.error || '检查失败');
    return r.data;
  },
  async setGlobalHotkey(spec) {
    return window.jikai?.setGlobalHotkey?.(spec) ?? { ok: false, reason: '不支持' };
  },
  async setTrayState(payload) {
    return window.jikai?.setTrayState?.(payload) ?? false;
  },
  async saveTextFile({ name = 'jikai.json', text = '' } = {}) {
    const r = await window.jikai?.saveTextFile?.({ name, text });
    if (r && r.ok === false) throw new Error(r.error || '保存失败');
    return true;
  },
  onCommand(cb) {
    const off = window.jikai?.onCommand?.(cb);
    return typeof off === 'function' ? off : () => {};
  },
};

export function getPlatform() {
  const isDesktop =
    typeof window !== 'undefined' && window.jikai && typeof window.jikai.readState === 'function';
  return isDesktop ? electronAdapter : webAdapter;
}

export const platform = getPlatform();
