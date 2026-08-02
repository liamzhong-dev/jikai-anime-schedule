import React from 'react';

const ITEMS = [
  {
    key: 'season',
    label: '本季番剧',
    icon: (
      <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6">
        <rect x="2.5" y="2.5" width="6.5" height="6.5" rx="1.6" />
        <rect x="11" y="2.5" width="6.5" height="6.5" rx="1.6" />
        <rect x="2.5" y="11" width="6.5" height="6.5" rx="1.6" />
        <rect x="11" y="11" width="6.5" height="6.5" rx="1.6" />
      </svg>
    ),
  },
  {
    key: 'schedule',
    label: '时间表',
    icon: (
      <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6">
        <rect x="2.5" y="4" width="15" height="13.5" rx="2" />
        <path d="M2.5 8h15M6.5 2.5v3M13.5 2.5v3" />
      </svg>
    ),
  },
  {
    key: 'following',
    label: '我的追番',
    icon: (
      <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M10 2.8l2.2 4.5 5 .7-3.6 3.5.85 4.9L10 13.9l-4.45 2.5.85-4.9L2.8 8l5-.7z" />
      </svg>
    ),
  },
  {
    key: 'catchup',
    label: '补番清单',
    icon: (
      <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M3 5.5h14M3 10h14M3 14.5h8" />
        <circle cx="15.5" cy="14.5" r="2" />
      </svg>
    ),
  },
];

export default function SideNav({ view, onView, counts, version, onOpenSettings }) {
  return (
    <nav className="sidenav">
      <div className="sidenav__logo" title="次回">次</div>
      {ITEMS.map((it) => (
        <button
          key={it.key}
          type="button"
          className={`sidenav__item${view === it.key ? ' is-active' : ''}`}
          onClick={() => onView(it.key)}
        >
          {it.icon}
          <span>{it.label}</span>
          {counts?.[it.key] ? <em className="sidenav__count">{counts[it.key]}</em> : null}
        </button>
      ))}
      <div className="sidenav__spacer" />
      <button type="button" className="sidenav__item sidenav__item--foot" onClick={onOpenSettings} title="设置">
        <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="10" cy="10" r="2.6" />
          <path d="M10 2.6v2M10 15.4v2M2.6 10h2M15.4 10h2M4.8 4.8l1.4 1.4M13.8 13.8l1.4 1.4M15.2 4.8l-1.4 1.4M6.2 13.8l-1.4 1.4" />
        </svg>
        <span>设置</span>
      </button>
      <div className="sidenav__foot">v{version || '0.2'}</div>
    </nav>
  );
}
