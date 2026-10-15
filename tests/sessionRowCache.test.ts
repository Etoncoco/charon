import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, asc, eq, like, or } from 'drizzle-orm';

// Incremental row caches (C03): the folds behind token totals, recorded turn
// usage and the background-task registry read only rows newer than their
// cached state, validate it on every call, warm cold sessions in slices and
// evict idle entries. Reference = the pre-C03 full scans, verbatim.

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/session', () => ({ requireApiSession: vi.fn(async () => ({})) }));
vi.mock('@/lib/server/claude/sessionRpc', () => ({ callSessionRpc: vi.fn(async () => ({})) }));
const agentCall = vi.hoisted(() => vi.fn(async (..._args: any[]): Promise<any> => ({})));
vi.mock('@/lib/server/agent/AgentClientPool', () => ({
  getAgentClientForVpsId: () => ({ call: agentCall, setAfterSeq: () => {}, subscribe: () => {}, unsubscribe: () => {}, resubscribe: () => {} }),
  getAgentClient: () => ({}),
  dropAgentClient: async () => {},
}));
// The VPS route re-arms hooks on PATCH only; DELETE never reaches it.
vi.mock('@/lib/server/agent/autoConnect', () => ({ armAgentClientHooks: () => {} }));

type Mod = typeof import('@/lib/server/agent/sessionRowCache');
let db: any;
let schema: any;
let rawSqlite: () => import('better-sqlite3').Database;
let rowCache: Mod;
let sessionTokenUsage: typeof import('@/lib/server/agent/sessionTokenUsage').sessionTokenUsage;
let recordedSessionUsage: typeof import('@/lib/server/agent/sessionUsage').recordedSessionUsage;
let bgTaskRowsFromDb: typeof import('@/lib/server/claude/bgTaskState').bgTaskRowsFromDb;

const VPS = 'rowcache-vps';
let sessionCounter = 0;

function newSession(kind = 'codex', status = 'active'): string {
  const id = (++sessionCounter).toString(16).padStart(32, '0');
  db.insert(schema.claudeSessions).values({ id, vpsId: VPS, cwd: '/tmp', name: 'rc', status, kind }).run();
  return id;
}

function insert(sessionId: string, role: string, content: unknown, tsMs?: number): number {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return Number(db.insert(schema.claudeSessionMessages)
    .values({ sessionId, role, content: text, ...(tsMs != null ? { tsMs } : {}) }).run().lastInsertRowid);
}

// ── References: the full scans C03 replaced, verbatim (ORDER BY id) ──────────
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

function refTokens(sessionId: string) {
  const m = schema.claudeSessionMessages;
  const rows = db.select({ id: m.id, content: m.content }).from(m).where(and(
    eq(m.sessionId, sessionId), eq(m.role, 'event'),
    or(like(m.content, '%"type":"endpoint_usage"%'), like(m.content, '%"type":"turn_usage"%')),
  )).orderBy(asc(m.id)).all();
  const result: any = {
    revision: 0, inputTokens: null, outputTokens: null, totalTokens: null,
    requests: 0, legacyTurns: 0, missingInput: 0, missingOutput: 0, missingTotal: 0, partial: false,
  };
  const requests = new Set<string>();
  for (const row of rows) {
    let e;
    try { e = JSON.parse(row.content); } catch { continue; }
    if (!e || !['endpoint_usage', 'turn_usage'].includes(e.type)) continue;
    result.revision = row.id;
    let input: number | null, output: number | null, total: number | null;
    if (e.type === 'endpoint_usage') {
      if (typeof e.requestId !== 'string' || requests.has(e.requestId)) continue;
      requests.add(e.requestId);
      result.requests++;
      input = count(e.inputTokens); output = count(e.outputTokens); total = count(e.totalTokens);
      if (e.partial) result.partial = true;
    } else {
      if (e.endpointAccounted) continue;
      result.legacyTurns++;
      result.partial = true;
      const u = e.tree;
      input = count(u?.input_tokens ?? e.inputTokens);
      output = count(u?.output_tokens ?? e.outputTokens);
      if (e.provider === 'claude' && input !== null) {
        input += count(u?.cache_read_tokens ?? e.cacheReadTokens) ?? 0;
        input += count(u?.cache_write_tokens ?? e.cacheWriteTokens) ?? 0;
      }
      if (input === 0 && output === 0) input = output = null;
      total = input !== null && output !== null ? input + output : null;
    }
    if (input === null) result.missingInput++; else result.inputTokens = (result.inputTokens ?? 0) + input;
    if (output === null) result.missingOutput++; else result.outputTokens = (result.outputTokens ?? 0) + output;
    if (total === null) result.missingTotal++; else result.totalTokens = (result.totalTokens ?? 0) + total;
  }
  return result;
}

function refRecorded(sessionId: string) {
  const m = schema.claudeSessionMessages;
  const rows = db.select({ content: m.content }).from(m).where(and(
    eq(m.sessionId, sessionId), eq(m.role, 'event'), like(m.content, '%"type":"turn_usage"%'),
  )).orderBy(asc(m.id)).all();
  const total: any = {
    turns: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
    duration_ms: 0, cost_usd: 0, models: [],
  };
  const models = new Set<string>();
  const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;
  for (const row of rows) {
    try {
      const event = JSON.parse(row.content);
      if (event?.type !== 'turn_usage') continue;
      const inclusive = event.tree && typeof event.tree === 'object' ? event.tree : null;
      total.turns += 1;
      total.input_tokens += num(inclusive?.input_tokens ?? event.inputTokens);
      total.output_tokens += num(inclusive?.output_tokens ?? event.outputTokens);
      total.cache_read_tokens += num(inclusive?.cache_read_tokens ?? event.cacheReadTokens);
      total.cache_write_tokens += num(inclusive?.cache_write_tokens ?? event.cacheWriteTokens);
      total.duration_ms += num(event.durationMs);
      total.cost_usd += num(inclusive?.cost_usd ?? event.costUsd);
      if (Array.isArray(inclusive?.models)) {
        for (const model of inclusive.models) if (typeof model === 'string') models.add(model);
      }
    } catch { /* corrupt */ }
  }
  if (!total.turns) return null;
  total.cost_usd = Math.round(total.cost_usd * 1_000_000) / 1_000_000;
  total.models = [...models].sort();
  return total;
}

function refBg(sessionId: string) {
  const m = schema.claudeSessionMessages;
  return db.select({ content: m.content, createdAt: m.createdAt, seq: m.seq, tsMs: m.tsMs }).from(m).where(and(
    eq(m.sessionId, sessionId), eq(m.role, 'event'), like(m.content, '%"bg_task"%'),
  )).orderBy(asc(m.id)).all();
}

// ── Random interleavings ────────────────────────────────────────────────────
function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function insertRandomRow(rnd: () => number, sessionId: string, i: number): void {
  const n = () => (rnd() < 0.15 ? null : Math.floor(rnd() * 500));
  const pick = rnd();
  // Mostly increasing ts, sometimes a "repaired" row dated in the past: ids
  // still increase, so the fold order (id) is unaffected.
  const ts = 1_800_000_000_000 + i * 10 - (rnd() < 0.05 ? 5_000 : 0);
  if (pick < 0.12) insert(sessionId, 'user', `prompt ${i}`, ts);
  else if (pick < 0.2) insert(sessionId, 'assistant', `answer ${i}`, ts);
  else if (pick < 0.27) insert(sessionId, 'tool_use', { id: `tu${i}`, name: 'Bash', input: {} }, ts);
  else if (pick < 0.37) {
    // Quoted JSON inside text is stored ESCAPED: it never matches the LIKE.
    insert(sessionId, 'event', { type: 'thinking', text: `see {"type":"endpoint_usage","requestId":"r1"} "bg_task" ${i}` }, ts);
  } else if (pick < 0.57) {
    insert(sessionId, 'event', {
      type: 'endpoint_usage',
      // A small pool ⇒ many duplicate request ids; sometimes not a string.
      requestId: rnd() < 0.08 ? 42 : `r${Math.floor(rnd() * 8)}`,
      inputTokens: n(), outputTokens: n(), totalTokens: n(), partial: rnd() < 0.2,
    }, ts);
  } else if (pick < 0.77) {
    const zero = rnd() < 0.1;
    insert(sessionId, 'event', {
      type: 'turn_usage', provider: rnd() < 0.5 ? 'claude' : 'codex',
      outputTokens: zero ? 0 : n(), inputTokens: zero ? 0 : n() ?? 0,
      cacheReadTokens: Math.floor(rnd() * 50), cacheWriteTokens: Math.floor(rnd() * 20),
      durationMs: Math.floor(rnd() * 3000), costUsd: rnd() < 0.3 ? null : rnd() / 100,
      ...(rnd() < 0.3 ? { endpointAccounted: true } : {}),
      ...(rnd() < 0.4 ? { tree: {
        input_tokens: n(), output_tokens: n(), cache_read_tokens: n(), cache_write_tokens: n(),
        cost_usd: rnd() / 50, models: [`model-${Math.floor(rnd() * 4)}`],
      } } : {}),
    }, ts);
  } else if (pick < 0.93) {
    const kinds = ['started', 'updated', 'finished'];
    insert(sessionId, 'event', {
      type: 'bg_task', kind: kinds[Math.floor(rnd() * 3)], taskId: `t${Math.floor(rnd() * 5)}`,
      ...(rnd() < 0.5 ? { status: rnd() < 0.5 ? 'running' : 'completed' } : {}),
    }, ts);
  } else {
    // Corrupt rows that DO match the LIKE: skipped by both folds.
    insert(sessionId, 'event', rnd() < 0.5 ? '{"type":"turn_usage", oops' : '{"type":"endpoint_usage" "bg_task" broken', ts);
  }
}

const KEYS = ['tokens', 'recorded', 'bg'] as const;

function check(key: typeof KEYS[number], sessionId: string): void {
  if (key === 'tokens') expect(sessionTokenUsage(sessionId)).toEqual(refTokens(sessionId));
  else if (key === 'recorded') expect(recordedSessionUsage(sessionId)).toEqual({ usage: refRecorded(sessionId), pending: false });
  else expect(bgTaskRowsFromDb(sessionId)).toEqual(refBg(sessionId));
}

beforeAll(async () => {
  const dbMod = await import('@/lib/db');
  db = dbMod.db;
  schema = dbMod;
  rawSqlite = dbMod.rawSqlite;
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: './drizzle' });
  db.insert(schema.vpsFolders).values({ id: 'default', name: 'default', position: 0 }).onConflictDoNothing().run();
  db.insert(schema.vps).values({ id: VPS, name: 'rc', ip: '127.0.0.1', sshUser: 'root' }).onConflictDoNothing().run();
  rowCache = await import('@/lib/server/agent/sessionRowCache');
  ({ sessionTokenUsage } = await import('@/lib/server/agent/sessionTokenUsage'));
  ({ recordedSessionUsage } = await import('@/lib/server/agent/sessionUsage'));
  ({ bgTaskRowsFromDb } = await import('@/lib/server/claude/bgTaskState'));
});

beforeEach(() => {
  rowCache.invalidateSessionRowCaches();
  agentCall.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('incremental fold == reference full scan', () => {
  it.each(KEYS)('%s: after every insert of a random interleaving (two sessions, dup request ids, endpointAccounted)', (key) => {
    const a = newSession();
    const b = newSession();
    const rnd = mulberry32(KEYS.indexOf(key) + 7);
    for (let i = 0; i < 260; i++) {
      insertRandomRow(rnd, rnd() < 0.75 ? a : b, i);
      check(key, a);
      if (i % 5 === 0) check(key, b);
    }
    check(key, b);
  });

  it('all three folds side by side, through a mid-sequence invalidation (cold re-fold)', () => {
    const a = newSession();
    const rnd = mulberry32(99);
    for (let i = 0; i < 200; i++) {
      insertRandomRow(rnd, a, i);
      if (i === 120) rowCache.invalidateSessionRowCaches(a);
      for (const key of KEYS) check(key, a);
    }
  });

  it('after the first fold a call reads only the rows inserted since (no O(session) scan)', () => {
    const a = newSession();
    const rnd = mulberry32(3);
    for (let i = 0; i < 400; i++) insertRandomRow(rnd, a, i);
    sessionTokenUsage(a);
    const before = rowCache.sessionRowCacheStats().rowsScanned;
    sessionTokenUsage(a);
    expect(rowCache.sessionRowCacheStats().rowsScanned).toBe(before);
    insert(a, 'event', { type: 'endpoint_usage', requestId: 'fresh', inputTokens: 1, outputTokens: 2, totalTokens: 3 });
    insert(a, 'user', 'not matched');
    expect(sessionTokenUsage(a)).toEqual(refTokens(a));
    expect(rowCache.sessionRowCacheStats().rowsScanned).toBe(before + 1);
  });

  it('returned states never alias the accumulator', () => {
    const a = newSession();
    insert(a, 'event', { type: 'endpoint_usage', requestId: 'x', inputTokens: 10, outputTokens: 1, totalTokens: 11 });
    insert(a, 'event', { type: 'bg_task', kind: 'started', taskId: 't1' });
    insert(a, 'event', { type: 'turn_usage', provider: 'codex', inputTokens: 5, outputTokens: 5, tree: { models: ['m'] } });
    const usage = sessionTokenUsage(a)!;
    usage.inputTokens = 999_999;
    const rows = bgTaskRowsFromDb(a);
    rows.length = 0;
    const recorded = recordedSessionUsage(a).usage!;
    recorded.models.push('mutated');
    recorded.turns = 50;
    expect(sessionTokenUsage(a)).toEqual(refTokens(a));
    expect(bgTaskRowsFromDb(a)).toEqual(refBg(a));
    expect(recordedSessionUsage(a).usage).toEqual(refRecorded(a));
  });
});

describe('validation', () => {
  it('a wipe and reinsert under the same SID resets every fold', () => {
    const a = newSession();
    const rnd = mulberry32(11);
    for (let i = 0; i < 80; i++) insertRandomRow(rnd, a, i);
    for (const key of KEYS) check(key, a);
    // The harness pattern of many test files: wipe the rows, reuse the SID.
    db.delete(schema.claudeSessionMessages).where(eq(schema.claudeSessionMessages.sessionId, a)).run();
    for (let i = 0; i < 30; i++) insertRandomRow(rnd, a, i);
    for (const key of KEYS) check(key, a);
    // Wiped with nothing after: max(id) fell below the cached position.
    db.delete(schema.claudeSessionMessages).where(eq(schema.claudeSessionMessages.sessionId, a)).run();
    for (const key of KEYS) check(key, a);
    expect(sessionTokenUsage(a)).toMatchObject({ revision: 0, requests: 0, totalTokens: null });
  });

  it('a suffix delete below the last hit is detected by max(id)', () => {
    const a = newSession();
    insert(a, 'event', { type: 'endpoint_usage', requestId: 'keep', inputTokens: 1, outputTokens: 1, totalTokens: 2 });
    const tail = [insert(a, 'user', 'u1'), insert(a, 'user', 'u2')];
    expect(sessionTokenUsage(a)).toEqual(refTokens(a));
    db.delete(schema.claudeSessionMessages).where(eq(schema.claudeSessionMessages.id, tail[1])).run();
    const dropped = rowCache.sessionRowCacheStats().dropped;
    expect(sessionTokenUsage(a)).toEqual(refTokens(a));
    expect(rowCache.sessionRowCacheStats().dropped).toBe(dropped + 1);
  });

  it('rollback keeps the token totals and the bg registry loses the rewound rows', async () => {
    const a = newSession('codex', 'active');
    insert(a, 'event', { type: 'bg_task', kind: 'started', taskId: 'early' }, 1_000);
    insert(a, 'event', { type: 'endpoint_usage', requestId: 'r1', inputTokens: 100, outputTokens: 20, totalTokens: 120 }, 1_100);
    const user = insert(a, 'user', 'rewind me', 2_000);
    insert(a, 'event', { type: 'bg_task', kind: 'started', taskId: 'rewound' }, 3_000);
    insert(a, 'event', { type: 'endpoint_usage', requestId: 'r2', inputTokens: 50, outputTokens: 5, totalTokens: 55 }, 3_100);
    // A late row dated BEFORE the rewind point (hub-originated, repaired): it
    // survives and stays the fold's last hit, so only the route's explicit
    // invalidation can drop the rewound bg row from the cache.
    insert(a, 'event', { type: 'bg_task', kind: 'finished', taskId: 'early' }, 1_500);
    const tokensBefore = sessionTokenUsage(a);
    expect(bgTaskRowsFromDb(a).map((r) => JSON.parse(r.content).taskId)).toEqual(['early', 'rewound', 'early']);

    const { POST } = await import('@/app/api/claude/sessions/[id]/rollback/route');
    const res = await POST(new Request(`http://localhost/api/claude/sessions/${a}/rollback`, {
      method: 'POST', body: JSON.stringify({ messageId: `m${user}` }),
    }), { params: Promise.resolve({ id: a }) });
    expect(res.status).toBe(200);
    expect(agentCall).toHaveBeenCalledWith('rollback_session', expect.objectContaining({ session_id: a }));

    expect(sessionTokenUsage(a)).toEqual(tokensBefore);
    expect(sessionTokenUsage(a)).toEqual(refTokens(a));
    expect(bgTaskRowsFromDb(a).map((r) => JSON.parse(r.content).taskId)).toEqual(['early', 'early']);
    expect(bgTaskRowsFromDb(a)).toEqual(refBg(a));
  });
});

describe('deletion paths free the folds (I11)', () => {
  it('deleting a VPS frees the folds of every session its cascade takes', async () => {
    const vpsId = 'rowcache-vps-gone';
    db.insert(schema.vps).values({ id: vpsId, name: 'gone', ip: '127.0.0.2', sshUser: 'root' }).run();
    const goneSession = (): string => {
      const id = (++sessionCounter).toString(16).padStart(32, '0');
      db.insert(schema.claudeSessions).values({ id, vpsId, cwd: '/tmp', name: 'gone', status: 'sleeping', kind: 'codex' }).run();
      return id;
    };
    const gone = [goneSession(), goneSession()];
    const kept = newSession();
    for (const sid of [...gone, kept]) {
      insert(sid, 'event', { type: 'endpoint_usage', requestId: 'x', inputTokens: 1, outputTokens: 1, totalTokens: 2 });
      insert(sid, 'event', { type: 'turn_usage', provider: 'codex', inputTokens: 3, outputTokens: 1 });
      insert(sid, 'event', { type: 'bg_task', kind: 'started', taskId: 't' });
      for (const key of KEYS) check(key, sid);
    }
    expect(rowCache.sessionRowCacheStats().entries).toBe(9);

    const { DELETE } = await import('@/app/api/vps/[id]/route');
    const res = await DELETE(new Request(`http://localhost/api/vps/${vpsId}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: vpsId }) });
    expect(res.status).toBe(200);
    const m = schema.claudeSessionMessages;
    for (const sid of gone) expect(db.select().from(m).where(eq(m.sessionId, sid)).all()).toEqual([]);
    // Only the surviving session's three folds stay in memory.
    expect(rowCache.sessionRowCacheStats().entries).toBe(3);
    for (const key of KEYS) check(key, kept);
    expect(rowCache.sessionRowCacheStats().entries).toBe(3);
  });
});

describe('cold folds are sliced', () => {
  function sliceOpts(onComplete?: (s: { ids: number[] }) => void) {
    let steps = 0;
    return {
      steps: () => steps,
      opts: {
        likes: ['%"type":"turn_usage"%'],
        init: () => ({ ids: [] as number[] }),
        clone: (s: { ids: number[] }) => ({ ids: [...s.ids] }),
        step: (s: { ids: number[] }, row: { id: number }) => { steps++; s.ids.push(row.id); return true; },
        sliceRows: 7,
        onComplete,
      },
    };
  }

  it('answers complete:false, finishes in ONE background chain, then onComplete equals the full scan', async () => {
    const a = newSession();
    const all: number[] = [];
    const sessionRows: number[] = [];
    for (let i = 0; i < 50; i++) {
      const id = i % 3 === 0
        ? insert(a, 'event', { type: 'turn_usage', provider: 'codex', inputTokens: i, outputTokens: 1 })
        : insert(a, 'user', `u${i}`);
      sessionRows.push(id);
      if (i % 3 === 0) all.push(id);
    }
    const completions: Array<{ ids: number[] }> = [];
    let resolve!: (s: { ids: number[] }) => void;
    const done = new Promise<{ ids: number[] }>((r) => { resolve = r; });
    const { opts, steps } = sliceOpts((s) => { completions.push(s); resolve(s); });

    const slicesBefore = rowCache.sessionRowCacheStats().slices;
    const first = rowCache.foldSessionEventRows('recorded', a, opts);
    expect(first.complete).toBe(false);
    // ONE synchronous slice = the first 7 session rows.
    expect(first.state.ids).toEqual(all.filter((id) => id <= sessionRows[6]));
    expect(steps()).toBe(first.state.ids.length);
    expect(rowCache.sessionRowCacheStats().chains).toBe(1);

    // A second synchronous call while warming advances one more slice and
    // never starts a second chain.
    const second = rowCache.foldSessionEventRows('recorded', a, opts);
    expect(second.complete).toBe(false);
    expect(second.state.ids).toEqual(all.filter((id) => id <= sessionRows[13]));
    expect(rowCache.sessionRowCacheStats().chains).toBe(1);

    const final = await done;
    expect(final.ids).toEqual(all);
    expect(completions).toHaveLength(1);
    expect(rowCache.sessionRowCacheStats().chains).toBe(0);
    expect(rowCache.sessionRowCacheStats().slices - slicesBefore).toBe(Math.ceil(50 / 7));
    const again = rowCache.foldSessionEventRows('recorded', a, opts);
    expect(again).toEqual({ state: { ids: all }, complete: true });
  });

  it('an invalidation stops the background chain', async () => {
    const a = newSession();
    for (let i = 0; i < 30; i++) insert(a, 'event', { type: 'turn_usage', provider: 'codex', inputTokens: i });
    const onComplete = vi.fn();
    const { opts } = sliceOpts(onComplete);
    expect(rowCache.foldSessionEventRows('recorded', a, opts).complete).toBe(false);
    rowCache.invalidateSessionRowCaches(a);
    for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));
    expect(onComplete).not.toHaveBeenCalled();
    expect(rowCache.sessionRowCacheStats()).toMatchObject({ entries: 0, chains: 0 });
  });
});

describe('eviction and module copies', () => {
  it('drops entries untouched for 30 min (one unref sweeper, stopped when empty)', () => {
    vi.useFakeTimers();
    rowCache.invalidateSessionRowCaches();   // the sweeper restarts under fake timers
    const a = newSession();
    const b = newSession();
    insert(a, 'event', { type: 'endpoint_usage', requestId: 'x', inputTokens: 1, outputTokens: 1, totalTokens: 2 });
    insert(b, 'event', { type: 'bg_task', kind: 'started', taskId: 't' });
    sessionTokenUsage(a);
    bgTaskRowsFromDb(b);
    expect(rowCache.sessionRowCacheStats()).toMatchObject({ entries: 2, sweeping: true });
    vi.advanceTimersByTime(20 * 60_000);
    bgTaskRowsFromDb(b);                     // touched at 20 min
    vi.advanceTimersByTime(11 * 60_000);     // a: 31 min idle, b: 11
    expect(rowCache.sessionRowCacheStats()).toMatchObject({ entries: 1, sweeping: true });
    vi.advanceTimersByTime(20 * 60_000);     // b: 31 min idle
    expect(rowCache.sessionRowCacheStats()).toMatchObject({ entries: 0, sweeping: false });
    // An evicted entry simply re-folds.
    expect(sessionTokenUsage(a)).toEqual(refTokens(a));
    expect(rowCache.sessionRowCacheStats()).toMatchObject({ entries: 1, sweeping: true });
  });

  it('a vi.resetModules() twin shares the cache (globalThis.__charonRowCaches)', async () => {
    const a = newSession();
    const rnd = mulberry32(5);
    for (let i = 0; i < 60; i++) insertRandomRow(rnd, a, i);
    const usage = sessionTokenUsage(a);
    const scanned = rowCache.sessionRowCacheStats().rowsScanned;
    vi.resetModules();
    const twinCache: Mod = await import('@/lib/server/agent/sessionRowCache');
    const twin = await import('@/lib/server/agent/sessionTokenUsage');
    expect(twinCache).not.toBe(rowCache);
    expect(twin.sessionTokenUsage(a)).toEqual(usage);
    // Served from the shared entry: nothing re-read.
    expect(twinCache.sessionRowCacheStats().rowsScanned).toBe(scanned);
    twinCache.invalidateSessionRowCaches(a);
    expect(rowCache.sessionRowCacheStats().entries).toBe(0);
  });
});

describe('observability', () => {
  it('every fold (synchronous slice or background continuation) is timed as `fold:<key>`', async () => {
    const lag = await import('@/lib/server/perf/loopLag');
    let t = 0;
    const warn = vi.fn();
    // Each clock read advances 300 ms: every section is slow (ring + warn).
    lag.startLoopLagMonitor({ now: () => (t += 300), warn });
    try {
      const a = newSession();
      insert(a, 'event', { type: 'endpoint_usage', requestId: 'x', inputTokens: 1, outputTokens: 1, totalTokens: 2 });
      sessionTokenUsage(a);
      recordedSessionUsage(a);
      bgTaskRowsFromDb(a);
      const b = newSession();
      for (let i = 0; i < 20; i++) insert(b, 'event', { type: 'turn_usage', provider: 'codex', inputTokens: i });
      const done = new Promise<void>((resolve) => {
        rowCache.foldSessionEventRows('recorded', b, {
          likes: ['%"type":"turn_usage"%'], init: () => 0, clone: (n) => n, step: () => true,
          sliceRows: 7, onComplete: () => resolve(),
        });
      });
      await done;
      const labels = lag.loopLagSnapshot().slow.map((s) => s.label);
      expect(labels.filter((l) => l === 'fold:tokens')).toHaveLength(1);
      expect(labels.filter((l) => l === 'fold:bg')).toHaveLength(1);
      // 1 synchronous `recorded` call + the sliced one: first slice + 2 continuations.
      expect(labels.filter((l) => l === 'fold:recorded')).toHaveLength(4);
      expect(warn.mock.calls.map((c) => String(c[0]))).toContainEqual(expect.stringMatching(/^\[perf\] fold:tokens [\d.]+ms$/));
    } finally {
      lag.stopLoopLagMonitor();
    }
  });
});

describe('the context route while the recorded fold warms', () => {
  it('answers recordedPending (never a partial sum), then the value', async () => {
    const a = newSession('codex', 'active');
    const ins = rawSqlite().prepare('INSERT INTO claude_session_messages (session_id, role, content, ts_ms) VALUES (?, ?, ?, ?)');
    const turn = (input: number) => JSON.stringify({ type: 'turn_usage', provider: 'codex', inputTokens: input, outputTokens: 1, durationMs: 10 });
    // Reasoning rows: outside every fold's LIKE, and not FTS-indexed (cheap to wipe).
    const FILLER = JSON.stringify({ type: 'thinking', text: 'filler' });
    rawSqlite().transaction(() => {
      for (let i = 0; i < 20_050; i++) {
        const row = i === 5 ? ['event', turn(100)] : i === 20_040 ? ['event', turn(7)] : ['event', FILLER];
        ins.run(a, row[0], row[1], 1_800_000_000_000 + i);
      }
    })();
    const { GET } = await import('@/app/api/claude/sessions/[id]/context/route');
    const get = async () => (await GET(new Request(`http://localhost/api/claude/sessions/${a}/context`),
      { params: Promise.resolve({ id: a }) })).json();

    const warming = await get();
    expect(warming.recordedPending).toBe(true);
    expect(warming.recorded_usage).toBeNull();

    await vi.waitFor(() => expect(rowCache.sessionRowCacheStats().chains).toBe(0));
    const warm = await get();
    expect(warm.recordedPending).toBeUndefined();
    expect(warm.recorded_usage).toMatchObject({ turns: 2, input_tokens: 107, output_tokens: 2, duration_ms: 20 });
    expect(recordedSessionUsage(a)).toEqual({ usage: refRecorded(a), pending: false });
  }, 30_000);
});
