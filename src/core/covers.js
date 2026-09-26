/**
 * 封面地址处理。
 *
 * Bangumi 的封面 URL 自带缩略图变体：路径里 `/pic/cover/<variant>/` 那一段
 * 换成别的字母就是不同尺寸，服务端现成生成，不需要本地缩图 ——
 * 这点很关键，因为本机没有 MSVC，Node 里装不了 sharp / canvas，自己缩图这条路走不通。
 *
 * 各变体的**实测**像素（自己联网量过，不是文档里抄的）：
 *
 * | 变体 | 实际像素 | 平均体积 | 用途 |
 * | --- | --- | --- | --- |
 * | `l` | 不统一（714×1000 ~ 2907×4096） | 569 KB | 原图。选它就要接受「尺寸不齐、要用 cover 裁切」 |
 * | `c` | 150 × 212 | 约 12 KB | 宽恒为 150px，比例整齐 |
 * | `m` | 100 × 141 | 7.2 KB | 只够 1x |
 * | `s` | 78 × 100 | 4.4 KB | 太小 |
 * | `g` | 48 × 48 | 1.4 KB | 注意不是 100×150，是小方图 |
 *
 * ⚠️ 「g 是 100×150 的缩略图」这个说法是错的，早先的规划文档里就是这么写的，
 * 实测 48×48 之后纠正过一次，别再退回去。
 */

/** 只允许这个 host：变体路径是 Bangumi 图床的约定，换个别家域名就不成立了 */
export const COVER_HOSTS = ['lain.bgm.tv'];

/** 认得的变体字母。放进重试清单里，某个变体缺失时可以往下退 */
export const VARIANT_FALLBACK = ['l', 'c', 'm', 's'];

/**
 * 界面上显示用哪一档：`c`（150×212）。
 *
 * 图块在界面上是 100×120 CSS 像素，2x 屏也就 200×240 —— `c` 勉强够，
 * 而 `l` 是 **569 KB / 张**，一季 82 张就是 45 MB，还要整份经 IPC 转成 base64
 * 送进渲染层。拿原图当缩略图用，代价是 17 倍，收益是零。
 *
 * ⚠️ 全季总量：`c` 是约 2.6 MB，`l` 是约 45.5 MB（都是实测值）。
 */
export const DISPLAY_VARIANT = 'c';

/**
 * 导出用哪一档：`l`（原图，尺寸不齐、要配合 coverCrop）。
 * 只有「按下导出」那一次才去取，平时不碰。
 */
export const EXPORT_VARIANT = 'l';

const VARIANT_PATH = /^(https?:\/\/[^/]+)\/pic\/cover\/([a-z])\/(.+)$/i;

/**
 * 把封面 URL 换成指定变体。
 *
 * 认不出格式、或者 host 不是 Bangumi 图床的，原样返回 ——
 * 宁可用原来的地址，也不要改出一个指向空处的链接。
 *
 * @param {string} url
 * @param {'l'|'c'|'m'|'s'|'g'} variant
 * @returns {{url:string, changed:boolean, variant:string|null}}
 */
export function coverVariant(url, variant) {
  const raw = String(url ?? '').trim();
  const want = String(variant ?? '').trim().toLowerCase();
  if (!raw || !want) return { url: raw, changed: false, variant: null };

  const m = VARIANT_PATH.exec(raw);
  if (!m) return { url: raw, changed: false, variant: null };

  const host = new URL(raw).hostname.toLowerCase();
  if (!COVER_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
    return { url: raw, changed: false, variant: null };
  }

  const current = m[2].toLowerCase();
  if (current === want) return { url: raw, changed: false, variant: current };
  return { url: `${m[1]}/pic/cover/${want}/${m[3]}`, changed: true, variant: want };
}

/**
 * 从封面 URL 反推变体；认不出来给 null。
 * 用来判断「缓存里存的是哪一档」，将来要升级画质时不用重猜。
 */
export function currentVariant(url) {
  const m = VARIANT_PATH.exec(String(url ?? '').trim());
  return m ? m[2].toLowerCase() : null;
}

/**
 * 组名校验 —— 会被当成目录名用，绝不能让用户输入直接进来。
 * 合法：字母数字和 - _，1~48 字符。季度 key（2026q3）和 catchup 都满足。
 */
export function safeGroupKey(group) {
  const s = String(group ?? '').trim();
  if (!/^[A-Za-z0-9_-]{1,48}$/.test(s)) return null;
  return s;
}

/**
 * 居中裁切到目标宽高比（cover 语义）。
 *
 * 选 `l` 变体之后这个是必须的：原图比例从 1:1.40 到 1:1.56 都有，
 * 不统一裁切，Tier List 的版面会参差不齐。
 *
 * @returns {{sx:number, sy:number, sw:number, sh:number}} 源矩形，保证落在原图范围内
 */
export function coverCrop({ srcW, srcH, dstW, dstH }) {
  const sw = Number(srcW) || 0;
  const sh = Number(srcH) || 0;
  const dw = Number(dstW) || 0;
  const dh = Number(dstH) || 0;
  if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) {
    return { sx: 0, sy: 0, sw: Math.max(0, sw), sh: Math.max(0, sh) };
  }
  const srcRatio = sw / sh;
  const dstRatio = dw / dh;

  // 源比目标宽 → 裁左右；源比目标高 → 裁上下。比例一致时整张用。
  if (srcRatio > dstRatio) {
    const w = Math.min(sw, Math.round(sh * dstRatio));
    return { sx: Math.round((sw - w) / 2), sy: 0, sw: w, sh };
  }
  if (srcRatio < dstRatio) {
    const h = Math.min(sh, Math.round(sw / dstRatio));
    return { sx: 0, sy: Math.round((sh - h) / 2), sw, sh: h };
  }
  return { sx: 0, sy: 0, sw, sh };
}

/**
 * 造一批「取图请求」：`{ key, url }`，`key` 是**条目自己的 id**。
 *
 * ⚠️ 为什么 `key` 必须是 id 而不是 url：
 * 封面要按变体取（界面用 `c` 缩略图、导出用 `l` 原图），而条目上存的 `cover`
 * 是原图地址 —— 于是「取图时用的地址」和「条目上的地址」天然是两个值。
 * 拿 url 当键的话，存的一侧和查的一侧各推一次，只要任何一处理解不同就查不到，
 * 而 JS 只给 `undefined`、不报错（v1.1 桌面端 82 张封面全退成色块就是这么来的）。
 *
 * 用 id 当键之后，「该取哪一档」变成纯内部实现，消费方根本碰不到地址。
 *
 * @param {Array<{id:*, cover:string}>} list
 * @param {'l'|'c'|'m'|'s'|'g'} variant
 * @returns {Array<{key:string, url:string}>} 没有封面地址的条目会被丢掉
 */
export function coverEntries(list, variant) {
  const out = [];
  for (const a of Array.isArray(list) ? list : []) {
    const url = coverVariant(a?.cover, variant).url;
    if (url) out.push({ key: String(a?.id), url });
  }
  return out;
}

/**
 * 把「按 url 存」的封面表翻译成「按条目 key 存」。
 *
 * 取图那一层只能按 url 收（它不知道条目），但对**外只暴露 key 键的表** ——
 * 这样变体地址永远出不了模块，也就不会再有「键对不上」这类 bug。
 *
 * @param {Array<{key:string,url:string}>} entries
 * @param {Object<string,string>} byUrl  url -> dataUrl
 * @returns {Object<string,string>}      key -> dataUrl
 */
export function mapCoversByKey(entries, byUrl) {
  const out = {};
  if (!byUrl) return out;
  for (const e of Array.isArray(entries) ? entries : []) {
    const v = byUrl[e?.url];
    // `e?.key` 也用可选链：entries 里混进 null 时 `e.key` 会直接抛，
    // 而这一类「脏数据」在列表里其实很常见
    if (v && e?.key != null) out[String(e.key)] = v;
  }
  return out;
}
