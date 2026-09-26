import React from 'react';
import Cover from './Cover.jsx';
import { clockCST, isLateNight, weekdayJST } from '../core/time.js';

/**
 * 番剧卡片。
 * 左上角是「周几更新」徽标，右上角星标即追番开关 —— 番剧党认封面不认标题，
 * 所以把这两个高频操作直接压在封面上，不用先点进详情。
 *
 * 封面**整块**都是「打开详情」的热区（曾经只有下面那行标题能点，
 * 但 `.card__cover` 的 `cursor: pointer` 一直写着 —— 设计意图本来就是这样，
 * 只是漏了接处理函数）。
 */
export default function AnimeCard({ anime, following, state, onToggle, onOpen }) {
  const beginMs = Date.parse(anime.begin ?? '');
  const weekday = Number.isNaN(beginMs) ? '待定' : weekdayJST(beginMs);
  const late = !Number.isNaN(beginMs) && isLateNight(beginMs);
  const title = anime.titleZh || anime.titleJa;

  return (
    <div className="card">
      <Cover anime={anime} className="card__cover">
        {/*
          用一个铺满封面的透明 <button> 做热区，而不是给 <Cover> 挂 onClick：
          ① `Cover` 是本季 / 时间表 / 追番 / 补番 / 日记 / 抽屉等**七个地方共用**的，
             把行为做进组件里会顺带改掉其余六处；
          ② 真的按钮才吃得到 Tab 与回车，`div + onClick` 吃不到。
          它在 DOM 里排在徽标与星标**前面**，所以那两样仍压在它上面
          （星标 click 里已经 stopPropagation，点星标不会连带开详情）。
        */}
        <button
          type="button"
          className="card__open"
          data-card-open={anime.id}
          aria-label={`打开《${title}》的详情`}
          onClick={() => onOpen(anime)}
        />
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
        {title}
      </button>

      <div className="card__meta">
        {anime.score != null ? <span className="card__score">{anime.score.toFixed(1)}</span> : null}
        <span>{Number.isNaN(beginMs) ? '时间待定' : `${clockCST(beginMs)} 更新`}</span>
        {state?.finished ? <span className="card__flag">完结</span> : null}
      </div>
    </div>
  );
}
