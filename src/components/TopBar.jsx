import React from 'react';
import ProgressBar from './ProgressBar.jsx';
import { seasonLabel } from '../core/time.js';
import { SOURCES } from '../data/sources.js';
import { getTheme } from '../theme/themes.js';

const TITLES = {
  season: '本季番剧',
  schedule: '播出时间表',
  following: '我的追番',
  catchup: '补番清单',
};

export default function TopBar({
  view, seasonKey, seasons, onSeason,
  keyword, onKeyword,
  onRefresh, syncing, progress,
  dataSource, onDataSource,
  onOpenSettings, themeId, onCycleTheme,
  wallpaperOn, onToggleWallpaper,
}) {
  const theme = getTheme(themeId);

  return (
    <header className="topbar">
      <div className="topbar__title">{TITLES[view] ?? '次回'}</div>

      <select className="select" value={seasonKey} onChange={(e) => onSeason(e.target.value)} title="切换季度">
        {seasons.map((s) => (
          <option key={s} value={s}>{seasonLabel(s)}</option>
        ))}
      </select>

      <input
        className="topbar__search"
        value={keyword}
        placeholder="搜番剧名 / 制作公司 / 标签"
        onChange={(e) => onKeyword(e.target.value)}
        data-search-input="1"
      />

      <div className="topbar__spacer" />

      <select
        className="select"
        value={dataSource}
        onChange={(e) => onDataSource(e.target.value)}
        title="数据源（带「需 VPN」的两个要连 api.bgm.tv，国内得先开代理）"
      >
        {SOURCES.map((s) => (
          <option key={s.id} value={s.id}>{s.needProxy ? `${s.label} · 需 VPN` : s.label}</option>
        ))}
      </select>

      <button
        type="button"
        className={`btn${syncing ? '' : ' btn--primary'}`}
        onClick={onRefresh}
        disabled={syncing}
      >
        {syncing ? '同步中…' : '同步数据'}
      </button>

      <button
        type="button"
        className={`iconbtn${wallpaperOn ? ' is-on' : ''}`}
        title={`壁纸：${wallpaperOn ? '开' : '关'}（快捷键 B）`}
        onClick={onToggleWallpaper}
      >
        <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6">
          <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
          <path d="M2.5 12.5l4-4 3.5 3.5 3-3 4 4" />
          <circle cx="7" cy="7.5" r="1.2" />
        </svg>
      </button>

      <button
        type="button"
        className="btn btn--ghost"
        title={`配色：${theme.name}（快捷键 T 逐套切换）`}
        onClick={onCycleTheme}
      >
        <span className="themedot" style={{ background: theme.colors.accent }} />
        {theme.name}
      </button>

      <button
        type="button"
        className="iconbtn"
        title="设置（快捷键 ,）"
        onClick={onOpenSettings}
      >
        <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="10" cy="10" r="2.6" />
          <path d="M10 2.6v2M10 15.4v2M2.6 10h2M15.4 10h2M4.8 4.8l1.4 1.4M13.8 13.8l1.4 1.4M15.2 4.8l-1.4 1.4M6.2 13.8l-1.4 1.4" />
        </svg>
      </button>

      <ProgressBar progress={progress} active={syncing} />
    </header>
  );
}
