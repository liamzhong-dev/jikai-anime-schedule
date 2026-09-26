import React, { useMemo, useState } from 'react';
import Cover from './Cover.jsx';
import {
  compareToBangumi,
  describeGap,
  diaryStats,
  diaryTimeline,
  sortByDivergence,
} from '../core/diary.js';
import { dateCST } from '../core/time.js';

/**
 * 补番日记视图。
 *
 * 两栏的取舍：
 *   左半**比对表按分歧降序** —— 分歧最大的浮在最上面。这是这个视图存在的全部理由：
 *     「大家说 8 分你也打 8 分」不需要一个页面来告诉你，「你打 10 分大家打 6 分」才需要。
 *   右半**时间线按时间倒序** —— 日记的天然读法。
 *
 * 空态不是一块空白：它得说清楚要去哪儿才能有内容，否则新用户看到的是一个坏掉的页面。
 */
export default function DiaryView({
  diary,
  lookup,
  onOpen,
  onRemove,
  onGoCatchup,
  now,
  tabProp,
  onTabProp,
}) {
  const [tabState, setTabState] = useState('compare');
  // 页签做成「可选受控」：默认自己管，传了 `tabProp` 就听外面的。
  // 起因是 SSR 断言灌不进组件内部 state —— 「时间线里有没有那句话」怎么测都是否，
  // 而否的原因跟功能对不对毫无关系。TierList 的 keyword 已经踩过同一个坑。
  const controlled = tabProp !== undefined;
  const tab = controlled ? tabProp : tabState;
  const setTab = (next) => {
    if (!controlled) setTabState(next);
    onTabProp?.(next);
  };

  const stats = useMemo(() => diaryStats(diary, lookup), [diary, lookup]);
  const rows = useMemo(() => sortByDivergence(diary, lookup), [diary, lookup]);
  const timeline = useMemo(() => diaryTimeline(diary, lookup), [diary, lookup]);

  const empty = rows.length === 0;

  return (
    <div className="diary" data-diary-view="1">
      {/*
        ⚠️ 每个 `data-diary-*` 都必须**显式带值**。写成不带 `=` 的裸属性时，
        React 会渲染成 `data-diary-works="true"` —— 钩子看着在，数字永远取不到，
        自动化脚本会一直读到 true 还以为一切正常。这条是 SSR 断言真的抓出来过的，
        所以这里的数字在属性里和文本里各放一份，是有意的重复。
      */}
      <div className="diary__stats" data-diary-stats={stats.comparable}>
        <div className="diary__stat">
          <b data-diary-works={stats.works}>{stats.works}</b>
          <span>记录的作品</span>
        </div>
        <div className="diary__stat">
          <b data-diary-entries={stats.entries}>{stats.entries}</b>
          <span>条记录</span>
        </div>
        <div className="diary__stat">
          <b data-diary-avg-mine={stats.avgMine ?? '—'}>{stats.avgMine ?? '—'}</b>
          <span>我的均分</span>
        </div>
        <div className="diary__stat">
          <b data-diary-avg-bgm={stats.avgBgm ?? '—'}>{stats.avgBgm ?? '—'}</b>
          <span>BGM 均分</span>
        </div>
        <div className="diary__stat">
          <b data-diary-agree={stats.agreeRatio != null ? `${Math.round(stats.agreeRatio * 100)}%` : '—'}>
            {stats.agreeRatio != null ? `${Math.round(stats.agreeRatio * 100)}%` : '—'}
          </b>
          <span>合拍占比</span>
        </div>
        <div className="diary__gap" data-diary-gap={stats.gap ?? ''}>{describeGap(stats)}</div>
      </div>

      {stats.comparable > 0 && stats.bands.unknown > 0 ? (
        // 把「有多少部其实没法比」明说出来。不说的话，上面那个均分会被当成全部作品的均分。
        <div className="diary__note">
          另有 {stats.bands.unknown} 部还差一边（还没打分，或本地没有它们的 Bangumi 评分），
          没有算进均分 —— 混进去会让上面那两个数字来自不同的样本。
        </div>
      ) : null}

      {empty ? (
        <div className="empty">
          补番日记还是空的。
          {onGoCatchup ? (
            <>
              {' '}
              <button type="button" className="btn btn--ghost btn--mini" onClick={onGoCatchup}>
                去补番清单打分
              </button>
            </>
          ) : null}
          <div className="diary__empty-hint">
            在补番清单的卡片上选 1–10 分、写一句感受，这里就会自动把
            「你的评分 / Bangumi 的评分 / 差多少」排出来。
          </div>
        </div>
      ) : (
        <>
          <div className="diary__tabs">
            <button
              type="button"
              className={`tab${tab === 'compare' ? ' is-active' : ''}`}
              data-diary-tab="compare"
              onClick={() => setTab('compare')}
            >
              评分比对（{rows.length}）
            </button>
            <button
              type="button"
              className={`tab${tab === 'timeline' ? ' is-active' : ''}`}
              data-diary-tab="timeline"
              onClick={() => setTab('timeline')}
            >
              时间线（{timeline.length}）
            </button>
          </div>

          {tab === 'compare' ? (
            <div className="diary__list" data-diary-panel="compare">
              {rows.map((r) => (
                <div className="diary__row" key={r.key} data-diary-row={r.key} data-band={r.cmp.band}>
                  <Cover anime={r.anime} className="diary__cover" />
                  <div className="diary__main">
                    <button type="button" className="diary__title" onClick={() => r.anime && onOpen?.(r.anime)}>
                      {r.anime?.titleZh || r.anime?.titleJa || `作品 ${r.key}`}
                    </button>
                    <div className="diary__meta">
                      <span className="diary__mine">我的 {r.my ?? '—'}</span>
                      <span className="diary__bgm">{r.cmp.bgm != null ? `BGM ${r.cmp.bgm}` : 'BGM 未知'}</span>
                      <span className={`diary-cmp diary-cmp--${r.cmp.band}`} data-diary-diff={r.cmp.diff ?? ''}>
                        {r.cmp.label}
                      </span>
                    </div>
                    {r.anime?.summary ? <div className="diary__summary">{r.anime.summary}</div> : null}
                  </div>
                  <HistoryButton id={r.key} diary={diary} onRemove={onRemove} />
                </div>
              ))}
            </div>
          ) : (
            <div className="diary__list" data-diary-panel="timeline">
              {timeline.map((e) => (
                <div className="diary__row diary__row--tl" key={`${e.key}-${e.at}`} data-diary-at={e.at}>
                  <Cover anime={e.anime} className="diary__cover" />
                  <div className="diary__main">
                    <div className="diary__tl-head">
                      <button type="button" className="diary__title" onClick={() => e.anime && onOpen?.(e.anime)}>
                        {e.anime?.titleZh || e.anime?.titleJa || `作品 ${e.key}`}
                      </button>
                      <time className="diary__time">{dateCST(e.at)}</time>
                    </div>
                    <div className="diary__meta">
                      <span className="diary__mine">{e.rating != null ? `我的 ${e.rating}` : '只写了感受'}</span>
                      {e.rating != null ? (
                        <span className={`diary-cmp diary-cmp--${e.cmp.band}`}>{e.cmp.label}</span>
                      ) : null}
                    </div>
                    {e.note ? <div className="diary__note-text">{e.note}</div> : null}
                  </div>
                  {onRemove ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--mini"
                      onClick={() => onRemove(e.id, e.at)}
                    >
                      删除
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** 「这一部记过几次」的展开，默认收起 —— 大多数时候只关心最近一条 */
function HistoryButton({ id, diary, onRemove }) {
  const [open, setOpen] = useState(false);
  const list = diary?.[String(id)]?.entries ?? [];
  if (list.length <= 1) return null;

  return (
    <div className="diary__history">
      <button type="button" className="btn btn--ghost btn--mini" onClick={() => setOpen(!open)}>
        {open ? '收起' : `${list.length} 条`}
      </button>
      {open ? (
        <ul className="diary__history-list">
          {[...list].reverse().map((e) => (
            <li key={e.at}>
              <time>{dateCST(e.at)}</time>
              <span>{e.rating != null ? `${e.rating} 分` : '无评分'}</span>
              <span className="diary__history-note">{e.note || '—'}</span>
              {onRemove ? (
                <button type="button" className="diary__history-del" onClick={() => onRemove(Number(id), e.at)}>
                  删
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export { compareToBangumi };
