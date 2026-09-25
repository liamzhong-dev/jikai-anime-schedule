/**
 * 由字符串派生稳定配色。
 *
 * 放在 core 而不是组件里，是因为**导出那一侧也要用**：
 * canvas 里画不出 CSS 渐变（除非自己造 gradient 对象），
 * 而「界面上有封面时是图、没封面时是色块」这条规则，
 * 导出图里必须保持一致 —— 否则会出现「界面好看、导出来一片灰」。
 */

/** 由字符串派生稳定的色相；同一个名字每次算出来都一样 */
export function hueOf(seed) {
  let h = 0;
  const s = String(seed ?? '');
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

/** CSS 渐变（界面用） */
export function fallbackGradient(seed) {
  const h = hueOf(seed);
  return `linear-gradient(150deg, hsl(${h} 62% 46%), hsl(${(h + 48) % 360} 58% 32%))`;
}

/**
 * 两个实色（canvas 用）。
 * 与 fallbackGradient 取同一对色相，界面和导出看起来才是一套东西。
 */
export function fallbackPair(seed) {
  const h = hueOf(seed);
  return [`hsl(${h} 62% 46%)`, `hsl(${(h + 48) % 360} 58% 32%)`];
}

/** 档位标签上的字用什么颜色：由底色亮度决定，别写死黑或白 */
export function readableInk(hex) {
  const m = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(String(hex ?? '').trim());
  if (!m) return '#1a1d24';
  let raw = m[1];
  if (raw.length === 3) raw = raw.split('').map((c) => c + c).join('');
  const r = parseInt(raw.slice(0, 2), 16);
  const g = parseInt(raw.slice(2, 4), 16);
  const b = parseInt(raw.slice(4, 6), 16);
  // 感知亮度（ITU-R BT.601 的近似），>150 就算亮底
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  return luma > 150 ? '#1a1d24' : '#ffffff';
}
