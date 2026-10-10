'use client';
import { memo } from 'react';
import { parseAsyncQuestion } from '@/lib/asyncQuestions';
import type { Msg } from './sessionTypes';
import QuestionCard from './QuestionCard';

export default memo(function AsyncQuestionBubble({ message, onRespond }: {
  message: Msg;
  onRespond: (id: string, answers: Record<string, string> | null) => Promise<void>;
}) {
  const q = parseAsyncQuestion(message.content);
  if (!q) return null;
  const resolved = !!q.status && q.status !== 'pending';
  return (
    <div className={`bubble role-question${resolved ? ' is-resolved' : ''}`}
      data-msg-role="question" data-question-id={q.id} tabIndex={-1}>
      <header className="bubble-h">
        <span className="tag">questions</span>
        <span className="uq-state">{resolved ? q.status === 'answered' ? 'answered' : q.status === 'unavailable' ? 'historical question' : 'dismissed' : 'awaiting your answers'}</span>
      </header>
      {resolved ? (
        <div className="uq-body">
          {q.questions.map((question, i) => (
            <div className="uq-question" key={i}>
              <div className="uq-text">{question.question}</div>
              <div className="uq-answer">{q.answers?.[question.question] ?? 'No answer'}</div>
            </div>
          ))}
        </div>
      ) : (
        <QuestionCard inline questions={q.questions}
          onAnswer={(answers) => onRespond(q.id, answers)}
          onCancel={() => onRespond(q.id, null)} />
      )}
    </div>
  );
});
