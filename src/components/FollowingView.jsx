import React from 'react';
import Cover from './Cover.jsx';
import { countdownLabel, dateTimeCST, sinceLabel } from '../core/time.js';

const STATUS = {
  watching: { text: '在看', cls: 'pill--watching' },
  wish: { text: '想看', cls: '' },
  on_hold: { text: '搁置', cls: 'pill--hold' },
  dropped: { text: '弃了', cls: 'pill--hold' },
};

/**
 * 追番队列 —— 不是「列表」，是「接下来先看什么」。
 *
 * 所以倒计时是主视觉、按剩余时间排序；已经更新的排最前面并换成绿色。
 * 落后多话的和刚更新的要分开说：前者该催他补，后者只是提醒一声。
 */
export default function FollowingView({ rows, now, onOpen, onMark, onSetStatus, onExternal, onUnfollow }) {
  if (rows.length === 0) {
    return (
      <div className="empty">
        还没有追番 —— 去「本季番剧」点封面右上角的星星即可加入
      </div>
    );
  }

  return (
    <div className="queue">
      {rows.map(({ anime, watched, status, ws, next, cd }) => {
        const st = STATUS[status] ?? STATUS.watching;
        const label = cd ? countdownLabel(cd) : null;
        const updated = cd?.overdue && !ws.finished;

        const rowCls = ['queue__row'];
        if (updated) rowCls.push('queue__row--hot');

        return (
          <div key={anime.id} className={rowCls.join(' ')}>
            <Cover anime={anime} className="queue__cover" />

            <div className="queue__info">
              <div className="queue__title">{anime.titleZh || anime.titleJa}</div>
              <div className="queue__sub">
                {anime.eps ? `已看 ${watched} / ${anime.eps} 话` : `已看 ${watched} 话`}
                <span className={`pill ${st.cls}`}>{st.text}</span>
                {ws.finished ? <span className="pill">已完结</span> : null}
                {next?.precision === 'date' ? <span className="pill">时刻待定</span> : null}
              </div>
            </div>

            <div className="queue__count">
              {ws.finished ? (
                <div className="queue__value queue__value--muted">完结</div>
              ) : updated ? (
                <>
                  <div className="queue__value queue__value--hot">已更新</div>
                  <div className="queue__unit">
                    {ws.behind > 1 ? `${ws.behind} 话待看` : sinceLabel(next.ms, now)}
                  </div>
                </>
              ) : label ? (
                <>
                  <div className="queue__value">{label.value}</div>
                  <div className="queue__unit">
                    {label.unit} · {dateTimeCST(next.ms)}
                  </div>
                </>
              ) : (
                <div className="queue__value queue__value--muted">待定</div>
              )}
            </div>

            <div className="queue__ops">
              <button type="button" className="btn" title="看了一集" onClick={() => onMark(anime.id, watched + 1)}>
                +1
              </button>
              <button type="button" className="btn" onClick={() => onOpen(anime)}>详情</button>
              <button type="button" className="btn btn--ghost" onClick={() => onExternal(anime.external?.bangumi)}>
                BGM
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => onExternal(anime.external?.moegirl)}>
                萌百
              </button>
              <select
                className="select select--mini"
                value={status ?? 'watching'}
                onChange={(e) => onSetStatus(anime.id, e.target.value)}
                title="追番状态"
              >
                <option value="watching">在看</option>
                <option value="wish">想看</option>
                <option value="on_hold">搁置</option>
                <option value="dropped">弃了</option>
              </select>
              <button type="button" className="btn btn--ghost" title="取消追番" onClick={() => onUnfollow(anime.id)}>
                移出
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
