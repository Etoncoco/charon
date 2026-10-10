export type AsyncQuestion = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
};

export type AsyncQuestionContent = {
  id: string;
  questions: AsyncQuestion[];
  status?: string;
  answers?: Record<string, string> | null;
};

export function parseAsyncQuestion(content: string): AsyncQuestionContent | null {
  try {
    const value = JSON.parse(content);
    return typeof value?.id === 'string' && Array.isArray(value.questions) ? value : null;
  } catch { return null; }
}

export function resolveAsyncQuestionMessages<T extends { role: string; content: string }>(
  messages: T[], id: string, status: string, answers?: Record<string, string> | null,
): T[] {
  let changed = false;
  const next = messages.map((m) => {
    if (m.role !== 'async_question') return m;
    const q = parseAsyncQuestion(m.content);
    if (!q || q.id !== id) return m;
    const content = JSON.stringify({ ...q, status, answers: answers ?? null });
    if (content === m.content) return m;
    changed = true;
    return { ...m, content };
  });
  return changed ? next : messages;
}

/** Native async questions receive ordinary conversation input, not an RPC gate response. */
export function asyncQuestionReply(questions: AsyncQuestion[], answers: Record<string, string> | null): string {
  if (!answers) return 'I am dismissing these questions without answering:\n\n'
    + questions.map((q) => q.question).join('\n');
  if (!questions.length || questions.some((q) => typeof answers[q.question] !== 'string' || !answers[q.question].trim())) {
    throw new Error('Please answer every question before validating.');
  }
  return 'Answers to your questions:\n\n'
    + questions.map((q) => `${q.question}\n${answers[q.question].trim()}`).join('\n\n');
}
