/**
 * 窗口尺寸 → 界面倍率。
 *
 * 这一组断言守的是「窗口变大了，内容到底有没有跟着变」—— 错了不报错，
 * 只表现为最大化之后界面纹丝不动，或者宽屏上字大得离谱。
 * 所以除了数值本身，还要守住单调性（越宽越大）和两端的夹逼。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CANVAS_BASE,
  CANVAS_SCALE,
  COVER_SCALE_OUT,
  FONT_SCALE_OUT,
  UI_BASE_W,
  UI_SCALE,
  canvasScale,
  cardMinScaled,
  mixScale,
  spacingScale,
  uiScale,
} from '../src/core/scale.js';

test('基准宽度处倍率正好是 1：照设计稿画', () => {
  assert.equal(uiScale(UI_BASE_W), 1);
});

test('量不出宽度就按 1 走，不猜', () => {
  // 这三种都是「还没有窗口」：SSR、最小化、布局前读不到。
  // 猜任何一个数字都会让首帧跳一下，1 是唯一安全的。
  assert.equal(uiScale(0), 1);
  assert.equal(uiScale(null), 1);
  assert.equal(uiScale(Number.NaN), 1);
});

test('越宽越大，且在 clamp 区间内单调', () => {
  const widths = [1000, 1200, 1440, 1680, 1920, 2200, 2560];
  const vals = widths.map((w) => uiScale(w));
  for (let i = 1; i < vals.length; i += 1) {
    // 反向守卫：被 clamp 压平的那一段（1000 → 1200 都贴着下限）不算变小的错
    assert.ok(vals[i] >= vals[i - 1], `${widths[i]}px 的倍率不该比 ${widths[i - 1]}px 小`);
  }
});

test('两端都夹得住：窄屏不缩成蚂蚁，宽屏不放大成海报', () => {
  assert.ok(uiScale(800) >= UI_SCALE.min);
  assert.ok(uiScale(3840) <= UI_SCALE.max);
  // 反向：不夹的话 3840 会到 1 + (2.667-1)*0.65 ≈ 2.08
  assert.ok(uiScale(3840) < 2.08 - 0.4);
});

test('倍率是量化过的：拖窗口不会每像素触发一次全站重排', () => {
  for (const w of [1450, 1451, 1452, 1510, 1600, 1720]) {
    const v = uiScale(w);
    assert.equal(Math.round(v * 100) / 100, v, `${w}px → ${v} 不是 0.01 的整数倍`);
  }
  // 反向：相邻两像素几乎总是同一个值（真连续的话这里会红）
  assert.equal(uiScale(1450), uiScale(1451));
});

test('窗口最窄时不会低于下限', () => {
  // 主进程 minWidth 是 1000，那是真实能到的最窄
  assert.equal(uiScale(1000), UI_SCALE.min);
});

test('间距涨得比内容慢', () => {
  assert.equal(spacingScale(1), 1);
  const u = 1.5;
  const sp = spacingScale(u);
  assert.ok(sp > 1 && sp < u, `间距倍率 ${sp} 应落在 1 与内容倍率 ${u} 之间`);
  // 反向：间距跟内容同倍放大，一屏就装不下东西了
  assert.ok(sp < 1 + (u - 1));
});

test('手动档位叠加自适应后不被吃回去', () => {
  // 用户把字拉到最大又全屏：1.4 × 1.55 会被夹到 1.8，但**必须还大于 1.4** ——
  // 用档位那一套窄区间夹的话会退回 1.4，等于用户白拉了。
  const out = mixScale(1.4, UI_SCALE.max);
  assert.ok(out > 1.4, `全屏时的大字号偏好被吃掉了：${out}`);
  assert.ok(out <= FONT_SCALE_OUT.max);
});

test('默认档位 × 自适应 = 自适应本身', () => {
  assert.equal(mixScale(1, 1.22), 1.22);
  assert.equal(mixScale(1, 1), 1);
});

test('封面倍率也有自己的上限，不跟着文字的上限走', () => {
  const out = mixScale(2, UI_SCALE.max, COVER_SCALE_OUT);
  assert.ok(out <= COVER_SCALE_OUT.max);
  assert.ok(out > 2, `封面倍率被夹回档位上限了：${out}`);
});

test('网格一格的最小宽度跟着窗口走：不然只会多出几列，卡片还是那么大', () => {
  const base = cardMinScaled(112, 1);
  const wide = cardMinScaled(112, uiScale(1920));
  assert.equal(base, 112);
  assert.ok(wide > base, `1920 宽时一格应比 ${base}px 大，实际 ${wide}px`);
  // 反向：不乘倍率的话两处相等 —— 「最大化没变化」正是这么来的
  assert.notEqual(cardMinScaled(112, 1.3), cardMinScaled(112, 1));
});

test('一格再怎么缩也留得下封面', () => {
  assert.ok(cardMinScaled(76, UI_SCALE.min) >= 64);
  assert.ok(cardMinScaled(null, 1) > 0);
});

/* ---------------------------------------------------------------------------
 * 画布摆位的等比缩放
 * --------------------------------------------------------------------------- */

test('设计基准处画布倍率正好是 1：摆位原样落下来', () => {
  const { kx, kh } = canvasScale(CANVAS_BASE.w, CANVAS_BASE.h);
  assert.equal(kx, 1);
  assert.equal(kh, 1);
});

test('窗口最大化后卡片真的跟着变大 —— 「全屏没变化」这一条的根', () => {
  // 1920×1040 是 1440×900 最大化后的常见尺寸
  const { kx } = canvasScale(1920, 1040);
  assert.ok(kx > 1.2, `1920 宽时横向倍率应明显大于 1，实际 ${kx}`);
  // 反向：不缩放的话 kx 恒为 1，卡片永远 1260 宽、右边一整块空白
  assert.notEqual(kx, 1);
});

test('摆位缩放后整块版面仍然落在画布内，不会溢出', () => {
  // 这是这套算法的安全前提：基准尺寸内的一条边，等比缩放后仍在画布内。
  const rect = { x: 16, y: 16, w: 1260, h: 622 };
  for (const [w, h] of [[1440, 900], [1920, 1040], [2560, 1400], [1000, 660]]) {
    const { kx, kh } = canvasScale(w, h);
    assert.ok((rect.x + rect.w) * kx <= w + 0.5, `${w} 宽：右边缘 ${(rect.x + rect.w) * kx} 超出了画布`);
    assert.ok((rect.y + rect.h) * kh <= h + 0.5, `${h} 高：下边缘 ${(rect.y + rect.h) * kh} 超出了画布`);
  }
});

test('画布倍率两端都夹得住', () => {
  const narrow = canvasScale(600, 400);
  assert.ok(narrow.kx >= CANVAS_SCALE.min);
  assert.ok(narrow.kh >= CANVAS_SCALE.minH);
  const wide = canvasScale(7680, 4320);
  assert.ok(wide.kx <= CANVAS_SCALE.max);
  assert.ok(wide.kh <= CANVAS_SCALE.max);
});

/*
 * 纵向**只放大不缩小**。
 *
 * 反向用例：把 minH 也设成 0.62，下面这条会红 —— 而红了之后用户看到的
 * 就是「本季概览」盖住了「番剧库」。这条不是洁癖，是自检实测出来的重叠。
 */
test('纵向倍率不会小于 1：压缩它会让概览卡压到下面那张卡上', () => {
  for (const [w, h] of [[1000, 660], [1280, 720], [1440, 900], [1920, 1080]]) {
    const { kh } = canvasScale(w - 32, h - 72);
    assert.ok(kh >= 1, `${w}×${h} 的纵向倍率 ${kh} 小于 1 —— 高度由内容决定的卡片会被压到下一张上`);
  }
  // 反向：窄窗口下横向是可以小于 1 的，别把两条一起收紧
  assert.ok(canvasScale(900, 700).kx < 1);
});

test('量不出画布尺寸就按 1 走，不猜', () => {
  const a = canvasScale(0, 0);
  assert.equal(a.kx, 1);
  assert.equal(a.kh, 1);
  const b = canvasScale(undefined, null);
  assert.equal(b.kx, 1);
  assert.equal(b.kh, 1);
});

test('两个方向各算各的：宽屏横向铺开更多，纵向只跟着变高一点', () => {
  // 1920×1040：横向 +33%，纵向 +16% —— 各自按自己的可用空间算，
  // 捆成一个倍率的话要么上下留一条、要么左右空一片。
  const { kx, kh } = canvasScale(1920, 1040);
  assert.ok(kx > kh, `横向倍率 ${kx} 应大于纵向 ${kh}`);
});
