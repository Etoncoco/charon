import { describe, expect, it } from 'vitest';
import {
  GATE_JOURNAL_MAX, gateChangesSince, journalGate, mergePendingSnapshot, type GateJournalEntry,
} from '@/app/pendingQueueMerge';

type Q = { id: string; createdAt: number };
const q = (id: string, createdAt = 1): Q => ({ id, createdAt });

describe('mergePendingSnapshot (INTERIM, until C16)', () => {
  it('a question added live during the first GET survives that GET', () => {
    // GET requested at revision 0; the question arrived live at revision 1.
    let journal: GateJournalEntry[] = [];
    journal = journalGate(journal, { rev: 1, id: 'live-q', op: 'added' });
    const current = [q('live-q', 5)];
    const { liveAdded, liveResolved } = gateChangesSince(journal, 0);
    expect(mergePendingSnapshot([], liveAdded, liveResolved, current)).toEqual([q('live-q', 5)]);
  });

  it('one resolved live stays gone although the snapshot still lists it', () => {
    let journal: GateJournalEntry[] = [];
    journal = journalGate(journal, { rev: 1, id: 'old-q', op: 'added' });
    journal = journalGate(journal, { rev: 2, id: 'old-q', op: 'resolved' });
    const { liveAdded, liveResolved } = gateChangesSince(journal, 0);
    expect(mergePendingSnapshot([q('old-q'), q('other')], liveAdded, liveResolved, [q('old-q')]))
      .toEqual([q('other')]);
  });

  it('changes from before the request are the snapshot\'s business', () => {
    let journal: GateJournalEntry[] = [];
    journal = journalGate(journal, { rev: 1, id: 'gone', op: 'added' });
    const { liveAdded, liveResolved } = gateChangesSince(journal, 1);
    // Resolved elsewhere and missed: the snapshot (requested after) drops it.
    expect(mergePendingSnapshot([], liveAdded, liveResolved, [q('gone')])).toEqual([]);
  });

  it('a local answer (half revision) outranks a snapshot requested before it', () => {
    let journal: GateJournalEntry[] = [];
    journal = journalGate(journal, { rev: 3.5, id: 'answered', op: 'resolved' });
    const { liveAdded, liveResolved } = gateChangesSince(journal, 3);
    expect(mergePendingSnapshot([q('answered')], liveAdded, liveResolved, [])).toEqual([]);
  });

  it('never duplicates an id the snapshot already has', () => {
    const merged = mergePendingSnapshot([q('a', 1)], new Set(['a']), new Set(), [q('a', 9)]);
    expect(merged).toEqual([q('a', 1)]);
  });

  it('the journal is bounded', () => {
    let journal: GateJournalEntry[] = [];
    for (let i = 0; i < GATE_JOURNAL_MAX + 10; i++) journal = journalGate(journal, { rev: i, id: `g${i}`, op: 'added' });
    expect(journal).toHaveLength(GATE_JOURNAL_MAX);
    expect(journal[journal.length - 1].id).toBe(`g${GATE_JOURNAL_MAX + 9}`);
  });
});
