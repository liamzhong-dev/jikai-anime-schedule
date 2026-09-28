import { useCallback, useEffect, useRef, useState } from 'react';
import { platform } from '../platform/index.js';
import { loadYucSeason } from '../data/yucSource.js';

/**
 * 番堂（yuc.wiki）一季的数据。
 *
 * 顺带说明它为什么不并进 store：这份数据**只读、可再生、而且有自己的过期概念**
 * （`savedAt`）。塞进 `state.json` 会让「换一季就整体 stringify 一次」多背几十 KB，
 * 而且它天然属于「打开看看」的东西 —— 落盘由取数层直接写 `yucSeasons.json`。
 *
 * ## 什么时候联网
 *
 * 进这个视图**不一定会联网**：`loadYucSeason` 是「缓存优先」——
 * 上次拉过这一季就直接给缓存，一次请求都不发。只有
 *   ① 这一季从没拉过，或者 ② 用户按了「重新拉取」
 * 才真的发请求。②走 `reload()`，①是默认行为。
 *
 * 为什么不干脆每次进来都拉一遍：这是别人的站，用户可能一天开十几次；
 * 而排播表一天之内根本不会变。
 *
 * ## 三种失败要分得清
 *
 *   - `status:'error'` —— 从来没有过数据，也没拉成（第一次就断网）
 *   - `stale:true`      —— **有旧数据，但这次没更新上**。界面必须说出来，
 *     否则用户以为看的是最新排播表（这正是取数层专门留 `stale` 的原因）
 *   - `note`            —— 解析不出来时对方页面给的理由（「这一季还没排」/「站点结构可能变了」）
 *
 * ## 为什么 `seasonKey` 可以是 null
 *
 * 传 null 就是在说「这一页现在没人看」—— **什么都不做**，也不清空已有数据
 * （切回来是瞬间的）。这么做是为了别在启动时就偷偷发一次请求：用户可能
 * 一整天都不点这个视图，而这是别人的站，不该无谓地打扰。
 */
export function useYuc(seasonKey) {
  const [state, setState] = useState({
    status: 'idle',
    data: null,
    error: null,
    stale: false,
    cached: false,
  });

  /*
   * 换季 / 换数据源时的竞态：请求发出去了，用户已经把季度切走了 ——
   * 那次的结果回来时必须丢掉，否则会把新季的数据盖成旧季的。
   * 只认最后一次，编号对不上就退出。
   */
  const seq = useRef(0);

  const run = useCallback(
    async (live) => {
      // 没人看这一页 —— 一个字都不发（见上面那段说明）
      if (!seasonKey) return;
      const my = (seq.current += 1);
      setState((s) => ({ ...s, status: 'loading' }));
      let r;
      try {
        r = await loadYucSeason({ seasonKey, live, platform });
      } catch (err) {
        r = { ok: false, error: err?.message ?? String(err) };
      }
      if (my !== seq.current) return;

      if (r.ok) {
        setState({
          status: 'ready',
          data: r.data,
          // stale 时把原因一并留着：界面要说清「这是上次的，没更新上」
          error: r.stale ? (r.error ?? '这次没更新上') : null,
          stale: Boolean(r.stale),
          cached: Boolean(r.cached),
        });
        return;
      }
      setState({ status: 'error', data: null, error: r.error ?? '取不到数据', stale: false, cached: false });
    },
    [seasonKey],
  );

  useEffect(() => {
    run(false);
    // 离开的那一刻把编号推一格，飞行中的那次回来时就会被丢掉
    return () => { seq.current += 1; };
  }, [run]);

  const reload = useCallback(() => run(true), [run]);
  return { ...state, reload };
}
