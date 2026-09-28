#!/usr/bin/env node
/**
 * 真联网验一次番堂（yuc.wiki）。
 *
 * 和 `test/yuc.test.mjs` 的分工要说清楚 ——
 *   - 那边用**裁下来的真实页面片段**验证解析规则，跑在 CI 里，不碰网络；
 *   - 这边连真的 `yuc.wiki`，验证的是**这条路在你这台机器上走不走得通**：
 *     站点还在不在、季度页的地址规则有没有变、真实的 160KB 页面上解析器
 *     能认出多少条、封面那张图能不能真的下下来。
 * 两者不能互相替代。**网络这件事，离线样本永远验不出来** ——
 * 反过来也一样：把网络当测试前提，就会在断网那天收到一堆与代码无关的红。
 * 所以它**不进 `check:all`**，要人来跑。
 *
 * 用法：
 *   node scripts/yuc-live-check.mjs                      # 自动探测代理，抓当季
 *   node scripts/yuc-live-check.mjs --season=2026q4      # 指定季度
 *   JIKAI_PROXY=http://127.0.0.1:7892 node scripts/yuc-live-check.mjs
 *
 * ⚠️ 命令行走的是**显式代理**（`--proxy=` / `JIKAI_PROXY`），不读系统代理 ——
 * 本机的 VPN 是系统代理模式，命令行不认。环境变量里那个 `http_proxy` 更别信：
 * 它是个黑洞代理（回 CONNECT 但不转发数据），照它走会「第一季成功、之后全失败」。
 */
import { httpGet, detectProxy, describeProxy } from './lib/proxyfetch.mjs';
import { parseYucPage, yucPageUrl } from '../src/data/yuc.js';
import { seasonOf } from '../src/core/time.js';

const arg = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? '').split('=')[1] || fallback;

const seasonKey = arg('season', '') || seasonOf(Date.now());
const explicit = arg('proxy', '') || process.env.JIKAI_PROXY || '';
const url = yucPageUrl(seasonKey);

if (!url) {
  console.error(`✗ 季度键不认识：${seasonKey}（要形如 2026q4）`);
  process.exit(2);
}

/**
 * `--proxy=http://127.0.0.1:7892` → `{host, port}`。
 *
 * ⚠️ `httpGet` 收的是**对象**不是地址串。传字符串进去 `tunnel` 会拿
 * `proxy.host` = undefined 去连，报出来的是一句 `连不上代理 undefined:undefined`
 * —— 看着像代理挂了，其实是参数给错了形状。
 */
function parseProxy(raw) {
  const m = String(raw).trim().replace(/^\w+:\/\//, '').replace(/\/.*$/, '');
  const [host, port] = m.split(':');
  return host && port ? { host, port: Number(port), from: 'arg' } : null;
}

console.log(`番堂联网验证 · 季度 ${seasonKey}`);
console.log(`  ${url}`);

/** 代理：`--proxy=` 优先；否则交给 `detectProxy` —— 它会**真发一次请求**验证 */
let proxy = explicit ? parseProxy(explicit) : null;
if (explicit && !proxy) {
  console.error(`✗ --proxy 的写法不认识：${explicit}（要形如 http://127.0.0.1:7892）`);
  process.exit(2);
}
if (!proxy) {
  proxy = await detectProxy({ target: 'yuc.wiki', port: 443, timeoutMs: 3000 }).catch(() => null);
}
console.log(`  代理：${proxy ? describeProxy(proxy) : '没探到，直连试试'}`);

let res;
try {
  res = await httpGet(url, {
    proxy,
    timeoutMs: 25000,
    // 站点对没有 UA 的请求会直接拒 —— 浏览器里能打开不代表命令行能打开
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; jikai-check)', Accept: 'text/html,*/*' },
  });
} catch (err) {
  console.error(`✗ 取页面失败：${err?.message ?? err}`);
  /*
   * 本机实测：yuc.wiki 和封面那个图床（i0.hdslb.com）**都是直连可达的**，
   * 不用代理。所以「连不上」时第一个该怀疑的不是墙，而是**代理参数本身**：
   * 指定了一个没在跑的端口（那个端口是本机 VPN 的，关掉 VPN 就没人听了）。
   */
  console.error('  → 先去掉 --proxy 直连试一次（番堂和它的图床都直连可达）');
  if (!proxy) console.error('  → 直连也不行的话，再试 --proxy=http://127.0.0.1:<本机 VPN 的端口>');
  process.exit(1);
}

console.log(`  HTTP ${res.status} · ${(res.bytes / 1024).toFixed(0)} KB`);

if (res.status !== 200) {
  console.error('✗ 状态码不是 200 —— 季度页可能还没建（下一季的页面通常是开播前一个月才出现）');
  process.exit(1);
}

const page = parseYucPage(res.text);
if (!page.ok) {
  console.error(`✗ 页面拿回来了但解析不出来：${page.reason}`);
  console.error('  → 站点改版了？先把这页存下来当新样本，再改 src/data/yuc.js（见 test/fixtures/yuc-schedule.sample.html）');
  process.exit(1);
}

console.log(`  收录：${page.seasonName || '(没写)'} 共 ${page.total ?? '?'} 部`);
console.log(`  排播：${page.stats.groups} 组 / ${page.stats.items} 条`);
console.log(`  资料：${page.stats.matched} 条对上了介绍区，${page.stats.unmatched} 部只在介绍区（没排进周表）`);
for (const g of page.groups) console.log(`    ${g.label.padEnd(14, ' ')} ${String(g.items.length).padStart(3, ' ')} 条`);

/*
 * 抽样验一张封面能不能真的下下来。
 *
 * 只验「取得到」不验「画得出来」：画那一步由桌面自检守着。
 * 挑有封面的第一条 —— 一条都没有说明排播区的选择器坏了，那也要红。
 */
const withCover = page.items.find((it) => it.cover);
if (!withCover) {
  console.error('✗ 一整页里没有一条带封面地址 —— 排播区的图片选择器多半失效了');
  process.exit(1);
}
const host = new URL(withCover.cover).hostname;
try {
  const img = await httpGet(withCover.cover, { proxy, timeoutMs: 15000 });
  const ok = img.status === 200 && (img.headers['content-type'] ?? '').startsWith('image/');
  console.log(`  封面样本：${host} · HTTP ${img.status} · ${img.headers['content-type']} · ${(img.bytes / 1024).toFixed(0)} KB`);
  if (!ok) {
    console.error('✗ 封面地址取回来不是图片 —— 缓存那一层会把这种东西当图存下来');
    process.exit(1);
  }
} catch (err) {
  console.error(`✗ 封面取不到（${host}）：${err?.message ?? err}`);
  console.error('  → 图床被墙 / 需要代理时，界面会退回色块（这是设计好的降级），但导出长图会缺图');
  process.exit(1);
}

/*
 * 对不上的条目逐条列出来。
 *
 * 它是**唯一能看出「解析规则开始漂了」的数字**：平时应该是个位数百分比，
 * 哪天突然一半对不上，就是对方的介绍区改名了 —— 而那时条目照样显示，
 * 只是资料全空，光看界面看不出来。
 */
const ratio = page.stats.items ? page.stats.matched / page.stats.items : 0;
console.log(`  资料覆盖率：${(ratio * 100).toFixed(0)}%`);
if (ratio < 0.6) {
  console.warn('  ⚠️ 覆盖率低于 60% —— 排播区和介绍区对不上了，去核对一下解析规则');
}
for (const u of page.unmatched.slice(0, 8)) console.log(`    · 只介绍：${u.titleZh}`);

console.log('✓ 番堂联网验证通过');
