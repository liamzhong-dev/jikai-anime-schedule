/**
 * 用**真实**的 bangumi-data 全量数据集，跑一遍本次新写的取数 + 建索引 + 搜索。
 *
 * 为什么不能只靠单测：本地造的假数据形状永远比真的规整。
 * 这一路要验的恰好是「真实数据的脏」——
 *   没有 bangumi id 的条目、begin 缺失的、中文名为空的、重名的系列条目。
 *
 * 用法：JIKAI_PROXY=http://127.0.0.1:7892 node scripts/live-catalog-check.mjs
 */
import { httpGet, detectProxy, describeProxy } from './lib/proxyfetch.mjs';
import { fetchCatalog, mapCatalog, groupBySeason } from '../src/data/bangumiData.js';
import { buildNameIndex, searchNames, nameIndexStale } from '../src/core/library.js';

const proxy = await detectProxy();
console.log('代理：', describeProxy(proxy));

/**
 * 项目里的 bangumiData 默认用全局 fetch（浏览器 / Electron 渲染层都有），
 * 而 Node 的内置 fetch 不吃系统代理。这里把它接到走隧道的 httpGet 上。
 *
 * 两个必须自己补齐的点：
 *   - httpGet 不跟随重定向，而 unpkg 一定会 302 到带版本号的 URL；
 *     真实的 fetch 默认是 follow，所以这是替身的缺口，不是应用的问题。
 *   - httpGet 给的是 text，没有 json()；fetch 有。
 */
globalThis.fetch = async (url) => {
  let target = url;
  for (let hop = 0; hop < 5; hop += 1) {
    const res = await httpGet(target, { proxy, timeoutMs: 90000, headers: { 'User-Agent': 'jikai-live-check/1.0' } });
    const location = res.headers?.location;
    if (res.status >= 300 && res.status < 400 && location) {
      target = new URL(location, target).href;
      continue;
    }
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      json: async () => JSON.parse(res.text),
      text: async () => res.text,
    };
  }
  throw new Error('重定向次数过多');
};

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`  ${ok ? '[ok]' : '[!!]'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures += 1;
};

console.log('\n=== 1. 拉全量数据集 ===');
const t0 = Date.now();
const raw = await fetchCatalog();
const ms = Date.now() - t0;
console.log(`  条目 ${raw.length} 条 · 用时 ${(ms / 1000).toFixed(1)}s`);
check('拿到的是数组', Array.isArray(raw));
check('条目数在合理区间（8000~10000）', raw.length > 8000 && raw.length < 10000, String(raw.length));

console.log('\n=== 2. 建名称索引 ===');
const index = buildNameIndex(raw, { nowMs: Date.now(), source: 'bangumi-data' });
console.log(`  索引 ${index.count} 条 · 年份跨度 ${index.span.join('~')}`);
const blob = JSON.stringify(index);
console.log(`  落盘体积 ${(blob.length / 1024 / 1024).toFixed(2)} MB · 平均每条 ${Math.round(blob.length / index.count)} 字节`);
check('索引条目数接近带 bangumi id 的总数', index.count > 8000 && index.count <= raw.length, String(index.count));
check('每条条目都有 id 与至少一个名字', index.entries.every((e) => e.id && (e.zh || e.ja)));
check('体积在 1.5MB 以内（能放心放进单独文件）', blob.length < 1.5 * 1024 * 1024);
check('刚建出来的索引不算过期', nameIndexStale(index, { nowMs: Date.now() }).stale === false);

console.log('\n=== 3. 真实数据上的搜索 ===');
// 关键词里刻意混进 latin 写法：真实数据的 title 是日文（《鬼滅の刃》），
// 只有英文译名字段能接住「Demon Slayer」这种搜法。
for (const kw of ['葬送', '孤独摇滚', '鬼灭', 'Frieren', 'Demon Slayer']) {
  const hits = searchNames(index, kw, { limit: 3 });
  const top = hits[0];
  console.log(`  「${kw}」→ ${hits.length} 条，第一命中：${top ? `${top.zh || top.ja} (${top.y}q${top.q})` : '（无）'}`);
  check(`搜得到「${kw}」`, hits.length > 0);
}

// 排序的关键保证：本体要压过衍生条目。
// 中文和英文各验一次 —— 英文译名常常一长串同前缀，单靠平手规则会翻车。
const g = searchNames(index, '鬼灭之刃', { limit: 5 });
check('搜中文系列名时正片排第一', g[0] && g[0].zh === '鬼灭之刃', g[0]?.zh ?? '（无命中）');

const d = searchNames(index, 'Demon Slayer', { limit: 5 });
check('搜英文系列名时也正片排第一', d[0] && d[0].zh === '鬼灭之刃', `${d[0]?.zh} (${d[0]?.y}q${d[0]?.q})` ?? '（无命中）');

console.log('\n=== 4. 按季度分组 ===');
const mapped = mapCatalog(raw);
const grouped = groupBySeason(mapped, ['2026q3', '2026q4']);
for (const [k, list] of Object.entries(grouped)) {
  console.log(`  ${k}: ${list.length} 部`);
}
check('两个季度都分出了条目', Object.keys(grouped).length === 2 && Object.values(grouped).every((l) => l.length > 0));

console.log(failures === 0 ? '\n结论：[ok] 真实数据集上的取数 / 建索引 / 搜索 / 分组全部通过' : `\n结论：[!!] ${failures} 项不通过`);
process.exit(failures === 0 ? 0 : 1);
