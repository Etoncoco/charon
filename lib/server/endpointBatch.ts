import 'server-only';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, customEndpoints, vps } from '@/lib/db';
import { ENDPOINT_ENGINES, type EndpointCheck, type EndpointModel } from '@/lib/customEndpoints';
import type { EndpointBatch, EndpointBatchBody } from '@/lib/types/api';
import { endpointCatalog } from '@/lib/endpointDiscovery';
import { probeEndpoint } from './endpointProbe';
import { savedEndpoint, saveEndpoint, type StoredEndpoint } from './customEndpoints';

type Snapshot = StoredEndpoint & { id: string };
type BatchState = { batch: EndpointBatch | null; cancel: boolean };
const shared = globalThis as typeof globalThis & { __charonEndpointBatch?: BatchState };
const state = shared.__charonEndpointBatch ??= { batch: null, cancel: false };
const isActive = (batch: EndpointBatch | null) => !!batch && ['preparing', 'running', 'cancelling'].includes(batch.status);

export function getEndpointBatch(): EndpointBatch | null {
  return state.batch ? structuredClone(state.batch) : null;
}

// Read immediately before each synchronous write: a running test cannot restore
// a deleted template or overwrite another tab's new connection/credentials.
function current(snapshot: Snapshot): Snapshot {
  const latest = savedEndpoint(snapshot.id) as Snapshot;
  if (latest.baseUrl !== snapshot.baseUrl || latest.auth !== snapshot.auth || latest.secret !== snapshot.secret) {
    throw new Error('Connection changed during testing. Start a new test for the updated endpoint.');
  }
  return latest;
}

function mergeModels(previous: EndpointModel[], discovered: EndpointModel[], fallback: string): EndpointModel[] {
  const models = new Map(previous.map((model) => [model.id, model]));
  for (const model of discovered) models.set(model.id, { ...models.get(model.id), ...model, checks: models.get(model.id)?.checks });
  if (!models.has(fallback)) models.set(fallback, { id: fallback });
  return [...models.values()];
}

function persistCheck(snapshot: Snapshot, check: EndpointCheck) {
  const latest = current(snapshot);
  const models = mergeModels(latest.models ?? [], [], check.model).map((model) => model.id === check.model
    ? { ...model, checks: { ...model.checks, [check.engine]: check } } : model);
  saveEndpoint({ ...latest, models, checks: latest.model === check.model
    ? { ...latest.checks, [check.engine]: check } : latest.checks }, latest.id);
}

async function run(batch: EndpointBatch, snapshots: Snapshot[]) {
  try {
    const tasks: { snapshot: Snapshot; progress: EndpointBatch['active'][number] }[] = [];
    for (const snapshot of snapshots) {
      if (state.cancel) break;
      let latest = current(snapshot);
      if (endpointCatalog(snapshot.baseUrl)) {
        const catalog = await probeEndpoint(latest, ENDPOINT_ENGINES[0], batch.vpsId, 'models');
        latest = current(snapshot);
        // Discovery failure does not erase saved models; saved/manual ids also
        // remain testable when the remote catalog stops advertising them.
        if (catalog.models.length) {
          latest = { ...latest, models: mergeModels(latest.models ?? [], catalog.models, latest.model) };
          saveEndpoint(latest, latest.id);
        }
      }
      if (state.cancel) break;
      const models = mergeModels(latest.models ?? [], [], latest.model);
      for (const model of models) for (const engine of ENDPOINT_ENGINES) tasks.push({ snapshot, progress: {
        endpointId: snapshot.id, name: latest.name, model: model.id, engine,
      } });
      batch.total = tasks.length;
    }
    if (!state.cancel) batch.status = 'running';
    let next = 0;
    let failure: unknown;
    const worker = async () => {
      while (!state.cancel && !failure && next < tasks.length) {
        const { snapshot, progress: task } = tasks[next++];
        batch.active.push(task);
        try {
          const endpoint = current(snapshot);
          const result = await probeEndpoint({ ...endpoint, model: task.model }, task.engine, batch.vpsId, 'test');
          if (!result.check || result.check.model !== task.model || result.check.engine !== task.engine) {
            throw new Error('The agent returned an incomplete compatibility test.');
          }
          persistCheck(snapshot, result.check);
          batch.completed++;
          (result.check.ok ? batch.passed : batch.failed)[task.engine]++;
        } catch (error) {
          failure = error;
        } finally {
          batch.active = batch.active.filter((active) => active !== task);
        }
      }
    };
    // Two bounded workers, independent of catalog size. A transport failure
    // stops scheduling; already running checks finish before releasing the job.
    await Promise.all([worker(), worker()]);
    if (failure) throw failure;
    batch.status = state.cancel ? 'cancelled' : 'completed';
  } catch (error) {
    batch.status = 'error';
    batch.error = error instanceof Error ? error.message : 'Endpoint testing failed.';
  } finally {
    batch.active = [];
  }
}

export class EndpointBatchBusy extends Error {}

export function startEndpointBatch(input: EndpointBatchBody): EndpointBatch {
  if (isActive(state.batch)) throw new EndpointBatchBusy('An endpoint test is already running.');
  if (!input || typeof input !== 'object') throw new Error('Choose a VPS for the tests.');
  if (typeof input.vpsId !== 'string' || !db.select({ id: vps.id }).from(vps).where(eq(vps.id, input.vpsId)).get()) {
    throw new Error('Choose an existing VPS for the tests.');
  }
  if (input.endpointId !== undefined && (typeof input.endpointId !== 'string' || !input.endpointId)) {
    throw new Error('Invalid endpoint ID.');
  }
  const snapshots = input.endpointId ? [savedEndpoint(input.endpointId) as Snapshot]
    : db.select().from(customEndpoints).all().map((row) => ({ ...JSON.parse(row.config), id: row.id }) as Snapshot);
  if (!snapshots.length) throw new Error('Add an endpoint before running the tests.');
  const batch: EndpointBatch = {
    id: randomUUID(), vpsId: input.vpsId, endpointId: input.endpointId, status: 'preparing', total: 0, completed: 0,
    passed: { claude: 0, codex: 0 }, failed: { claude: 0, codex: 0 }, active: [],
  };
  state.cancel = false;
  state.batch = batch;
  void run(batch, snapshots);
  return getEndpointBatch()!;
}

export function cancelEndpointBatch(id: string): EndpointBatch | null {
  if (!state.batch || state.batch.id !== id) throw new Error('This test is no longer current.');
  if (isActive(state.batch)) {
    state.cancel = true;
    state.batch.status = 'cancelling';
  }
  return getEndpointBatch();
}
