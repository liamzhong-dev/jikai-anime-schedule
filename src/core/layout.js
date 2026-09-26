/**
 * 卡片窗口的几何。
 *
 * 放在这里而不是写在组件里，是因为这几件事**只有在真机上拖得动**：
 * 八方向缩放的换算、以及「默认摆位比画布还宽」的适配。
 * 副作用层里没法断言，纯函数层可以 —— 而且这里恰好是最容易写错、
 * 错了以后表现成「手感怪怪的」而不是报错的那一类代码。
 */

export const MIN_CARD_W = 300;
export const MIN_CARD_H = 160;

/** 八个把手；`se` 是原来唯一有的那一个 */
export const RESIZE_DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

/** 每个把手该用哪个鼠标指针（斜角两个方向的命名是反的，别按直觉写） */
export const RESIZE_CURSOR = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
};

/** 番剧网格「一格留多宽」的档位范围 */
export const CARD_MIN = { def: 112, min: 76, max: 220 };

export function clampCardMin(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return CARD_MIN.def;
  return Math.max(CARD_MIN.min, Math.min(CARD_MIN.max, Math.round(n)));
}

/**
 * 拖了某个把手之后，卡片该在哪儿。
 *
 * 三件容易写错的事都在这里定死：
 *
 * ① **西 / 北两侧改的是 x / y，不只是宽高。** 抓住左边往左拖，意思是
 *    「左边再往外一点」，右边缘必须钉住不动；只改 `w` 的话卡片会整体平移。
 *
 * ② **夹到最小尺寸时要把「吃掉的那部分」还给 x / y。** 否则宽度已经到底了、
 *    手继续往右拖，卡片的左边缘还会跟着跑 —— 看起来就是卡片在飘。
 *
 * ③ **西 / 北两侧不许越过画布左上角。** 所以最大尺寸是「原右 / 下边缘」
 *    （`x + w`）而不是无限：左边最多拖到 0。
 *
 * 取整是因为 `clientX` 在高分屏上会是小数，直接存进去的话
 * `state.json` 里会攒出一堆 300.5 这种值。
 *
 * @param {{base:{x,y,w,h}, dx?:number, dy?:number, dir?:string, minW?:number, minH?:number}} o
 */
export function resizeRect({ base, dx = 0, dy = 0, dir = 'se', minW = MIN_CARD_W, minH = MIN_CARD_H }) {
  const b = base ?? { x: 0, y: 0, w: minW, h: minH };
  // 认不出来的方向退成右下角（原来唯一有的那个）。不这么写的话，
  // 一个拼错的方向名会让这个函数「什么都不做」—— 拖起来就是把手完全不响应。
  const raw = String(dir ?? 'se');
  const d = RESIZE_DIRS.includes(raw) ? raw : 'se';

  let w = b.w;
  let h = b.h;
  if (d.includes('e')) w = b.w + dx;
  if (d.includes('s')) h = b.h + dy;
  if (d.includes('w')) w = b.w - dx;
  if (d.includes('n')) h = b.h - dy;

  let x = b.x;
  let y = b.y;

  if (d.includes('w')) {
    const maxW = Math.max(minW, b.x + b.w);
    w = Math.min(Math.max(minW, w), maxW);
    x = b.x + (b.w - w);
  } else {
    w = Math.max(minW, w);
  }

  if (d.includes('n')) {
    const maxH = Math.max(minH, b.y + b.h);
    h = Math.min(Math.max(minH, h), maxH);
    y = b.y + (b.h - h);
  } else {
    h = Math.max(minH, h);
  }

  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/**
 * 把一张卡的摆位缩到画布里去。
 *
 * 默认摆位是按 1440 宽的窗口定的（见 `layoutPresets.js`），窗口一窄，
 * 卡片就比画布还宽 —— 于是得先把页面滚动条拖到右下角，才够得着缩放把手，
 * 而右下角那个把手原本还是唯一的缩放入口。这正是「卡片只有那么大、
 * 很麻烦」的来源。缩进画布之后就不需要滚动条了。
 *
 * ⚠️ **只在用户没摆过这张卡的时候用一次**，绝不覆盖用户自己的摆位 ——
 * 用户把卡片拖到画布外是常有的事（多屏、临时挪开），那是他的选择。
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
