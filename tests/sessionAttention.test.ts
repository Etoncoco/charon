import { describe, it, expect } from 'vitest';
import {
  attentionForRow, deriveAttention, isWaitingAttention, pendingSplit, rowStatus, NON_LIVE_STATUSES,
} from '@/lib/sessionAttention';
import { deriveAttention as reexported } from '@/lib/sessionSummary';
import { isWorkingStatus } from '@/app/sessionUnread';
import { createAttentionTracker, ATTENTION_WINDOW_MS, ATTENTION_POST_INTERVAL_MS } from '@/app/attention';
import { applyPendingSnapshot, pruneExpired, FEED_EXPIRY_SLACK_S } from '@/app/useCrossSessionInteractionFeed';

// THE cross-session attention predicate (lib/sessionAttention.ts): one reading
// for the sidebar card, the header nav (+ favicon), the tab bar, the filter
// chip and the desk. The scenarios are R5 §5.1's matrix A–K.

type Row = Parameters<typeof attentionForRow>[0];
const row = (o: Partial<Row> & { status?: string } = {}): Row => ({
  status: 'active', liveStatus: undefined, unreadStop: 0,
  pendingPermissions: 0, pendingBlocking: 0, pendingAsync: 0, ...o,
});

// The surface rules, written exactly as the components apply them.
const sidebarWord = (r: Row, selected = false) => {
  const a = attentionForRow(r, { viewedHere: selected });
  return a === 'blocked' ? 'needs you' : a === 'question' ? 'question' : rowStatus(r);
};
const headerRunning = (r: Row) => isWorkingStatus(rowStatus(r)) || attentionForRow(r, { viewedHere: false }) === 'blocked';
const headerWaiting = (r: Row) => isWaitingAttention(attentionForRow(r, { viewedHere: false }));
const chipCounts = (r: Row) => isWaitingAttention(attentionForRow(r, { viewedHere: false }));

describe('deriveAttention', () => {
  it('is the module lib/sessionSummary re-exports', () => {
    expect(reexported).toBe(deriveAttention);
  });

  it('orders blocked > question > unread > null', () => {
    const base = { status: 'active', unreadStop: 1, pendingBlocking: 1, pendingAsync: 1 };
    expect(deriveAttention(base)).toBe('blocked');
    expect(deriveAttention({ ...base, pendingBlocking: 0 })).toBe('question');
    expect(deriveAttention({ ...base, pendingBlocking: 0, pendingAsync: 0 })).toBe('unread');
    expect(deriveAttention({ ...base, pendingBlocking: 0, pendingAsync: 0, unreadStop: 0 })).toBe(null);
  });

  it('blocked on every live status, never on a non-live one', () => {
    for (const status of ['active', 'thinking', 'starting', 'background', 'failed']) {
      expect(deriveAttention({ status, unreadStop: 0, pendingBlocking: 1, pendingAsync: 0 })).toBe('blocked');
    }
    for (const status of NON_LIVE_STATUSES) {
      expect(deriveAttention({ status, unreadStop: 0, pendingBlocking: 1, pendingAsync: 0 })).toBe(null);
    }
  });

  it('question on any status', () => {
    for (const status of ['active', 'thinking', 'sleeping', 'error', 'failed']) {
      expect(deriveAttention({ status, unreadStop: 0, pendingBlocking: 0, pendingAsync: 2 })).toBe('question');
    }
  });

  it('unread only on a ready (active) session', () => {
    for (const status of ['thinking', 'starting', 'background', 'sleeping', 'error', 'failed']) {
      expect(deriveAttention({ status, unreadStop: true, pendingBlocking: 0, pendingAsync: 0 })).toBe(null);
    }
    expect(deriveAttention({ status: 'active', unreadStop: true, pendingBlocking: 0, pendingAsync: 0 })).toBe('unread');
  });
});

describe('row helpers', () => {
  it('rowStatus prefers the live status', () => {
    expect(rowStatus({ liveStatus: 'thinking', status: 'active' })).toBe('thinking');
    expect(rowStatus({ liveStatus: undefined, status: 'sleeping' })).toBe('sleeping');
    expect(rowStatus({ liveStatus: null, status: 'active' })).toBe('active');
  });

  it('an older hub (pendingPermissions only) reads as blocking', () => {
    expect(pendingSplit({ pendingPermissions: 3 })).toEqual({ pendingBlocking: 3, pendingAsync: 0 });
    expect(pendingSplit({ pendingPermissions: 3, pendingBlocking: 1, pendingAsync: 2 }))
      .toEqual({ pendingBlocking: 1, pendingAsync: 2 });
    expect(attentionForRow({ status: 'thinking', pendingPermissions: 1 }, { viewedHere: false })).toBe('blocked');
  });
});

describe('R5 §5.1 scenario matrix', () => {
  it('A: blocking gate mid-turn (thinking) ⇒ "needs you" everywhere, still running', () => {
    const r = row({ liveStatus: 'thinking', pendingPermissions: 1, pendingBlocking: 1 });
    expect(attentionForRow(r, { viewedHere: false })).toBe('blocked');
    expect(sidebarWord(r)).toBe('needs you');
    expect(headerWaiting(r)).toBe(true);
    expect(headerRunning(r)).toBe(true);
  });

  it('B: async question on an idle session ⇒ question, not working', () => {
    const r = row({ liveStatus: 'active', pendingPermissions: 1, pendingAsync: 1 });
    expect(attentionForRow(r, { viewedHere: false })).toBe('question');
    expect(sidebarWord(r)).toBe('question');
    expect(headerWaiting(r)).toBe(true);
    expect(headerRunning(r)).toBe(false);
  });

  it('C: async question on a paused session ⇒ question, NOT counted as working', () => {
    const r = row({ status: 'sleeping', liveStatus: 'sleeping', pendingPermissions: 1, pendingAsync: 1 });
    expect(attentionForRow(r, { viewedHere: false })).toBe('question');
    expect(headerWaiting(r)).toBe(true);
    expect(headerRunning(r)).toBe(false);
  });

  it('D: finished unread, not selected ⇒ unread; the viewed row hides it', () => {
    const r = row({ liveStatus: 'active', unreadStop: 1 });
    expect(attentionForRow(r, { viewedHere: false })).toBe('unread');
    expect(attentionForRow(r, { viewedHere: true })).toBe(null);
  });

  it('E: an SSR/older row without liveStatus reads its DB status', () => {
    const r = row({ status: 'active', liveStatus: undefined, unreadStop: 1 });
    expect(attentionForRow(r, { viewedHere: false })).toBe('unread');
    const t = row({ status: 'thinking', liveStatus: undefined });
    expect(headerRunning(t)).toBe(true);
  });

  it('F: a ghost gate leaves the feed on the next pending_snapshot', () => {
    const q = {
      perms: [{ id: 'p1', sessionId: 's', tool: 't', input: {}, createdAt: 0 },
        { id: 'p2', sessionId: 's', tool: 't', input: {}, createdAt: 0 }],
      questions: [{ id: 'q1', sessionId: 's', createdAt: 0, questions: [], delivery: 'async' as const }],
      exitPlans: [{ id: 'e1', sessionId: 's', createdAt: 0, plan: '' }],
    };
    const next = applyPendingSnapshot(q, { permissions: [{ id: 'p2' }], questions: [{ id: 'q1' }], exitPlans: [] });
    expect(next.perms.map((p) => p.id)).toEqual(['p2']);
    expect(next.questions).toBe(q.questions);            // unchanged ⇒ same array (no re-render)
    expect(next.exitPlans).toEqual([]);
  });

  it('F: an expired gate is pruned after the slack', () => {
    const gates = [{ id: 'a', expiresAt: 100 }, { id: 'b' }, { id: 'c', expiresAt: 1000 }];
    expect(pruneExpired(gates, 100 + FEED_EXPIRY_SLACK_S)).toBe(gates);
    expect(pruneExpired(gates, 100 + FEED_EXPIRY_SLACK_S + 1).map((g) => g.id)).toEqual(['b', 'c']);
  });

  it('G: a blocking gate on a stopped session is not "needs you"', () => {
    for (const status of ['sleeping', 'error']) {
      const r = row({ status, liveStatus: status, pendingPermissions: 1, pendingBlocking: 1 });
      expect(attentionForRow(r, { viewedHere: false })).toBe(null);
      expect(sidebarWord(r)).toBe(status);
      expect(headerWaiting(r)).toBe(false);
    }
  });

  it('I: an idle device is not an attended view', () => {
    let now = 1_000_000;
    let visible = true;
    const posts: number[] = [];
    const t = createAttentionTracker({
      now: () => now, isVisible: () => visible, hasFocus: () => true, post: () => posts.push(now),
    });
    expect(t.isAttentive()).toBe(true);                  // the page load is input
    now += ATTENTION_WINDOW_MS + 1;
    expect(t.isAttentive()).toBe(false);                 // left open, nobody there
    t.noteInput();                                       // idle → active: proof at once
    expect(t.isAttentive()).toBe(true);
    expect(posts).toEqual([now]);
    now += 1_000; t.noteInput();                         // throttled
    expect(posts.length).toBe(1);
    now += ATTENTION_POST_INTERVAL_MS; t.noteInput();    // ≤ 1 per 30 s while focused
    expect(posts.length).toBe(2);
    visible = false;
    expect(t.isAttentive()).toBe(false);                 // hidden is never attended
    now += 1; t.noteInput();
    expect(posts.length).toBe(2);
    visible = true; t.noteVisible();                     // the focus re-POST is the proof
    expect(t.isAttentive()).toBe(true);
    expect(posts.length).toBe(2);
  });

  it('I: no periodic proof without a focused session', () => {
    let now = 0;
    const posts: number[] = [];
    const t = createAttentionTracker({
      now: () => now, isVisible: () => true, hasFocus: () => false, post: () => posts.push(now),
    });
    for (let i = 0; i < 5; i++) { now += ATTENTION_POST_INTERVAL_MS; t.noteInput(); }
    expect(posts).toEqual([]);
  });

  it('J: the selected session finishing while the tab is hidden still counts (viewedHere needs visible)', () => {
    const r = row({ liveStatus: 'active', unreadStop: 1 });
    const selected = true; const visible = false;
    expect(attentionForRow(r, { viewedHere: selected && visible })).toBe('unread');
  });

  it('K: a session that just finished turns unread with the stop (status active + marker)', () => {
    const thinking = row({ liveStatus: 'thinking', unreadStop: 1 });
    expect(attentionForRow(thinking, { viewedHere: false })).toBe(null);
    expect(attentionForRow({ ...thinking, liveStatus: 'active' }, { viewedHere: false })).toBe('unread');
  });
});

describe('the sidebar filter chip predicate', () => {
  it('counts a hidden paused session holding only an async question', () => {
    expect(chipCounts(row({ status: 'sleeping', liveStatus: 'sleeping', pendingPermissions: 1, pendingAsync: 1 }))).toBe(true);
  });

  it('does not count an unread one', () => {
    expect(chipCounts(row({ liveStatus: 'active', unreadStop: 1 }))).toBe(false);
  });

  it('counts a blocked one, not a dead gate on a stopped session', () => {
    expect(chipCounts(row({ liveStatus: 'thinking', pendingPermissions: 1, pendingBlocking: 1 }))).toBe(true);
    expect(chipCounts(row({ status: 'error', liveStatus: 'error', pendingPermissions: 1, pendingBlocking: 1 }))).toBe(false);
  });
});
