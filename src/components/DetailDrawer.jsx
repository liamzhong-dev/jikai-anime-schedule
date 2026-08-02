import React, { useMemo } from 'react';
import Cover from './Cover.jsx';
import { airingsInRange, clockCST, countdown, countdownLabel, dateCST, isLateNight, watchState, weekdayJST } from '../core/time.js';

export default function DetailDrawer({
  anime, following, watchedEps, now,
  onClose, onToggleFollow, onMarkEpisode, onAddCatchup, onOpenExternal,
}) {
  const episodes = useMemo(() => {
    if (!anime) return [];
    const from = Date.parse(anime.begin ?? '') - 86400000;
    if (Number.isNaN(from)) return [];
    return airingsInRange(anime, from, from + 400 * 86400000, anime.eps || 60);
  }, [anime]);

  const ws = useMemo(
    () => (anime ? watchState(anime, watchedEps ?? 0, now) : null),
    [anime, watchedEps, now],
  );

  if (!anime) return null;

  const beginMs = Date.parse(anime.begin ?? '');
  const hasBegin = !Number.isNaN(beginMs);
  const cd = ws && ws.next.ms != null && !ws.finished ? countdown(ws.next.ms, now) : null;
  const label = cd ? countdownLabel(cd) : null;

  return (
    <>
      <div className="drawer__mask" onClick={onClose} />
      <aside className="drawer__panel" role="dialog" aria-label={anime.titleZh || anime.titleJa}>
        <button type="button" className="drawer__close" onClick={onClose} title="关闭">✕</button>

        <div className="drawer__head">
          <Cover anime={anime} className="drawer__cover" />
          <div className="drawer__titlewrap">
            <h3 className="drawer__title">{anime.titleZh || anime.titleJa}</h3>
            {anime.titleZh && anime.titleJa ? <div className="drawer__sub">{anime.titleJa}</div> : null}
            <div className="drawer__meta">
              {[anime.platform, anime.studio, anime.eps ? `${anime.eps} 话` : null]
                .filter(Boolean)
                .join(' · ')}
            </div>
            <div className="drawer__pills">
              <span className="pill">{anime.score != null ? `${anime.score.toFixed(1)} 分` : '评分待补'}</span>
              {anime.watchers != null ? <span className="pill">{anime.watchers.toLocaleString()} 人关注</span> : null}
              {hasBegin ? (
                <span className="pill">
                  {weekdayJST(beginMs)}更新{isLateNight(beginMs) ? ' · 深夜档' : ''}
                </span>
              ) : null}
              {(anime.tags ?? []).slice(0, 4).map((t) => (
                <span key={t} className="pill">{t}</span>
              ))}
            </div>
          </div>
        </div>

        <div className="drawer__body">
          <div className={`drawer__countdown${ws.behind > 0 && !ws.finished ? ' drawer__countdown--hot' : ''}`}>
            {ws.finished ? (
              <span className="drawer__countdown-text">
                全 {anime.eps} 话已播完
                {ws.behind > 0 ? ` · 你还有 ${ws.behind} 话没看` : ''}
              </span>
            ) : ws.behind > 0 ? (
              <span className="drawer__countdown-text">
                第 {ws.latest.episode} 话已更新 · 还有 {ws.behind} 话没看
              </span>
            ) : label ? (
              <>
                <span className="drawer__countdown-num">{label.value}</span>
                <span className="drawer__countdown-unit">
                  {label.unit}更新 · {dateCST(ws.next.ms)} {clockCST(ws.next.ms)}
                </span>
              </>
            ) : (
              <span className="drawer__countdown-text">暂无下一集播出时间</span>
            )}
          </div>

          <div className="drawer__actions">
            <button type="button" className={`btn${following ? ' btn--primary' : ''}`} onClick={onToggleFollow}>
              {following ? '已追 · 点击取消' : '加入追番'}
            </button>
            <button type="button" className="btn" onClick={() => onOpenExternal(anime.external?.moegirl)}>
              萌娘百科
            </button>
            <button type="button" className="btn" onClick={() => onOpenExternal(anime.external?.bangumi)}>
              Bangumi
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => onAddCatchup(anime)}>
              加入补番
            </button>
          </div>

          {anime.summary ? <p className="drawer__summary">{anime.summary}</p> : null}

          <div className="drawer__section">剧集（点一行标记进度）</div>
          {episodes.length === 0 ? (
            <div className="empty">没有可推算的剧集时间</div>
          ) : (
            <div className="eplist">
              {episodes.map((e) => {
                const watched = e.episode <= (watchedEps ?? 0);
                return (
                  <button
                    key={e.episode}
                    type="button"
                    className={`ep${watched ? ' ep--watched' : ''}`}
                    onClick={() => onMarkEpisode(anime.id, watched ? e.episode - 1 : e.episode)}
                  >
                    <span className="ep__no">{String(e.episode).padStart(2, '0')}</span>
                    <span className="ep__time">
                      {e.uncertain ? '播出时间待定' : `${dateCST(e.ms)} ${clockCST(e.ms)}`}
                    </span>
                    <span className="ep__flag">{watched ? '已看' : e.ms > now ? '未播' : '待看'}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
