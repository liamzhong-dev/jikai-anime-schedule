import React from 'react';
import Cover from './Cover.jsx';
import { deadlineStatus, progress } from '../core/catchup.js';
import { dateCST } from '../core/time.js';

function toDateValue(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 补番清单：每部一个带 deadline 的卡片。
 * 三档配色直接对应「该不该现在动手」——逾期红、三天内黄、宽裕灰。
 */
export default function CatchupView({ rows, now, onOpen, onPatch, onRemove, onMark, onExternal }) {
  if (rows.length === 0) {
    return (
      <div className="empty">
        补番清单是空的 —— 在番剧详情里点「加入补番」，就会生成一张带 deadline 的卡片
      </div>
    );
  }

  return (
    <div className="board">
      {rows.map(({ item, anime }) => {
        const st = deadlineStatus(item.deadline, now);
        const pg = progress(item);
        const cls = ['catchup', `catchup--${st.level}`];
        if (item.archived) cls.push('catchup--archived');

        return (
          <div key={item.id} className={cls.join(' ')}>
            <div className="catchup__head">
              <Cover anime={anime} className="catchup__cover" />
              <div className="catchup__titlewrap">
                <button type="button" className="catchup__title" onClick={() => onOpen(anime)}>
                  {anime.titleZh || anime.titleJa}
                </button>
                <div className="catchup__eps">
                  {pg.done} / {pg.total} 话 · {pg.remaining === 0 ? '已补完' : `还剩 ${pg.remaining} 话`}
                </div>
              </div>
            </div>

            <div className="bar">
              <div className="bar__fill" style={{ width: `${Math.round(pg.ratio * 100)}%` }} />
            </div>

            <div className="catchup__meta">
              <span className={`tag tag--${pg.remaining === 0 ? 'normal' : st.level}`}>
                {item.archived ? '已归档' : pg.remaining === 0 ? '已完成' : st.label}
              </span>
              <span className="catchup__hint">{dateCST(item.deadline)} 前补完</span>
            </div>

            <div className="catchup__ops">
              <button type="button" className="btn" onClick={() => onMark(item.id, item.watchedEps + 1)}>
                +1 话
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => onOpen(anime)}>详情</button>
              <button type="button" className="btn btn--ghost" onClick={() => onExternal(anime.external?.moegirl)}>
                萌百
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => onPatch(item.id, { archived: !item.archived })}>
                {item.archived ? '恢复' : '归档'}
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => onRemove(item.id)}>删除</button>
            </div>

            <label className="catchup__deadline">
              <span>截止</span>
              <input
                className="date-input"
                type="date"
                value={toDateValue(item.deadline)}
                onChange={(e) => {
                  const ms = Date.parse(`${e.target.value}T23:59:59`);
                  if (!Number.isNaN(ms)) onPatch(item.id, { deadline: ms });
                }}
              />
            </label>
          </div>
        );
      })}
    </div>
  );
}
