/**
 * 长门番堂（yuc.wiki）季度页解析。
 *
 * 这个站没有 API，季度页是 Hexo 生成的静态 HTML：
 *
 *   https://yuc.wiki/202610/     ← 2026 年 10 月档（秋）
 *
 * 一个页面同时装了三样东西，正好是 Bangumi 那边没有的：
 *   ① 排播区：八组（周一~周日 + 「网络放送 & 其他」），每条带**放送时刻**（`21:00~`）
 *      和**首播日期**（`10/5~`）；
 *   ② 介绍区：每部的原名 / 类型 / 题材标签 / 制作 / 声优 / 官网·PV / 首播；
 *   ③ 收录统计：本期共几部、各类改编各几部。
 *
 * ⚠️ 这一层是**纯函数**，不发请求、不碰磁盘。抓回来的 HTML 交给 `parseYucPage`，
 * 结果交给缓存层。分开的理由很实际：解析规则会因为对方改版而失效，
 * 那时候必须能拿一段真实 HTML 在单测里复现，而不是「打开软件看一眼」。
 *
 * ⚠️ 解析规则依赖 class 名（`date2` / `div_date` / `date_title_` / `title_cn_r` …），
 * 这些是站点生成器写死的，比 DOM 结构稳（外层 div 套了几层没有意义）。
 * 但**任何一步对不上都要如实返回「解析不到」，不能猜** ——
 * 猜出来的结果是「看着有内容、其实字段是错的」，比空着难查得多。
 */

/** 八组的稳定 key —— 用的是星期序号，不是中文字，免得以后改文案就把缓存全作废 */
const WEEKDAY_KEY = { 一: 'mon', 二: 'tue', 三: 'wed', 四: 'thu', 五: 'fri', 六: 'sat', 日: 'sun' };

/** 排播区分组的标题单元格 */
const GROUP_HEAD = /<td class="date2">([\s\S]*?)<\/td>/g;

/** 一条排播记录的外层起点。周一到周日与网络放送都用 float:left 排放 */
const ENTRY_SPLIT = /(?=<div\s+style="float:\s*left"\s*>)/;

/*
 * 介绍区每条记录的起点。
 *
 * ⚠️ **不要用 `<!--#A01-->` 那种序号注释当锚点**：实测那一季 69 部作品里
 * 只有 7 个带这个注释（生成器只给部分条目加），拿它切就只能解析出 7 条，
 * 而症状是「每一条都对不上介绍区」—— 看着像标题匹配算法不行，
 * 其实是压根没读到介绍区。表宽 500px 是介绍表格的固定样式，69 部 = 69 张，对得上。
 */
const INTRO_TABLE = /<table[^>]*width="500px"[^>]*>/gi;

/** 介绍区封面（180px）就在表格前面几个字符处，往回找这一段 */
const INTRO_COVER_LOOKBACK = 400;

/** 季度键 → 番堂的页面键。'2026q4' → '202610' */
const QUARTER_MONTH = { 1: '01', 2: '04', 3: '07', 4: '10' };

const TAG_RE = /<[^>]*>/g;

/**
 * 季度键 ↔ 番堂页面键的换算。
 *
 * 两边对「季」的理解是一样的（1/4/7/10 月开播），只是写法不同，
 * 所以这里不需要任何查表，直接换月份即可。
 */
export function yucPageKey(seasonKey) {
  const m = /^(\d{4})q([1-4])$/.exec(String(seasonKey ?? '').trim());
  if (!m) return null;
  return `${m[1]}${QUARTER_MONTH[Number(m[2])]}`;
}

export function yucPageUrl(seasonKey) {
  const key = yucPageKey(seasonKey);
  return key ? `https://yuc.wiki/${key}/` : null;
}

/** 反向：'202610' → '2026q4'。给「点了番堂的条目、想跳回本季番剧」用 */
export function seasonKeyOfYucPage(pageKey) {
  const m = /^(\d{4})(01|04|07|10)$/.exec(String(pageKey ?? '').trim());
  if (!m) return null;
  const q = { '01': 1, '04': 2, '07': 3, '10': 4 }[m[2]];
  return `${m[1]}q${q}`;
}

/* ---------- 文本处理 ---------- */

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    // `&amp;` 必须放最后：放前面的话 `&amp;lt;` 会被解两次成 `<`，
    // 而它本来的意思就是一个字面的 `&lt;` 文本
    .replace(/&amp;/gi, '&');
}

/** 去标签 + 解实体 + 收空白。`<br>` 当成硬换行的地方要先自己处理掉 */
function plain(html) {
  return decodeEntities(String(html ?? '').replace(TAG_RE, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 标题专用：先按 `<br>` 拆行，再判断哪几行是中文名。
 *
 * ⚠️ 页面上同一个 `<br>` 有两种含义，**必须分开处理**：
 *   ① 中文名 + 原名分两行（`顶点武装<br>VERTEX FORCE`）—— 中文只在前一行；
 *   ② 一个长名字为了排版断开（`赛博朋克<br>边缘行者2`）—— 两行都是中文名。
 * 一律用空格接起来的话，第一种会变成「顶点武装 VERTEX FORCE」，
 * 而且**用它去和介绍区的 `title_cn_r` 比对永远对不上** —— 症状是标签、声优、链接全空。
 *
 * 判据：这一行里有没有汉字。整行都是假名/拉丁字母的，就是在写原名。
 */
export function splitTitle(html) {
  const lines = String(html ?? '')
    .split(/<br\s*\/?>/i)
    .map((l) => decodeEntities(l.replace(TAG_RE, '')).replace(/[\s\u3000]+/g, ' ').trim())
    .filter(Boolean);

  const hasCjk = (s) => /[\u3400-\u4dbf\u4e00-\u9fff]/.test(s);
  const cjk = lines.filter(hasCjk);
  const ja = lines.filter((l) => !hasCjk(l));

  return {
    lines,
    titleZh: (cjk.length ? cjk : lines).join(''),
    titleJa: ja.join(' '),
    // 匹配用的候选：中文名 / 首行 / 全行。三条都试一遍，
    // 因为不同条目的 <br> 用法不一样，判错了也只该少省一步、不该整条对不上。
    keys: [...new Set([
      normTitle((cjk.length ? cjk : lines).join('')),
      normTitle(lines[0] ?? ''),
      normTitle(lines.join('')),
    ].filter(Boolean))],
  };
}

/** 匹配用的归一化：去掉所有空白与常见标点，全角括号统一成半角 */
export function normTitle(s) {
  return String(s ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[《》〈〉「」『』【】()（）[\]·・:：!！?？~～\-—–_、,，.。'"“”‘’]/g, '')
    .toLowerCase();
}

/** 条目的稳定 id：标题哈希。跨刷新不变，也不会和 Bangumi 的数字 id 撞（前缀 `y`） */
export function yucItemId(title) {
  const s = normTitle(title);
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `y${(h >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * 抓某个 class 的单元格 / 段落内容；抓不到给 null（不是空串 —— 两者含义不同）。
 *
 * ⚠️ 这个函数**只适合内容里不再套同类标签的格子**（`title_cn_r`、`broadcast_r` 那类）。
 * 像 `link_a_r` 这种里面套着 `<a>…</a>` 的，惰性匹配会停在**第一个 `</a>`**，
 * 于是返回的是一段被截断的 HTML —— 症状是「链接一个都没抓到」，
 * 而看起来像选择器写错了。要整块的用 `regionOf`。
 *
 * ⚠️ 认这一类格子时**必须允许数字后缀**。介绍区里同一个位置的类名会带
 * `1`/`2`/`3`/`4` 的尾巴（`title_cn_r1`、`title_jp_r2`、`staff_r1`…），
 * 而且**不是所有条目都带** —— 只按 `title_cn_r` 找的话，69 部里只能解析出 46 部，
 * 剩下 23 部的标签、声优、官网会整片空着，看着像「那一季就这些没资料」。
 */
function pickVariant(html, bases) {
  for (const base of Array.isArray(bases) ? bases : [bases]) {
    const re = new RegExp(`<[a-z]+[^>]*class="${base}\\d*"[^>]*>([\\s\\S]*?)</[a-z]+>`, 'i');
    const m = re.exec(html);
    if (m) return m[1];
  }
  return null;
}

function pickVariantText(html, bases) {
  const raw = pickVariant(html, bases);
  return raw == null ? null : plain(raw);
}

/** 改编类型那一格按类别换字母（`type_a_r`…`type_e_r`），逐个试 */
const TYPE_CLASSES = ['type_a_r', 'type_b_r', 'type_c_r', 'type_d_r', 'type_e_r'];
const STAFF_CLASSES = ['staff_r', 'staff_r1', 'staff_r2'];
const TAG_CLASSES = ['type_tag_r', 'type_tag_r1'];

/**
 * 从某个 class 的那个标签**开头一直取到片段末尾**，不试着找「配对的收尾标签」。
 *
 * 之所以不做配对：这段 HTML 是标签汤（`<td>` 里塞 `<a>`、`<p>`、`<br>`），
 * 数标签配对比直接用剩余部分更容易出错。调用方本来拿的就是「一条记录的片段」，
 * 取到片段末尾就已经是安全的了。
 */
function regionOf(html, base) {
  const m = new RegExp(`class="${base}\\d*"`, 'i').exec(html);
  if (!m) return null;
  const gt = html.indexOf('>', m.index);
  return gt < 0 ? null : html.slice(gt + 1);
}

/** 抓排播标题格：类名是 `date_title_` 或 `date_title__`，两种都要认 */
function pickTitleCell(html) {
  const m = /<td[^>]*class="date_title__*"[^>]*>([\s\S]*?)<\/td>/i.exec(html);
  return m ? m[1] : null;
}

function attrOf(tag, name) {
  const re = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i');
  const m = re.exec(tag);
  return m ? m[1] : null;
}

/**
 * 模糊相似度：最长公共子序列长度 ÷ 较长者的长度。
 *
 * 为什么要这一步：排播区用简称、介绍区用全名，而且是**真的不一样**，不是写法差异。
 * 实测那一季 4 部如此 —— 例如排播写「和没有信徒的女神一起攻略异世界」，
 * 介绍区写「和没有信徒的女神**大人**一起攻略异世界」。包含关系判断不出来。
 *
 * 用子序列而不是前缀：简称常常是把中间几个字省掉，公共部分不连着。
 */
export function titleSimilarity(a, b) {
  const x = normTitle(a);
  const y = normTitle(b);
  if (!x || !y) return 0;
  const prev = new Array(y.length + 1).fill(0);
  const cur = new Array(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i += 1) {
    for (let j = 1; j <= y.length; j += 1) {
      cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev.splice(0, y.length + 1, ...cur);
  }
  return prev[y.length] / Math.max(x.length, y.length);
}

/** 标题里的数字串，用来挡住「第 2 期」和「第 3 期」被模糊匹配粘到一起 */
function digitsOf(s) {
  return (normTitle(s).match(/\d+/g) ?? []).join(',');
}

/**
 * 模糊匹配的两条闸门。
 *
 * 阈值 0.75 是拿真实数据试出来的：上面那三条真匹配落在 0.88~0.94，
 * 而「第2期 / 第3期」这种只差一个字的**假**匹配也能到 0.9 ——
 * 光看相似度拦不住，所以要再要求两边的数字串完全一致。
 * 宁可少合一条（那条只是少几个字段，照样显示），也不要合错
 * （合错之后声优、制作、官网全是别人家的，而且看不出来）。
 */
export const FUZZY_MIN_RATIO = 0.75;
export const FUZZY_MIN_LEN = 8;

export function fuzzyOk(scheduleTitle, introTitle) {
  const x = normTitle(scheduleTitle);
  const y = normTitle(introTitle);
  if (x.length < FUZZY_MIN_LEN || y.length < FUZZY_MIN_LEN) return false;
  if (digitsOf(x) !== digitsOf(y)) return false;
  return titleSimilarity(x, y) >= FUZZY_MIN_RATIO;
}

/* ---------- 排播区 ---------- */

function groupKeyOf(label) {
  const m = /^周([一二三四五六日])/.exec(label);
  if (m) return WEEKDAY_KEY[m[1]];
  if (label.includes('网络')) return 'net';
  // 认不出的分组照样保留 —— 用标签本身当 key，至少不会丢
  return `g-${normTitle(label).slice(0, 12) || 'other'}`;
}

/** 「10/5~」→ 10 月 5 日；顺带把「10/3周六深夜」这类也认下来（时刻是「深夜」） */
export function parseYucDate(text) {
  const s = plain(text);
  const m = /^(\d{1,2})\/(\d{1,2})/.exec(s);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
  const tail = s.slice(m[0].length);
  return { month, day, label: s, note: tail.replace(/^[~～\s]+/, '').trim() };
}

function parseEntry(chunk, group) {
  const dateBlock = /<div class="div_date_?">([\s\S]*?)<\/div>/i.exec(chunk);
  const scope = dateBlock ? dateBlock[1] : chunk;

  const title = splitTitle(pickTitleCell(scope) ?? pickTitleCell(chunk) ?? '');
  if (!title.titleZh) return null;

  const imgTag = /<img[^>]*>/i.exec(scope);
  const cover = imgTag ? (attrOf(imgTag[0], 'data-src') ?? attrOf(imgTag[0], 'src')) : null;

  // 网络放送那几条没有 `imgtext4`，日期写在 `pmfs`/`pmfs2` 里
  const time = pickVariantText(scope, 'imgtext4') ?? '';
  const startRaw = pickVariantText(scope, 'imgep2')
    ?? pickVariantText(chunk, 'pmfs2')
    ?? pickVariantText(chunk, 'pmfs')
    ?? '';
  const episodes = pickVariantText(chunk, 'pmex') ?? pickVariantText(chunk, 'paomian') ?? '';
  const area = pickVariantText(chunk, 'area') ?? '';

  const aTag = /<a\s[^>]*href="([^"]+)"[^>]*>/i.exec(regionOf(chunk, 'tr_area') ?? '');
  const site = aTag ? decodeEntities(aTag[1]) : null;

  return {
    id: yucItemId(title.titleZh),
    titleZh: title.titleZh,
    titleKeys: title.keys,
    cover: cover ? decodeEntities(cover) : null,
    time,
    startDate: startRaw,
    start: parseYucDate(startRaw),
    episodes: episodes ? plain(episodes) : '',
    area,
    site: site && !/^#/.test(site) ? site : null,
    groupKey: group.key,
    groupLabel: group.label,
  };
}

/* ---------- 介绍区 ---------- */

/** 制作名单：`导演：高村和宏` / 续行 `　　　　　铃木雅词`（没有冒号，接上一条的职位） */
export function parseStaff(html) {
  const lines = String(html ?? '')
    .split(/<br\s*\/?>/i)
    .map((l) => plain(l))
    .filter(Boolean);
  const out = [];
  for (const line of lines) {
    const i = line.search(/[:：]/);
    if (i > 0) {
      out.push({ role: line.slice(0, i).trim(), people: [line.slice(i + 1).trim()].filter(Boolean) });
    } else if (out.length) {
      out[out.length - 1].people.push(line);
    } else {
      out.push({ role: '', people: [line] });
    }
  }
  return out;
}

/** 声优表：一行里可能并排写好几个，靠全角空格分隔 */
export function parseCast(html) {
  return String(html ?? '')
    .split(/<br\s*\/?>/i)
    .map((l) => plain(l))
    .join('\u3000')
    .split(/[\s\u3000]+/)
    .map((s) => s.trim())
    .filter((s) => s && s !== '　');
}

function parseIntroEntry(chunk, cover) {
  // 介绍区的中文名是单独一格，不掺原名，所以不需要拆行
  const titleZh = plain(pickVariant(chunk, 'title_cn_r') ?? '');
  if (!titleZh) return null;

  /*
   * 先把注释整段删掉再找链接。
   *
   * 页面上没填的格子是 `<!--platform-->` 这样的注释占位，
   * 不删的话「链接」会把注释里的死链也算进去 —— 那种链接点开是空白页，
   * 而界面上看起来一切正常。
   */
  const linkBlock = String(regionOf(chunk, 'link_a_r') ?? '').replace(/<!--[\s\S]*?-->/g, '');

  const links = [];
  const seen = new Set();
  for (const m of linkBlock.matchAll(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = decodeEntities(m[1]);
    const label = plain(m[2]);
    // 同一部作品的官网/PV/平台可能在不同格子里重复出现，按地址去重
    if (!url || seen.has(url) || /^#/.test(url) || /^javascript:/i.test(url)) continue;
    seen.add(url);
    links.push({ label: label || url, url });
  }

  const tagText = pickVariantText(chunk, TAG_CLASSES) ?? '';
  const tags = tagText ? tagText.split(/[\/、,，]/).map((s) => s.trim()).filter(Boolean) : [];

  const ex = pickVariantText(chunk, 'broadcast_ex_r') ?? '';

  return {
    id: yucItemId(titleZh),
    titleZh,
    titleJa: plain(pickVariant(chunk, 'title_jp_r') ?? '') || '',
    kind: pickVariantText(chunk, TYPE_CLASSES) ?? '',
    tags,
    staff: parseStaff(pickVariant(chunk, STAFF_CLASSES) ?? ''),
    cast: parseCast(pickVariant(chunk, 'cast_r') ?? ''),
    links,
    broadcast: pickVariantText(chunk, 'broadcast_r') ?? '',
    broadcastNote: ex,
    cover,
  };
}

/** 收录统计段落：`本期 <b>秋季档</b> 共收录 <u>69</u> 部` + `原创动画×7 …` */
export function parseIntroSummary(html) {
  const block = /<p class="intro">([\s\S]*?)<\/p>/i.exec(String(html ?? ''));
  if (!block) return { seasonName: '', total: null, breakdown: [] };

  const body = block[1];
  const totalM = /<u>\s*(\d+)\s*<\/u>/.exec(body);
  const nameM = /<b>\s*([^<]+?)\s*<\/b>/.exec(body);

  const breakdown = [];
  for (const m of body.matchAll(/<font[^>]*>([^<]+)<\/font>\s*[×x]\s*(\d+)/g)) {
    breakdown.push({ label: plain(m[1]), count: Number(m[2]) });
  }

  return {
    seasonName: nameM ? plain(nameM[1]) : '',
    total: totalM ? Number(totalM[1]) : null,
    breakdown,
  };
}

/* ---------- 主入口 ---------- */

/**
 * 把季度页 HTML 解析成结构化数据。
 *
 * @returns {{
 *   ok: boolean, reason?: string,
 *   seasonName: string, total: number|null, breakdown: Array,
 *   groups: Array<{key,label,items:Array}>,
 *   items: Array, unmatched: Array,
 *   stats: { items:number, matched:number, unmatched:number, groups:number },
 * }}
 *   `ok:false` 时 `reason` 说清是哪一步没对上 —— 页面改版与「这一季还没排」是两件事，
 *   界面要能分开说（前者提示更新，后者什么都不用说）。
 */
export function parseYucPage(html) {
  const raw = String(html ?? '');
  const summary = parseIntroSummary(raw);
  const empty = (reason) => ({
    ok: false,
    reason,
    seasonName: summary.seasonName,
    total: summary.total,
    breakdown: summary.breakdown,
    groups: [],
    items: [],
    unmatched: [],
    stats: { items: 0, matched: 0, unmatched: 0, groups: 0 },
  });

  if (!raw.trim()) return empty('页面是空的');

  // ---------- 介绍区（先建索引，排播区要拿它补字段）----------
  const introTables = [...raw.matchAll(INTRO_TABLE)];
  const intro = [];
  for (let i = 0; i < introTables.length; i += 1) {
    const from = introTables[i].index;
    const to = i + 1 < introTables.length ? introTables[i + 1].index : raw.length;
    // 封面在表格左边，是上一个兄弟节点；往回找最后一张 img
    const before = raw.slice(Math.max(0, from - INTRO_COVER_LOOKBACK), from);
    const imgs = [...before.matchAll(/<img[^>]*>/gi)];
    const last = imgs.length ? imgs[imgs.length - 1][0] : '';
    const cover = last ? (attrOf(last, 'data-src') ?? attrOf(last, 'src')) : null;
    const item = parseIntroEntry(raw.slice(from, to), cover ? decodeEntities(cover) : null);
    if (item) intro.push(item);
  }
  const introByNorm = new Map();
  for (const it of intro) {
    const k = normTitle(it.titleZh);
    if (k && !introByNorm.has(k)) introByNorm.set(k, it);
  }

  // ---------- 排播区 ----------
  const heads = [...raw.matchAll(GROUP_HEAD)];
  if (!heads.length) {
    return empty(
      intro.length
        ? '页面上只有介绍段，没有排播分组（这一季多半还没排）'
        : '页面里既没有排播分组也没有作品介绍 —— 站点结构可能变了',
    );
  }

  const groups = [];
  for (let i = 0; i < heads.length; i += 1) {
    const label = plain(heads[i][1]);
    const from = heads[i].index + heads[i][0].length;
    let to = i + 1 < heads.length ? heads[i + 1].index : raw.length;
    // 最后一组的尾巴会连到介绍区，用 <hr> 切掉
    const hr = raw.indexOf('<hr>', from);
    if (hr >= 0 && hr < to) to = hr;

    const group = { key: groupKeyOf(label), label, items: [] };
    for (const chunk of raw.slice(from, to).split(ENTRY_SPLIT)) {
      const item = parseEntry(chunk, group);
      if (item) group.items.push(item);
    }
    groups.push(group);
  }

  const real = groups.filter((g) => g.items.length);
  if (!real.length) return empty('排播分组都是空的（这一季多半还没排）');

  // ---------- 合并：介绍区补字段 ----------
  const usedIntro = new Set();
  const items = [];
  /*
   * ⚠️ 合并结果**必须同时塞回 `groups[].items`**。
   *
   * 这里踩过一次，症状极隐蔽：`groups` 原本存的是排播区的原始条目（只有时刻、
   * 首播、封面），补上制作/声优/链接的是旁边那个平铺的 `items` 数组。
   * 于是「解析器测试全绿」而**界面拿到手的是同一批没有资料的条目** ——
   * 测试看的是 `items`，界面看的是 `groups`，两边各拿各的。
   * 而且它不报错：详情面板一片空白，看着像「这一季的番堂没填资料」。
   *
   * 现在两个出口是同一份数据：`items` 是平铺的副本，`groups` 是按天分好的同一批对象。
   */
  const mergedByGroup = new Map();
  for (const g of real) mergedByGroup.set(g.key, []);
  for (const g of real) {
    for (const it of g.items) {
      const keys = it.titleKeys?.length ? it.titleKeys : [normTitle(it.titleZh)];
      let extra = null;
      for (const key of keys) {
        extra = introByNorm.get(key);
        if (extra) break;
      }
      /*
       * 对不上时退一步做「包含」匹配。
       *
       * 排播区的标题偶尔会带上架次之类的后缀（`… 2nd&3rd STAGE`），
       * 而介绍区写的是短名字。归一化能解决绝大多数，剩下这一档兜住边角。
       * 阈值取 4 个字：再短的话「第二季」这种前缀会把不同的作品粘到一起。
       */
      if (!extra) {
        for (const key of keys) {
          if (key.length < 4) continue;
          for (const [k, v] of introByNorm) {
            if (usedIntro.has(k)) continue;
            if (k.includes(key) || key.includes(k)) { extra = v; break; }
          }
          if (extra) break;
        }
      }
      // 还不行才上模糊匹配，而且在没被用掉的那几条里挑最像的一条
      if (!extra) {
        let best = null;
        let bestScore = 0;
        for (const [k, v] of introByNorm) {
          if (usedIntro.has(k)) continue;
          if (!fuzzyOk(it.titleZh, v.titleZh)) continue;
          const score = titleSimilarity(it.titleZh, v.titleZh);
          if (score > bestScore) { best = v; bestScore = score; }
        }
        extra = best;
      }
      if (extra) usedIntro.add(normTitle(extra.titleZh));

      const merged = {
        ...it,
        titleJa: extra?.titleJa ?? '',
        kind: extra?.kind ?? '',
        tags: extra?.tags ?? [],
        staff: extra?.staff ?? [],
        cast: extra?.cast ?? [],
        links: extra?.links ?? [],
        broadcast: extra?.broadcast ?? '',
        broadcastNote: extra?.broadcastNote ?? '',
        // 排播区的封面是给 120px 格子用的那一版；介绍区的更清楚，有就优先
        cover: extra?.cover ?? it.cover,
        matched: Boolean(extra),
      };
      items.push(merged);
      mergedByGroup.get(g.key)?.push(merged);
    }
  }

  const unmatched = intro.filter((it) => !usedIntro.has(normTitle(it.titleZh)));

  return {
    ok: true,
    seasonName: summary.seasonName,
    total: summary.total,
    breakdown: summary.breakdown,
    // ⚠️ 是合并过的分组，不是上面那两个 `g`（它们是排播区的原始条目）——
    // 界面只认这一份，两边必须是同一个对象、同一批字段
    groups: real.map((g) => ({ key: g.key, label: g.label, items: mergedByGroup.get(g.key) ?? [] })),
    items,
    unmatched,
    stats: {
      items: items.length,
      matched: items.filter((i) => i.matched).length,
      unmatched: unmatched.length,
      groups: real.length,
    },
  };
}

/**
 * 把解析结果压成能落盘的形状。
 *
 * 不落 HTML：一页 160KB，而结构化的只有几十 KB，而且**下次打开时不该再解析一遍** ——
 * 站点改版时旧缓存还得能读，所以存的是解析结果，不是原文。
 */
export function slimYuc(result) {
  if (!result?.ok) return null;
  return {
    savedAt: Date.now(),
    seasonName: result.seasonName,
    total: result.total,
    breakdown: result.breakdown,
    stats: result.stats,
    groups: result.groups.map((g) => ({
      key: g.key,
      label: g.label,
      items: g.items.map((it) => ({
        id: it.id,
        titleZh: it.titleZh,
        titleJa: it.titleJa ?? '',
        cover: it.cover ?? null,
        time: it.time ?? '',
        startDate: it.startDate ?? '',
        start: it.start ?? null,
        episodes: it.episodes ?? '',
        area: it.area ?? '',
        site: it.site ?? null,
        groupKey: it.groupKey,
        groupLabel: it.groupLabel,
        kind: it.kind ?? '',
        tags: it.tags ?? [],
        staff: it.staff ?? [],
        cast: it.cast ?? [],
        links: it.links ?? [],
        broadcast: it.broadcast ?? '',
        broadcastNote: it.broadcastNote ?? '',
        matched: Boolean(it.matched),
      })),
    })),
  };
}

/* ---------- 与自己的库对表 ---------- */

/**
 * 把番堂的条目和自己的库（本季番剧那批）对起来，返回 `yuc 条目 id -> 库里的条目`。
 *
 * 为什么要做这件事：番堂那份数据本身是**独立**的（没有 bgm id、没有评分），
 * 一个只有时刻表的列表，用户扫过去还是得自己认「这条我追了没」——
 * 而这正好是软件该替他做的那一步。
 *
 * 三段式，和 `parseYucPage` 内部那一套同一个道理（那边是排播区配介绍区）：
 *   ① 归一化后完全相等；
 *   ② 一边包含另一边（≥4 个字，短了会把「第二季」这种前缀粘在一起）；
 *   ③ 模糊相似度（`fuzzyOk` + 取最高分）。
 *
 * 挑中的库条目会被**登记掉**，不让两条番堂记录抢同一个：番堂那边「第 2 期」和
 * 「第 3 期」是两个条目，而模糊匹配看它们长得几乎一样。
 *
 * ⚠️ 对不上不算错误，`items` 里没有就是没有 —— 番堂收得比 Bangumi 全
 * （特别篇、网络放送、里番），对不上是常态。
 *
 * @param {Array} items 番堂条目（`titleZh` / 可选 `titleKeys`）
 * @param {Array} candidates 自己的库（`id` + `titleZh` / `titleJa`）
 * @returns {Map<string, object>}
 */
export function matchLibrary(items, candidates) {
  const pool = (Array.isArray(candidates) ? candidates : []).filter((c) => c && (c.titleZh || c.titleJa));
  const byNorm = new Map();
  for (const c of pool) {
    for (const t of [c.titleZh, c.titleJa]) {
      const k = normTitle(t);
      if (k && !byNorm.has(k)) byNorm.set(k, c);
    }
  }

  const used = new Set();
  const out = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    if (!it) continue;
    const keys = Array.isArray(it.titleKeys) && it.titleKeys.length ? it.titleKeys : [normTitle(it.titleZh)];

    let hit = null;
    for (const k of keys) {
      hit = byNorm.get(k);
      if (hit) break;
    }

    if (!hit) {
      for (const k of keys) {
        if (!k || k.length < 4) continue;
        for (const [pk, v] of byNorm) {
          if (used.has(v.id)) continue;
          if (pk.includes(k) || k.includes(pk)) { hit = v; break; }
        }
        if (hit) break;
      }
    }

    if (!hit) {
      let best = null;
      let bestScore = 0;
      for (const c of pool) {
        if (used.has(c.id)) continue;
        const title = c.titleZh || c.titleJa;
        if (!fuzzyOk(it.titleZh, title)) continue;
        const score = titleSimilarity(it.titleZh, title);
        if (score > bestScore) { best = c; bestScore = score; }
      }
      hit = best;
    }

    if (hit) {
      used.add(hit.id);
      out.set(it.id, hit);
    }
  }
  return out;
}
