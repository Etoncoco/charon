'use client';
import { useEffect, useState } from 'react';
import type {
  PermissionRequest, PendingQuestion, PendingExitPlan,
} from './sessionTypes';
import { subscribeAll } from './globalEventStream';

// useCrossSessionInteractionFeed
// ─────────────────────────────────────────────────────────────────────────────
// Subscribes to the multiplexed global stream via `globalEventStream` and
// maintains the cross-session interaction queues:
//   - permission_request → permQueue (top-right popup)
//   - user_question → questionQueue
//   - exit_plan_request → exitPlanQueue
//   - interaction_resolved → empties the corresponding queue
//
// The server emits these events to ALL connections (low-volume events,
// cf. lib/server/sync/frameRouting.ts § FRAME_CLASS) — no focus needed to receive
// them. This is what enables the cross-session permission popup:
// if you're on Session A and a perm fires on Session B, you still see it.

export type CrossSessionInteractions = {
  perms: PermissionRequest[];
  questions: PendingQuestion[];
  exitPlans: PendingExitPlan[];
};

/** Slack past a gate's `expiresAt` before the feed drops it on its own: the
 *  hub's expiry frame normally arrives first (C07 sweeper); this only reaps a
 *  gate whose removal this tab never received. */
export const FEED_EXPIRY_SLACK_S = 5;
const FEED_PRUNE_TICK_MS = 5_000;

type Gate = { id: string; expiresAt?: number };
type PendingSnapshotFrame = {
  permissions: Array<{ id: string }>;
  questions: Array<{ id: string }>;
  exitPlans: Array<{ id: string }>;
};

/** Keep only the gates a COMPLETE `pending_snapshot` names (ghost removal: a
 *  resolution missed while disconnected). Same array back when nothing goes. */
export function keepListed<T extends Gate>(queue: T[], listed: ReadonlyArray<{ id: string }>): T[] {
  const ids = new Set(listed.map((x) => x.id));
  const next = queue.filter((g) => ids.has(g.id));
  return next.length === queue.length ? queue : next;
}

/** Drop the gates past `expiresAt` (unix s) + slack. Same array back when none. */
export function pruneExpired<T extends Gate>(queue: T[], nowSec: number): T[] {
  const next = queue.filter((g) => g.expiresAt == null || nowSec <= g.expiresAt + FEED_EXPIRY_SLACK_S);
  return next.length === queue.length ? queue : next;
}

/** The three queues after a `pending_snapshot` frame. */
export function applyPendingSnapshot(q: CrossSessionInteractions, snap: PendingSnapshotFrame): CrossSessionInteractions {
  return {
    perms: keepListed(q.perms, snap.permissions ?? []),
    questions: keepListed(q.questions, snap.questions ?? []),
    exitPlans: keepListed(q.exitPlans, snap.exitPlans ?? []),
  };
}

export function useCrossSessionInteractionFeed(): CrossSessionInteractions {
  const [perms, setPerms] = useState<PermissionRequest[]>([]);
  const [questions, setQuestions] = useState<PendingQuestion[]>([]);
  const [exitPlans, setExitPlans] = useState<PendingExitPlan[]>([]);

  useEffect(() => {
    setPerms([]); setQuestions([]); setExitPlans([]);
    const now = () => Math.floor(Date.now() / 1000);

    const unsubscribe = subscribeAll((ev) => {
      // `subscribeAll` also receives install events which have no
      // sessionId — we filter them via the discriminant `'sessionId' in ev`.
      const sid = 'sessionId' in ev ? ev.sessionId : null;
      if (!sid) return;
      if (ev.type === 'pending_snapshot') {
        // Sent after the connect replays: the complete pending set. Anything
        // queued here that it does not name was resolved while we were away.
        const snap = ev as unknown as PendingSnapshotFrame;
        setPerms((q) => keepListed(q, snap.permissions ?? []));
        setQuestions((q) => keepListed(q, snap.questions ?? []));
        setExitPlans((q) => keepListed(q, snap.exitPlans ?? []));
        return;
      }
      if (ev.type === 'permission_request') {
        setPerms((q) => q.some((p) => p.id === ev.id) ? q : [...q, {
          id: ev.id, sessionId: sid, tool: ev.tool, input: ev.input,
          createdAt: now(),
          expiresAt: ev.expiresAt,
        }]);
      } else if (ev.type === 'user_question') {
        setQuestions((q) => q.some((p) => p.id === ev.id) ? q : [...q, {
          id: ev.id, sessionId: sid, questions: ev.questions,
          createdAt: ev.createdAt ?? now(),
          expiresAt: ev.expiresAt,
          delivery: ev.delivery,
        }]);
      } else if (ev.type === 'exit_plan_request') {
        setExitPlans((q) => q.some((p) => p.id === ev.id) ? q : [...q, {
          id: ev.id, sessionId: sid, plan: ev.plan ?? '',
          createdAt: now(),
          expiresAt: ev.expiresAt,
        }]);
      } else if (ev.type === 'interaction_resolved') {
        if (ev.kind === 'permission') setPerms((q) => q.filter((p) => p.id !== ev.id));
        else if (ev.kind === 'question') setQuestions((q) => q.filter((p) => p.id !== ev.id));
        else if (ev.kind === 'exit_plan') setExitPlans((q) => q.filter((p) => p.id !== ev.id));
      }
    });

    // A gate past its deadline is closed by the provider; reap it even if
    // its removal frame never reached this tab.
    const prune = setInterval(() => {
      const t = now();
      setPerms((q) => pruneExpired(q, t));
      setQuestions((q) => pruneExpired(q, t));
      setExitPlans((q) => pruneExpired(q, t));
    }, FEED_PRUNE_TICK_MS);

    return () => { unsubscribe(); clearInterval(prune); };
  }, []);

  return { perms, questions, exitPlans };
}
