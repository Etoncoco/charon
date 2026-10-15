import { describe, expect, it } from 'vitest';
import {
  initialSyncState, onFrame, onOpen, sinceParam, withInitialPosition, type SyncClientState,
} from '@/app/sync/syncClientState';

// The client's sync baseline (SPEC §3.3.1, binding): what lastRev becomes on
// each frame, what is dropped, what fires, and what the next connect asks for.

const E = 1_700_000_000_000;
type Feed = { type: string; id?: string; payload?: Record<string, unknown> };

function run(s: SyncClientState, frames: Feed[]) {
  const out: Array<ReturnType<typeof onFrame>> = [];
  for (const f of frames) {
    const r = onFrame(s, { type: f.type, lastEventId: f.id ?? '', payload: { type: f.type, ...(f.payload ?? {}) } });
    s = r.state;
    out.push(r);
  }
  return { s, out };
}

const resumeHello = (from: number, rev: number, extra: Record<string, unknown> = {}): Feed => ({
  type: 'sync_hello', payload: { proto: 2, mode: 'resume', epoch: E, rev, from, buildId: 'b1', ...extra },
});
const resyncHello = (rev: number, reason = 'gap', epoch = E): Feed => ({
  type: 'sync_hello', payload: { proto: 2, mode: 'resync', reason, epoch, rev, buildId: 'b1' },
});
const line = (rev: number, type = 'status', epoch = E): Feed => ({ type, id: `${epoch}.${rev}`, payload: { sessionId: 's1' } });

describe('syncClientState (§3.3.1)', () => {
  it('resume hello{from:100, rev:110} + lines 101..110 ⇒ all delivered; a cut after 105 ⇒ next since=E.105', () => {
    let s = withInitialPosition(initialSyncState(), { epoch: E, rev: 100, buildId: 'b1' });
    expect(sinceParam(s)).toBe(`${E}.100`);
    s = onOpen(s);
    const all = run(s, [resumeHello(100, 110), ...Array.from({ length: 10 }, (_, i) => line(101 + i))]);
    expect(all.out.slice(1).every((o) => o.deliver && o.catchUp)).toBe(true);
    expect(all.s.lastRev).toBe(110);
    // Cut after line 105 (no replay end): the reconnect resumes from it.
    const cut = run(onOpen(s), [resumeHello(100, 110), ...Array.from({ length: 5 }, (_, i) => line(101 + i))]);
    expect(cut.s.lastRev).toBe(105);
    expect(sinceParam(onOpen(cut.s))).toBe(`${E}.105`);
  });

  it('the hello never sets lastRev: resume keeps it, resync nulls it', () => {
    const s = withInitialPosition(initialSyncState(), { epoch: E, rev: 100 });
    const resume = run(onOpen(s), [resumeHello(100, 500)]);
    expect(resume.s.lastRev).toBe(100);
    expect(resume.s.phase).toBe('replay');
    const resync = run(onOpen(s), [resyncHello(500)]);
    expect(resync.s.lastRev).toBeNull();
    expect(resync.s.epoch).toBe(E);
    expect(resync.s.phase).toBe('snapshot');
  });

  it('a resync cut before sync_snapshot_end ⇒ the next connect has no since ⇒ resync', () => {
    const s = withInitialPosition(initialSyncState(), { epoch: E, rev: 10 });
    const r = run(onOpen(s), [
      resyncHello(50), { type: 'sync_summaries', payload: { sessions: [] } }, { type: 'sync_vps', payload: { vps: [] } },
    ]);
    expect(r.s.lastRev).toBeNull();
    expect(sinceParam(r.s)).toBeNull();
  });

  it('snapshot frames do not advance lastRev; sync_snapshot_end sets it and fires resync exactly once', () => {
    const r = run(onOpen(initialSyncState()), [
      resyncHello(50, 'first'),
      { type: 'sync_summaries', payload: { sessions: [] } },
      { type: 'sync_vps', payload: { vps: [] } },
      { type: 'sync_installs', payload: { running: [] } },
      { type: 'model_notices', payload: { notices: {} } },
      { type: 'sync_snapshot_end', id: `${E}.50`, payload: { rev: 50 } },
    ]);
    const fires = r.out.map((o) => o.fire).filter(Boolean);
    expect(fires).toEqual(['resync']);
    for (const o of r.out.slice(1, 5)) { expect(o.deliver).toBe(true); expect(o.rev).toBeNull(); }
    expect(r.out[5].rev).toEqual({ epoch: E, rev: 50 });
    expect(r.s.lastRev).toBe(50);
    expect(r.s.phase).toBe('live');
    // The snapshot frames are stamped with the hello's R.
    expect(run(onOpen(initialSyncState()), [resyncHello(50)]).s.snapshotStamp).toEqual({ epoch: E, rev: 50 });
  });

  it('the dup guard drops bus lines ≤ lastRev; control types are exempt; lastRev is monotonic', () => {
    const base = run(onOpen(initialSyncState()), [resyncHello(10), { type: 'sync_snapshot_end', id: `${E}.10`, payload: { rev: 10 } }]).s;
    const r = run(base, [line(9), line(10), line(11), line(11), line(13), line(12)]);
    expect(r.out.map((o) => o.deliver)).toEqual([false, false, true, false, true, false]);
    expect(r.s.lastRev).toBe(13);
    // model_notices from a snapshot (no id) is exempt.
    expect(onFrame(r.s, { type: 'model_notices', lastEventId: '', payload: {} }).deliver).toBe(true);
    // lastRev never goes down through a stale line or a lower replay end.
    let s = r.s;
    let max = s.lastRev ?? 0;
    for (const f of [line(5), { type: 'sync_replay_end', payload: { rev: 3 } }, line(20), line(19)] as Feed[]) {
      s = run(s, [f]).s;
      expect(s.lastRev ?? 0).toBeGreaterThanOrEqual(max);
      max = s.lastRev ?? 0;
    }
    expect(max).toBe(20);
  });

  it('sync_replay_end{rev} ⇒ lastRev = max(lastRev, rev) and ends the catch-up', () => {
    const s = withInitialPosition(initialSyncState(), { epoch: E, rev: 100 });
    const r = run(onOpen(s), [resumeHello(100, 120), line(101), { type: 'sync_replay_end', payload: { rev: 120 } }, line(121)]);
    expect(r.out[1].catchUp).toBe(true);
    expect(r.s.phase).toBe('live');
    expect(r.out[3].catchUp).toBe(false);
    expect(r.s.lastRev).toBe(121);
    const lower = run(onOpen(s), [resumeHello(100, 120), line(110), { type: 'sync_replay_end', payload: { rev: 105 } }]);
    expect(lower.s.lastRev).toBe(110);
  });

  it('a heartbeat on a live connection advances lastRev (its id proves delivery), is never delivered', () => {
    const live = run(onOpen(initialSyncState()), [resyncHello(10), { type: 'sync_snapshot_end', id: `${E}.10`, payload: { rev: 10 } }]).s;
    const hb = onFrame(live, { type: 'heartbeat', lastEventId: `${E}.42`, payload: { type: 'heartbeat', ts: 1 } });
    expect(hb.deliver).toBe(false);
    expect(hb.state.lastRev).toBe(42);
    // …but not mid-snapshot nor mid-replay.
    const snap = run(onOpen(initialSyncState()), [resyncHello(10)]).s;
    expect(onFrame(snap, { type: 'heartbeat', lastEventId: `${E}.42`, payload: {} }).state.lastRev).toBeNull();
  });

  it('rev-less frames (old hub, no hello on this connection) pass through with rev:null and touch nothing', () => {
    const s = onOpen(withInitialPosition(initialSyncState(), { epoch: E, rev: 7 }));
    const r = run(s, [{ type: 'status', payload: { sessionId: 'x' } }, { type: 'vps_status', id: '', payload: {} }]);
    expect(r.out.every((o) => o.deliver && o.rev === null && !o.catchUp)).toBe(true);
    expect(r.s.lastRev).toBe(7);
    // A live stream's id-less frame (a synthetic smoke event) also passes.
    const live = run(onOpen(initialSyncState()), [resyncHello(1), { type: 'sync_snapshot_end', id: `${E}.1`, payload: { rev: 1 } }]).s;
    const smoke = onFrame(live, { type: 'assistant_text', lastEventId: '', payload: {} });
    expect(smoke.deliver).toBe(true);
    expect(smoke.rev).toBeNull();
  });

  it('a build mismatch fires on the hello; a resume hello that is not our baseline asks for a reconnect', () => {
    const s = withInitialPosition(initialSyncState(), { epoch: E, rev: 100, buildId: 'old' });
    expect(onFrame(onOpen(s), { type: 'sync_hello', lastEventId: '', payload: { mode: 'resync', reason: 'first', epoch: E, rev: 1, buildId: 'new' } }).fire)
      .toBe('buildMismatch');
    expect(onFrame(onOpen(s), { type: 'sync_hello', lastEventId: '', payload: { mode: 'resync', reason: 'first', epoch: E, rev: 1, buildId: 'old' } }).fire)
      .toBeNull();
    const bad = onFrame(onOpen(s), { type: 'sync_hello', lastEventId: '', payload: { mode: 'resume', epoch: E + 1, rev: 5, from: 100, buildId: 'old' } });
    expect(bad.reconnect).toBe(true);
    expect(sinceParam(bad.state)).toBeNull();
  });

  it('the SSR stamp seeds the position once; a later stamp never overrides a live baseline', () => {
    const live = run(onOpen(initialSyncState()), [resyncHello(10), { type: 'sync_snapshot_end', id: `${E}.10`, payload: { rev: 10 } }]).s;
    expect(withInitialPosition(live, { epoch: E, rev: 3 }).lastRev).toBe(10);
  });
});
