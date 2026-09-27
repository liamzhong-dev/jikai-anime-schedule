/**
 * 备份文件的格式：导出什么、怎么认、怎么报数。
 *
 * 这一层是纯函数：只做「状态对象 → 一个可写盘的对象」和反过来的校验。
 * 落盘、弹窗、覆盖本机状态都在别处 —— 那些有副作用的事不该混进来，
 * 因为**这份格式是唯一一份「用户的记录长什么样」的约定**，
 * 它要是能随便写盘，就没法拿单测钉住「导出的东西是不是全」。
 *
 * 关于「导什么」，见 `EXPORTED_KEYS` 那一段 —— 有两个字段是**故意不导**的，
 * 理由写在那儿，别顺手补上。
 */

export const TRANSFER_APP = 'jikai';
export const TRANSFER_FORMAT = 1;

/**
 * 会跟着备份走的状态字段。
 *
 * 和 `store.js` 的 `snapshot()` 是同一批 —— 两边不一致的后果很隐蔽：
 * `snapshot()` 多的字段等于「导出缺一块」，导出多的字段等于「新设备上多一块莫名其妙的东西」。
 * 所以有一条测试专门对着这两个清单比。
 */
export const EXPORTED_KEYS = [
  'following',
  'catchup',
  'subjects',
  'groups',
  'layout',
  'layoutPresets',
  'activePreset',
  'tierlists',
  'diary',
  'reports',
  'settings',
];

/**
 * ⚠️ 故意**不**导出的东西：
 *
 * 1. **封面缓存、壁纸图片**（`coverCache` / `wallpaper.json`）。
 *    它们是几十 MB 的二进制，而且换台机器重新下一次就行；
 *    塞进备份会让文件从几十 KB 涨到几十 MB，用户传都传不过去。
 *    `settings.wallpaper` 本身也不导：那张图不跟着走，导一半过去等于留个坏配置。
 * 2. **`cache`**（内置数据的版本戳之类）。它描述的是「这台机器上装了什么」，
 *    不是用户的记录；跟着走会让新设备以为自己的内置数据是旧版。
 */
export const SKIPPED_KEYS = ['cache', 'settings.wallpaper'];

/** 备份文件名：带日期，方便用户在文件夹里认出哪个是新的 */
export function transferFileName(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const p = (n) => String(n).padStart(2, '0');
  return `jikai-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
}

/**
 * 「导出文件包」那个目录叫什么。
 *
 * 带时间戳是必须的：一次导出是「这一轮要交出去的东西」，
 * 而用户过两周再导一次时，最怕的就是第二次把第一次的内容盖掉。
 * 用本地时间（不是 UTC）—— 用户看到的时间要和他自己表上的对得上。
 */
export function bundleFolderName(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const p = (n) => String(n).padStart(2, '0');
  return `次回-导出-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * 文件包里的「说明.txt」。
 *
 * 写这个不是客套：那个目录会离开这台机器（发给别人、拷到另一台设备），
 * 而「数据备份.json 要拿程序里的『从备份导入』打开」这件事，
 * 除了这个文件没有任何地方会告诉接收的人。
 *
 * @param {{counts?:object, seasonName?:string, hasReport?:boolean, generatedAt?:number, appVersion?:string, note?:string}} opts
 */
export function bundleReadme({
  counts, seasonName = '', hasReport = false, generatedAt = Date.now(), appVersion = '', note = '',
} = {}) {
  const d = new Date(generatedAt);
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  const lines = [
    '次回 jikai · 导出文件包',
    '',
    `生成时间：${stamp}`,
    appVersion ? `程序版本：v${appVersion}` : null,
    `里面有：${describeCounts(counts)}`,
    '',
    '【怎么用】',
    '· 数据备份.json —— 里面是你全部的记录：追番、补番、日记、档位表、报告、外观设置。',
    '  在另一台设备上打开次回 → 设置 → 数据源 → 从备份导入…，选这个文件就行。',
    '  导入是整份替换，程序会先把那台设备现在的记录另存一份再覆盖。',
    '· 封面图片不在这份备份里 —— 那是几十 MB 的缓存，换台机器重新下一次就好。',
    hasReport
      ? `· 季度报告（${seasonName}）是一张长图，可以直接发出去。`
      : '· 这次没有报告长图：要带上它，先切到「季度报告」那一页，再导一次。',
    '',
    note ? `【这次要说的】\n${note}` : null,
    '',
    '—— 就这些。',
  ].filter((x) => x !== null);
  return `${lines.join('\n')}\n`;
}

/** 只挑出要带走的那几项，顺手深拷一份（不深拷的话调用方后面改了状态，备份也跟着变） */
function pickExported(state) {
  const src = state && typeof state === 'object' ? state : {};
  const out = {};
  for (const k of EXPORTED_KEYS) {
    const v = src[k];
    if (v === undefined) continue;
    out[k] = typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v));
  }
  /*
   * settings 整包带走，再把壁纸那一项**摘掉**。
   * 只按顶层键过滤是不够的 —— `settings.wallpaper` 是嵌在里面的，
   * 不摘的话它带着 `enabled / imgW / imgH` 一起过去，新设备上那张图并不存在，
   * 用户看到的是「壁纸开着、但是一片空」，比直接关着更难理解。
   * （dataUrl 本体本来就不在 state 里，它是单独的 wallpaper.json。）
   */
  if (out.settings && typeof out.settings === 'object') delete out.settings.wallpaper;
  return out;
}

/**
 * 造一份备份。
 *
 * `counts` 是**给人看的**：导入的时候要能在确认框里告诉用户
 * 「文件里有多少条记录、本机现在有多少条」—— 看不到这两个数，就没法判断该不该点确定。
 */
export function buildTransfer(state, { appVersion = '', nowMs = Date.now() } = {}) {
  const payload = {
    app: TRANSFER_APP,
    format: TRANSFER_FORMAT,
    exportedAt: nowMs,
    appVersion: String(appVersion ?? ''),
    counts: transferCounts(state),
    state: pickExported(state),
  };
  return payload;
}

/** 各集合条数。导入确认框和导出提示都用它，只算给人看的那几项 */
export function transferCounts(state) {
  const s = state && typeof state === 'object' ? state : {};
  const len = (v) => (Array.isArray(v) ? v.length : Object.keys(v && typeof v === 'object' ? v : {}).length);
  const diaryEntries = Object.values(s.diary && typeof s.diary === 'object' ? s.diary : {})
    .reduce((n, rec) => n + (Array.isArray(rec?.entries) ? rec.entries.length : 0), 0);
  return {
    following: len(s.following),
    catchup: len(s.catchup),
    diary: diaryEntries,
    tierlists: len(s.tierlists),
    reports: len(s.reports),
    subjects: len(s.subjects),
    groups: len(s.groups),
  };
}

/** 把 counts 说成一句人话 */
export function describeCounts(counts) {
  const c = counts && typeof counts === 'object' ? counts : {};
  const parts = [
    ['追番', c.following],
    ['补番', c.catchup],
    ['日记', c.diary],
    ['档位表', c.tierlists],
    ['报告', c.reports],
  ].filter(([, n]) => Number(n) > 0).map(([label, n]) => `${label} ${n}`);
  return parts.length ? parts.join(' · ') : '空空如也';
}

/**
 * 认一份备份文件。
 *
 * 只认自己家的格式，别的一律拒绝并说清为什么 ——
 * 「随手挑了个 json 也能导进去」是最危险的行为：它会把用户本机记录覆盖成一片空白。
 *
 * @returns {{ ok: true, payload: object } | { ok: false, error: string }}
 */
export function parseTransfer(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, error: '文件是空的' };

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: '不是合法的 JSON —— 是不是选错文件了？' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: '文件内容不是一个对象' };
  }
  if (data.app !== TRANSFER_APP) {
    return { ok: false, error: '这不是本程序导出的备份文件' };
  }
  const fmt = Number(data.format);
  if (!Number.isFinite(fmt) || fmt < 1) {
    return { ok: false, error: '备份文件没写格式版本' };
  }
  // 只挡「未来版本」，往下的都收：新版本导出的文件里可能有旧版本认不出的字段，
  // 那些字段会走 DEFAULTS，不影响能认出来的部分。
  if (fmt > TRANSFER_FORMAT) {
    return { ok: false, error: `这份备份是更新版本的程序导出的（格式 ${fmt}），当前程序只认到 ${TRANSFER_FORMAT}` };
  }
  if (!data.state || typeof data.state !== 'object' || Array.isArray(data.state)) {
    return { ok: false, error: '备份文件里没有记录数据（state 缺失）' };
  }

  /*
   * ⚠️ 一份**一个集合都没有**的 state 也要当错处理。
   * 一份正常导出的文件至少会有 settings；如果连它都没有，
   * 那多半是选到了别的程序的 json，或者是被手工截断过的文件 ——
   * 放它过去的结果是把用户本机的记录覆盖成空。
   */
  const hasAny = EXPORTED_KEYS.some((k) => data.state[k] !== undefined);
  if (!hasAny) return { ok: false, error: '备份文件里没有可识别的记录（像是被截断过）' };

  return { ok: true, payload: data };
}
