'use client';
import { memo } from 'react';
import { parseAsyncQuestion } from '@/lib/asyncQuestions';
import type { Msg } from './sessionTypes';
import { revealAsyncQuestionStrip } from './AsyncQuestionStrip';

/** An async question in the transcript (§14.96). READ-ONLY: while pending it
 *  points to the one form, the strip above the composer
 *  (AsyncQuestionStrip.tsx); once resolved it shows the answers. */
export default memo(function AsyncQuestionBubble({ message }: { message: Msg }) {
  const q = parseAsyncQuestion(message.content);
  if (!q) return null;
  const resolved = !!q.status && q.status !== 'pending';
  return (
    <div className={`bubble role-question${resolved ? ' is-resolved' : ''}`}
      data-msg-role="question" data-question-id={q.id} tabIndex={-1}>
      <header className="bubble-h">
        <span className="tag">questions</span>
        <span className="uq-state">{resolved ? q.status === 'answered' ? 'answered' : q.status === 'unavailable' ? 'historical question' : 'dismissed' : 'awaiting your answer — answer below ↓'}</span>
      </header>
      <div className="uq-body">
        {q.questions.map((question, i) => (
          <div className="uq-question" key={i}>
            <div className="uq-text">{question.question}</div>
            {resolved && <div className="uq-answer">{q.answers?.[question.question] ?? 'No answer'}</div>}
          </div>
        ))}
      </div>
      {!resolved && (
        <button type="button" className="pending-questions-link"
          onClick={() => revealAsyncQuestionStrip(q.id)}>
          answer below <span aria-hidden>↓</span>
        </button>
      )}
    </div>
  );
});
