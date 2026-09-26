import React, { useState } from 'react';
import { RATING_MAX, RATING_MIN, compareToBangumi } from '../core/diary.js';

/**
 * 打分 + 一句话短评的输入控件。
 *
 * 三个刻意的选择：
 *
 *  1. **一排数字按钮，不是下拉框 / 滑块**。打分是从「看完之后的印象」落到一个
 *     数字上，越少一步越好；下拉要展开、滑块拖不准，都会让人干脆不打分。
 *  2. **不用 `window.prompt`**。Electron 里它存在但一调用就抛
 *     （`prompt() is and will not be supported.`），而且 `?.` 救不了 ——
 *     值存在、只是会抛。任何输入都用行内控件，这是本项目的硬规矩。
 *  3. **保存后原地显示对比**。打完分最想知道的就是「跟 Bangumi 差多少」，
 *     让这个答案出现在按键旁边，而不是要切到另一个页面去查。
 */
export default function DiaryRatingInput({
  id,
  rating = null,
  note = '',
  bgmScore = null,
  count = 0,
  compact = false,
  onSave,
  onOpenDiary,
  onRemove,
  lastEntryAt = null,
}) {
  const [draftRating, setDraftRating] = useState(rating);
  const [draftNote, setDraftNote] = useState(note);
  const [error, setError] = useState('');

  const cmp = compareToBangumi(rating, bgmScore);
  const dirty = draftRating !== rating || draftNote !== note;

  const save = () => {
    const r = onSave?.({ rating: draftRating, note: draftNote });
    if (r && r.ok === false) {
      setError(r.reason || '没存下来');
      return;
    }
    setError('');
  };

  return (
    <div className={`diary-input${compact ? ' diary-input--compact' : ''}`} data-diary-for={id}>
      <div className="diary-input__scores" role="group" aria-label="我的评分">
        {Array.from({ length: RATING_MAX - RATING_MIN + 1 }, (_, i) => RATING_MIN + i).map((n) => (
          <button
            key={n}
            type="button"
            className={`diary-input__num${draftRating === n ? ' is-on' : ''}`}
            data-diary-rate={n}
            aria-pressed={draftRating === n}
            title={`给 ${n} 分`}
            onClick={() => setDraftRating(draftRating === n ? null : n)}
          >
            {n}
          </button>
        ))}
      </div>

      <div className="diary-input__row">
        <input
          className="input diary-input__note"
          data-diary-note={id}
          placeholder="一句话记录看完的感受（可留空）"
          value={draftNote}
          onChange={(e) => setDraftNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
          }}
        />
        <button type="button" className="btn btn--mini" data-diary-save={id} onClick={save}>
          {count > 0 ? '再记一条' : '记下'}
        </button>
        {count > 0 ? (
          <button
            type="button"
            className="btn btn--ghost btn--mini"
            data-diary-open={id}
            title="去补番日记看这一部的全部记录"
            onClick={() => onOpenDiary?.(id)}
          >
            已记 {count} 次
          </button>
        ) : null}
      </div>

      {error ? <div className="diary-input__error">{error}</div> : null}

      {rating != null ? (
        <div className="diary-input__cmp" data-diary-cmp={cmp.band}>
          <span className="diary-input__mine">我的 {rating}</span>
          <span className="diary-input__bgm">{cmp.bgm != null ? `BGM ${cmp.bgm}` : 'BGM 评分未知'}</span>
          <span className={`diary-cmp diary-cmp--${cmp.band}`}>{cmp.label}</span>
          {onRemove && lastEntryAt != null ? (
            <button
              type="button"
              className="diary-input__undo"
              data-diary-remove={lastEntryAt}
              title="删掉最近这一条"
              // 删的是「最近一条带评分的记录」，不是整个作品 —— 记错一次不该把历史全毁掉
              onClick={() => onRemove?.(lastEntryAt)}
            >
              撤销上一条
            </button>
          ) : null}
        </div>
      ) : null}

      {/* 有草稿但没记下来时要提醒 —— 静默丢掉用户刚打的字是最不能接受的失败 */}
      {dirty ? <div className="diary-input__hint">改动还没记下，点「{count > 0 ? '再记一条' : '记下'}」保存</div> : null}
    </div>
  );
}
