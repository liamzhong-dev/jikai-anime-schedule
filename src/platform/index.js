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
const NAME_INDEX_KEY = 'jikai/nameindex/v1';

/**
 * 浏览器这一侧不支持的能力，统一回这个形状。
 *
 * 为什么不直接抛：界面要有区分度 —— 「浏览器里就是不行」和「程序出错了」
 * 是两回事，混成同一种会让用户以为是 bug。所以带上 unsupported 标记。
 */
function unsupported(what, detail) {
  return { ok: false, unsupported: true, error: `${what}：${detail}` };
}

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
  /**
   * 「再试一次硬件加速」是桌面壳专属。
   *
   * 浏览器里没有「关掉硬件加速」这回事 —— 渲染模式归浏览器自己管，页面连接口都没有。
   * 所以这里老实说没有，别摆一个点了没反应的按钮。
   */
  async retryHardware() {
    return { ok: false, error: '浏览器里没有这一项，渲染模式由浏览器自己决定' };
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

  /**
   * 让用户挑一个文本文件读进来（导入备份用）。
   *
   * 浏览器侧用隐藏的 `<input type="file">`，桌面侧是系统选文件对话框。
   * ⚠️ 这条**不能顺手用 `prompt` 让用户粘路径**：Electron 里 prompt 存在但一调用就抛
   * （「prompt() is and will not be supported」），而浏览器里是好好的 ——
   * 属于「换个壳才炸」的那类坑，读代码完全看不出来。
   *
   * @returns {{ ok: true, name: string, text: string } | { ok: false, error: string }}
   *          用户取消时 `error` 是 '已取消' —— 界面据此**不报错**，只是什么都不做
   */
  async pickTextFile() {
    if (typeof document === 'undefined') return { ok: false, error: '当前环境不能读文件' };
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.style.display = 'none';
      // 拿不到 change（用户关掉选择框）时也得有个收尾：否则 Promise 一直悬着，
      // 界面上的按钮永远是「读取中…」
      let done = false;
      const finish = (r) => { if (!done) { done = true; input.remove(); resolve(r); } };
      input.addEventListener('change', () => {
        const f = input.files?.[0];
        if (!f) return finish({ ok: false, error: '已取消' });
        const fr = new FileReader();
        fr.onload = () => finish({ ok: true, name: f.name, text: String(fr.result ?? '') });
        fr.onerror = () => finish({ ok: false, error: '读文件出错' });
        fr.readAsText(f);
      });
      // 现代浏览器关掉选择框不再触发任何事件，只能靠窗口重新获得焦点时收尾
      globalThis.addEventListener?.('focus', () => setTimeout(() => {
        if (!input.files?.length) finish({ ok: false, error: '已取消' });
      }, 500), { once: true });
      document.body.appendChild(input);
      input.click();
    });
  },

  /**
   * 导入前的自动备份。
   *
   * 浏览器里没有「程序的数据目录」，退而求其次存进 localStorage ——
   * 它是唯一一处「用户看不见、但重启还在」的地方。
   * ⚠️ 明确回 `where`：界面要把「备份放在哪儿」说给用户听，
   * 说不到位的话，「反悔时找得回来」就只是一句空话。
   */
  async writeStateBackup({ name = 'backup.json', text = '' } = {}) {
    if (typeof localStorage === 'undefined') return { ok: false, error: '当前环境没有可写的地方' };
    try {
      localStorage.setItem(`jikai:backup:${name}`, String(text));
      return { ok: true, where: '浏览器本地存储', name, bytes: String(text).length };
    } catch (err) {
      // 配额满了是这里最常见的失败，得如实报，不能假装成功
      return { ok: false, error: err?.message ?? String(err) };
    }
  },

  // ---- 封面缓存 ----
  // 浏览器里没有本地磁盘缓存这回事：直接 <img> 跨域指向 lain.bgm.tv 能显示，
  // 但画进 canvas 就会被 taint，toBlob() 抛 SecurityError。所以这条能力
  // 在 Web 侧明确不支持 —— 宁可说清楚，也不要给一张「看起来能用、导出就炸」的图。
  async getCoverImage() {
    return unsupported('封面本地缓存', '浏览器环境不支持，导出高清图请用桌面版');
  },
  async warmCovers() {
    return unsupported('封面预热', '浏览器环境不支持，导出高清图请用桌面版');
  },
  async coverCacheStats() {
    return { root: null, exists: false, totalBytes: 0, totalFiles: 0, groups: [] };
  },
  async clearCoverCache() {
    return { removed: 0, freedBytes: 0 };
  },
  onCoverProgress() {
    return () => {};
  },

  /** 浏览器里也试着走一次 fetch→blob→dataURL。CORS 允许就成，不允许照实报错。 */
  async saveBinaryFile({ name = 'jikai.png', dataUrl = '' } = {}) {
    if (typeof document === 'undefined') return { ok: false, error: '当前环境不能保存文件' };
    try {
      const blob = await (await fetch(dataUrl)).blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      return { ok: true, bytes: blob.size };
    } catch (err) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  },

  /**
   * 季度报告长图的导出通道。**桌面专属**：它靠主进程开一个隐藏窗口重新渲染，
   * 浏览器里没有等价物（也就没有「图片本地缓存」，封面全是跨域地址，
   * 画进 canvas 直接 taint）。所以这里明确说不支持，界面据此把按钮灰掉 ——
   * 一个点了没反应的按钮比一个灰按钮坏得多。
   */
  async reportExport() {
    return unsupported('季度报告长图导出', '浏览器环境不支持，导出长图请用桌面版');
  },

  // ---- 名称索引 ----
  async readNameIndex() {
    return readJson(NAME_INDEX_KEY);
  },
  async writeNameIndex(payload) {
    return writeJson(NAME_INDEX_KEY, payload);
  },
  async clearNameIndex() {
    if (!hasLocalStorage()) return false;
    try {
      localStorage.removeItem(NAME_INDEX_KEY);
      return true;
    } catch {
      return false;
    }
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
  async retryHardware() {
    return window.jikai?.retryHardware?.() ?? { ok: false, error: '这个版本的桌面壳还不支持' };
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
  /** 系统选文件对话框读一个文本进来。取消时回 `{ok:false, error:'已取消'}`，不抛 */
  async pickTextFile() {
    const r = await window.jikai?.readTextFile?.();
    if (!r) return { ok: false, error: '主进程没有提供读文件能力' };
    return r;
  },
  /** 往 userData 下的 backups/ 写一份（导入前的自动备份），路径由主进程定 */
  async writeStateBackup({ name = 'backup.json', text = '' } = {}) {
    const r = await window.jikai?.writeBackup?.({ name, text });
    if (!r) return { ok: false, error: '主进程没有提供写备份能力' };
    return r;
  },
  async saveBinaryFile({ name = 'jikai.png', dataUrl = '' } = {}) {
    const r = await window.jikai?.saveBinaryFile?.({ name, dataUrl });
    if (!r) throw new Error('主进程没有提供保存能力');
    if (r.ok === false) throw new Error(r.error || '保存失败');
    return r;
  },

  // ---- 封面缓存 ----
  /** @returns {{status:'hit'|'fetched'|'error', dataUrl?, bytes?, error?}} */
  async getCoverImage({ group, url, timeoutMs, refresh, readOnly } = {}) {
    const r = await window.jikai?.getCover?.({ group, url, timeoutMs, refresh, readOnly });
    if (!r) return unsupported('封面取图', '主进程没有提供封面通道');
    return r;
  },
  async warmCovers({ group, urls, concurrency, timeoutMs } = {}) {
    const r = await window.jikai?.warmCovers?.({ group, urls, concurrency, timeoutMs });
    if (!r) return unsupported('封面预热', '主进程没有提供封面通道');
    return r;
  },
  async coverCacheStats() {
    return (await window.jikai?.coverCacheStats?.()) ?? { totalBytes: 0, totalFiles: 0, groups: [], exists: false };
  },
  async clearCoverCache({ group = null } = {}) {
    return (await window.jikai?.clearCoverCache?.({ group })) ?? { removed: 0, freedBytes: 0 };
  },
  onCoverProgress(cb) {
    const off = window.jikai?.onCoverProgress?.(cb);
    return typeof off === 'function' ? off : () => {};
  },

  /**
   * 长图导出。`html` 由渲染层拼好（样式内联、图都是 dataURL），
   * 主进程只负责在隐藏窗口里渲染并落盘。
   * @returns {{ok:boolean, path?:string, bytes?:number, kind?:string, error?:string}}
   */
  async reportExport({ kind = 'pdf', html = '', width = 1220, name = 'jikai-report' } = {}) {
    const r = await window.jikai?.reportExport?.({ kind, html, width, name });
    if (!r) return unsupported('长图导出', '主进程没有提供导出通道（preload 没更新？）');
    return r;
  },

  // ---- 名称索引 ----
  async readNameIndex() {
    return window.jikai?.readNameIndex?.() ?? null;
  },
  async writeNameIndex(payload) {
    return window.jikai?.writeNameIndex?.(payload) ?? false;
  },
  async clearNameIndex() {
    return window.jikai?.clearNameIndex?.() ?? false;
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
