import { beforeAll, beforeEach, expect, it, vi } from 'vitest';

// The header account buttons hydrate EVERY login at once with `cached=1`: the
// GET must answer from the snapshot, never await a poll or a profile RPC
// (each could hold an HTTP/1.1 socket for up to the agent timeout).
vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/session', () => ({ requireApiSession: async () => ({ userId: 'u' }) }));
const poll = vi.fn(async () => null);
const profilePoll = vi.fn(async () => null);
const readStatus = vi.fn(async () => ({}));
vi.mock('@/lib/server/agent/usagePoll', () => ({
  USAGE_STALE_MS: 1000,
  PROVIDER_USAGE: new Proxy({}, { get: () => ({ snapshot: () => null, needsForce: () => true, ageMs: () => Infinity, poll }) }),
  getAccountProfileUsage: () => null,
  pollAccountProfileUsage: profilePoll,
}));
vi.mock('@/lib/server/agent/accountProfiles', () => ({ requireAccountProfile: () => {}, readProfileStatus: readStatus }));
vi.mock('@/lib/server/agent/accountProfileState', () => ({ profileStatuses: new Map(), statusKey: () => 'k' }));
vi.mock('@/lib/server/agent/AgentClientPool', () => ({ getAgentClientForVpsId: () => ({ status: 'connected' }) }));

let GET: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
beforeAll(async () => {
  const mod = await import('@/lib/db');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(mod.db, { migrationsFolder: './drizzle' });
  mod.db.insert(mod.vpsFolders).values({ id: 'default', name: 'default', position: 0 }).onConflictDoNothing().run();
  mod.db.insert(mod.vps).values({ id: 'v1', name: 'v', ip: '127.0.0.1', sshUser: 'root' }).onConflictDoNothing().run();
  ({ GET } = await import('@/app/api/vps/[id]/usage/route'));
});
beforeEach(() => { poll.mockClear(); profilePoll.mockClear(); readStatus.mockClear(); });

const get = (q: string) => GET(new Request(`http://h/api/vps/v1/usage?${q}`), { params: Promise.resolve({ id: 'v1' }) });

it('cached=1 never polls nor probes the profile', async () => {
  expect((await get('provider=claude&profile=default&refresh=0&cached=1')).status).toBe(200);
  expect((await get('provider=codex&profile=p2&refresh=0&cached=1')).status).toBe(200);
  expect(poll).not.toHaveBeenCalled();
  expect(profilePoll).not.toHaveBeenCalled();
  expect(readStatus).not.toHaveBeenCalled();
});

it('without it (or with refresh=1) a stale snapshot is still polled', async () => {
  await get('provider=claude&profile=default&refresh=0');
  await get('provider=codex&profile=p2&refresh=1&cached=1');
  expect(poll).toHaveBeenCalledTimes(1);
  expect(readStatus).toHaveBeenCalledTimes(1);
  expect(profilePoll).toHaveBeenCalledTimes(1);
});
