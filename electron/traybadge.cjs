'use strict';

/**
 * 把角标像素变成托盘能用的图。
 *
 * 只有这一个文件碰 Electron —— 画像素的部分在 badgePixels.cjs（纯函数，可单测）。
 * 分开的理由很实际：一旦 require('electron')，这个文件在 `node --test`
 * 里就加载不了，角标的正确性就只剩下「肉眼看一眼托盘」这一条路。
 */

const { nativeImage } = require('electron');
const { badgePixels, WIDTH, HEIGHT } = require('./badgePixels.cjs');
const { encodePng } = require('../scripts/lib/png.cjs');

/**
 * @param {number} count 今天的更新部数；<=0 不画角标
 * @returns {Electron.NativeImage}
 */
function badgeIcon(count) {
  const { pixels } = badgePixels(count);
  return nativeImage.createFromBuffer(encodePng(WIDTH, HEIGHT, pixels), { width: WIDTH, height: HEIGHT });
}

module.exports = { badgeIcon };
