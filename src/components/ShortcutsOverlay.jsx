import React from 'react';
import { hotkeysByGroup } from '../core/hotkeys.js';

/** 快捷键帮助浮层：按 ? 打开 */
export default function ShortcutsOverlay({ open, onClose, globalHotkey }) {
  if (!open) return null;
  const groups = hotkeysByGroup();

  return (
    <>
      <div className="drawer__mask" onClick={onClose} />
      <div className="modal" role="dialog" aria-label="快捷键">
        <header className="modal__bar">
          <span className="modal__title">快捷键</span>
          <button type="button" className="window__btn" onClick={onClose} title="关闭">✕</button>
        </header>
        <div className="modal__body">
          {groups.map((g) => (
            <section key={g.group} className="keys">
              <div className="keys__group">{g.group}</div>
              <div className="keys__list">
                {g.items.map((h) => (
                  <div key={h.id} className="keys__row">
                    <kbd className="kbd">{prettyKey(h.spec)}</kbd>
                    <span className="keys__label">{h.label}</span>
                  </div>
                ))}
              </div>
            </section>
          ))}
          {globalHotkey ? (
            <section className="keys">
              <div className="keys__group">全局（任何窗口下都生效）</div>
              <div className="keys__list">
                <div className="keys__row">
                  <kbd className="kbd">{prettyKey(globalHotkey)}</kbd>
                  <span className="keys__label">显示 / 隐藏主窗口</span>
                </div>
              </div>
            </section>
          ) : null}
          <p className="modal__note">
            输入框里打字时，单字符快捷键（1 / r / t…）会让路；Esc 与 Ctrl 组合始终生效。
          </p>
        </div>
      </div>
    </>
  );
}

export function prettyKey(spec) {
  return String(spec ?? '')
    .replace(/CommandOrControl|CmdOrCtrl/gi, 'Ctrl')
    .replace(/ctrl/gi, 'Ctrl')
    .replace(/meta/gi, 'Win')
    .replace(/alt/gi, 'Alt')
    .replace(/shift/gi, 'Shift')
    .replace(/esc/gi, 'Esc')
    .replace(/space/gi, '空格')
    .split('+')
    .map((p) => (p.length === 1 && /[a-z]/.test(p) ? p.toUpperCase() : p))
    .join(' + ');
}
