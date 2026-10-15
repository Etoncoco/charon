// INTERIM (sync refonte C09 — deleted by C16, whose snapshot@R + journal makes
// it moot): a pending-gate snapshot (the session GET's or the delta poll's
// `pendingPermissions`/`pendingQuestions`/`pendingExitPlans`) was read BEFORE
// the live frames that arrived while it was in flight. Replacing the queue with
// it dropped a question announced live during the first GET (D-17 / R3 F5) or
// during a poll (F8), and brought back for a tick a gate resolved live meanwhile.
//
// The hook journals the gate ids it added or resolved live, stamped with its
// live-event revision; when a snapshot whose request started at revision R is
// applied, the ids journaled after R are re-applied over it.
//
// Browser-safe, no React.

/** The ids a snapshot must not contradict: added (kept, from the queue held
 *  now — `current`) and resolved (removed) live since its request started.
 *  `current` (an addition to the spec's 3-parameter form, deviations/C09.md):
 *  a live-added gate's DATA is only in the queue the view holds. */
export function mergePendingSnapshot<T extends { id: string }>(
  snapshot: readonly T[], liveAdded: ReadonlySet<string>, liveResolved: ReadonlySet<string>,
  current: readonly T[] = [],
): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const item of snapshot) {
    if (liveResolved.has(item.id) || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  for (const item of current) {
    if (!liveAdded.has(item.id) || liveResolved.has(item.id) || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

export type GateJournalEntry = { rev: number; id: string; op: 'added' | 'resolved' };

/** Bounded journal of live gate changes (the hook's ref). */
export const GATE_JOURNAL_MAX = 256;

export function journalGate(journal: GateJournalEntry[], entry: GateJournalEntry): GateJournalEntry[] {
  const next = journal.length >= GATE_JOURNAL_MAX ? journal.slice(journal.length - GATE_JOURNAL_MAX + 1) : journal.slice();
  next.push(entry);
  return next;
}

/** The live changes after revision `since` (a request's start). The latest
 *  operation per id wins (added then resolved ⇒ resolved). */
export function gateChangesSince(journal: readonly GateJournalEntry[], since: number):
  { liveAdded: Set<string>; liveResolved: Set<string> } {
  const last = new Map<string, 'added' | 'resolved'>();
  for (const e of journal) if (e.rev > since) last.set(e.id, e.op);
  const liveAdded = new Set<string>();
  const liveResolved = new Set<string>();
  for (const [id, op] of last) (op === 'added' ? liveAdded : liveResolved).add(id);
  return { liveAdded, liveResolved };
}
