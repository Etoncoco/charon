import { describe, expect, it } from 'vitest';
import { OverlayBox, OVERLAY_CAP_MS, reconcileOptimisticBubbles } from '@/app/sync/optimistic';
import {
  applyFrame, applyLocalSend, applyLocalSendAck, applyLocalSendFailed, applySnapshot, createTranscriptState, type SessionFrame,
  type TranscriptState,
} from '@/app/sync/transcriptReducer';
import type { SessionWindowResponse } from '@/lib/types/api';
import type { SyncRev } from '@/lib/sync/rev';

const E = 1_700_000_000_000;
const R = (rev: number): SyncRev => ({ epoch: E, rev });

function box<V>() {
  let now = 1_000;
  let last: SyncRev | null = R(10);
  const b = new OverlayBox<V>({ lastRev: () => last, now: () => now });
  return { b, setNow: (n: number) => { now = n; }, setLast: (r: SyncRev | null) => { last = r; } };
}

describe('OverlayBox', () => {
  it('shownToken identifies the shown overlay: a re-set within the same tick changes it, none is 0', () => {
    const { b } = box<string>();
    expect(b.shownToken).toBe(0);
    const h1 = b.set('sleeping');
    const t1 = b.shownToken;
    expect(t1).toBeGreaterThan(0);
    h1.fail();
    b.set('starting');                            // same count (1), different overlay
    expect(b.shownToken).not.toBe(t1);
    expect(b.shownToken).toBeGreaterThan(0);
  });

  it('shows the overlay while the POST is pending, then until lastRev ≥ ack — exactly', () => {
    const { b, setLast } = box<string>();
    const h = b.set('thinking');
    expect(b.value('active')).toBe('thinking');
    setLast(R(50));
    expect(b.value('active')).toBe('thinking');   // still pending: whatever the stream says
    h.ack(R(60));
    expect(b.value('active')).toBe('thinking');   // 50 < 60
    setLast(R(59));
    expect(b.value('active')).toBe('thinking');
    setLast(R(60));
    expect(b.value('active')).toBe('active');      // cleared exactly at lastRev ≥ ack
    expect(b.active).toBe(false);
    setLast(R(10));
    expect(b.value('active')).toBe('active');      // once cleared, gone
  });

  it('a POST failure reverts at once', () => {
    const { b } = box<string>();
    const h = b.set('sleeping');
    h.fail();
    expect(b.value('active')).toBe('active');
  });

  it('an ack without `sync` (older hub) clears at once', () => {
    const { b } = box<string>();
    b.set('starting').ack(null);
    expect(b.value('sleeping')).toBe('sleeping');
  });

  it('30 s cap', () => {
    const { b, setNow, setLast } = box<string>();
    b.set('thinking').ack(R(99));
    setLast(R(1));
    setNow(1_000 + OVERLAY_CAP_MS - 1);
    expect(b.value('active')).toBe('thinking');
    setNow(1_000 + OVERLAY_CAP_MS);
    expect(b.value('active')).toBe('active');
    const pending = box<string>();
    pending.b.set('x');                            // a POST that never settles
    pending.setNow(1_000 + OVERLAY_CAP_MS);
    expect(pending.b.value('base')).toBe('base');
  });

  it('a newer set supersedes; the older handle does nothing', () => {
    const { b } = box<string>();
    const first = b.set('sleeping');
    b.set('starting');
    first.fail();
    expect(b.value('active')).toBe('starting');
    first.ack(null);
    expect(b.value('active')).toBe('starting');
  });
});

// ─── clientMessageId reconciliation, both arrival orders ───────────────────
function win(rev: number, rows: Array<{ id: number; role: string; content: string }>): SessionWindowResponse {
  return {
    session: { id: 's1', kind: 'claude', status: 'active', vpsId: 'v1', permissionMode: 'normal' } as never,
    liveStatus: 'active', subscribers: 1, hasMore: false, oldestChatId: null,
    messages: rows.map((r) => ({ ...r, createdAt: 100, tsMs: 100_000 + r.id })) as never,
    maxMessageId: rows.reduce((a, r) => Math.max(a, r.id), 0),
    streamingText: '', pendingPermissions: [], pendingQuestions: [], pendingExitPlans: [],
    features: ['assistant_flushed'], sync: R(rev), focus: { applied: true, focused: true, focusSeq: 1 },
  } as SessionWindowResponse;
}
const ctx = (rev: number | null) => ({ fromJournal: false, rev: rev == null ? null : R(rev), nowMs: E,
  view: 'full' as const, provider: 'claude' as const, hubBoundaries: true });
const snap = (s: TranscriptState, r: SessionWindowResponse) => applySnapshot(s, r, { ...ctx(null), mode: 'tail' });
const ids = (s: TranscriptState) => s.messages.map((m) => m.id);
const echo = (rowId: number): SessionFrame =>
  ({ type: 'user_echo', content: 'hello', createdAt: 100, rowId, clientMessageId: 'cm-1' }) as SessionFrame;

describe('optimistic user bubbles keyed by clientMessageId', () => {
  const base = () => applyLocalSend(snap(createTranscriptState('s1', 'claude'), win(10, [])), 'cm-1', 'hello', E);

  it('echo first, then the POST answer ⇒ ONE m<rowId>', () => {
    let s = base();
    expect(ids(s)).toEqual(['u-cm-1']);
    s = applyFrame(s, echo(42), ctx(11)).state;
    expect(ids(s)).toEqual(['m42']);
    s = applyLocalSendAck(s, 'cm-1', 42);
    expect(ids(s)).toEqual(['m42']);
    expect(s.knownRowIds.has(42)).toBe(true);
  });

  it('POST answer first, then the echo ⇒ ONE m<rowId>', () => {
    let s = applyLocalSendAck(base(), 'cm-1', 42);
    expect(ids(s)).toEqual(['m42']);
    s = applyFrame(s, echo(42), ctx(11)).state;
    expect(ids(s)).toEqual(['m42']);
    expect(s.sends.size).toBe(0);
  });

  it('an echo ≤ the snapshot rev still records the mapping: the bubble becomes the snapshot row', () => {
    let s = base();
    // The window read after the row was written (R = 20) lands first …
    s = snap(s, win(20, [{ id: 42, role: 'user', content: 'hello' }]));
    // … unmaterialised as far as the sends know: the bubble is re-appended.
    expect(ids(s)).toEqual(['m42', 'u-cm-1']);
    // The echo (rev 15 ≤ 20) is dropped as a frame, but names the row.
    s = applyFrame(s, echo(42), ctx(15)).state;
    expect(ids(s)).toEqual(['m42']);
    expect(s.sends.size).toBe(0);
  });

  it('a snapshot without the row re-appends the bubble; one with it drops the entry', () => {
    let s = applyLocalSendAck(base(), 'cm-1', 42);
    s = snap(s, win(12, []));                    // read before the insert
    expect(ids(s)).toEqual(['m42']);              // the known row id keeps its name
    expect(s.sends.size).toBe(1);
    s = snap(s, win(30, [{ id: 42, role: 'user', content: 'hello' }]));
    expect(ids(s)).toEqual(['m42']);
    expect(s.sends.size).toBe(0);
  });

  it('POST failed, never persisted ⇒ gone after the next snapshot (never re-appended below later turns)', () => {
    let s = applyLocalSendFailed(base(), 'cm-1');
    expect(ids(s)).toEqual(['u-cm-1']);           // kept until a snapshot decides
    s = snap(s, win(20, [{ id: 2, role: 'user', content: 'retry' }, { id: 3, role: 'assistant', content: 'reply' }]));
    expect(ids(s)).toEqual(['m2', 'm3']);
    expect(s.sends.size).toBe(0);
    s = snap(s, win(40, [{ id: 2, role: 'user', content: 'retry' }, { id: 3, role: 'assistant', content: 'reply' },
      { id: 4, role: 'user', content: 'more' }]));
    expect(ids(s)).toEqual(['m2', 'm3', 'm4']);
  });

  it('POST failed AFTER the row was persisted ⇒ the echo or the snapshot still shows it once', () => {
    // The echo first: renamed in place, the failure mark is moot.
    let s = applyFrame(applyLocalSendFailed(base(), 'cm-1'), echo(42), ctx(11)).state;
    expect(ids(s)).toEqual(['m42']);
    // No echo: the snapshot holds the row, the bubble goes.
    s = applyLocalSendFailed(base(), 'cm-1');
    s = snap(s, win(20, [{ id: 42, role: 'user', content: 'hello' }]));
    expect(ids(s)).toEqual(['m42']);
    // A late echo after the drop shows the row (no duplicate).
    s = applyFrame(s, echo(42), ctx(21)).state;
    expect(ids(s)).toEqual(['m42']);
  });

  it('a failure after the POST named its row changes nothing', () => {
    const acked = applyLocalSendAck(base(), 'cm-1', 42);
    expect(applyLocalSendFailed(acked, 'cm-1')).toBe(acked);
  });

  it('reconcileOptimisticBubbles is a no-op without sends', () => {
    const msgs = [{ id: 'm1', role: 'user', content: 'x', createdAt: 1 }];
    const out = reconcileOptimisticBubbles(msgs, new Map(), new Set([1]));
    expect(out.messages).toBe(msgs);
  });
});
