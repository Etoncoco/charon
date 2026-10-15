// STUB(C12): the one export of C13's `lib/server/sync/sessionSummaries.ts`
// (SPEC §6 C13) that the proto-2 SSE resync reads, implemented as SPEC §6
// C12's "until C13 lands" fallback: the annotated non-archived list rows with
// `gates: []` and a locally derived `attention`, and NO publication (the
// reconcile is a no-op). The integrator replaces this file with C13's; the
// signature is identical, so the events route does not change.
import 'server-only';
import { desc, eq } from 'drizzle-orm';
import { db, claudeSessions } from '@/lib/db';
import { annotateSessionRows } from '@/lib/server/claude/sessionList';
import type { Attention, SessionSummary } from '@/lib/sessionSummary';
import type { WorkerStatus } from '@/lib/types/api';

/** blocked > question (async) > unread (`active`) — §14.108's order; C10's
 *  `deriveAttention` replaces it with the real module. */
function fallbackAttention(item: { pendingBlocking?: number; pendingAsync?: number;
  unreadStop?: number | null; liveStatus?: string | null }): Attention {
  if ((item.pendingBlocking ?? 0) > 0) return 'blocked';
  if ((item.pendingAsync ?? 0) > 0) return 'question';
  if (item.unreadStop === 1 && item.liveStatus === 'active') return 'unread';
  return null;
}

/** Every non-archived session as a summary (list order). STUB: publishes nothing. */
export function reconcileAllSummaries(): SessionSummary[] {
  const rows = db.select().from(claudeSessions)
    .where(eq(claudeSessions.archived, 0))
    .orderBy(desc(claudeSessions.createdAt), desc(claudeSessions.id))
    .all();
  return annotateSessionRows(rows).map((r) => ({
    ...r,
    liveStatus: (r.liveStatus ?? r.status) as WorkerStatus,
    runningBgTasks: r.runningBgTasks ?? 0,
    lastActivityMs: r.lastActivityMs ?? null,
    addressable: !!r.addressable,
    pendingBlocking: r.pendingBlocking ?? 0,
    pendingAsync: r.pendingAsync ?? 0,
    gates: [],
    attention: fallbackAttention(r),
  }));
}
