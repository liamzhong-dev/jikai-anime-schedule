import React, { useMemo, useState } from 'react';
import SeasonPicker from './SeasonPicker.jsx';
import { ageText, seasonLabel } from '../core/time.js';

/**
 * 本地库：把「更新 Bangumi 数据」这件事做成看得见、可控的一步。
 *
 * 单独一个组件的理由：它有自己的三块状态（要更新哪些季度、要不要重建索引、
 * 上一次跑到哪一步），塞进设置面板会让它变成上千行的巨型组件，
 * 而这三块状态跟「外观 / 主题」那些完全不搭界。
 *
 * 界面上刻意做重了说明文字：这一按钮会下载 7.5 MB、
 * 涉及联网，用户有权知道自己在点什么。
 */

/** 组名 → 人话。季度 key 走 seasonLabel，补番组是固定名 */
function groupLabel(key) {
  if (key === 'catchup') return '补番组';
  if (/^\d{4}q[1-4]$/.test(String(key))) return seasonLabel(key);
  return String(key);
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(2)} MB`;
}

export default function LibraryPanel({
  seasons = [],
  nameIndex = null,
  coverStats = null,
  groups = [],
  running = false,
  progress = null,       // { pct, label }
  report = null,         // 上一次同步的报告
  onRun,
  onClearCovers,
  onClearNameIndex,
  onToast,
}) {
  // 默认勾最近 4 个季度：再多意义不大，而每多一季就多一份缓存要维护
  const [picked, setPicked] = useState(() => (seasons.slice(0, 4)));
  const [rebuild, setRebuild] = useState(false);

  const indexFresh = useMemo(() => {
    if (!nameIndex?.builtAt) return null;
    return nameIndex.builtAt;
  }, [nameIndex]);

  const doRun = () => {
    if (running) return;
    if (!picked.length && !rebuild) {
      onToast?.('没有选季度', '至少要勾一个季度，或者勾上「重建名称索引」');
      return;
    }
    onRun?.({ seasonKeys: picked, rebuildIndex: rebuild });
  };

  const doClearCovers = async (group) => {
    const r = await onClearCovers?.(group ? { group } : {});
    if (r?.error) {
      onToast?.('清理失败', r.error);
      return;
    }
    if (!r?.removed) onToast?.('没有可清理的封面', group ? `${groupLabel(group)} 里没有缓存` : '本地还没有缓存封面');
    else onToast?.('封面缓存已清理', `${group ? groupLabel(group) : '全部'} · ${r.removed} 张 · 释放 ${fmtBytes(r.freedBytes)}`);
  };

  const coverGroups = coverStats?.groups ?? [];

  return (
    <>
      <section className="ssec">
        <h4 className="ssec__title">
          更新 Bangumi 数据
          <em className="ssec__hint">一次下载，派生出名称索引 + 季度分组 + 补番组</em>
        </h4>

        <p className="snote">
          点一次会拉 <code>bangumi-data</code> 的全量数据集（约 7.5 MB，挂代理时大概 7 秒），
          然后按下面勾选的季度分别落缓存。<b>平时不需要点它</b> ——
          想看某一季，直接在顶栏切季度就行，这只是一个补齐 / 刷新的入口。
          <br />
          名称索引是<b>所有动画的名字表</b>（实测 8833 部 · 约 0.95 MB），专门为了让你能搜到
          当前季度之外的老番并加进补番清单。它按季度一月变不了几次，所以默认是「没有才建」。
        </p>

        <div className="srow">
          <div className="srow__label">
            <span>要更新的季度</span>
            <em className="srow__hint">已选 {picked.length} 个 · 可搜 2011 / 2011q3 / 2011 年 7 月</em>
          </div>
          <div className="srow__ctl">
            {/*
              原来这里是一排按钮，而可选项来自 `availableSeasons()` —— **只有 9 季**，
              所以 2011 年 7 月番根本选不到（想给老番建缓存是做不到的）。
              现在跟顶栏共用同一个可搜索的选择器，候选扩到 2000 年至今。
            */}
            <SeasonPicker
              mode="multi"
              seasons={seasons}
              values={picked}
              onPick={setPicked}
              disabled={running}
            />
          </div>
        </div>

        <div className="srow">
          <div className="srow__label">
            <span>重建名称索引</span>
            <em className="srow__hint">
              {indexFresh ? `当前索引建于 ${ageText(indexFresh)}` : '当前还没有索引'}
            </em>
          </div>
          <div className="srow__ctl">
            <label className="check" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={rebuild} onChange={(e) => setRebuild(e.target.checked)} disabled={running} />
              <span>无视「还新鲜」，强制重建</span>
            </label>
          </div>
        </div>

        <div className="srow">
          <div className="srow__label">
            <span />
          </div>
          <div className="srow__ctl">
            <button type="button" className="btn btn--primary" onClick={doRun} disabled={running}>
              {running ? `更新中 ${progress?.pct ?? 0}%` : '更新 Bangumi 数据'}
            </button>
            <span style={{ marginLeft: 10, fontSize: 12, color: 'var(--text-2)' }}>
              {running ? (progress?.label ?? '正在处理') : '联网前记得开 VPN / 代理'}
            </span>
          </div>
        </div>

        {running ? (
          <div className="bar" style={{ marginTop: 8 }}>
            <div className="bar__fill" style={{ width: `${Math.max(2, progress?.pct ?? 0)}%` }} />
          </div>
        ) : null}

        {report ? (
          <div className={`report__row${report.ok ? ' is-ok' : ''}`} style={{ marginTop: 10 }}>
            <span className="report__dot" />
            <span className="report__msg">{report.text}</span>
          </div>
        ) : null}
      </section>

      <section className="ssec">
        <h4 className="ssec__title">
          本地库存
          <em className="ssec__hint">名称索引、分组与封面缓存</em>
        </h4>

        <div className="mini-list">
          <div className="mini-row">
            <div className="mini-row__main">
              <div className="mini-row__title">名称索引</div>
              <div className="mini-row__meta">
                {nameIndex?.count
                  ? `${nameIndex.count} 部 · 覆盖 ${nameIndex.span?.[0] ?? '?'}–${nameIndex.span?.[1] ?? '?'} 年 · ${ageText(nameIndex.builtAt)}更新`
                  : '还没有建立 —— 点上面的「更新 Bangumi 数据」，或者勾上强制重建'}
              </div>
            </div>
            {nameIndex?.count ? (
              <button
                type="button"
                className="btn btn--mini btn--ghost"
                onClick={async () => { await onClearNameIndex?.(); onToast?.('名称索引已清除', '下次更新会重新建立'); }}
              >
                清除
              </button>
            ) : null}
          </div>

          {groups.map((g) => (
            <div className="mini-row" key={g.key}>
              <div className="mini-row__main">
                <div className="mini-row__title">{g.label}</div>
                <div className="mini-row__meta">
                  {g.count} 部{g.hint ? ` · ${g.hint}` : ''}
                </div>
              </div>
              <span className="tag tag--normal">{g.count ? '已归档' : '空'}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="ssec">
        <h4 className="ssec__title">
          封面缓存
          <em className="ssec__hint">
            共 {coverStats?.totalFiles ?? 0} 张 · {fmtBytes(coverStats?.totalBytes ?? 0)}
          </em>
        </h4>

        <p className="snote">
          封面按组分开存（一个季度一个目录、补番组一个目录），所以清理可以对着一个组来，
          不用一刀切。拿不至于扑再说 —— 缓存不是为了省流量，
          而是<b>断网时还能看见封面</b>：实测关掉 VPN 之后 <code>lain.bgm.tv</code> 整体不可达。
        </p>

        {coverGroups.length ? (
          <div className="cache">
            <div className="cache__head">
              <span className="cache__season">组</span>
              <span className="cache__badge">张数 / 占用</span>
              <span />
            </div>
            {coverGroups.map((g) => (
              <div className="cache__row" key={g.group}>
                <span className="cache__season">{groupLabel(g.group)}</span>
                <span className="cache__badge">{g.files} 张 · {fmtBytes(g.bytes)}</span>
                <button type="button" className="btn btn--mini btn--ghost" onClick={() => doClearCovers(g.group)}>
                  清理
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty empty--inline">本地还没有缓存任何封面</div>
        )}

        {coverStats?.totalFiles ? (
          <div className="sact" style={{ marginTop: 10 }}>
            <button type="button" className="btn btn--danger btn--mini" onClick={() => doClearCovers(null)}>
              清空全部封面缓存
            </button>
          </div>
        ) : null}
      </section>
    </>
  );
}
