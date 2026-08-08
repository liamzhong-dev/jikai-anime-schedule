/**
 * 全虚构的番剧数据 —— 只给测试用，不进应用产物。
 *
 * 这里出现的番剧名、制作公司、评分、人数都是编造的。应用本身用的是
 * 内置真实数据（src/data/builtin/）与联网数据源，不引用这个文件。
 *
 * 留它的理由：测调度、倒计时、状态推算这些纯逻辑时，需要「时间点、
 * 星期、话数」完全可控的样本。真实数据会随时间变，断言写不稳。
 *
 * begin 按「日本时间」构造：以当前周的周一为锚点回退若干周，
 * 保证任何时候跑测试，都有「已更新 / 即将更新 / 已完结」三种状态的番剧。
 */

const JST_MS = 9 * 3600000;
const DAY_MS = 86400000;

// 虚构条目：中文名 / 假名风格的原名 / 首播星期(0=周日) / JST 时刻 / 话数 / 制作 / 标签 / 评分 / 在看
const SEED = [
  ['雾灯的守夜人', 'キリビノモリ', 2, '25:30', 12, '灯屋工房', ['奇幻', '治愈'], 7.8, 12400],
  ['第七放映厅', 'ナナバンシアター', 4, '23:00', 12, '赤道动画', ['悬疑', '群像'], 8.1, 20300],
  ['鲸落电台', 'ゲイラクラジオ', 6, '22:00', 13, '潮汐社', ['音乐', '青春'], 6.9, 5100],
  ['铁皮邮差', 'ブリキノユウビン', 1, '24:30', 12, '北街工房', ['科幻', '旅行'], 7.4, 8900],
  ['砂糖与枪油', 'サトウトジュウユ', 3, '25:00', 24, '南岛映画', ['动作', '蒸汽'], 7.1, 15200],
  ['春日邮筒', 'ハルヒノポスト', 5, '21:00', 12, '灯屋工房', ['日常', '治愈'], 8.4, 26800],
  ['碎冰航线', 'コオリノコウセン', 0, '23:30', 12, '极地工作室', ['冒险', '海洋'], 7.0, 6300],
  ['电子盆栽', 'デンシ盆栽', 2, '22:30', 12, '绿屋动画', ['日常', '科幻'], 6.6, 3400],
  ['第七封回信', 'ナナメノヘンシン', 4, '25:30', 12, '赤道动画', ['恋爱', '悬疑'], 7.6, 11100],
  ['纸鹤航班', 'カミツルフライト', 1, '19:30', 24, '青空工房', ['冒险', '成长'], 7.9, 18700],
  ['午夜食堂账本', 'ミッドナイトチョウ', 6, '26:00', 12, '深夜亭', ['美食', '人情'], 8.2, 22400],
  ['盐粒纪年', 'エンリュウキネン', 3, '22:00', 12, '白盐社', ['历史', '群像'], 7.2, 7600],
  ['玻璃动物园', 'ガラスノドウブツ', 5, '23:30', 12, '透明工房', ['寓言', '奇幻'], 6.8, 4200],
  ['灯塔维修班', 'トウダイメンテ', 0, '20:00', 12, '灯屋工房', ['职场', '治愈'], 7.5, 9800],
  ['雨声录音带', 'アマオトテープ', 2, '24:00', 13, '潮汐社', ['音乐', '日常'], 7.3, 6900],
  ['旧书市集的最后一页', 'コボンイチ', 4, '22:30', 12, '纸页社', ['文学', '怀旧'], 8.0, 13500],
  ['齿轮与蒲公英', 'ハグルマタンポポ', 1, '25:00', 24, '南岛映画', ['蒸汽', '冒险'], 7.7, 16900],
  ['夜行巡道车', 'ヤコウジュンドウ', 3, '26:30', 12, '极地工作室', ['悬疑', '夜景'], 7.1, 5800],
];

const SEASON_START_WEEKS_AGO = 5;

function jstMondayUtc(nowMs, weeksBack = 0) {
  const jst = new Date(nowMs + JST_MS);
  const dow = jst.getUTCDay();
  const back = (dow + 6) % 7;
  const jstMidnightUtc = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate()) - JST_MS;
  return jstMidnightUtc - back * DAY_MS - weeksBack * 7 * DAY_MS;
}

function parseClock(time) {
  const [h, m] = time.split(':').map(Number);
  return (h * 60 + m) * 60000;
}

/**
 * 把「日本播出星期」换算成相对本周一的偏移天数。
 *
 * SEED 里的星期是播出习惯的写法（0 = 周日），而锚点 monday 是周一，
 * 中间必须补一次偏移；直接拿 0 当周一用，整张演示时间表会集体前移一天，
 * 而且周日那一列永远是空的。
 */
const weekdayOffset = (weekday) => (weekday + 6) % 7;

function coverGradient(seed) {
  // 由名字派生一对稳定的色相，避免引用任何外部图片
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return { from: `hsl(${h} 62% 46%)`, to: `hsl(${(h + 48) % 360} 58% 32%)` };
}

export function buildMockSeason(nowMs = Date.now()) {
  const monday = jstMondayUtc(nowMs, SEASON_START_WEEKS_AGO);
  return SEED.map((row, i) => {
    const [titleZh, titleJa, weekday, time, eps, studio, tags, score, watchers] = row;
    const beginMs = monday + weekdayOffset(weekday) * DAY_MS + parseClock(time);
    return {
      id: 900000 + i,
      titleZh,
      titleJa,
      begin: new Date(beginMs).toISOString(),
      broadcast: `R/${new Date(beginMs).toISOString()}/P7D`,
      eps,
      platform: weekday === 6 || weekday === 0 ? 'WEB' : 'TV',
      studio,
      tags,
      score,
      watchers,
      summary: `《${titleZh}》是虚构演示条目：${tags.join(' / ')}。本季由${studio}制作，共 ${eps} 话。`,
      season: demoSeasonKey(beginMs),
      cover: coverGradient(titleZh),
      external: {
        bangumi: 'https://bgm.tv/subject_search/' + encodeURIComponent(titleJa),
        moegirl: 'https://zh.moegirl.org.cn/index.php?search=' + encodeURIComponent(titleZh),
      },
    };
  });
}

function demoSeasonKey(ms) {
  const d = new Date(ms + JST_MS);
  return `${d.getUTCFullYear()}q${Math.ceil((d.getUTCMonth() + 1) / 3)}`;
}

/** 虚构的老番，用于补番清单演示 */
export function buildMockArchive(nowMs = Date.now()) {
  const defs = [
    ['旧月台的钟', 'フルイプラットホーム', 26, 2019],
    ['南岛的雨季', 'ナントウノウキ', 13, 2021],
    ['铁皮星图', 'ブリキセイズ', 24, 2020],
    ['纸页社短篇集', 'シペイシャタンペン', 12, 2022],
    ['雾灯前传', 'キリビゼンデン', 12, 2018],
  ];
  return defs.map(([titleZh, titleJa, eps, year], i) => {
    const beginMs = Date.UTC(year, 3, 6) - JST_MS;
    return {
      id: 800000 + i,
      titleZh,
      titleJa,
      begin: new Date(beginMs).toISOString(),
      broadcast: `R/${new Date(beginMs).toISOString()}/P7D`,
      eps,
      platform: 'TV',
      studio: ['灯屋工房', '赤道动画', '南岛映画', '纸页社'][i % 4],
      tags: [['怀旧', '群像'], ['青春', '雨'], ['科幻', '旅行'], ['文学', '短篇'], ['奇幻', '前传']][i],
      score: 7.2 + i * 0.3,
      watchers: 4200 + i * 1700,
      summary: `《${titleZh}》是虚构的老番演示条目，共 ${eps} 话。`,
      season: `${year}q2`,
      cover: coverGradient(titleZh),
      external: {
        bangumi: 'https://bgm.tv/subject_search/' + encodeURIComponent(titleJa),
        moegirl: 'https://zh.moegirl.org.cn/index.php?search=' + encodeURIComponent(titleZh),
      },
    };
  });
}

/** 虚构的用户状态：追了 6 部，进度各不相同；补番清单 5 张卡 */
export function buildMockUserState(season, archive, nowMs = Date.now()) {
  const following = {};
  const picks = [0, 3, 5, 8, 10, 13];
  const watched = [4, 5, 4, 3, 5, 2];
  picks.forEach((idx, k) => {
    const a = season[idx];
    if (!a) return;
    following[a.id] = { status: k === 4 ? 'on_hold' : 'watching', watchedEps: watched[k], notify: true };
  });

  const offsets = [-3, 0, 2, 12, 40]; // 逾期 / 今天 / 三天内 / 宽裕 / 更宽裕
  const watchedEps = [18, 9, 6, 0, 12];
  const catchup = archive.map((a, i) => ({
    id: `catchup-${a.id}`,
    subjectId: a.id,
    deadline: nowMs + offsets[i] * DAY_MS,
    watchedEps: watchedEps[i],
    targetEps: a.eps,
    archived: i === 4,
    createdAt: nowMs - (5 - i) * DAY_MS,
  }));

  return { following, catchup };
}
