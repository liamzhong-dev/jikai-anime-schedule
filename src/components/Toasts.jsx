import React from 'react';

export default function Toasts({ toasts }) {
  if (!toasts?.length) return null;
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          <div className="toast__title">{t.title}</div>
          {t.body ? <div className="toast__body">{t.body}</div> : null}
        </div>
      ))}
    </div>
  );
}
