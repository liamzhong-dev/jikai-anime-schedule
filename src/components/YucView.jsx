import React, { useMemo } from 'react';
import Cover from './Cover.jsx';
import { CoverProvider } from './CoverContext.jsx';
import { useCovers } from '../core/useCovers.js';
import { coverEntries } from '../core/covers.js';
// 别名：组件本身有个同名 prop（当前季度的显示名），直接 import 会撞车
import { seasonLabel as seasonLabelOf } from '../core/time.js';
import { platform } from '../platform/index.js';

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
 * `allowRemote`：桌面壳里关掉，浏览器壳里打开 —— 判据和本季番剧那批是同一条
 * （`platform.kind === 'web'`）。浏览器那头根本没有本地缓存这回事，
 * 关掉就等于「一片色块、永远不会有图」，而那不是降级，是坏了。
 * 桌面这头关掉的理由不变：直连会让浏览器先下一遍、主进程再下一遍，
 * 断网则一片色块 —— 走缓存是唯一「离线也有图」的路。
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
  seasons,
  onSeason,
  selectedId,
  onSelect,
  matched,
  onReload,
  allowRemote,
}) {
  const groups = data?.groups ?? [];
  const items = useMemo(() => groups.flatMap((g) => g.items ?? []), [groups]);

  /*
   * 封面能不能直连远端，由壳决定 —— 但**允许被 props 顶掉**。
   *
   * 为什么留这个口子：这条规矩是两个壳相反的（桌面关、浏览器开），而 SSR 环境里
   * `platform` 一律判成 web（`window.jikai` 不存在）。不留口子的话，单测只能测到
   * 「浏览器那一档」，桌面那档（也是真正的主力壳）**永远测不到** ——
   * 而「断言只能测到一半」比没有断言更危险，它会让人以为两边都守住了。
   */
  const remoteOk = allowRemote ?? (platform.kind === 'web');

  // 封面的入参是 `[{key, url}]`，键是条目 id（不是地址）—— 变体地址是取图层的内部事
  const entries = useMemo(() => coverEntries(items.map((it) => ({ id: it.id, cover: it.cover })), 'c'), [items]);
  /*
   * ⚠️ `progress` 必须接出来用。2026-09-29 那次报障「封面一个都没渲染出来」，
   * 真实情况是：图能取到，但每张 290 KB、24 张要几十秒，而界面上一点提示都没有 ——
   * 用户看到的和「根本没接封面」完全一样。现在图压到了 10 KB/张（见 covers.js 的
   * `coverThumb`），再把进度摆出来，两种失败就不会再被混为一谈。
   */
  const { images, progress: coverProgress, error: coverError } = useCovers({
    group: `yuc-${seasonKey}`,
    entries,
    enabled: entries.length > 0,
  });

  const busy = status === 'loading';

  return (
    <CoverProvider images={images} allowRemote={remoteOk}>
      <div className="yuc" data-yuc-view="1" data-yuc-remote={remoteOk ? '1' : '0'}>
        <div className="toolbar">
          <span className="toolbar__note" data-yuc-summary={data?.stats?.items ?? -1}>
            {data
              ? `${data.seasonName || seasonLabel || ''}　共收录 ${data.total ?? data.stats?.items ?? 0} 部`
              : '番堂 · 排播表'}
          </span>
          {/*
            数据来源要摆在明面上：这一页的排播表是长门有C（yuc.wiki）整理的，
            不是我们自己算的。写清楚既是对来源的尊重，也让「这一页的数字为什么
            和别的页不一样」有个出处可查。
          */}
          <span className="yuc-credit" data-yuc-source="yuc.wiki">
            数据来源：长门有C
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
          {/*
            换季。用真的 <select> 而不是自己画的按钮组：键盘能翻、屏幕阅读器认得，
            而且「当前是哪一季」由浏览器自己维护，不用我们操心高亮。
            只有一个可选项时也照样画出来 —— 那是「这一页有季度概念」的唯一提示，
            藏起来用户就不知道还能换。
          */}
          <select
            className="yuc-season"
            data-yuc-season={seasonKey}
            value={seasonKey ?? ''}
            onChange={(e) => onSeason?.(e.target.value || null)}
            aria-label="选一个季度"
          >
            {(seasons ?? []).length
              ? seasons.map((k) => (
                  <option key={k} value={k}>{seasonLabelOf(k)}</option>
                ))
              : <option value={seasonKey ?? ''}>{seasonLabel || '这一季'}</option>}
          </select>
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

        {coverProgress ? (
          <p
            className="yuc-note"
            data-yuc-coverprog={`${coverProgress.done}/${coverProgress.total}`}
          >
            封面正在缓存 {coverProgress.done}/{coverProgress.total} —— 第一次打开这一季会慢一点，之后就走本地缓存了
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
