'use strict';

/**
 * 用户自己导入的图（动画封面、插画、截图……）。
 *
 * 和封面缓存（`covers.cjs`）是两套东西，别混：
 *   1. 封面缓存的**键是远端 URL**，随时能被重新下载出来，丢了不心疼；
 *      这里的图是用户从自己磁盘上挑的，丢了就再也拿不回来 —— 所以
 *      **删除只有用户显式点才发生**，清理缓存那套逻辑一律不碰这个目录。
 *   2. 文件名是**内容的 sha1**（前 12 位），同一张图重复导入只会存一份。
 *      用户很可能把同一张插画加进两个季度，不去重就是白占一倍空间。
 *
 * 目录：
 *   custom-images/
 *     index.json          { items: [{ file, name, bytes, addedAt }] }
 *     ci-<hash12>.<ext>
 *
 * ⚠️ `name` 是用户起的名字（可能是中文），**不进文件名** ——
 * 本机批处理与非 ASCII 路径一起用会出编码问题，而名字只是显示用。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** 单张上限 12MB。再大的多半是「选错了文件」（原图扫描件 / 视频截图序列） */
const MAX_BYTES = 12 * 1024 * 1024;

/** 允许落盘的文件名。渲染层传进来的 file 一律用它验一遍，防路径穿越 */
const FILE_RE = /^ci-[0-9a-f]{12}\.(jpe?g|png|webp|gif|avif)$/;

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
};

const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
};

function extOf(file) {
  return path.extname(String(file ?? '')).toLowerCase();
}

function mimeOfExt(ext) {
  return MIME_BY_EXT[String(ext ?? '').toLowerCase()] ?? 'application/octet-stream';
}

/** 是不是一个能安全拼进路径的 file 名 */
function isSafeFile(file) {
  return FILE_RE.test(String(file ?? ''));
}

class CustomImageStore {
  /**
   * @param {string} root userData 目录；图会落在它下面的 custom-images/
   */
  constructor(root) {
    this.root = path.join(String(root ?? ''), 'custom-images');
  }

  indexPath() {
    return path.join(this.root, 'index.json');
  }

  fileOf(name) {
    const file = String(name ?? '');
    if (!isSafeFile(file)) return null;
    return path.join(this.root, file);
  }

  async readIndex() {
    try {
      const raw = await fs.promises.readFile(this.indexPath(), 'utf8');
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed?.items) ? parsed.items : [];
      const out = [];
      const seen = new Set();
      for (const it of items) {
        const file = String(it?.file ?? '');
        // 索引是会被手改的：不合法的文件名在这里就丢掉，绝不能让它进路径
        if (!isSafeFile(file) || seen.has(file)) continue;
        seen.add(file);
        out.push({
          file,
          name: String(it?.name ?? file).slice(0, 60) || file,
          bytes: Number.isFinite(Number(it?.bytes)) ? Number(it.bytes) : 0,
          addedAt: Number.isFinite(Number(it?.addedAt)) ? Number(it.addedAt) : 0,
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  async writeIndex(items) {
    await fs.promises.mkdir(this.root, { recursive: true });
    const tmp = `${this.indexPath()}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify({ items }, null, 2), 'utf8');
    await fs.promises.rename(tmp, this.indexPath());
  }

  /**
   * 列出全部（并顺手丢掉磁盘上已经不在的）。
   *
   * 为什么要现查磁盘：索引和目录是两个地方，用户可能自己进 userData 删过图。
   * 只信索引的话界面上会留一条永远显示不出来的条目 —— 而它还能被拖进报告，
   * 于是「报告里有一格是空的」这个现象根本没有线索指向「图被删了」。
   */
  async list() {
    let items = await this.readIndex();
    let changed = false;
    const kept = [];
    for (const it of items) {
      const abs = this.fileOf(it.file);
      if (!abs) { changed = true; continue; }
      const size = await sizeOf(abs);
      if (!size) { changed = true; continue; }
      kept.push(size === it.bytes ? it : { ...it, bytes: size });
    }
    if (changed) {
      items = kept;
      await this.writeIndex(kept).catch(() => {});
    }
    return { items, root: this.root };
  }

  /**
   * 弹选图框 → 读入 → 落盘。
   *
   * @returns {{ok:boolean, file?:string, name?:string, bytes?:number, dataUrl?:string, error?:string}}
   *   用户取消时 `error` 是 '已取消'（不是失败，界面据此什么都不做）
   */
  async importImage({ dialog } = {}) {
    const dlg = dialog ?? require('electron').dialog;
    const { canceled, filePaths } = await dlg.showOpenDialog({
      title: '选一张图加进次回',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif'] }],
    });
    if (canceled || !filePaths?.length) return { ok: false, error: '已取消' };

    const src = filePaths[0];
    let buf;
    try {
      const st = fs.statSync(src);
      if (st.size > MAX_BYTES) {
        return { ok: false, error: `这张图有 ${(st.size / 1048576).toFixed(1)} MB，上限是 ${MAX_BYTES / 1048576} MB` };
      }
      buf = await fs.promises.readFile(src);
    } catch (err) {
      return { ok: false, error: err?.message ?? String(err) };
    }
    if (!buf?.length) return { ok: false, error: '这个文件是空的' };

    // 只认扩展名：本机没有 sharp / canvas，解不出真实格式，
    // 而「扩展名写着 png 其实是 jpeg」这种文件浏览器也能认、落盘也不影响显示
    const ext = EXT_BY_MIME[mimeOfExt(extOf(src))] ?? extOf(src);
    if (!ext) return { ok: false, error: '只收 jpg / png / webp / gif / avif' };

    const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
    const file = `ci-${hash}${ext}`;
    const abs = this.fileOf(file);
    const mime = mimeOfExt(ext);
    const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;

    // 同一张图已经导入过：直接复用，不重复写、也不重复进索引
    const items = await this.readIndex();
    if (await sizeOf(abs)) {
      if (!items.some((it) => it.file === file)) {
        items.push({ file, name: baseName(src), bytes: buf.length, addedAt: Date.now() });
        await this.writeIndex(items);
      }
      return { ok: true, file, name: baseName(src), bytes: buf.length, dataUrl, reused: true };
    }

    try {
      await fs.promises.mkdir(this.root, { recursive: true });
      // 先写临时文件再改名：写一半崩了不会留下一个能被读成图的坏文件
      const tmp = `${abs}.tmp`;
      await fs.promises.writeFile(tmp, buf);
      await fs.promises.rename(tmp, abs);
    } catch (err) {
      return { ok: false, error: `存图失败：${err?.message ?? String(err)}` };
    }

    items.push({ file, name: baseName(src), bytes: buf.length, addedAt: Date.now() });
    await this.writeIndex(items);
    return { ok: true, file, name: baseName(src), bytes: buf.length, dataUrl };
  }

  /**
   * 读一张图出来（给渲染层显示 / 导出用）。
   *
   * 返回的是 **dataURL** 而不是文件路径：报告长图那份 HTML 是「不同源的临时文件」，
   * 里面写 `file://` 地址会被 Chromium 挡掉，只有 dataURL 能进产物。
   */
  async read(file) {
    const abs = this.fileOf(file);
    if (!abs) return { ok: false, error: '图片名不合法' };
    try {
      const buf = await fs.promises.readFile(abs);
      if (!buf.length) return { ok: false, error: '这个文件是空的' };
      return { ok: true, file: String(file), dataUrl: `data:${mimeOfExt(extOf(file))};base64,${buf.toString('base64')}` };
    } catch (err) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  }

  /** 删一张图。只有用户显式点删除才走到这里 */
  async remove(file) {
    const abs = this.fileOf(file);
    if (!abs) return { ok: false, error: '图片名不合法' };
    const items = await this.readIndex();
    const next = items.filter((it) => it.file !== String(file));
    try {
      await fs.promises.rm(abs, { force: true });
    } catch (err) {
      return { ok: false, error: err?.message ?? String(err) };
    }
    if (next.length !== items.length) await this.writeIndex(next);
    return { ok: true, removed: items.length - next.length };
  }
}

function baseName(p) {
  return path.basename(String(p ?? '')).slice(0, 60) || '图片';
}

async function sizeOf(file) {
  try {
    const st = await fs.promises.stat(file);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}

module.exports = { CustomImageStore, isSafeFile, MAX_BYTES, FILE_RE };
