import 'server-only';
import { and, eq, inArray, isNotNull, lte } from 'drizzle-orm';
import { db, claudePendingPermissions, claudePendingQuestions } from '@/lib/db';

// Import-cycle-free on purpose (sessionOps imports this module): publishing
// lives in sessionOps (`publishInteractionResolved`, `sweepExpiredInteractions`).
// Everything here only writes the gate tables and RETURNS what it changed — a
// caller that removes a gate owes its `interaction_resolved` frame (G7).

/** A human gate as the wire names it (`interaction_resolved.kind`). */
export type GateKind = 'permission' | 'question' | 'exit_plan';
export type GateOutcome = 'answered' | 'denied' | 'expired' | 'cancelled';
export type GateRef = { kind: GateKind; id: string; sessionId: string };

/** `claude_pending_questions.kind` → wire kind (an async question is a question). */
export function questionGateKind(kind: string): 'question' | 'exit_plan' {
  return kind === 'exit_plan' ? 'exit_plan' : 'question';
}

/** A resolved row's `status` → the outcome the live path publishes for it
 *  (a permission row stores `allowed`, its frame says `answered`). */
export function gateOutcome(status: string): GateOutcome {
  switch (status) {
    case 'allowed':
    case 'answered':
      return 'answered';
    case 'denied':
    case 'expired':
    case 'cancelled':
      return status;
    default:
      return 'cancelled';
  }
}

/**
 * Repairs pending rows whose provider deadline passed while the hub was down
 * or while an older agent (which cannot emit interaction_resolved) was live.
 * The providers already deny/cancel at these deadlines; this only keeps the
 * durable UI projection honest. Returns the rows it expired: the caller
 * publishes each (sessionOps § sweepExpiredInteractions). Async questions
 * carry no deadline, so they are never swept (§14.96).
 */
export function expireStalePendingInteractions(
  nowSeconds = Math.floor(Date.now() / 1000),
): GateRef[] {
  const perms = db.update(claudePendingPermissions)
    .set({ status: 'expired', respondedAt: nowSeconds })
    .where(and(
      eq(claudePendingPermissions.status, 'pending'),
      isNotNull(claudePendingPermissions.expiresAt),
      lte(claudePendingPermissions.expiresAt, nowSeconds),
    ))
    .returning({ id: claudePendingPermissions.id, sessionId: claudePendingPermissions.sessionId })
    .all();
  const questions = db.update(claudePendingQuestions)
    .set({ status: 'expired', respondedAt: nowSeconds })
    .where(and(
      eq(claudePendingQuestions.status, 'pending'),
      isNotNull(claudePendingQuestions.expiresAt),
      lte(claudePendingQuestions.expiresAt, nowSeconds),
    ))
    .returning({
      id: claudePendingQuestions.id, sessionId: claudePendingQuestions.sessionId,
      kind: claudePendingQuestions.kind,
    })
    .all();
  return [
    ...perms.map((p) => ({ kind: 'permission' as const, id: p.id, sessionId: p.sessionId })),
    ...questions.map((q) => ({ kind: questionGateKind(q.kind), id: q.id, sessionId: q.sessionId })),
  ];
}

/**
 * Cancel the BLOCKING gates of a session that left the live states (sleep,
 * error, killed, force-stop): their provider future died with the worker, so
 * no answer can ever reach it. Async questions survive — answering one
 * resumes the session (§14.49/96). Returns the cancelled gates to publish.
 */
export function cancelBlockingGateRows(
  sessionId: string, nowSeconds = Math.floor(Date.now() / 1000),
): GateRef[] {
  return db.transaction(() => {
    const perms = db.update(claudePendingPermissions)
      .set({ status: 'cancelled', respondedAt: nowSeconds })
      .where(and(
        eq(claudePendingPermissions.sessionId, sessionId),
        eq(claudePendingPermissions.status, 'pending'),
      ))
      .returning({ id: claudePendingPermissions.id })
      .all();
    const questions = db.update(claudePendingQuestions)
      .set({ status: 'cancelled', respondedAt: nowSeconds })
      .where(and(
        eq(claudePendingQuestions.sessionId, sessionId),
        eq(claudePendingQuestions.status, 'pending'),
        inArray(claudePendingQuestions.kind, ['question', 'exit_plan']),
      ))
      .returning({ id: claudePendingQuestions.id, kind: claudePendingQuestions.kind })
      .all();
    return [
      ...perms.map((p) => ({ kind: 'permission' as const, id: p.id, sessionId })),
      ...questions.map((q) => ({ kind: questionGateKind(q.kind), id: q.id, sessionId })),
    ];
  });
}

/**
 * Delete EVERY gate row of a session (archive, rollback, session delete) and
 * return the ones that were still PENDING; the caller publishes `cancelled`
 * for each after its transaction committed. Meant to run inside that
 * transaction (one SQLite connection: `db` inside `db.transaction` is in it).
 */
export function deleteSessionGates(sessionId: string): GateRef[] {
  const perms = db.select({ id: claudePendingPermissions.id }).from(claudePendingPermissions)
    .where(and(
      eq(claudePendingPermissions.sessionId, sessionId),
      eq(claudePendingPermissions.status, 'pending'),
    )).all();
  const questions = db.select({ id: claudePendingQuestions.id, kind: claudePendingQuestions.kind })
    .from(claudePendingQuestions)
    .where(and(
      eq(claudePendingQuestions.sessionId, sessionId),
      eq(claudePendingQuestions.status, 'pending'),
    )).all();
  db.delete(claudePendingPermissions).where(eq(claudePendingPermissions.sessionId, sessionId)).run();
  db.delete(claudePendingQuestions).where(eq(claudePendingQuestions.sessionId, sessionId)).run();
  return [
    ...perms.map((p) => ({ kind: 'permission' as const, id: p.id, sessionId })),
    ...questions.map((q) => ({ kind: questionGateKind(q.kind), id: q.id, sessionId })),
  ];
}
