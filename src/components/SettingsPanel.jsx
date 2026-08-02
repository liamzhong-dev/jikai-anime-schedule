import React, { useRef, useState } from 'react';
import { THEMES, THEME_GROUPS } from '../theme/themes.js';
import { seasonLabel } from '../core/time.js';
import { HOTKEYS } from '../core/hotkeys.js';
import { sourceMeta, SOURCES } from '../data/sources.js';
import { BUILTIN_GENERATED_AT, BUILTIN_SEASONS } from '../data/builtin/index.js';
import { hiddenFeatures, isVisible } from '../core/features.js';
import { formatBytes as fmtBytes } from '../core/wallpaper.js';
import { describeUpdate } from '../core/update.js';
import { prettyKey } from './ShortcutsOverlay.jsx';
import { platform } from '../platform/index.js';
import {
  CONTACT_EMAIL,
  CONTACT_GITHUB_URL,
  CONTACT_GITHUB_USER,
  CONTACT_MAILTO,
} from '../core/contact.js';
import {
  applyLayoutPreset,
  cacheSummary,
  clearSeasonCache,
  deleteLayoutPreset,
  exportLayoutPresets,
  formatBytes,
  importLayoutPresets,
  listPresets,
  patchSettingSection,
  patchSettings,
  renameLayoutPreset,
  resetLayout,
  saveLayoutPreset,
} from '../core/store.js';

const TABS = [
  ['look', '外观'],
  ['data', '数据源'],
  ['layout', '布局'],
  ['remind', '提醒'],
  ['system', '系统'],
  ['contact', '联系'],
];

function ageText(ms) {
  const m = Math.floor((Number(ms) || 0) / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

function Row({ label, hint, children }) {
  return (
    <div className="srow">
      <div className="srow__label">
        <span>{label}</span>
        {hint ? <em className="srow__hint">{hint}</em> : null}
      </div>
      <div className="srow__ctl">{children}</div>
    </div>
  );
}

function Slider({ value, min, max, step, onChange, format, disabled }) {
  return (
    <div className="slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="slider__val">{format ? format(value) : value}</span>
    </div>
  );
}

export default function SettingsPanel({
  open, onClose,
  themeId, onTheme,
  wallpaper, onPickWallpaper, onClearWallpaper, wallpaperBusy,
  settings,
  onDiagnose, diagnosing, diagnoseResult,
  apiTest, onTestApi, testingApi,
  onApplyProxy,
  updateState, onCheckUpdate, onOpenUpdate,
  onExportPresets,
  appInfo, autoLaunch, onAutoLaunch,
  hotkeyInfo, onGlobalHotkey,
  onToast,
}) {
  const [tab, setTab] = useState('look');
  const [presetName, setPresetName] = useState('');
  const [apiId, setApiId] = useState('1');
  const wpFileRef = useRef(null);
  const presetFileRef = useRef(null);
  const [cacheRev, setCacheRev] = useState(0);
  // 预设改名走行内编辑，**不用 window.prompt**：
  // Electron 渲染进程里 prompt() 虽然存在，但一调用就抛
  // 「prompt() is and will not be supported.」，桌面版点改名会当场报错、界面毫无反应。
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  // 联系页的复制反馈：记的是「哪一行刚复制过」，不是复制的内容
  const [copied, setCopied] = useState('');

  const copyContact = async (text, tag) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
      setTimeout(() => setCopied((v) => (v === tag ? '' : v)), 1800);
    } catch {
      // 浏览器里没有剪贴板权限时什么都不做：地址本身就摆在旁边，手抄也行
      setCopied('');
    }
  };

  // 这两个直接现算：数据量很小，而 memo 会因为 store 变化没进依赖而显示旧值
  const summary = cacheSummary();
  void cacheRev;
  const presets = listPresets();
  const wp = wallpaper ?? {};
  const wall = settings?.wallpaper ?? {};

  if (!open) return null;

  const pickWallpaper = async (file) => {
    if (!file) return;
    try {
      await onPickWallpaper(file);
    } catch (err) {
      onToast?.('壁纸导入失败', err?.message ?? String(err));
    }
  };

  const doImportPresets = async (file) => {
    if (!file) return;
    try {
      const text = await file.text();
      const n = importLayoutPresets(JSON.parse(text));
      onToast?.('布局预设已导入', `新增 ${n} 套`);
    } catch (err) {
      onToast?.('导入失败', err?.message ?? String(err));
    }
  };

  const doExportPresets = async () => {
    try {
      await onExportPresets?.();
      onToast?.('已导出布局预设', '包含全部自定义预设');
    } catch (err) {
      onToast?.('导出失败', err?.message ?? String(err));
    }
  };

  const clearCache = (opts, label) => {
    const r = clearSeasonCache(opts);
    setCacheRev((v) => v + 1);
    if (!r.cleared.length) onToast?.('没有可清理的缓存', '当前条件下一项都没命中');
    else onToast?.(label, `清掉 ${r.cleared.length} 个季度 · 释放约 ${formatBytes(r.freedBytes)}`);
  };

  const startRename = (p) => {
    setRenameValue(p.name);
    setRenamingId(p.id);
  };

  const commitRename = (id) => {
    const name = renameValue.trim();
    if (name) renameLayoutPreset(id, name);
    setRenamingId(null);
  };

  return (
    <>
      <div className="drawer__mask" onClick={onClose} />
      <aside className="settings" role="dialog" aria-label="设置">
        <header className="settings__bar">
          <span className="settings__title">设置</span>
          <div className="tabs">
            {TABS.map(([k, label]) => (
              <button
                key={k}
                type="button"
                className={`tabs__btn${tab === k ? ' is-on' : ''}`}
                onClick={() => setTab(k)}
              >
                {label}
              </button>
            ))}
          </div>
          <button type="button" className="window__btn" onClick={onClose} title="关闭">✕</button>
        </header>

        <div className="settings__body">
          {/* ---------------- 外观 ---------------- */}
          {tab === 'look' ? (
            <>
              <section className="ssec">
                <h4 className="ssec__title">
                  配色主题
                  <em className="ssec__hint">共 {THEMES.length} 套 · 点一下立即生效</em>
                </h4>
                {THEME_GROUPS.map((group) => {
                  const list = THEMES.filter((t) => t.group === group);
                  if (!list.length) return null;
                  return (
                    <div key={group} className="theme-group">
                      <div className="theme-group__name">{group}</div>
                      <div className="theme-grid">
                        {list.map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            className={`theme-card${themeId === t.id ? ' is-on' : ''}`}
                            onClick={() => onTheme(t.id)}
                            title={t.desc}
                          >
                            <div className="theme-card__swatches">
                              {t.preview.map((c, i) => (
                                <span key={`${t.id}-${i}`} className="theme-card__sw" style={{ background: c }} />
                              ))}
                            </div>
                            <div className="theme-card__meta">
                              <div className="theme-card__name">{t.name}</div>
                              <div className="theme-card__scene">{t.scene}</div>
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </section>

              <section className="ssec">
                <h4 className="ssec__title">
                  自定义壁纸
                  <em className="ssec__hint">图片会自动压到长边 1920，不会把本地存储撑爆</em>
                </h4>

                <Row label="壁纸图片" hint={wp.name ? `${wp.name} · ${fmtBytes(wp.bytes)}` : '还没有选图'}>
                  <input
                    ref={wpFileRef}
                    type="file"
                    accept="image/*"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      pickWallpaper(e.target.files?.[0]);
                      e.target.value = '';
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={wallpaperBusy}
                    onClick={() => wpFileRef.current?.click()}
                  >
                    {wallpaperBusy ? '处理中…' : wp.name ? '换一张' : '选择图片'}
                  </button>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={Boolean(wall.enabled)}
                      disabled={!wp.dataUrl}
                      onChange={(e) => patchSettingSection('wallpaper', { enabled: e.target.checked })}
                    />
                    启用
                  </label>
                  {wp.dataUrl ? (
                    <button type="button" className="btn" onClick={onClearWallpaper}>移除</button>
                  ) : null}
                </Row>

                <Row label="不透明度" hint="壁纸本身多显眼">
                  <Slider
                    value={wall.opacity ?? 0.55}
                    min={0.05}
                    max={1}
                    step={0.01}
                    disabled={!wall.enabled}
                    onChange={(v) => patchSettingSection('wallpaper', { opacity: v })}
                    format={(v) => `${Math.round(v * 100)}%`}
                  />
                </Row>
                <Row label="模糊" hint="糊一点当背景更不抢眼">
                  <Slider
                    value={wall.blur ?? 0}
                    min={0}
                    max={40}
                    step={1}
                    disabled={!wall.enabled}
                    onChange={(v) => patchSettingSection('wallpaper', { blur: v })}
                    format={(v) => `${v} px`}
                  />
                </Row>
                <Row label="亮度">
                  <Slider
                    value={wall.brightness ?? 1}
                    min={0.2}
                    max={2}
                    step={0.02}
                    disabled={!wall.enabled}
                    onChange={(v) => patchSettingSection('wallpaper', { brightness: v })}
                    format={(v) => `${Math.round(v * 100)}%`}
                  />
                </Row>
                <Row label="缩放" hint="模糊时略微放大，避免边缘露白">
                  <Slider
                    value={wall.scale ?? 1.04}
                    min={1}
                    max={3}
                    step={0.02}
                    disabled={!wall.enabled}
                    onChange={(v) => patchSettingSection('wallpaper', { scale: v })}
                    format={(v) => `${v.toFixed(2)}×`}
                  />
                </Row>
                <Row label="压暗" hint="压在壁纸上的暗角，保证字还看得清">
                  <Slider
                    value={wall.dim ?? 0.22}
                    min={0}
                    max={0.85}
                    step={0.01}
                    disabled={!wall.enabled}
                    onChange={(v) => patchSettingSection('wallpaper', { dim: v })}
                    format={(v) => `${Math.round(v * 100)}%`}
                  />
                </Row>
                <Row label="对齐">
                  <select
                    className="select"
                    value={wall.position ?? 'center'}
                    disabled={!wall.enabled}
                    onChange={(e) => patchSettingSection('wallpaper', { position: e.target.value })}
                  >
                    <option value="center">居中</option>
                    <option value="top">顶部</option>
                    <option value="bottom">底部</option>
                    <option value="left">靠左</option>
                    <option value="right">靠右</option>
                  </select>
                </Row>

                <Row label="卡片不透明度" hint="调低一点，壁纸就能从卡片里透出来">
                  <Slider
                    value={settings?.panelAlpha ?? 1}
                    min={0.3}
                    max={1}
                    step={0.02}
                    onChange={(v) => patchSettings({ panelAlpha: v })}
                    format={(v) => `${Math.round(v * 100)}%`}
                  />
                </Row>
              </section>
            </>
          ) : null}

          {/* ---------------- 数据源 ---------------- */}
          {tab === 'data' ? (
            <>
              <section className="ssec">
                <h4 className="ssec__title">数据源</h4>
                <div className="optlist">
                  {SOURCES.map((s) => (
                    <React.Fragment key={s.id}>
                      <label className={`opt${settings?.dataSource === s.id ? ' is-on' : ''}`}>
                        <input
                          type="radio"
                          name="datasource"
                          checked={settings?.dataSource === s.id}
                          onChange={() => patchSettings({ dataSource: s.id })}
                        />
                        <span className="opt__main">
                          <span className="opt__label">{s.label}</span>
                          <span className="opt__hint">{s.hint}</span>
                        </span>
                        <span className={`tag${s.network ? ' tag--urgent' : ' tag--normal'}`}>
                          {s.network ? '需要网络' : '离线'}
                        </span>
                      </label>
                      {s.needProxy && settings?.dataSource === s.id ? (
                        <div className="hintbar" role="note">
                          <span className="hintbar__mark">VPN</span>
                          <span className="hintbar__text">
                            这个源要连 <code>api.bgm.tv</code>。国内直连基本不通（域名能解析，但 TCP 直接超时），
                            <b>同步前先开 VPN / 系统代理</b>。桌面版会自动跟随系统代理，不用额外填什么；
                            要是还不通，把代理地址填到下面的「代理」栏，或者自建反代填进「反代地址」。
                          </span>
                        </div>
                      ) : null}
                    </React.Fragment>
                  ))}
                </div>
                <p className="snote">
                  内置数据含 {BUILTIN_SEASONS.join(' / ')}，抓取于 {BUILTIN_GENERATED_AT.slice(0, 10)}。
                  这几季不开网络也能看；要别的季度、或者想要最新的话数与评分，
                  切到上面两个联网源再点同步。
                </p>
              </section>

              <section className="ssec">
                <h4 className="ssec__title">
                  Bangumi API
                  <em className="ssec__hint">只补全缺失的话数 / 评分 / 封面 / 简介</em>
                </h4>
                <Row label="官方地址">
                  <input
                    className="input"
                    value={settings?.api?.base ?? ''}
                    onChange={(e) => patchSettingSection('api', { base: e.target.value })}
                    placeholder="https://api.bgm.tv"
                  />
                </Row>
                <Row label="反代地址" hint="被墙时填自建反代，优先级最高；留空则只用官方地址">
                  <input
                    className="input"
                    value={settings?.api?.customBase ?? ''}
                    onChange={(e) => patchSettingSection('api', { customBase: e.target.value })}
                    placeholder="https://你的反代域名"
                  />
                </Row>
                <Row label="代理" hint="形如 http://127.0.0.1:7890 · 留空则跟随系统代理 / VPN">
                  <input
                    className="input"
                    value={settings?.api?.proxy ?? ''}
                    onChange={(e) => patchSettingSection('api', { proxy: e.target.value })}
                    onBlur={(e) => onApplyProxy?.(e.target.value)}
                    placeholder="跟随系统"
                  />
                </Row>
                <Row label="并发 / 超时" hint="官方建议别打太猛">
                  <Slider
                    value={settings?.api?.concurrency ?? 3}
                    min={1}
                    max={8}
                    step={1}
                    onChange={(v) => patchSettingSection('api', { concurrency: v })}
                    format={(v) => `${v} 并发`}
                  />
                  <Slider
                    value={(settings?.api?.timeoutMs ?? 12000) / 1000}
                    min={4}
                    max={30}
                    step={1}
                    onChange={(v) => patchSettingSection('api', { timeoutMs: v * 1000 })}
                    format={(v) => `${v}s`}
                  />
                </Row>
                <Row label="单季度补全上限" hint="防止一次打出上百个请求">
                  <Slider
                    value={settings?.api?.enrichLimit ?? 60}
                    min={0}
                    max={200}
                    step={5}
                    onChange={(v) => patchSettingSection('api', { enrichLimit: v })}
                    format={(v) => (v === 0 ? '不限制' : `${v} 部`)}
                  />
                </Row>

                <div className="sact">
                  <button type="button" className="btn btn--primary" disabled={diagnosing} onClick={onDiagnose}>
                    {diagnosing ? '探测中…' : '连通性诊断'}
                  </button>
                  <input
                    className="input input--mini"
                    value={apiId}
                    onChange={(e) => setApiId(e.target.value.replace(/[^\d]/g, ''))}
                    title="条目 ID"
                    placeholder="条目 ID"
                  />
                  <button type="button" className="btn" disabled={testingApi} onClick={() => onTestApi(Number(apiId) || 1)}>
                    {testingApi ? '请求中…' : '测试一条'}
                  </button>
                </div>

                {diagnoseResult ? (
                  <div className="report">
                    {diagnoseResult.rows.map((r) => (
                      <div key={r.base} className={`report__row${r.ok ? ' is-ok' : ''}`}>
                        <span className="report__dot" />
                        <span className="report__base">{r.base}</span>
                        <span className="report__msg">
                          {r.ok ? `${r.ms} ms · 样例：${r.sample}` : r.error}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}

                {apiTest ? (
                  <div className="report">
                    <div className={`report__row${apiTest.ok ? ' is-ok' : ''}`}>
                      <span className="report__dot" />
                      <span className="report__base">{apiTest.base || '请求失败'}</span>
                      <span className="report__msg">
                        {apiTest.ok
                          ? `${apiTest.patch?.titleZh || apiTest.patch?.titleJa || '拿不到标题'} · ${
                            apiTest.patch?.eps ? `${apiTest.patch.eps} 话 · ` : ''
                          }${apiTest.patch?.score ? `${apiTest.patch.score} 分 · ` : ''
                          }${apiTest.patch?.cover ? '有封面' : '无封面'}`
                          : apiTest.error}
                      </span>
                    </div>
                  </div>
                ) : null}

                <p className="snote">
                  上面三种办法任选一种就行。通了以后点「连通性诊断」，会看到一行绿色的。
                </p>
              </section>

              <section className="ssec">
                <h4 className="ssec__title">
                  季度缓存
                  <em className="ssec__hint">
                    {summary.seasons} 个季度 · {summary.items} 条 · 约 {formatBytes(summary.bytes)}
                  </em>
                </h4>
                {summary.rows.length === 0 ? (
                  <div className="empty empty--inline">还没有缓存。切到需要网络的数据源同步一次就会产生。</div>
                ) : (
                  <div className="cache">
                    <div className="cache__head">
                      <span>季度</span>
                      <span>来源</span>
                      <span>条目</span>
                      <span>大小</span>
                      <span>时间</span>
                      <span />
                    </div>
                    {summary.rows.map((r) => (
                      <div key={r.seasonKey} className="cache__row">
                        <span className="cache__season">
                          {seasonLabel(r.seasonKey)}
                          {r.enriched ? <em className="cache__badge">已补全</em> : null}
                        </span>
                        <span>{sourceMeta(r.source).label.split('（')[0]}</span>
                        <span>{r.count}</span>
                        <span>{formatBytes(r.bytes)}</span>
                        <span>{ageText(r.ageMs)}</span>
                        <span>
                          <button
                            type="button"
                            className="btn btn--mini"
                            onClick={() => clearCache({ key: r.seasonKey }, '已清理该季度缓存')}
                          >
                            清理
                          </button>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="sact">
                  <button type="button" className="btn" onClick={() => clearCache({ olderThanMs: 3 * 86400000 }, '已清理过期缓存')}>
                    清理 3 天前的
                  </button>
                  <button type="button" className="btn" onClick={() => clearCache({ olderThanMs: 12 * 3600000 }, '已清理过期缓存')}>
                    清理 12 小时前的
                  </button>
                  <button type="button" className="btn btn--danger" onClick={() => clearCache({}, '已清空全部缓存')}>
                    全部清空
                  </button>
                </div>
                <p className="snote">清缓存只影响「从网上下下来的番剧表」，你的追番、进度、补番卡都不动。</p>
              </section>
            </>
          ) : null}

          {/* ---------------- 布局 ---------------- */}
          {tab === 'layout' ? (
            <>
              <section className="ssec">
                <h4 className="ssec__title">
                  布局预设
                  <em className="ssec__hint">卡片窗口可以随便拖，拖乱了从这儿一键回位</em>
                </h4>
                <div className="presets">
                  {presets.map((p) => (
                    <div key={p.id} className={`preset${settings?.activePreset === p.id ? ' is-on' : ''}`}>
                      <div className="preset__main">
                        <div className="preset__name">
                          {p.name}
                          {p.builtin ? <em className="preset__badge">内置</em> : null}
                        </div>
                        <div className="preset__desc">{p.desc ?? `保存于 ${ageText(Date.now() - (p.createdAt ?? Date.now()))}`}</div>
                      </div>
                      <div className="preset__ops">
                        <button
                          type="button"
                          className="btn btn--mini"
                          onClick={() => {
                            applyLayoutPreset(p.id);
                            onToast?.('已套用布局', p.name);
                          }}
                        >
                          套用
                        </button>
                        {!p.builtin ? (
                          renamingId === p.id ? (
                            <>
                              <input
                                className="input input--mini input--rename"
                                value={renameValue}
                                autoFocus
                                onChange={(e) => setRenameValue(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') commitRename(p.id);
                                  if (e.key === 'Escape') setRenamingId(null);
                                }}
                              />
                              <button type="button" className="btn btn--mini btn--primary" onClick={() => commitRename(p.id)}>
                                确定
                              </button>
                              <button type="button" className="btn btn--mini" onClick={() => setRenamingId(null)}>
                                取消
                              </button>
                            </>
                          ) : (
                            <>
                              <button type="button" className="btn btn--mini" onClick={() => startRename(p)}>
                                改名
                              </button>
                              <button
                                type="button"
                                className="btn btn--mini btn--danger"
                                onClick={() => deleteLayoutPreset(p.id)}
                              >
                                删除
                              </button>
                            </>
                          )
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="sact">
                  <input
                    className="input"
                    value={presetName}
                    onChange={(e) => setPresetName(e.target.value)}
                    placeholder="给当前布局起个名字"
                  />
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => {
                      const p = saveLayoutPreset(presetName);
                      setPresetName('');
                      onToast?.('已保存预设', `${p.name} · 记下当前所有卡片摆位`);
                    }}
                  >
                    保存当前布局
                  </button>
                </div>
                <div className="sact">
                  <button type="button" className="btn" onClick={doExportPresets}>导出预设文件</button>
                  <input
                    ref={presetFileRef}
                    type="file"
                    accept="application/json,.json"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      doImportPresets(e.target.files?.[0]);
                      e.target.value = '';
                    }}
                  />
                  <button type="button" className="btn" onClick={() => presetFileRef.current?.click()}>导入预设文件</button>
                  <button
                    type="button"
                    className="btn btn--danger"
                    onClick={() => {
                      resetLayout();
                      onToast?.('布局已重置', '所有卡片回到默认位置');
                    }}
                  >
                    全部复位
                  </button>
                </div>
                <p className="snote">
                  预设文件是纯 JSON，可以传给别人、也可以进版本库。注意每套预设覆盖全部四个视图的卡片。
                </p>
              </section>
            </>
          ) : null}

          {/* ---------------- 提醒 ---------------- */}
          {tab === 'remind' ? (
            <>
              <section className="ssec">
                <h4 className="ssec__title">
                  更新提醒
                  <em className="ssec__hint">桌面版才有系统通知；浏览器里降级为页面内提示</em>
                </h4>
                <Row label="提前量">
                  <select
                    className="select"
                    value={settings?.reminderLeadMin ?? 0}
                    onChange={(e) => patchSettings({ reminderLeadMin: Number(e.target.value) })}
                  >
                    <option value={0}>更新时提醒</option>
                    <option value={5}>提前 5 分钟</option>
                    <option value={10}>提前 10 分钟</option>
                    <option value={30}>提前 30 分钟</option>
                    <option value={60}>提前 1 小时</option>
                  </select>
                </Row>
                <Row label="免打扰时段" hint="这段时间内不弹通知">
                  <div className="range">
                    <input
                      type="number"
                      className="input input--num"
                      min={0}
                      max={23}
                      value={settings?.quietHours?.[0] ?? 23}
                      onChange={(e) => patchSettings({ quietHours: [Number(e.target.value), settings?.quietHours?.[1] ?? 8] })}
                    />
                    <span className="range__sep">点 到</span>
                    <input
                      type="number"
                      className="input input--num"
                      min={0}
                      max={23}
                      value={settings?.quietHours?.[1] ?? 8}
                      onChange={(e) => patchSettings({ quietHours: [settings?.quietHours?.[0] ?? 23, Number(e.target.value)] })}
                    />
                    <span className="range__sep">点</span>
                  </div>
                </Row>
                <p className="snote">
                  想让它真的「随时提醒」，得让程序常驻：打开下面系统页里的托盘常驻，关窗口就不会退出了。
                </p>
              </section>

              <section className="ssec">
                <h4 className="ssec__title">快捷键一览</h4>
                <div className="keys__list keys__list--compact">
                  {HOTKEYS.filter((h) => h.id !== 'open-settings-ctrl').map((h) => (
                    <div key={h.id} className="keys__row">
                      <kbd className="kbd">{prettyKey(h.spec)}</kbd>
                      <span className="keys__label">{h.label}</span>
                    </div>
                  ))}
                </div>
                <Row label="启用应用内快捷键">
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={settings?.hotkeysEnabled !== false}
                      onChange={(e) => patchSettings({ hotkeysEnabled: e.target.checked })}
                    />
                    开启
                  </label>
                </Row>
              </section>
            </>
          ) : null}

          {/* ---------------- 系统 ---------------- */}
          {tab === 'system' ? (
            <>
              <section className="ssec">
                <h4 className="ssec__title">托盘与常驻</h4>
                <Row label="显示托盘图标" hint="关掉之后关窗就真的退出了，提醒也不再有效">
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={settings?.tray?.enabled !== false}
                      onChange={(e) => patchSettingSection('tray', { enabled: e.target.checked })}
                    />
                    开启
                  </label>
                </Row>
                <Row label="关闭窗口时收到托盘">
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={settings?.tray?.closeToTray !== false}
                      onChange={(e) => patchSettingSection('tray', { closeToTray: e.target.checked })}
                    />
                    开启
                  </label>
                </Row>
                <Row label="最小化时收到托盘">
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={settings?.tray?.minimizeToTray !== false}
                      onChange={(e) => patchSettingSection('tray', { minimizeToTray: e.target.checked })}
                    />
                    开启
                  </label>
                </Row>
                <Row
                  label="开机自启"
                  hint={autoLaunch?.supported === false ? '当前环境不支持（浏览器里没有这项能力）' : '开机后静默进托盘，不弹窗'}
                >
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={Boolean(autoLaunch?.openAtLogin)}
                      disabled={autoLaunch?.supported === false}
                      onChange={(e) => onAutoLaunch?.(e.target.checked)}
                    />
                    开启
                  </label>
                </Row>
                <Row
                  label="全局快捷键"
                  hint={
                    hotkeyInfo?.ok === false
                      ? `注册失败：${hotkeyInfo.reason}`
                      : settings?.globalHotkey
                        ? '在任何窗口下都能呼出 / 收起主窗口'
                        : '留空表示不注册'
                  }
                >
                  <input
                    className="input"
                    value={settings?.globalHotkey ?? ''}
                    onChange={(e) => patchSettings({ globalHotkey: e.target.value })}
                    placeholder="CommandOrControl+Shift+A"
                  />
                  <button
                    type="button"
                    className="btn"
                    onClick={() => onGlobalHotkey?.(settings?.globalHotkey ?? '')}
                  >
                    应用
                  </button>
                </Row>
              </section>

              {/* 自动更新：实现（IPC 通道 + 纯函数 + 测试）都在，但没有安装包、
                  也没有发布渠道，点「检查更新」只会回一句「未配置更新源」。
                  目前是「先把入口藏起来」的状态 —— 开关在 src/core/features.js，
                  哪天真的打包发版了，把 visible 改回 true 就回来了。 */}
              {isVisible('autoUpdate') ? (
                <section className="ssec">
                  <h4 className="ssec__title">
                    自动更新
                    <em className="ssec__hint">在没做安装包的前提下，这里是「检查 + 跳下载」而不是静默替换</em>
                  </h4>
                  <Row label="当前版本">
                    <span className="kv">{appInfo?.version ?? '—'}</span>
                    {appInfo?.packaged === false ? <span className="tag tag--normal">开发模式</span> : null}
                  </Row>
                  <Row label="更新源地址" hint="支持自定义 manifest JSON，也支持 GitHub Releases API 地址">
                    <input
                      className="input"
                      value={settings?.update?.manifestUrl ?? ''}
                      onChange={(e) => patchSettingSection('update', { manifestUrl: e.target.value })}
                      placeholder="https://example.com/jikai/releases/latest"
                    />
                  </Row>
                  <Row label="启动时自动检查">
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={settings?.update?.autoCheck !== false}
                        onChange={(e) => patchSettingSection('update', { autoCheck: e.target.checked })}
                      />
                      开启
                    </label>
                  </Row>
                  <div className="sact">
                    <button type="button" className="btn btn--primary" disabled={updateState?.checking} onClick={onCheckUpdate}>
                      {updateState?.checking ? '检查中…' : '检查更新'}
                    </button>
                    {settings?.update?.lastCheck ? (
                      <span className="snote snote--inline">上次检查：{ageText(Date.now() - settings.update.lastCheck)}</span>
                    ) : null}
                  </div>
                  <div className={`report report--one${updateState?.result?.hasUpdate ? ' is-update' : ''}`}>
                    <div className="report__row is-ok">
                      <span className="report__dot" />
                      <span className="report__base">{describeUpdate(updateState?.result ?? settings?.update?.lastResult)}</span>
                      {updateState?.result?.hasUpdate && updateState.result.url ? (
                        <button type="button" className="btn btn--mini btn--primary" onClick={onOpenUpdate}>
                          前往下载
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <p className="snote">
                    想升级成「下载完自动替换」的话，需要配合 electron-builder 打安装包并把 release 发到同一处，
                    再把这里换成 electron-updater 即可 —— 判断逻辑（比版本、看是否跳过）已经单独抽出来了，
                    换的时候不用动界面。
                  </p>
                </section>
              ) : null}

              <section className="ssec">
                <h4 className="ssec__title">关于</h4>
                <Row label="运行环境">
                  <span className="kv">
                    {appInfo?.isDesktop ? 'Electron 桌面版' : '浏览器（功能受限）'} · {appInfo?.platform ?? '—'}
                  </span>
                </Row>
                <Row label="数据来源">
                  <span className="kv">bangumi-data（CC BY 4.0）· Bangumi API</span>
                </Row>
                <p className="snote">
                  本作与 Bangumi 官方无关；番剧数据版权归原作者与 bangumi-data 项目所有。
                </p>
                {hiddenFeatures().length ? (
                  <p className="snote">
                    暂不放入口的功能：{hiddenFeatures().map((h) => `${h.label}（${h.reason}）`).join('；')}。
                    代码和测试都保留着，条件具备时把开关打开就回来了。
                  </p>
                ) : null}
              </section>
            </>
          ) : null}

          {/* ---------------- 联系 ---------------- */}
          {tab === 'contact' ? (
            <>
              <section className="ssec">
                <h4 className="ssec__title">
                  联系我
                  <em className="ssec__hint">出问题、数据对不上、想要的功能，都可以直接说</em>
                </h4>
                <Row label="邮箱">
                  <span className="kv">{CONTACT_EMAIL}</span>
                  <button type="button" className="btn btn--mini" onClick={() => copyContact(CONTACT_EMAIL, 'mail')}>
                    {copied === 'mail' ? '已复制' : '复制'}
                  </button>
                  <button type="button" className="btn btn--mini" onClick={() => platform.openExternal(CONTACT_MAILTO)}>
                    写信
                  </button>
                </Row>
                <Row label="GitHub">
                  <span className="kv">@{CONTACT_GITHUB_USER}</span>
                  <button type="button" className="btn btn--mini" onClick={() => copyContact(CONTACT_GITHUB_USER, 'gh')}>
                    {copied === 'gh' ? '已复制' : '复制'}
                  </button>
                  <button
                    type="button"
                    className="btn btn--mini btn--primary"
                    onClick={() => platform.openExternal(CONTACT_GITHUB_URL)}
                  >
                    打开主页
                  </button>
                </Row>
                <p className="snote">
                  提 bug 走 GitHub 的 issue 最快，附上版本号和截图更好定位 —— 当前版本
                  {' '}
                  {appInfo?.version ?? '—'}，侧边栏最下面也写着。
                </p>
              </section>
            </>
          ) : null}
        </div>
      </aside>
    </>
  );
}
