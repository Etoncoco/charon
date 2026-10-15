import type { Msg } from './sessionTypes';

// Only streamed fragments concatenate. Imported reasoning and complete SDK
// blocks keep their own boundaries; tokens retain their exact whitespace.
function joinThinking(previous: Msg | undefined, next: Msg): Msg | null {
  if (previous?.role !== 'thinking' || next.role !== 'thinking'
      || !previous.thinkingDelta || !next.thinkingDelta || previous.thinkingClosed) return null;
  return { ...previous, content: previous.content + next.content, thinkingClosed: next.thinkingClosed };
}

export function appendThinkingMessage(messages: Msg[], message: Msg): Msg[] {
  if (!message.content) return messages;
  const joined = joinThinking(messages[messages.length - 1], message);
  return joined ? [...messages.slice(0, -1), joined] : [...messages, message];
}

export function closeThinkingMessage(messages: Msg[]): Msg[] {
  const last = messages[messages.length - 1];
  if (last?.role !== 'thinking' || !last.thinkingDelta || last.thinkingClosed) return messages;
  return [...messages.slice(0, -1), { ...last, thinkingClosed: true }];
}

// The open reasoning block after a refetch: the hub's unflushed text
// (`streamingThinking`) against what this browser already received live. The
// local copy wins only while it EXTENDS the server's (the GET was read before
// the latest deltas arrived); anything else means the server knows better.
export function reconcileOpenThinking(server: string, local: string): string {
  return local.startsWith(server) ? local : server;
}

// The open block shown after a rebuilt history (`streamingThinking`, not a row
// yet): joined to the persisted head of the same block, like a live fragment.
export function appendOpenThinking(messages: Msg[], open: string, createdAt: number): Msg[] {
  return appendThinkingMessage(messages, {
    id: 'th-open', role: 'thinking', content: open, thinkingDelta: true, createdAt,
  });
}

// The hub cut the open block into row `rowId` (`thinking_flushed`, CLAUDE.md
// §14.17). The bubble stays open — the next block may continue it, exactly as
// the rebuild joins adjacent rows — and takes the id the rebuild gives it: the
// FIRST fragment's row, so an `m…` id is kept, and an id already on screen is
// never duplicated. `content` (a replay extended a persisted prefix) replaces
// the block's own part of the bubble: `openText`, what arrived since the last
// cut, when the bubble still ends with it.
export function applyThinkingFlushed(
  messages: Msg[], flushed: { rowId: number; content?: string }, openText: string,
): Msg[] {
  const last = messages[messages.length - 1];
  if (last?.role !== 'thinking' || !last.thinkingDelta || last.thinkingClosed) return messages;
  const rowKey = `m${flushed.rowId}`;
  const id = last.id.startsWith('m') || messages.some((m) => m.id === rowKey) ? last.id : rowKey;
  let content = last.content;
  if (typeof flushed.content === 'string') {
    content = openText && last.content.endsWith(openText)
      ? last.content.slice(0, last.content.length - openText.length) + flushed.content
      : flushed.content;
  }
  if (id === last.id && content === last.content) return messages;
  return [...messages.slice(0, -1), { ...last, id, content }];
}

// A page boundary may cut a streamed block in two. Join just that boundary,
// leaving every other message and its React identity intact.
export function prependMessagePage(older: Msg[], current: Msg[]): Msg[] {
  if (!older.length) return current;
  if (!current.length) return older;
  const joined = joinThinking(older[older.length - 1], current[0]);
  return joined
    ? [...older.slice(0, -1), joined, ...current.slice(1)]
    : [...older, ...current];
}
