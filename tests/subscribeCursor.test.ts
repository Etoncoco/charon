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
