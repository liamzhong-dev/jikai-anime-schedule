/**
 * 「更新 Bangumi 数据」这一件事的编排层。
 *
 * 放在这里而不是塞进 App.jsx，是因为它有清晰的三步、且每一步都可能失败：
 *
 *   ① 拉一次 bangumi-data 全量数据集（7.5 MB，走代理约 7 秒）
 *   ② 由同一份数据派生出三样东西：名称索引 / 各季度分组 / 作品档案
 *   ③ 补番组里「名单上有、档案里没有」的作品，逐个回查 Bangumi API 补全
 *
 * 为什么一定是「一次拉取、多处派生」而不是各下各的：
 * 数据集是全量的，每个季度各自 fetch 一次就等于重复下载同一份 7.5 MB ——
 * 再加上名称索引要遍历全量，一轮「更新数据」能下掉几十 MB。
 *
 * 副作用全部通过注入的函数进来（写入 / 网络），本模块自身没有副作用，
 * 因此可以在测试里塞假实现，不需要真联网。
 */

import { buildNameIndex, nameIndexStale } from '../core/library.js';
import { fetchSubject, mapSubjectToPatch } from './bangumiApi.js';
import { mapCatalog, groupBySeason } from './bangumiData.js';
import { slimItems } from './slim.js';

/** 一次「补全补番组」最多发多少请求。补番名单一般只有几十条，够了 */
const CATCHUP_ENRICH_LIMIT = 40;

/**
 * 由 Bangumi API 的条目构造一个档案条目。
 *
 * 只回填确实拿到的字段：没评分就别写 0 进去 —— 0 分和「还没人打分」
 * 是两回事，界面上一个显示 0.0 一个应该留空。
 */
export function subjectFromApi(id, subject) {
  const patch = mapSubjectToPatch(subject);
  const titleZh = patch.titleZh || '';
  const titleJa = patch.titleJa || '';
  const display = titleZh || titleJa || `条目 ${id}`;
  const out = { id: Number(id), ...patch };
  out.titleZh = titleZh;
  out.titleJa = titleJa;
  out.external = {
    bangumi: `https://bgm.tv/subject/${id}`,
    moegirl: `https://zh.moegirl.org.cn/index.php?search=${encodeURIComponent(display)}`,
  };
  return out;
}

/**
 * @param {object} opts
 * @param {string[]} opts.seasonKeys       要更新的季度；空数组表示只建索引不算季度
 * @param {number[]} opts.catchupIds       补番组里需要保证有档案的 id
 * @param {boolean} opts.rebuildIndex      是否重建名称索引（force 时无视新鲜度）
 * @param {Function} opts.fetchCatalog     async ({signal}) => raw[]
 * @param {Function} opts.readNameIndex    async () => index | null
 * @param {Function} opts.writeNameIndex   async (payload) => void
 * @param {Function} opts.writeSeason      (seasonKey, items) => void
 * @param {Function} opts.archiveSubjects  (items) => {added, updated}
 * @param {Function} opts.fetchJson        给 Bangumi API 用的网络通道
 * @param {object}   opts.api              Bangumi API 配置
 * @param {Function} opts.onProgress       ({pct, label}) => void
 * @param {AbortSignal} opts.signal
 */
export async function syncLibrary({
  seasonKeys = [],
  catchupIds = [],
  rebuildIndex = false,
  fetchCatalog,
  readNameIndex,
  writeNameIndex,
  writeSeason,
  archiveSubjects,
  fetchJson,
  api = {},
  onProgress,
  signal,
  nowMs = Date.now(),
} = {}) {
  const report = {
    ok: true,
    downloaded: 0,
    index: null,
    seasons: [],
    archived: null,
    catchup: { requested: 0, ok: 0, failed: 0 },
    errors: [],
  };
  const say = (pct, label) => onProgress?.({ pct, label });

  // ---------- ① 拉全量 ----------
  say(6, '拉取 bangumi-data 全量数据');
  let raw;
  try {
    raw = await fetchCatalog({ signal });
  } catch (err) {
    report.ok = false;
    report.errors.push({ stage: 'catalog', error: err?.message ?? String(err) });
    say(100, `下载失败：${err?.message ?? String(err)}`);
    return report;
  }
  report.downloaded = raw?.length ?? 0;

  // ---------- ②-a 名称索引 ----------
  let needIndex = Boolean(rebuildIndex);
  if (!needIndex && typeof readNameIndex === 'function') {
    try {
      const cur = await readNameIndex();
      needIndex = nameIndexStale(cur, { nowMs }).stale;
    } catch {
      needIndex = true;   // 读不动当成没有
    }
  }

  if (needIndex && typeof writeNameIndex === 'function') {
    say(18, '建立名称索引');
    const index = buildNameIndex(raw, { nowMs, source: 'bangumi-data' });
    try {
      await writeNameIndex(index);
      report.index = { built: true, count: index.count, span: index.span };
    } catch (err) {
      report.errors.push({ stage: 'name-index', error: err?.message ?? String(err) });
      report.index = { built: false, count: index.count, error: err?.message ?? String(err) };
    }
  } else {
    report.index = { built: false, skipped: true };
  }

  // ---------- ②-b 季度分组 ----------
  const mapped = mapCatalog(raw);
  const wanted = seasonKeys?.length ? seasonKeys : null;
  const grouped = groupBySeason(mapped, wanted);

  let done = 0;
  const total = Object.keys(grouped).length;
  for (const [key, list] of Object.entries(grouped)) {
    const items = slimItems(list);
    try {
      writeSeason?.(key, items);
      report.seasons.push({ key, count: items.length });
    } catch (err) {
      report.errors.push({ stage: `season:${key}`, error: err?.message ?? String(err) });
    }
    done += 1;
    say(18 + Math.round((done / Math.max(1, total)) * 40), `写入季度分组 ${done}/${total}`);

    // 顺手归档：看见过的番都留一份条目，卡片才不会因为换季而找不到名字
    if (typeof archiveSubjects === 'function') {
      try {
        archiveSubjects(items);
      } catch {
        /* 归档失败不影响本季能否显示 */
      }
    }
  }

  // ---------- ③ 补番组补全 ----------
  // 名单里有、档案里没有的，不联网就永远只有一串 id。
  // 这是「补番名单记住了但补不出来」的直接来源，所以必须走到。
  const missing = [...new Set((catchupIds ?? []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  const targets = missing.slice(0, CATCHUP_ENRICH_LIMIT);
  report.catchup.requested = targets.length;
  if (targets.length) {
    report.catchup.requested = targets.length;
    const found = [];
    let done2 = 0;
    for (const id of targets) {
      if (signal?.aborted) break;
      try {
        const res = await fetchSubject(id, { api, fetchJson, signal });
        found.push(subjectFromApi(id, res.data));
        report.catchup.ok += 1;
      } catch (err) {
        report.catchup.failed += 1;
        if (report.errors.length < 20) {
          report.errors.push({ stage: `subject:${id}`, error: err?.message ?? String(err) });
        }
      }
      done2 += 1;
      say(58 + Math.round((done2 / targets.length) * 40), `补全补番组 ${done2}/${targets.length}`);
    }
    if (found.length && typeof archiveSubjects === 'function') {
      try {
        const stats = archiveSubjects(found);
        report.archived = stats;
      } catch (err) {
        report.errors.push({ stage: 'archive', error: err?.message ?? String(err) });
      }
    }
  }

  if (report.errors.length) report.ok = false;
  say(100, '完成');
  return report;
}

/**
 * 把同步结果翻译成一句话。
 * 界面要能一眼看出「更新了什么」，而不是只说一句「完成」——
 * 尤其是部分失败的时候，沉默等于让用户以为全好了。
 */
export function describeSyncReport(report) {
  if (!report) return '没有拿到结果';
  if (!report.downloaded) {
    return `拉取失败：${report.errors?.[0]?.error ?? '未知原因'} · 检查一下 VPN / 代理有没有开`;
  }
  const parts = [];
  if (report.index?.built) parts.push(`名称索引 ${report.index.count} 条`);
  else if (report.index?.error) parts.push(`名称索引写入失败（${report.index.error}）`);
  const seasonCount = report.seasons.reduce((n, s) => n + s.count, 0);
  if (report.seasons.length) parts.push(`${report.seasons.length} 个季度共 ${seasonCount} 部`);
  if (report.catchup.requested) {
    parts.push(`补番组补全 ${report.catchup.ok}/${report.catchup.requested}`);
  }
  const failed = report.errors.length;
  return `${parts.join(' · ') || '什么都没更新'}${failed ? ` · ${failed} 处出错` : ''}`;
}
