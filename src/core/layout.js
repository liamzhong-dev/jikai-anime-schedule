/**
 * 卡片窗口的几何，以及「卡片内容显示多大」的一组档位。
 *
 * 放在这里而不是写在组件里，是因为这里恰好是最容易写错、
 * 错了以后表现成「手感怪怪的 / 怎么看都不对」而不是报错的那一类代码 ——
 * 副作用层里没法断言，纯函数层可以。
 *
 * ⚠️ 八方向缩放的换算（原来的 `resizeRect` / `RESIZE_DIRS` / `RESIZE_CURSOR`）
 * **已经删掉**：卡片窗口本身不再可缩放 —— 它能拉大，里面的封面和字还是原来那么大，
 * 用户真正想要的是「内容换个大小看」。那件事现在由下面的两个档位管。
 * 那套几何连同它的测试一起移除了：留着不用，只会在下一次改布局时把人带偏。
 */

export const MIN_CARD_W = 300;
export const MIN_CARD_H = 160;

/**
 * 番剧网格「一格留多宽」的档位范围。
 *
 * 这个值直接决定封面画多大 —— 也就是用户嘴里那个「封面图的大小」。
 */
export const CARD_MIN = { def: 112, min: 76, max: 220 };

/*
 * 乘上「窗口自适应倍率」之后的格宽。
 *
 * 上面那个 max 220 是**滑块能拉到**的范围，不是「画出来最大能有多大」：
 * 窗口放大 1.55 倍时，220 × 1.55 ≈ 341 才是合理结果。拿 220 去夹，
 * 表现就是「开了自适应、封面又拉满，最大化之后一点反应都没有」。
 */
export const CARD_MIN_SCALED = { min: 56, max: 360 };

/** 同上：只用于已经乘过自适应倍率的格宽，别拿它夹滑块的值。 */
export function clampCardMinScaled(v) {
  if (v === null || v === undefined || v === '') return CARD_MIN.def;
  const n = Number(v);
  if (!Number.isFinite(n)) return CARD_MIN.def;
  return Math.max(CARD_MIN_SCALED.min, Math.min(CARD_MIN_SCALED.max, Math.round(n)));
}

/**
 * 卡片里文字的大小倍率。
 *
 * 和 `CARD_MIN` 是一对：一个管封面画多大，一个管字多大。分开给是因为
 * 它们的最佳值不一样 —— 有人想一屏塞进更多封面（图和字一起小），
 * 也有人只想把字放大看清（图不动）。捆成一个「整体缩放」两个诉求都满足不了。
 */
export const FONT_SCALE = { def: 1, min: 0.85, max: 1.4, step: 0.05 };

/*
 * ⚠️ 这两个 clamp 都要**先把「没设」挑出去**，不能直接往 `Number()` 里塞：
 * `Number(null) === 0`、`Number('') === 0`，照直写就会把「没设」当成「0」，
 * 然后被抬到**下限**（0.85 / 76）—— 而下限是一个**有意义的值**，
 * 所以这种错永远不会报错：只是用户第一次打开时字是小的、封面是密的，
 * 谁也不知道是哪儿设歪的。
 * （`Number(undefined)` 是 NaN，能落到默认值 —— 于是只有 null / 空串这两条路会静默走偏，
 *   这种「一半对一半错」最容易骗过自测：随手试的那一次恰好是对的。）
 */
export function clampFontScale(v) {
  if (v === null || v === undefined || v === '') return FONT_SCALE.def;
  const n = Number(v);
  if (!Number.isFinite(n)) return FONT_SCALE.def;
  // 取整到两位：滑块步进是 0.05，浮点累加会攒出 1.0000000000000002 这种值，
  // 直接存进 state.json 又脏又难比对
  return Math.round(Math.max(FONT_SCALE.min, Math.min(FONT_SCALE.max, n)) * 100) / 100;
}

export function clampCardMin(v) {
  if (v === null || v === undefined || v === '') return CARD_MIN.def;
  const n = Number(v);
  if (!Number.isFinite(n)) return CARD_MIN.def;
  return Math.max(CARD_MIN.min, Math.min(CARD_MIN.max, Math.round(n)));
}

/*
 * 缩略图的整体倍率。
 *
 * 为什么要有这一层：`cardMin` 说的是「本季网格一格留多宽」，只有那个网格认它；
 * 追番 / 补番 / TierList / 日记 / 历程里的缩略图各自写死自己的 px。
 * 于是用户在本季把封面调到最大，换到 TierList 一看，一个像素都没动 ——
 * 那感觉就像功能坏了，其实是两个页面根本不共用一档。
 *
 * 现在由 `cardMin` 派生出一个**倍率**喂给所有封面：只有一个滑块，全站一起变。
 * 不额外新增一个设置键，是为了不让「封面尺寸」在设置里出现两次。
 */
export const COVER_SCALE = { def: 1, min: 0.6, max: 2, step: 0.02 };

export function clampCoverScale(v) {
  if (v === null || v === undefined || v === '') return COVER_SCALE.def;
  const n = Number(v);
  // 0 和负数在这里没有意义（会出现除零 / 缩略图反向塌成一条线），退回默认
  if (!Number.isFinite(n) || n <= 0) return COVER_SCALE.def;
  return Math.round(Math.max(COVER_SCALE.min, Math.min(COVER_SCALE.max, n)) * 100) / 100;
}

/**
 * 「封面尺寸」那一档 → 全站倍率。
 *
 * `CARD_MIN.def` 是基准：本季网格保持默认宽度时，别处的缩略图也正好是它们原来的尺寸
 * —— 这是有意对齐的，换个默认值不该让整个软件所有页面的图一起变大。
 */
export function coverScaleFromCardMin(cardMin) {
  return clampCoverScale(clampCardMin(cardMin) / CARD_MIN.def);
}

/**
 * 把一张卡的摆位缩到画布里去。
 *
 * 默认摆位是按 1440 宽的窗口定的（见 `layoutPresets.js`），窗口一窄，
 * 卡片就比画布还宽 —— 于是得先把页面滚动条拖到右下角才看得全。
 * 这正是「卡片只有那么大、很麻烦」的来源。
 *
 * ⚠️ **只在用户没摆过这张卡的时候用一次**，绝不覆盖用户自己的摆位 ——
 * 用户把卡片拖到画布外是常有的事（多屏、临时挪开），那是他的选择。
 *
 * ⚠️ 卡片不能缩放之后，这一步更必要了：用户**没有别的办法**把超宽的卡片收回来。
 */
export function fitRect(rect, { availW, availH, minW = MIN_CARD_W, minH = MIN_CARD_H } = {}) {
  const r = { x: 0, y: 0, w: minW, h: minH, ...(rect ?? {}) };
  const aw = Number(availW);
  const ah = Number(availH);
  // 量不出来（还没布局完、拿不到父元素）就原样返回 —— 宁可先摆大一点，
  // 也不要因为一次读不到尺寸就把卡片永久缩成一条缝。
  if (!Number.isFinite(aw) || !Number.isFinite(ah) || aw <= 0 || ah <= 0) return { ...r };
  return {
    ...r,
    w: Math.min(r.w, Math.max(minW, Math.round(aw))),
    h: Math.min(r.h, Math.max(minH, Math.round(ah))),
  };
}
