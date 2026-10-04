/**
 * 窗口尺寸 → 界面倍率。
 *
 * 放在纯函数层是因为这一层**最容易写错成「看起来没错」**：倍率这种东西
 * 错了不报错，只表现为「手感怪怪的」—— 窗口拉大的时候该大不大、或者说
 * 该稳的地方跟着一起变大。副作用层里没法断言，这里可以。
 *
 * ---------------------------------------------------------------------------
 * 为什么要有这一层
 * ---------------------------------------------------------------------------
 * 原来只有两个**手动档位**（`--fs` 文字、`--cs` 封面），倍率完全由用户拉的
 * 滑块决定，跟窗口多大一点关系都没有。于是把窗口从 1440 拉到 1920：
 * 列数多了两列、两边留白，而卡片、字号、间距一个像素都没动 —— 看起来就是
 * 「最大化了但界面没跟着变」。用户真正想要的是「窗口多大，内容就多大」，
 * 这件事不该靠他去拉滑块。
 *
 * 所以现在倍率是**两段相乘**：
 *
 *     最终倍率 = 用户档位（个人偏好）× 窗口自适应倍率（这一层算的）
 *
 * 手动档位保留，但含义变成「在自动的基础上再偏一点」：有人就是想字再大一号，
 * 那是偏好，不是让他去补自动化的缺。
 *
 * ---------------------------------------------------------------------------
 * 三个不显然的取舍
 * ---------------------------------------------------------------------------
 * 1. **不能直接线性跟随窗口**（`u = w / 1440`）。
 *    2560 的屏上倍率会到 1.78 —— 11px 的辅助文字变成 19.6px，整屏只剩几个
 *    大字。窗口尺寸的变化幅度远大于「内容该变化的幅度」，所以加一个阻尼
 *    （`damp`）：窗口翻倍，内容只放大 1 + (2-1)*0.65 ≈ 1.65 倍。
 *
 * 2. **必须量化**（`step` 0.01）。
 *    改 root 上的变量会触发**全站重排**。拖窗口时每来一帧就重排一次，
 *    1440 → 1920 这一下就是几百次 —— 表现出来是拖动卡顿。量化到 0.01 之后
 *    大约每 14px 才真的变一次，肉眼看还是连续的，代价小了两个数量级。
 *    （本机还有 backdrop-filter 那条老账：越大面积越贵，别再叠重排。）
 *
 * 3. **间距比内容更保守**（`SPACING_DAMP`）。
 *    字号放大 20% 是「看得更清」，间距放大 20% 是「一屏少了三分之一内容」。
 *    留白比字更容易失控，所以间距共用同一个倍率但再压一道。
 */

/** 设计基准宽度：这套界面是按 1440 宽的窗口定的，基准处倍率正好是 1。 */
export const UI_BASE_W = 1440;

/**
 * 自适应倍率的可用区间与形状。
 *
 * `min` 0.9 而不是更低：窗口最窄 1000px（主进程 `minWidth`），那时倍率约 0.9；
 * 再小下去卡片里的字就没法看了 —— 宁可让用户滚动，也不要把字缩成蚂蚁。
 */
export const UI_SCALE = { min: 0.9, max: 1.55, step: 0.01, damp: 0.65 };

/** 间距相对「内容倍率」再压一道（见上面第 3 条）。 */
export const SPACING_DAMP = 0.6;

/** 最终落到 CSS 上的上限：手动档位还能再往上偏，但不能偏到失控。 */
export const FONT_SCALE_OUT = { min: 0.78, max: 1.8 };
export const COVER_SCALE_OUT = { min: 0.6, max: 2.6 };

function clampNum(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function quantize(v, step) {
  /*
   * 量化到 step 的整数倍，并**消掉浮点尾巴**。
   *
   * ⚠️ `Math.round(v / 0.01) * 0.01` 不是干净的：113 * 0.01 在双精度里是
   * 1.1300000000000001，写进 CSS 变量、存进 state.json 都带着这串尾巴，
   * 断言也只能写成近似比较 —— 那就等于没有断言。
   */
  return Number((Math.round(v / step) * step).toFixed(4));
}

/**
 * 窗口宽度 → 内容倍率（连续，但已量化）。
 *
 * @param {number} width 窗口内容宽度（CSS px，也就是 `window.innerWidth`）
 * @param {{base?:number, damp?:number, min?:number, max?:number, step?:number}} [opts]
 * @returns {number} 倍率，一定落在 [min, max] 内
 */
export function uiScale(width, opts = {}) {
  const base = Number(opts.base) || UI_BASE_W;
  const damp = Number.isFinite(opts.damp) ? opts.damp : UI_SCALE.damp;
  const min = Number.isFinite(opts.min) ? opts.min : UI_SCALE.min;
  const max = Number.isFinite(opts.max) ? opts.max : UI_SCALE.max;
  const step = Number(opts.step) > 0 ? opts.step : UI_SCALE.step;

  const w = Number(width);
  // 量不出来（SSR、窗口还没布局、最小化时某些平台给 0）就按基准走：
  // 倍率 1 是「照设计稿画」，任何猜的数字都比它危险。
  if (!Number.isFinite(w) || w <= 0) return 1;

  const raw = 1 + (w / base - 1) * damp;
  return clampNum(quantize(raw, step), min, max);
}

/**
 * 内容倍率 → 间距倍率。
 *
 * 内容 1.5 倍时间距只有 1.3 倍：留白涨得比字慢，一屏才装得下东西。
 */
export function spacingScale(u) {
  const n = Number(u);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return quantize(1 + (clampNum(n, UI_SCALE.min, UI_SCALE.max) - 1) * SPACING_DAMP, 0.005);
}

/**
 * 手动档位 × 自适应倍率，夹到最终区间。
 *
 * 为什么两档要分开夹：档位本身有它的合理区间（0.85–1.4 是「偏好」），
 * 乘上窗口倍率之后再用**另一套**更宽的区间夹一次 —— 用同一套区间夹会让
 * 用户的大字号偏好在全屏时被吃掉（1.4 × 1.55 被夹回 1.4，等于白拉）。
 */
export function mixScale(userScale, u, out = FONT_SCALE_OUT) {
  const a = Number(userScale);
  const b = Number(u);
  const av = Number.isFinite(a) && a > 0 ? a : 1;
  const bv = Number.isFinite(b) && b > 0 ? b : 1;
  return clampNum(quantize(av * bv, 0.01), out.min, out.max);
}

/**
 * 网格「一格留多宽」：手动档位 × 自适应倍率。
 *
 * 这一处是「窗口变大了卡片也该变大」的关键 —— 不乘这一下的话，
 * auto-fill 只会把多出来的宽度换成**更多列**，每张卡还是原来那么大。
 */
export function cardMinScaled(cardMin, u) {
  const a = Number(cardMin);
  const b = Number(u);
  const av = Number.isFinite(a) && a > 0 ? a : 112;
  const bv = Number.isFinite(b) && b > 0 ? b : 1;
  return Math.max(64, Math.round(av * bv));
}

/* ---------------------------------------------------------------------------
 * 画布：卡片摆位的等比缩放
 * ---------------------------------------------------------------------------
 * 上面那一组管的是**内容**（字、封面、间距），这一组管的是**卡片本身**。
 *
 * 卡片摆位存的是绝对 px，而且是按 1440×900 的窗口定的。窗口最大化到 1920 时，
 * 卡片还是 1260 宽，右边凭空多出一大块空白 —— 这就是「全屏了但界面没跟着
 * 铺开」的来源。用户能做的只有一张张去拖，而拖动的结果下次启动又还在原处。
 *
 * 做法：**存盘的摆位不动**（它就是「1440 宽时那张卡该在哪、该多大」这份设计），
 * 渲染时按 `kx / kh` 乘一次。好处是零兼容风险 —— 老 state.json 一个字不用改，
 * 而且用户拖过的相对位置完整保留（拖到右下角的缩放后依然在右下角）。
 *
 * 两个方向分开给倍率，而不是整体 `transform: scale()`：
 *   - `transform` 会把字一起放大，和上面的 `--u` 叠成双重放大；
 *   - 非整数倍缩放下文字会发虚，而这套界面本来就在和 backdrop-filter 抢性能；
 *   - 绝对定位换成 calc() 之后，倍率一变浏览器自己重排，不需要重渲染 React 树。
 */

/*
 * 摆位的设计基准：**画布的可用尺寸**，不是窗口尺寸。
 *
 * ⚠️ 这两个数是**量出来的**（1440×900 的窗口下 `.canvas` 的 clientWidth /
 * clientHeight 分别是 1342 与 808），不是从窗口宽高减骨架算出来的 ——
 * 侧栏宽度和画布内边距都写在 CSS 里、还跟着间距倍率一起变，在这儿再抄一份
 * 数字，改样式的时候必然对不上。
 *
 * 一开始按 1440×900 算，结果在设计窗口下 kx 只有 0.93：卡片凭空比设计稿
 * 小了一圈，看上去就是「刚打开，卡片之间空得莫名其妙」。
 */
export const CANVAS_BASE = { w: 1342, h: 808 };

/**
 * 画布倍率的可用区间。
 *
 * `min` 0.62：窗口最窄 1000px，减去侧栏与内边距后大约 900 —— 那时卡片缩到
 * 0.62 倍才装得下。再小下去卡片里的网格就只剩一列了，宁可让它滚动。
 * `max` 2.4：留到 3440 的超宽屏也够用，再大纯属意外。
 *
 * ⚠️ `minH` 是 **1，不是 0.62**：纵向只放大、不缩小。
 *
 * 这不是偷懒，是被一条真实的重叠逼出来的。「本季概览」那张卡的高度是
 * **内容给的**（`fitHeight`，它当初就是为了让四个统计块不被切掉才改成 auto 的），
 * 不跟着纵向倍率走。于是纵向一压缩，它的 `top` 往上挪、下一张卡的 `top` 也
 * 往上挪，而它自己的高度纹丝不动 —— 两张卡叠在一起（自检实测 gridGap 为负）。
 * 纵向只放大时，两张卡的 top 一起往下走、间距只会变大，怎么都不会压到一起。
 * 窄窗口的代价是卡片纵向不收、可能出现滚动条 —— 那本来就是原来的行为。
 */
export const CANVAS_SCALE = { min: 0.62, max: 2.4, minH: 1, step: 0.005 };

/**
 * 画布可用尺寸 → 两个方向的倍率。
 *
 * @param {number} availW 画布可用宽度（CSS px）
 * @param {number} availH 画布可用高度
 * @returns {{kx:number, kh:number}} 一定落在 [min, max] 内；量不出来时都是 1
 */
export function canvasScale(availW, availH, opts = {}) {
  const bw = Number(opts.baseW) > 0 ? Number(opts.baseW) : CANVAS_BASE.w;
  const bh = Number(opts.baseH) > 0 ? Number(opts.baseH) : CANVAS_BASE.h;
  const min = Number.isFinite(opts.min) ? opts.min : CANVAS_SCALE.min;
  const minH = Number.isFinite(opts.minH) ? opts.minH : CANVAS_SCALE.minH;
  const max = Number.isFinite(opts.max) ? opts.max : CANVAS_SCALE.max;
  const step = Number(opts.step) > 0 ? opts.step : CANVAS_SCALE.step;

  const one = (avail, base, lo) => {
    const a = Number(avail);
    // 量不出来（还没布局、画布隐藏）就按 1 走 —— 那是「照设计稿画」，
    // 比任何猜出来的倍率都安全，下一帧量到了自然会跟上。
    if (!Number.isFinite(a) || a <= 0) return 1;
    return clampNum(quantize(a / base, step), lo, max);
  };

  return { kx: one(availW, bw, min), kh: one(availH, bh, minH) };
}
