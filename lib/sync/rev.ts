// Sync revisions (CLAUDE.md §14.14). Browser-safe, no imports.
//
// Every frame of the hub's sync bus is stamped `id: <epoch>.<rev>`: `epoch` is
// the hub process start (ms, captured once when `globalThis.__charonSync` is
// created), `rev` a per-process counter starting at 1. A new process always
// yields a later epoch, so (epoch, rev) is totally ordered across restarts —
// unlike the agent's seq, which restarts at 1 when its log is recreated
// (§14.71). Snapshots (HTTP responses) carry the same pair as `sync`.

export type SyncRev = { epoch: number; rev: number };

export const formatRev = (r: SyncRev): string => `${r.epoch}.${r.rev}`;

const REV_RE = /^(\d{1,16})\.(\d{1,15})$/;

/** `"<epoch>.<rev>"` → SyncRev, else null (malformed, or past 2^53). */
export function parseRev(s: string | null | undefined): SyncRev | null {
  if (typeof s !== 'string') return null;
  const m = REV_RE.exec(s);
  if (!m) return null;
  const epoch = Number(m[1]);
  const rev = Number(m[2]);
  if (!Number.isSafeInteger(epoch) || !Number.isSafeInteger(rev)) return null;
  return { epoch, rev };
}

/** Total order: null lowest, then epoch, then rev. Returns -1, 0 or 1. */
export function cmpRev(a: SyncRev | null, b: SyncRev | null): number {
  if (a == null || b == null) return a == null ? (b == null ? 0 : -1) : 1;
  if (a.epoch !== b.epoch) return a.epoch < b.epoch ? -1 : 1;
  if (a.rev !== b.rev) return a.rev < b.rev ? -1 : 1;
  return 0;
}

export const isNewer = (a: SyncRev | null, b: SyncRev | null): boolean => cmpRev(a, b) > 0;
