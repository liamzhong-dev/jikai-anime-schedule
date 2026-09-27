'use strict';

/**
 * 把「随包的封面素材图包」种进本地缓存。
 *
 * 装完第一次打开、还没联网的时候，界面上那一片色块很容易被读成「软件坏了」。
 * 与其解释「图还没下来」，不如直接带一批图进去 —— 217 张缩略图一共 2.4MB，
 * 换的是「打开就有图」。
 *
 * 三条规矩：
 *   1. **只补不覆盖**。目标已经有的（不管是种子还是用户自己下过的）一律不碰 ——
 *      种子是旧版本打的包，而用户缓存里那张可能是他刚下到的新图。
 *   2. 只认 hash 命名的文件。图包目录里混进任何别的东西都不该被复制过去。
 *   3. 0 字节的不种。一个空文件摆在缓存里，运行时 `locate` 会判成「已存在」，
 *      于是那张图**永远下不下来** —— 比没有种子更坏。
 *
 * 文件名必须是「运行时算出来的那个 hash」。这件事不靠这里保证，
 * 靠 scripts/fetch-covers.mjs 直接用同一个 hashUrl —— 它那边算错，
 * 这里只会安静地种一堆永远命中不了的文件（见 scripts/check-coverseed.mjs 里
 * 那条「种完之后运行时真的找得到」的断言）。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 与 CoverCache 的落点规则一致：20 位 sha1 前缀 + 已知图片扩展名 */
const HASH_FILE = /^[a-f0-9]{20}\.(?:jpg|jpeg|png|webp|gif|avif|bin)$/;

/**
 * @param {{from:string, to:string}} opts
 *   `from` 是随包图包根目录，`to` 是运行时缓存根目录（即 `CoverCache.root`，
 *   注意**不是** userData 那一层 —— CoverCache 自己会拼一个 covers 子目录）
 * @returns {Promise<{copied:number, skipped:number, rejected:number, failed:number, bytes:number, missing:boolean, source:string, target:string}>}
 *   目录不存在时返回 `missing: true` 而不是抛 —— 开发机上没有图包是正常状态。
 *   `rejected` 与 `failed` 分开：前者是「文件不合规，按规矩不种」（0 字节），
 *   后者是真的写失败了。混在一起时，一个正常的 0 字节文件会让日志看起来像出了故障。
 */
async function seedCovers({ from, to } = {}) {
  const out = {
    copied: 0, skipped: 0, rejected: 0, failed: 0, bytes: 0,
    missing: false, source: from ?? null, target: to ?? null,
  };
  if (!from || !to) {
    out.missing = true;
    return out;
  }

  let groups = [];
  try {
    groups = await fs.promises.readdir(from, { withFileTypes: true });
  } catch {
    out.missing = true;
    return out;
  }

  for (const g of groups) {
    if (!g.isDirectory()) continue;
    const gdir = path.join(from, g.name);
    let files = [];
    try {
      files = await fs.promises.readdir(gdir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!HASH_FILE.test(f)) continue;
      const src = path.join(gdir, f);
      const dst = path.join(to, g.name, f);
      if (fs.existsSync(dst)) {
        out.skipped += 1;
        continue;
      }
      try {
        const st = await fs.promises.stat(src);
        if (!st.isFile() || st.size <= 0) {
          out.rejected += 1;
          continue;
        }
        await fs.promises.mkdir(path.dirname(dst), { recursive: true });
        // 先写 .seed 再改名：写一半被打断时，缓存目录里不会留下一个能被命中的坏文件
        const tmp = `${dst}.seed`;
        await fs.promises.copyFile(src, tmp);
        await fs.promises.rename(tmp, dst);
        out.copied += 1;
        out.bytes += st.size;
      } catch {
        out.failed += 1;
      }
    }
  }

  return out;
}

module.exports = { seedCovers, HASH_FILE };
