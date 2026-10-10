/**
 * 用户自己导入的图：键的约定、元数据的形状、以及「假条目」的造法。
 *
 * ## 为什么自定义图要伪装成一部番
 *
 * 封面墙、奖项、Tier List 这三处消费图片的地方，全都是**按条目 id 取图**
 * （`Cover` 查 `CoverContext` 里 `images[id]`、`TierItem` 查 `images[key]`、
 * Tier 导出查同一个 Map）。给自定义图单独开一条「按 file 取图」的路，
 * 等于让这三处各多一个分支 —— 而每多一个分支就多一次「这边改了那边没改」的机会。
 *
 * 所以自定义图也发一个 key：`img:<file>`，然后按这个 key 造一个只有
 * `id / titleZh / cover` 三个字段的**假条目**塞进素材池。下游全都不用改：
 * 它看起来就是一部「名字是用户起的、封面是本地 dataURL」的番。
 *
 * ⚠️ `cover` 放的是 **dataURL**：报告长图那份 HTML 是主进程写的临时文件、
 * 和 app 不同源，`file://` 地址在里面会被挡掉，只有 dataURL 能进产物。
 */

/** 自定义图 key 的前缀。`img:` 不会和 Bangumi 的数字 id 撞 */
export const CUSTOM_PREFIX = 'img:';

/** 落盘文件名的合法形状（与主进程 `customImages.cjs` 的 FILE_RE 一致） */
export const CUSTOM_FILE_RE = /^ci-[0-9a-f]{12}\.(jpe?g|png|webp|gif|avif)$/;

export function isCustomFile(file) {
  return CUSTOM_FILE_RE.test(String(file ?? '').trim());
}

export function customKeyOf(file) {
  const f = String(file ?? '').trim();
  return f ? `${CUSTOM_PREFIX}${f}` : '';
}

/** 从 key 反解出 file；不是自定义 key 给空串 */
export function fileOfCustomKey(key) {
  const k = String(key ?? '').trim();
  if (!k.startsWith(CUSTOM_PREFIX)) return '';
  return isCustomFile(k.slice(CUSTOM_PREFIX.length)) ? k.slice(CUSTOM_PREFIX.length) : '';
}

export function isCustomKey(key) {
  return fileOfCustomKey(key) !== '';
}

/**
 * 名字的长度上限。
 * 它会被画进封面墙那一行、Tier 图块那一行 —— 太长会把版面撑散。
 */
export const IMAGE_NAME_MAX = 40;

export function imageName(name, fallback = '自定义图片') {
  const s = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, IMAGE_NAME_MAX);
  return s || fallback;
}

/**
 * 元数据归一化。
 *
 * `file` 不合法一律丢掉 —— 它是要拼进磁盘路径的，宁可少一张图，
 * 也不能让一个手改过的字符串变成 `../../xxx`。
 */
export function normalizeImageMeta(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const file = String(src.file ?? '').trim();
  if (!isCustomFile(file)) return null;
  return {
    file,
    name: imageName(src.name, file),
    bytes: Number.isFinite(Number(src.bytes)) ? Math.max(0, Math.trunc(Number(src.bytes))) : 0,
    addedAt: Number.isFinite(Number(src.addedAt)) ? Number(src.addedAt) : 0,
  };
}

/** 一批元数据：丢掉不合法的、按 file 去重、按加入时间倒序（新加的在最前面） */
export function normalizeImageList(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const m = normalizeImageMeta(item);
    if (!m || seen.has(m.file)) continue;
    seen.add(m.file);
    out.push(m);
  }
  out.sort((a, b) => (b.addedAt - a.addedAt) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return out;
}

/**
 * 造一个「假条目」。
 *
 * `score` 刻意给 0：Tier List 的「按评分自动分档」遇到 0 分会把它留在素材池，
 * 而不是替用户塞进最后一档 —— 自定义图没有评分，谁也不该替它做这个判断。
 * `cover` 没加载出来时给空串：下游 `Cover` 会退成派生色块，不会留下破图。
 */
export function customAnimeOf({ file, name, dataUrl = '' }) {
  const f = String(file ?? '').trim();
  if (!isCustomFile(f)) return null;
  return {
    id: customKeyOf(f),
    titleZh: imageName(name),
    titleJa: '',
    cover: typeof dataUrl === 'string' ? dataUrl : '',
    score: 0,
    __custom: true,
    file: f,
  };
}

/** 元数据 + 已加载的 dataUrl → 假条目清单。给素材池用 */
export function customAnimeList(meta = [], data = {}) {
  return (Array.isArray(meta) ? meta : [])
    .map((m) => customAnimeOf({ file: m?.file, name: m?.name, dataUrl: data?.[m?.file] ?? '' }))
    .filter(Boolean);
}
