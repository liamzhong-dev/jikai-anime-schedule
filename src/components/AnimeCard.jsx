import React from 'react';
import Cover from './Cover.jsx';
import { clockCST, isLateNight, weekdayJST } from '../core/time.js';

/**
 * 番剧卡片。
 * 左上角是「周几更新」徽标，右上角星标即追番开关 —— 番剧党认封面不认标题，
 * 所以把这两个高频操作直接压在封面上，不用先点进详情。
 */
export default function AnimeCard({ anime, following, state, onToggle, onOpen }) {
  const beginMs = Date.parse(anime.begin ?? '');
  const weekday = Number.isNaN(beginMs) ? '待定' : weekdayJST(beginMs);
  const late = !Number.isNaN(beginMs) && isLateNight(beginMs);

  return (
    <div className="card">
      <Cover anime={anime} className="card__cover">
        <span className="card__badge">
          {weekday}
          {late ? <em className="card__badge-late">深夜</em> : null}
        </span>
        <button
          type="button"
          className={`card__follow${following ? ' card__follow--on' : ''}`}
          title={following ? '取消追番' : '加入追番'}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(anime.id);
          }}
        >
          {following ? '★' : '☆'}
        </button>
      </Cover>

      <button type="button" className="card__title" onClick={() => onOpen(anime)} title={anime.titleJa}>
        {anime.titleZh || anime.titleJa}
      </button>

      <div className="card__meta">
        {anime.score != null ? <span className="card__score">{anime.score.toFixed(1)}</span> : null}
        <span>{Number.isNaN(beginMs) ? '时间待定' : `${clockCST(beginMs)} 更新`}</span>
        {state?.finished ? <span className="card__flag">完结</span> : null}
      </div>
    </div>
  );
}
