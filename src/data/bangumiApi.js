/**
 * Bangumi v0 API 客户端（可选启用）。
 *
 * 为什么单独一个文件、并且要把 fetch 注入进来：
 *   - 浏览器里直连 api.bgm.tv 会被 CORS 拦，桌面端要走主进程的网络通道；
 *   - 有些人需要挂反代 / 走代理，端点列表必须可配置；
 *   - 断网环境要能整体降级，不能让一个请求把界面拖死。
 * 所以这里只管「请求哪个地址、怎么解析、怎么并发」，怎么发出去交给调用方。
 *
 * 字段依据 v0 文档与实测：/v0/subjects/{id} 返回 eps / total_episodes /
 * rating.score / rating.total / images.grid / tags / infobox，足够补齐
 * bangumi-data 缺的那几项。
 */

/**
 * 请求 Bangumi API 时带的 UA。官方要求能识别出调用方，
 * 版本号与主页地址都取自 src/core/version.js，不在这里重复写死。
 */
import { USER_AGENT } from '../core/version.js';
export { USER_AGENT };

/** 默认候选端点。第一个不通就顺次往下试。 */
export const DEFAULT_BASES = [
  'https://api.bgm.tv',
];

/** 反代前缀候选：把官方地址挂在后面，适合自建 Cloudflare Worker / Vercel 反代 */
export const DEFAULT_PREFIXES = [
  'https://api.bgm.tv',
];

export const DEFAULT_API = {
  base: 'https://api.bgm.tv',
  customBase: '',     // 用户自填的反代地址，优先级最高
  proxy: '',          // 形如 http://127.0.0.1:7890，交给主进程设置会话代理
  timeoutMs: 12000,
  concurrency: 3,     // 官方建议别太猛
  gapMs: 120,
  enrichLimit: 60,    // 一个季度最多补全多少部，避免一次打上百个请求
};

/** 按优先级排出这次要试的端点 */
export function resolveBases(api = {}) {
  const out = [];
  const push = (v) => {
    const s = String(v ?? '').trim().replace(/\/+$/, '');
    if (s && /^https?:\/\//i.test(s) && !out.includes(s)) out.push(s);
  };
  push(api.customBase);
  push(api.base);
  for (const b of DEFAULT_BASES) push(b);
  return out.length ? out : [...DEFAULT_BASES];
}

export function subjectUrl(base, id) {
  return `${String(base).replace(/\/+$/, '')}/v0/subjects/${encodeURIComponent(id)}`;
}

export function episodesUrl(base, id, { limit = 100, offset = 0 } = {}) {
  return `${String(base).replace(/\/+$/, '')}/v0/episodes?subject_id=${encodeURIComponent(id)}&limit=${limit}&offset=${offset}`;
}

/**
 * 依次尝试候选端点，返回第一个成功的响应。
 * 失败信息会累积到 error，方便诊断面板一次看清所有端点各自怎么了。
 */
export async function fetchWithFallback(pathFor, { api = {}, fetchJson, signal } = {}) {
  const bases = resolveBases(api);
  const timeoutMs = api.timeoutMs ?? DEFAULT_API.timeoutMs;
  const tries = [];
  for (const base of bases) {
    const url = pathFor(base);
    try {
      const data = await fetchJson(url, { timeoutMs, signal, headers: { 'User-Agent': USER_AGENT } });
      return { data, base, tries };
    } catch (err) {
      tries.push({ base, ok: false, error: err?.message ?? String(err) });
    }
  }
  const e = new Error(`所有端点都不可用：${tries.map((t) => `${t.base} → ${t.error}`).join('；')}`);
  e.tries = tries;
  throw e;
}

export function fetchSubject(id, ctx) {
  return fetchWithFallback((base) => subjectUrl(base, id), ctx);
}

/**
 * 取出制作公司。
 *
 * 注意：这里被真实数据打过一次脸，记下来。
 * 真实 infobox 里含「制作」二字的 key 有一大堆 ——
 *   音响制作担当 / 音乐制作 / 制作进行 / 制作进行协力 / 制作管理 /
 *   设定制作 / 美术制作进行 / CG 制作人 / OP・ED 动画制作 / 製作 …
 * 最早写成 `/动画制作|製作|制作/` 撞第一个匹配，结果撞到排在最前面的
 * 「音响制作担当」，取回来的是个人名 —— 那一条的「制作」列就全错了。
 * 本地造的假数据里只放了一个「动画制作」，所以测试全绿也照样错。
 *
 * 现在的做法：按 key 精确分层匹配，白名单之外一概不认。
 */
const STUDIO_KEY_TIERS = [
  // 第一档：明确就是动画制作公司
  /^(动[画畫]制作|动画製作|動畫製作|アニメーション制作|アニメ制作|アニメーション製作)$/,
  // 第二档：别名的写法
  /^(制作公司|动[画畫]制作公司|アニメーション制作会社)$/,
  // 第三档：光写「制作 / 製作」的条目，还要再看值像不像公司（下面会滤掉委员会）
  /^(制作|製作)$/,
];

/** 制作委员会不是动画公司，别拿它冒充 */
const STUDIO_VALUE_NOISE = /委員会|委员会/;

/** 把 key 归一化后再比对：去掉空白，全角空格也算 */
const normalizeKey = (k) => String(k ?? '').trim().replace(/[\s\u3000]+/g, '');

/** 清理值：剥掉说明性前缀，滤掉委员会 */
function cleanStudioValue(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  // 「XXプロデュース：某社」这种带说明前缀的，取冒号后面的实体名
  const m = /^[^：:]{2,24}[：:]\s*(.+)$/.exec(s);
  if (m && m[1].trim()) s = m[1].trim();
  if (STUDIO_VALUE_NOISE.test(s)) return '';
  return s;
}

export function parseStudio(infobox) {
  const boxes = Array.isArray(infobox) ? infobox : [];
  for (const re of STUDIO_KEY_TIERS) {
    for (const b of boxes) {
      if (!re.test(normalizeKey(b?.key))) continue;
      const raw = b?.value;
      const arr = Array.isArray(raw) ? raw : [raw];
      const names = arr
        .map((v) => (typeof v === 'string' ? v : v?.v))
        .filter(Boolean)
        .map(cleanStudioValue)
        .filter(Boolean);
      if (names.length) return names.join(' / ');
    }
  }
  return null;
}

/**
 * 平台归一化。
 *
 * 又是一个真实数据才暴露的问题：排播表里的 type 是规整的
 * tv / web / ova / movie，但 Bangumi 条目的 platform 是**给人看的字符串** ——
 * 除了 TV / Web / OVA，还会出现「其他」「剧场版」「游戏」。
 * 早先直接 toUpperCase 盖上去，结果界面上出现「其他」这样一个徽标，
 * 而筛选器只列了 TV / WEB，那一条就再也筛不出来了。
 *
 * 认不出来的取值一律返回 null（＝不覆盖），保留排播表里的那个。
 */
const PLATFORM_ALIASES = {
  tv: 'TV', 电视: 'TV', 电视剧: 'TV',
  web: 'WEB', 网络: 'WEB', ona: 'WEB', webアニメ: 'WEB',
  ova: 'OVA', oad: 'OVA', スペシャル: 'OVA',
  movie: 'MOVIE', 剧场版: 'MOVIE', 劇場版: 'MOVIE', 电影: 'MOVIE', 映画: 'MOVIE',
};

export function normalizePlatform(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  return PLATFORM_ALIASES[s] ?? PLATFORM_ALIASES[s.toLowerCase()] ?? null;
}

/**
 * 把 Bangumi 条目揉成番剧对象上的补丁。
 * 只产出「确实拿到了」的字段，取不到就留空，避免用假数据把界面填满。
 */
export function mapSubjectToPatch(subject) {
  if (!subject || typeof subject !== 'object') return {};
  const score = subject.rating?.score;
  const patch = {};

  const eps = Number(subject.total_episodes ?? subject.eps ?? 0);
  if (Number.isFinite(eps) && eps > 0) patch.eps = eps;

  if (Number.isFinite(score) && score > 0) patch.score = Math.round(score * 10) / 10;
  if (Number.isFinite(subject.rating?.total)) patch.watchers = subject.rating.total;
  if (Number.isFinite(subject.rating?.rank) && subject.rating.rank > 0) patch.rank = subject.rating.rank;

  const cover = subject.images?.large || subject.images?.common || subject.images?.medium || subject.images?.grid;
  if (cover) patch.cover = String(cover);

  if (subject.summary) patch.summary = String(subject.summary).trim();
  if (subject.name_cn) patch.titleZh = String(subject.name_cn).trim();
  if (subject.name) patch.titleJa = String(subject.name).trim();
  if (subject.date) patch.date = String(subject.date);

  const studio = parseStudio(subject.infobox);
  if (studio) patch.studio = studio;

  const tags = (subject.tags ?? [])
    .map((t) => t?.name)
    .filter(Boolean)
    .slice(0, 8)
    .map(String);
  if (tags.length) patch.tags = tags;

  const platform = normalizePlatform(subject.platform);
  if (platform) patch.platform = platform;

  return patch;
}

/** 简易并发池：保持顺序无关，但限制同时在飞的请求数 */
export async function mapPool(items, worker, { concurrency = 3, gapMs = 0, onProgress, signal } = {}) {
  const list = [...items];
  const out = new Array(list.length);
  let cursor = 0;
  let done = 0;
  const size = Math.max(1, Math.min(concurrency, list.length || 1));

  async function run() {
    for (;;) {
      if (signal?.aborted) return;
      const i = cursor;
      cursor += 1;
      if (i >= list.length) return;
      try {
        out[i] = await worker(list[i], i);
      } catch (err) {
        out[i] = { __error: err?.message ?? String(err) };
      }
      done += 1;
      onProgress?.(done, list.length);
      if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
    }
  }

  await Promise.all(Array.from({ length: size }, run));
  return out;
}

/**
 * 批量补全：对没有话数/封面的条目逐个查 Bangumi。
 * 返回 { items, stats } —— stats 记下成功/失败数，界面据此说清「补了多少、漏了多少」。
 */
export async function enrichItems(items, { api = {}, fetchJson, signal, onProgress } = {}) {
  const cfg = { ...DEFAULT_API, ...api };
  const targets = items.filter((a) => needsEnrich(a)).slice(0, cfg.enrichLimit);
  if (!targets.length) return { items, stats: { requested: 0, ok: 0, failed: 0, skipped: items.length } };

  const byId = new Map(items.map((a) => [a.id, a]));
  let ok = 0;
  let failed = 0;

  const results = await mapPool(
    targets,
    async (anime) => {
      const res = await fetchSubject(anime.id, { api: cfg, fetchJson, signal });
      return { id: anime.id, patch: mapSubjectToPatch(res.data) };
    },
    {
      concurrency: cfg.concurrency,
      gapMs: cfg.gapMs,
      signal,
      onProgress: (d, t) => onProgress?.(d, t),
    },
  );

  for (const r of results) {
    if (!r || r.__error) { failed += 1; continue; }
    const target = byId.get(r.id);
    if (!target) continue;
    Object.assign(target, r.patch);
    ok += 1;
  }

  return {
    items,
    stats: { requested: targets.length, ok, failed, skipped: items.length - targets.length },
  };
}

/** 值不值得为它跑一趟网络：缺话数或缺封面就算 */
export function needsEnrich(anime) {
  return Boolean(anime) && (anime.eps == null || anime.eps <= 0 || !anime.cover);
}

/**
 * 连通性诊断：把候选端点挨个探一遍，返回每条的耗时与失败原因。
 * 用户开没开代理、反代地址填对没有，看这个比猜快。
 */
export async function diagnose({ api = {}, fetchJson } = {}) {
  const cfg = { ...DEFAULT_API, ...api };
  const bases = resolveBases(cfg);
  const rows = [];
  for (const base of bases) {
    const t0 = Date.now();
    try {
      const data = await fetchJson(subjectUrl(base, 1), {
        timeoutMs: Math.min(cfg.timeoutMs, 8000),
        headers: { 'User-Agent': USER_AGENT },
      });
      rows.push({
        base,
        ok: true,
        ms: Date.now() - t0,
        sample: data?.name_cn || data?.name || '(无标题)',
      });
    } catch (err) {
      rows.push({ base, ok: false, ms: Date.now() - t0, error: err?.message ?? String(err) });
    }
  }
  return { ok: rows.some((r) => r.ok), rows };
}

/** 单条验证：给设置面板里的「测试」按钮用 */
export async function probeSubject(id, ctx) {
  const res = await fetchSubject(id || 1, ctx);
  const patch = mapSubjectToPatch(res.data);
  return { base: res.base, patch, raw: res.data };
}
