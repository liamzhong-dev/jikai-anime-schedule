import React, { useMemo, useState } from 'react';
import AnimeCard from './AnimeCard.jsx';
import { filterSeason, sortList } from '../core/filters.js';
import { watchState } from '../core/time.js';

const SORTS = [
  ['air', '放送日'],
  ['score', '评分'],
  ['heat', '热度'],
  ['title', '名称'],
];

export default function SeasonView({ season, following, now, onToggle, onOpen }) {
  const [sortKey, setSortKey] = useState('air');
  const [platform, setPlatform] = useState('all');
  const [followedOnly, setFollowedOnly] = useState(false);

  // 平台选项从数据里长出来，不写死。
  // 写死成 TV / WEB 的时候踩过一次：某部条目的平台是「其他」，
  // 筛选器里没有这一项，那部就再也筛不出来了。
  const platforms = useMemo(() => {
    const seen = [...new Set(season.map((a) => a.platform).filter(Boolean))].sort();
    return [['all', '全部'], ...seen.map((k) => [k, k])];
  }, [season]);

  const followedIds = useMemo(() => new Set(Object.keys(following ?? {})), [following]);

  const list = useMemo(() => {
    const filtered = filterSeason(season, { followedOnly, platform }, followedIds);
    return sortList(filtered, sortKey);
  }, [season, followedIds, followedOnly, platform, sortKey]);

  return (
    <>
      <div className="toolbar">
        <span className="toolbar__label">排序</span>
        <div className="seg">
          {SORTS.map(([k, label]) => (
            <button
              key={k}
              type="button"
              className={`seg__btn${sortKey === k ? ' is-on' : ''}`}
              onClick={() => setSortKey(k)}
            >
              {label}
            </button>
          ))}
        </div>

        <span className="toolbar__label">平台</span>
        <div className="seg">
          {platforms.map(([k, label]) => (
            <button
              key={k}
              type="button"
              className={`seg__btn${platform === k ? ' is-on' : ''}`}
              onClick={() => setPlatform(k)}
            >
              {label}
            </button>
          ))}
        </div>

        <button
          type="button"
          className={`btn${followedOnly ? ' btn--primary' : ''}`}
          onClick={() => setFollowedOnly((v) => !v)}
        >
          只看已追
        </button>

        <div className="toolbar__spacer" />
        <span className="toolbar__note">{list.length} / {season.length} 部</span>
      </div>

      {list.length === 0 ? (
        <div className="empty">
          没有符合条件的番剧 —— 换个关键词，或把「只看已追」关掉
        </div>
      ) : (
        <div className="cardgrid">
          {list.map((a) => {
            const f = following?.[a.id];
            return (
              <AnimeCard
                key={a.id}
                anime={a}
                following={Boolean(f)}
                state={f ? watchState(a, f.watchedEps ?? 0, now) : null}
                onToggle={onToggle}
                onOpen={onOpen}
              />
            );
          })}
        </div>
      )}
    </>
  );
}
