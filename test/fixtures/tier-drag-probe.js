/**
 * 拖拽的真事件模拟（由 scripts/tier-render-check.mjs --drag 注入）。
 *
 * 为什么必须做到这一步：`useDragSort` 那一百多行是**唯一**没办法用纯函数测试守住的部分 ——
 * 它牵扯 pointer 事件的启动阈值、window 上的 move/up 监听、
 * `getBoundingClientRect` 量出来的行矩形、以及最后 `moveItem` 的插入位置。
 * 每一层单独看都对，串起来「拖了没反应」完全可能 —— 而这就是跨层功能的典型失败方式。
 *
 * 所以这里用真的 `PointerEvent` 从第一个图块拖到 TOP 档，然后看 DOM 里的计数。
 */

(() => {
  const out = (text) => {
    let el = document.getElementById('drag');
    if (!el) {
      el = document.createElement('pre');
      el.id = 'drag';
      document.body.appendChild(el);
    }
    el.textContent = text;
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const fire = (target, type, x, y) => {
    target.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    }));
  };

  async function waitFor(fn, tries = 60) {
    for (let i = 0; i < tries; i += 1) {
      const v = fn();
      if (v) return v;
      await sleep(100);
    }
    return null;
  }

  async function main() {
    const firstTile = await waitFor(() => document.querySelector('.tier-pool__grid .tier-item'));
    if (!firstTile) {
      out('DRAG_FAIL 素材池里没有图块');
      return;
    }

    const poolBefore = document.querySelectorAll('.tier-pool__grid .tier-item').length;
    const topBefore = Number(
      document.querySelector('.tier-row[data-row="r1"] .tier-row__body')?.dataset.count ?? -1,
    );

    const a = firstTile.getBoundingClientRect();
    const from = { x: a.left + a.width / 2, y: a.top + a.height / 2 };

    // 落点：TOP 档那一行的内容区左半边（插到第 0 个的位置）
    const body = document.querySelector('.tier-row[data-row="r1"] .tier-row__body');
    if (!body) {
      out('DRAG_FAIL 找不到 TOP 档的行容器');
      return;
    }
    const b = body.getBoundingClientRect();
    const to = { x: b.left + 30, y: b.top + b.height / 2 };

    // 先小挪一下，越过 4px 启动阈值；再挪到落点 —— 两步都要发，
    // 只发一次的话会被当成「点了一下」，那样正好漏测阈值逻辑
    fire(firstTile, 'pointerdown', from.x, from.y);
    fire(window, 'pointermove', from.x + 2, from.y + 2);
    await sleep(30);
    fire(window, 'pointermove', to.x, to.y);
    await sleep(30);
    fire(window, 'pointerup', to.x, to.y);

    await sleep(400);

    const poolAfter = document.querySelectorAll('.tier-pool__grid .tier-item').length;
    const topAfter = Number(
      document.querySelector('.tier-row[data-row="r1"] .tier-row__body')?.dataset.count ?? -1,
    );
    const topTiles = document.querySelectorAll('.tier-row[data-row="r1"] .tier-row__body .tier-item').length;

    out(JSON.stringify({
      status: 'DRAG_OK',
      poolBefore,
      poolAfter,
      topBefore,
      topAfter,
      topTiles,
      ghostLeft: document.querySelectorAll('.tier-ghost').length,
    }));
  }

  main().catch((err) => out(`DRAG_FAIL ${err?.message ?? String(err)}`));
})();
