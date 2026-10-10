import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { platform } from '../platform/index.js';
import { customKeyOf, normalizeImageList } from './customImages.js';

/**
 * 用户导入的图：清单 + 内容。
 *
 * 分两层是刻意的：
 *   - `meta`（file / name / bytes）很小，**一进来就全量读**；
 *   - `data`（dataUrl）是图的本体，一张动辄几百 KB 的 base64，
 *     **用到才读**（`ensure`），而且只补没读过的。
 *
 * 一次性把全部图的 dataUrl 灌进内存的话，加个十来张图就会开始卡：
 * React 每次重渲染都要比对这些巨大的字符串，而真正需要它的只有两个视图。
 *
 * ⚠️ 删除不检查「有没有被引用」：报告里存的是 `img:<file>` 这样的键，
 * 删掉图之后那一格会变成色块 —— 这件事由界面在删的时候说清楚，
 * 而不是在这里偷偷拦下（用户想删一张图，不该被一句「还被引用着」挡回去）。
 */
export function useCustomImages({ enabled = true } = {}) {
  const [meta, setMeta] = useState([]);
  const [data, setData] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const loaded = useRef(new Set());

  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    platform.listImages?.()
      .then((r) => { if (alive) setMeta(normalizeImageList(r?.items)); })
      .catch(() => { /* 列不出来就当没有，别把界面搞崩 */ });
    return () => { alive = false; };
  }, [enabled]);

  /** 把还没读出来的图读成 dataUrl；读过的直接跳过 */
  const ensure = useCallback(async (files) => {
    const list = Array.isArray(files) ? files : [files];
    const want = list.filter((f) => f && !loaded.current.has(f));
    if (!want.length) return;
    // 先占位再读：连点两次「加图」不会把同一张读两遍
    for (const f of want) loaded.current.add(f);
    const got = {};
    await Promise.all(want.map(async (f) => {
      try {
        const r = await platform.readImage({ file: f });
        if (r?.dataUrl) got[f] = r.dataUrl;
      } catch {
        /* 读不出来就留空：那一格会退成色块，总比整页报错好 */
      }
    }));
    if (Object.keys(got).length) setData((prev) => ({ ...prev, ...got }));
  }, []);

  /**
   * 挑一张图进来。
   *
   * 用户取消时不报错、也不弹提示 —— 他只是改了主意；
   * 但**真的失败**要回一句人话（选的文件太大、存不下），
   * 否则就是「点了没反应」。
   */
  const add = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const r = await platform.pickImage();
      if (!r?.ok) {
        // 取消（用户改了主意）返回 null，界面据此一声不吭；
        // 真失败（图太大 / 存不下）才回一句人话
        if (r?.error && r.error !== '已取消') {
          setError(r.error);
          return { ok: false, error: r.error };
        }
        return null;
      }
      if (r.dataUrl) {
        loaded.current.add(r.file);
        setData((prev) => ({ ...prev, [r.file]: r.dataUrl }));
      }
      setMeta((prev) => normalizeImageList([
        { file: r.file, name: r.name, bytes: r.bytes, addedAt: Date.now() },
        ...prev,
      ]));
      return r;
    } catch (err) {
      const msg = err?.message ?? String(err);
      setError(msg);
      return { ok: false, error: msg };
    } finally {
      setBusy(false);
    }
  }, []);

  const remove = useCallback(async (file) => {
    const f = String(file ?? '');
    if (!f) return;
    try {
      await platform.removeImage({ file: f });
    } catch (err) {
      setError(err?.message ?? String(err));
      return;
    }
    loaded.current.delete(f);
    setData((prev) => {
      const next = { ...prev };
      delete next[f];
      return next;
    });
    setMeta((prev) => prev.filter((m) => m.file !== f));
  }, []);

  /** 给封面那套「按条目 id 取图」用的映射：`img:<file> -> dataUrl` */
  const imagesByKey = useMemo(() => {
    const out = {};
    for (const [file, url] of Object.entries(data)) out[customKeyOf(file)] = url;
    return out;
  }, [data]);

  const clearError = useCallback(() => setError(''), []);

  return { meta, data, imagesByKey, busy, error, add, remove, ensure, clearError };
}
