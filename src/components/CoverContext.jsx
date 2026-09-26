import React, { createContext, useContext, useMemo } from 'react';

/**
 * 封面解析上下文。
 *
 * 为什么要有这一层：`<Cover anime={...}>` 在七个地方被用到（本季卡片、时间表、
 * 追番队列、补番清单、日记、详情抽屉……），而「按 id 去缓存里取图」这件事如果靠
 * 逐层传 props，这七个父组件就都得知道「有缓存这回事」，而且每多一个消费方就多
 * 一次推错「该用哪一档」的机会。
 *
 * ⚠️ **键是条目 id，不是地址。** 变体地址（界面 `c` / 导出 `l`）是 `core/covers.js`
 * 的内部实现，`anime.cover` 在这里只是「缓存取不到时的直连退路」。
 * v1.1 那回 82 张封面在桌面壳里全退成色块，就是键用了派生地址。
 *
 * 默认值刻意不是 `null`：没有 Provider 时（SSR 断言、单独渲染某个组件）
 * 退化成「没有缓存、允许直连」，这样每个组件单独拿出来也是能用的。
 */
const CoverCtx = createContext({ images: {}, allowRemote: true });

export function CoverProvider({ images, allowRemote = true, children }) {
  const value = useMemo(
    () => ({
      images: images && typeof images === 'object' ? images : {},
      allowRemote: Boolean(allowRemote),
    }),
    [images, allowRemote],
  );
  return <CoverCtx.Provider value={value}>{children}</CoverCtx.Provider>;
}

/**
 * 解析一张封面该用哪个 src。
 *
 * @returns {{key:string, cache:string|null, remote:string|null}}
 *   `cache` 是本地缓存里的 dataUrl（优先）；`remote` 是远端直链（`allowRemote` 关掉时为 null）。
 */
export function useCoverSrc(anime) {
  const { images, allowRemote } = useContext(CoverCtx);
  const key = anime?.id != null ? String(anime.id) : '';
  const cache = key && images[key] ? images[key] : null;
  const url = typeof anime?.cover === 'string' && anime.cover ? anime.cover : null;
  return { key, cache, remote: allowRemote ? url : null };
}
