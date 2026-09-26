import { useEffect, useRef, useState } from 'react';
import { platform } from '../platform/index.js';
import { mapCoversByKey } from './covers.js';

/**
 * 批量取封面，返回 `条目 key -> dataUrl` 的映射。
 *
 * ⚠️ 入参是 `entries: [{key, url}]`，不是一串 url；返回的键也是 `key`（条目 id），
 * 不是 url。变体地址（界面 `c`、导出 `l`）是这一层的内部实现，**不许外泄** ——
 * 外泄一次就意味着消费方要自己再推一遍「该用哪一档」，而每多一个消费方就多一次
 * 推错的机会（v1.1 桌面端 82 张封面全退成色块，就是三个组件各自推错了）。
 *
 * 为什么显示也要走缓存，而不是直接 `<img src={远端地址}>`：
 *   1. **断网就没图**。实测 `lain.bgm.tv` 在代理关掉时完全不可达 ——
 *      直接引远端地址的话，关掉 VPN 打开就是一片色块。
 *   2. 导出必须用它（跨域图会 taint canvas）。显示和导出走同一条路，
 *      就不会出现「界面上有图、导出出来是空的」。
 *
 * ## 为什么要「边下边显示」，不能等预热跑完
 *
 * 这是实测踩出来的：预热 82 张要走几十秒，而原来的写法是
 *
 * ```js
 * await warmCovers(...)   // ← 卡在这儿
 * for (url of urls) await getCoverImage(url)
 * ```
 *
 * 结果磁盘上已经落了 13MB，界面上一个数都没动、一张图都没出来 ——
 * 用户看到的完全是「点了没反应」。
 *
 * 现在改成三件事并行：
 *   ① 先只读扫一遍缓存（上次看过的图**立刻**就出来，一张都不用等）；
 *   ② 预热在后台跑，进度一到就再只读扫一遍，下好一批显示一批；
 *   ③ 预热结束后再走一遍普通模式，把确实没有的补上（该联网就联网）。
 *
 * ①③ 用的是 `readOnly` 模式：只读不下载。否则「反复看看现在有哪些」
 * 每次未命中都会触发一次下载，和正在跑的预热叠成两份流量。
 */

/** 每攒够这么多张才 setState 一次，避免 82 次重渲染 */
const BATCH = 8;

export function useCovers({ group, entries = [], enabled = true, concurrency = 5 } = {}) {
  const [images, setImages] = useState({});
  const [progress, setProgress] = useState(null);
  const [supported, setSupported] = useState(true);
  const [error, setError] = useState(null);

  const urls = entries.map((e) => e?.url).filter(Boolean);
  const sig = urls.join('|');
  const doneSig = useRef('');

  useEffect(() => {
    if (!enabled || !urls.length) {
      setProgress(null);
      return undefined;
    }
    // 同一批 url 只跑一次；换季度或换数据源时 sig 会变，自然重跑
    const key = `${group}::${sig}`;
    if (doneSig.current === key) return undefined;
    doneSig.current = key;

    let alive = true;
    let reading = false;
    setError(null);
    setProgress({ phase: 'warm', done: 0, total: urls.length });

    // 内部按 url 收（取图那层不知道条目），对外只给 key 键的表
    const out = {};
    const flush = () => { if (alive) setImages(mapCoversByKey(entries, out)); };
    const pending = new Set(urls);

    /** 扫一遍还没拿到的；readOnly=true 时只读缓存，绝不联网 */
    const pass = async (readOnly) => {
      if (reading) return;
      reading = true;
      let since = 0;
      try {
        for (const url of [...pending]) {
          if (!alive) return;
          const r = await platform.getCoverImage({ group, url, readOnly }).catch(() => null);
          if (r?.dataUrl) {
            out[url] = r.dataUrl;
            pending.delete(url);
          } else if (!readOnly) {
            // 联网也没拿到，别再反复问 —— 但也不能静默：最后统一报一次
            pending.delete(url);
          }
          // 联网那一趟要分批刷，不然 82 张刷 82 次
          since += 1;
          if (!readOnly && since % BATCH === 0) flush();
        }
        flush();
      } finally {
        reading = false;
      }
    };

    // 预热是主进程在跑的，进度它一直在推 —— 不接的话界面会停在 0/82 不动
    let lastTick = 0;
    const off = platform.onCoverProgress?.((p) => {
      if (!alive || !p?.total) return;
      setProgress({ phase: 'warm', done: p.done ?? 0, total: p.total });
      // 每前进 BATCH 张就顺手把新下好的读出来，不打断预热
      if ((p.done ?? 0) - lastTick >= BATCH) {
        lastTick = p.done ?? 0;
        pass(true);
      }
    });

    (async () => {
      // ① 先拿已有的（上次的缓存，一张都不用等）
      await pass(true);
      if (!alive) return;

      // ② 预热 + 边下边读
      const warm = await platform.warmCovers({ group, urls, concurrency }).catch((err) => ({
        unsupported: true,
        error: err?.message ?? String(err),
      }));
      if (!alive) return;

      if (warm?.unsupported) {
        setSupported(false);
        setProgress(null);
        return;
      }

      const totalWarm = Number(warm?.total) || 0;
      if (totalWarm > 0 && Number(warm?.failed) >= totalWarm) {
        setProgress(null);
        setError('封面一张都没取到，检查一下网络或代理');
        return;
      }

      // ③ 剩下的该联网就联网
      if (pending.size) setProgress({ phase: 'read', done: urls.length - pending.size, total: urls.length });
      if (pending.size) await pass(false);
      if (!alive) return;

      flush();
      setProgress(null);
    })().catch((err) => {
      if (alive) {
        setError(err?.message ?? String(err));
        setProgress(null);
      }
    });

    return () => { alive = false; off?.(); };
    // sig 是 urls 的内容指纹，依赖它比依赖数组本身稳（数组每次渲染都是新的）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group, sig, enabled, concurrency]);

  return { images, progress, supported, error };
}
