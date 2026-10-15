import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@/lib/sessionSummary';
import { installFakeBrowser, lastEs } from './helpers/fakeSse';

// THE client summary store (app/sync/summaryStore.ts, §14.108): rule I5 per
// id, complete snapshots prune what they do not list (≤ their rev), overlays
// held until the action's revision reached this tab, and a module-level feed
// from the transport that exists as soon as the module is imported.

const E = 1_700_000_000_000;
const rev = (r: number, epoch = E) => ({ epoch, rev: r });
const sum = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id, vpsId: 'v', name: id, cwd: '/p', kind: 'claude', status: 'active', createdAt: 1,
  liveStatus: 'active', runningBgTasks: 0, lastActivityMs: null, addressable: true,
  pendingBlocking: 0, pendingAsync: 0, gates: [], attention: null, ...extra,
} as unknown as SessionSummary);

type Store = typeof import('@/app/sync/summaryStore');
type Transport = typeof import('@/app/globalEventStream');
let store: Store;
let gse: Transport;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  installFakeBrowser();
  // A BARE import of the store: its feed must be live on its own.
  store = await import('@/app/sync/summaryStore');
  gse = await import('@/app/globalEventStream');
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Open the transport and walk it to a live baseline at `r` (a resync). */
function goLive(r: number, sessions: SessionSummary[] = []) {
  gse.subscribeAll(() => {});
  const es = lastEs();
  es.open();
  es.send({ type: 'sync_hello', proto: 2, mode: 'resync', reason: 'first', epoch: E, rev: r, buildId: 'b' });
  es.send({ type: 'sync_summaries', sessions });
  es.send({ type: 'sync_snapshot_end', rev: r }, `${E}.${r}`);
  return es;
}

describe('summaryStore', () => {
  it('an older revision is ignored, a newer one applies; arrival order never matters', () => {
    store.applySummaryFrame('a', sum('a', { name: 'v5' }), rev(5));
    store.applySummaryFrame('a', sum('a', { name: 'v3' }), rev(3));
    expect(store.getSummary('a')?.name).toBe('v5');
    store.applySummaryFrame('a', sum('a', { name: 'v5-again' }), rev(5));
    expect(store.getSummary('a')?.name).toBe('v5');
    store.seedSummaries([sum('a', { name: 'snap4' })], rev(4), true);
    expect(store.getSummary('a')?.name).toBe('v5');           // the snapshot is older than the held frame
    store.seedSummaries([sum('a', { name: 'snap5' })], rev(5), true);
    expect(store.getSummary('a')?.name).toBe('snap5');        // equal: a snapshot at R reflects frame R
    // A new hub process (later epoch) wins over any rev of the old one.
    store.applySummaryFrame('a', sum('a', { name: 'next-epoch' }), rev(1, E + 1));
    expect(store.getSummary('a')?.name).toBe('next-epoch');
    // A null frame removes; a late older frame cannot resurrect it.
    store.applySummaryFrame('a', null, rev(2, E + 1));
    store.applySummaryFrame('a', sum('a'), rev(1, E + 1));
    expect(store.getSummary('a')).toBeUndefined();
  });

  it('a complete snapshot prunes ids it does not list whose held rev ≤ its rev, keeps newer ones', () => {
    store.applySummaryFrame('old', sum('old'), rev(10));
    store.applySummaryFrame('new', sum('new'), rev(30));
    store.seedSummaries([sum('listed')], rev(20), true);
    expect(store.getSummary('old')).toBeUndefined();
    expect(store.getSummary('new')).toBeDefined();
    expect(store.getSummary('listed')).toBeDefined();
    // A NON-complete seed never removes.
    store.seedSummaries([], rev(40), false);
    expect(store.getSummary('new')).toBeDefined();
    // Order: createdAt desc, id desc; stable identity until something changes.
    store.seedSummaries([sum('x', { createdAt: 5 }), sum('b', { createdAt: 9 }), sum('c', { createdAt: 5 })], rev(50), true);
    const list = store.getSessionList();
    expect(list.map((s) => s.id)).toEqual(['b', 'x', 'c']);
    expect(store.getSessionList()).toBe(list);
    store.seedSummaries([sum('x', { createdAt: 5 }), sum('b', { createdAt: 9 }), sum('c', { createdAt: 5 })], rev(51), true);
    expect(store.getSessionList()).toBe(list);                 // same content ⇒ no new array
  });

  it('a rev-less input (older hub) applies unconditionally', () => {
    store.applySummaryFrame('a', sum('a', { name: 'v9' }), rev(9));
    store.applySummaryFrame('a', sum('a', { name: 'legacy' }), null);
    expect(store.getSummary('a')?.name).toBe('legacy');
    store.seedSummaries([], null, true);
    expect(store.getSummary('a')).toBeUndefined();
  });

  it('an overlay holds until the POST settled AND lastRev ≥ its ack, then clears', () => {
    goLive(10, [sum('a', { name: 'before' })]);
    const o = store.addOverlay('a', { name: 'renamed' });
    expect(store.getSummary('a')?.name).toBe('renamed');
    lastEs().send({ type: 'heartbeat', ts: 1 }, `${E}.12`);  // lastRev 12, POST not answered yet
    expect(store.getSummary('a')?.name).toBe('renamed');
    o.ack(rev(15));
    expect(store.getSummary('a')?.name).toBe('renamed');      // lastRev 12 < 15
    lastEs().send({ type: 'status', sessionId: 'z', status: 'active' }, `${E}.14`);
    expect(store.getSummary('a')?.name).toBe('renamed');
    // The summary frame carrying the rename, then lastRev reaches the ack.
    lastEs().send({ type: 'session_summary', sessionId: 'a', summary: sum('a', { name: 'renamed' }) }, `${E}.15`);
    expect(store.overlayCount()).toBe(0);
    expect(store.getSummary('a')?.name).toBe('renamed');
  });

  it('a failed action reverts its overlay; the 30 s cap clears a forgotten one', () => {
    goLive(10, [sum('a', { name: 'before' })]);
    const o = store.addOverlay('a', { removed: true });
    expect(store.getSessionList().map((s) => s.id)).toEqual([]);
    o.fail();
    expect(store.getSessionList().map((s) => s.id)).toEqual(['a']);
    store.addOverlay('a', { name: 'never-acked' });
    expect(store.getSummary('a')?.name).toBe('never-acked');
    vi.advanceTimersByTime(store.OVERLAY_CAP_MS + 1);
    expect(store.getSummary('a')?.name).toBe('before');
  });

  it('a filtered or includeArchived list answer never seeds; the default one does (complete)', () => {
    store.seedSummaries([sum('a')], rev(10), true);
    const r = { sessions: [sum('z')], sync: rev(20) };
    expect(store.seedFromListResponse(r, { vpsId: 'v' })).toBe(false);
    expect(store.seedFromListResponse(r, { status: 'active' })).toBe(false);
    expect(store.seedFromListResponse({ ...r, sessions: [sum('z'), sum('arch', { archived: 1 } as never)] }, { includeArchived: true })).toBe(false);
    expect(store.getSessionList().map((s) => s.id)).toEqual(['a']);
    expect(store.seedFromListResponse(r)).toBe(true);
    expect(store.getSessionList().map((s) => s.id)).toEqual(['z']);
  });

  it('the module-level feed is active after a bare import (no page wiring)', () => {
    gse.subscribeAll(() => {});
    const es = lastEs();
    es.open();
    es.send({ type: 'sync_hello', proto: 2, mode: 'resync', reason: 'first', epoch: E, rev: 3, buildId: 'b' });
    es.send({ type: 'sync_summaries', sessions: [sum('fromSnapshot')] });
    es.send({ type: 'sync_vps', vps: [{ id: 'v1', agentStatus: 'ok' }] });
    es.send({ type: 'sync_snapshot_end', rev: 3 }, `${E}.3`);
    expect(store.getSummary('fromSnapshot')).toBeDefined();
    expect(store.getVpsRuntime().get('v1')?.agentStatus).toBe('ok');
    es.send({ type: 'session_summary', sessionId: 'live', summary: sum('live') }, `${E}.4`);
    expect(store.getSummary('live')).toBeDefined();
    es.send({ type: 'session_summary', sessionId: 'live', summary: null }, `${E}.5`);
    expect(store.getSummary('live')).toBeUndefined();
  });

  it('VPS runtime: per-key revision order, frames carry only their keys (no-clobber)', () => {
    store.applyVpsFrame('v1', { agentStatus: 'ok', claudeLoggedIn: 1 } as never, rev(10));
    store.seedVpsRuntime([{ id: 'v1', agentStatus: 'error', claudeLoggedIn: 0, agentVersion: '0.1' } as never], rev(8));
    const v = store.getVpsRuntime().get('v1') as Record<string, unknown>;
    expect(v.agentStatus).toBe('ok');            // the older list GET does not revert the sign-in (R3 F3)
    expect(v.claudeLoggedIn).toBe(1);
    expect(v.agentVersion).toBe('0.1');          // a key the frame did not carry is taken
    store.applyVpsFrame('v1', { agentStatus: 'missing' } as never, rev(11));
    expect((store.getVpsRuntime().get('v1') as Record<string, unknown>).claudeLoggedIn).toBe(1);
  });
});
