'use strict';

/**
 * 封面本地缓存。
 *
 * 为什么必须有这一层：
 *   1) 渲染层直接 <img> 跨域的封面图，画进 canvas 会被 taint，导出时 toBlob()
 *      直接抛 SecurityError —— 只有主进程取回来的图（同源 dataURL）才安全；
 *   2) 断网就没封面。实测过 lain.bgm.tv 在 VPN 一关就整体不可达，
 *      所以「图片能离线显示」不是优化项，是做图类功能的**前置条件**。
 *
 * 目录按「组」分一层：
 *   covers/<group>/<hash>.<ext>
 *   group 目前有两种取值 —— 季度 key（2026q3）和补番组（catchup）。
 * 分层的理由是清理：删一个季度的缓存就是删一个目录，不用遍历判定归属。
 *
 * 文件名来自 URL 的 sha1，不用 subject id —— 同一部番可能有多个变体，
 * 而「变体」只是在 URL 的一小段里，换成 hash 之后天然互不覆盖。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PROGRESS_MAX = 100;

/** MIME → 扩展名；认不出来的一律 .bin，不猜 */
const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
};

function extFor(mime, url) {
  const byMime = EXT_BY_MIME[String(mime ?? '').toLowerCase()];
  if (byMime) return byMime;
  return extFromUrl(url);
}

/** 从 URL 后缀猜扩展名；猜不出给 .jpg（Bangumi 封面几乎全是 jpg） */
function extFromUrl(url) {
  const m = /\.(jpe?g|png|webp|gif|avif)(?:\?|$)/i.exec(String(url ?? ''));
  if (m) return `.${m[1].toLowerCase()}`;
  return '.jpg';
}

/** 查缓存时要挨个试的扩展名集合，顺序无关，覆盖 extFor 可能写出的每一种 */
const KNOWN_EXTS = ['.jpg', '.png', '.webp', '.gif', '.avif', '.bin'];

/** 组名必须能安全地出现在路径里 —— 季度 key 和 'catchup' 都满足，用户自填的不行 */
function safeGroup(group) {
  const s = String(group ?? '').trim();
  if (!/^[A-Za-z0-9_-]{1,48}$/.test(s)) return null;
  return s;
}

function hashUrl(url) {
  return crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 20);
}

class CoverCache {
  /**
   * @param {string} root 缓存根目录，一般是 app.getPath('userData')/covers
   * @param {{ fetchBinary?: Function }} deps fetchBinary 由 net.cjs 注入，方便测试与替换
   */
  constructor(root, { fetchBinary } = {}) {
    this.root = path.join(root, 'covers');
    this.fetchBinary = fetchBinary;
  }

  groupDir(group) {
    const safe = safeGroup(group);
    if (!safe) return null;
    return path.join(this.root, safe);
  }

  /**
   * 定位一个 URL 对应的本地文件。
   *
   * 这里必须按扩展名逐个试，不能只算一个「预期路径」：
   * 扩展名是从响应的 Content-Type 推出来的，而**查缓存的时候还没有响应** ——
   * 早先的写法查的是 `hash + '.jpg'`，落盘却可能写成 `hash + '.png'`（图是 PNG 时），
   * 于是第二次来查永远查不到，又去下载一遍。缓存看起来在工作，其实一次都没命中过。
   *
   * @returns {{file:string, found:string|null, error?:string}}
   *   found 非空表示本地已有；file 是「没有时应该写到哪」。
   */
  locate(group, url) {
    const dir = this.groupDir(group);
    if (!dir) return { error: '组名不合法（只允许字母、数字、-、_，最长 48 字符）' };
    const base = path.join(dir, hashUrl(url));
    for (const ext of KNOWN_EXTS) {
      const p = base + ext;
      if (fs.existsSync(p)) return { file: p, found: p };
    }
    // 没有就按 URL 后缀猜一个落点（Bangumi 的封面基本都是 .jpg）
    return { file: base + extFromUrl(url), found: null };
  }

  /**
   * 取一张封面：有缓存就直接回.readFile，没有才走网络。
   *
   * @returns {Promise<{status:'hit'|'fetched'|'error', dataUrl?:string, bytes?:number, error?:string}>}
   *   调用方看 status 就知道这次有没有真的联网，界面据此决定要不要显示「补图中」。
   */
  /**
   * 取一张图。
   *
   * `readOnly` = 只读缓存，**绝不联网**。
   * 存在的意义：界面在预热的同时要反复「看看现在有哪些」，用普通模式问的话
   * 每次未命中都会触发一次下载 —— 和正在跑的预热叠在一起就是两份流量。
   *
   * @returns {{status:'hit'|'miss'|'fetched'|'error', dataUrl?, bytes?, error?}}
   */
  async get({ group, url, timeoutMs = 20000, refresh = false, readOnly = false } = {}) {
    if (!this.fetchBinary) return { status: 'error', error: '主进程没有注入取图能力' };
    if (!url) return { status: 'error', error: '没有封面地址' };

    const { file: existing, error } = this.locate(group, url);
    if (error) return { status: 'error', error };

    if (!refresh && existing) {
      try {
        const buf = await fs.promises.readFile(existing);
        if (buf.length) {
          const mime = mimeFromExt(path.extname(existing));
          return { status: 'hit', dataUrl: `data:${mime};base64,${buf.toString('base64')}`, bytes: buf.length };
        }
      } catch {
        /* 读不出来就当没有，往下走网络重新取 */
      }
    }

    // 只读模式到这里就结束：没有就是没有，不是错误，也不去下
    if (readOnly) return { status: 'miss' };

    const res = await this.fetchBinary({ url, timeoutMs });
    if (!res?.ok) return { status: 'error', error: res?.error ?? '取图失败' };

    const { error: fileErr } = this.locate(group, url);
    if (fileErr) return { status: 'error', error: fileErr };
    // 落点按「真实 MIME」算，跟查缓存时的逐个试配对 —— 两边必须一致，否则永远命中不了
    const realFile = path.join(this.groupDir(group), `${hashUrl(url)}${extFor(res.mime, url)}`);

    // 先写临时文件再改名：写一半崩了不会留下一个能被 readFile 命中的坏图
    try {
      await fs.promises.mkdir(path.dirname(realFile), { recursive: true });
      const tmp = `${realFile}.tmp`;
      await fs.promises.writeFile(tmp, Buffer.from(res.data, 'base64'));
      await fs.promises.rename(tmp, realFile);
    } catch (err) {
      // 落盘失败不该让整张图废掉 —— 内存里那份还能用
      return {
        status: 'fetched',
        dataUrl: `data:${res.mime};base64,${res.data}`,
        bytes: res.bytes,
        cached: false,
        warning: `缓存写入失败：${err?.message ?? String(err)}`,
      };
    }

    return {
      status: 'fetched',
      dataUrl: `data:${res.mime};base64,${res.data}`,
      bytes: res.bytes,
      cached: true,
    };
  }

  /**
   * 批量预热一组封面。只下载还没有的 —— 已经有的一律跳过，
   * 否则每进一次 Tier List 都重下一遍，等于没有缓存。
   *
   * 并发必须限制：实测串行拉一季要 200 秒，并发 5 路只要 7 秒；
   * 但也别太狠，lain.bgm.tv 那边太猛会被限流。
   */
  async warm({ group, urls, timeoutMs = 20000, concurrency = 5, onProgress } = {}) {
    const list = [...new Set((urls ?? []).filter(Boolean))];
    const total = list.length;
    let ok = 0;
    let skipped = 0;
    let failed = 0;
    let bytes = 0;
    const errors = [];

    if (!total) {
      onProgress?.({ pct: PROGRESS_MAX, done: 0, total: 0, cached: 0, failed: 0 });
      return { total: 0, ok: 0, skipped: 0, failed: 0, bytes: 0, errors };
    }

    // 先扫一遍哪些已经有了：补:{ 已存的图不用联网，也能马上给个准数 }
    const pending = [];
    for (const url of list) {
      const { found, error } = this.locate(group, url);
      if (error) { failed += 1; errors.push({ url, error }); continue; }
      const size = found ? await existsWithSize(found) : 0;
      if (size) { skipped += 1; bytes += size; }
      else pending.push(url);
    }

    let done = skipped;
    const report = () => onProgress?.({
      pct: Math.min(PROGRESS_MAX, Math.round((done / total) * PROGRESS_MAX)),
      done, total, cached: skipped, failed,
    });
    report();

    let cursor = 0;
    const size = Math.max(1, Math.min(concurrency, pending.length || 1));

    async function runWorker() {
      for (;;) {
        const i = cursor;
        cursor += 1;
        if (i >= pending.length) return;
        const url = pending[i];
        const res = await this.get({ group, url, timeoutMs });
        if (res.status === 'error') {
          failed += 1;
          if (errors.length < 20) errors.push({ url, error: res.error });
        } else {
          ok += 1;
          bytes += res.bytes ?? 0;
        }
        done += 1;
        report();
      }
    }

    await Promise.all(Array.from({ length: size }, () => runWorker.call(this)));
    return { total, ok, skipped, failed, bytes, errors };
  }

  /** 各组的占用情况，给设置面板显示用 */
  async stats() {
    const out = { root: this.root, exists: false, totalBytes: 0, totalFiles: 0, groups: [] };
    let entries;
    try {
      entries = await fs.promises.readdir(this.root, { withFileTypes: true });
    } catch {
      return out;
    }
    out.exists = true;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(this.root, e.name);
      let files = null;
      try { files = await fs.promises.readdir(dir); } catch { continue; }
      let bytes = 0;
      for (const f of files) {
        const size = await sizeOf(path.join(dir, f));
        bytes += size;
      }
      out.totalBytes += bytes;
      out.totalFiles += files.length;
      out.groups.push({ group: e.name, files: files.length, bytes });
    }
    out.groups.sort((a, b) => b.bytes - a.bytes);
    return out;
  }

  /** 清一组或全清。省略 group 就是清空整个 covers 目录 */
  async clear({ group = null } = {}) {
    const before = await this.stats();
    if (group) {
      const dir = this.groupDir(group);
      if (!dir) return { removed: 0, freedBytes: 0, error: '组名不合法' };
      const hit = before.groups.find((g) => g.group === group);
      try {
        await fs.promises.rm(dir, { recursive: true, force: true });
      } catch (err) {
        return { removed: 0, freedBytes: 0, error: err?.message ?? String(err) };
      }
      return { removed: hit?.files ?? 0, freedBytes: hit?.bytes ?? 0 };
    }

    try {
      await fs.promises.rm(this.root, { recursive: true, force: true });
    } catch (err) {
      return { removed: 0, freedBytes: 0, error: err?.message ?? String(err) };
    }
    return { removed: before.totalFiles, freedBytes: before.totalBytes };
  }
}

function mimeFromExt(ext) {
  const map = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif' };
  return map[String(ext ?? '').toLowerCase()] ?? 'application/octet-stream';
}

async function existsWithSize(file) {
  try {
    const st = await fs.promises.stat(file);
    return st.isFile() && st.size > 0 ? st.size : 0;
  } catch {
    return 0;
  }
}

async function sizeOf(file) {
  try {
    const st = await fs.promises.stat(file);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}

module.exports = { CoverCache, hashUrl, extFor, safeGroup, mimeFromExt };
