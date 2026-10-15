// THE cross-session attention predicate (CLAUDE.md §11 HeaderSessionNav, §14.47).
// Browser-safe, no imports beyond types. Every surface that says "this session
// wants you" — sidebar card, header nav (+ title/favicon badge), tab bar, the
// sidebar filter chip, the desk — asks THIS module, so one session can never
// read "needs you" in one place and "working" three inches away (R5 D-4).
//
//   blocked   a blocking gate (permission, blocking question, plan review) on a
//             LIVE session — whatever the live status, thinking included: the
//             turn is parked on you.
//   question  an async question (§14.96): answerable at any time, any status
//             (answering wakes a paused session), never blocking.
//   unread    the durable "finished, unread" marker (§14.47) on a READY row.
//
// A blocking gate on a non-live session (sleeping/error/killed) is dead — the
// hub resolves it on the way down (C07) — so it is not `blocked` here.
import type { SessionListItem } from '@/lib/types/api';

export type Attention = 'blocked' | 'question' | 'unread' | null;

/** Statuses on which a blocking gate cannot be answered any more. */
export const NON_LIVE_STATUSES = ['sleeping', 'error', 'killed'] as const;
const NON_LIVE: ReadonlySet<string> = new Set(NON_LIVE_STATUSES);

/** What the row is actually showing: the live status when the hub knows one. */
export function rowStatus(r: { liveStatus?: string | null; status: string }): string {
  return r.liveStatus ?? r.status;
}

export function deriveAttention(s: {
  status: string;
  unreadStop: number | boolean | null | undefined;
  pendingBlocking: number;
  pendingAsync: number;
}): Attention {
  const status = String(s.status ?? '');
  if (s.pendingBlocking > 0 && status !== '' && !NON_LIVE.has(status)) return 'blocked';
  if (s.pendingAsync > 0) return 'question';
  if (s.unreadStop && status === 'active') return 'unread';
  return null;
}

/** The gate split of a list row. An older hub sends only `pendingPermissions`
 *  (every gate, summed): read it as blocking. */
export function pendingSplit(row: {
  pendingPermissions?: number | null; pendingBlocking?: number | null; pendingAsync?: number | null;
}): { pendingBlocking: number; pendingAsync: number } {
  if (typeof row.pendingBlocking === 'number') {
    return { pendingBlocking: row.pendingBlocking, pendingAsync: row.pendingAsync ?? 0 };
  }
  return { pendingBlocking: row.pendingPermissions ?? 0, pendingAsync: 0 };
}

/**
 * The attention of a list row as THIS tab draws it. The one client-local rule:
 * `unread` is hidden on the row this tab is visibly viewing (the view itself is
 * the acknowledgement, POST /focus clears the durable marker).
 */
export function attentionForRow(
  row: Pick<SessionListItem, 'status'> & {
    liveStatus?: string | null;
    unreadStop?: number | boolean | null;
    pendingPermissions?: number | null; pendingBlocking?: number | null; pendingAsync?: number | null;
  },
  o: { viewedHere: boolean },
): Attention {
  const a = deriveAttention({ status: rowStatus(row), unreadStop: row.unreadStop, ...pendingSplit(row) });
  if (a === 'unread' && o.viewedHere) return null;
  return a;
}

/** blocked | question: the session is waiting on the user (badge, tab dot, filter chip). */
export function isWaitingAttention(a: Attention): boolean {
  return a === 'blocked' || a === 'question';
}
