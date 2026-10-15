// STUB(C13): the spec-exact subset of C10's `lib/sessionAttention.ts` (SPEC §5
// C10) that the session summaries (C13) need — `deriveAttention` and its
// types. C10 owns the real module (plus `attentionForRow`, `pendingSplit`…);
// the integrator replaces this file with C10's.
//
// THE cross-session attention predicate (CLAUDE.md §14.47/§14.108):
//   blocked   a blocking gate on a LIVE session (any live status, thinking too)
//   question  an async question (§14.96), any status
//   unread    the durable "finished, unread" marker on an `active` row
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
