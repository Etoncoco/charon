// INTERIM (Step 2, C10) — deleted by the summary store (C15).
//
// The session list has two writers: the list GET (complete but slow, and
// unordered: two GETs can land out of order, FM9) and the live frames that
// patch one field of one row (`status`, `session_unread`, `session_bg_tasks`).
// Without ordering, a GET that STARTED before a stop and RETURNED after the
// live patch reverted the row to "thinking, not unread" until the next poll
// (R3 F1/F2/F15, R5 D-2/scenario H).
//
// `createListRefresher` fixes both halves:
//   - one list GET in flight at a time; triggers during the flight set `dirty`
//     ⇒ exactly one rerun after it (N triggers ⇒ ≤ 2 GETs);
//   - every live patch is stamped with a monotonic tick and re-applied over any
//     response whose GET started BEFORE it (a response started after the patch
//     already contains it, and the patch is forgotten).
import type { SessionListItem } from '@/lib/types/api';

/** The row fields the live frames patch. */
export type SessionLivePatch = {
  liveStatus?: SessionListItem['liveStatus'];
  unreadStop?: number;
  runningBgTasks?: number;
};
type PatchKey = keyof SessionLivePatch;

export type ListRefresher<R extends { sessions: SessionListItem[] }> = {
  /** Trigger a list GET (coalesced). Resolves when the GET chain it joined settles. */
  refresh(): Promise<void>;
  /** Record a live patch (the caller applies it to its state itself). */
  notePatch(id: string, patch: SessionLivePatch): void;
  /** Rows with the still-relevant live patches applied (exposed for tests). */
  overlay(rows: SessionListItem[], startedAt: number): SessionListItem[];
  /** Pending patch count (tests / debugging). */
  pendingPatches(): number;
};

export function createListRefresher<R extends { sessions: SessionListItem[] }>(opts: {
  fetch: () => Promise<R>;
  /** Called with the response and its rows, newer live patches re-applied. */
  apply: (response: R, sessions: SessionListItem[]) => void;
}): ListRefresher<R> {
  let tick = 0;
  // id → field → { value, at }
  const patches = new Map<string, Map<PatchKey, { value: unknown; at: number }>>();
  let inFlight: Promise<void> | null = null;
  let dirty = false;

  function overlay(rows: SessionListItem[], startedAt: number): SessionListItem[] {
    if (patches.size === 0) return rows;
    let changed = false;
    const out = rows.map((row) => {
      const fields = patches.get(row.id);
      if (!fields) return row;
      let next: SessionListItem | null = null;
      for (const [key, p] of fields) {
        if (p.at <= startedAt) continue;           // the response already saw it
        if ((row as Record<string, unknown>)[key] === p.value) continue;
        next ??= { ...row };
        (next as Record<string, unknown>)[key] = p.value;
      }
      if (!next) return row;
      changed = true;
      return next;
    });
    return changed ? out : rows;
  }

  /** Forget the patches a response started at `startedAt` already contains. */
  function forgetUpTo(startedAt: number): void {
    for (const [id, fields] of patches) {
      for (const [key, p] of fields) if (p.at <= startedAt) fields.delete(key);
      if (fields.size === 0) patches.delete(id);
    }
  }

  async function runOnce(): Promise<void> {
    const startedAt = tick;
    let response: R;
    try {
      response = await opts.fetch();
    } catch {
      return;                                      // the next trigger retries
    }
    const rows = overlay(response.sessions, startedAt);
    forgetUpTo(startedAt);
    opts.apply(response, rows);
  }

  function refresh(): Promise<void> {
    if (inFlight) {
      dirty = true;
      return inFlight;
    }
    inFlight = (async () => {
      try {
        do {
          dirty = false;
          await runOnce();
        } while (dirty);
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  function notePatch(id: string, patch: SessionLivePatch): void {
    const at = ++tick;
    let fields = patches.get(id);
    if (!fields) { fields = new Map(); patches.set(id, fields); }
    for (const key of Object.keys(patch) as PatchKey[]) {
      if (patch[key] === undefined) continue;
      fields.set(key, { value: patch[key], at });
    }
    if (fields.size === 0) patches.delete(id);
  }

  return {
    refresh,
    notePatch,
    overlay,
    pendingPatches: () => {
      let n = 0;
      for (const f of patches.values()) n += f.size;
      return n;
    },
  };
}

/** One field: primitives by identity, objects/arrays (`gates`, `endpoint` —
 *  a fresh identity on every JSON parse) by value. */
function sameField(x: unknown, y: unknown): boolean {
  if (x === y) return true;
  if (x == null || y == null || typeof x !== 'object' || typeof y !== 'object') return false;
  return JSON.stringify(x) === JSON.stringify(y);
}

function sameRow(a: SessionListItem, b: SessionListItem): boolean {
  if (a === b) return true;
  const x = a as unknown as Record<string, unknown>;
  const y = b as unknown as Record<string, unknown>;
  const xk = Object.keys(x);
  if (xk.length !== Object.keys(y).length) return false;
  for (const k of xk) if (!sameField(x[k], y[k])) return false;
  return true;
}

/**
 * The list a refresh should commit: `prev` itself when nothing changed (no
 * re-render), else `next` with every unchanged row (same id, same values)
 * replaced by its previous object, so unchanged cards keep their identity.
 */
export function reuseSessionRows(prev: SessionListItem[], next: SessionListItem[]): SessionListItem[] {
  const byId = new Map(prev.map((r) => [r.id, r]));
  let changed = prev.length !== next.length;
  const out = next.map((row, i) => {
    const old = byId.get(row.id);
    if (old && sameRow(old, row)) {
      if (prev[i] !== old) changed = true;
      return old;
    }
    changed = true;
    return row;
  });
  return changed ? out : prev;
}
