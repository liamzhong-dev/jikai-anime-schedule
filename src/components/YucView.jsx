import React, { useMemo } from 'react';
import Cover from './Cover.jsx';
import { CoverProvider } from './CoverContext.jsx';
import { useCovers } from '../core/useCovers.js';
import { coverEntries } from '../core/covers.js';

/**
 * 长门番堂（yuc.wiki）的季度排播表。
 *
 * 它和别的视图最大的不同：**这份数据不属于我们的库**。
 * 番堂给的是「几点播、哪天开播、谁做的、谁配的」，没有 Bangumi 的条目 id、
 * 没有话数、没有评分 —— 所以它不做成第四个数据源（那样封面、评分、日记、报告
 * 这些依赖 bgm id 的地方会整片塌掉），而是**另开一页**，两份数据各用各的长处，
 * 只在一处交汇：能对上的条目上标一个「已收入」。
 *
 * ## 封面
 *
 * 走现有的封面缓存通道（`group = yuc-<季度>`），**不直接 `<img src>`**：
 * 番堂的封面挂在 B 站图床（`i0.hdslb.com`）上，直连的话「关掉代理就是一片色块」，
 * 而且浏览器先下一遍、主进程再下一遍。缓存键用条目自己的 id（`y` + 标题哈希），
 * 不会和 Bangumi 的数字 id 撞。
 *
 * `allowRemote={false}`：桌面壳里不许直连 —— 这一条和本季番剧那批是同一个理由。
 * 代价是「第一次打开、还没缓存」时是一片色块，但那比「看着有图、断网就没了」好。
 *
 * ## 状态
 *
 * 三种失败长得完全不一样，界面上必须分开说：
 *   - 从没拿到过（`status === 'error'`）→ 给一个「重新拉取」的按钮和原因；
 *   - 有旧数据但这次没更新上（`stale`）→ 数据照常显示，上面挂一条说明。
 *     不挂的话用户会以为看的是最新排播表 —— 那是这套缓存最容易骗到人的地方；
 *   - 这一季还没排（对方原话）→ 照实说，这不是错误。
 */
export default function YucView({
  data,
  status,
  error,
  stale,
  seasonKey,
  seasonLabel,
  selectedId,
  onSelect,
  matched,
  onReload,
}) {
  const groups = data?.groups ?? [];
  const items = useMemo(() => groups.flatMap((g) => g.items ?? []), [groups]);

  // 封面的入参是 `[{key, url}]`，键是条目 id（不是地址）—— 变体地址是取图层的内部事
  const entries = useMemo(() => coverEntries(items.map((it) => ({ id: it.id, cover: it.cover })), 'c'), [items]);
  const { images, error: coverError } = useCovers({
    group: `yuc-${seasonKey}`,
    entries,
    enabled: entries.length > 0,
  });

  const busy = status === 'loading';

  return (
    <CoverProvider images={images} allowRemote={false}>
      <div className="yuc" data-yuc-view="1">
        <div className="toolbar">
          <span className="toolbar__note" data-yuc-summary={data?.stats?.items ?? -1}>
            {data
              ? `${data.seasonName || seasonLabel || ''}　共收录 ${data.total ?? data.stats?.items ?? 0} 部`
              : '长门番堂 · 排播表'}
          </span>
          {data?.breakdown?.length ? (
            <span className="yuc-chips">
              {data.breakdown.map((b) => (
                <span key={b.label} className="yuc-chip">
                  {b.label}
                  <em>{b.count}</em>
                </span>
              ))}
            </span>
          ) : null}
          <div className="toolbar__spacer" />
          <button
            type="button"
            className="btn"
            data-yuc-reload="1"
            disabled={busy}
            onClick={() => onReload?.()}
            title="忽略缓存，重新从 yuc.wiki 拉一次"
          >
            {busy ? '拉取中…' : '重新拉取'}
          </button>
        </div>

        {stale && data ? (
          <p className="yuc-note" data-yuc-stale="1">
            这次没更新上（{error || '网络不通'}），下面看到的是<strong>上次拉到的</strong>排播表。
          </p>
        ) : null}

        {coverError ? <p className="yuc-note">封面没取到：{coverError}</p> : null}

        {!data && status === 'error' ? (
          <div className="empty" data-yuc-state="error">
            <p>拉不到番堂的排播表：{error || '未知原因'}</p>
            <button type="button" className="btn" data-yuc-reload="1" onClick={() => onReload?.()}>
              再试一次
            </button>
          </div>
        ) : null}

        {!data && status === 'loading' ? (
          <div className="empty" data-yuc-state="loading">
            正在从 yuc.wiki 拉这一季的排播表…
          </div>
        ) : null}

        {data && !groups.length ? (
          <div className="empty" data-yuc-state="empty">
            这一季的页面上还没有排播分组 —— 多半是还没开播，过阵子再来。
          </div>
        ) : null}

        {groups.map((g) => (
          <section className="yuc-group" key={g.key} data-yuc-group={g.key}>
            <header className="yuc-group__head">
              <span className="yuc-group__name">{g.label}</span>
              <span className="yuc-group__count">{g.items.length} 部</span>
            </header>
            <div className="yuc-grid">
              {g.items.map((it) => {
                const lib = matched?.get?.(it.id) ?? null;
                return (
                  <div
                    key={it.id}
                    className={`yuc-item${selectedId === it.id ? ' is-sel' : ''}${lib ? ' yuc-item--own' : ''}`}
                    data-yuc-item={it.id}
                  >
                    <Cover
                      anime={{ id: it.id, titleZh: it.titleZh, titleJa: it.titleJa, cover: it.cover }}
                      className="yuc-item__cover"
                    />
                    {/*
                      整块可点，所以热区是**真的 <button>**（div + onClick 吃不到 Tab 和回车）。
                      它排在最前面、`inset: 0` 铺满整张卡 —— 标题和徽标虽然画在它上面，
                      但都是 static，指针事件照样落到它身上，于是「点哪儿都能选中」。
                    */}
                    <button
                      type="button"
                      className="yuc-item__hot"
                      data-yuc-select={it.id}
                      aria-label={`查看《${it.titleZh}》的详细资料`}
                      onClick={() => onSelect?.(it)}
                    />
                    <span className="yuc-item__title">{it.titleZh}</span>
                    <span className="yuc-item__meta">
                      {it.time ? <em className="yuc-item__time">{it.time}</em> : null}
                      {!it.time && it.area ? <em className="yuc-item__time">{it.area}</em> : null}
                      {it.startDate ? <span className="yuc-item__date">{it.startDate}</span> : null}
                      {lib ? <span className="yuc-item__own" data-yuc-own-item={lib.id}>已收入</span> : null}
                    </span>
                  </div>
                );
              })}
            </div>
          </section>
        ))}

        {data?.stats ? (
          <p className="yuc-foot" data-yuc-foot={data.stats.matched}>
            排播 {data.stats.items} 条 · 当前季度共 {data.stats.groups} 组 · 其中 {data.stats.matched} 条
            在 yuc 的介绍区里找到了完整资料
            {data.stats.unmatched ? `，另有 ${data.stats.unmatched} 部只在介绍区出现（没排进周表）` : ''}
          </p>
        ) : null}
      </div>
    </CoverProvider>
  );
}
