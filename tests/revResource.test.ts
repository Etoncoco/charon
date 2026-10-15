import { describe, expect, it } from 'vitest';
import { createLatestGate, createRerunner, createRevResource } from '@/app/sync/revResource';

// Revision-guarded refetch (tabs, settings): one GET at a time, one rerun for
// any number of invalidations during a flight, and an answer older than the
// invalidation it was asked for is never applied.

const E = 5;
type Resp = { v: string; sync?: { epoch: number; rev: number } };

function deferredFetcher() {
  const calls: Array<{ resolve: (r: Resp) => void; reject: (e: unknown) => void }> = [];
  const fetch = () => new Promise<Resp>((resolve, reject) => { calls.push({ resolve, reject }); });
  return { calls, fetch };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('createRevResource', () => {
  it('an invalidation during the flight ⇒ exactly ONE rerun after it', async () => {
    const f = deferredFetcher();
    const applied: string[] = [];
    const res = createRevResource<Resp>({ fetch: f.fetch, apply: (r) => applied.push(r.v) });
    const p = res.refresh();
    expect(f.calls).toHaveLength(1);
    void res.invalidate({ epoch: E, rev: 10 });
    void res.invalidate({ epoch: E, rev: 11 });
    void res.invalidate({ epoch: E, rev: 12 });
    expect(f.calls).toHaveLength(1);                     // never two in flight
    f.calls[0].resolve({ v: 'first', sync: { epoch: E, rev: 9 } });
    await tick();
    expect(applied).toEqual([]);                          // older than rev 12: not applied
    expect(f.calls).toHaveLength(2);                      // the single rerun
    f.calls[1].resolve({ v: 'second', sync: { epoch: E, rev: 12 } });
    await p;
    expect(applied).toEqual(['second']);
    expect(f.calls).toHaveLength(2);
    expect(res.lastApplied).toEqual({ epoch: E, rev: 12 });
  });

  it('a stale answer is not applied and refetched (bounded); a fresh one is', async () => {
    const f = deferredFetcher();
    const applied: string[] = [];
    const res = createRevResource<Resp>({ fetch: f.fetch, apply: (r) => applied.push(r.v) });
    const p = res.invalidate({ epoch: E, rev: 20 });
    f.calls[0].resolve({ v: 'stale', sync: { epoch: E, rev: 19 } });
    await tick();
    expect(applied).toEqual([]);
    f.calls[1].resolve({ v: 'fresh', sync: { epoch: E, rev: 25 } });
    await p;
    expect(applied).toEqual(['fresh']);
    // An answer older than the last applied one never replaces it (G4).
    const p2 = res.refresh();
    f.calls[2].resolve({ v: 'older', sync: { epoch: E, rev: 21 } });
    await p2;
    expect(applied).toEqual(['fresh']);
  });

  it('stale retries are bounded (a hub that never catches up cannot loop)', async () => {
    let n = 0;
    const res = createRevResource<Resp>({
      fetch: async () => { n++; return { v: 'x', sync: { epoch: E, rev: 1 } }; },
      apply: () => { throw new Error('never'); },
    });
    await res.invalidate({ epoch: E, rev: 100 });
    expect(n).toBe(3);   // the request + STALE_REFETCH_MAX
  });

  it('an answer without sync (older hub) applies; a newer epoch beats any older rev', async () => {
    const applied: string[] = [];
    const res = createRevResource<Resp>({ fetch: async () => ({ v: 'old-hub' }), apply: (r) => applied.push(r.v) });
    await res.invalidate({ epoch: E, rev: 3 });
    expect(applied).toEqual(['old-hub']);
    const res2 = createRevResource<Resp>({
      fetch: async () => ({ v: 'restarted', sync: { epoch: E + 1, rev: 1 } }), apply: (r) => applied.push(r.v),
    });
    await res2.invalidate({ epoch: E, rev: 999 });
    expect(applied).toEqual(['old-hub', 'restarted']);
  });

  it('runs through the serializer (a refresh never lands inside a mutation)', async () => {
    const order: string[] = [];
    let tail: Promise<unknown> = Promise.resolve();
    const run = <T,>(fn: () => Promise<T>) => { const r = tail.then(fn, fn); tail = r.then(() => {}, () => {}); return r; };
    let releaseMutation!: () => void;
    void run(() => new Promise<void>((r) => { releaseMutation = () => { order.push('mutation'); r(); }; }));
    const res = createRevResource<Resp>({
      fetch: async () => { order.push('get'); return { v: 'x', sync: { epoch: E, rev: 1 } }; }, apply: () => {}, run,
    });
    const p = res.refresh();
    await tick();
    expect(order).toEqual([]);
    releaseMutation();
    await p;
    expect(order).toEqual(['mutation', 'get']);
  });
});

describe('createRerunner / createLatestGate', () => {
  it('N triggers during a run ⇒ one more run; an error does not stall it', async () => {
    let runs = 0;
    let release!: () => void;
    const r = createRerunner(async () => {
      runs++;
      if (runs === 1) await new Promise<void>((res) => { release = res; });
      if (runs === 2) throw new Error('boom');
    });
    const p = r.trigger();
    void r.trigger(); void r.trigger();
    release();
    await p;
    expect(runs).toBe(2);
    await r.trigger();
    expect(runs).toBe(3);
  });

  it('only the latest-started request is applied', () => {
    const g = createLatestGate();
    const a = g.next();
    const b = g.next();
    expect(g.isLatest(a)).toBe(false);
    expect(g.isLatest(b)).toBe(true);
  });
});
