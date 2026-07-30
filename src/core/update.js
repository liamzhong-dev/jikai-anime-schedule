/**
 * 自动更新的「判断」部分（纯函数，不碰网络也不碰 Electron）。
 *
 * 真正发请求在 electron/updater.cjs，那边用主进程的 net 通道，
 * 所以这里只负责：怎么把地址翻译成该请求的 URL、怎么比版本、
 * 怎么把两种更新源格式（自定义 manifest / GitHub Releases）揉成同一种结构。
 */

/** 'v0.2.1-beta.3' → [0,2,1]，非数字段按 0 处理 */
export function parseVersion(v) {
  const s = String(v ?? '').trim().replace(/^v/i, '');
  const main = s.split(/[-+]/)[0];
  return main.split('.').map((n) => {
    const num = parseInt(n.replace(/[^\d]/g, ''), 10);
    return Number.isFinite(num) ? num : 0;
  });
}

/** -1 / 0 / 1 */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i += 1) {
    const l = x[i] ?? 0;
    const r = y[i] ?? 0;
    if (l > r) return 1;
    if (l < r) return -1;
  }
  return 0;
}

const firstString = (...vals) => {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
};

/**
 * 把更新源返回的 JSON 统一成内部结构。
 * 支持两种：
 *   1) 自定义 manifest：{ version, notes, url, mandatory, sha256 }
 *   2) GitHub Releases API：{ tag_name, body, html_url, assets:[{browser_download_url}] }
 */
export function normalizeManifest(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('更新源返回的不是一个 JSON 对象');

  const version = firstString(raw.version, raw.tag_name, raw.tagName, raw.name);
  if (!version) throw new Error('更新源里没有版本号字段（version / tag_name）');

  const assets = Array.isArray(raw.assets) ? raw.assets : [];
  const preferred = assets.find((a) => /\.(exe|msi|dmg|AppImage|zip)$/i.test(String(a?.name ?? '')));
  const url = firstString(
    raw.url,
    raw.downloadUrl,
    raw.download_url,
    preferred?.browser_download_url,
    assets[0]?.browser_download_url,
    raw.html_url,
  );

  return {
    version: version.replace(/^v/i, ''),
    notes: firstString(raw.notes, raw.body, raw.changelog, raw.description) ?? '',
    url,
    mandatory: Boolean(raw.mandatory ?? raw.force ?? false),
    pubDate: firstString(raw.pubDate, raw.published_at, raw.publishedAt),
    sha256: firstString(raw.sha256),
    source: raw.tag_name ? 'github' : 'manifest',
  };
}

/**
 * 比对当前版本与更新源。
 * @returns {{hasUpdate, current, latest, notes, url, mandatory, skipped}}
 */
export function evaluateUpdate(raw, currentVersion, { skippedVersion = null } = {}) {
  const m = normalizeManifest(raw);
  const hasUpdate = compareVersions(m.version, currentVersion) > 0;
  const skipped = Boolean(skippedVersion) && compareVersions(m.version, skippedVersion) === 0;
  return {
    hasUpdate: hasUpdate && !skipped,
    current: String(currentVersion ?? '').replace(/^v/i, ''),
    latest: m.version,
    notes: m.notes,
    url: m.url,
    mandatory: m.mandatory,
    skipped,
    pubDate: m.pubDate,
  };
}

/**
 * 把「人写的更新源地址」翻成「真正要请求的地址」。
 *
 * 为什么需要这一步：设置面板里写的是「支持自定义 manifest，也支持 GitHub
 * Releases」。但用户手里的 GitHub 地址通常是网页地址
 *   https://github.com/owner/repo/releases/latest
 * 而能返回 JSON 的是 API 地址
 *   https://api.github.com/repos/owner/repo/releases/latest
 * 如果非要用户自己记住 api.github.com 这一段，那句「支持 GitHub」就等于没做。
 *
 * 认得的写法（其余原样返回）：
 *   .../owner/repo
 *   .../owner/repo/releases
 *   .../owner/repo/releases/latest
 *   .../owner/repo/releases/tag/v0.3.0
 */
export function toApiUrl(url) {
  const raw = firstString(url);
  if (!raw) return null;
  const m = /^https?:\/\/github\.com\/([^/?#]+)\/([^/?#]+?)(?:\.git)?(?:\/releases(?:\/(latest|tag\/[^/?#]+))?)?\/?$/i.exec(raw);
  if (!m) return raw;
  const [, owner, repo, tail] = m;
  return `https://api.github.com/repos/${owner}/${repo}/releases/${tail ?? 'latest'}`;
}

/** 更新源地址兜底：没有配置就明确说没有，不要假装检查过 */
export function resolveManifestUrl(configured, fromPackage) {
  const c = firstString(configured, fromPackage);
  if (!c) return null;
  if (!/^https?:\/\//i.test(c)) return null;
  return toApiUrl(c);
}

/** 把检查结果说成一句人话 */
export function describeUpdate(result) {
  if (!result) return '还没检查过';
  if (result.error) return `检查失败：${result.error}`;
  if (!result.hasUpdate) {
    if (result.latest && result.current && compareVersions(result.latest, result.current) === 0) return `已是最新版本 ${result.current}`;
    return `已是最新版本 ${result.current}`;
  }
  return `发现新版本 ${result.latest}（当前 ${result.current}）`;
}
