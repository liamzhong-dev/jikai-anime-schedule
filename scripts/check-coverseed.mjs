/**
 * 随包封面图包的验收。
 *
 * 这个功能最容易「看起来做完了」：图包里躺着 217 个文件，
 * 目录、体积、文件名都对 —— 但只要**名字和运行时算出来的不一样**，
 * 它们就一个都用不上，而且不报错、不警告，界面上只是「还是要联网下」。
 * 所以这里的判据不是「文件在不在」，而是：
 *
 *   ① 从**真实作品数据**算出「运行时会去找哪个文件」，那个文件必须真的在图包里；
 *   ② 种进缓存之后，`CoverCache` 用**只读模式**必须命中 ——
 *      只读模式不联网，命中了就证明确实是种子给的。
 *
 * 用法：node scripts/check-coverseed.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { seedCovers } = require('../electron/coverSeed.cjs');
const { CoverCache, hashUrl } = require('../electron/covers.cjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COVER_PACK = path.join(ROOT, 'build', 'covers');

const coversMod = await import(pathToFileURL(path.join(ROOT, 'src', 'core', 'covers.js')).href);
const builtinMod = await import(pathToFileURL(path.join(ROOT, 'src', 'data', 'builtin', 'index.js')).href);

let failures = 0;
function check(ok, label, extra = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures += 1;
}

/** 每个场景一个干净目录，互不影响 */
function freshDir(name) {
  const dir = path.join(os.tmpdir(), `jikai-coverseed-${process.pid}-${name}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const builtinItems = typeof builtinMod.allBuiltinItems === 'function'
  ? builtinMod.allBuiltinItems()
  : builtinMod.allBuiltinItems;

/** 「运行时会去找的那个文件」——组、文件名，全部按运行时的规则来 */
function expectedFor(item) {
  const url = coversMod.coverVariant(item?.cover, coversMod.DISPLAY_VARIANT).url;
  if (!url) return null;
  const group = String(item?.season ?? '');
  if (!/^[A-Za-z0-9_-]{1,48}$/.test(group)) return null;
  const ext = /\.png(\?|$)/i.test(url) ? '.png' : '.jpg';
  return { group, url, file: `${hashUrl(url)}${ext}` };
}

console.log('\n【图包本身】');
const packFiles = [];
if (fs.existsSync(COVER_PACK)) {
  for (const g of fs.readdirSync(COVER_PACK, { withFileTypes: true })) {
    if (!g.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(COVER_PACK, g.name))) {
      packFiles.push({ group: g.name, file: f });
    }
  }
}
check(packFiles.length > 0, '图包里有文件', `${packFiles.length} 个`);

const expected = builtinItems.map(expectedFor).filter(Boolean);
const have = new Set(packFiles.map((p) => `${p.group}/${p.file}`));
const hit = expected.filter((e) => have.has(`${e.group}/${e.file}`));
const miss = expected.filter((e) => !have.has(`${e.group}/${e.file}`));

check(
  hit.length >= Math.floor(expected.length * 0.9),
  '随包作品里九成以上的封面都在图包里，且文件名和运行时算的一致',
  `覆盖 ${hit.length}/${expected.length}（缺 ${miss.length}）`,
);
if (miss.length && miss.length <= 10) {
  for (const m of miss) console.log(`      · 缺 ${m.group}/${m.file}`);
}

console.log('\n【种进去】');
const source = freshDir('src');
const target = freshDir('dst');

// 场景 1：源目录不存在
{
  const r = await seedCovers({ from: path.join(source, '不存在'), to: target });
  check(r.missing === true && r.copied === 0, '源目录不存在时返回 missing: true 而不是抛');
}

// 场景 2：正常种一份（拿真实图包里前 6 个）
const sample = packFiles.slice(0, 6);
for (const s of sample) {
  fs.mkdirSync(path.join(source, s.group), { recursive: true });
  fs.writeFileSync(path.join(source, s.group, s.file), fs.readFileSync(path.join(COVER_PACK, s.group, s.file)));
}
// 混进三样不该被种的东西
fs.writeFileSync(path.join(source, sample[0].group, 'README.txt'), 'not a cover');
fs.writeFileSync(path.join(source, sample[0].group, '00000000000000000000.jpg'), '');
fs.mkdirSync(path.join(source, '不作为组'), { recursive: true });

{
  const r = await seedCovers({ from: source, to: target });
  check(
    r.copied === sample.length && r.failed === 0,
    '该种的都种了，没有一个写失败',
    `copied=${r.copied} rejected=${r.rejected} failed=${r.failed}`,
  );
  check(r.rejected === 1, '那个 0 字节的文件被按规矩拒了（记在 rejected，不是 failed）');
  check(!fs.existsSync(path.join(target, sample[0].group, 'README.txt')), '非 hash 命名的文件不许进缓存');
  check(
    !fs.existsSync(path.join(target, sample[0].group, '00000000000000000000.jpg')),
    '0 字节的文件不许进缓存 —— 它会让那张图永远下不下来',
  );
}

// 场景 3：再种一遍，一个都不该覆盖
{
  const before = fs.statSync(path.join(target, sample[0].group, sample[0].file)).mtimeMs;
  const r = await seedCovers({ from: source, to: target });
  const after = fs.statSync(path.join(target, sample[0].group, sample[0].file)).mtimeMs;
  check(r.copied === 0 && r.skipped === sample.length, '重复种一个都不抄', `copied=${r.copied} skipped=${r.skipped}`);
  check(before === after, '已有的文件没被重新写一遍（只补不覆盖）');
}

// 场景 4：目标里已有的内容不许被种子盖掉
{
  const victim = path.join(target, sample[0].group, sample[0].file);
  fs.writeFileSync(victim, 'USER_VERSION');
  await seedCovers({ from: source, to: target });
  check(fs.readFileSync(victim, 'utf8') === 'USER_VERSION', '用户缓存里已有的那张没有被种子覆盖');
}

console.log('\n【运行时真的找得到】（这条才是关键）');
/*
 * 拿真实作品走一遍：算名字 → 种 → 用真 CoverCache 只读取。
 * 只读模式**不联网**，所以它命中就只可能是种子给的。
 * 联网取图直接抛 —— 顺便证明这一路上真的没走网络。
 */
const realSource = COVER_PACK;
/*
 * ⚠️ `CoverCache` 的构造参数是 **userData 那一层**，它自己会拼一个 `covers` 子目录。
 * 种子的落点就得是拼完之后那个目录 —— 一开始把同一个 `realTarget` 同时喂给两边，
 * 文件种在 `realTarget/`、缓存去 `realTarget/covers/` 找，两边都对，
 * 合起来就是 0 命中（下面那条 totalFiles=0 就是这么来的）。
 */
const realBase = freshDir('real');
const realTarget = path.join(realBase, 'covers');
const noNetwork = async () => {
  throw new Error('不该联网 —— 只读模式却去下了图');
};

{
  const r = await seedCovers({ from: realSource, to: realTarget });
  check(r.copied > 0, '真实图包种进缓存', `copied=${r.copied} skip=${r.skipped} fail=${r.failed} ${(r.bytes / 1024 / 1024).toFixed(2)}MB`);

  const cache = new CoverCache(realBase, { fetchBinary: noNetwork });
  const probes = expected.slice(0, 8);
  let okCount = 0;
  for (const p of probes) {
    const res = await cache.get({ group: p.group, url: p.url, readOnly: true });
    if (res.status === 'hit' && res.dataUrl?.startsWith('data:image/')) okCount += 1;
  }
  check(okCount === probes.length, '只看本地就能取到图（只读模式命中）', `${okCount}/${probes.length}`);

  const stats = await cache.stats();
  check(stats.totalFiles >= r.copied - 5, '缓存里确实躺着这些文件', `totalFiles=${stats.totalFiles}`);
}

// 反问一句：种子的存在不能变成「不再下载」的借口 —— 缺的那几张该下还得下
{
  const cache = new CoverCache(realBase, { fetchBinary: noNetwork });
  const absent = { group: '2099q1', url: 'https://lain.bgm.tv/pic/cover/c/ff/ff/999999_zzzzz.jpg' };
  const res = await cache.get({ ...absent, readOnly: true });
  check(res.status === 'miss', '图包里没有的那张，只读模式如实报 miss（不会假装有）');
}

console.log(`\n${failures ? `✗ ${failures} 条没过` : '✓ 图包自检通过'}\n`);
process.exit(failures ? 1 : 0);
