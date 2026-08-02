import React, { useMemo, useState } from 'react';
import Cover from './Cover.jsx';
import { MS_PER_DAY, airingsInRange, clockCST, isLateNight, startOfCSTDay, toCST, weekdayJST } from '../core/time.js';
import { buildNight } from '../core/schedule.js';

const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]; // 周一 … 周日
const WEEK_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 播出时间表。
 *
 * 分组口径是**北京时间**而不是日本时间：番剧党的实际作息是在北京时间的夜里等更新，
 * 日本 25:30 的深夜档在他这里就是次日凌晨 00:30，按 JST 归组这张表会和他的熬夜时间对不上。
 */
export default function ScheduleView({ season, following, now, onOpen }) {
  const [mode, setMode] = useState('week');

  const week = useMemo(() => {
    const dayStart = startOfCSTDay(now);
    const back = (toCST(now).weekday + 6) % 7;
    const monday = dayStart - back * MS_PER_DAY;

    const cols = WEEK_ORDER.map((weekday, i) => {
      const from = monday + i * MS_PER_DAY;
      const cst = toCST(from);
      return {
        weekday,
        label: WEEK_LABEL[weekday],
        dateLabel: `${cst.month}/${cst.day}`,
        isToday: from === dayStart,
        items: [],
      };
    });

    for (const a of season) {
      for (const air of airingsInRange(a, monday, monday + 7 * MS_PER_DAY, 4)) {
        const idx = WEEK_ORDER.indexOf(toCST(air.ms).weekday);
        if (cols[idx]) cols[idx].items.push({ anime: a, ...air });
      }
    }
    cols.forEach((c) => c.items.sort((x, y) => x.ms - y.ms));
    return cols;
  }, [season, now]);

  // 日视图照顾深夜档：从当天 18:00 排到次日 06:00
  const night = useMemo(() => buildNight(season, now).items, [season, now]);

  const total = week.reduce((n, c) => n + c.items.length, 0);

  return (
    <>
      <div className="toolbar">
        <div className="seg">
          <button
            type="button"
            className={`seg__btn${mode === 'week' ? ' is-on' : ''}`}
            onClick={() => setMode('week')}
          >
            周视图
          </button>
          <button
            type="button"
            className={`seg__btn${mode === 'day' ? ' is-on' : ''}`}
            onClick={() => setMode('day')}
          >
            深夜档
          </button>
        </div>
        <div className="toolbar__spacer" />
        <span className="toolbar__note">
          本周 {total} 次更新 · 深夜档归入次日凌晨
        </span>
      </div>

      {mode === 'week' ? (
        <div className="weekgrid">
          {week.map((col) => (
            <div key={col.label} className={`weekcol${col.isToday ? ' weekcol--today' : ''}`}>
              <div className="weekcol__head">
                <span className="weekcol__name">{col.label}</span>
                <span className="weekcol__date">{col.dateLabel}</span>
              </div>
              {col.items.length === 0 ? (
                <div className="weekcol__empty">—</div>
              ) : (
                col.items.map((it) => {
                  const follow = Boolean(following?.[it.anime.id]);
                  const cls = ['slot'];
                  if (follow) cls.push('slot--follow');
                  if (it.uncertain) cls.push('slot--uncertain');
                  return (
                    <button
                      key={`${it.anime.id}-${it.episode}`}
                      type="button"
                      className={cls.join(' ')}
                      onClick={() => onOpen(it.anime)}
                      title={`${it.anime.titleZh || it.anime.titleJa} 第 ${it.episode} 话`}
                    >
                      <span className="slot__time">
                        {it.uncertain ? '待定' : clockCST(it.ms)}
                        {isLateNight(it.ms) ? <em className="slot__late">深夜</em> : null}
                      </span>
                      <span className="slot__name">{it.anime.titleZh || it.anime.titleJa}</span>
                      <span className="slot__ep">第 {it.episode} 话</span>
                    </button>
                  );
                })
              )}
            </div>
          ))}
        </div>
      ) : night.length === 0 ? (
        <div className="empty">今晚 18:00 到次日 06:00 没有排播</div>
      ) : (
        <div className="queue">
          {night.map((it) => (
            <div key={`${it.anime.id}-${it.episode}`} className="queue__row">
              <Cover anime={it.anime} className="queue__cover" />
              <div className="queue__info">
                <div className="queue__title">{it.anime.titleZh || it.anime.titleJa}</div>
                <div className="queue__sub">
                  第 {it.episode} 话 · {clockCST(it.ms)} · 日本 {weekdayJST(it.ms)}
                  {following?.[it.anime.id] ? ' · 已追' : ''}
                </div>
              </div>
              <div className="queue__ops">
                <button type="button" className="btn" onClick={() => onOpen(it.anime)}>详情</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
