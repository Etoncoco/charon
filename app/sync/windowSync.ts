// ONE window GET per transcript at a time (sync refonte C16, CLAUDE.md
// §14.107). React-free controller; `useClaudeSessionStream` instantiates one.
//
// Transcript = snapshot@R + frames>R. A request starts the journal; frames
// delivered meanwhile are applied live AND journaled; the answer (stamped
// `sync` = R) replaces the snapshot-owned state, then the journaled frames
// with rev > R are re-dispatched (`apply(r, mode, replay)`).
//
// Rules:
//   · `mount`/`view`/`reset`/`epoch` ABORT the request in flight (its answer
//     has the wrong view, predates the reset or the epoch) and start a new
//     one in `replace` mode (older pages dropped);
//   · any other reason during a flight sets `rerun` (first reason kept) ⇒
//     exactly ONE rerun after the current apply, in `tail` mode (the pages a
//     reader scrolled up into are kept);
//   · the journal begins at every request start, spans aborts and reruns, and
//     ends only after an apply (or an error) with no rerun queued;
//   · an answer of an older epoch than the stream's, or strictly older than
//     the snapshot already applied, is ignored;
//   · journal eviction beyond the answer's revision ⇒ rerun `overflow`.
// Coverage: the transcript is COVERED when its last applied snapshot was
// focused (`focus.focused === true`: this connection carried the session's
// frames from that revision on) and is ≥ the last resync revision. A resync
// re-windows unless covered. An unfocused snapshot retries once at the next
// hello completion (`sync_replay_end`/`sync_snapshot_end`).

import { cmpRev, type SyncRev } from '@/lib/sync/rev';
import type { TranscriptView } from '@/lib/transcriptRows';
import type { SessionWindowResponse } from '@/lib/types/api';
import type { TranscriptJournal } from './transcriptJournal';
import type { SessionFrame } from './transcriptReducer';

export type WindowReason = 'mount' | 'view' | 'reset' | 'epoch' | 'resync' | 'unfocused' | 'missed-frame'
  | 'unknown-row' | 'gate' | 'gate-payload' | 'overflow' | 'probe-404';

/** Reasons whose request supersedes the one in flight (replace mode). */
const ABORTING: ReadonlySet<WindowReason> = new Set<WindowReason>(['mount', 'view', 'reset', 'epoch']);

export type WindowSync = {
  setView(v: TranscriptView | null): void;
  request(reason: WindowReason): void;
  onResync(snapshotRev: SyncRev): void;
  onHelloComplete(): void;
  readonly inFlight: boolean;
  readonly snapshotRev: SyncRev | null;
  dispose(): void;
};

export function createWindowSync(o: {
  fetchWindow(p: { view: TranscriptView; conn: string; focusSeq: number; signal: AbortSignal }): Promise<SessionWindowResponse>;
  apply(r: SessionWindowResponse, mode: 'replace' | 'tail', replay: Array<{ ev: SessionFrame; rev: SyncRev }>): void;
  journal: TranscriptJournal<SessionFrame>; focusTicket(): { conn: string; seq: number };
  epoch(): number | null;
  /** A request failed (network, 5xx, 404…). Optional: diagnostics / 401/404 handling. */
  onError?(error: unknown, reason: WindowReason): void;
  /** A request starts / settles (the hook's syncing cue). Optional. */
  onFlight?(inFlight: boolean, reason: WindowReason | null): void;
}): WindowSync {
  let view: TranscriptView | null = null;
  let controller: AbortController | null = null;
  let flight: { gen: number; mode: 'replace' | 'tail'; reason: WindowReason } | null = null;
  let gen = 0;
  let rerun: WindowReason | null = null;
  let snapshotRev: SyncRev | null = null;
  let lastFocused = false;
  let lastResyncRev: SyncRev | null = null;
  let recheckResync = false;
  let unfocusedRetry = false;
  let disposed = false;

  const covered = (): boolean => lastFocused && snapshotRev != null
    && (lastResyncRev == null || cmpRev(snapshotRev, lastResyncRev) >= 0);

  function abortFlight(): void {
    if (!flight) return;
    gen += 1;                      // the old answer is ignored when it lands
    flight = null;
    try { controller?.abort(new DOMException('window superseded', 'AbortError')); } catch { /* already settled */ }
    controller = null;
  }

  function start(mode: 'replace' | 'tail', reason: WindowReason): void {
    if (disposed || view == null) return;
    o.journal.begin();
    const myGen = ++gen;
    const ac = new AbortController();
    controller = ac;
    flight = { gen: myGen, mode, reason };
    o.onFlight?.(true, reason);
    const ticket = o.focusTicket();
    let req: Promise<SessionWindowResponse>;
    try {
      req = o.fetchWindow({ view, conn: ticket.conn, focusSeq: ticket.seq, signal: ac.signal });
    } catch (e) {
      req = Promise.reject(e);
    }
    req.then((r) => {
      if (disposed || myGen !== gen) return;
      flight = null;
      controller = null;
      land(r, mode);
    }, (e) => {
      if (disposed || myGen !== gen) return;
      flight = null;
      controller = null;
      o.onError?.(e, reason);
      settle();
    });
  }

  /** After an answer or an error: one queued rerun, else the journal ends. */
  function settle(): void {
    if (rerun) {
      const why = rerun;
      rerun = null;
      start('tail', why);
      return;
    }
    o.journal.end();
    o.onFlight?.(false, null);
  }

  function land(r: SessionWindowResponse, mode: 'replace' | 'tail'): void {
    const sync = r.sync ?? null;
    const streamEpoch = o.epoch();
    const stale = sync != null && (
      (streamEpoch != null && sync.epoch < streamEpoch)
      // Strictly older only: a quiet hub answers a later request with the
      // SAME revision (nothing published since), and that answer is still
      // the one to apply (another view, a gate written outside the bus).
      || (snapshotRev != null && cmpRev(sync, snapshotRev) < 0));
    if (!stale) {
      const replay = sync ? o.journal.takeAfter(sync) : [];
      o.apply(r, mode, replay);
      if (sync) snapshotRev = sync;
      // An older hub answers no `focus`: nothing to retry against.
      lastFocused = r.focus ? r.focus.focused === true : true;
      if (r.focus && r.focus.focused === false) unfocusedRetry = true;
      const dropped = o.journal.droppedUpTo;
      if (sync && dropped && cmpRev(dropped, sync) > 0) rerun ??= 'overflow';
    }
    if (recheckResync) {
      recheckResync = false;
      if (!covered()) rerun ??= 'resync';
    }
    settle();
  }

  function request(reason: WindowReason): void {
    if (disposed) return;
    if (view == null) return;                 // the first non-null view runs `mount`
    if (ABORTING.has(reason)) {
      abortFlight();
      rerun = null;                           // the new request answers it
      start('replace', reason);
      return;
    }
    if (flight) {
      rerun ??= reason;
      return;
    }
    start('tail', reason);
  }

  return {
    setView(v) {
      if (disposed || v === view) return;
      const first = view == null;
      view = v;
      if (v == null) {
        abortFlight();
        rerun = null;
        o.journal.end();
        return;
      }
      request(first ? 'mount' : 'view');
    },
    request,
    onResync(rev) {
      if (disposed) return;
      lastResyncRev = rev;
      if (view == null) return;               // the mount GET is the resync
      // A new hub process (or offline compaction): rows older than the window
      // may differ too ⇒ replace, never tail.
      if (snapshotRev && rev.epoch !== snapshotRev.epoch) {
        request('epoch');
        return;
      }
      if (flight) {
        recheckResync = true;                 // decided when the answer lands
        return;
      }
      if (covered()) return;
      request('resync');
    },
    onHelloComplete() {
      if (disposed || !unfocusedRetry) return;
      unfocusedRetry = false;
      request('unfocused');
    },
    get inFlight() { return flight != null; },
    get snapshotRev() { return snapshotRev; },
    dispose() {
      if (disposed) return;
      abortFlight();
      disposed = true;
      rerun = null;
      o.journal.end();
    },
  };
}
