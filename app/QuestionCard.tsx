'use client';
import { useState } from 'react';
import { useUnsavedInput } from './inputDraftStore';
import { LinkifiedText } from './Message';

export type QuestionItem = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
};

type Props = {
  questions: QuestionItem[];
  onAnswer: (answers: Record<string, string>) => void | Promise<void>;
  onCancel: () => void | Promise<void>;
  inline?: boolean;
  /** Where the question's file paths open (URLs need neither). */
  vpsId?: string;
  cwd?: string | null;
};

// Card displayed when Claude calls AskUserQuestion. For each question,
// the user clicks an option (or several if multiSelect), OR types a free
// answer in the textarea (which overrides the click).
// The return is { question_text: "label1, label2" } or { question_text: "free text" }.
export default function QuestionCard({ questions, onAnswer, onCancel, inline, vpsId, cwd }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selections, setSelections] = useState<Record<number, Set<string>>>(() => {
    const init: Record<number, Set<string>> = {};
    questions.forEach((_, i) => { init[i] = new Set(); });
    return init;
  });
  const [customs, setCustoms] = useState<Record<number, string>>({});
  // Typed answers live only here: a new-build auto-reload waits for them.
  useUnsavedInput(!submitting && Object.values(customs).some((v) => v.trim() !== ''));

  function toggle(qIdx: number, label: string, multi: boolean) {
    setSelections((prev) => {
      const next = { ...prev };
      const cur = new Set(prev[qIdx] ?? new Set<string>());
      if (multi) {
        if (cur.has(label)) cur.delete(label); else cur.add(label);
      } else {
        cur.clear();
        cur.add(label);
      }
      next[qIdx] = cur;
      return next;
    });
  }

  function answerForQuestion(qIdx: number): string | null {
    const custom = (customs[qIdx] ?? '').trim();
    if (custom) return custom;
    const sel = selections[qIdx];
    if (!sel || sel.size === 0) return null;
    return Array.from(sel).join(', ');
  }

  const allAnswered = questions.every((_, i) => !!answerForQuestion(i));

  async function deliver(action: () => void | Promise<void>) {
    if (submitting) return;
    setSubmitting(true); setError(null);
    try { await action(); }
    catch (e) { setError(String((e as Error)?.message ?? e)); }
    finally { setSubmitting(false); }
  }

  function submit() {
    const answers: Record<string, string> = {};
    questions.forEach((q, i) => {
      const a = answerForQuestion(i);
      if (a) answers[q.question] = a;
    });
    void deliver(() => onAnswer(answers));
  }

  return (
    <div className="user-question-card">
      {!inline && <header className="uq-card-head">
        <span className="uq-tag">❓ question{questions.length > 1 ? `s × ${questions.length}` : ''}</span>
        <span className="uq-sub">choose an option or write your own answer</span>
      </header>}
      <fieldset disabled={submitting} className="uq-fields">
      <div className="uq-body">
        {questions.map((q, qIdx) => {
          const multi = !!q.multiSelect;
          const sel = selections[qIdx] ?? new Set<string>();
          const customVal = customs[qIdx] ?? '';
          const hasCustom = customVal.trim().length > 0;
          return (
            <div key={qIdx} className="uq-question">
              {q.header && <div className="uq-header">{q.header}</div>}
              <div className="uq-text"><LinkifiedText text={q.question} vpsId={vpsId} cwd={cwd} /></div>
              {multi && <div className="uq-multi-hint">multiple choice (☑)</div>}
              <div className={`uq-options${hasCustom ? ' dimmed' : ''}`}>
                {q.options.map((opt) => {
                  const on = sel.has(opt.label);
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      className={`uq-option${on ? ' selected' : ''}${multi ? ' multi' : ''}`}
                      onClick={() => toggle(qIdx, opt.label, multi)}
                    >
                      <span className="uq-radio">{multi ? (on ? '☑' : '☐') : (on ? '◉' : '◯')}</span>
                      <span className="uq-label">{opt.label}</span>
                      {opt.description && <span className="uq-desc">{opt.description}</span>}
                    </button>
                  );
                })}
              </div>
              <div className="uq-custom">
                <label className="uq-custom-label">or free answer:</label>
                <textarea
                  className="uq-custom-input"
                  placeholder="type your own answer — it will be used instead of the options"
                  value={customVal}
                  onChange={(e) => setCustoms((c) => ({ ...c, [qIdx]: e.target.value }))}
                  rows={2}
                />
              </div>
            </div>
          );
        })}
      </div>
      </fieldset>
      {error && <p className="uq-error" role="alert">{error}</p>}
      <footer className="uq-actions">
        <button type="button" className="uq-cancel" disabled={submitting} onClick={() => void deliver(onCancel)}>{inline ? 'dismiss' : 'cancel'}</button>
        <button type="button" className="uq-submit" onClick={submit} disabled={!allAnswered || submitting}>
          {submitting ? 'sending…' : inline ? 'validate answers' : 'send'}
        </button>
      </footer>
    </div>
  );
}
