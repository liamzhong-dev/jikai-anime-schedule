import React from 'react';
import Cover from './Cover.jsx';

/**
 * 番堂条目的详细资料。
 *
 * 数据全部来自番堂页的「介绍区」—— 也就是排播表里**没有**的那部分：
 * 原名、改编类型、题材标签、制作名单、声优、官网/PV。
 *
 * ⚠️ 这些字段是**对不上就没有**的：能对上的条目（绝大多数）字段齐全，
 * 对不上的只在排播表里出现，除了时刻和封面什么都没有。所以每一块都要
 * 「有才画」，不能画一个空标题栏 —— 那看起来像解析坏了。
 *
 * 对上了自己的库时多一条出口：直接打开 Bangumi 那边的详情（评分、话数、日记
 * 都在那边）。这是这一页和「本季番剧」唯一的交汇点，也是它值得单独存在的理由：
 * 时刻表来自番堂、条目资料来自 Bangumi，两边各有各的用处。
 */
export default function YucDetail({ item, lib, onOpenLibrary }) {
  if (!item) {
    return (
      <div className="empty" data-yuc-detail="">
        点左边任意一条，这里显示它的原名、制作、声优和官网。
      </div>
    );
  }

  const staff = item.staff ?? [];
  const tags = item.tags ?? [];
  const links = item.links ?? [];

  return (
    <div className="yuc-detail" data-yuc-detail={item.id}>
      <div className="yuc-detail__head">
        <Cover
          anime={{ id: item.id, titleZh: item.titleZh, titleJa: item.titleJa, cover: item.cover }}
          className="yuc-detail__cover"
        />
        <div className="yuc-detail__names">
          <h3 className="yuc-detail__title">{item.titleZh}</h3>
          {item.titleJa ? <p className="yuc-detail__ja">{item.titleJa}</p> : null}
          <p className="yuc-detail__group">
            {item.groupLabel}
            {item.time ? ` · ${item.time}` : ''}
            {item.startDate ? ` · 首播 ${item.startDate}` : ''}
          </p>
          {item.broadcast ? (
            <p className="yuc-detail__bcast">
              首播 {item.broadcast}
              {item.broadcastNote ? `（${item.broadcastNote}）` : ''}
            </p>
          ) : null}
          {item.kind || tags.length ? (
            <p className="yuc-detail__chips">
              {item.kind ? <span className="yuc-chip">{item.kind}</span> : null}
              {tags.map((t) => (
                <span key={t} className="yuc-chip yuc-chip--soft">{t}</span>
              ))}
            </p>
          ) : null}
        </div>
      </div>

      {lib ? (
        <div className="yuc-detail__own" data-yuc-own={lib.id}>
          <span>
            你的库里有这条：
            <strong>{lib.titleZh || lib.titleJa}</strong>
          </span>
          <button type="button" className="btn" data-yuc-open-lib={lib.id} onClick={() => onOpenLibrary?.(lib)}>
            看评分与日记
          </button>
        </div>
      ) : null}

      {staff.length ? (
        <>
          <h4 className="yuc-detail__sec">制作</h4>
          <dl className="yuc-staff">
            {staff.map((s, i) => (
              <div className="yuc-staff__row" key={`${s.role}-${i}`}>
                <dt>{s.role || '—'}</dt>
                <dd>{(s.people ?? []).join('、')}</dd>
              </div>
            ))}
          </dl>
        </>
      ) : null}

      {item.cast?.length ? (
        <>
          <h4 className="yuc-detail__sec">声优</h4>
          <p className="yuc-detail__cast">{item.cast.join('、')}</p>
        </>
      ) : null}

      {links.length ? (
        <>
          <h4 className="yuc-detail__sec">官网 / PV</h4>
          <p className="yuc-detail__links">
            {links.map((l) => (
              // 外链一律交给系统浏览器，不在应用里开新窗口 —— 应用窗口只有一个，
              // 拿它去显示网页会把整个界面顶掉，而且回不来
              <a key={l.url} className="btn" href={l.url} target="_blank" rel="noreferrer noopener">
                {l.label}
              </a>
            ))}
          </p>
        </>
      ) : null}

      {!staff.length && !item.cast?.length && !links.length ? (
        <p className="yuc-detail__note">
          这一条在番堂的介绍区里没找到对应资料（排播表里有、介绍区里没有的条目是常事），
          所以只有时刻和封面。
        </p>
      ) : null}
    </div>
  );
}
