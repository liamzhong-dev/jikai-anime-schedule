/**
 * 季度报告长图的纯函数层。
 *
 * 这一层和 `tierlist.js` 是同一个路子：不碰 DOM、不碰 store、不碰图片数据，
 * 全是「输入对象，输出对象」，所以能被 `node --test` 完整守住。
 * 界面层只负责把真实的点击/拖拽喂进来、把结果画出去。
 *
 * ## 数据形状
 *
 * ```js
 * {
 *   seasonKey: '2026q3',
 *   width: 1220,
 *   theme: 'default',
 *   blocks: [                      // 平铺有序数组，顺序就是自上而下的顺序
 *     { id:'b-1', type:'header', title:'2026 夏季番', subtitle:'七月新番总结' },
 *     { id:'b-2', type:'wall',   title:'本季一览', subjectIds:['558064', ...], columns:6 },
 *     { id:'b-3', type:'award',  title:'本季最佳演出', body:'……', subjectId:'558064' },
 *     { id:'b-4', type:'text',   body:'这季整体偏……' },
 *   ],
 *   updatedAt: 0,
 * }
 * ```
 *
 * ## 三个刻意的选择（和计划稿不一样的地方都在这儿）
 *
 * 1. **`blocks` 是平铺数组**，不是嵌套结构。拖拽排序直接复用 Tier List 那套语义
 *    （「先摘出来、再按摘完后的位置插」），不用为树形结构再写一遍。
 * 2. **封面墙存的是具体 id，不是 `auto` 标记**。计划稿写的是 `sources:['auto']` +
 *    `count`，但那样每次渲染都要重新解析一遍，报告会随着素材库变化而变 ——
 *    报告是**产出物**，不该跟着数据漂。所以插入那一刻就把 id 定下来
 *    （`autoWallSubjects` 负责挑），之后它就是一份固定的名单。
 * 3. **`type` 只开四种**（header / wall / award / text）。模板图里那十几个奖项区块，
 *    本质上都是 `award` 换个标题，不需要每种奖项开一个类型。
 *    `image`（用户导入截图）暂缓，见文件末尾「还没做的」。
 *
 * ## 为什么 id 是 `b-<数字>` 而不是随机串
 *
 * 纯函数要能断言。`crypto.randomUUID()` 一进来，测试就只能写成
 * 「id 存在吗」这种什么都没验的断言。`nextBlockId` 取现有最大值 +1，
 * 连点两次也稳定。
 */

// ===================== 常量 =====================

/** 画布逻辑宽度（1x 像素）。1220 是排版上「一屏看不到底、但导出不超限」的折中 */
export const REPORT_WIDTH = 1220;

/** 允许的宽度范围（拖滑块用） */
export const WIDTH_MIN = 800;
export const WIDTH_MAX = 1600;

/** 块类型。顺序 = 界面上「加一块」按钮的顺序 */
export const BLOCK_TYPES = ['header', 'wall', 'award', 'text'];

export const BLOCK_LABELS = {
  header: '标题',
  wall: '封面墙',
  award: '奖项',
  text: '正文',
};

/** 各字段长度上限。长文本不截，画布会被撑成一张没法看的图 */
export const TITLE_MAX = 60;
export const SUBTITLE_MAX = 80;
export const BODY_MAX = 1200;

/**
 * 编辑器里画布的预览倍率。
 *
 * ⚠️ 这一档**只作用于预览**：画布的逻辑宽度依然是 `REPORT_WIDTH` 那一套，
 * 缩放是把「画好的那一整张」缩着看，不是把排版改小 —— 否则预览就不等于产物了。
 * 所以实现上只能 `transform: scale()`，不许去改画布自己的 width / 字号。
 *
 * 上限取 1：放大超过原尺寸没有意义（想看清细节看导出图），还白白多一层缩放采样。
 */
export const ZOOM = { min: 0.25, max: 1, step: 0.05, def: 1 };

/** 封面墙 */
export const WALL_COLUMNS = 6;
export const WALL_COLUMNS_MIN = 2;
export const WALL_COLUMNS_MAX = 10;
export const WALL_MIN = 1;
export const WALL_MAX = 60;
export const WALL_DEFAULT_COUNT = 24;

// ===================== 文本 / 数字工具 =====================

/**
 * 归一化一段文本。
 *
 * 只认字符串和有限数字：直接 `String(v)` 的话，`{a:1}` 会变成 `"[object Object]"`
 * 存进去，之后谁也看不出这是脏数据还是用户真写了这么一句。
 */
function text(v, max) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v).slice(0, max);
  if (typeof v !== 'string') return '';
  // 换行统一成 \n：CRLF 混进来会让「没改过」的文本在 diff 里显示成改过
  return v.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim().slice(0, max);
}

function intIn(v, lo, hi, fallback) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/** 条目 id 一律转成字符串 —— 键的类型不统一，查表时就一半命中一半不命中 */
function idText(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return '';
  return v.trim();
}

/** 一列 id：丢掉空的、去重、保序 */
function idList(v, max) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(v) ? v : []) {
    const id = idText(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

// ===================== 预览缩放 =====================

/**
 * 夹一个预览倍率。
 *
 * `null` / 空串 / 非数字一律回默认 —— 这跟 `clampFontScale` 是同一个坑：
 * `Number(null) === 0`，不提前挡住的话「没设」会被当成「缩到最小」。
 * 取整到 `step` 的整数倍，好让界面上那个百分比是整的五格一跳（25%、30%…），
 * 而不是 0.37 这种滑到哪儿算哪儿的数。
 */
export function clampZoom(v) {
  if (v === null || v === undefined || v === '') return ZOOM.def;
  const n = Number(v);
  if (!Number.isFinite(n)) return ZOOM.def;
  const snapped = Math.round(n / ZOOM.step) * ZOOM.step;
  // 取整之后可能顶出上限（0.99 → 1.00 没问题，但 1.02 → 1.00 之后还得再夹一次）
  return Math.min(ZOOM.max, Math.max(ZOOM.min, Number(snapped.toFixed(4))));
}

/**
 * 按可用宽度算「整幅看得见」的倍率。
 *
 * `avail` 是滚动区的可视宽度（已经扣掉内边距），`canvasW` 是画布的逻辑宽度。
 * 两者任何一个量不到（0 / 非数字）就返回 1 —— 宁可照原尺寸画，
 * 也不要用 0 或 NaN 去乘，那种时候画布会整个塌掉、还看不出是缩放干的。
 *
 * 上限 1：**小窗口才需要缩小，大窗口不放大**。放大只会让滚动条又回来。
 */
export function fitZoom(avail, canvasW) {
  const a = Number(avail);
  const w = Number(canvasW);
  if (!Number.isFinite(a) || !Number.isFinite(w) || a <= 0 || w <= 0) return ZOOM.def;
  const raw = Math.min(ZOOM.max, a / w);
  /*
   * ⚠️ 这里是**向下**取整，不是四舍五入。
   * 向上哪怕只多一点点，缩完也比可用宽度宽那么几 px，横向滚动条就又回来了 ——
   * 而用户要的恰恰是它别回来。「稍微留点白」比「多一条滚动条」好得多。
   *
   * 粒度取 0.01 而不是 `ZOOM.step`（0.05）：那一格在 1220px 的画布上是 61px，
   * 白白空掉一大条。手动档要整格是因为界面上得显示「55%」这种整齐的数，
   * 自动档没这个需要 —— 它是算出来的，用户看的是「是不是全看见了」。
   */
  const floored = Math.floor(raw * 100) / 100;
  return Math.min(ZOOM.max, Math.max(ZOOM.min, floored));
}

// ===================== 块 =====================

/**
 * 造一块。`type` 认不出就返回 null（调用方据此报错，而不是塞一个空块进去）。
 */
export function makeBlock(type, patch = {}) {
  const t = BLOCK_TYPES.includes(type) ? type : null;
  if (!t) return null;
  const src = patch && typeof patch === 'object' ? patch : {};
  return normalizeBlock({ ...src, id: idText(src.id) || 'b-0', type: t });
}

const EMPTY_BY_TYPE = {
  header: { title: '', subtitle: '' },
  wall: { title: '', subjectIds: [], columns: WALL_COLUMNS },
  award: { title: '', body: '', subjectId: '' },
  text: { body: '' },
};

/**
 * 把读回来的块修正成能用的结构；认不出类型或缺 id 的返回 null。
 *
 * 和 `normalizeTierlist` 一个理由：状态文件是写在磁盘上的，可能被旧版写过、
 * 被手改过、被写坏。界面层不该为这些情况兜底，读的时候就该修干净。
 */
export function normalizeBlock(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const type = BLOCK_TYPES.includes(src.type) ? src.type : null;
  const id = idText(src.id);
  if (!type || !id) return null;

  const base = { id, type, ...EMPTY_BY_TYPE[type] };
  if (type === 'header') {
    return { ...base, title: text(src.title, TITLE_MAX), subtitle: text(src.subtitle, SUBTITLE_MAX) };
  }
  if (type === 'wall') {
    return {
      ...base,
      title: text(src.title, TITLE_MAX),
      subjectIds: idList(src.subjectIds, WALL_MAX),
      columns: intIn(src.columns, WALL_COLUMNS_MIN, WALL_COLUMNS_MAX, WALL_COLUMNS),
    };
  }
  if (type === 'award') {
    return {
      ...base,
      title: text(src.title, TITLE_MAX),
      body: text(src.body, BODY_MAX),
      subjectId: idText(src.subjectId),
    };
  }
  return { ...base, body: text(src.body, BODY_MAX) };
}

/** 块上有没有内容 —— 空块不值得占版面，界面要靠这个给提示 */
export function isBlankBlock(block) {
  const b = normalizeBlock(block);
  if (!b) return true;
  if (b.type === 'header') return !b.title && !b.subtitle;
  if (b.type === 'wall') return b.subjectIds.length === 0;
  if (b.type === 'award') return !b.title && !b.body;
  return !b.body;
}

/** 下一块的 id：取现有最大值 +1，稳定可断言 */
export function nextBlockId(blocks) {
  let max = 0;
  for (const b of Array.isArray(blocks) ? blocks : []) {
    const m = /^b-(\d+)$/.exec(idText(b?.id));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `b-${max + 1}`;
}

// ===================== 报告的增删改序 =====================

/** 一份空报告。刻意不预置任何块 —— 空态是真实存在的分支，得能走到 */
export function makeDefaultReport(seasonKey = null, { nowMs = Date.now() } = {}) {
  return {
    seasonKey: seasonKey ?? null,
    width: REPORT_WIDTH,
    theme: 'default',
    blocks: [],
    updatedAt: nowMs,
  };
}

export function normalizeReport(raw, { seasonKey = null, nowMs = Date.now() } = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const seen = new Set();
  const blocks = (Array.isArray(src.blocks) ? src.blocks : [])
    .map(normalizeBlock)
    .filter(Boolean)
    // 同一个 id 出现两次，React 的 key 会撞、拖拽会算出两个落点
    .filter((b) => {
      if (seen.has(b.id)) return false;
      seen.add(b.id);
      return true;
    });

  return {
    seasonKey: typeof src.seasonKey === 'string' ? src.seasonKey : seasonKey,
    width: intIn(src.width, WIDTH_MIN, WIDTH_MAX, REPORT_WIDTH),
    theme: typeof src.theme === 'string' && src.theme ? src.theme : 'default',
    blocks,
    updatedAt: Number.isFinite(src.updatedAt) ? src.updatedAt : nowMs,
  };
}

/** 整个「季度 -> 报告」映射的归一化，读写都过它 */
export function normalizeReports(raw, { nowMs = Date.now() } = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [key, value] of Object.entries(src)) {
    const k = idText(key);
    if (!k) continue;
    out[k] = normalizeReport(value, { seasonKey: k, nowMs });
  }
  return out;
}

export function blockById(blocks, id) {
  const want = idText(id);
  return (Array.isArray(blocks) ? blocks : []).find((b) => idText(b?.id) === want) ?? null;
}

/**
 * 插一块。
 *
 * `at` 越界就挂到末尾 —— 和 Tier List 的 `moveItem` 一个规矩：
 * 「插到第 99 个」在只有 3 块的时候不算错误，就是放到最后。
 */
export function addBlock(blocks, block, at = Infinity) {
  const list = Array.isArray(blocks) ? blocks : [];
  const b = normalizeBlock(block);
  if (!b) return list.slice();
  const idx = Number.isFinite(Number(at))
    ? Math.min(Math.max(0, Math.trunc(Number(at))), list.length)
    : list.length;
  const out = list.slice();
  out.splice(idx, 0, b);
  return out;
}

export function removeBlock(blocks, id) {
  const want = idText(id);
  return (Array.isArray(blocks) ? blocks : []).filter((b) => idText(b?.id) !== want);
}

/** 改一块。patch 会先过 normalize —— 脏值在写入前就被拦下，不许进状态 */
export function patchBlock(blocks, id, patch) {
  const want = idText(id);
  const list = Array.isArray(blocks) ? blocks : [];
  return list.map((b) => {
    if (idText(b?.id) !== want) return b;
    const merged = normalizeBlock({ ...b, ...(patch ?? {}), id: b.id, type: b.type });
    // 合并后认不出来的话，宁可原样不动，也不要留下一个 null 让渲染层炸掉
    return merged ?? b;
  });
}

/**
 * 把第 `from` 块移到 `to` 位置。
 *
 * ⚠️ `to` 是**移走之后**的下标，不是移走之前的 —— 先摘出来再插，
 * 才是人拖东西时心里想的那个位置；先插再摘会差一位。
 * 这条语义和 `tierlist.moveItem` 一致，别各写一套。
 */
export function moveBlock(blocks, from, to) {
  const list = (Array.isArray(blocks) ? blocks : []).slice();
  const f = Math.trunc(Number(from));
  if (!Number.isFinite(f) || f < 0 || f >= list.length) return list;
  const rest = list.slice();
  const [moved] = rest.splice(f, 1);
  const t = Number.isFinite(Number(to))
    ? Math.min(Math.max(0, Math.trunc(Number(to))), rest.length)
    : rest.length;
  rest.splice(t, 0, moved);
  return rest;
}

// ===================== 封面墙选取 =====================

/**
 * 自动挑一墙作品：有评分的按分降序在前，没评分的按原顺序补在后面。
 *
 * 为什么没评分的也要留：新番刚开播时 `score` 常常是 0，把它们全排除的话
 * 「本季一览」会变成「上季度回顾」。但也不能因此让没评分的排在有评分的前面 ——
 * 那又不是按质量的一览了。
 */
export function autoWallSubjects(pool, count = WALL_DEFAULT_COUNT) {
  const list = (Array.isArray(pool) ? pool : []).filter((a) => a && a.id != null);
  const scored = [];
  const rest = [];
  for (const a of list) {
    (Number(a.score) > 0 ? scored : rest).push(a);
  }
  // 同分按 id 升序兜底：不兜的话排序结果依赖输入顺序，
  // 连点两次「按评分挑」可能排出两个顺序来（autoRankByScore 同一个规矩）
  scored.sort((x, y) => (Number(y.score) - Number(x.score)) || idCompare(x.id, y.id));
  const n = intIn(count, WALL_MIN, WALL_MAX, WALL_DEFAULT_COUNT);
  return scored.concat(rest).slice(0, n).map((a) => idText(a.id));
}

function idCompare(a, b) {
  const x = idText(a);
  const y = idText(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * 查表结果里「其实是查不到」的那一类。
 *
 * ⚠️ 这条是**跟 App 接通之后才暴露出来的**：上层为了不让入口消失，
 * 查不到时会返回一个带 `__missing: true` 的**占位条目**而不是 null
 * （`diaryLookup` / `catchupRows` 都是这个约定 —— 对日记卡片是对的，
 * 卡片得留着，上面写着「待补全」）。
 *
 * 但报告不能照单全收：照收的话墙上会冒出一格写着「条目 12345」的色块，
 * 看着像正常内容，而 `missing` 这条分支永远走不到 —— 于是「查不到的作品要显式留位」
 * 这件事在本机测通了、装到 App 里其实没生效。
 *
 * 只认 `__missing` 这一个标记，不去猜别的字段形状。
 */
export function isMissing(anime) {
  return !anime || anime.__missing === true;
}

/**
 * 把封面墙的 id 解析成作品。
 *
 * 解析不到的不静默丢掉，单独放进 `missing` —— 报告里缺了 3 部作品，
 * 用户得知道是「那 3 部查不到了」，而不是以为墙本来就只放了这些。
 */
export function wallItems(block, lookup) {
  const ids = Array.isArray(block?.subjectIds) ? block.subjectIds : [];
  const items = [];
  const missing = [];
  for (const id of ids) {
    const anime = lookup ? lookup(id) : null;
    if (isMissing(anime)) missing.push(id);
    else items.push(anime);
  }
  return { items, missing };
}

// ===================== 统计 =====================

/**
 * 报告概览。给界面底部和导出前的检查用。
 *
 * `works` 是**去重后**的作品数（同一部可能既在封面墙又在一个奖项里），
 * 而 `blocks` 是块数 —— 这两个数不一样，别混着显示。
 */
export function reportStats(doc) {
  const blocks = Array.isArray(doc?.blocks) ? doc.blocks : [];
  const byType = {};
  for (const t of BLOCK_TYPES) byType[t] = 0;
  const ids = new Set();
  let wallTiles = 0;

  for (const b of blocks) {
    if (!byType[b.type] && byType[b.type] !== 0) continue;
    byType[b.type] += 1;
    if (b.type === 'wall') {
      wallTiles += b.subjectIds.length;
      for (const id of b.subjectIds) ids.add(id);
    }
    if (b.type === 'award' && b.subjectId) ids.add(b.subjectId);
  }

  return { blocks: blocks.length, byType, works: ids.size, wallTiles };
}

/*
 * 还没做的（v1.2 先不做，写在这儿免得下次重新想一遍）：
 *
 * - `image` 块（用户导入自己的截图）。需要「把文件存进 userData 下的一个目录 +
 *   报告里只记相对路径」这套，涉及新的平台能力，单独一步做。
 * - 多套主题 / 自定义配色。现在只有 `default`。
 * - 富文本（加粗、斜体、表格）。只做「换行 + 段落」，报告不是排版软件。
 */
