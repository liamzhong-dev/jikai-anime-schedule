import React, { useMemo } from 'react';
import Cover from './Cover.jsx';
import { describeHistory, formatSpan, historyEvents, historyStats } from '../core/history.js';
import { dateCST, toCST } from '../core/time.js';

const KIND = {
  follow: { text: '开始追', cls: 'history__kind--follow' },
  finish: { text: '看完了', cls: 'history__kind--finish' },
};

/**
 * 追番历程视图 —— 「从哪部开始、追了多久、看完了哪些」。
 *
 * 和补番日记的区别：日记是**用户写的**（评分、短评），这里是**机器记的**
 * （加入追番、推进进度时顺手打的时间戳）。所以这一页不需要用户做任何额外操作，
 * 打开就该有东西 —— 前提是时间戳已经开始记了（有的话在界面上明说，
 * 不能让用户对着一页说不清来由的数字猜）。
 *
 * 上面四个数字里，「追番总数」和「已看完」是准的，「平均天数」和「记录跨度」
 * 只统计有时间戳的那部分。所以下面一定要有一行说清「另有 N 部没有时间」——
 * 一个不说清分母的统计数字，比不给更坏。
 */
export default function HistoryView({
  following = {},
  diary = {},
  lookup = () => null,
  now = Date.now(),
  onOpen,
  onGoSeason,
}) {
  const stats = useMemo(
    () => historyStats({ following, diary, lookup, nowMs: now }),
    [following, diary, lookup, now],
  );
  const events = useMemo(() => historyEvents({ following, lookup }), [following, lookup]);

  return (
    <div className="history" data-history-view="1">
      {/*
        ⚠️ 每个 `data-history-*` 都要**显式带值**。写成不带 `=` 的裸属性时
        React 会渲成 `data-history-total="true"` —— 钩子看着在、数字永远读不到，
        自动化脚本会一直读到 true 还以为一切正常。这条在日记那边真被抓出来过一次。
      */}
      <div className="history__stats">
        <div className="history__stat">
          <b data-history-total={stats.total}>{stats.total}</b>
          <span>追番总数</span>
        </div>
        <div className="history__stat">
          <b data-history-finished={stats.finished}>{stats.finished}</b>
          <span>已看完</span>
        </div>
        <div className="history__stat">
          <b data-history-avg={stats.avgDays ?? ''}>{stats.avgDays ?? '—'}</b>
          <span>平均天数</span>
        </div>
        <div className="history__stat">
          <b data-history-span={stats.spanDays ?? ''}>{stats.spanDays ?? '—'}</b>
          <span>记录跨度（天）</span>
        </div>
      </div>

      {/* 两个计数都放在这一行上：`untimed` 只在大于 0 时才渲染下面那句提示，
          但自动化要能随时读到它 —— 靠「某个节点在不在」判断数字会得到空字符串。 */}
      <div className="history__summary" data-history-tracking={stats.tracking} data-history-untimed={stats.untimed}>
        {describeHistory(stats)}
      </div>

      {stats.highlight ? (
        // 「哪部最重要」不给分数、不给排名，只给一个理由 ——
        // 理由（写了多少字）用户自己能核对，凭空一个 92 分没法核对。
        <div className="history__highlight" data-history-highlight={stats.highlight.key}>
          <span className="history__hl-label">你为它写得最多</span>
          <button
            type="button"
            className="history__hl-title"
            onClick={() => stats.highlight.anime && onOpen?.(stats.highlight.anime)}
          >
            {stats.highlight.anime?.titleZh || stats.highlight.anime?.titleJa || `作品 ${stats.highlight.key}`}
          </button>
          <span className="history__hl-meta">
            {stats.highlight.chars} 字 · {stats.highlight.notes} 条笔记
          </span>
        </div>
      ) : null}

      {stats.untimed > 0 ? (
        <div className="history__note">
          另有 {stats.untimed} 部是在开始记时间之前加进来的，没有时间戳 ——
          它们算进上面的「追番总数」，但排不进下面的时间轴。
        </div>
      ) : null}

      {events.length === 0 ? (
        <div className="empty">
          时间线还是空的。
          {onGoSeason ? (
            <>
              {' '}
              <button type="button" className="btn btn--ghost btn--mini" onClick={onGoSeason}>
                去本季番剧
              </button>
            </>
          ) : null}
          <div className="history__empty-hint">
            从今天起，在「本季番剧」点星标加入追番、在「我的追番」点 +1 推进进度，
            这里会自己长出时间线 —— 不用额外记任何东西。
            <br />
            在这之前加进来的追番没有时间戳，补不回来，所以现在看着空是正常的。
          </div>
        </div>
      ) : (
        <div className="history__list" data-history-events={events.length}>
          {events.map((e) => {
            const kind = KIND[e.kind] ?? KIND.follow;
            const year = e.at ? toCST(e.at).year : null;
            return (
              <div
                className="history__row"
                key={`${e.key}-${e.kind}-${e.at ?? 'x'}`}
                data-history-event={e.kind}
                data-history-days={e.days ?? ''}
              >
                <div className="history__when">
                  <span className="history__date" data-history-at={e.at ?? ''}>
                    {e.at ? dateCST(e.at) : '时间未知'}
                  </span>
                  {year ? <span className="history__year">{year}</span> : null}
                </div>
                <div className="history__spine">
                  <i className={`history__dot history__dot--${e.kind}`} />
                </div>
                <Cover anime={e.anime} className="history__cover" />
                <div className="history__main">
                  <button
                    type="button"
                    className="history__title"
                    onClick={() => e.anime && onOpen?.(e.anime)}
                  >
                    {e.anime?.titleZh || e.anime?.titleJa || `作品 ${e.key}`}
                  </button>
                  <div className="history__meta">
                    <span className={`history__kind ${kind.cls}`}>{kind.text}</span>
                    {e.kind === 'finish' && e.days != null ? (
                      <span className="history__span" data-history-finish-days={e.days}>
                        用了 {formatSpan(e.days)}
                      </span>
                    ) : null}
                    {e.kind === 'finish' && e.days == null ? (
                      <span className="history__span history__span--muted">
                        {e.atKnown ? '耗时未知' : '完成日未知'}
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
