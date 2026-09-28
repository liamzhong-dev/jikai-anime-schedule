/**
 * 长门番堂（yuc.wiki）解析层测试。
 *
 * 素材是 `test/fixtures/yuc-schedule.sample.html`：**从真实季度页裁下来的**
 * （2026 年 10 月档，只留周一、周六、网络放送、收录统计、前两条介绍）。
 * 用它而不是手写一段 HTML，是因为这个解析器要对付的全是现实里的怪东西 ——
 * 类名带数字后缀、同一个 `<br>` 两种含义、`<td>` 里套 `<a>`。
 * 手写的样本会把这些都洗掉，测出来是绿的，拿真数据就崩。
 *
 * 这层是纯函数，所以断言可以精确到字段。断言的重点是**反向**：
 * 「不该合起来的没合起来」「认不出的时候有没有老实说认不出」——
 * 「该有的有了」这种正向断言在这类解析器里最容易自欺。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  FUZZY_MIN_RATIO,
  fuzzyOk,
  matchLibrary,
  normTitle,
  parseCast,
  parseIntroSummary,
  parseStaff,
  parseYucDate,
  parseYucPage,
  seasonKeyOfYucPage,
  slimYuc,
  splitTitle,
  titleSimilarity,
  yucItemId,
  yucPageKey,
  yucPageUrl,
} from '../src/data/yuc.js';

const FIXTURE = new URL('./fixtures/yuc-schedule.sample.html', import.meta.url);
const html = fs.readFileSync(FIXTURE, 'utf8');
const page = parseYucPage(html);

/* ---------- 季度键换算 ---------- */

test('季度键 → 番堂页面键：四个季度都按 1/4/7/10 月对', () => {
  assert.equal(yucPageKey('2026q1'), '202601');
  assert.equal(yucPageKey('2026q2'), '202604');
  assert.equal(yucPageKey('2026q3'), '202607');
  assert.equal(yucPageKey('2026q4'), '202610');
  assert.equal(yucPageKey('2011q3'), '201107');
});

test('季度键：认不出的写法一律给 null，不猜', () => {
  for (const bad of ['', null, undefined, '2026q5', '2026Q4', '2026-04', '202610', 'q4']) {
    assert.equal(yucPageKey(bad), null, `${JSON.stringify(bad)} 不该被认出来`);
  }
  assert.equal(yucPageUrl('不是季度'), null);
  assert.equal(yucPageUrl('2026q4'), 'https://yuc.wiki/202610/');
});

test('页面键 → 季度键：和上一个函数互为逆运算', () => {
  for (const q of ['2020q1', '2026q2', '2026q4', '2033q3']) {
    assert.equal(seasonKeyOfYucPage(yucPageKey(q)), q);
  }
  assert.equal(seasonKeyOfYucPage('202611'), null);
});

/* ---------- 标题拆行 ---------- */

test('同一个 <br> 的两种含义要分开：中文+原名 与 长名字断行', () => {
  // ① 中文名 + 原名 → 中文只取前一行，原名单独给
  const a = splitTitle('顶点武装<br>VERTEX FORCE');
  assert.equal(a.titleZh, '顶点武装');
  assert.equal(a.titleJa, 'VERTEX FORCE');

  // ② 两行都是中文（名字太长断开）→ 合起来，且不能塞进 titleJa
  const b = splitTitle('赛博朋克<br>边缘行者2');
  assert.equal(b.titleZh, '赛博朋克边缘行者2');
  assert.equal(b.titleJa, '', '两行都是中文时不该把某一行当成原名');
});

test('拆行结果里不能出现「中文名和原名粘在一起」', () => {
  const t = splitTitle('顶点武装<br>VERTEX FORCE');
  assert.ok(!t.titleZh.includes('VERTEX'), `中文名里混进了原名：${t.titleZh}`);
  // 而且要给出足够多的匹配候选 —— 只有一条候选时，写法一变就整条对不上
  assert.ok(t.keys.length >= 2, `匹配候选太少了：${JSON.stringify(t.keys)}`);
});

/* ---------- 制作 / 声优 ---------- */

test('制作名单：换行续写要接在上一个职位上', () => {
  const staff = parseStaff('　　导演：高村和宏<br>　　编剧：高村和宏<br>　　　　　铃木雅词<br>CG导演：田所洋行');
  assert.deepEqual(staff.map((s) => s.role), ['导演', '编剧', 'CG导演']);
  assert.deepEqual(staff[1].people, ['高村和宏', '铃木雅词'], '没有冒号的那行应该接到上一个职位');
  assert.deepEqual(staff[0].people, ['高村和宏']);
});

test('声优表：一行并排几个名字要拆开', () => {
  const cast = parseCast('　寺岛拓笃　白石晴香<br>　会泽纱弥　东山奈央');
  assert.deepEqual(cast, ['寺岛拓笃', '白石晴香', '会泽纱弥', '东山奈央']);
});

test('空输入给空数组，不抛', () => {
  assert.deepEqual(parseStaff(''), []);
  assert.deepEqual(parseCast(null), []);
});

/* ---------- 日期 ---------- */

test('首播日：认「10/5~」，把后面的尾巴单独留出来', () => {
  assert.deepEqual(parseYucDate('10/5~'), { month: 10, day: 5, label: '10/5~', note: '' });
  assert.equal(parseYucDate('10/3周六深夜').month, 10);
  assert.equal(parseYucDate('10/3周六深夜').note, '周六深夜');
  // 认不出就是 null —— 不要编一个 1 月 1 日出来
  assert.equal(parseYucDate(''), null);
  assert.equal(parseYucDate('未定'), null);
  assert.equal(parseYucDate('13/40'), null, '越界的月日要被挡掉');
});

/* ---------- 模糊匹配的两条闸门 ---------- */

test('模糊匹配：真的对上（简称 vs 全名）', () => {
  assert.ok(
    fuzzyOk('和没有信徒的女神一起攻略异世界', '和没有信徒的女神大人一起攻略异世界'),
    '少两个字不该判成对不上',
  );
  assert.ok(
    fuzzyOk('转生贵族靠鉴定技能一飞冲天 第3期', '转生贵族靠着鉴定技能一飞冲天 第3期'),
    '多一个「着」不该判成对不上',
  );
});

test('⚠️ 模糊匹配：不同季数的作品不许粘到一起', () => {
  // 只差一个字符，「第2期」和「第3期」的相似度能到 0.9 —— 光看相似度拦不住
  assert.ok(
    titleSimilarity('魔法少女育成计画 第2期', '魔法少女育成计画 第3期') >= 0.9,
    '前提没成立：这两条本来就没那么像，那下面这条断言就白测了',
  );
  assert.equal(fuzzyOk('魔法少女育成计画 第2期', '魔法少女育成计画 第3期'), false);
});

test('模糊匹配：太短的一律不认（避免「第二季」这种前缀乱粘）', () => {
  assert.equal(fuzzyOk('异世界', '异世界2'), false);
});

/* ---------- 真页面片段 ---------- */

test('页面能解析出来：不算「认不出」', () => {
  assert.equal(page.ok, true, `解析失败：${page.reason}`);
  assert.ok(page.items.length > 0);
});

test('分组数 = 页面里真正的分组标题数（不写死数字）', () => {
  const expected = (html.match(/<td class="date2">/g) ?? []).length;
  assert.ok(expected > 0, '样本里应该有分组标题');
  assert.equal(page.groups.length, expected);
});

test('每个分组的条数加起来 = 条目总数', () => {
  const sum = page.groups.reduce((n, g) => n + g.items.length, 0);
  assert.equal(sum, page.items.length);
  assert.ok(page.items.length > 0);
});

test('星期分组的 key 是稳定英文，不是中文（中文一改文案缓存就全废）', () => {
  const keys = page.groups.map((g) => g.key);
  assert.ok(keys.includes('mon'), `没认出周一：${keys.join(',')}`);
  assert.ok(keys.includes('sat'), `没认出周六：${keys.join(',')}`);
  assert.ok(keys.includes('net'), `没认出网络放送：${keys.join(',')}`);
  for (const k of keys) assert.match(k, /^[a-z-]+$/);
});

test('每条都有中文名、封面、分组归属', () => {
  for (const it of page.items) {
    assert.ok(it.titleZh, `有条目没有中文名：${JSON.stringify(it)}`);
    assert.ok(it.cover, `${it.titleZh} 没有封面`);
    assert.ok(it.id.startsWith('y'), `id 前缀不对：${it.id}`);
    assert.ok(it.groupKey, `${it.titleZh} 没有分组`);
  }
});

test('id 稳定且不重复：同一页解析两次给同一批 id', () => {
  const again = parseYucPage(html);
  assert.deepEqual(again.items.map((i) => i.id), page.items.map((i) => i.id));
  const uniq = new Set(page.items.map((i) => i.id));
  assert.equal(uniq.size, page.items.length, '同一页里出现了重复 id');
});

test('id 不会和 Bangumi 的数字 id 撞（封面缓存按 id 作键，撞了就串图）', () => {
  for (const it of page.items) assert.ok(!/^\d+$/.test(it.id), `${it.id} 看起来像 Bangumi 的数字 id`);
});

test('排播条：时刻和首播日都读到了', () => {
  const mon = page.groups.find((g) => g.key === 'mon');
  assert.ok(mon && mon.items.length, '样本里的周一应该是空的');
  const withTime = mon.items.filter((i) => /^\d{1,2}:\d{2}/.test(i.time));
  assert.equal(withTime.length, mon.items.length, `周一有 ${mon.items.length - withTime.length} 条没读到时刻`);
  for (const it of mon.items) {
    assert.ok(it.start, `${it.titleZh} 没解析出首播日：${JSON.stringify(it.startDate)}`);
  }
});

test('网络放送那组：没有时刻但有「几号网络放送」和话数', () => {
  const net = page.groups.find((g) => g.key === 'net');
  assert.ok(net && net.items.length, '样本里应该有网络放送组');
  for (const it of net.items) {
    assert.equal(it.time, '', '网络放送不该有周播时刻');
    assert.ok(it.start, `${it.titleZh} 没有放送日期`);
  }
  assert.ok(net.items.some((i) => /全\d+话|[0-9]+话/.test(i.episodes)), '话数一条都没读到');
});

test('介绍区补字段：对上的条目要有原名 / 类型 / 标签 / 声优 / 制作', () => {
  const hit = page.items.find((i) => i.matched);
  assert.ok(hit, '一条都没和介绍区对上 —— 标题匹配大概率坏了');
  assert.ok(hit.titleJa, `${hit.titleZh} 没有原名`);
  assert.ok(hit.kind, `${hit.titleZh} 没有类型`);
  assert.ok(hit.tags.length, `${hit.titleZh} 没有题材标签`);
  assert.ok(hit.cast.length, `${hit.titleZh} 没有声优`);
  assert.ok(hit.staff.length, `${hit.titleZh} 没有制作`);
});

test('链接要真的抓到（<td> 里套 <a> 会让惰性匹配提前截断）', () => {
  const withLinks = page.items.filter((i) => i.links.length);
  assert.ok(withLinks.length > 0, '一条链接都没抓到 —— link_a_r 那块多半被截断了');
  for (const it of withLinks) {
    for (const l of it.links) {
      assert.match(l.url, /^https?:\/\//, `${it.titleZh} 的链接不是 http(s)：${l.url}`);
      assert.ok(l.label, `${it.titleZh} 有个链接没有文字`);
    }
  }
});

test('⚠️ 介绍区的类名会带数字后缀（`title_cn_r1` / `title_jp_r2`），必须认出来', () => {
  /*
   * 这是**最容易漏的一档**：同一个位置的类名，有的条目带 `1`、有的带 `2`、有的不带，
   * 而且不带的占多数。只按 `title_cn_r` 找的话，真实那一季 69 部里只能解析出 46 部，
   * 剩下 23 部的标签、声优、制作、官网整片空着 —— 而界面上看起来像是
   * 「这一季就这些作品没资料」，没有任何报错。
   */
  const jojo = page.items.find((i) => normTitle(i.titleZh).startsWith('jojo'));
  assert.ok(jojo, '样本里应该有那一条 JOJO');
  assert.equal(jojo.matched, true, '带后缀的介绍条没被认出来');
  assert.ok(jojo.titleJa, '带后缀的原名（title_jp_r2）没读到');
  assert.ok(jojo.cast.length, '带后缀的声优格没读到');
  assert.ok(jojo.staff.length, '带后缀的制作格没读到');
  assert.ok(jojo.links.length, '带后缀的链接格没读到');
});

test('⚠️ 注释掉的占位链接不能算进来（点开是空白页，界面上看不出来）', () => {
  const all = page.items.flatMap((i) => i.links.map((l) => l.url));
  assert.ok(!all.some((u) => u.includes('#')), `抓到井号占位链接：${all.filter((u) => u.includes('#')).join(',')}`);
  assert.ok(!all.some((u) => /^javascript:/i.test(u)));
});

test('收录统计：总数和分类部数都读到了', () => {
  assert.equal(page.seasonName, '秋季档');
  assert.equal(typeof page.total, 'number');
  assert.ok(page.breakdown.length >= 2, '分类统计只读到一项以下，多半是选择器坏了');
  // 统计段说共 N 部，分类之和应该等于 N —— 不相等说明有一类没认出来
  const sum = page.breakdown.reduce((n, b) => n + b.count, 0);
  assert.equal(sum, page.total, `分类相加 ${sum} ≠ 总数 ${page.total}`);
});

/*
 * ⚠️ 这一条是「测试全绿、界面却是空的」那个坑的守门员。
 *
 * `parseYucPage` 原来返回的 `groups` 里装的是**排播区的原始条目**（只有时刻、
 * 首播、封面），补过制作/声优/链接的是旁边那个平铺的 `items`。
 * 解析器测试看的是 `items`，界面看的是 `groups` —— 于是两边各自都对，
 * 合起来就是「详情面板一片空白」，而它**不报错**，看着像番堂没填资料。
 *
 * 断言写成**成对**的：先证明样本里确实有带资料的条目（前提成立），
 * 再比较两边的数量。少了前半句，样本一旦变了这条就会「因为没东西可失」而假绿。
 */
test('groups 和 items 是同一批条目：groups 里也必须带着介绍区的资料', () => {
  const withStaff = page.items.filter((i) => (i.staff ?? []).length);
  assert.ok(withStaff.length > 0, '样本里应当有对上了介绍区、带着制作名单的条目（前提不成立就没法验下面这条）');

  const grouped = page.groups.flatMap((g) => g.items);
  assert.equal(grouped.length, page.items.length, '分组里的条目数应当和平铺的一样');

  const groupedWithStaff = grouped.filter((i) => (i.staff ?? []).length);
  assert.equal(
    groupedWithStaff.length,
    withStaff.length,
    `groups 里有 ${groupedWithStaff.length} 条带制作名单、items 里有 ${withStaff.length} 条 —— ` +
      '界面读的是 groups，少一条就是「详情面板空着」',
  );
  assert.ok(page.items.includes(groupedWithStaff[0]), '两边应当是同一批对象，不是各拼一份');
});

test('没和排播表对上的介绍条要如实报出来，不能悄悄吞掉', () => {
  // 未匹配的条数 = 介绍区总数 − 被用掉的介绍条数。三个数必须自洽，
  // 否则界面上那句「另有 N 部没对上」就是个编出来的数字。
  const usedIntro = page.items.filter((i) => i.matched);
  assert.equal(page.stats.matched, usedIntro.length, 'stats.matched 和实际匹配数对不上');
  assert.equal(
    page.stats.items,
    page.items.length,
    'stats.items 和条目总数对不上',
  );
  assert.equal(page.stats.unmatched, page.unmatched.length);
  // 匹配数 + 未匹配数不该超过条目总数（模糊匹配若把一条介绍分给两部作品就会发生）
  assert.ok(
    page.stats.matched + page.stats.unmatched <= page.stats.items,
    `一条介绍被重复分配了：matched=${page.stats.matched} + unmatched=${page.stats.unmatched} > items=${page.stats.items}`,
  );
  for (const it of page.unmatched) assert.ok(it.titleZh, '未匹配列表里出现了没有名字的条目');
});

/* ---------- 反向：认不出的时候要老实说 ---------- */

test('⚠️ 空页面：ok=false 且说得出理由，不是「成功但 0 条」', () => {
  const r = parseYucPage('');
  assert.equal(r.ok, false);
  assert.ok(r.reason);
  assert.equal(r.items.length, 0);
});

test('⚠️ 页面结构变了（既没有分组也没有介绍）：ok=false，且理由要指明结构', () => {
  const r = parseYucPage('<html><body><p>什么都没有</p></body></html>');
  assert.equal(r.ok, false);
  assert.match(r.reason, /结构|分组|介绍/, `理由没指明原因：${r.reason}`);
});

test('⚠️ 只有介绍段、没有排播分组（那一季还没排）：认出来是「还没排」而不是「结构坏了」', () => {
  const onlyIntro = html.slice(html.indexOf('<table width="500px">'));
  const r = parseYucPage(onlyIntro);
  assert.equal(r.ok, false);
  assert.match(r.reason, /没排|还没/, `理由该说「还没排」，实际：${r.reason}`);
});

test('分组存在但没有条目：也判成「还没排」', () => {
  const r = parseYucPage('<div><table class="date_" width="100%"><tr><td class="date2">周一 (月)</td></tr></table></div>');
  assert.equal(r.ok, false);
  assert.match(r.reason, /没排|还没/);
});

/* ---------- 落盘形态 ---------- */

test('slimYuc：解析失败时给 null（别把半份数据写进缓存）', () => {
  assert.equal(slimYuc(parseYucPage('')), null);
  assert.equal(slimYuc(null), null);
});

test('slimYuc：留下的字够界面用，且带 savedAt', () => {
  const s = slimYuc(page);
  assert.ok(s && s.savedAt > 0);
  assert.equal(s.stats.items, page.stats.items);

  /*
   * ⚠️ 挑**有资料的那一条**来验，不能随手拿 `items[0]`：
   * 排播区里大多数条目在介绍区里没有对应（这一季 24 条里只有 2 条有），
   * 拿第一条验的话 `staff`/`cast`/`links` 全是空数组 ——
   * `'staff' in first` 照样通过，等于什么都没验。
   */
  const rich = s.groups.flatMap((g) => g.items).find((it) => (it.staff ?? []).length && (it.links ?? []).length);
  assert.ok(rich, '样本里应该有资料齐全的条目，否则这条断言验不到东西');
  for (const k of ['id', 'titleZh', 'cover', 'groupKey', 'time', 'startDate', 'tags', 'cast', 'staff', 'links', 'matched']) {
    assert.ok(k in rich, `落盘结果里缺字段 ${k}`);
  }
  assert.ok(rich.staff.length > 0, '制作名单不该是空的');
  assert.ok(rich.cast.length > 0, '声优不该是空的');
  assert.ok(rich.links.length > 0, '官网 / PV 链接不该是空的');
  // 匹配候选是内部用的，不该进缓存（下次读出来也没用了）
  assert.ok(!('titleKeys' in rich), 'titleKeys 是匹配用的中间量，不该落盘');
});

test('标题 id 只由标题决定：换一页顺序不变', () => {
  assert.equal(yucItemId('顶点武装'), yucItemId('顶点武装'));
  assert.notEqual(yucItemId('顶点武装'), yucItemId('顶点武装2'));
});

/* ---------- 收录统计的容错 ---------- */

test('没有收录统计段落时，返回空统计而不是抛', () => {
  const s = parseIntroSummary('<html></html>');
  assert.deepEqual(s, { seasonName: '', total: null, breakdown: [] });
});

test('模糊匹配阈值是有意的：调低会误合并，这条钉住它', () => {
  assert.ok(FUZZY_MIN_RATIO >= 0.7 && FUZZY_MIN_RATIO <= 0.85, `阈值跑到 ${FUZZY_MIN_RATIO} 了，得重新验证一遍误合并`);
});

/* ---------- 和「自己的库」对表 ---------- */

test('matchLibrary：完全同名直接对上', () => {
  const items = [{ id: 'y1', titleZh: '顶点武装' }];
  const lib = [{ id: 111, titleZh: '顶点武装', titleJa: 'VERTEX FORCE' }];
  const m = matchLibrary(items, lib);
  assert.equal(m.size, 1);
  assert.equal(m.get('y1')?.id, 111);
});

test('matchLibrary：番堂用简称、库里是全名，靠包含关系对上', () => {
  const items = [{ id: 'y1', titleZh: '和没有信徒的女神一起攻略异世界' }];
  const lib = [{ id: 222, titleZh: '和没有信徒的女神大人一起攻略异世界' }];
  const m = matchLibrary(items, lib);
  assert.equal(m.get('y1')?.id, 222, '简称/全名这种差异必须靠包含兜住，不然一半条目都是「没追」');
});

test('matchLibrary：库里没有的就不返回 —— 对不上是常态，不是错误', () => {
  const items = [{ id: 'y1', titleZh: '一个完全不存在的番剧名' }];
  const m = matchLibrary(items, [{ id: 1, titleZh: '顶点武装' }]);
  assert.equal(m.size, 0);
  assert.equal(m.get('y1'), undefined);
});

test('matchLibrary：一条库条目不会被两条番堂记录抢走', () => {
  /*
   * 「第 2 期」「第 3 期」在模糊匹配眼里长得几乎一样（相似度能到 0.9），
   * 所以光靠相似度拦不住。这里钉的是「登记掉」那一步：
   * 第一条拿走之后，第二条就只能自己去找别的（找不到就空着）。
   */
  const items = [
    { id: 'y1', titleZh: '某番 第2期' },
    { id: 'y2', titleZh: '某番 第3期' },
  ];
  const lib = [{ id: 9, titleZh: '某番 第2期' }];
  const m = matchLibrary(items, lib);
  assert.equal(m.get('y1')?.id, 9, '完全同名的那条必须先拿到');
  assert.equal(m.get('y2'), undefined, '第二条不该把同一条库记录再认领一次');
});

test('matchLibrary：脏输入不抛', () => {
  assert.equal(matchLibrary(null, null).size, 0);
  assert.equal(matchLibrary([{ id: 'y1', titleZh: '顶点武装' }], [null, 0, {}]).size, 0);
});
