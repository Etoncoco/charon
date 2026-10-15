import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { AgentClient } from '@/lib/server/agent/AgentClient';
import type { Vps } from '@/lib/db/schema';

// A subscribe fired while CONNECTED must remember its durable cursor: the
// reconnect re-subscribe otherwise fell back to `replay:300`, a ring tail big
// enough to overflow the agent's send queue on every reconnect.
describe('subscribe cursor across reconnects', () => {
  it('re-subscribes with the explicit after_seq, not a ring replay', () => {
    const client = new AgentClient({ id: 'v1', name: 'test' } as Vps, new Promise<void>(() => {}));
    const sent: Record<string, unknown>[] = [];
    (client as any).call = (method: string, params: Record<string, unknown>) => {
      if (method === 'subscribe') sent.push(params);
      return Promise.resolve({ ok: true });
    };
    client.status = 'connected';
    client.subscribe('s1', () => {}, { afterSeq: 1304 });
    // What _onConnected does for every subscribed session.
    (client as any)._fireSubscribe('s1');
    expect(sent).toEqual([
      { session_id: 's1', after_seq: 1304 },
      { session_id: 's1', after_seq: 1304 },
    ]);
  });

  // A cursor-less resubscribe while DISCONNECTED (resumeSession during an SSH
  // drop) used to store null, and the reconnect fell back to `replay: 300` —
  // a ring tail that can start below last_seen_seq (§14.31).
  it('a cursor-less resubscribe while disconnected keeps the known cursor', () => {
    const client = new AgentClient({ id: 'v1', name: 'test' } as Vps, new Promise<void>(() => {}));
    const sent: Record<string, unknown>[] = [];
    (client as any).call = (method: string, params: Record<string, unknown>) => {
      if (method === 'subscribe') sent.push(params);
      return Promise.resolve({ ok: true });
    };
    client.status = 'connected';
    client.subscribe('s1', () => {}, { afterSeq: 1304 });
    client.setAfterSeq('s1', 1310);
    client.status = 'reconnecting';
    client.resubscribe('s1');
    // An explicit cursor still wins.
    client.subscribe('s2', () => {});
    client.resubscribe('s2', { afterSeq: 7 });
    client.status = 'connected';
    (client as any)._fireSubscribe('s1');
    (client as any)._fireSubscribe('s2');
    expect(sent).toEqual([
      { session_id: 's1', after_seq: 1304 },
      { session_id: 's1', after_seq: 1310 },
      { session_id: 's2', after_seq: 7 },
    ]);
  });

  // The agent queues each replay burst whole in one send queue (10 000 events
  // / 32 MiB); several sessions re-subscribed back to back added up past it
  // and the connection dropped before a line was written, on every reconnect.
  it('re-subscribes every session after a (re)connect ONE AT A TIME, each after the previous answer', async () => {
    const client = new AgentClient({ id: 'v1', name: 'test' } as Vps, new Promise<void>(() => {}));
    const sent: string[] = [];
    const answers: Array<() => void> = [];
    (client as any).call = (method: string, params: Record<string, unknown>) => {
      if (method !== 'subscribe') return Promise.resolve({});
      sent.push(String(params.session_id));
      return new Promise((resolve) => answers.push(() => resolve({ ok: true, replay_count: 1 })));
    };
    for (const sid of ['s1', 's2', 's3']) client.subscribe(sid, () => {}, { afterSeq: 5 });
    expect(sent).toEqual([]);                                        // not connected yet
    (client as any).child = {};
    client.status = 'connected';
    const chain = (client as any)._resubscribeAll();
    expect(sent).toEqual(['s1']);
    answers[0]();
    await new Promise((r) => setImmediate(r));
    expect(sent).toEqual(['s1', 's2']);
    // A failed answer does not stall the chain.
    (client as any).call = (method: string, params: Record<string, unknown>) => {
      if (method === 'subscribe') sent.push(String(params.session_id));
      return Promise.reject(new Error('connection lost'));
    };
    answers[1]();
    await chain;
    expect(sent).toEqual(['s1', 's2', 's3']);
  });

  it('a newer (re)connect supersedes the chain: nothing more from the old one', async () => {
    const client = new AgentClient({ id: 'v1', name: 'test' } as Vps, new Promise<void>(() => {}));
    const sent: string[] = [];
    const answers: Array<() => void> = [];
    (client as any).call = (method: string, params: Record<string, unknown>) => {
      if (method === 'subscribe') sent.push(String(params.session_id));
      return new Promise((resolve) => answers.push(() => resolve({ ok: true })));
    };
    for (const sid of ['s1', 's2']) client.subscribe(sid, () => {}, { afterSeq: 5 });
    (client as any).child = { id: 'first' };
    client.status = 'connected';
    const first = (client as any)._resubscribeAll();
    (client as any).child = { id: 'second' };                        // the connection was replaced
    answers[0]();
    await first;
    expect(sent).toEqual(['s1']);
  });
});

// Final step review, finding 3: the answer of a back-pressured replay (agent
// >= 0.103.0) follows the whole burst. A burst slower than the 60 s RPC
// timeout to drain lost its answer — and with it the rotation gap's
// `replay_gap` notice (SPEC R2 step 8: never a silent loss) — and released
// the reconnect chain onto the next burst mid-drain. The timer of a pending
// subscribe now follows its session's replay window.
describe('a subscribe whose replay window streams longer than the RPC timeout', () => {
  const SID = 's'.repeat(32);
  const OTHER = 'o'.repeat(32);

  function connected() {
    const client = new AgentClient({ id: 'v1', name: 'test' } as Vps, new Promise<void>(() => {}));
    const writes: any[] = [];
    (client as any).child = { stdin: { write: (line: string) => { writes.push(JSON.parse(line)); } } };
    client.status = 'connected';
    const feed = (msg: unknown) => (client as any)._onStdout(Buffer.from(JSON.stringify(msg) + '\n'));
    return { client, writes, feed };
  }
  const flush = () => new Promise((r) => setImmediate(r));
  const thinking = (seq: number, sid = SID) => ({ event: 'thinking', session_id: sid, seq, ts: seq, text: `w${seq}` });

  it('a gap answer arriving 90 s after the request (frames every 10 s) still yields replay_gap', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { client, writes, feed } = connected();
      const events: any[] = [];
      client.subscribe(SID, (ev) => events.push(ev), { afterSeq: 100 });
      const req = writes.find((w) => w.method === 'subscribe');
      expect(req.params).toEqual({ session_id: SID, after_seq: 100 });
      feed({ event: 'replay_begin', session_id: SID, count: 9 });
      for (let i = 0; i < 9; i++) {
        vi.advanceTimersByTime(10_000);
        feed(thinking(5000 + i));
      }
      feed({ event: 'replay_end', session_id: SID });
      feed({ event: 'status', session_id: SID, status: 'active' });
      vi.advanceTimersByTime(500);
      feed({ id: req.id, result: { ok: true, replay_count: 9, status: 'active', current_seq: 5008,
        earliest_seq: 5000, gap: true, internal_gaps: [] } });
      await flush();
      expect(events.map((e) => e.event)).toContain('replay_gap');
      expect(events.find((e) => e.event === 'replay_gap')).toMatchObject({ after_seq: 100, earliest_seq: 5000 });
      expect(warn.mock.calls.map(([m]) => String(m)).filter((m) => m.includes('timeout'))).toEqual([]);
      expect((client as any).subscribesInFlight.size).toBe(0);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('no window, or only another session\'s window or live frames: the 60 s timeout still applies', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { client, writes, feed } = connected();
      client.subscribe(SID, () => {}, { afterSeq: 100 });
      client.subscribe(OTHER, () => {}, { afterSeq: 1 });
      const req = writes.find((w) => w.method === 'subscribe' && w.params.session_id === SID);
      feed({ event: 'replay_begin', session_id: OTHER, count: 99 });
      for (let i = 0; i < 7; i++) {
        vi.advanceTimersByTime(10_000);
        feed(thinking(10 + i, OTHER));                                 // another session's window
        feed(thinking(900 + i));                                       // SID, outside any window
      }
      await flush();
      const timeouts = warn.mock.calls.map(([m]) => String(m)).filter((m) => m.includes('timeout on subscribe'));
      expect(timeouts).toHaveLength(1);                                // SID's; OTHER's window keeps its own alive
      expect((client as any).pending.has(req.id)).toBe(false);
      expect([...(client as any).subscribesInFlight.keys()]).toEqual([OTHER]);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('the reconnect chain waits for a 3-minute burst before the next session', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const client = new AgentClient({ id: 'v1', name: 'test' } as Vps, new Promise<void>(() => {}));
      for (const sid of [SID, OTHER]) client.subscribe(sid, () => {}, { afterSeq: 5 });
      const writes: any[] = [];
      (client as any).child = { stdin: { write: (line: string) => { writes.push(JSON.parse(line)); } } };
      client.status = 'connected';
      const feed = (msg: unknown) => (client as any)._onStdout(Buffer.from(JSON.stringify(msg) + '\n'));
      const chain = (client as any)._resubscribeAll();
      expect(writes.map((w) => w.params.session_id)).toEqual([SID]);
      feed({ event: 'replay_begin', session_id: SID, count: 18 });
      for (let i = 0; i < 18; i++) {
        vi.advanceTimersByTime(10_000);
        feed(thinking(6 + i));
        await flush();
      }
      expect(writes.map((w) => w.params.session_id)).toEqual([SID]);  // still draining: no second burst
      feed({ event: 'replay_end', session_id: SID });
      feed({ event: 'status', session_id: SID, status: 'active' });
      feed({ id: writes[0].id, result: { ok: true, replay_count: 18, status: 'active', current_seq: 23 } });
      await flush();
      expect(writes.map((w) => w.params.session_id)).toEqual([SID, OTHER]);
      feed({ id: writes[1].id, result: { ok: true, replay_count: 0, status: 'active', current_seq: 5 } });
      await chain;
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});

// PATCH cwd kills the session agent-side (its subscriber set and log go with
// it), then a resume's cursor-less resubscribe must really go out — with the
// stored cursor, whose answer detects the recreated log's seq-epoch reset.
describe('a killed session forgets the agent-side subscription', () => {
  function connectedClient() {
    const client = new AgentClient({ id: 'v1', name: 'test' } as Vps, new Promise<void>(() => {}));
    const sent: Record<string, unknown>[] = [];
    (client as any)._writeRequest = (method: string, params: Record<string, unknown>, onResult?: (r: unknown) => void) => {
      if (method === 'subscribe') sent.push(params);
      const r = { ok: true };
      onResult?.(r);
      return Promise.resolve(r);
    };
    client.status = 'connected';
    return { client, sent };
  }

  it('kill_session answered ⇒ the next resubscribe fires with the stored cursor', async () => {
    const { client, sent } = connectedClient();
    client.subscribe('s1', () => {}, { afterSeq: 4000 });
    await new Promise((r) => setImmediate(r));
    client.resubscribe('s1');                         // already subscribed: no-op
    expect(sent).toHaveLength(1);
    await client.call('kill_session', { session_id: 's1' });
    client.resubscribe('s1');                         // the resume's
    expect(sent).toEqual([
      { session_id: 's1', after_seq: 4000 },
      { session_id: 's1', after_seq: 4000 },
    ]);
  });

  it('a live killed status does the same; a replayed one does not', async () => {
    const { client, sent } = connectedClient();
    client.subscribe('s1', () => {}, { afterSeq: 10 });
    await new Promise((r) => setImmediate(r));
    (client as any)._dispatchMessage({ event: 'replay_begin', session_id: 's1' });
    (client as any)._dispatchMessage({ event: 'status', session_id: 's1', status: 'killed', seq: 3 });
    (client as any)._dispatchMessage({ event: 'replay_end', session_id: 's1' });
    client.resubscribe('s1');
    expect(sent).toHaveLength(1);
    (client as any)._dispatchMessage({ event: 'status', session_id: 's1', status: 'killed', seq: 11 });
    client.resubscribe('s1');
    expect(sent).toEqual([
      { session_id: 's1', after_seq: 10 },
      { session_id: 's1', after_seq: 10 },
    ]);
  });
});
