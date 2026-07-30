/**
 * bangumi-data 接入层：拉全量排播表，映射成本作的番剧对象。
 *
 * 数据来源：github.com/bangumi-data/bangumi-data（CC BY 4.0，需在「关于」中署名）
 * 字段依据实测：begin 是 UTC 绝对时刻，broadcast 形如 R/.../P7D，
 * Bangumi 条目 ID 在 sites 数组里取 site==='bangumi' 那一项。
 *
 * 这个数据集只有「谁、什么时候开始播、多久一集」，没有话数、评分、封面 ——
 * 那些由 bangumiApi.js 逐个补。仓库里另存了一份构建期抓好的快照
 * （见 src/data/builtin/），所以不联网也有内容可看。
 */

const DATA_URL = 'https://unpkg.com/bangumi-data@0.3/dist/data.json';

export function bangumiIdOf(item) {
  const hit = (item.sites ?? []).find((s) => s.site === 'bangumi');
  return hit?.id ? Number(hit.id) : null;
}

export function mapItem(item) {
  const id = bangumiIdOf(item);
  const titleZh = item.titleTranslate?.['zh-Hans']?.[0] ?? null;
  const titleJa = item.title ?? '';
  const display = titleZh || titleJa;
  return {
    id: id ?? hashId(titleJa),
    titleZh: display,
    titleJa,
    begin: item.begin ?? null,
    broadcast: item.broadcast ?? null,
    eps: null, // 排播表没有话数，联网源会查 Bangumi API 补上
    platform: (item.type ?? 'tv').toUpperCase(),
    studio: null,
    tags: [],
    score: null,
    watchers: null,
    summary: '',
    season: seasonKeyOf(item.begin),
    cover: null,
    officialSite: item.officialSite ?? null,
    external: {
      bangumi: id ? `https://bgm.tv/subject/${id}` : `https://bgm.tv/subject_search/${encodeURIComponent(titleJa)}?cat=2`,
      moegirl: `https://zh.moegirl.org.cn/index.php?search=${encodeURIComponent(display)}`,
    },
  };
}

function seasonKeyOf(begin) {
  if (!begin) return null;
  const d = new Date(Date.parse(begin) + 9 * 3600000);
  return `${d.getUTCFullYear()}q${Math.ceil((d.getUTCMonth() + 1) / 3)}`;
}

function hashId(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) % 1000000;
  return 700000 + h;
}

/** 拉取全量数据并按季度过滤；失败时抛出，由调用方降级到缓存或内置数据 */
export async function fetchSeason(seasonKey, { signal } = {}) {
  const res = await fetch(DATA_URL, { signal });
  if (!res.ok) throw new Error(`bangumi-data 拉取失败：HTTP ${res.status}`);
  const raw = await res.json();
  const items = Array.isArray(raw) ? raw : (raw.items ?? []);
  const mapped = items.map(mapItem).filter((a) => a.begin);
  if (!seasonKey) return mapped;
  return mapped.filter((a) => a.season === seasonKey);
}

/**
 * 生成可选的季度列表：下一季开头，往前数到第 7 季，共 9 项。
 *
 * 为什么把「下一季」放最前面：番剧排播是按季度整批换的，9 月下旬打开这个
 * 台历的人，关心的多半是十月要开什么，而不是七月那批还剩几集。
 * 放在最前面省一次翻找 —— 内置数据也正好覆盖了下一季，点开就有内容。
 */
export function availableSeasons(nowMs = Date.now()) {
  const d = new Date(nowMs + 9 * 3600000);
  const out = [];
  let year = d.getUTCFullYear();
  let q = Math.ceil((d.getUTCMonth() + 1) / 3) + 1; // 先站到下一季
  if (q > 4) { q -= 4; year += 1; }
  for (let i = 0; i < 9; i += 1) {
    out.push(`${year}q${q}`);
    q -= 1;
    if (q === 0) { q = 4; year -= 1; }
  }
  return out;
}

export function currentSeason(nowMs = Date.now()) {
  const d = new Date(nowMs + 9 * 3600000);
  return `${d.getUTCFullYear()}q${Math.ceil((d.getUTCMonth() + 1) / 3)}`;
}
