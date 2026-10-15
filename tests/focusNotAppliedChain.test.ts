import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeEventSource, installFakeBrowser, lastEs } from './helpers/fakeSse';

// W2 review (C10): "two consecutive ok:false ⇒ reconnect" counts answers of
// ONE focus chain (a POST and its own retry). Two parallel POSTs racing the
// initial SSE registration (the view's hook and the panel both focus at
// mount) are not a zombie conn and must not tear the fresh EventSource down.
// W4 review: only an OPEN stream that had its hello is a zombie; a stream
// still CONNECTING is simply not registered yet (the hello timeout and the
// stale watchdog own it).

const E = 1_700_000_000_000;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  installFakeBrowser({ fetch: () => ({ ok: false }) });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const closedCount = () => FakeEventSource.all.filter((e) => e.closed).length;

describe('focus POST ok:false counting', () => {
  it('two parallel chains answering ok:false once each do not reconnect; a chain failing twice on an OPEN stream does', async () => {
    const { setFocus } = await import('@/app/globalEventStream');
    const p = Promise.all([setFocus('s1'), setFocus('s1')]);
    const es = lastEs();
    es.open();
    es.send({ type: 'sync_hello', proto: 2, mode: 'resync', reason: 'first', epoch: E, rev: 1, buildId: 'b1' });
    await p;
    expect(FakeEventSource.all).toHaveLength(1);
    expect(closedCount()).toBe(0);
    // Each chain's retry fails too: that one IS a zombie conn ⇒ ONE reconnect.
    await vi.advanceTimersByTimeAsync(700);
    expect(closedCount()).toBe(1);
    expect(FakeEventSource.all).toHaveLength(2);
  });

  it('a stream still CONNECTING is never torn down by ok:false answers', async () => {
    const { setFocus } = await import('@/app/globalEventStream');
    await setFocus('s1');
    expect(lastEs().readyState).toBe(0);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(FakeEventSource.all).toHaveLength(1);
    expect(closedCount()).toBe(0);
  });
});
