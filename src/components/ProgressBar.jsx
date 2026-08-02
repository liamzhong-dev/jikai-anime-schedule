import React from 'react';

/** 顶部细进度条：同步时推进，完成后淡出 */
export default function ProgressBar({ progress, active }) {
  const visible = active || (progress > 0 && progress < 100);
  return (
    <div
      className={`progressbar${visible ? '' : ' progressbar--hidden'}`}
      style={{ width: `${Math.max(progress, 4)}%` }}
      aria-hidden={!visible}
    >
      <span className="progressbar__glow" />
    </div>
  );
}
