/**
 * 用本地假服务器验证 Bangumi 真实 API 那条链路。
 *
 * 为什么要这么绕：这台机器上 api.bgm.tv 是连不通的（直连和走代理都超时），
 * 如果只能「跑通了才算测过」，那这段代码就永远是没验证过的状态。
 * 于是起一个只说 Bangumi v0 那套 JSON 形状的本地服务：字段名、结构、
 * 甚至 infobox 的嵌套都照原样，这样被测的是「我们的解析对不对」，
 * 而不是「今天网络通不通」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  DEFAULT_API, diagnose, enrichItems, fetchWithFallback, mapSubjectToPatch,
  needsEnrich, normalizePlatform, parseStudio, resolveBases, subjectUrl,
} from '../src/data/bangumiApi.js';
import { degradedText, loadSeason, slimItems } from '../src/data/sources.js';
import { BUILTIN_SEASONS } from '../src/data/builtin/index.js';

// ---------- 假服务器 ----------

/** 计数器放外面：用来断言「缓存命中时确实一个请求都没发」 */
let hits = 0;

function fakeSubject(id) {
  return {
    id,
    type: 2,
    name: `テストアニメ${id}`,
    name_cn: `虚构测试动画${id}`,
    summary: `这是第 ${id} 条虚构概要，用来验证简介字段能被正确接上。`,
    date: '2026-07-05',
    platform: 'TV',
    images: {
      large: `http://127.0.0.1/cover/${id}.jpg`,
      common: '', medium: '', small: '', grid: '',
    },
    eps: 12,
    total_episodes: 12,
    rating: { rank: 100 + id, total: 12345, score: 7.63 },
    tags: [{ name: '奇幻', count: 100 }, { name: '日常', count: 80 }, { name: '治愈', count: 60 }],
    infobox: [
      { key: '中文名', value: [{ v: '虚构测试动画' }] },
      // ↓ key 照真实 Bangumi infobox 抄（值已虚构）。
      //   真实条目里「音响制作担当」「制作进行」这类噪声 key 排在「动画制作」**前面**，
      //   早期版本用模糊匹配撞第一个，制作公司就取成了人名。留在这里当回归钉子。
      { key: '音响制作担当', value: [{ v: '仮名 太郎' }] },
      { key: '音乐制作', value: [{ v: '虚构音乐社' }] },
      { key: '制作进行', value: [{ v: '仮名 次郎' }] },
      { key: '制作进行协力', value: [{ v: '仮名 三郎' }] },
      { key: '动画制作', value: [{ v: '虚构工作室' }, { v: '灯屋工房' }] },
      { key: '製作', value: [{ v: '虚构製作委员会（甲、乙、丙）' }] },
      { key: '别名', value: [{ v: 'Fake Anime' }] },
    ],
    collection: {}, series: false, locked: false, nsfw: false, redirect: 0, volumes: 0,
  };
}

function startStub() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (!url.pathname.startsWith('/v0/')) {
        res.writeHead(404).end('nope');
        return;
      }
      if (url.pathname === '/v0/subjects/404') {
        hits += 1;
        res.writeHead(404, { 'content-type': 'application/json' }).end('{"title":"NotFound"}');
        return;
      }
      const m = url.pathname.match(/^\/v0\/subjects\/(\d+)$/);
      if (m) {
        hits += 1;
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(fakeSubject(Number(m[1]))));
        return;
      }
      res.writeHead(404).end('{}');
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** 等价于 platform.fetchJson 在 Node 下的实现 */
async function nodeFetchJson(url, { timeoutMs = 4000, headers } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`请求超时（${timeoutMs}ms）`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 一个连接必定失败的地址，用来验证降级 */
const DEAD = 'http://127.0.0.1:1';

// ---------- 纯解析 ----------

test('parseStudio 从 infobox 里取出动画制作，多个用 / 连接', () => {
  const s = fakeSubject(1);
  assert.equal(parseStudio(s.infobox), '虚构工作室 / 灯屋工房');
  assert.equal(parseStudio([]), null);
  assert.equal(parseStudio(undefined), null);
  // value 直接是字符串数组也要能吃
  assert.equal(parseStudio([{ key: '动画制作', value: ['A'] }]), 'A');
});

test('parseStudio 不被含「制作」二字的噪声 key 带偏（真实数据踩过的坑）', () => {
  // 真实条目里「音响制作担当」排在「动画制作」前面，值是个人名
  assert.equal(
    parseStudio([
      { key: '音响制作担当', value: [{ v: '人名 某人' }] },
      { key: '动画制作', value: [{ v: '正经工作室' }] },
    ]),
    '正经工作室',
  );
  // 只有噪声 key 时宁可返回 null，也不要拿人名 / 音乐公司顶上
  assert.equal(parseStudio([{ key: '音响制作担当', value: [{ v: '人名 某人' }] }]), null);
  assert.equal(parseStudio([{ key: '音乐制作', value: [{ v: '某音乐社' }] }]), null);
  assert.equal(parseStudio([{ key: '制作进行', value: [{ v: '人名 某人' }] }]), null);
  assert.equal(parseStudio([{ key: '设定制作', value: [{ v: '人名 某人' }] }]), null);
  assert.equal(parseStudio([{ key: 'CG 制作人', value: [{ v: '人名 某人' }] }]), null);
  assert.equal(parseStudio([{ key: '美术制作进行', value: [{ v: '人名 某人' }] }]), null);
});

test('parseStudio 认得别名写法，并且不把制作委员会当公司', () => {
  assert.equal(parseStudio([{ key: 'アニメーション制作', value: [{ v: '某スタジオ' }] }]), '某スタジオ');
  assert.equal(parseStudio([{ key: '制作公司', value: [{ v: '某影业' }] }]), '某影业');
  assert.equal(parseStudio([{ key: '动画製作', value: [{ v: '某动画' }] }]), '某动画');
  // key 带全角空格也要认出来
  assert.equal(parseStudio([{ key: '动画 制作', value: [{ v: '某动画' }] }]), '某动画');
  // 「製作」后面挂的是委员会列表 —— 那不是动画公司
  assert.equal(
    parseStudio([{ key: '製作', value: [{ v: '「某某」製作委员会（甲社、乙社、丙社）' }] }]),
    null,
  );
  // 单写「制作」但值是公司，还是要认
  assert.equal(parseStudio([{ key: '制作', value: [{ v: '某工作室' }] }]), '某工作室');
});

test('mapSubjectToPatch 只产出拿得到的字段，评分保留一位小数', () => {
  const p = mapSubjectToPatch(fakeSubject(7));
  assert.equal(p.eps, 12);
  assert.equal(p.score, 7.6);
  assert.equal(p.rank, 107);
  assert.equal(p.watchers, 12345);
  assert.equal(p.cover, 'http://127.0.0.1/cover/7.jpg');
  assert.equal(p.studio, '虚构工作室 / 灯屋工房');
  assert.equal(p.titleZh, '虚构测试动画7');
  assert.equal(p.tags.length, 3);
  assert.equal(p.platform, 'TV');
});

test('mapSubjectToPatch 对空数据不编数据出来', () => {
  assert.deepEqual(mapSubjectToPatch(null), {});
  assert.deepEqual(mapSubjectToPatch({ id: 1 }), {});
  // 评分为 0 时按「没有」处理，而不是补 0.0 分
  assert.equal(mapSubjectToPatch({ rating: { score: 0 } }).score, undefined);
});

test('needsEnrich 只对缺话数或缺封面的条目为真', () => {
  assert.equal(needsEnrich({ eps: 12, cover: 'http://x/a.jpg' }), false);
  assert.equal(needsEnrich({ eps: null, cover: 'http://x/a.jpg' }), true);
  assert.equal(needsEnrich({ eps: 12, cover: null }), true);
  assert.equal(needsEnrich({ eps: 0, cover: null }), true);
  assert.equal(needsEnrich(null), false);
});

test('resolveBases 把自填反代排在最前面并去重', () => {
  const bases = resolveBases({ customBase: 'https://my-mirror.example.com/', base: 'https://api.bgm.tv' });
  assert.equal(bases[0], 'https://my-mirror.example.com');
  assert.equal(bases.filter((b) => b === 'https://api.bgm.tv').length, 1);
  // 非法值要被丢掉
  assert.deepEqual(resolveBases({ customBase: 'not-a-url' }), ['https://api.bgm.tv']);
});

test('slimItems 会截断简介、限制标签数量', () => {
  const long = 'x'.repeat(900);
  const [a] = slimItems([{ id: 1, summary: long, tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] }]);
  assert.equal(a.summary.length, 240, '默认截断长度');
  assert.equal(a.tags.length, 8);
  // 长度可调：内置数据生成脚本会传自己的值
  const [b] = slimItems([{ id: 2, summary: long, tags: [] }], { summaryMax: 100 });
  assert.equal(b.summary.length, 100);
  // 没有简介的条目不该被塞进一个空串之外的任何东西
  const [c] = slimItems([{ id: 3, tags: null }]);
  assert.equal(c.summary, '');
  assert.deepEqual(c.tags, []);
});

// ---------- 请求与失败转移 ----------

test('fetchWithFallback：第一个端点挂了会自动试第二个', async () => {
  const { server, port } = await startStub();
  try {
    const r = await fetchWithFallback((base) => subjectUrl(base, 1), {
      api: { customBase: DEAD, base: `http://127.0.0.1:${port}`, timeoutMs: 3000 },
      fetchJson: nodeFetchJson,
    });
    assert.equal(r.base, `http://127.0.0.1:${port}`);
    assert.equal(r.data.name_cn, '虚构测试动画1');
    assert.equal(r.tries.length, 1);
    assert.match(r.tries[0].error, /ECONNREFUSED|fetch failed|HTTP/i);
  } finally {
    server.close();
  }
});

test('fetchWithFallback：全都挂了要抛错，并把每个端点的原因带出来', async () => {
  await assert.rejects(
    () => fetchWithFallback((base) => subjectUrl(base, 1), {
      api: { customBase: DEAD, base: DEAD, timeoutMs: 2500 },
      fetchJson: nodeFetchJson,
    }),
    (err) => {
      assert.match(err.message, /所有端点都不可用/);
      assert.ok(err.tries.length >= 2);
      return true;
    },
  );
});

test('enrichItems：并发跑完并统计成功失败', async () => {
  const { server, port } = await startStub();
  try {
    const items = [1, 2, 3, 404].map((id) => ({ id, eps: null, cover: null, titleJa: `t${id}` }));
    const progress = [];
    const res = await enrichItems(items, {
      api: { base: `http://127.0.0.1:${port}`, customBase: '', concurrency: 2, gapMs: 0, timeoutMs: 3000 },
      fetchJson: nodeFetchJson,
      onProgress: (done, total) => progress.push(`${done}/${total}`),
    });
    assert.equal(res.stats.requested, 4);
    assert.equal(res.stats.ok, 3);
    assert.equal(res.stats.failed, 1);
    assert.equal(progress.at(-1), '4/4');
    assert.equal(items[0].eps, 12);
    assert.equal(items[1].cover, 'http://127.0.0.1/cover/2.jpg');
    // 失败的那条不被写脏
    assert.equal(items[3].eps, null);
  } finally {
    server.close();
  }
});

test('diagnose 逐条报出可用性，一条挂不影响另一条', async () => {
  const { server, port } = await startStub();
  try {
    const r = await diagnose({
      api: { customBase: `http://127.0.0.1:${port}`, base: DEAD, timeoutMs: 2500 },
      fetchJson: nodeFetchJson,
    });
    assert.equal(r.ok, true);
    // 候选端点 = 自填反代 + base + 兜底的官方地址（去重后），
    // 数量不该被写死，但顺序必须是我们期望的优先级
    assert.ok(r.rows.length >= 2);
    assert.equal(r.rows[0].base, `http://127.0.0.1:${port}`);
    assert.equal(r.rows[0].ok, true);
    assert.match(r.rows[0].sample, /虚构测试动画/);
    assert.equal(r.rows[1].ok, false);
    assert.match(r.rows[1].error, /ECONNREFUSED|fetch failed/i);
  } finally {
    server.close();
  }
});

// ---------- 整条 loadSeason ----------

function staticItems() {
  return [1, 2, 3].map((id) => ({
    id,
    titleZh: `虚构测试动画${id}`,
    titleJa: `テストアニメ${id}`,
    begin: '2026-07-05T15:00:00.000Z',
    broadcast: 'R/2026-07-05T15:00:00.000Z/P7D',
    eps: null,
    platform: 'TV',
    studio: null,
    tags: [],
    score: null,
    watchers: null,
    summary: '',
    season: '2026q3',
    cover: null,
    external: {},
  }));
}

test('loadSeason(bangumi-api)：真实排播表 + API 补全，并把结果写进缓存', async () => {
  const { server, port } = await startStub();
  hits = 0;
  const cache = {};
  try {
    const res = await loadSeason('bangumi-api', '2026q3', {
      api: { base: `http://127.0.0.1:${port}`, customBase: '', timeoutMs: 3000, concurrency: 2, gapMs: 0 },
      fetchJson: nodeFetchJson,
      staticFetcher: async () => staticItems(),
      readCache: (k) => cache[k] ?? null,
      writeCache: (k, v) => { cache[k] = v; },
      onProgress: () => {},
    });

    assert.equal(res.items.length, 3);
    assert.equal(res.degraded, null);
    assert.equal(res.enrichStats.ok, 3);

    const a = res.items[0];
    assert.equal(a.eps, 12);
    assert.equal(a.score, 7.6);
    assert.equal(a.cover, 'http://127.0.0.1/cover/1.jpg');
    assert.equal(a.studio, '虚构工作室 / 灯屋工房');
    assert.match(a.summary, /虚构概要/);

    // 缓存内容与标记
    assert.equal(cache['2026q3'].source, 'bangumi-api');
    assert.equal(cache['2026q3'].enriched, true);
    assert.equal(hits, 3);

    // 再拉一次（非 live）应当直接吃缓存，一个请求都不发
    const again = await loadSeason('bangumi-api', '2026q3', {
      api: { base: `http://127.0.0.1:${port}`, timeoutMs: 3000 },
      fetchJson: nodeFetchJson,
      staticFetcher: async () => { throw new Error('不该走到这里'); },
      readCache: (k) => cache[k] ?? null,
      writeCache: () => {},
    });
    assert.equal(again.cached, true);
    assert.equal(again.items.length, 3);
    assert.equal(hits, 3, '缓存命中的情况下不该再发请求');
  } finally {
    server.close();
  }
});

test('loadSeason：网络全挂且没有缓存 → 回退内置数据，并给出可读的降级说明', async () => {
  const season = BUILTIN_SEASONS[0];
  const res = await loadSeason('bangumi-api', season, {
    api: { base: DEAD, customBase: '', timeoutMs: 2000 },
    fetchJson: nodeFetchJson,
    staticFetcher: async () => { throw new Error('模拟断网'); },
    readCache: () => null,
    writeCache: () => {},
  });
  assert.ok(res.items.length > 0, '回退后应该有内置数据可看');
  assert.equal(res.degraded.kind, 'builtin-fallback');
  assert.match(degradedText(res.degraded), /已改用内置数据/);
});

test('loadSeason：内置数据没有这一季 → 明确说清有哪几季，而不是空着不解释', async () => {
  const res = await loadSeason('builtin', '1999q1', {});
  assert.equal(res.items.length, 0);
  assert.equal(res.degraded.kind, 'builtin-missing');
  assert.match(degradedText(res.degraded), /内置数据只含/);
});

test('loadSeason：有旧缓存但网络挂了 → 用旧缓存，并说明是旧缓存', async () => {
  const stale = { savedAt: Date.now(), source: 'bangumi-data', enriched: false, items: staticItems() };
  const res = await loadSeason('bangumi-data', '2026q3', {
    live: true,
    api: { base: DEAD, timeoutMs: 2000 },
    fetchJson: nodeFetchJson,
    staticFetcher: async () => { throw new Error('模拟断网'); },
    readCache: () => stale,
    writeCache: () => {},
  });
  assert.equal(res.items.length, 3);
  assert.equal(res.cached, true);
  assert.equal(res.degraded.kind, 'stale-cache');
  assert.match(degradedText(res.degraded), /上次缓存/);
});

test('loadSeason：补全全失败时仍给出排播表，并说明补全失败', async () => {
  const res = await loadSeason('bangumi-api', '2026q3', {
    api: { base: DEAD, customBase: '', timeoutMs: 2000 },
    fetchJson: nodeFetchJson,
    staticFetcher: async () => staticItems(),
    readCache: () => null,
    writeCache: () => {},
  });
  assert.equal(res.items.length, 3, '排播表本身是好的，不该被丢掉');
  assert.equal(res.items[0].eps, null);
  assert.equal(res.degraded.kind, 'enrich-failed');
  assert.match(degradedText(res.degraded), /只拿到了排播表/);
});

test('内置数据源不碰网络', async () => {
  let called = false;
  const res = await loadSeason('builtin', BUILTIN_SEASONS[0], {
    fetchJson: async () => { called = true; throw new Error('不该发请求'); },
    staticFetcher: async () => { called = true; return []; },
  });
  assert.equal(called, false);
  assert.ok(res.items.length > 0, '内置数据应该是有内容的');
  assert.equal(res.source, 'builtin');
  assert.equal(res.degraded, null);
  assert.equal(res.cached, false);
});

test('DEFAULT_API 的默认值没被改动', () => {
  assert.equal(DEFAULT_API.base, 'https://api.bgm.tv');
  assert.equal(DEFAULT_API.enrichLimit, 60);
});
