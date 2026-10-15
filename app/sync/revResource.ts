// Revision-guarded refetch of an HTTP resource (CLAUDE.md §9, SPEC C15) —
// React-free, browser-safe.
//
// A bus frame announces "this changed at rev R" (`tabs_changed`,
// `settings_changed`); the data itself comes from a GET whose answer carries
// `sync` = the bus revision it reflects. The rule:
//   - `invalidate(R)` records R and fetches;
//   - an answer is applied iff `sync ≥` the highest invalidation seen (else it
//     was read before the change: refetch, bounded) and never when older than
//     the last applied answer (G4);
//   - ONE request at a time: a trigger during a flight sets `dirty` ⇒ exactly
//     one rerun after it (never a join that hands back the pre-change answer —
//     R3 F14).
// An answer without `sync` (an older hub) is applied as it comes.
import { cmpRev, type SyncRev } from '@/lib/sync/rev';

/** Single flight + one rerun: N triggers during a run ⇒ ONE more run. */
export function createRerunner(run: () => Promise<void>): { trigger(): Promise<void>; readonly running: boolean } {
  let inflight: Promise<void> | null = null;
  let dirty = false;
  return {
    get running() { return inflight != null; },
    trigger() {
      if (inflight) { dirty = true; return inflight; }
      inflight = (async () => {
        try {
          do {
            dirty = false;
            try { await run(); } catch { /* the next trigger retries */ }
          } while (dirty);
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    },
  };
}

/** Latest-STARTED request wins (R3 F13): `const n = gate.next(); … if
 *  (gate.isLatest(n)) apply(r)`. */
export function createLatestGate(): { next(): number; isLatest(n: number): boolean } {
  let seq = 0;
  return { next: () => ++seq, isLatest: (n) => n === seq };
}

export type RevResource = {
  /** A frame says the resource changed at `rev` (null: unknown ⇒ just refetch). */
  invalidate(rev: SyncRev | null | undefined): Promise<void>;
  /** Refetch without a known revision (resync, window focus, mount). */
  refresh(): Promise<void>;
  readonly lastApplied: SyncRev | null;
};

export const STALE_REFETCH_MAX = 2;

export function createRevResource<R>(o: {
  fetch(): Promise<R>;
  apply(r: R): void;
  /** Default: `r.sync`. */
  stampOf?(r: R): SyncRev | null | undefined;
  /** Serializer (e.g. the store's mutation queue): a refresh never lands
   *  between a mutation's request and its answer. */
  run?: <T>(fn: () => Promise<T>) => Promise<T>;
}): RevResource {
  let need: SyncRev | null = null;
  let lastApplied: SyncRev | null = null;
  let staleRetries = 0;
  const stampOf = o.stampOf ?? ((r: R) => (r as { sync?: SyncRev | null } | null)?.sync ?? null);
  const run = o.run ?? (<T>(fn: () => Promise<T>) => fn());

  const rerunner = createRerunner(async () => {
    const r = await run(() => o.fetch());
    const stamp = stampOf(r) ?? null;
    if (stamp && need && cmpRev(stamp, need) < 0) {
      // Read before the change it was asked for: refetch (a GET started
      // after the frame always reflects it — bounded anyway).
      if (staleRetries++ < STALE_REFETCH_MAX) void rerunner.trigger();
      return;
    }
    staleRetries = 0;
    if (stamp && lastApplied && cmpRev(stamp, lastApplied) < 0) return;
    o.apply(r);
    if (stamp) lastApplied = stamp;
  });

  return {
    get lastApplied() { return lastApplied; },
    invalidate(rev) {
      if (rev && cmpRev(rev, need) > 0) need = rev;
      staleRetries = 0;
      return rerunner.trigger();
    },
    refresh() {
      return rerunner.trigger();
    },
  };
}
