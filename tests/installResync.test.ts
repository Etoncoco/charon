import { describe, expect, it, vi } from 'vitest';
import { isInstallNotFound, reconcileInstallsOnResync, type InstallRow } from '@/app/sync/installResync';

// A resync's `sync_installs` (W4-review): an install that finished during the
// gap keeps its row with its final state (§14.22), dropped only on a 404.

type Row = InstallRow & { log?: string };

function harness(initial: Row[], answers: Record<string, Row | Error>) {
  let rows = initial;
  const finished: Row[] = [];
  const getInstall = vi.fn(async (id: string) => {
    const a = answers[id];
    if (a instanceof Error) throw a;
    if (!a) throw new Error(`GET /api/installs/${id} → 404: install not found`);
    return a;
  });
  reconcileInstallsOnResync(initial, Object.keys(answers).filter((id) => {
    const a = answers[id];
    return !(a instanceof Error) && a.status === 'running';
  }), {
    getInstall,
    update: (fn) => { rows = fn(rows); },
    onFinished: (info) => finished.push(info),
  });
  return { rows: () => rows, finished, getInstall };
}

describe('install rows across a resync', () => {
  it('a running row the list omits is refetched and shows its final error (not dropped)', async () => {
    const h = harness(
      [{ id: 'i1', vpsId: 'v1', status: 'running' }],
      { i1: { id: 'i1', vpsId: 'v1', status: 'error' } },
    );
    await vi.waitFor(() => expect(h.rows()).toEqual([{ id: 'i1', vpsId: 'v1', status: 'error' }]));
    expect(h.finished).toEqual([]);
  });

  it('a gap success runs the finished side effect (VPS badge)', async () => {
    const h = harness(
      [{ id: 'i1', vpsId: 'v1', status: 'running' }],
      { i1: { id: 'i1', vpsId: 'v1', status: 'success' } },
    );
    await vi.waitFor(() => expect(h.finished).toHaveLength(1));
    expect(h.rows()[0].status).toBe('success');
  });

  it('a 404 (hub restarted) drops the running row; another failure keeps it', async () => {
    const h = harness([{ id: 'gone', vpsId: 'v1', status: 'running' }], {});
    await vi.waitFor(() => expect(h.rows()).toEqual([]));
    const h2 = harness([{ id: 'i2', vpsId: 'v1', status: 'running' }], { i2: new Error('GET /api/installs/i2 → 502') });
    await new Promise((r) => setTimeout(r, 0));
    expect(h2.rows()).toHaveLength(1);
  });

  it('a listed unknown id is fetched and added; listed known and finished rows are left alone', async () => {
    const h = harness(
      [{ id: 'k', vpsId: 'v1', status: 'running' }, { id: 'done', vpsId: 'v2', status: 'error' }],
      { k: { id: 'k', vpsId: 'v1', status: 'running' }, n: { id: 'n', vpsId: 'v3', status: 'running' } },
    );
    await vi.waitFor(() => expect(h.rows().map((r) => r.id)).toEqual(['k', 'done', 'n']));
    expect(h.getInstall.mock.calls.map(([id]) => id)).toEqual(['n']);
  });

  it('isInstallNotFound reads the api error shape', () => {
    expect(isInstallNotFound(new Error('GET /api/installs/x → 404: install not found'))).toBe(true);
    expect(isInstallNotFound(new Error('GET /api/installs/x → 4040'))).toBe(false);
    expect(isInstallNotFound(new Error('GET /api/installs/x → 500'))).toBe(false);
  });
});
