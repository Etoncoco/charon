import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { EndpointEngine } from '@/lib/customEndpoints';
import type { StoredEndpoint } from '@/lib/server/customEndpoints';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ probe: vi.fn(), auth: vi.fn() }));
vi.mock('@/lib/server/endpointProbe', () => ({ probeEndpoint: mocks.probe }));
vi.mock('@/lib/server/session', () => ({ requireApiSession: mocks.auth }));

let store: typeof import('@/lib/server/customEndpoints');
let runner: typeof import('@/lib/server/endpointBatch');
let database: typeof import('@/lib/db');
let route: typeof import('@/app/api/custom-endpoints/test-all/route');
beforeAll(async () => {
  process.env.MASTER_PASSWORD = 'endpoint-batch-test';
  process.env.MASTER_SALT = '00112233445566778899aabbccddeeff';
  database = await import('@/lib/db');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(database.db, { migrationsFolder: './drizzle' });
  database.db.insert(database.vpsFolders).values({ id: 'default', name: 'Default' }).onConflictDoNothing().run();
  database.db.insert(database.vps).values({ id: 'test-vps', name: 'Tests', ip: '127.0.0.1', sshUser: 'test' }).run();
  store = await import('@/lib/server/customEndpoints');
  runner = await import('@/lib/server/endpointBatch');
  route = await import('@/app/api/custom-endpoints/test-all/route');
});

function verdict(endpoint: StoredEndpoint, engine: EndpointEngine) {
  const ok = endpoint.model === 'both' || endpoint.model === engine;
  return { ok, models: [], check: { ok, model: endpoint.model, engine, vpsId: 'test-vps', streaming: ok, tools: ok,
    ...(ok ? {} : { error: 'The requested format is not supported.' }) } };
}
function save(id: string, baseUrl = 'https://example.test', models = ['claude', 'codex', 'neither', 'both']) {
  return store.saveEndpoint({ name: id, baseUrl, auth: 'none', model: models[0], models: models.map((model) => ({ id: model })) }, id);
}
async function finish() {
  await vi.waitFor(() => expect(['completed', 'cancelled', 'error']).toContain(runner.getEndpointBatch()?.status));
  return runner.getEndpointBatch()!;
}
const request = (method: string, body: unknown) => new Request('http://localhost/api/custom-endpoints/test-all', { method, body: JSON.stringify(body) });

describe('bulk endpoint compatibility tests', () => {
  beforeEach(() => {
    database.db.delete(database.customEndpoints).run();
    mocks.auth.mockResolvedValue({ userId: 'test' });
    mocks.probe.mockReset().mockImplementation(async (endpoint: StoredEndpoint, engine: EndpointEngine) => verdict(endpoint, engine));
  });

  it('tests every model on both engines, persists failures as well as successes, and supports all saved endpoints', async () => {
    save('first'); save('second', 'https://another.test', ['both']);
    runner.startEndpointBatch({ vpsId: 'test-vps' });
    const batch = await finish();
    expect(batch).toMatchObject({ status: 'completed', total: 10, completed: 10, passed: { claude: 3, codex: 3 }, failed: { claude: 2, codex: 2 } });
    expect(mocks.probe).toHaveBeenCalledTimes(10);
    const models = store.savedEndpoint('first').models!;
    expect(models.find((model) => model.id === 'claude')?.checks).toMatchObject({ claude: { ok: true }, codex: { ok: false } });
    expect(models.find((model) => model.id === 'codex')?.checks).toMatchObject({ claude: { ok: false }, codex: { ok: true } });
    expect(models.find((model) => model.id === 'neither')?.checks).toMatchObject({ claude: { ok: false }, codex: { ok: false } });
    expect(models.find((model) => model.id === 'both')?.checks).toMatchObject({ claude: { ok: true }, codex: { ok: true } });
    expect(store.savedEndpoint('first').model).toBe('claude');
  });

  it('refreshes known catalogs, deduplicates ids and retains manual models and metadata', async () => {
    save('go', 'https://opencode.ai/zen/go', ['manual']);
    mocks.probe.mockImplementation(async (endpoint, engine, _vps, action) => action === 'models'
      ? { ok: true, models: [{ id: 'both', info: { name: 'New model' } }, { id: 'both' }] } : verdict(endpoint, engine));
    runner.startEndpointBatch({ vpsId: 'test-vps', endpointId: 'go' });
    expect((await finish()).completed).toBe(4);
    expect(store.savedEndpoint('go').models?.map((model) => model.id)).toEqual(['manual', 'both']);
    expect(store.savedEndpoint('go').models?.[1].info?.name).toBe('New model');
  });

  it('limits concurrency, rejects duplicate jobs, and saves in-flight results when cancelled', async () => {
    save('first');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let concurrent = 0, peak = 0;
    mocks.probe.mockImplementation(async (endpoint, engine) => {
      peak = Math.max(peak, ++concurrent);
      await gate; concurrent--;
      return verdict(endpoint, engine);
    });
    const batch = runner.startEndpointBatch({ vpsId: 'test-vps', endpointId: 'first' });
    expect(batch.active).toHaveLength(2);
    expect(() => runner.startEndpointBatch({ vpsId: 'test-vps' })).toThrow('already running');
    expect(() => runner.cancelEndpointBatch('old-job')).toThrow('no longer current');
    expect(runner.cancelEndpointBatch(batch.id)?.status).toBe('cancelling');
    release();
    expect(await finish()).toMatchObject({ status: 'cancelled', total: 8, completed: 2 });
    expect(peak).toBe(2);
    expect(mocks.probe).toHaveBeenCalledTimes(2);
    expect(store.savedEndpoint('first').models?.[0].checks).toMatchObject({ claude: { ok: true }, codex: { ok: false } });
  });

  it.each(['delete', 'credentials'] as const)('never restores stale results after an endpoint %s', async (change) => {
    save('first');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mocks.probe.mockImplementation(async (endpoint, engine) => { await gate; return verdict(endpoint, engine); });
    runner.startEndpointBatch({ vpsId: 'test-vps', endpointId: 'first' });
    if (change === 'delete') database.db.delete(database.customEndpoints).where(eq(database.customEndpoints.id, 'first')).run();
    else store.saveEndpoint({ ...store.savedEndpoint('first'), auth: 'bearer', secret: store.sealToken('new-token'), models: [] }, 'first');
    release();
    expect(await finish()).toMatchObject({ status: 'error', completed: 0 });
    if (change === 'delete') expect(() => store.savedEndpoint('first')).toThrow('not found');
    else expect(store.savedEndpoint('first').models).toEqual([]);
  });

  it('preserves concurrent template edits and saves each successful check before the whole run ends', async () => {
    save('first');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mocks.probe.mockImplementation(async (endpoint, engine) => {
      if (engine === 'codex') await gate;
      return verdict(endpoint, engine);
    });
    const batch = runner.startEndpointBatch({ vpsId: 'test-vps', endpointId: 'first' });
    await vi.waitFor(() => expect(store.savedEndpoint('first').models?.[0].checks?.claude?.ok).toBe(true));
    const latest = store.savedEndpoint('first');
    store.saveEndpoint({ ...latest, name: 'Renamed', model: 'both', usageUrl: 'https://example.test/usage' }, 'first');
    runner.cancelEndpointBatch(batch.id); release();
    await finish();
    expect(store.savedEndpoint('first')).toMatchObject({ name: 'Renamed', model: 'both', usageUrl: 'https://example.test/usage' });
    expect(store.savedEndpoint('first').models?.[0].checks?.codex?.ok).toBe(false);
  });

  it('does not mark untested models as failed after transport errors', async () => {
    save('first');
    mocks.probe.mockRejectedValue(new Error('VPS disconnected'));
    runner.startEndpointBatch({ vpsId: 'test-vps' });
    expect(await finish()).toMatchObject({ status: 'error', completed: 0, error: 'VPS disconnected' });
    expect(store.savedEndpoint('first').models?.every((model) => !model.checks)).toBe(true);
    expect(mocks.probe).toHaveBeenCalledTimes(2);
  });

  it('requires authentication for start, progress and cancellation; validates VPS and endpoint selection', async () => {
    mocks.auth.mockResolvedValue(new Response(null, { status: 401 }));
    expect((await route.GET()).status).toBe(401);
    expect((await route.POST(request('POST', { vpsId: 'test-vps' }))).status).toBe(401);
    expect((await route.DELETE(request('DELETE', { id: 'anything' }))).status).toBe(401);
    mocks.auth.mockResolvedValue({ userId: 'test' });
    expect((await route.POST(request('POST', { vpsId: 'missing' }))).status).toBe(400);
    expect((await route.POST(request('POST', { vpsId: 'test-vps', endpointId: 'missing' }))).status).toBe(400);
    expect((await route.POST(request('POST', { vpsId: 'test-vps' }))).status).toBe(400);
    expect(mocks.probe).not.toHaveBeenCalled();
  });

  it('shares progress and duplicate protection across module copies without exposing credentials', async () => {
    save('first');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mocks.probe.mockImplementation(async (endpoint, engine) => { await gate; return verdict(endpoint, engine); });
    store.saveEndpoint({ ...store.savedEndpoint('first'), auth: 'bearer', secret: store.sealToken('private-token') }, 'first');
    const response = await route.POST(request('POST', { vpsId: 'test-vps', endpointId: 'first' }));
    expect(response.status).toBe(202);
    expect(JSON.stringify(await response.json())).not.toContain('private-token');
    vi.resetModules();
    const copy = await import('@/lib/server/endpointBatch');
    expect(copy.getEndpointBatch()?.active).toHaveLength(2);
    expect(() => copy.startEndpointBatch({ vpsId: 'test-vps' })).toThrow('already running');
    copy.cancelEndpointBatch(copy.getEndpointBatch()!.id); release();
    await finish();
  });
});
