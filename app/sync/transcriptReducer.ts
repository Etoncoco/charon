// The session transcript's pure reducers (sync refonte C09; C16 completes it).
//
// Browser-safe, no React, no DOM: every client transcript guarantee is proven
// against this module (tests/transcriptReducer.test.ts) — there is no DOM test
// environment (SPEC §11). `useClaudeSessionStream` calls these inside its
// state updaters; the cases it still handles inline move here in C16.
//
// Hub-owned boundaries (CLAUDE.md §7, sync refonte I7): when the session GET
// advertises `features: ['assistant_flushed', …]` the HUB cuts assistant
// bubbles (`assistant_flushed`), extends a persisted SIGTERM partial
// (`assistant_reopened`) and names every persisted row (`rowId` ⇒ the live
// row is `m<rowId>`, the id the rebuild gives it). The client then never
// invents a boundary; the legacy flush on boundary frames runs only against a
// hub without the feature.

import type { Msg } from '../sessionTypes';
import type { WorkerEvent } from '@/lib/server/claude/types';
import type { SessionProvider } from '@/lib/sessionCapabilities';
import type { TranscriptView } from '@/lib/transcriptRows';
import { applyThinkingFlushed, closeThinkingMessage } from '../thinkingMessages';

type Frame<T extends WorkerEvent['type']> = Extract<WorkerEvent, { type: T }>;
export type AssistantFlushed = Frame<'assistant_flushed'>;
export type AssistantReopened = Frame<'assistant_reopened'>;
export type ThinkingFlushed = Frame<'thinking_flushed'>;
export type UserEcho = Frame<'user_echo'>;
export type ToolUseFrame = Frame<'tool_use'>;
export type ToolResultFrame = Frame<'tool_result'>;
export type StopFrame = Frame<'stop'>;

/** Live text not yet a row: `assistant` = the assistant buffer (the hub's open
 *  accumulation as received; with `streamingInto` set, only what follows row
 *  `streamingInto`'s rendered prefix); `thinkingOpen` = a delta provider's
 *  open reasoning block since its last cut. */
export type LiveBuffers = { assistant: string; streamingInto: number | null; thinkingOpen: string };

/** The composer's optimistic sends, by the browser's `clientMessageId`, in send
 *  order (the content FIFO for echoes lacking an id walks it). */
export type OptimisticSends = Map<string /*clientMessageId*/, { content: string; createdAt: number; rowId?: number }>;

export type TranscriptCtx = {
  fromJournal: boolean;
  view: TranscriptView;
  provider: SessionProvider;
  hubBoundaries: boolean;
  nowMs: number;
};

export type Effect = { kind: 'refetch'; reason: string } | { kind: 'markFinal'; rowId: number }
  | { kind: 'fsChanged'; paths: string[] } | { kind: 'banner'; msg: string } | { kind: 'killed' } | { kind: 'ackFocus' };

/** The id of a live row the hub persisted (`rowId`), the rebuild's own id. */
export const rowKey = (rowId: number): string => `m${rowId}`;

/** The optimistic user bubble of a composer send. */
export const optimisticUserId = (clientMessageId: string): string => `u-${clientMessageId}`;

/** A `clientMessageId` the input route accepts (≤64 chars of `[A-Za-z0-9-]`).
 *  `crypto.randomUUID` exists only in secure contexts: a hub served over plain
 *  HTTP on a LAN address falls back to `getRandomValues`, then Math.random. */
export function newClientMessageId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') {
    try { return c.randomUUID(); } catch { /* insecure context */ }
  }
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function upsertById(messages: Msg[], row: Msg): Msg[] {
  const idx = messages.findIndex((m) => m.id === row.id);
  if (idx < 0) return [...messages, row];
  const next = messages.slice();
  next[idx] = row;
  return next;
}

// ─── Hub boundaries: assistant_flushed / assistant_reopened / thinking_flushed ─

type FlushEvent = AssistantFlushed | AssistantReopened | ThinkingFlushed;

/** The buffer half of `reduceFlushFrame`: depends only on the buffer and the
 *  frame, so the hook applies it synchronously to its refs while the messages
 *  half runs in its state updater (`applyFlushFrame`). */
export function flushFrameBuffer(buf: LiveBuffers, ev: FlushEvent): { buf: LiveBuffers; effects: Effect[] } {
  switch (ev.type) {
    case 'assistant_flushed': {
      const effects: Effect[] = [];
      // The hub's buffer is `length` chars. Ours is the same text unless a
      // frame was lost; `content` (a replay extend) or `duplicate` make ours
      // irrelevant. Reopened into a row, ours is only the part past its prefix
      // and the hub always sends `content` then.
      if (!ev.duplicate && typeof ev.content !== 'string' && buf.streamingInto == null
          && buf.assistant.length !== ev.length) {
        effects.push({ kind: 'refetch', reason: `assistant_flushed length ${buf.assistant.length} != ${ev.length}` });
      }
      return { buf: { ...buf, assistant: '', streamingInto: null }, effects };
    }
    case 'assistant_reopened': {
      // The deltas that follow extend row `rowId`. A buffer reopened into
      // another row is committed into it by the messages half; a plain one
      // cannot exist (every earlier buffer was cut) unless a frame was lost.
      const effects: Effect[] = buf.assistant && buf.streamingInto == null
        ? [{ kind: 'refetch', reason: 'assistant_reopened over an uncut buffer' }] : [];
      return { buf: { ...buf, assistant: '', streamingInto: ev.rowId }, effects };
    }
    case 'thinking_flushed':
      return { buf: { ...buf, thinkingOpen: '' }, effects: [] };
  }
}

/** The messages half of `reduceFlushFrame`, given the buffer BEFORE the frame. */
export function applyFlushFrame(messages: Msg[], before: LiveBuffers, ev: FlushEvent, ctx: Pick<TranscriptCtx, 'nowMs'>): Msg[] {
  switch (ev.type) {
    case 'assistant_flushed': {
      // Replayed text already persisted: the row (when on screen) is it.
      if (ev.duplicate || ev.rowId == null) return messages;
      const id = rowKey(ev.rowId);
      const existing = messages.find((m) => m.id === id);
      const content = typeof ev.content === 'string' ? ev.content
        : before.streamingInto === ev.rowId && existing ? existing.content + before.assistant
        : before.assistant;
      if (!content && !existing) return messages;
      const createdAt = typeof ev.tsMs === 'number' && Number.isFinite(ev.tsMs)
        ? Math.floor(ev.tsMs / 1000)
        : existing?.createdAt ?? Math.floor(ctx.nowMs / 1000);
      return upsertById(messages, {
        ...(existing ?? {}),
        id, role: 'assistant', content, createdAt,
        model: ev.model ?? existing?.model ?? null,
        // A cut is never final by itself: `stop` names the turn's final row.
        assistantFinal: existing?.assistantFinal === 1 ? 1 : 0,
      });
    }
    case 'assistant_reopened': {
      // A buffer still open on another row is committed as that row's text
      // first (no boundary lost); a plain buffer cannot exist here (the hub
      // sends `assistant_reopened` before the remainder of a new buffer).
      if (before.assistant && before.streamingInto != null && before.streamingInto !== ev.rowId) {
        const prev = messages.find((m) => m.id === rowKey(before.streamingInto!));
        if (prev) return upsertById(messages, { ...prev, content: prev.content + before.assistant });
      }
      return messages;
    }
    case 'thinking_flushed':
      return applyThinkingFlushed(messages, ev, before.thinkingOpen);
  }
}

export function reduceFlushFrame(messages: Msg[], buf: LiveBuffers,
  ev: AssistantFlushed | AssistantReopened | ThinkingFlushed, ctx: TranscriptCtx):
  { messages: Msg[]; buf: LiveBuffers; effects: Effect[] } {
  const out = flushFrameBuffer(buf, ev);
  return { messages: applyFlushFrame(messages, buf, ev, ctx), buf: out.buf, effects: out.effects };
}

/** The live assistant bubble: `__streaming` after the history, or — after an
 *  `assistant_reopened` — row `m<streamingInto>` itself, its content followed
 *  by the buffer (no second bubble). Null when there is nothing to show (an
 *  empty buffer reopened into a row renders that row as it is). */
export function liveStreamingMessage(messages: Msg[], buf: LiveBuffers): Msg | null {
  if (!buf.assistant) return null;
  if (buf.streamingInto != null) {
    const row = messages.find((m) => m.id === rowKey(buf.streamingInto!));
    if (row) return { ...row, content: row.content + buf.assistant, assistantFinal: 0 };
  }
  return { id: '__streaming', role: 'assistant', content: buf.assistant, createdAt: 0, assistantFinal: 0 };
}

// ─── user_echo ↔ optimistic sends ───────────────────────────────────────────

/** What an echo means for the transcript (`matchUserEcho`). */
export type EchoMatch =
  | { kind: 'own'; clientMessageId: string; rowId: number | null }   // our bubble: rename it to m<rowId>
  | { kind: 'suppress' }                                              // legacy content match: keep our bubble
  | { kind: 'foreign' };                                              // another tab/device/server send

/** The sends half of `reduceUserEcho` (synchronous, ref-side). An echo with a
 *  `clientMessageId` is matched by IDENTITY only — an unknown id is a foreign
 *  echo, never a content match; only echoes lacking an id (an older hub) walk
 *  the content FIFO. */
export function matchUserEcho(sends: OptimisticSends, ev: UserEcho): { sends: OptimisticSends; match: EchoMatch } {
  const cmid = ev.clientMessageId;
  if (cmid) {
    if (!sends.has(cmid)) return { sends, match: { kind: 'foreign' } };
    const next = new Map(sends);
    next.delete(cmid);
    return { sends: next, match: { kind: 'own', clientMessageId: cmid, rowId: ev.rowId ?? null } };
  }
  for (const [id, s] of sends) {
    if (s.content !== ev.content) continue;
    const next = new Map(sends);
    next.delete(id);
    return { sends: next, match: { kind: 'suppress' } };
  }
  return { sends, match: { kind: 'foreign' } };
}

/** Our optimistic bubble becomes row `rowId` in place (or goes, when the row is
 *  already on screen — a refetch or the other arrival order put it there). */
function renameOwnBubble(messages: Msg[], clientMessageId: string, rowId: number | null): Msg[] {
  if (rowId == null) return messages;
  const from = optimisticUserId(clientMessageId);
  const to = rowKey(rowId);
  const idx = messages.findIndex((m) => m.id === from);
  if (idx < 0) return messages;
  if (messages.some((m) => m.id === to)) return messages.filter((_, i) => i !== idx);
  const next = messages.slice();
  next[idx] = { ...next[idx], id: to };
  return next;
}

export function applyUserEchoMatch(messages: Msg[], match: EchoMatch, ev: UserEcho): Msg[] {
  switch (match.kind) {
    case 'suppress': return messages;
    case 'own': {
      const renamed = renameOwnBubble(messages, match.clientMessageId, match.rowId);
      if (renamed !== messages) return renamed;
      // Neither our bubble nor its row on screen (a refetch replaced the
      // bubble before the row existed): show the row.
      if (match.rowId != null && !messages.some((m) => m.id === rowKey(match.rowId!))
          && !messages.some((m) => m.id === optimisticUserId(match.clientMessageId))) {
        return [...messages, { id: rowKey(match.rowId), role: 'user', content: ev.content, createdAt: ev.createdAt }];
      }
      return messages;
    }
    case 'foreign': {
      if (ev.rowId != null) {
        const id = rowKey(ev.rowId);
        if (messages.some((m) => m.id === id)) return messages;   // a replayed echo
        return [...messages, { id, role: 'user', content: ev.content, createdAt: ev.createdAt }];
      }
      return [...messages, { id: 'u' + ev.createdAt + Math.random(), role: 'user', content: ev.content, createdAt: ev.createdAt }];
    }
  }
}

export function reduceUserEcho(messages: Msg[], sends: OptimisticSends, ev: UserEcho):
  { messages: Msg[]; sends: OptimisticSends } {
  const m = matchUserEcho(sends, ev);
  return { messages: applyUserEchoMatch(messages, m.match, ev), sends: m.sends };
}

/** Bound on remembered sends: an echo that never comes (SSE down) must not
 *  grow the map forever; the oldest go first. */
export const OPTIMISTIC_SENDS_MAX = 64;

/** A composer send: the optimistic bubble `u-<clientMessageId>` and its entry. */
export function addOptimisticSend(messages: Msg[], sends: OptimisticSends,
  clientMessageId: string, content: string, createdAt: number):
  { messages: Msg[]; sends: OptimisticSends } {
  const next = new Map(sends);
  next.set(clientMessageId, { content, createdAt });
  while (next.size > OPTIMISTIC_SENDS_MAX) next.delete(next.keys().next().value!);
  return {
    messages: [...messages, { id: optimisticUserId(clientMessageId), role: 'user', content, createdAt }],
    sends: next,
  };
}

/** The POST answered `{rowId}`: recorded on the entry (the echo may still come,
 *  or never), and the bubble takes the row's id at once — whichever of echo
 *  and response arrives first, the transcript ends with ONE `m<rowId>`. */
export function reduceSendAck(messages: Msg[], sends: OptimisticSends,
  clientMessageId: string, rowId: number | null | undefined):
  { messages: Msg[]; sends: OptimisticSends } {
  if (rowId == null) return { messages, sends };
  const entry = sends.get(clientMessageId);
  let nextSends = sends;
  if (entry) {
    nextSends = new Map(sends);
    nextSends.set(clientMessageId, { ...entry, rowId });
  }
  return { messages: renameOwnBubble(messages, clientMessageId, rowId), sends: nextSends };
}

// ─── Rows the hub named: tool_use / tool_result ─────────────────────────────

/** A live tool frame. With `rowId` the row is `m<rowId>` (inserted once — a
 *  replayed frame replaces it in place); a `tool_result` renames the
 *  `tr-live-<sdkId>` row its `tool_progress` frames built. Without `rowId`
 *  (an older hub) the historical ids are kept. */
export function reduceRowIdRename(messages: Msg[], ev: ToolUseFrame | ToolResultFrame, nowMs = Date.now()): Msg[] {
  const createdAt = Math.floor(nowMs / 1000);
  if (ev.type === 'tool_use') {
    const content = JSON.stringify({ type: 'tool_use', id: ev.id, name: ev.name, input: ev.input });
    if (ev.rowId == null) {
      return [...messages, { id: 'tu' + ev.id + Math.random(), role: 'tool_use', content, createdAt }];
    }
    const id = rowKey(ev.rowId);
    const existing = messages.find((m) => m.id === id);
    return upsertById(messages, { id, role: 'tool_use', content, createdAt: existing?.createdAt ?? createdAt });
  }
  const content = JSON.stringify({ type: 'tool_result', tool_use_id: ev.tool_use_id,
    content: ev.content, is_error: !!ev.is_error });
  const liveId = 'tr-live-' + ev.tool_use_id;
  if (ev.rowId == null) {
    return upsertById(messages, {
      id: liveId, role: 'tool_result', content,
      createdAt: messages.find((m) => m.id === liveId)?.createdAt ?? createdAt,
    });
  }
  const id = rowKey(ev.rowId);
  const liveIdx = messages.findIndex((m) => m.id === liveId);
  const rowIdx = messages.findIndex((m) => m.id === id);
  if (rowIdx >= 0) {
    const next = messages.map((m, i) => i === rowIdx ? { ...m, content } : m);
    return liveIdx >= 0 ? next.filter((_, i) => i !== liveIdx) : next;
  }
  if (liveIdx >= 0) {
    const next = messages.slice();
    next[liveIdx] = { ...next[liveIdx], id, content };
    return next;
  }
  return [...messages, { id, role: 'tool_result', content, createdAt }];
}

// ─── stop ───────────────────────────────────────────────────────────────────

/** `stop` closes an open reasoning bubble and marks the turn's final assistant
 *  row (`finalAssistantId`). The "last optimistic `a…` bubble" fallback is
 *  for a hub without boundaries only: there, the row may still carry the
 *  client's own id; with hub boundaries it is always `m<rowId>`. */
export function reduceStop(messages: Msg[], ev: StopFrame, ctx: Pick<TranscriptCtx, 'hubBoundaries'>): Msg[] {
  let next = closeThinkingMessage(messages);
  if (ev.finalAssistantId == null) return next;
  let index = next.findIndex((m) => m.id === rowKey(ev.finalAssistantId!));
  if (index < 0 && !ctx.hubBoundaries) {
    index = next.findLastIndex((m) => m.role === 'assistant' && m.id.startsWith('a'));
  }
  if (index < 0 || next[index].assistantFinal === 1) return next;
  next = next.slice();
  next[index] = { ...next[index], assistantFinal: 1 };
  return next;
}
