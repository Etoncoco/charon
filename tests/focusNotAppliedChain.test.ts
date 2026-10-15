import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// W2 review (C10): "two consecutive ok:false ⇒ reconnect" counts answers of
// ONE focus chain (a POST and its own retry). Two parallel POSTs racing the
// initial SSE registration (the view's hook and the panel both focus at
// mount) are not a zombie conn and must not tear the fresh EventSource down.

let created = 0;
let closed = 0;
class FakeEventSource {
  readyState = 0;
  onmessage: unknown = null; onopen: unknown = null; onerror: unknown = null;
  constructor(public url: string) { created++; }
  close() { closed++; this.readyState = 2; }
  addEventListener() {}
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  created = 0; closed = 0;
  const noop = () => {};
  vi.stubGlobal('window', { addEventListener: noop, removeEventListener: noop, location: { reload: noop } });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: noop, removeEventListener: noop });
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ ok: false }) })));
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('focus POST ok:false counting', () => {
  it('two parallel chains answering ok:false once each do not reconnect; a chain failing twice does', async () => {
    const { setFocus } = await import('@/app/globalEventStream');
    await Promise.all([setFocus('s1'), setFocus('s1')]);
    expect(created).toBe(1);
    expect(closed).toBe(0);
    // Each chain's retry fails too: that one IS a zombie conn ⇒ ONE reconnect.
    await vi.advanceTimersByTimeAsync(700);
    expect(closed).toBe(1);
    expect(created).toBe(2);
  });
});
