/**
 * Tier List 的纯函数层。
 *
 * 这一层刻意不碰 DOM、不碰 store、不碰图片数据 ——
 * 拖拽落点、档位分配、导出几何这三件事全是「输入坐标/数字，输出数字」，
 * 是本项目里少数能被 `node --test` 完整守住的部分。
 * 界面层（阶段 D）只负责把真实的鼠标坐标喂进来、把算出的结果画出去。
 *
 * 数据形状按规划 §2.7，不再另行设计：
 *
 * ```js
 * {
 *   templateId: 'anime-season',
 *   rows:  [{ id:'r1', label:'TOP', color:'#ff7f7f' }, ...],
 *   items: [{ key:'558064', rowId:'r1' }],   // 数组顺序 = 档内顺序，不另存 index
 *   itemSize: 'poster',
 *   updatedAt: 0,
 * }
 * ```
 *
 * 两个容易记反的地方，写在这儿免得后面踩：
 *
 * 1. `items` 的**下标不代表档内序号** —— 同一档的图块在数组里可以不连续
 *    （别的档的图块会插在中间）。取「第 n 个」必须先在同档子序列里数一遍，
 *    `moveItem` 内部就是这么做的。
 * 2. `moveItem` 的 `index` 是**移走之后**的位置。先摘出来再插，才是人拖东西时
 *    心里想的那个位置；先插再摘会差一位。
 */

import { coverCrop } from './covers.js';

// ===================== 常量 =====================

/** 图块尺寸基准（1x 像素）。海报 1:1.4，角色 1:3 —— 后者为第二个模板留着 */
export const ITEM_SIZES = {
  poster: { id: 'poster', label: '海报', w: 100, h: 140 },
  character: { id: 'character', label: '角色', w: 60, h: 180 },
};

/** 默认档位：7 档，颜色走 tiermaker 那套由红到紫的渐变，深浅一眼能分档 */
export const DEFAULT_ROWS = [
  { id: 'r1', label: 'TOP', color: '#ff7f7f' },
  { id: 'r2', label: 'A', color: '#ffbf7f' },
  { id: 'r3', label: 'B', color: '#ffdf7f' },
  { id: 'r4', label: 'C', color: '#bfff7f' },
  { id: 'r5', label: 'D', color: '#7fbfff' },
  { id: 'r6', label: 'TRASH', color: '#bf7fff' },
  { id: 'r7', label: 'DRUG', color: '#9aa0a6' },
];

/**
 * 预设档位组。
 *
 * 规划里拍的是「几套预设可选，档位数量固定 7 档」——
 * 所以这三组**都是 7 行**，换组只换名字和颜色，行数不变。
 * 理由很实在：行数一变，`items` 里指向 `r7` 的图块就会悬空，
 * 而「换档位组时把用户排好的东西丢掉」是最不能接受的。
 */
export const PRESET_ROW_GROUPS = [
  { id: 'top-drug', name: 'TOP ~ DRUG（默认）', rows: DEFAULT_ROWS },
  {
    id: 'masterpiece',
    name: 'Masterpiece ~ E',
    rows: [
      { id: 'r1', label: 'Masterpiece', color: '#ff7f7f' },
      { id: 'r2', label: 'S', color: '#ffbf7f' },
      { id: 'r3', label: 'A', color: '#ffdf7f' },
      { id: 'r4', label: 'B', color: '#bfff7f' },
      { id: 'r5', label: 'C', color: '#7fbfff' },
      { id: 'r6', label: 'D', color: '#bf7fff' },
      { id: 'r7', label: 'E', color: '#9aa0a6' },
    ],
  },
  {
    id: 's-f',
    name: 'S ~ F',
    rows: [
      { id: 'r1', label: 'S', color: '#ff7f7f' },
      { id: 'r2', label: 'A', color: '#ffbf7f' },
      { id: 'r3', label: 'B', color: '#ffdf7f' },
      { id: 'r4', label: 'C', color: '#bfff7f' },
      { id: 'r5', label: 'D', color: '#7fbfff' },
      { id: 'r6', label: 'E', color: '#bf7fff' },
      { id: 'r7', label: 'F', color: '#9aa0a6' },
    ],
  },
];

/**
 * 自动分档的分数线（降序，长度 = 档位数 - 1）。
 * 最后那一档兜住所有更低的分数。
 */
export const SCORE_THRESHOLDS = [8, 7.5, 7, 6.5, 6, 5];

/**
 * 「自定义」**不是一套档位行**，只是「这份表已经不是任何一个预设了」的标记。
 *
 * 所以它不进 `PRESET_ROW_GROUPS`：那里每一项都要自带 `rows`，
 * 而自定义的行就存在这份 tierlist 自己的 `rows` 里。
 * 混进去的话，「换档位组」那条分支会拿着一份空行去覆盖用户改好的表。
 */
export const CUSTOM_PRESET_ID = 'custom';

/** 档位行数上下限。上限是排版撑不住，下限是「只有一档」的 Tier List 没有意义 */
export const ROW_LIMITS = { min: 2, max: 12 };

/** 档位名的长度上限：粘一整段话进来会把那一列撑爆，预览和导出都得跟着崩 */
export const ROW_LABEL_MAX = 24;

/**
 * 新档位的颜色轮转。
 *
 * 单独一张表，不从 `DEFAULT_ROWS` 里取 —— 以后改默认档位的配色
 * （比如换成别的色系），不该顺带改掉「加一档」时给的颜色。
 */
const NEW_ROW_COLORS = ['#ff7f7f', '#ffbf7f', '#ffdf7f', '#bfff7f', '#7fbfff', '#bf7fff', '#d0d0d0', '#7fd4c1'];

/** 这份表还是不是某个预设 */
export function isCustomPreset(presetId) {
  return String(presetId ?? '') === CUSTOM_PRESET_ID;
}

/** 档位名洗一遍：去掉首尾空白、压掉换行、截到上限。空的内退回兜底名 */
export function cleanRowLabel(label, fallback = '新档') {
  const s = String(label ?? '').replace(/\s+/g, ' ').trim().slice(0, ROW_LABEL_MAX);
  return s || fallback;
}

const HEX_COLOR = /^#([0-9a-fA-F]{6})$/;
const HEX_SHORT = /^#([0-9a-fA-F]{3})$/;

/**
 * 认一个颜色，认不出给中性灰。
 *
 * 三位简写 `#fff` 展开成六位：`<input type="color">` 只吃六位，
 * 存档里留着简写的话，取色器会显示成灰的、用户一碰就把颜色改错。
 * 八位带 alpha 的不收：档位底色必须是实色，透明下去行里的白字就看不清了。
 */
export function cleanRowColor(color, fallback = '#9aa0a6') {
  const s = String(color ?? '').trim();
  if (HEX_COLOR.test(s)) return s.toLowerCase();
  const short = HEX_SHORT.exec(s);
  if (short) return `#${short[1][0].repeat(2)}${short[1][1].repeat(2)}${short[1][2].repeat(2)}`.toLowerCase();
  return fallback;
}

/**
 * 下一个可用的行 id。
 *
 * 从 `r<n>` 里取最大编号往后接，并**避开已经占用的**——
 * 自定义到一半又换回预设时，行 id 会重新变成 r1~r7，
 * 直接 `r8` 下去没错，但「删了中间几档再加」就有可能撞上。
 */
export function nextRowId(rows) {
  const used = new Set((Array.isArray(rows) ? rows : []).map((r) => String(r?.id ?? '')));
  let max = 0;
  for (const id of used) {
    const m = /^r(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  let n = max + 1;
  while (used.has(`r${n}`)) n += 1;
  return `r${n}`;
}

/**
 * 加一档。`afterId` 给了就插在它后面，否则挂到最后。
 *
 * @returns {{ rows: object[], added: object|null }} 到上限时 `added` 为 null、rows 原样返回
 */
export function addRow(rows, { afterId = null, label = '', color = '' } = {}) {
  const list = cloneRows(rows);
  if (list.length >= ROW_LIMITS.max) return { rows: list, added: null };

  const id = nextRowId(list);
  const row = {
    id,
    label: cleanRowLabel(label, `新档 ${list.length + 1}`),
    color: cleanRowColor(color, NEW_ROW_COLORS[list.length % NEW_ROW_COLORS.length]),
  };
  const at = list.findIndex((r) => r.id === String(afterId));
  if (at >= 0) list.splice(at + 1, 0, row);
  else list.push(row);
  return { rows: list, added: row };
}

/**
 * 删一档。
 *
 * ⚠️ 这里**只管行**，图块由 `unassignRow` 接手放回素材池 ——
 * 两件事分开是因为调用方必须**两个都做**：只删行的话，`items` 里指向它的图块
 * 会变成悬空引用（`normalizeTierlist` 读盘时会把它们丢掉，等于静默删数据）。
 *
 * @returns {{ rows: object[], removed: object|null }} 到下限时 `removed` 为 null
 */
export function removeRow(rows, rowId) {
  const list = cloneRows(rows);
  if (list.length <= ROW_LIMITS.min) return { rows: list, removed: null };
  const at = list.findIndex((r) => r.id === String(rowId));
  if (at < 0) return { rows: list, removed: null };
  const [removed] = list.splice(at, 1);
  return { rows: list, removed };
}

/** 改档位名 */
export function setRowLabel(rows, rowId, label) {
  const want = String(rowId);
  return cloneRows(rows).map((r) => (r.id === want ? { ...r, label: cleanRowLabel(label, r.label) } : r));
}

/** 改档位颜色 */
export function setRowColor(rows, rowId, color) {
  const want = String(rowId);
  return cloneRows(rows).map((r) => (r.id === want ? { ...r, color: cleanRowColor(color, r.color) } : r));
}

/**
 * 把某一档里的图块全放回素材池。
 *
 * 做法是把它们从 `items` 里**摘掉** —— 素材池显示的是「不在 items 里的条目」，
 * 摘掉就等于回去了。注意这不是「删图块」：用户点的是「删这一档」，
 * 顺带把他排好的十几部番一起删掉，是这个界面能做的最糟的事。
 */
export function unassignRow(items, rowId) {
  const want = String(rowId);
  return (Array.isArray(items) ? items : []).filter((it) => String(it?.rowId) !== want);
}

/**
 * Chromium canvas 的硬上限（实测，不是估的）：
 * 单边 16384 像素、面积约 2.68 亿像素。超了 `toBlob()` 直接返回空图。
 */
export const CANVAS_LIMITS = { maxSide: 16384, maxPixels: 268435456 };

/** 导出布局的默认值（1x 单位，scale 另乘） */
export const EXPORT_DEFAULTS = {
  width: 1200,
  padding: 24,
  labelWidth: 96,
  gap: 8,
  rowGap: 10,
};

// ===================== 结构 =====================

/** 复制一份档位定义，避免多份 tierlist 共享同一个数组被改花 */
function cloneRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((r) => ({ ...r }));
}

/**
 * 认一个 itemSize 名字，认不出给海报。
 *
 * 用 `?.id === name` 而不是直接查表：`ITEM_SIZES['toString']` 也是真值
 * （Object 原型上的东西），脏状态里混进这种字符串会被当成合法尺寸。
 */
function tileOf(itemSize) {
  const t = ITEM_SIZES[String(itemSize ?? '')];
  return t && t.id === itemSize ? t : ITEM_SIZES.poster;
}

/** 造一份新的 tierlist。季度 key 只是记账用，不参与结构 */
export function makeDefaultTierlist(seasonKey, { presetId = 'top-drug', templateId = 'anime-season', nowMs = Date.now() } = {}) {
  const preset = PRESET_ROW_GROUPS.find((p) => p.id === presetId) ?? PRESET_ROW_GROUPS[0];
  return {
    templateId,
    seasonKey: seasonKey ?? null,
    presetId: preset.id,
    rows: cloneRows(preset.rows),
    items: [],
    itemSize: 'poster',
    updatedAt: nowMs,
  };
}

/**
 * 把读回来的对象修正成能用的结构。
 *
 * 状态文件是手写进磁盘的，可能被旧版写过、被手改过、被写坏 ——
 * 界面层不该为这些情况兜底，读的时候就该修干净。
 * 修不了的（rows 全没了）就退回默认档位，但**不丢 items**。
 */
export function normalizeTierlist(raw, { seasonKey = null, nowMs = Date.now() } = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const rows = Array.isArray(src.rows) && src.rows.length
    ? src.rows
        .filter((r) => r && r.id)
        .map((r, i) => ({
          id: String(r.id),
          // 读盘时也过一遍 cleanRowLabel / cleanRowColor：写出去的已经洗过了，
          // 但存档是能被手改的，而「多长算长」这个规矩只该有一处定义。
          label: cleanRowLabel(r.label, `档位 ${i + 1}`),
          color: cleanRowColor(r.color),
        }))
    : cloneRows(DEFAULT_ROWS);

  const rowIds = new Set(rows.map((r) => r.id));
  const seen = new Set();
  const items = (Array.isArray(src.items) ? src.items : [])
    .filter((it) => it && it.key != null)
    // 指向不存在的档位的图块要丢掉 —— 留着会在渲染时变成「找不到行」的幽灵
    .filter((it) => rowIds.has(String(it.rowId)))
    // 同一个 key 出现两次会让拖拽算出两个落点
    .filter((it) => {
      const k = String(it.key);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((it) => {
      const out = { key: String(it.key), rowId: String(it.rowId) };
      if (it.label) out.label = String(it.label);
      return out;
    });

  return {
    templateId: src.templateId ?? 'anime-season',
    seasonKey: src.seasonKey ?? seasonKey,
    presetId: src.presetId ?? null,
    rows,
    items,
    itemSize: tileOf(src.itemSize).id,
    updatedAt: Number.isFinite(src.updatedAt) ? src.updatedAt : nowMs,
  };
}

/**
 * 整个「季度 → 档位表」映射的归一化。
 *
 * 和 report.js 的 `normalizeReports` 是一对：导入备份、读盘都用它 ——
 * 备份文件是能被手改的，而一份脏的 tierlists 会带着悬空的 rowId 进 state，
 * 到界面那一步才炸（渲染时按 rowId 过滤，什么也不显示，看着像「排的东西丢了」）。
 */
export function normalizeTierlists(raw, { nowMs = Date.now() } = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [key, value] of Object.entries(src)) {
    const k = String(key ?? '').trim();
    if (!k) continue;
    out[k] = normalizeTierlist(value, { seasonKey: k, nowMs });
  }
  return out;
}

// ===================== 查询 =====================
/** 某一档里的图块，按数组顺序 */
export function itemsOfRow(items, rowId) {
  const want = String(rowId);
  return (Array.isArray(items) ? items : []).filter((it) => String(it.rowId) === want);
}

/** 图块在哪一档；不在任何档（还在素材池）返回 null */
export function rowOf(items, key) {
  const want = String(key);
  const hit = (Array.isArray(items) ? items : []).find((it) => String(it.key) === want);
  return hit ? String(hit.rowId) : null;
}

/** 每档各有多少个图块，按 rows 顺序返回 */
export function rowStats(items, rows) {
  const list = Array.isArray(items) ? items : [];
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    rowId: r.id,
    count: itemsOfRow(list, r.id).length,
  }));
}

/** 素材池里「还没被排进去」的条目 */
export function poolKeys(pool, items) {
  const placed = new Set((Array.isArray(items) ? items : []).map((it) => String(it.key)));
  return (Array.isArray(pool) ? pool : [])
    .filter((a) => a && a.id != null && !placed.has(String(a.id)))
    .map((a) => String(a.id));
}

// ===================== 拖拽 =====================

/**
 * 由落点坐标算出「插到哪一档的第几个」。
 *
 * 行判定：y 落在某行的矩形内就算命中；行与行之间那点缝也算最近的那一档
 * （缝只有几个像素，让人精确瞄准是不现实的），完全在表外就取最近的一行。
 *
 * 列判定：图块按 `itemW` 宽、`gap` 间隔排开，落在图块**左半边**插到它前面，
 * **右半边**插到它后面 —— 用 round 而不是 floor，否则永远只能插到前面。
 *
 * @param {{x:number,y:number}} point 落点（与 rowRects 同一坐标系）
 * @param {Array<{rowId:string,left:number,top:number,width:number,height:number,count:number}>} rowRects
 * @returns {{rowId:string,index:number,rowIndex:number}|null}
 */
export function insertIndexAt({ x, y, rowRects = [], itemW = ITEM_SIZES.poster.w, itemH = ITEM_SIZES.poster.h, gap = 8 } = {}) {
  const rows = (Array.isArray(rowRects) ? rowRects : []).filter(
    (r) => r && Number.isFinite(r.top) && Number.isFinite(r.height),
  );
  if (!rows.length) return null;

  const tolerance = Math.max(0, Number(gap) || 0) / 2;
  let target = rows.find((r) => y >= r.top - tolerance && y <= r.top + r.height + tolerance);

  if (!target) {
    // 落在表外（上方或下方）：取纵向距离最近的一行
    const distance = (r) => (y < r.top ? r.top - y : y - (r.top + r.height));
    target = rows.reduce((best, r) => (distance(r) < distance(best) ? r : best));
  }

  // 守卫：itemW + gap 为 0 会算出 Infinity / NaN，往下怎么 clamp 都是脏值
  const step = Math.max(1, (Number(itemW) || 0) + (Number(gap) || 0));
  const raw = Math.round(((Number(x) || 0) - (Number(target.left) || 0)) / step);
  const count = Number(target.count) || 0;
  const index = Math.min(count, Math.max(0, raw));

  return { rowId: String(target.rowId), index, rowIndex: rows.indexOf(target) };
}

/**
 * 执行移动，返回新的 items 数组（不改原数组）。
 *
 * @param {Array<{key:string,rowId:string}>} items
 * @param {{key:string, toRow?:string|null, index?:number, label?:string}} move
 *   `toRow` 为 null/undefined 表示**移回素材池**。
 *   `index` 是移走之后的档内位置（见文件头说明）。
 * @returns {Array} 新数组；找不到 key 且给了 toRow 时，会新建一条
 */
export function moveItem(items, { key, toRow = null, index = Infinity, label } = {}) {
  const list = Array.isArray(items) ? items : [];
  const want = String(key);

  const existing = list.find((it) => String(it.key) === want);
  const rest = list.filter((it) => String(it.key) !== want);

  // 移回素材池 = 从数组里摘掉，不留下任何痕迹
  if (toRow == null || toRow === '') return rest;

  const target = String(toRow);
  // 已有的自定义名字跟着一起搬走；只有显式传 label 才覆盖
  const moved = existing ? { ...existing, rowId: target } : { key: want, rowId: target };
  if (label != null) moved.label = String(label);

  // 目标档里现有的位置（下标是 rest 里的绝对下标）
  const slots = [];
  for (let i = 0; i < rest.length; i += 1) {
    if (String(rest[i].rowId) === target) slots.push(i);
  }

  const want0 = Number.isFinite(index) ? Math.max(0, Math.trunc(index)) : slots.length;
  let at;
  if (want0 >= slots.length) {
    // 插到该档最后一个之后；这一档还是空的就挂到数组末尾
    at = slots.length ? slots[slots.length - 1] + 1 : rest.length;
  } else {
    at = slots[want0];
  }

  const out = rest.slice();
  out.splice(at, 0, moved);
  return out;
}

/** 移回素材池。`moveItem(..., { toRow: null })` 的简写 */
export function removeItem(items, key) {
  const want = String(key);
  return (Array.isArray(items) ? items : []).filter((it) => String(it.key) !== want);
}

// ===================== 自动分档 =====================

/**
 * 按 Bangumi 评分铺进各档。
 *
 * 三条刻意的取舍：
 *   1. **没有评分的不排**。新番刚开播时 `score` 常常是 null，硬塞进最后一档
 *      等于替用户做了个没依据的判断 —— 留在素材池让他自己拖才是对的。
 *   2. **不动非番剧图块**（`local:` 前缀等自定义项）。它们不在 pool 里，
 *      自动分档没有依据重排它们，保留原位置。
 *   3. 同档内按评分降序，评分相同按 key 升序 —— 保证结果稳定，
 *      连点两次按钮不会排出两个顺序。
 *
 * @param {Array} items 现有图块
 * @param {Array<{id:number|string, score?:number}>} pool 当前季度的素材
 * @param {Array<{id:string}>} rows 档位定义（顺序即高低）
 * @returns {{items:Array, ranked:string[], unranked:string[]}}
 */
export function autoRankByScore(items, pool, rows, { thresholds = SCORE_THRESHOLDS } = {}) {
  const rowList = Array.isArray(rows) && rows.length ? rows : DEFAULT_ROWS;
  const cuts = (Array.isArray(thresholds) && thresholds.length ? thresholds : SCORE_THRESHOLDS).slice(0, rowList.length - 1);
  const lastRow = rowList[rowList.length - 1].id;

  const rowIdFor = (score) => {
    for (let i = 0; i < cuts.length; i += 1) {
      if (score >= cuts[i]) return rowList[i].id;
    }
    return lastRow;
  };

  const poolIds = new Set(
    (Array.isArray(pool) ? pool : []).filter((a) => a && a.id != null).map((a) => String(a.id)),
  );

  // 非番剧图块原样保留在最前面，番剧按档位重新铺
  const keep = (Array.isArray(items) ? items : []).filter((it) => !poolIds.has(String(it.key)));

  const ranked = [];
  const unranked = [];
  const buckets = new Map();

  for (const a of Array.isArray(pool) ? pool : []) {
    if (!a || a.id == null) continue;
    const key = String(a.id);
    const score = Number(a.score);
    if (!Number.isFinite(score) || score <= 0) {
      unranked.push(key);
      continue;
    }
    const rowId = rowIdFor(score);
    if (!buckets.has(rowId)) buckets.set(rowId, []);
    buckets.get(rowId).push({ key, score });
    ranked.push(key);
  }

  // 档位顺序走 rows 定义的顺序，保证输出的数组顺序与界面上下一致
  const out = keep.slice();
  for (const row of rowList) {
    const bucket = buckets.get(row.id) ?? [];
    bucket.sort((x, y) => (y.score - x.score) || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
    for (const it of bucket) out.push({ key: it.key, rowId: row.id });
  }

  return { items: out, ranked, unranked };
}

// ===================== 导出几何 =====================

/** 是否超出 canvas 硬上限 */
export function fitsLimits(w, h, limits = CANVAS_LIMITS) {
  const width = Number(w) || 0;
  const height = Number(h) || 0;
  const L = limits ?? CANVAS_LIMITS;
  if (width <= 0 || height <= 0) return false;
  if (width > L.maxSide || height > L.maxSide) return false;
  return width * height <= L.maxPixels;
}

/**
 * 导出画布的排布计算。
 *
 * 所有输入都是 **1x 单位**，输出的坐标再统一乘 `scale` ——
 * 这样 1x 和 2x 排出来的版面结构完全一致，只是精细度不同。
 *
 * 一档之内图块会**换行**（按 1x 宽算每行能放几个），而不是无限往右延伸：
 * 82 部番全塞一行的话，画布宽度在 2x 下会撞上 16384 那条线。
 *
 * @returns {{scale:number,width:number,height:number,tileW:number,tileH:number,perLine:number,
 *            overflow:boolean,pixels:number,rows:Array}}
 */
export function measureLayout(rows, items, opts = {}) {
  const {
    scale = 2,
    width = EXPORT_DEFAULTS.width,
    padding = EXPORT_DEFAULTS.padding,
    labelWidth = EXPORT_DEFAULTS.labelWidth,
    gap = EXPORT_DEFAULTS.gap,
    rowGap = EXPORT_DEFAULTS.rowGap,
    itemSize = 'poster',
    header = 0,   // 顶部标题区高度（1x 单位）；为 0 就是没有标题
    limits = CANVAS_LIMITS,
  } = opts;

  const tile = tileOf(itemSize);
  const rowList = Array.isArray(rows) ? rows : [];
  const list = Array.isArray(items) ? items : [];

  const contentW = Math.max(tile.w, width - padding * 2 - labelWidth - gap);
  const step = tile.w + gap;
  const perLine = Math.max(1, Math.floor((contentW + gap) / step));

  const headerH = Math.max(0, Number(header) || 0);
  let y = padding + (headerH ? headerH + rowGap : 0);
  const outRows = [];

  for (const row of rowList) {
    const rowItems = itemsOfRow(list, row.id);
    const lines = Math.max(1, Math.ceil(rowItems.length / perLine));
    const height = lines * tile.h + (lines - 1) * gap;

    const placed = rowItems.map((it, i) => {
      const line = Math.floor(i / perLine);
      const col = i % perLine;
      return {
        key: String(it.key),
        x: Math.round((padding + labelWidth + gap + col * step) * scale),
        y: Math.round((y + line * (tile.h + gap)) * scale),
        w: Math.round(tile.w * scale),
        h: Math.round(tile.h * scale),
      };
    });

    outRows.push({
      rowId: row.id,
      label: row.label ?? '',
      color: row.color ?? '#9aa0a6',
      left: Math.round(padding * scale),
      top: Math.round(y * scale),
      width: Math.round((width - padding * 2) * scale),
      height: Math.round(height * scale),
      lines,
      items: placed,
    });

    y += height + rowGap;
  }

  const width1x = Math.max(1, width);
  // y 已经从 header 下面开始算了，这里不能再加一遍 header
  const height1x = Math.max(padding * 2, y - rowGap + padding);
  const outW = Math.round(width1x * scale);
  const outH = Math.round(height1x * scale);

  return {
    scale,
    headerHeight: Math.round(headerH * scale),
    width: outW,
    height: outH,
    tileW: Math.round(tile.w * scale),
    tileH: Math.round(tile.h * scale),
    perLine,
    rows: outRows,
    overflow: !fitsLimits(outW, outH, limits),
    pixels: outW * outH,
  };
}

/**
 * 挑一个能出图的放大倍数。
 *
 * 「点了导出，什么都没弹出来」是最难查的一类 bug ——
 * canvas 超限时 `toBlob()` 不抛错，只是给你一张空的。
 * 所以这里**显式**往下退，并把退的原因一路带回界面。
 *
 * @returns {{scale:number,width:number,height:number,pixels:number,degraded:boolean,reason:string|null}}
 */
export function pickScale(rows, items, opts = {}) {
  const candidates = Array.isArray(opts.candidates) && opts.candidates.length
    ? opts.candidates
    : [2, 1];
  const sorted = [...candidates].sort((a, b) => b - a);

  let best = null;
  for (const scale of sorted) {
    const layout = measureLayout(rows, items, { ...opts, scale });
    if (!layout.overflow) return { scale, width: layout.width, height: layout.height, pixels: layout.pixels, degraded: scale !== sorted[0], reason: scale === sorted[0] ? null : `画布超出上限，已降到 ${scale}x` };
    best = { scale, width: layout.width, height: layout.height, pixels: layout.pixels };
  }

  return {
    ...best,
    degraded: true,
    reason: `即使 ${best.scale}x 也超出 canvas 上限（单边 16384 像素 / 2.68 亿像素），请减少图块数量`,
  };
}

/**
 * 把一个图块画进 canvas 时的源矩形。
 *
 * 只是把 `covers.js` 的 coverCrop 按「目标图块尺寸」包了一层 ——
 * 几何本身已经在那边被测试守住了，这里不重复实现一份。
 */
export function tileCrop(srcW, srcH, itemSize = 'poster', scale = 1) {
  const tile = tileOf(itemSize);
  return coverCrop({ srcW, srcH, dstW: tile.w * scale, dstH: tile.h * scale });
}
