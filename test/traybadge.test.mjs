/**
 * 托盘角标。
 *
 * 这个功能是「画在 16×16 的小方块上」，肉眼很难判：
 * 数字糊了、颜色反了、角标画到了图标外面 —— 在托盘里都只是「好像有个点点」。
 * 所以正确性全部落在像素级断言上，不靠截图。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { badgeText, badgePixels, BADGE_BG, BADGE_FG, WIDTH, HEIGHT } = require('../electron/badgePixels.cjs');

/** 找出「红底」像素：与 BADGE_BG 完全一致 */
function redPixels(pixels) {
  const out = [];
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const i = (y * WIDTH + x) * 4;
      if (pixels[i] === BADGE_BG[0] && pixels[i + 1] === BADGE_BG[1] && pixels[i + 2] === BADGE_BG[2]) {
        out.push({ x, y });
      }
    }
  }
  return out;
}

function whitePixels(pixels) {
  const out = [];
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const i = (y * WIDTH + x) * 4;
      if (pixels[i] === 255 && pixels[i + 1] === 255 && pixels[i + 2] === 255 && pixels[i + 3] === 255) {
        out.push({ x, y });
      }
    }
  }
  return out;
}

test('角标上的字：没有更新就不写', () => {
  assert.equal(badgeText(0), null, '0 部更新不该画一个空红点 —— 那会让人以为有东西要看');
  assert.equal(badgeText(-3), null);
  assert.equal(badgeText(NaN), null);
  assert.equal(badgeText(undefined), null);
  assert.equal(badgeText('abc'), null);
});

test('角标上的字：三位数收成 99', () => {
  assert.equal(badgeText(1), '1');
  assert.equal(badgeText(99), '99');
  assert.equal(badgeText(150), '99', '32px 上放不下三位，「99+」只会糊成一团');
  assert.equal(badgeText(1.9), '1', '向下取整：报 2 部其实只有 1 部，比少报更糟');
  assert.equal(badgeText('7'), '7', '存档里可能是字符串');
});

test('没有更新时一个红像素都不许有', () => {
  const { pixels, badge } = badgePixels(0);
  assert.equal(badge, null);
  assert.equal(redPixels(pixels).length, 0, '没更新还画角标 = 骗用户有事');
});

test('有更新时角标画在右上角，且没戳出画布', () => {
  const { pixels, badge } = badgePixels(3);
  assert.ok(badge, '有更新必须有角标');
  assert.ok(badge.x + badge.w <= WIDTH, `角标右边越界：${badge.x}+${badge.w} > ${WIDTH}`);
  assert.ok(badge.y + badge.h <= HEIGHT, `角标下边越界：${badge.y}+${badge.h} > ${HEIGHT}`);
  assert.ok(badge.x >= 0 && badge.y >= 0, '角标不能画到画布外');
  // 右上角：中心应该落在画布右半边、上半边
  assert.ok(badge.x + badge.w / 2 > WIDTH / 2, '角标该在右边');
  assert.ok(badge.y + badge.h / 2 < HEIGHT / 2, '角标该在上边');

  const red = redPixels(pixels);
  assert.ok(red.length > 0, '角标底是红的，一个红像素都没有说明根本没画上去');
  // 红像素必须都落在角标矩形内 —— 画到框外就是算法错了
  for (const p of red) {
    const inside = p.x >= badge.x && p.x < badge.x + badge.w && p.y >= badge.y && p.y < badge.y + badge.h;
    assert.ok(inside, `红像素 (${p.x},${p.y}) 落在角标框 ${JSON.stringify(badge)} 外面`);
  }
});

test('角标上真的写了字（白像素在框内，且不同数字画出来的不一样）', () => {
  const a = badgePixels(1);
  const b = badgePixels(8);
  const whiteA = whitePixels(a.pixels).filter(
    (p) => p.x >= a.badge.x && p.x < a.badge.x + a.badge.w && p.y >= a.badge.y && p.y < a.badge.y + a.badge.h,
  );
  assert.ok(whiteA.length > 0, '角标框里没有白像素 —— 描边和数字都没画上');

  // 「1」和「8」的点阵不同，画出来的红像素数必然不同。
  // 这条卡的不是「画了东西」，而是「画的是这个数字」。
  assert.notEqual(redPixels(a.pixels).length, redPixels(b.pixels).length, '1 和 8 画出来一模一样 → 数字没起作用');
});

test('两位数比一位数的角标宽', () => {
  const one = badgePixels(7);
  const two = badgePixels(42);
  assert.ok(two.badge.w > one.badge.w, `两位数该更宽：${two.badge.w} vs ${one.badge.w}`);
  assert.equal(badgeText(42).length, 2);
});

test('角标不能吃掉整张图标', () => {
  const { badge } = badgePixels(99);
  const area = badge.w * badge.h;
  assert.ok(area < (WIDTH * HEIGHT) / 4, `角标占了 ${area}/${WIDTH * HEIGHT} —— 那不叫角标，叫盖住图标`);
});

test('底图没被改动（每次都从原图重新合成，不会越画越脏）', () => {
  const first = badgePixels(0).pixels;
  badgePixels(88);
  badgePixels(12);
  const again = badgePixels(0).pixels;
  assert.deepEqual(Array.from(again), Array.from(first), '画过角标之后底图变了 —— 说明改的是同一份像素');
});
