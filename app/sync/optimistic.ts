// Optimistic UI = overlays (sync refonte C16, CLAUDE.md §14.32). Pure,
// browser-safe.
//
// An action (send / sleep / resume / restart, mode / model / effort) shows its
// expected value at once. The overlay holds while the POST is pending, then
// until the stream has delivered the action's revision (`lastRev ≥` the
// response's `sync`: the summary/status frames carrying the action are then
// on screen); a POST failure reverts at once; 30 s caps everything. No timer
// guesses ("4 s after a send") and no poll can clobber it.
//
// Optimistic user bubbles are keyed by the browser's `clientMessageId`
// (transcriptReducer.ts renames them on the echo or the POST answer); after a
// snapshot, `reconcileOptimisticBubbles` re-appends those still unmaterialised
// (unless their POST failed: then they go) and drops those whose row the
// snapshot holds.

import { cmpRev, type SyncRev } from '@/lib/sync/rev';
import type { Msg } from '../sessionTypes';
import type { OptimisticSends } from './transcriptReducer';

// Same ids as transcriptReducer.ts § rowKey / optimisticUserId (kept local:
// the reducer imports this module).
const rowKey = (rowId: number): string => `m${rowId}`;
const optimisticUserId = (clientMessageId: string): string => `u-${clientMessageId}`;

export const OVERLAY_CAP_MS = 30_000;

export type OverlayHandle = {
  /** The POST succeeded; `rev` = its `sync` (absent from an older hub ⇒ the
   *  overlay clears now). */
  ack(rev: SyncRev | null | undefined): void;
  /** The POST failed: revert. */
  fail(): void;
};

type Pending<V> = { token: number; value: V; at: number; pending: boolean; ackRev: SyncRev | null };

export class OverlayBox<V> {
  private cur: Pending<V> | null = null;
  private seq = 0;
  private readonly now: () => number;
  private readonly lastRev: () => SyncRev | null;
  private readonly capMs: number;

  constructor(o: { lastRev: () => SyncRev | null; now?: () => number; capMs?: number }) {
    this.lastRev = o.lastRev;
    this.now = o.now ?? (() => Date.now());
    this.capMs = o.capMs ?? OVERLAY_CAP_MS;
  }

  /** Show `value` until settled. A newer `set` supersedes (the older handle
   *  then does nothing). */
  set(value: V): OverlayHandle {
    const token = ++this.seq;
    this.cur = { token, value, at: this.now(), pending: true, ackRev: null };
    return {
      ack: (rev) => {
        const c = this.cur;
        if (!c || c.token !== token) return;
        if (!rev) { this.cur = null; return; }
        c.pending = false;
        c.ackRev = rev;
      },
      fail: () => {
        if (this.cur?.token === token) this.cur = null;
      },
    };
  }

  /** Is the overlay still shown? (Drops it once settled.) */
  get active(): boolean {
    const c = this.cur;
    if (!c) return false;
    if (this.now() - c.at >= this.capMs) { this.cur = null; return false; }
    if (c.pending) return true;
    if (c.ackRev && cmpRev(this.lastRev(), c.ackRev) >= 0) { this.cur = null; return false; }
    return true;
  }

  /** Identity of the shown overlay (0 = none): a re-render trigger that also
   *  sees a set and an expiry landing in the same tick. */
  get shownToken(): number {
    return this.active ? this.cur!.token : 0;
  }

  /** The displayed value: the overlay while active, else `base`. */
  value(base: V): V {
    return this.active ? this.cur!.value : base;
  }
}

/**
 * After a snapshot rebuilt `messages`: every composer send of this view whose
 * row is not in it yet (the echo and the POST answer are both newer than the
 * snapshot, or never came) keeps its bubble, re-appended at the end; a send
 * whose row the snapshot holds is materialised — its entry goes, the row is
 * the bubble. `knownRowIds` = the snapshot's row ids.
 */
export function reconcileOptimisticBubbles(messages: Msg[], sends: OptimisticSends,
  knownRowIds: ReadonlySet<number>): { messages: Msg[]; sends: OptimisticSends } {
  if (sends.size === 0) return { messages, sends };
  let nextSends: OptimisticSends | null = null;
  const append: Msg[] = [];
  for (const [cmid, s] of sends) {
    if (s.rowId != null && (knownRowIds.has(s.rowId) || messages.some((m) => m.id === rowKey(s.rowId!)))) {
      (nextSends ??= new Map(sends)).delete(cmid);
      continue;
    }
    // A failed POST that named no row, absent from this snapshot: never
    // persisted (or a late echo will show it) ⇒ dropped, not re-appended.
    if (s.rowId == null && s.failed) {
      (nextSends ??= new Map(sends)).delete(cmid);
      continue;
    }
    const id = s.rowId != null ? rowKey(s.rowId) : optimisticUserId(cmid);
    if (!messages.some((m) => m.id === id)) {
      append.push({ id, role: 'user', content: s.content, createdAt: s.createdAt });
    }
  }
  return {
    messages: append.length ? [...messages, ...append] : messages,
    sends: nextSends ?? sends,
  };
}
