import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';

vi.mock('server-only', () => ({}));
const bus = vi.hoisted(() => ({ status: vi.fn(), unread: vi.fn() }));
vi.mock('@/lib/server/agent/sessionOps', () => ({
  emitGlobalShellStatus: bus.status,
  emitGlobalShellUnread: bus.unread,
}));
vi.mock('@/lib/db', async () => {
  const tables = await import('@/lib/db/schema');
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema: tables });
  migrate(db, { migrationsFolder: './drizzle' });
  return { ...tables, db };
});

const {
  shellFinishedBody, formatWorkDuration, noteShellStatus, recordShellActivity, markShellFinished, markShellRead,
} = await import('@/lib/server/agent/shellNotify');
const { db, vps, shells } = await import('@/lib/db');
const { hubHooks } = await import('@/lib/server/agent/hubHooks');

const base = {
  event: 'shell_idle' as const, session_id: 's', shell_id: 's',
  idle_seconds: 6, burst_seconds: 0, burst_bytes: 0,
};

describe('shell "finished" alert wording (§14.42)', () => {
  it('names the command that returned to the prompt', () => {
    expect(shellFinishedBody({ ...base, reason: 'command', work_seconds: 125, command: 'npm install' }))
      .toBe('npm install finished after 2m 05s');
  });

  it('says an interactive program is waiting', () => {
    expect(shellFinishedBody({ ...base, reason: 'turn', work_seconds: 44.6, command: 'claude' }))
      .toBe('claude finished after 45s — waiting for you');
  });

  it('works without a process name, and strips control characters from one', () => {
    expect(shellFinishedBody({ ...base, reason: 'command', work_seconds: 12, command: null }))
      .toBe('The command finished after 12s');
    expect(shellFinishedBody({ ...base, reason: 'turn', work_seconds: 9, command: '\u001b[31mx\u0007' }))
      .toBe('[31mx finished after 9s — waiting for you');
  });

  it('keeps the old wording for an agent that sends no reason', () => {
    expect(shellFinishedBody({ ...base, burst_seconds: 7.2 }))
      .toBe('The shell went quiet after 7s of output — finished something');
  });

  it('formats durations', () => {
    expect(formatWorkDuration(0.2)).toBe('1s');
    expect(formatWorkDuration(59.4)).toBe('59s');
    expect(formatWorkDuration(3600 + 12 * 60 + 5)).toBe('1h 12m');
  });
});

describe('shell activity time (header nav order, §11)', () => {
  db.insert(vps).values({ id: 'v', name: 'V', ip: '192.0.2.1', sshUser: 'user' }).run();
  db.insert(shells).values({ id: 'sh1', vpsId: 'v', cwd: '/p' }).run();
  const stored = () => db.select().from(shells).where(eq(shells.id, 'sh1')).all()[0]?.lastActivityMs ?? null;

  it('a holder re-attach announcing `active` is not activity', () => {
    expect(noteShellStatus('sh1', 'active')).toBeNull();
    expect(stored()).toBeNull();
  });

  it('the end of a busy span is, persisted before it is published', () => {
    expect(noteShellStatus('sh1', 'busy')).toBeNull();
    const at = noteShellStatus('sh1', 'active');
    expect(at).toEqual(expect.any(Number));
    expect(stored()).toBe(at);
    expect(noteShellStatus('sh1', 'active')).toBeNull();
  });

  it('a finished job is; an unknown shell is not', () => {
    expect(recordShellActivity('sh1', 42)).toBe(42);
    expect(stored()).toBe(42);
    expect(recordShellActivity('nope', 43)).toBeNull();
  });
});

describe('shell finished-unread marker (§14.47 twin)', () => {
  db.insert(shells).values({ id: 'sh2', vpsId: 'v', cwd: '/p' }).run();
  const unread = () => db.select().from(shells).where(eq(shells.id, 'sh2')).all()[0]?.unreadFinish;

  it('a finish nobody attends lights it once, persisted then published', () => {
    const seen: Array<[string, number | null | undefined]> = [];
    hubHooks().focusChecker = (id, at) => { seen.push([id, at]); return false; };
    bus.unread.mockReset();
    markShellFinished('sh2', 1234);
    expect(seen).toEqual([['sh2', 1234]]);
    expect(unread()).toBe(1);
    expect(bus.unread).toHaveBeenCalledExactlyOnceWith('sh2', true);
    markShellFinished('sh2', 1235);
    expect(bus.unread).toHaveBeenCalledOnce();
  });

  it('an attended view reads it, and a watched finish never lights it', () => {
    bus.unread.mockReset();
    markShellRead('sh2');
    expect(unread()).toBe(0);
    expect(bus.unread).toHaveBeenCalledExactlyOnceWith('sh2', false);
    markShellRead('sh2');
    expect(bus.unread).toHaveBeenCalledOnce();
    hubHooks().focusChecker = () => true;
    markShellFinished('sh2', 1);
    expect(unread()).toBe(0);
    expect(bus.unread).toHaveBeenCalledOnce();
    hubHooks().focusChecker = undefined;
  });
});
