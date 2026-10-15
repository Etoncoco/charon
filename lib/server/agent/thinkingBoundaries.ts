// Where a delta provider's reasoning block ends (CLAUDE.md §14.17/§14.31,
// sync refonte C02). Codex and Cursor stream reasoning as one `thinking` event
// per token; the hub coalesces a run of them into ONE `event` row stamped with
// the FIRST delta's seq and ts. A row must never span something the transcript
// renders between two fragments, nor a turn end — so every event type CLOSES
// the open block unless it is listed here as transparent. A new event type
// therefore closes by default: an extra split renders identically (the client
// re-joins adjacent delta rows, app/thinkingMessages.ts), a missing one would
// merge reasoning across a tool call.
//
// Browser-safe and dependency-free on purpose (the compaction tooling and the
// tests read the same rules).

/** Events that neither persist a row nor cut a bubble: the block stays open.
 *  Both replay markers are transparent: a resubscribe re-delivers deltas the
 *  open block already holds, and the replay-only seq guard can drop them only
 *  while it is still open (closing it at `replay_begin` wrote them twice). */
export const THINKING_TRANSPARENT_EVENTS: ReadonlySet<string> = new Set([
  'thinking', 'generation_progress', 'tool_progress', 'edit_progress', 'bg_task_progress',
  'tool_activity', 'codex_signal', 'rate_limit', 'session_info', 'model_changed',
  'effort_changed', 'mode_changed', 'session_id', 'replay_begin', 'replay_end',
]);

/** True when `ev` ends the open reasoning block. Usage closes only on its
 *  final frame (the persisted `turn_usage` row closes the bubble on rebuild). */
export function closesThinking(ev: { event: string; final?: unknown }): boolean {
  if (ev.event === 'usage') return ev.final === true;
  return !THINKING_TRANSPARENT_EVENTS.has(ev.event);
}

/** A block longer than this is cut into adjacent rows (one row never grows
 *  without bound; the client joins them back). */
export const THINKING_ROW_MAX_CHARS = 256 * 1024;

/** Re-delivery of a sealed block the retry cap dropped (sessionOps.ts):
 *  requests that may include one block before the hub stops asking for it,
 *  and the age after which an unanswered request counts as lost (no replay
 *  window ever came: no listener on a swapped client, a failed RPC, an empty
 *  answer). Above the agent RPC timeout (60 s). */
export const THINKING_REDELIVERY_ATTEMPTS = 3;
export const THINKING_REDELIVERY_STALE_MS = 120_000;
/** Largest seq range one re-delivery may ask for (from the dropped block's
 *  first seq to the frontier). The agent queues a subscribe's whole burst at
 *  once and drops the connection past 10 000 events / 32 MiB (every session
 *  on that VPS reconnects), so a request keeps to half of that; a block
 *  further back is abandoned to the restart repair (its `event` pin). */
export const THINKING_REDELIVERY_MAX_EVENTS = 5_000;

/** `PersistedSpans` bounds: count per stream, and the age past which a span
 *  no subscribe can still start inside is pruned (an RPC times out at 60 s). */
export const PERSISTED_SPANS_CAP = 1024;
export const PERSISTED_SPANS_TTL_MS = 10 * 60_000;

/** Seq extents of coalesced rows (a reasoning block, an assistant flush row)
 *  that THIS process persisted or proved persisted (sessionOps.ts). A row is
 *  anchored at its FIRST delta's seq, so a replay window starting INSIDE it
 *  (a subscribe whose cursor was taken while the row still streamed, answered
 *  after it closed: an overlapping resubscribe) re-delivers deltas with no row
 *  of their own and no cover; a seq inside a recorded span proves them
 *  persisted (G2). Memory is enough: the durable cursor never lands strictly
 *  inside a closed row — an open one holds it at its anchor − 1, and a write
 *  or an event lost while an assistant buffer is open pins that buffer's
 *  anchor (sessionOps `_pinEvent`: the buffer runs on past it into the same
 *  row) — so a restart's replay starts at an anchor. Matched on
 *  ts too, like replay identity (a recreated log reuses seqs, §14.71). Spans
 *  are disjoint within one log: sorted by `since`, binary-searched. Bounded:
 *  only a subscribe issued while a row streamed can start inside it, so the
 *  lowest seqs (then the stale ones) go first. */
export class PersistedSpans {
  private spans: Array<{ since: number; last: number; firstTs: number | null; lastTs: number | null; at: number }> = [];

  constructor(private readonly cap = PERSISTED_SPANS_CAP, private readonly ttlMs = PERSISTED_SPANS_TTL_MS) {}

  get size(): number {
    return this.spans.length;
  }

  /** Index of the last span whose `since` is below `seq` (or equal, when
   *  `orEqual`), or -1. */
  private _floor(seq: number, orEqual: boolean): number {
    let lo = 0;
    let hi = this.spans.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const since = this.spans[mid].since;
      if (since < seq || (orEqual && since === seq)) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found;
  }

  /** The row anchored at `since` holds the deltas up to `last`. A one-delta
   *  row is skipped: its anchor is its own identity. A known span grows. */
  record(since: number, last: number, firstTs: number | null, lastTs: number | null, now = Date.now()): void {
    if (!(last > since)) return;
    const i = this._floor(since, true);
    const known = i >= 0 && this.spans[i].since === since ? this.spans[i] : null;
    if (known) {
      if (last > known.last) { known.last = last; known.lastTs = lastTs; }
      known.firstTs ??= firstTs;
      known.at = now;
    } else {
      this.spans.splice(i + 1, 0, { since, last, firstTs, lastTs, at: now });
    }
    while (this.spans.length > this.cap || (this.spans.length && now - this.spans[0].at > this.ttlMs)) {
      this.spans.shift();
    }
  }

  /** True when `seq` lies after a recorded span's anchor and within it, at a
   *  matching ts (±1 ms) when the event carries one. A span missing a ts
   *  bound never matches a dated event: a miss costs a duplicate, a false hit
   *  a loss. */
  covers(seq: number, ts: number | null): boolean {
    const i = this._floor(seq, false);
    if (i < 0) return false;
    const span = this.spans[i];
    if (seq > span.last) return false;
    if (ts == null) return true;
    return span.firstTs != null && span.lastTs != null && ts >= span.firstTs - 1 && ts <= span.lastTs + 1;
  }

  clear(): void {
    this.spans = [];
  }
}

/** The text of a persisted thinking row (`{type:'thinking', text}`), or null
 *  for any other content. */
export function thinkingText(content: string | null | undefined): string | null {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content) as { type?: unknown; text?: unknown } | null;
    return parsed && parsed.type === 'thinking' && typeof parsed.text === 'string' ? parsed.text : null;
  } catch {
    return null;
  }
}
