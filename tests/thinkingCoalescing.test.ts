import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

// Delta providers' reasoning coalesces hub-side (CLAUDE.md §14.17/§14.31, sync
// refonte C02): ONE `event` row per block, stamped with the first delta's seq
// and ts, closed by every non-transparent event; replay identity per delta
// (own row, or positional cover of a coalesced row); sealed retries with
// per-source holdbacks; no row persisted while a block is open (I8); a 25 ms
// broadcast lane and the `thinking_flushed` cut; `streamingThinking` on the
// GET. Same harness as replayIdentity/replayExactness: a real migrated SQLite
// DB (tests/setup/hermeticDb.ts), the SessionStream driven through
// `_onAgentEvent`, message-row inserts failed on demand.

const pool = vi.hoisted(() => {
  // The AgentClient's reconnect cursor (`_pendingAfterSeq`): written by
  // `setAfterSeq` and by a `resubscribe` with an explicit `afterSeq`.
  const cursors = new Map<string, number | null>();
  return {
    cursors,
    // ONE stable client object (attach() compares identity); resubscribe spied.
    client: {
      setAfterSeq: (sid: string, seq: number | null) => { cursors.set(sid, seq); },
      subscribe: (..._args: any[]) => {},
      unsubscribe: () => {},
      resubscribe: vi.fn((sid: string, opts?: { afterSeq?: number }) => {
        if (typeof opts?.afterSeq === 'number') cursors.set(sid, opts.afterSeq);
      }),
      call: async (..._args: any[]): Promise<any> => ({ ok: true, status: 'active' }),
    },
  };
});

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/session', () => ({ requireApiSession: async () => ({ userId: 'u' }) }));
vi.mock('@/lib/server/seed', () => ({ seedInitialData: () => {} }));
vi.mock('@/lib/server/agent/AgentClientPool', () => ({
  getAgentClientForVpsId: () => pool.client,
  getAgentClient: () => pool.client,
  dropAgentClient: async () => {},
}));
vi.mock('@/lib/server/claude/codexBgState', () => ({ readCodexBgState: async () => [] }));
vi.mock('@/lib/server/claude/webPush', () => ({ sendPushToAll: async () => {} }));
vi.mock('@/lib/server/claude/telegram', () => ({
  sendPermissionToTelegram: async () => {},
  sendQuestionToTelegram: async () => {},
  markInteractionResolvedInTelegram: async () => {},
  sendPlainToTelegram: async () => {},
}));

const VPS_ID = 'thinkvps';
const SID = 'c'.repeat(32);
const REF_SID = 'b'.repeat(32);      // reference (uninterrupted) runs
const SCHED_SID = '8'.repeat(32);    // registered stream (scheduled resume)
const GET_SID = '7'.repeat(32);      // registered stream (session GET)
const ALL_SIDS = [SID, REF_SID, SCHED_SID, GET_SID];
const T0 = Date.now() - 3_600_000;   // agent event clock: an hour ago

let db: any;
let schema: any;
let SessionStream: any;
let getOrCreateStream: any;
let orderChronologically: any;
let rebuildStateFromMessages: any;
// Fail the next N INSERTs into claude_session_messages (other tables pass).
let failMessageInserts = 0;
// Fail the next N UPDATEs of claude_session_messages.
let failMessageUpdates = 0;

function mkStream(opts: { id?: string; kind?: string; lastSeenSeq?: number | null } = {}) {
  return new SessionStream({
    id: opts.id ?? SID, vpsId: VPS_ID, vpsName: 'test', name: null,
    status: 'active', permissionMode: 'normal', claudeSessionId: null,
    kind: opts.kind ?? 'codex', lastSeenSeq: opts.lastSeenSeq ?? null,
  }) as any;
}

/** Agent event with the agent's `ts` (unix SECONDS) = T0 + seq ms. */
function ev(event: string, seq: number | null, extra: Record<string, unknown> = {}, sid = SID) {
  return {
    event, session_id: sid,
    ...(seq != null ? { seq, ts: (T0 + seq) / 1000 } : {}),
    ...extra,
  };
}
const delta = (seq: number, text: string, sid = SID) => ev('thinking', seq, { text }, sid);
const toolUse = (seq: number, id = `t${seq}`, sid = SID) =>
  ev('tool_use', seq, { id, name: 'Read', input: { file_path: '/x' } }, sid);

function send(s: any, events: any[]) {
  for (const e of events) s._onAgentEvent(e);
}

function replay(s: any, events: any[], sid = SID) {
  s._onAgentEvent({ event: 'replay_begin', session_id: sid, count: events.length });
  send(s, events);
  s._onAgentEvent({ event: 'replay_end', session_id: sid });
}

function rows(sid = SID) {
  return db.select().from(schema.claudeSessionMessages).all()
    .filter((r: any) => r.sessionId === sid)
    .sort((a: any, b: any) => a.id - b.id);
}

function isThinkingRow(r: any): boolean {
  if (r.role !== 'event') return false;
  try { return JSON.parse(r.content).type === 'thinking'; } catch { return false; }
}

function thinkingRows(sid = SID) {
  return rows(sid).filter(isThinkingRow).map((r: any) => ({
    id: r.id, text: JSON.parse(r.content).text as string, seq: r.seq, tsMs: r.tsMs,
  }));
}

/** The rendered transcript, ids/dates left out (they differ between runs). */
function rendered(sid: string) {
  const ordered = orderChronologically(rows(sid)).map((r: any) => ({
    id: r.id, role: r.role, content: r.content, createdAt: r.createdAt,
  }));
  return rebuildStateFromMessages(ordered, 'active', 'codex').messages
    .map((m: any) => ({ role: m.role, content: m.content, thinkingDelta: !!m.thinkingDelta }));
}

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db;
  schema = dbMod;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });
  db.insert(schema.vpsFolders).values({ id: 'default', name: 'default', position: 0 }).onConflictDoNothing().run();
  db.insert(schema.vps).values({ id: VPS_ID, name: 'test', ip: '127.0.0.1', sshUser: 'root' }).onConflictDoNothing().run();
  for (const id of ALL_SIDS) {
    db.insert(schema.claudeSessions).values({ id, vpsId: VPS_ID, cwd: '/tmp', status: 'active', kind: 'codex' })
      .onConflictDoNothing().run();
  }
  db.insert(schema.claudeSettings).values({ key: 'notif.global_enabled', value: 'false' }).onConflictDoNothing().run();

  const realInsert = db.insert.bind(db);
  vi.spyOn(db, 'insert').mockImplementation(((table: any) => {
    if (failMessageInserts > 0 && table === schema.claudeSessionMessages) {
      failMessageInserts--;
      const boom = () => { throw new Error('injected DB failure'); };
      return { values: () => ({ run: boom, onConflictDoNothing: () => ({ run: boom }) }) };
    }
    return realInsert(table);
  }) as any);
  const realUpdate = db.update.bind(db);
  vi.spyOn(db, 'update').mockImplementation(((table: any) => {
    if (failMessageUpdates > 0 && table === schema.claudeSessionMessages) {
      failMessageUpdates--;
      const boom = () => { throw new Error('injected DB failure'); };
      return { set: () => ({ where: () => ({ run: boom }) }) };
    }
    return realUpdate(table);
  }) as any);

  ({ SessionStream, getOrCreateStream } = await import('@/lib/server/agent/sessionOps'));
  ({ orderChronologically } = await import('@/lib/server/claude/messageOrder'));
  ({ rebuildStateFromMessages } = await import('@/app/sessionRebuild'));
});

beforeEach(() => {
  pool.client.resubscribe.mockClear();
  pool.cursors.clear();
});

afterEach(() => {
  vi.useRealTimers();
  failMessageInserts = 0;
  failMessageUpdates = 0;
  for (const id of ALL_SIDS) {
    db.delete(schema.claudeSessionMessages).where(eq(schema.claudeSessionMessages.sessionId, id)).run();
  }
  db.delete(schema.claudePendingQuestions).run();
  db.delete(schema.sessionScheduledResumes).run();
  db.update(schema.claudeSessions).set({ lastSeenSeq: null, pendingAssistantMessageId: null }).run();
});

describe('boundaries (thinkingBoundaries.ts)', () => {
  it('closes on every event except the transparent ones; usage only when final; unknown types close', async () => {
    const { closesThinking, THINKING_TRANSPARENT_EVENTS } = await import('@/lib/server/agent/thinkingBoundaries');
    for (const event of THINKING_TRANSPARENT_EVENTS) expect(closesThinking({ event })).toBe(false);
    for (const event of ['tool_use', 'tool_result', 'assistant_text', 'stop', 'status', 'bg_task',
      'endpoint_usage', 'replay_gap', 'error', 'turn_error', 'effective_model', 'plan_progress', 'brand_new_event']) {
      expect(closesThinking({ event })).toBe(true);
    }
    // Both replay markers keep the block open (the replay-only guard needs it).
    expect(closesThinking({ event: 'replay_begin' })).toBe(false);
    expect(closesThinking({ event: 'replay_end' })).toBe(false);
    expect(closesThinking({ event: 'usage' })).toBe(false);
    expect(closesThinking({ event: 'usage', final: false })).toBe(false);
    expect(closesThinking({ event: 'usage', final: true })).toBe(true);
  });
});

describe('one row per block', () => {
  it.each(['codex', 'cursor'])('%s: 5 deltas + tool_use ⇒ one row stamped with the first delta, sorted before the tool', (kind) => {
    const s = mkStream({ kind });
    send(s, ['0', '.', '154', '.', '0'].map((t, i) => delta(1 + i, t)));
    expect(thinkingRows()).toEqual([]);                    // nothing persisted while open
    expect(s.getStreamingThinking()).toBe('0.154.0');
    expect(s._durableCursor()).toBe(0);                    // held below the open block
    send(s, [toolUse(6)]);
    const all = rows();
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ role: 'event', content: JSON.stringify({ type: 'thinking', text: '0.154.0' }), seq: 1, tsMs: T0 + 1 });
    expect(orderChronologically(all).map((r: any) => r.role)).toEqual(['event', 'tool_use']);
    expect(s.getStreamingThinking()).toBe('');
    expect(s._durableCursor()).toBe(6);
  });

  it('Claude keeps one row and one immediate frame per thinking event', () => {
    const s = mkStream({ kind: 'claude' });
    const emitted = vi.spyOn(s, '_emitBroadcast').mockImplementation(() => {});
    send(s, [delta(1, 'First block.'), delta(2, 'Second block.')]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['First block.', 1], ['Second block.', 2]]);
    expect(emitted.mock.calls.map(([e]) => e)).toEqual([
      { type: 'thinking', text: 'First block.' }, { type: 'thinking', text: 'Second block.' },
    ]);
    expect(s.getStreamingThinking()).toBe('');
  });

  it('seq-less deltas (old agents) keep one row per event', () => {
    const s = mkStream();
    send(s, [ev('thinking', null, { text: 'a' }), ev('thinking', null, { text: 'b' })]);
    expect(thinkingRows().map((r: any) => r.text)).toEqual(['a', 'b']);
  });

  it('assistant_text closes the block; the next reasoning closes the text', () => {
    const s = mkStream();
    send(s, [delta(1, 'think '), delta(2, 'more'), ev('assistant_text', 3, { delta: 'Answer' }),
      delta(4, 'again'), ev('stop', 5, { subtype: 'success' })]);
    expect(orderChronologically(rows()).map((r: any) => [r.role, r.role === 'event' ? JSON.parse(r.content).text : r.content]))
      .toEqual([['event', 'think more'], ['assistant', 'Answer'], ['event', 'again']]);
    expect(rows().map((r: any) => r.seq)).toEqual([1, 3, 4]);   // ids follow chronology
  });

  it('bg_task, endpoint_usage, status and a final usage close the block', () => {
    const closers = [
      ev('bg_task', 11, { kind: 'started', task_id: 'bg-1', description: 'job' }),
      ev('endpoint_usage', 21, { request_id: 'r1', input_tokens: 1, output_tokens: 2, total_tokens: 3 }),
      ev('status', 31, { status: 'active' }),
      ev('usage', 41, { output_tokens: 5, final: true }),
    ];
    const s = mkStream();
    closers.forEach((closer, i) => {
      const base = 10 * (i + 1) - 2;
      send(s, [delta(base, `b${i}-`), delta(base + 1, 'x'), closer]);
    });
    send(s, [delta(50, 'tail'), toolUse(51)]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([
      ['b0-x', 8], ['b1-x', 18], ['b2-x', 28], ['b3-x', 38], ['tail', 50],
    ]);
  });

  it('transparent events (and non-final usage) keep the block open', () => {
    const s = mkStream();
    const between = [
      ev('generation_progress', 2, { characters: 10 }),
      ev('tool_progress', 4, { tool_use_id: 'x', delta: 'out' }),
      ev('edit_progress', 6, { tool_use_id: 'x', file_path: '/f', diff: '', size: 0, truncated: false }),
      ev('bg_task_progress', 8, { task_id: 'bg' }),
      ev('tool_activity', 10, { kind: 'mcp', id: '1', status: 'running' }),
      ev('codex_signal', 12, { kind: 'filesystem', id: '1', status: 'idle' }),
      ev('rate_limit', 14, { status: 'allowed' }),
      ev('session_info', 16, { capabilities: ['x'] }),
      ev('model_changed', 18, { model: 'm', fallback_model: null }),
      ev('effort_changed', 20, { effort: null }),
      ev('mode_changed', 22, { mode: 'workspace-write' }),
      ev('session_id', 24, { claude_session_id: 'thread-x' }),
      ev('replay_end', null),
      ev('usage', 26, { output_tokens: 1 }),
    ];
    send(s, [delta(1, 'a')]);
    between.forEach((e, i) => send(s, [e, delta(e.seq != null ? (e.seq as number) + 1 : 100 + i, String(i))]));
    send(s, [toolUse(200)]);
    const texts = thinkingRows().map((r: any) => r.text);
    expect(texts).toEqual(['a' + between.map((_, i) => String(i)).join('')]);
    expect(thinkingRows()[0].seq).toBe(1);
  });

  it('a block past 256 KiB is cut into adjacent rows that render as one bubble', () => {
    const s = mkStream();
    const chunk = 'x'.repeat(64 * 1024);
    send(s, [delta(1, chunk), delta(2, chunk), delta(3, chunk), delta(4, chunk), delta(5, 'tail'), toolUse(6)]);
    const t = thinkingRows();
    expect(t.map((r: any) => [r.text.length, r.seq])).toEqual([[256 * 1024, 1], [4, 5]]);
    expect(rendered(SID).filter((m: any) => m.role === 'thinking')).toEqual([
      { role: 'thinking', content: chunk.repeat(4) + 'tail', thinkingDelta: true },
    ]);
  });

  it('live new-epoch deltas below the open block\'s last seq are kept', () => {
    const s = mkStream();
    send(s, [delta(500, 'old '), delta(501, 'epoch '), ev('thinking', 3, { text: 'new', ts: (T0 + 600) / 1000 })]);
    send(s, [ev('tool_use', 4, { id: 'n', name: 'Read', input: {}, ts: (T0 + 601) / 1000 })]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['old epoch new', 500]]);
  });
});

describe('I8: no row lands while a block is open', () => {
  it('a hub-originated user row flushes the block first', async () => {
    const s = mkStream();
    send(s, [delta(10, 'pondering')]);
    await s.sendUserMessage('next question');
    const all = rows();
    expect(all.map((r: any) => r.role)).toEqual(['event', 'user']);
    expect(JSON.parse(all[0].content).text).toBe('pondering');
    expect(s.getStreamingThinking()).toBe('');
  });

  it('persistExternal flushes first and returns the write\'s value', () => {
    const s = mkStream();
    send(s, [delta(10, 'a')]);
    const value = s.persistExternal(() => {
      expect(thinkingRows().map((r: any) => r.text)).toEqual(['a']);
      return 42;
    });
    expect(value).toBe(42);
  });

  it('an open Codex block + an async answer: thinking rows precede the answer and the resolution', async () => {
    const s = mkStream();
    const questions = [{ question: 'Which colour?', options: [{ label: 'Orange' }, { label: 'Purple' }] }];
    send(s, [ev('user_question', 700, { id: 'async-q', delivery: 'async', questions })]);
    send(s, [delta(701, 'still '), delta(702, 'thinking')]);
    // The answer starts a new turn whose reasoning streams in while the send
    // is in flight — the resolution transaction runs after it.
    s.sendUserMessage = vi.fn(async () => {
      send(s, [ev('thinking', 703, { text: 'new turn', ts: Date.now() / 1000 })]);
    });
    await s.respondQuestion('async-q', { 'Which colour?': 'Orange' });
    const all = rows().filter((r: any) => r.role !== 'async_question');
    const kinds = all.map((r: any) => r.role === 'event' ? JSON.parse(r.content).type + ':' + (JSON.parse(r.content).text ?? '') : r.role);
    expect(kinds).toEqual(['thinking:still thinking', 'user', 'thinking:new turn', 'interaction_resolved:']);
    expect(orderChronologically(all).map((r: any) => r.id)).toEqual(all.map((r: any) => r.id));
  });

  it('an open block + a scheduled-resume card and its delivery: every write lands after the block row', async () => {
    vi.useFakeTimers({ now: Date.now() });
    const s = getOrCreateStream(SCHED_SID);
    expect(s.kind).toBe('codex');
    const think = (seq: number, text: string) =>
      s._onAgentEvent({ event: 'thinking', session_id: SCHED_SID, seq, ts: Date.now() / 1000, text });
    const kinds = () => rows(SCHED_SID).map((r: any) => {
      if (r.role !== 'event') return r.role;
      const c = JSON.parse(r.content);
      return c.type === 'thinking' ? `thinking:${c.text}` : c.type;
    });
    const source = db.insert(schema.claudeSessionMessages).values({
      sessionId: SCHED_SID, role: 'error', content: '{}', tsMs: Date.now(),
    }).run();
    think(900, 'before card');
    const { createScheduledResume, runScheduledResumesDue } = await import('@/lib/server/agent/scheduledResume');
    createScheduledResume({ sessionId: SCHED_SID, sourceMessageId: Number(source.lastInsertRowid), resetAt: Date.now() - 1 });
    expect(kinds()).toEqual(['error', 'thinking:before card', 'scheduled_resume', 'scheduled_resume_update']);

    think(901, 'before delivery');
    // Each delivery write gets its own open block, so each wrapper is proven
    // alone. Between the first card and the user row nothing can interleave
    // for real (synchronous code): the block is injected through the card's
    // publish. The send starts a new turn whose reasoning is still open when
    // the final card is written.
    const publish = s.publishScheduledResume.bind(s);
    let injected = false;
    s.publishScheduledResume = (...args: any[]) => {
      publish(...args);
      if (!injected) { injected = true; think(902, 'before user'); }
    };
    s.sendUserMessage = vi.fn(async () => { think(903, 'new turn'); });
    vi.setSystemTime(Date.now() + 121_000);
    await runScheduledResumesDue();
    expect(kinds()).toEqual([
      'error', 'thinking:before card', 'scheduled_resume', 'scheduled_resume_update',
      'thinking:before delivery', 'scheduled_resume_update',      // deliver's first card
      'thinking:before user', 'user',                              // deliver's user row
      'thinking:new turn', 'scheduled_resume_update',              // the final card
    ]);
  });
});

describe('sealed blocks and holdbacks', () => {
  it('a failed flush seals: cursor held at first−1, the boundary still persists, the retry releases it', () => {
    const s = mkStream();
    send(s, [delta(10, 'a'), delta(11, 'b'), delta(12, 'c')]);
    failMessageInserts = 1;
    send(s, [toolUse(13)]);
    expect(thinkingRows()).toEqual([]);
    expect(rows().map((r: any) => r.role)).toEqual(['tool_use']);   // never blocks the boundary
    expect(s._durableCursor()).toBe(9);
    expect(s.getStreamingThinking()).toBe('');                      // sealed ≠ open

    failMessageInserts = 1;                                          // the retry at the next open fails too
    send(s, [delta(14, 'd'), delta(15, 'e')]);
    expect(thinkingRows()).toEqual([]);
    expect(s._durableCursor()).toBe(9);
    send(s, [ev('stop', 16, { subtype: 'success' })]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq, r.tsMs])).toEqual([
      ['abc', 10, T0 + 10], ['de', 14, T0 + 14],
    ]);
    expect(orderChronologically(rows()).map((r: any) => r.role === 'event' ? JSON.parse(r.content).text : r.role))
      .toEqual(['abc', 'tool_use', 'de']);
    expect(s.holdbacks.size).toBe(0);
    expect(s._durableCursor()).toBe(16);                             // released: the cursor advances
  });

  it('past 50 sealed blocks the oldest is dropped: its holdback stays and the agent re-delivers it', () => {
    const s = mkStream();
    failMessageInserts = Number.MAX_SAFE_INTEGER;
    for (let i = 0; i <= 50; i++) {
      send(s, [delta(100 + 2 * i, `b${i}`), ev('turn_error', 101 + 2 * i, { kind: 'overloaded' })]);
    }
    expect(s.thinkingRetry).toHaveLength(50);
    expect(s.thinkingRetry[0].since).toBe(102);
    expect(s.holdbacks.get('thinking:100')).toBe(100);
    expect(pool.client.resubscribe).toHaveBeenCalledTimes(1);
    expect(pool.client.resubscribe).toHaveBeenCalledWith(SID, { afterSeq: 99 });
    expect(s._durableCursor()).toBe(99);

    // The re-delivery: the sealed blocks persist on the first lookup, the
    // dropped one is rebuilt and persisted, every holdback is released.
    failMessageInserts = 0;
    replay(s, [delta(100, 'b0'), ev('turn_error', 101, { kind: 'overloaded' }), delta(102, 'b1')]);
    expect(thinkingRows().map((r: any) => r.text).sort()).toEqual(
      Array.from({ length: 51 }, (_, i) => `b${i}`).sort());
    expect(s.thinkingRetry).toHaveLength(0);
    expect(s.holdbacks.size).toBe(0);
    expect(s._durableCursor()).toBe(201);
  });

  it('sealed failure + replay of the same block + live continuation: the text is persisted once (prefix-extend)', () => {
    const s = mkStream();
    const emitted = vi.spyOn(s, '_emitBroadcast').mockImplementation(() => {});
    send(s, [delta(10, 'ab'), delta(11, 'cd')]);
    // A hub-side writer closes the block; its insert fails → sealed 'abcd'@10.
    failMessageInserts = 1;
    s._persist('user', 'interjection');
    expect(s.thinkingRetry.map((x: any) => x.text)).toEqual(['abcd']);
    // The block is re-delivered (the agent's block went on: 12 is part of it)
    // while the retries keep failing: the replay rebuilds it from 10.
    failMessageInserts = 2;   // the retries before the lookup and at the open
    replay(s, [delta(10, 'ab'), delta(11, 'cd')]);
    expect(s.getStreamingThinking()).toBe('abcd');
    send(s, [delta(12, 'ef')]);                                     // live continuation
    send(s, [toolUse(13)]);                                         // retry lands 'abcd', the buffer extends it
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['abcdef', 10]]);
    expect(s.holdbacks.size).toBe(0);
    const flushed = emitted.mock.calls.map(([e]) => e).filter((e: any) => e.type === 'thinking_flushed');
    expect(flushed.at(-1)).toMatchObject({ type: 'thinking_flushed', length: 6, content: 'abcdef' });
  });

  it('sealed failure + replay: the retry before the lookup lands the row and covers the replayed deltas', () => {
    const s = mkStream();
    send(s, [delta(10, 'ab'), delta(11, 'cd')]);
    failMessageInserts = 1;
    send(s, [toolUse(12)]);
    replay(s, [delta(10, 'ab'), delta(11, 'cd'), toolUse(12)]);
    send(s, [delta(13, 'ef'), ev('stop', 14, { subtype: 'success' })]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['abcd', 10], ['ef', 13]]);
    expect(rows().filter((r: any) => r.role === 'tool_use')).toHaveLength(1);
  });

  it('a sealed block whose row appeared meanwhile is extended by its retry, never duplicated; a failed extend stays sealed', () => {
    const s = mkStream();
    send(s, [delta(20, 'ef'), delta(21, 'gh')]);
    failMessageInserts = 1;
    send(s, [toolUse(22)]);                                          // sealed 'efgh'@20
    expect(s.thinkingRetry.map((x: any) => x.text)).toEqual(['efgh']);
    // A replay rebuilt (part of) the block meanwhile: row 'ef'@20.
    db.insert(schema.claudeSessionMessages).values({
      sessionId: SID, role: 'event', content: JSON.stringify({ type: 'thinking', text: 'ef' }), seq: 20, tsMs: T0 + 20,
    }).run();
    failMessageUpdates = 1;                                          // the first extend fails: stays sealed
    s.flushThinking();
    expect(s.thinkingRetry).toHaveLength(1);
    expect(s._durableCursor()).toBe(19);
    s.flushThinking();                                               // retried: extends, no second row
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['efgh', 20]]);
    expect(s.holdbacks.size).toBe(0);
    expect(s._durableCursor()).toBe(22);
  });

  it('a failed replay prefix-extend seals the block and its retry extends the row', () => {
    const s = mkStream();
    send(s, [delta(10, 'ab'), delta(11, 'cd')]);
    failMessageInserts = 1;
    s._persist('user', 'interjection');                              // sealed 'abcd'@10
    failMessageInserts = 2;
    replay(s, [delta(10, 'ab'), delta(11, 'cd')]);
    send(s, [delta(12, 'ef')]);
    failMessageUpdates = 1;                                          // the retry lands 'abcd', the extend fails
    send(s, [toolUse(13)]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['abcd', 10]]);
    expect(s.thinkingRetry.map((x: any) => x.text)).toEqual(['abcdef']);
    expect(s._durableCursor()).toBe(9);
    s.flushThinking();
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['abcdef', 10]]);
    expect(s._durableCursor()).toBe(13);
  });

  it('a rebuilt copy of a sealed block that fails again replaces the entry (one entry per block); the cursor holds until it lands', () => {
    const s = mkStream();
    send(s, [delta(10, 'ab'), delta(11, 'cd')]);
    failMessageInserts = 1;
    s._persist('user', 'interjection');                              // sealed 'abcd'@10
    failMessageInserts = 2;                                          // the retries before the lookup and at the open
    replay(s, [delta(10, 'ab'), delta(11, 'cd')]);
    send(s, [delta(12, 'ef')]);
    failMessageInserts = 2;                                          // the flush's retry and its own insert
    send(s, [toolUse(13)]);
    expect(s.thinkingRetry.map((x: any) => [x.text, x.since])).toEqual([['abcdef', 10]]);
    expect(s._durableCursor()).toBe(9);
    failMessageUpdates = 1;                                          // irrelevant now: no prefix row to extend
    s.flushThinking();
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['abcdef', 10]]);
    expect(s._durableCursor()).toBe(13);
  });

  it('two sealed entries for one block: the first landing keeps the holdback while the second waits', () => {
    const s = mkStream({ lastSeenSeq: 13 });
    // Whatever produced them (the merge above prevents it for prefix copies).
    s.thinkingRetry.push({ text: 'abcd', since: 10, tsMs: T0 + 10 }, { text: 'abcdef', since: 10, tsMs: T0 + 10 });
    s._holdBack('thinking:10', 10);
    failMessageUpdates = 1;                                          // 'abcd' inserts, the 'abcdef' extend fails
    s.flushThinking();
    expect(thinkingRows().map((r: any) => r.text)).toEqual(['abcd']);
    expect(s.thinkingRetry.map((x: any) => x.text)).toEqual(['abcdef']);
    expect(s._durableCursor()).toBe(9);
    s.flushThinking();
    expect(thinkingRows().map((r: any) => r.text)).toEqual(['abcdef']);
    expect(s.holdbacks.size).toBe(0);
    expect(s._durableCursor()).toBe(13);
  });

  it('the cap re-delivery is ONE request at a time: none during the outage, one more once the DB recovers', () => {
    const s = mkStream();
    const blocks: any[] = [];
    for (let i = 0; i <= 50; i++) blocks.push(delta(100 + 2 * i, `b${i}`), ev('turn_error', 101 + 2 * i, { kind: 'overloaded' }));
    failMessageInserts = Number.MAX_SAFE_INTEGER;
    send(s, blocks);
    expect(pool.client.resubscribe).toHaveBeenCalledTimes(1);
    const sealed = s.thinkingRetry.map((x: any) => x.since);
    expect(sealed).toHaveLength(50);
    // The agent answers while inserts still fail: rebuilt copies merge into
    // their entries, the dropped block is not sealed again — no overflow.
    replay(s, blocks);
    expect(pool.client.resubscribe).toHaveBeenCalledTimes(1);
    expect(s.thinkingRetry.map((x: any) => x.since)).toEqual(sealed);
    // More blocks during the outage overflow again: still no request.
    send(s, [delta(300, 'late'), ev('turn_error', 301, { kind: 'overloaded' })]);
    expect(pool.client.resubscribe).toHaveBeenCalledTimes(1);
    expect(s._durableCursor()).toBe(99);
    // The DB recovers: the first successful write asks once, from the oldest drop.
    failMessageInserts = 0;
    send(s, [toolUse(302)]);
    expect(pool.client.resubscribe).toHaveBeenCalledTimes(2);
    expect(pool.client.resubscribe).toHaveBeenLastCalledWith(SID, { afterSeq: 99 });
    // Its answer rebuilds the dropped blocks; every holdback is released.
    replay(s, [...blocks, delta(300, 'late'), ev('turn_error', 301, { kind: 'overloaded' }), toolUse(302)]);
    expect(pool.client.resubscribe).toHaveBeenCalledTimes(2);
    expect(thinkingRows().map((r: any) => r.text).sort()).toEqual(
      [...Array.from({ length: 51 }, (_, i) => `b${i}`), 'late'].sort());
    expect(s.thinkingRetry).toHaveLength(0);
    expect(s.holdbacks.size).toBe(0);
    expect(s._durableCursor()).toBe(302);
  });

  it('a sealed retry finding a LONGER row of its block reuses it (no second row)', () => {
    const s = mkStream();
    send(s, [delta(10, 'ab'), delta(11, 'cd')]);
    failMessageInserts = 1;
    s._persist('user', 'interjection');                              // sealed 'abcd'@10
    failMessageInserts = 3;                                          // both retries in the replay, then the flush's
    replay(s, [delta(10, 'ab'), delta(11, 'cd'), delta(12, 'ef')]);
    send(s, [toolUse(13)]);                                          // the rebuilt block lands 'abcdef'@10
    s.flushThinking();                                               // the sealed 'abcd' finds it
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['abcdef', 10]]);
    expect(s.thinkingRetry).toHaveLength(0);
    expect(s.holdbacks.size).toBe(0);
  });

  it('a replay-opened block whose row is already LONGER: no insert, `thinking_flushed` carries the row\'s length', () => {
    const s = mkStream();
    const emitted = vi.spyOn(s, '_emitBroadcast').mockImplementation(() => {});
    send(s, [delta(10, 'ab'), delta(11, 'cd'), delta(12, 'ef')]);
    failMessageInserts = 1;
    s._persist('user', 'interjection');                              // sealed 'abcdef'@10
    failMessageInserts = 2;                                          // the retries before the lookup and at the open
    s._onAgentEvent({ event: 'replay_begin', session_id: SID, count: 2 });
    send(s, [delta(10, 'ab'), delta(11, 'cd')]);                     // rebuilds 'abcd'
    s._persist('user', 'second');                                    // its retry lands 'abcdef', the block finds it
    s._onAgentEvent({ event: 'replay_end', session_id: SID });
    const t = thinkingRows();
    expect(t.map((r: any) => [r.text, r.seq])).toEqual([['abcdef', 10]]);
    const flushed = emitted.mock.calls.map(([e]) => e).filter((e: any) => e.type === 'thinking_flushed');
    expect(flushed.at(-1)).toEqual({ type: 'thinking_flushed', rowId: t[0].id, length: 6, replay: true });
    expect(s.holdbacks.size).toBe(0);
  });

  it('pins of events dropped behind a failing assistant flush share ONE key (the lowest seq)', () => {
    const s = mkStream();
    send(s, [ev('assistant_text', 9, { delta: 'Hi' })]);
    failMessageInserts = Number.MAX_SAFE_INTEGER;
    send(s, Array.from({ length: 2000 }, (_, i) => delta(10 + i, 'x')));
    expect([...s.holdbacks.keys()].sort()).toEqual(['assistant:9', 'event']);
    expect(s.holdbacks.get('event')).toBe(10);
    expect(s._durableCursor()).toBe(8);
    failMessageInserts = 0;
    send(s, [ev('stop', 3000, { subtype: 'success' })]);              // the flush lands
    expect([...s.holdbacks.keys()]).toEqual(['event']);
    expect(s._durableCursor()).toBe(9);
  });
});

describe('the cap re-delivery is bounded', () => {
  const sealBlocks = (s: any, first: number, count: number) => {
    for (let i = 0; i < count; i++) {
      send(s, [delta(first + 2 * i, `b${first + 2 * i}`), ev('turn_error', first + 2 * i + 1, { kind: 'overloaded' })]);
    }
  };

  it('an answer without the dropped block (rotated log): its replay_gap settles it, nothing is asked again', () => {
    const s = mkStream();
    failMessageInserts = Number.MAX_SAFE_INTEGER;
    sealBlocks(s, 100, 51);                                          // 100 dropped
    expect(pool.client.resubscribe).toHaveBeenCalledTimes(1);
    expect(pool.client.resubscribe).toHaveBeenLastCalledWith(SID, { afterSeq: 99 });
    failMessageInserts = 0;
    for (let answer = 0; answer < 5; answer++) {
      // The log now starts at 350: the replay starts past 100, the RPC
      // answer's gap follows the window.
      replay(s, [toolUse(400), ev('stop', 401, { subtype: 'success' })]);
      s._onAgentEvent({ event: 'replay_gap', session_id: SID, after_seq: 99, earliest_seq: 350 });
      expect(pool.client.resubscribe).toHaveBeenCalledTimes(1);
    }
    expect(s.thinkingDropped.size).toBe(0);
    expect(s.thinkingRedelivery).toBe('idle');
    expect(s.holdbacks.size).toBe(0);                                // the gap row records the hole
    expect(s._durableCursor()).toBe(401);
  });

  it('an answer replaying through the dropped seq settles it even when nothing is rebuilt (row already there)', () => {
    const s = mkStream();
    failMessageInserts = Number.MAX_SAFE_INTEGER;
    sealBlocks(s, 100, 51);
    failMessageInserts = 0;
    db.insert(schema.claudeSessionMessages).values({                 // an earlier pass persisted the block
      sessionId: SID, role: 'event', content: JSON.stringify({ type: 'thinking', text: 'b100' }), seq: 100, tsMs: T0 + 100,
    }).run();
    for (let answer = 0; answer < 3; answer++) {
      replay(s, [delta(100, 'b100'), ev('turn_error', 101, { kind: 'overloaded' })]);
    }
    expect(pool.client.resubscribe).toHaveBeenCalledTimes(1);
    expect(thinkingRows().filter((r: any) => r.seq === 100)).toHaveLength(1);
    expect(s.thinkingDropped.size).toBe(0);
    expect(s.holdbacks.size).toBe(0);
    expect(s._durableCursor()).toBe(201);
  });

  it('answers that keep failing: a block is asked for at most 3 times, then its pin is kept for a restart', () => {
    const s = mkStream();
    failMessageInserts = Number.MAX_SAFE_INTEGER;
    sealBlocks(s, 100, 51);
    for (let round = 1; round <= 3; round++) {
      failMessageInserts = Number.MAX_SAFE_INTEGER;
      replay(s, [delta(100, 'b100'), ev('turn_error', 101, { kind: 'overloaded' })]);
      expect(s.thinkingRedelivery).toBe('blocked');
      expect(pool.client.resubscribe).toHaveBeenCalledTimes(round);
      failMessageInserts = 0;
      send(s, [toolUse(1000 + round)]);                              // a live success unblocks
    }
    expect(pool.client.resubscribe).toHaveBeenCalledTimes(3);
    expect(s.thinkingRedelivery).toBe('idle');
    expect(s.thinkingDropped.size).toBe(0);
    expect([...s.holdbacks.entries()]).toEqual([['event', 100]]);
    expect(s._durableCursor()).toBe(99);
  });

  it('a request no replay window answers is asked again once stale: by a live success, or by a later cap drop', () => {
    vi.useFakeTimers({ now: Date.now() });
    const s = mkStream();
    failMessageInserts = Number.MAX_SAFE_INTEGER;
    sealBlocks(s, 100, 51);                                          // the client drops the request (no listener)
    expect(pool.client.resubscribe).toHaveBeenCalledTimes(1);
    failMessageInserts = 0;
    send(s, [toolUse(300)]);                                         // fresh: one request outstanding
    expect(pool.client.resubscribe).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 121_000);
    send(s, [toolUse(302)]);                                         // stale: asked again
    expect(pool.client.resubscribe).toHaveBeenCalledTimes(2);
    expect(pool.client.resubscribe).toHaveBeenLastCalledWith(SID, { afterSeq: 99 });
    failMessageInserts = Number.MAX_SAFE_INTEGER;
    sealBlocks(s, 400, 51);                                          // 400 dropped: waits for the fresh request
    expect(pool.client.resubscribe).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + 121_000);
    sealBlocks(s, 502, 1);                                           // 402 dropped, the request is stale
    expect(pool.client.resubscribe).toHaveBeenCalledTimes(3);
    expect(pool.client.resubscribe).toHaveBeenLastCalledWith(SID, { afterSeq: 99 });
    failMessageInserts = 0;
    const all: any[] = [];
    for (const first of [100, 400]) {
      for (let i = 0; i < 51; i++) all.push(delta(first + 2 * i, `b${first + 2 * i}`), ev('turn_error', first + 2 * i + 1, { kind: 'overloaded' }));
    }
    replay(s, [...all.slice(0, 102), toolUse(300), toolUse(302), ...all.slice(102), delta(502, 'b502'),
      ev('turn_error', 503, { kind: 'overloaded' })]);
    expect(pool.client.resubscribe).toHaveBeenCalledTimes(3);
    expect(s.thinkingDropped.size).toBe(0);
    expect(s.thinkingRetry).toHaveLength(0);
    expect(s.holdbacks.size).toBe(0);
    expect(thinkingRows()).toHaveLength(103);
    expect(s._durableCursor()).toBe(503);
  });

  it('a request sent during a replay window is answered by a LATER window, never by that one\'s end', () => {
    const s = mkStream();
    failMessageInserts = Number.MAX_SAFE_INTEGER;
    sealBlocks(s, 100, 50);                                          // 50 sealed, nothing dropped yet
    expect(pool.client.resubscribe).not.toHaveBeenCalled();
    s._onAgentEvent({ event: 'replay_begin', session_id: SID, count: 3 });
    send(s, [delta(300, 'x'), ev('turn_error', 301, { kind: 'overloaded' })]);   // overflows: 100 dropped, asked
    expect(pool.client.resubscribe).toHaveBeenCalledTimes(1);
    failMessageInserts = 0;
    send(s, [toolUse(302)]);                                         // the window's last write succeeds
    s._onAgentEvent({ event: 'replay_end', session_id: SID });
    expect(s.thinkingRedelivery).toBe('requested');
    expect(pool.client.resubscribe).toHaveBeenCalledTimes(1);
    replay(s, [delta(100, 'b100'), ev('turn_error', 101, { kind: 'overloaded' })]);   // the answer
    expect(pool.client.resubscribe).toHaveBeenCalledTimes(1);
    expect(s.thinkingRedelivery).toBe('idle');
    expect(s.thinkingDropped.size).toBe(0);
    expect(s.holdbacks.size).toBe(0);
    expect(s._durableCursor()).toBe(302);
  });

  // The request's `resubscribe` rewinds the client's reconnect cursor to
  // from−1; replayed seqs never move it forward again. A request made outside
  // a seq-advancing dispatch (here a hub writer's success) stays rewound.
  it('a request answered (or blocked) puts the client\'s reconnect cursor back on the frontier; an outstanding one keeps it', () => {
    const s = mkStream();
    failMessageInserts = Number.MAX_SAFE_INTEGER;
    sealBlocks(s, 100, 51);                                          // 100 dropped, asked
    replay(s, [delta(100, 'b100'), ev('turn_error', 101, { kind: 'overloaded' })]);   // answered, writes still fail
    expect(s.thinkingRedelivery).toBe('blocked');
    expect(pool.cursors.get(SID)).toBe(201);                         // blocked: back on the frontier
    failMessageInserts = 0;
    s._persist('user', 'the DB is back');                            // a success outside a replay asks again
    expect(pool.client.resubscribe).toHaveBeenCalledTimes(2);
    expect(pool.cursors.get(SID)).toBe(99);                          // outstanding: a reconnect asks from 99
    replay(s, [delta(100, 'b100'), ev('turn_error', 101, { kind: 'overloaded' })]);   // the answer
    expect(s.thinkingRedelivery).toBe('idle');
    expect(s.thinkingDropped.size).toBe(0);
    expect(pool.cursors.get(SID)).toBe(201);                         // a reconnect resumes at the frontier
    expect(pool.client.resubscribe).toHaveBeenCalledTimes(2);
  });

  it('a request answered by its replay_gap puts the client\'s reconnect cursor back on the frontier', () => {
    const s = mkStream();
    failMessageInserts = Number.MAX_SAFE_INTEGER;
    sealBlocks(s, 100, 51);
    replay(s, [delta(100, 'b100'), ev('turn_error', 101, { kind: 'overloaded' })]);
    expect(s.thinkingRedelivery).toBe('blocked');
    failMessageInserts = 0;
    s._persist('user', 'the DB is back');
    expect(pool.cursors.get(SID)).toBe(99);
    // The log was rotated meanwhile: the answer starts at 150 (past 100),
    // its gap follows.
    replay(s, [delta(150, 'b150'), ev('turn_error', 151, { kind: 'overloaded' })]);
    expect(s.thinkingRedelivery).toBe('requested');
    expect(pool.cursors.get(SID)).toBe(99);                          // not answered yet
    s._onAgentEvent({ event: 'replay_gap', session_id: SID, after_seq: 99, earliest_seq: 150 });
    expect(s.thinkingRedelivery).toBe('idle');
    expect(s.thinkingDropped.size).toBe(0);
    expect(pool.cursors.get(SID)).toBe(201);
  });
});

describe('a replay window starting INSIDE a persisted row (overlapping resubscribe)', () => {
  it('Codex reasoning: a block closed live, then a burst from its middle ⇒ one row, nothing re-broadcast', () => {
    const s = mkStream({ lastSeenSeq: 9 });
    const emitted = vi.spyOn(s, '_emitBroadcast').mockImplementation(() => {});
    // resumeSession resubscribes after 10 ('a' received); 11-13 arrive live
    // before the agent answers, and the block closes at 13.
    send(s, [delta(10, 'a'), delta(11, 'b'), delta(12, 'c'), toolUse(13)]);
    const frames = emitted.mock.calls.length;
    replay(s, [delta(11, 'b'), delta(12, 'c'), toolUse(13)]);
    send(s, [ev('stop', 14, { subtype: 'success' })]);
    s._flushLiveBroadcast();
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['abc', 10]]);
    expect(rows().filter((r: any) => r.role === 'tool_use')).toHaveLength(1);
    expect(rendered(SID).filter((m: any) => m.role === 'thinking')).toEqual([
      { role: 'thinking', content: 'abc', thinkingDelta: true },
    ]);
    expect(emitted.mock.calls.slice(frames).map(([e]: any[]) => e.type)
      .filter((t: string) => t === 'thinking' || t === 'thinking_flushed')).toEqual([]);
    expect(s._durableCursor()).toBe(14);
  });

  it('double replay whose second burst starts mid-block: the block rebuilt by the first is not written again', () => {
    const s = mkStream({ lastSeenSeq: 9 });
    replay(s, [delta(10, 'a'), delta(11, 'b'), delta(12, 'c'), toolUse(13)]);
    replay(s, [delta(11, 'b'), delta(12, 'c'), toolUse(13)]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['abc', 10]]);
  });

  it('a row proved by the cover (persisted by an earlier process): a later burst from its middle writes nothing', () => {
    db.insert(schema.claudeSessionMessages).values({
      sessionId: SID, role: 'event', content: JSON.stringify({ type: 'thinking', text: 'abc' }), seq: 10, tsMs: T0 + 10,
    }).run();
    db.insert(schema.claudeSessionMessages).values({
      sessionId: SID, role: 'tool_use', content: JSON.stringify({ type: 'tool_use', id: 't13', name: 'Read', input: {} }),
      seq: 13, tsMs: T0 + 13,
    }).run();
    const s = mkStream({ lastSeenSeq: 9 });
    replay(s, [delta(10, 'a'), delta(11, 'b'), delta(12, 'c'), toolUse(13)]);
    replay(s, [delta(11, 'b'), delta(12, 'c'), toolUse(13)]);
    expect(rows()).toHaveLength(2);
  });

  it('a block cut by a hub writer, and a sealed block landed by its retry: a burst from inside either writes nothing', () => {
    const s = mkStream({ lastSeenSeq: 9 });
    send(s, [delta(10, 'a'), delta(11, 'b')]);
    s.flushThinking();                                               // I8 cut: 'ab'@10
    send(s, [delta(12, 'c'), delta(13, 'd'), delta(14, 'e')]);
    failMessageInserts = 1;
    send(s, [toolUse(15)]);                                          // 'cde'@12 sealed
    send(s, [delta(16, 'f'), toolUse(17)]);                          // its retry lands it, then 'f'@16
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['ab', 10], ['cde', 12], ['f', 16]]);
    replay(s, [delta(13, 'd'), delta(14, 'e'), toolUse(15)]);        // inside the retried block
    replay(s, [delta(11, 'b'), delta(12, 'c'), delta(13, 'd'), delta(14, 'e'), toolUse(15)]);   // inside the cut one
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['ab', 10], ['cde', 12], ['f', 16]]);
    expect(rows().filter((r: any) => r.role === 'tool_use').map((r: any) => r.seq)).toEqual([15, 17]);
  });

  it('a block a window reopens from its anchor (its row was deleted meanwhile) keeps every delta: the span never cuts it', () => {
    const s = mkStream({ lastSeenSeq: 9 });
    send(s, [delta(10, 'a'), delta(11, 'b'), delta(12, 'c'), toolUse(13)]);
    db.delete(schema.claudeSessionMessages).where(eq(schema.claudeSessionMessages.sessionId, SID)).run();   // a rewind
    replay(s, [delta(10, 'a'), delta(11, 'b'), delta(12, 'c'), toolUse(13)]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['abc', 10]]);
  });

  it('a recreated log reusing the seqs (later ts) is new reasoning, never swallowed by the span', () => {
    const s = mkStream({ lastSeenSeq: 9 });
    send(s, [delta(10, 'a'), delta(11, 'b'), delta(12, 'c'), toolUse(13)]);
    const later = (T0 + 60_000) / 1000;
    replay(s, [ev('thinking', 11, { text: 'new', ts: later }),
      ev('tool_use', 12, { id: 'n12', name: 'Read', input: {}, ts: later + 0.001 })]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['abc', 10], ['new', 11]]);
  });

  it.each(['codex', 'claude'])('%s assistant text: a flush row closed live, then a burst from its middle ⇒ one row', (kind) => {
    const s = mkStream({ kind, lastSeenSeq: 9 });
    const text = (seq: number, delta: string) => ev('assistant_text', seq, { delta });
    send(s, [text(10, 'Hel'), text(11, 'lo '), text(12, 'there'), toolUse(13)]);
    replay(s, [text(11, 'lo '), text(12, 'there'), toolUse(13)]);
    // A window from the ANCHOR still accumulates the whole text (the
    // boundary's identity/prefix-extend needs it): the span only skips
    // deltas that would open a buffer mid-row.
    s._onAgentEvent({ event: 'replay_begin', session_id: SID, count: 4 });
    send(s, [text(10, 'Hel'), text(11, 'lo '), text(12, 'there')]);
    expect(s.getStreamingText()).toBe('Hello there');
    send(s, [toolUse(13)]);
    s._onAgentEvent({ event: 'replay_end', session_id: SID });
    send(s, [ev('stop', 14, { subtype: 'success' })]);
    expect(s.getStreamingText()).toBe('');
    expect(rows().filter((r: any) => r.role === 'assistant').map((r: any) => [r.content, r.seq]))
      .toEqual([['Hello there', 10]]);
  });

  it('assistant text: a row proved at a gated boundary (earlier process), then a burst from its middle ⇒ nothing written', () => {
    db.insert(schema.claudeSessionMessages).values({ sessionId: SID, role: 'assistant', content: 'abc', seq: 10, tsMs: T0 + 10 }).run();
    db.insert(schema.claudeSessionMessages).values({
      sessionId: SID, role: 'tool_use', content: JSON.stringify({ type: 'tool_use', id: 't13', name: 'Read', input: {} }),
      seq: 13, tsMs: T0 + 13,
    }).run();
    const s = mkStream({ lastSeenSeq: 9 });
    const text = (seq: number, delta: string) => ev('assistant_text', seq, { delta });
    replay(s, [text(10, 'a'), text(11, 'b'), text(12, 'c'), toolUse(13)]);
    replay(s, [text(11, 'b'), text(12, 'c'), toolUse(13)]);
    send(s, [ev('stop', 14, { subtype: 'success' })]);
    expect(rows()).toHaveLength(2);
  });
});

describe('PersistedSpans (thinkingBoundaries.ts)', () => {
  it('covers the seqs after a span\'s anchor through its last delta, ts-matched; never the anchor itself', async () => {
    const { PersistedSpans } = await import('@/lib/server/agent/thinkingBoundaries');
    const spans = new PersistedSpans();
    spans.record(10, 12, 1000, 1002);
    spans.record(20, 20, 2000, 2000);                                // one delta: its own identity
    expect(spans.size).toBe(1);
    expect([9, 10, 11, 12, 13, 20].map((seq) => spans.covers(seq, null))).toEqual([false, false, true, true, false, false]);
    expect(spans.covers(11, 1001)).toBe(true);
    expect(spans.covers(11, 1003)).toBe(true);                       // ±1 ms rounding
    expect(spans.covers(11, 1004)).toBe(false);                      // a recreated log: later ts
    expect(spans.covers(11, 998)).toBe(false);
    spans.record(30, 32, null, null);                                // undated span
    expect(spans.covers(31, null)).toBe(true);
    expect(spans.covers(31, 3001)).toBe(false);                      // never swallows a dated event
  });

  it('grows a known span, keeps spans sorted, and is bounded by count (lowest seqs first) and age', async () => {
    const { PersistedSpans } = await import('@/lib/server/agent/thinkingBoundaries');
    const spans = new PersistedSpans(3, 1000);
    spans.record(50, 52, 50, 52, 0);
    spans.record(10, 11, 10, 11, 0);                                 // an older block re-delivered late
    spans.record(10, 14, 10, 14, 0);                                 // the same row, grown
    expect(spans.covers(14, 14)).toBe(true);
    expect(spans.covers(51, 51)).toBe(true);
    spans.record(30, 31, 30, 31, 0);
    spans.record(70, 71, 70, 71, 0);                                 // over the cap: 10 goes
    expect(spans.size).toBe(3);
    expect(spans.covers(14, 14)).toBe(false);
    expect([31, 51, 71].map((seq) => spans.covers(seq, seq))).toEqual([true, true, true]);
    spans.record(90, 91, 90, 91, 1500);                              // over the cap (30), then stale (50, 70)
    expect(spans.size).toBe(1);
    expect([31, 51, 71, 91].map((seq) => spans.covers(seq, seq))).toEqual([false, false, false, true]);
    const many = new PersistedSpans();
    for (let i = 0; i < 1000; i++) many.record(10 * i, 10 * i + 5, null, null);
    expect(many.covers(5005, null)).toBe(true);
    expect(many.covers(5007, null)).toBe(false);
  });
});

describe('an event dropped behind a failed assistant flush (order rule 16.3)', () => {
  it.each(['codex', 'claude'])('%s: it pins the cursor after the flush succeeds; the restart replay persists it once', (kind) => {
    const s = mkStream({ kind });
    send(s, [ev('assistant_text', 10, { delta: 'Hel' }), ev('assistant_text', 11, { delta: 'lo' })]);
    failMessageInserts = 1;
    send(s, [toolUse(12)]);                                          // flush fails ⇒ tool_use 12 dropped
    expect(rows()).toEqual([]);
    send(s, [ev('stop', 13, { subtype: 'success' })]);               // the retried flush succeeds
    expect(rows().map((r: any) => [r.role, r.seq])).toEqual([['assistant', 10]]);
    expect(s.holdbacks.has('assistant:10')).toBe(false);
    expect(s._durableCursor()).toBe(11);
    const persisted = db.select({ c: schema.claudeSessions.lastSeenSeq }).from(schema.claudeSessions)
      .where(eq(schema.claudeSessions.id, SID)).get().c;
    expect(persisted).toBe(11);
    // Restart: the replay from the durable cursor writes tool_use 12 once.
    const s2 = mkStream({ kind, lastSeenSeq: persisted });
    replay(s2, [toolUse(12), ev('stop', 13, { subtype: 'success' })]);
    expect(orderChronologically(rows()).map((r: any) => [r.role, r.seq])).toEqual([['assistant', 10], ['tool_use', 12]]);
    expect(s2._durableCursor()).toBe(13);
  });

  it('a Codex reasoning delta dropped there is rebuilt by the restart replay, in order', () => {
    const s = mkStream();
    send(s, [ev('assistant_text', 10, { delta: 'Hel' }), ev('assistant_text', 11, { delta: 'lo' })]);
    failMessageInserts = 1;
    send(s, [delta(12, 'LOST ')]);                                   // flush fails ⇒ the delta is dropped
    send(s, [delta(13, 'kept'), toolUse(14)]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['kept', 13]]);
    expect(s._durableCursor()).toBe(11);
    const s2 = mkStream({ lastSeenSeq: 11 });
    replay(s2, [delta(12, 'LOST '), delta(13, 'kept'), toolUse(14)]);
    expect(orderChronologically(thinkingRows()).map((r: any) => [r.text, r.seq])).toEqual([['LOST ', 12], ['kept', 13]]);
    expect(rows().filter((r: any) => r.role === 'assistant')).toHaveLength(1);
    expect(rendered(SID).filter((m: any) => m.role === 'thinking')).toEqual([
      { role: 'thinking', content: 'LOST kept', thinkingDelta: true },
    ]);
  });
});

describe('replay identity of delta reasoning', () => {
  it('crash mid-block: the replay rebuilds exactly one row', () => {
    const s = mkStream();
    send(s, [delta(10, 'a'), delta(11, 'b'), delta(12, 'c')]);
    const cursor = s._durableCursor();
    expect(cursor).toBe(9);
    const s2 = mkStream({ lastSeenSeq: cursor });
    replay(s2, [delta(10, 'a'), delta(11, 'b'), delta(12, 'c')]);
    send(s2, [delta(13, 'd'), toolUse(14)]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq, r.tsMs])).toEqual([['abcd', 10, T0 + 10]]);
  });

  it('SIGTERM partial + replay + live continuation: prefix row + adjacent remainder, rendered like the uninterrupted run', () => {
    const parts = ['Let ', 'me ', 'check', ' the ', 'file'];
    // Uninterrupted reference.
    const ref = mkStream({ id: REF_SID });
    send(ref, [...parts.map((t, i) => delta(10 + i, t, REF_SID)), toolUse(15, 't15', REF_SID)]);

    const s = mkStream();
    send(s, parts.slice(0, 3).map((t, i) => delta(10 + i, t)));
    s.flushPendingAssistant();                                       // SIGTERM: partial 'Let me check'@10
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['Let me check', 10]]);
    const s2 = mkStream({ lastSeenSeq: 9 });                         // the durable cursor never passed the block
    replay(s2, parts.slice(0, 4).map((t, i) => delta(10 + i, t)));
    send(s2, [delta(14, 'file'), toolUse(15)]);                      // live continuation
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['Let me check', 10], [' the file', 13]]);
    expect(rendered(SID)).toEqual(rendered(REF_SID));
    expect(rendered(SID).filter((m: any) => m.role === 'thinking')).toHaveLength(1);
  });

  it('legacy per-delta rows + replay ⇒ zero inserts, nothing broadcast', () => {
    const insert = (seq: number, text: string) => db.insert(schema.claudeSessionMessages).values({
      sessionId: SID, role: 'event', content: JSON.stringify({ type: 'thinking', text }), seq, tsMs: T0 + seq,
    }).run();
    insert(10, 'a'); insert(11, 'b'); insert(12, 'c');
    db.insert(schema.claudeSessionMessages).values({
      sessionId: SID, role: 'tool_use', content: JSON.stringify({ type: 'tool_use', id: 't13', name: 'Read', input: {} }),
      seq: 13, tsMs: T0 + 13,
    }).run();
    const before = rows().length;
    const s = mkStream({ lastSeenSeq: 9 });
    const emitted = vi.spyOn(s, '_emitBroadcast').mockImplementation(() => {});
    replay(s, [delta(10, 'a'), delta(11, 'b'), delta(12, 'c'), toolUse(13)]);
    s._flushLiveBroadcast();
    expect(rows()).toHaveLength(before);
    expect(emitted.mock.calls.filter(([e]: any[]) => e.type === 'thinking' || e.type === 'thinking_flushed')).toEqual([]);
  });

  it('a compacted merged row + replay of the same deltas ⇒ zero inserts', () => {
    db.insert(schema.claudeSessionMessages).values({
      sessionId: SID, role: 'event', content: JSON.stringify({ type: 'thinking', text: 'abc' }), seq: 10, tsMs: T0 + 10,
    }).run();
    db.insert(schema.claudeSessionMessages).values({
      sessionId: SID, role: 'tool_use', content: JSON.stringify({ type: 'tool_use', id: 't13', name: 'Read', input: {} }),
      seq: 13, tsMs: T0 + 13,
    }).run();
    const s = mkStream({ lastSeenSeq: 9 });
    replay(s, [delta(10, 'a'), delta(11, 'b'), delta(12, 'c'), toolUse(13)]);
    expect(rows()).toHaveLength(2);
    expect(s.getStreamingThinking()).toBe('');
  });

  it('a cover is positional: it never matches text after a boundary', () => {
    db.insert(schema.claudeSessionMessages).values({
      sessionId: SID, role: 'event', content: JSON.stringify({ type: 'thinking', text: 'abab' }), seq: 10, tsMs: T0 + 10,
    }).run();
    const s = mkStream({ lastSeenSeq: 9 });
    // Only 'ab' of the row is replayed before a boundary: the cover resets,
    // and the 'ab' after it is new reasoning.
    replay(s, [delta(10, 'ab'), toolUse(11), delta(12, 'ab'), toolUse(13)]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['abab', 10], ['ab', 12]]);
  });

  it('a cover is positional inside its row: it matches only from its start, never text found further in', () => {
    db.insert(schema.claudeSessionMessages).values({
      sessionId: SID, role: 'event', content: JSON.stringify({ type: 'thinking', text: 'aXb' }), seq: 10, tsMs: T0 + 10,
    }).run();
    const s = mkStream({ lastSeenSeq: 9 });
    // The rest of the row is 'Xb': a replayed 'b' does not start it — new reasoning.
    replay(s, [delta(10, 'a'), delta(11, 'b'), toolUse(12)]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['aXb', 10], ['b', 11]]);
  });

  it('a cover moves forward in seq: the anchor replayed again inside one window restarts it, never consumes it', () => {
    db.insert(schema.claudeSessionMessages).values({
      sessionId: SID, role: 'event', content: JSON.stringify({ type: 'thinking', text: 'abab' }), seq: 10, tsMs: T0 + 10,
    }).run();
    const s = mkStream({ lastSeenSeq: 9 });
    replay(s, [delta(10, 'ab'), delta(10, 'ab'), delta(11, 'ab'), toolUse(12)]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['abab', 10]]);
  });

  it('a cover left by a cut re-delivery window never swallows the next window\'s new deltas', () => {
    db.insert(schema.claudeSessionMessages).values({
      sessionId: SID, role: 'event', content: JSON.stringify({ type: 'thinking', text: 'ab the' }), seq: 10, tsMs: T0 + 10,
    }).run();
    db.insert(schema.claudeSessionMessages).values({
      sessionId: SID, role: 'tool_use', content: JSON.stringify({ type: 'tool_use', id: 't14', name: 'Read', input: {} }),
      seq: 14, tsMs: T0 + 14,
    }).run();
    const s = mkStream({ lastSeenSeq: 20 });
    // A re-delivery of older events (cap re-delivery, reset replay) is cut
    // right after the row's first delta: the rest ' the' is left over.
    s._onAgentEvent({ event: 'replay_begin', session_id: SID, count: 5 });
    send(s, [delta(10, 'ab')]);
    s._onAgentEvent({ event: 'replay_end', session_id: SID, synthetic: true });
    expect(s.replayThinkingCover).toBe(' the');
    // The reconnect replays from 20: ' the' at 21 is NEW reasoning.
    replay(s, [delta(21, ' the'), delta(22, ' end'), toolUse(23)]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['ab the', 10], [' the end', 21]]);
  });

  it('a hub-restart window cut mid-row: the next window resumes the cover (also through a transparent event), no duplicate', () => {
    // 'ab the' = deltas 10 and 12 (a rate_limit at 11 between them).
    db.insert(schema.claudeSessionMessages).values({
      sessionId: SID, role: 'event', content: JSON.stringify({ type: 'thinking', text: 'ab the' }), seq: 10, tsMs: T0 + 10,
    }).run();
    db.insert(schema.claudeSessionMessages).values({
      sessionId: SID, role: 'tool_use', content: JSON.stringify({ type: 'tool_use', id: 't14', name: 'Read', input: {} }),
      seq: 14, tsMs: T0 + 14,
    }).run();
    const s = mkStream({ lastSeenSeq: 9 });
    s._onAgentEvent({ event: 'replay_begin', session_id: SID, count: 6 });
    send(s, [delta(10, 'ab'), ev('rate_limit', 11, { status: 'allowed' })]);
    s._onAgentEvent({ event: 'replay_end', session_id: SID, synthetic: true });
    // The reconnect resumes right after 11.
    replay(s, [delta(12, ' the'), toolUse(14), delta(15, 'next'), toolUse(16)]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['ab the', 10], ['next', 15]]);
    expect(rows().filter((r: any) => r.role === 'tool_use').map((r: any) => r.seq)).toEqual([14, 16]);
  });

  it('attach + resubscribe double replay ⇒ no doubled text', () => {
    const s = mkStream({ lastSeenSeq: 9 });
    const block = [delta(10, 'one '), delta(11, 'two '), delta(12, 'three')];
    replay(s, block);
    replay(s, block);
    send(s, [toolUse(13)]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['one two three', 10]]);
    // The same range twice inside ONE window: the replay-only seq guard.
    const s2 = mkStream({ id: REF_SID, lastSeenSeq: 9 });
    replay(s2, [delta(10, 'one ', REF_SID), delta(11, 'two ', REF_SID), delta(10, 'one ', REF_SID),
      delta(11, 'two ', REF_SID), delta(12, 'three', REF_SID)], REF_SID);
    send(s2, [toolUse(13, 't13', REF_SID)]);
    expect(thinkingRows(REF_SID).map((r: any) => r.text)).toEqual(['one two three']);
  });

  it('a resubscribe replaying deltas the LIVE block already holds writes them once (replay_begin keeps it open)', () => {
    const s = mkStream({ lastSeenSeq: 9 });
    send(s, [delta(10, 'a'), delta(11, 'b'), delta(12, 'c')]);
    // resumeSession's resubscribe: the agent re-sends what it had queued
    // live, plus one delta this hub had not received yet.
    replay(s, [delta(11, 'b'), delta(12, 'c'), delta(13, 'd')]);
    expect(s.getStreamingThinking()).toBe('abcd');
    expect(s.pendingThinkingFromReplay).toBe(true);                 // its flush goes through identity
    send(s, [ev('status', null, { status: 'thinking' })]);           // the agent's seq-less post-subscribe status
    send(s, [delta(14, 'e'), toolUse(15)]);
    expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['abcd', 10], ['e', 14]]);
    expect(rendered(SID).filter((m: any) => m.role === 'thinking')).toEqual([
      { role: 'thinking', content: 'abcde', thinkingDelta: true },
    ]);
  });

  it('a re-delivery from an older seq closes the live block, then rebuilds the older one (the guard covers only the open block)', () => {
    const s = mkStream({ lastSeenSeq: 99 });
    send(s, [delta(300, 'live ')]);
    // The cap re-delivery of a dropped block (100) arrives while 300 is open.
    replay(s, [delta(100, 'old'), ev('turn_error', 101, { kind: 'overloaded' }), delta(300, 'live ')]);
    send(s, [delta(301, 'more'), toolUse(302)]);
    expect(orderChronologically(thinkingRows()).map((r: any) => [r.text, r.seq]))
      .toEqual([['old', 100], ['live ', 300], ['more', 301]]);
  });

  it('a replayed delta at a persisted row closes the open block: later uncovered deltas never join it out of order', () => {
    // 11 was never persisted; 12.. is a SIGTERM partial 'BC' of the block 12-14.
    db.insert(schema.claudeSessionMessages).values({
      sessionId: SID, role: 'event', content: JSON.stringify({ type: 'thinking', text: 'BC' }), seq: 12, tsMs: T0 + 12,
    }).run();
    const s = mkStream({ lastSeenSeq: 10 });
    replay(s, [delta(11, 'A'), delta(12, 'B'), delta(13, 'C'), delta(14, 'D'), toolUse(15)]);
    expect(orderChronologically(thinkingRows()).map((r: any) => [r.text, r.seq]))
      .toEqual([['A', 11], ['BC', 12], ['D', 14]]);
    expect(rendered(SID).filter((m: any) => m.role === 'thinking')).toEqual([
      { role: 'thinking', content: 'ABCD', thinkingDelta: true },
    ]);
  });

  it('a replay-opened block whose row DIVERGED meanwhile is inserted beside it, with a warning (a duplicate beats a loss)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const s = mkStream({ lastSeenSeq: 9 });
      s._onAgentEvent({ event: 'replay_begin', session_id: SID, count: 3 });
      send(s, [delta(10, 'ab'), delta(11, 'cd')]);                   // no row at 10 yet: the block opens
      db.insert(schema.claudeSessionMessages).values({               // another writer's row appears meanwhile
        sessionId: SID, role: 'event', content: JSON.stringify({ type: 'thinking', text: 'xyz' }), seq: 10, tsMs: T0 + 10,
      }).run();
      send(s, [toolUse(12)]);
      s._onAgentEvent({ event: 'replay_end', session_id: SID });
      expect(thinkingRows().map((r: any) => [r.text, r.seq])).toEqual([['xyz', 10], ['abcd', 10]]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[replay] thinking diverged at seq 10'));
    } finally {
      warn.mockRestore();
    }
  });

  it('a replay-opened block whose sealed copy lands at its flush: no insert, `thinking_flushed` names the existing row', () => {
    const s = mkStream();
    const emitted = vi.spyOn(s, '_emitBroadcast').mockImplementation(() => {});
    send(s, [delta(10, 'ab'), delta(11, 'cd')]);
    failMessageInserts = 1;
    s._persist('user', 'interjection');                              // sealed 'abcd'@10
    failMessageInserts = 2;                                          // the retries before the lookup and at the open
    replay(s, [delta(10, 'ab'), delta(11, 'cd')]);
    expect(s.getStreamingThinking()).toBe('abcd');
    send(s, [toolUse(12)]);                                          // the retry lands 'abcd' = the block's text
    const t = thinkingRows();
    expect(t.map((r: any) => [r.text, r.seq])).toEqual([['abcd', 10]]);
    const flushed = emitted.mock.calls.map(([e]) => e).filter((e: any) => e.type === 'thinking_flushed');
    expect(flushed).toEqual([{ type: 'thinking_flushed', rowId: t[0].id, length: 4 }]);
    expect(s.holdbacks.size).toBe(0);
  });

  it('a replayed persisted delta while an assistant buffer is open: the buffer is dropped only if its flush row exists', () => {
    // Flush row present: no second assistant row.
    db.insert(schema.claudeSessionMessages).values({ sessionId: SID, role: 'assistant', content: 'Hello', seq: 20, tsMs: T0 + 20 }).run();
    db.insert(schema.claudeSessionMessages).values({
      sessionId: SID, role: 'event', content: JSON.stringify({ type: 'thinking', text: 'x' }), seq: 22, tsMs: T0 + 22,
    }).run();
    const s = mkStream({ lastSeenSeq: 19 });
    replay(s, [ev('assistant_text', 20, { delta: 'Hel' }), ev('assistant_text', 21, { delta: 'lo' }), delta(22, 'x')]);
    expect(s.getStreamingText()).toBe('');
    expect(rows().filter((r: any) => r.role === 'assistant')).toHaveLength(1);

    // Flush row missing (it failed before the crash): the buffer is KEPT —
    // no early row at the replayed delta; the next boundary writes it, dated
    // from its first delta.
    db.delete(schema.claudeSessionMessages).where(eq(schema.claudeSessionMessages.id, rows().find((r: any) => r.role === 'assistant').id)).run();
    const s2 = mkStream({ lastSeenSeq: 19 });
    replay(s2, [ev('assistant_text', 20, { delta: 'Hel' }), ev('assistant_text', 21, { delta: 'lo' }), delta(22, 'x')]);
    expect(rows().filter((r: any) => r.role === 'assistant')).toHaveLength(0);
    expect(s2.getStreamingText()).toBe('Hello');
    send(s2, [toolUse(23)]);
    expect(rows().filter((r: any) => r.role === 'assistant').map((r: any) => [r.content, r.seq])).toEqual([['Hello', 20]]);
    expect(thinkingRows()).toHaveLength(1);
  });
});

describe('broadcast lane and thinking_flushed', () => {
  it('N deltas within 25 ms ⇒ one `thinking` frame, then `thinking_flushed`, then the boundary', () => {
    vi.useFakeTimers();
    const s = mkStream();
    const emitted = vi.spyOn(s, '_emitBroadcast').mockImplementation(() => {});
    send(s, ['0', '.', '154'].map((t, i) => delta(1 + i, t)));
    expect(emitted).not.toHaveBeenCalled();
    vi.advanceTimersByTime(25);
    expect(emitted.mock.calls.map(([e]) => e)).toEqual([{ type: 'thinking', text: '0.154' }]);
    send(s, [delta(4, '.'), delta(5, '0'), toolUse(6)]);
    const [row] = thinkingRows();
    expect(emitted.mock.calls.map(([e]) => e).slice(1)).toEqual([
      { type: 'thinking', text: '.0' },
      { type: 'thinking_flushed', rowId: row.id, length: 7 },
      expect.objectContaining({ type: 'tool_use', id: 't6' }),
    ]);
  });

  it('lane and replay switches flush first; replayed frames keep their tag', () => {
    const s = mkStream({ lastSeenSeq: 0 });
    const emitted = vi.spyOn(s, '_emitBroadcast').mockImplementation(() => {});
    replay(s, [delta(1, 'old ')]);
    send(s, [delta(2, 'new'), ev('assistant_text', 3, { delta: 'Hi' })]);
    s._flushAssistantBroadcast();                                    // the alias still works
    const frames = emitted.mock.calls.map(([e]) => e);
    expect(frames).toEqual([
      { type: 'thinking', text: 'old ', replay: true },
      { type: 'thinking', text: 'new' },
      { type: 'thinking_flushed', rowId: thinkingRows()[0].id, length: 7 },
      { type: 'assistant_text', delta: 'Hi' },
    ]);
  });
});

describe('session GET', () => {
  it('returns the open block as `streamingThinking`', async () => {
    const s = getOrCreateStream(GET_SID);
    s._onAgentEvent({ event: 'thinking', session_id: GET_SID, seq: 5, ts: (T0 + 5) / 1000, text: 'half a ' });
    s._onAgentEvent({ event: 'thinking', session_id: GET_SID, seq: 6, ts: (T0 + 6) / 1000, text: 'thought' });
    const { GET } = await import('@/app/api/claude/sessions/[id]/route');
    const get = async () => (await GET(new Request(`http://localhost/api/claude/sessions/${GET_SID}`),
      { params: Promise.resolve({ id: GET_SID }) })).json();
    const open = await get();
    expect(open.streamingThinking).toBe('half a thought');
    expect(open.messages.filter(isThinkingRow)).toEqual([]);
    s._onAgentEvent({ event: 'tool_use', session_id: GET_SID, seq: 7, ts: (T0 + 7) / 1000, id: 'g', name: 'Read', input: {} });
    const closed = await get();
    expect(closed.streamingThinking).toBe('');
    expect(closed.messages.filter(isThinkingRow).map((r: any) => JSON.parse(r.content).text)).toEqual(['half a thought']);
  });
});
