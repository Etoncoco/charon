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

// The 5 s delta poll (§14.24) while the hub holds an open block: it writes no
// row until it closes, so the `?since=` probe alone sees nothing to catch up.
// TRUE ⇒ the screen does not hold the server's open block and needs the
// clean reload: a hole or another block (neither text extends the other), or
// frames that stopped arriving — the screen still lacks what the server held
// one tick ago (`previous`, same block). Being behind by one tick is normal
// (frames in flight); holding more than the server is too.
export function openThinkingNeedsReload(server: string, local: string, previous: string | null): boolean {
  if (!server || local.startsWith(server)) return false;
  if (!server.startsWith(local)) return true;
  return previous != null && server.startsWith(previous) && local.length < previous.length;
}

// The open bubble's date: its first delta's (as its row will be), else now.
export function openThinkingCreatedAt(tsMs: number | null | undefined, nowMs = Date.now()): number {
  return Math.floor((typeof tsMs === 'number' && Number.isFinite(tsMs) ? tsMs : nowMs) / 1000);
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
// never duplicated. `content` (a replay rebuilt or extended the block) replaces
// the block's own part of the bubble: `openText`, what arrived since the last
// cut, when the bubble still ends with it (empty: none of it is on screen, the
// row's text is appended).
export function applyThinkingFlushed(
  messages: Msg[], flushed: { rowId: number; content?: string }, openText: string,
): Msg[] {
  const last = messages[messages.length - 1];
  if (last?.role !== 'thinking' || !last.thinkingDelta || last.thinkingClosed) return messages;
  const rowKey = `m${flushed.rowId}`;
  const id = last.id.startsWith('m') || messages.some((m) => m.id === rowKey) ? last.id : rowKey;
  let content = last.content;
  if (typeof flushed.content === 'string') {
    content = last.content.endsWith(openText)
      ? last.content.slice(0, last.content.length - openText.length) + flushed.content
      : flushed.content;
  }
  if (id === last.id && content === last.content) return messages;
  return [...messages.slice(0, -1), { ...last, id, content }];
}

// ─── The live lane (useClaudeSessionStream's delta-reasoning state) ────────
// Kept pure so the hub's real frame stream can be replayed through the exact
// client logic in tests (thinkingCoalescing.test.ts: live == rebuild).
// `batch`: fragments received but not committed to `messages` yet (≤ 80 ms,
// §14.17); `open`: the hub's still-open block as this browser received it,
// since its last `thinking_flushed` cut.
export type ThinkingLane = { batch: string; open: string };

export function createThinkingLane(): ThinkingLane {
  return { batch: '', open: '' };
}

// A delta `thinking` frame: batched (the caller schedules the commit).
export function thinkingLaneDelta(lane: ThinkingLane, text: string): void {
  lane.batch += text;
  lane.open += text;
}

// Commit the batch as ONE fragment joined to the open bubble. Returns the
// `messages` updater, or null when nothing is batched. The text is taken NOW
// (an updater runs later).
export function thinkingLaneCommit(
  lane: ThinkingLane, fragment: { id: string; createdAt: number },
): ((messages: Msg[]) => Msg[]) | null {
  const text = lane.batch;
  if (!text) return null;
  lane.batch = '';
  return (messages) => appendThinkingMessage(messages, {
    id: fragment.id, role: 'thinking', content: text, createdAt: fragment.createdAt, thinkingDelta: true,
  });
}

// Every SSE frame goes through this FIRST: any frame but a delta `thinking`
// lands after the reasoning received before it (the batch is committed).
export function thinkingLaneBeforeFrame(
  lane: ThinkingLane, frameType: string, fragment: { id: string; createdAt: number },
): ((messages: Msg[]) => Msg[]) | null {
  return frameType === 'thinking' ? null : thinkingLaneCommit(lane, fragment);
}

// `thinking_flushed`: the hub cut the open block (applyThinkingFlushed); the
// next block starts a new `open`.
export function thinkingLaneFlushed(
  lane: ThinkingLane, flushed: { rowId: number; content?: string },
): (messages: Msg[]) => Msg[] {
  const openText = lane.open;
  lane.open = '';
  return (messages) => applyThinkingFlushed(messages, flushed, openText);
}

// A history snapshot (the session GET, `applyApiData`): the batch is part of
// the local open text, so it is dropped; the hub's open block
// (`streamingThinking`) is reconciled with what this browser holds and shown
// after the rebuilt history.
export function thinkingLaneSnapshot(
  lane: ThinkingLane, rebuilt: Msg[], serverThinking: string, createdAt: number,
): Msg[] {
  lane.batch = '';
  if (!serverThinking) {
    lane.open = '';
    return rebuilt;
  }
  lane.open = reconcileOpenThinking(serverThinking, lane.open);
  return appendOpenThinking(rebuilt, lane.open, createdAt);
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
