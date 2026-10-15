import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// SSE registry identity (CLAUDE.md §14.15, G8): a connection is its STREAM
// instance. A reconnect with the same connId closes and replaces the old stream,
// and the old stream's late close can never unregister the replacement — the
// measured zombie conn (registered, heartbeating, receiving nothing, every focus
// POST answered `ok:false`). Also pins the legacy SSE connect snapshot additions
// (derived vps_status keys, archived rows skipped, unread + bg-task counts, ONE
// pending_snapshot).

const bus = vi.hoisted(() => {
  const subs = new Set<(ev: any) => void>();
  return {
    subs,
    emit(ev: any) { for (const cb of [...subs]) cb(ev); },
    markSessionRead: vi.fn(),
    streams: new Map<string, { status: string; runningBgTaskCount(): number }>(),
  };
});

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/agent/sessionOps', () => ({
  subscribeGlobalSessionEvents: (cb: (ev: any) => void) => {
    bus.subs.add(cb);
    return () => { bus.subs.delete(cb); };
  },
  setSessionFocusChecker: () => {},
  markSessionRead: bus.markSessionRead,
  peekStream: (id: string) => bus.streams.get(id) ?? null,
}));
vi.mock('@/lib/server/session', () => ({ requireApiSession: vi.fn(async () => ({ userId: 'test-user' })) }));
vi.mock('@/lib/server/seed', () => ({ seedInitialData: vi.fn() }));
vi.mock('@/lib/server/install/installSession', () => ({
  subscribeInstallBus: () => () => {},
  listInstalls: () => [],
}));

import {
  focusCountFor, registerConnection, setConnectionFocus,
} from '@/lib/server/agent/eventConnections';

type Frame = Record<string, any>;

/** Read an SSE body until `until(frames)` holds (or the stream ends). */
async function readFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  until: (frames: Frame[]) => boolean,
): Promise<{ frames: Frame[]; done: boolean }> {
  const decoder = new TextDecoder();
  let buf = '';
  const frames: Frame[] = [];
  for (let i = 0; i < 200; i++) {
    const next = await Promise.race([
      reader.read(),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2000)),
    ]);
    if (next === 'timeout') throw new Error(`SSE read timed out after ${frames.length} frames`);
    if (next.done) return { frames, done: true };
    buf += decoder.decode(next.value, { stream: true });
    let cut: number;
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      for (const line of block.split('\n')) {
        if (line.startsWith('data: ')) frames.push(JSON.parse(line.slice(6)));
      }
    }
    if (until(frames)) return { frames, done: false };
  }
  throw new Error('SSE read: too many chunks');
}

const hasHeartbeat = (frames: Frame[]) => frames.some((f) => f.type === 'heartbeat');

describe('registerConnection identity (G8)', () => {
  beforeEach(() => { bus.markSessionRead.mockReset(); });

  it('a second stream on the same connId closes the first once; its late unregister leaves the second registered', async () => {
    const sendA = vi.fn();
    const sendB = vi.fn();
    let unregA: () => void = () => {};
    // The route's close() calls its own unregister, synchronously.
    const closeA = vi.fn(() => unregA());
    const closeB = vi.fn();
    unregA = registerConnection({
      connId: 'identity-conn-1', send: sendA, close: closeA,
      initialFocus: 'S1', initialFocusSeq: 1, initialVisible: true,
    });
    const unregB = registerConnection({
      connId: 'identity-conn-1', send: sendB, close: closeB,
      initialFocus: 'S1', initialFocusSeq: 1, initialVisible: true,
    });
    expect(closeA).toHaveBeenCalledTimes(1);
    expect(closeA).toHaveBeenCalledWith('superseded');
    expect(closeB).not.toHaveBeenCalled();

    // The superseded stream's abort/cancel fires late — must be a no-op for B.
    unregA();
    unregA();
    expect(focusCountFor('S1')).toBe(1);

    bus.emit({ type: 'assistant_text', sessionId: 'S1', delta: 'hi' });
    bus.emit({ type: 'status', sessionId: 'S9', status: 'active' });
    expect(sendA).not.toHaveBeenCalled();
    expect(sendB).toHaveBeenCalledTimes(2);

    // A focus POST on the replacement applies (it is registered).
    const { POST } = await import('@/app/api/claude/focus/route');
    const res = await POST(new Request('http://localhost/api/claude/focus', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conn: 'identity-conn-1', sessionId: 'S2', focusSeq: 2, visible: true }),
    }));
    expect(await res.json()).toEqual({ ok: true, applied: true, focus: 'S2', focusSeq: 2 });
    expect(bus.markSessionRead).toHaveBeenCalledWith('S2');

    unregB();
    expect(focusCountFor('S2')).toBe(0);
    expect(setConnectionFocus('identity-conn-1', 'S3', 3).ok).toBe(false);
    expect(closeB).not.toHaveBeenCalled();
  });

  it('a superseded stream whose close is a no-op is still detached from the bus', () => {
    const sendA = vi.fn();
    const sendB = vi.fn();
    const unregA = registerConnection({ connId: 'identity-conn-2', send: sendA, initialFocus: 'S1' });
    const unregB = registerConnection({ connId: 'identity-conn-2', send: sendB, initialFocus: 'S1' });
    bus.emit({ type: 'assistant_text', sessionId: 'S1', delta: 'x' });
    expect(sendA).not.toHaveBeenCalled();
    expect(sendB).toHaveBeenCalledTimes(1);
    unregA();
    expect(focusCountFor('S1')).toBe(1);
    unregB();
    expect(focusCountFor('S1')).toBe(0);
    expect(bus.subs.size).toBe(0);
  });

  it('a conn registered without `send` (push transport) subscribes nothing on the session bus', () => {
    const unreg = registerConnection({ connId: 'identity-conn-3', push: () => {}, initialFocus: 'S1' });
    expect(bus.subs.size).toBe(0);
    expect(focusCountFor('S1')).toBe(1);
    unreg();
    expect(focusCountFor('S1')).toBe(0);
  });
});

describe('setConnectionFocus sequencing', () => {
  let unreg: () => void = () => {};
  afterEach(() => unreg());

  it('seq < cur is not applied', () => {
    unreg = registerConnection({ connId: 'seq-conn-1', send: () => {}, initialFocus: 'A', initialFocusSeq: 5 });
    expect(setConnectionFocus('seq-conn-1', 'B', 4)).toEqual({ ok: true, applied: false, focus: 'A', focusSeq: 5 });
    expect(focusCountFor('A')).toBe(1);
  });

  it('seq === cur on the same session re-applies presence idempotently (applied:true)', () => {
    unreg = registerConnection({
      connId: 'seq-conn-2', send: () => {}, initialFocus: 'A', initialFocusSeq: 5, initialVisible: false,
    });
    // Hidden ⇒ a finish is not "watched"; the same POST re-sent visible is.
    expect(setConnectionFocus('seq-conn-2', 'A', 5, true)).toEqual({ ok: true, applied: true, focus: 'A', focusSeq: 5 });
    return import('@/lib/server/agent/eventConnections').then(({ isBeingWatched }) => {
      expect(isBeingWatched('A')).toBe(true);
      expect(setConnectionFocus('seq-conn-2', 'A', 5, false)).toMatchObject({ applied: true });
      expect(isBeingWatched('A')).toBe(false);
    });
  });

  it('seq === cur on the same session with routingOnly leaves presence untouched', async () => {
    const { isBeingWatched } = await import('@/lib/server/agent/eventConnections');
    unreg = registerConnection({
      connId: 'seq-conn-3', send: () => {}, initialFocus: 'A', initialFocusSeq: 5, initialVisible: false,
    });
    expect(setConnectionFocus('seq-conn-3', 'A', 5, true, { routingOnly: true }))
      .toEqual({ ok: true, applied: true, focus: 'A', focusSeq: 5 });
    expect(isBeingWatched('A')).toBe(false);
  });

  it('seq === cur on another session is not applied', () => {
    unreg = registerConnection({ connId: 'seq-conn-4', send: () => {}, initialFocus: 'A', initialFocusSeq: 5 });
    expect(setConnectionFocus('seq-conn-4', 'B', 5)).toEqual({ ok: true, applied: false, focus: 'A', focusSeq: 5 });
    expect(focusCountFor('B')).toBe(0);
  });

  it('seq > cur applies; routingOnly moves focus/focusSeq only', async () => {
    const { isBeingWatched } = await import('@/lib/server/agent/eventConnections');
    unreg = registerConnection({
      connId: 'seq-conn-5', send: () => {}, initialFocus: 'A', initialFocusSeq: 5, initialVisible: false,
    });
    expect(setConnectionFocus('seq-conn-5', 'B', 6, true, { routingOnly: true }))
      .toEqual({ ok: true, applied: true, focus: 'B', focusSeq: 6 });
    expect(focusCountFor('B')).toBe(1);
    expect(isBeingWatched('B')).toBe(false);   // still hidden: presence untouched
    expect(setConnectionFocus('seq-conn-5', 'C', 7, true))
      .toEqual({ ok: true, applied: true, focus: 'C', focusSeq: 7 });
    expect(isBeingWatched('C')).toBe(true);
  });

  it('an unknown conn is ok:false and is never created', () => {
    expect(setConnectionFocus('seq-conn-unknown', 'A', 1)).toEqual({ ok: false, applied: false, focus: null, focusSeq: 0 });
    expect(focusCountFor('A')).toBe(0);
  });
});

describe('GET /api/claude/events (legacy body)', () => {
  let db: any;
  let schema: any;
  let GET: (req: Request) => Promise<Response>;

  beforeAll(async () => {
    const dbMod = await import('@/lib/db');
    db = dbMod.db;
    schema = dbMod;
    const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
    migrate(db, { migrationsFolder: './drizzle' });
    db.insert(schema.vpsFolders).values({ id: 'default', name: 'default', position: 0 }).onConflictDoNothing().run();
    ({ GET } = await import('@/app/api/claude/events/route'));
  });

  beforeEach(() => {
    bus.streams.clear();
    db.delete(schema.claudePendingPermissions).run();
    db.delete(schema.claudePendingQuestions).run();
    db.delete(schema.claudeSessions).run();
    db.delete(schema.vps).run();
  });

  const open = (conn: string, extra = '') => {
    const ac = new AbortController();
    const res = GET(new Request(`http://localhost/api/claude/events?conn=${conn}&focus=S1&focusSeq=1${extra}`, {
      signal: ac.signal,
    }));
    return { ac, res };
  };

  it('a reconnect on the same conn ends the previous stream and stays registered', async () => {
    const first = open('route-identity-conn');
    const r1 = (await first.res).body!.getReader();
    await readFrames(r1, hasHeartbeat);
    expect(focusCountFor('S1')).toBe(1);

    const second = open('route-identity-conn');
    const r2 = (await second.res).body!.getReader();
    await readFrames(r2, hasHeartbeat);
    // The superseded stream ENDS (its heartbeat with it) …
    const rest = await readFrames(r1, () => false);
    expect(rest.done).toBe(true);
    // … and its abort, arriving late, does not unregister the new one.
    first.ac.abort();
    expect(focusCountFor('S1')).toBe(1);
    bus.emit({ type: 'assistant_text', sessionId: 'S1', delta: 'live' });
    const live = await readFrames(r2, (f) => f.some((x) => x.type === 'assistant_text'));
    expect(live.frames.find((x) => x.type === 'assistant_text')).toMatchObject({ delta: 'live' });

    await r2.cancel();
    expect(focusCountFor('S1')).toBe(0);
  });

  it('snapshots derived VPS keys, skips archived rows, sends unread + bg counts and ONE pending_snapshot', async () => {
    db.insert(schema.vps).values({
      id: 'vps-a', name: 'a', ip: '127.0.0.1', sshUser: 'root', agentStatus: 'ok',
      cursorAvailable: 1, cursorSdkVersion: '1.2.3', cursorLoggedIn: 1, codexLoggedIn: 0,
    }).run();
    const session = (id: string, extra: Record<string, unknown>) => db.insert(schema.claudeSessions).values({
      id, vpsId: 'vps-a', cwd: '/tmp', name: id, status: 'active', ...extra,
    }).run();
    session('S-live', { unreadStop: 1 });
    session('S-arch', { unreadStop: 1, archived: 1, status: 'sleeping' });
    session('S-bg', { status: 'background' });
    session('S-read', { unreadStop: 0 });
    bus.streams.set('S-bg', { status: 'background', runningBgTaskCount: () => 2 });
    bus.streams.set('S-read', { status: 'thinking', runningBgTaskCount: () => 0 });
    bus.streams.set('S-arch', { status: 'sleeping', runningBgTaskCount: () => 3 });

    db.insert(schema.claudePendingPermissions).values([
      { id: 'perm-1', sessionId: 'S-live', toolName: 'Bash', toolInput: '{"command":"ls"}' },
      { id: 'perm-done', sessionId: 'S-live', toolName: 'Bash', toolInput: '{}', status: 'allowed' },
    ]).run();
    db.insert(schema.claudePendingQuestions).values([
      { id: 'q-async', sessionId: 'S-live', kind: 'async_question', payload: '[{"question":"why?"}]' },
      { id: 'q-block', sessionId: 'S-read', kind: 'question', payload: '[{"question":"ok?"}]' },
      { id: 'plan-1', sessionId: 'S-bg', kind: 'exit_plan', payload: '{"plan":"do it"}' },
    ]).run();

    const { ac, res } = open('route-snapshot-conn', '&attentive=0');
    const reader = (await res).body!.getReader();
    const { frames } = await readFrames(reader, hasHeartbeat);
    ac.abort();

    const vpsStatus = frames.find((f) => f.type === 'vps_status' && f.sessionId === 'vps-a');
    expect(vpsStatus).toMatchObject({
      agentStatus: 'ok', cursorAvailable: 1, cursorSdkVersion: '1.2.3', cursorLoggedIn: 1, codexLoggedIn: 0,
    });

    const statuses = frames.filter((f) => f.type === 'status');
    expect(statuses.map((f) => [f.sessionId, f.status]).sort()).toEqual([
      ['S-bg', 'background'], ['S-live', 'active'], ['S-read', 'thinking'],
    ]);
    const unread = frames.filter((f) => f.type === 'session_unread');
    expect(unread).toEqual([{ type: 'session_unread', sessionId: 'S-live', unread: true }]);
    const bg = frames.filter((f) => f.type === 'session_bg_tasks');
    expect(bg).toEqual([{ type: 'session_bg_tasks', sessionId: 'S-bg', running: 2 }]);
    const lastStatus = frames.lastIndexOf(statuses[statuses.length - 1]);
    expect(frames.indexOf(unread[0])).toBeGreaterThan(lastStatus);
    expect(frames.indexOf(bg[0])).toBeGreaterThan(lastStatus);

    const snapshots = frames.filter((f) => f.type === 'pending_snapshot');
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toEqual({
      type: 'pending_snapshot', sessionId: 'pending',
      permissions: [{ id: 'perm-1', sessionId: 'S-live' }],
      questions: expect.arrayContaining([
        { id: 'q-async', sessionId: 'S-live', delivery: 'async' },
        { id: 'q-block', sessionId: 'S-read' },
      ]),
      exitPlans: [{ id: 'plan-1', sessionId: 'S-bg' }],
    });
    expect(snapshots[0].questions).toHaveLength(2);
    // After every pending replay.
    const lastReplay = Math.max(...frames
      .map((f, i) => (['permission_request', 'user_question', 'exit_plan_request'].includes(f.type) ? i : -1)));
    expect(lastReplay).toBeGreaterThan(-1);
    expect(frames.indexOf(snapshots[0])).toBeGreaterThan(lastReplay);
  });

  it('an empty pending set still sends ONE (empty) pending_snapshot', async () => {
    const { ac, res } = open('route-empty-conn');
    const reader = (await res).body!.getReader();
    const { frames } = await readFrames(reader, hasHeartbeat);
    ac.abort();
    expect(frames.filter((f) => f.type === 'pending_snapshot')).toEqual([
      { type: 'pending_snapshot', sessionId: 'pending', permissions: [], questions: [], exitPlans: [] },
    ]);
  });
});
