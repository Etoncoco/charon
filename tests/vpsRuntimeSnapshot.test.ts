import { beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { VpsRuntimeSnapshot } from '@/lib/types/api';
import { PROVIDERS, SESSION_PROVIDERS } from '@/lib/sessionCapabilities';

process.env.DATABASE_URL = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'charon-vps-runtime-test-')), 'test.db');
vi.mock('server-only', () => ({}));

let listVpsRuntimeSnapshots: () => VpsRuntimeSnapshot[];

beforeAll(async () => {
  const schema = await import('@/lib/db');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(schema.db, { migrationsFolder: './drizzle' });
  schema.db.insert(schema.vpsFolders).values({ id: 'default', name: 'default' }).onConflictDoNothing().run();
  schema.db.insert(schema.vps).values({
    id: 'snapshot-vps', name: 'secret box', ip: '192.0.2.99', sshUser: 'private-user',
    agentStatus: 'ok', sdkVersion: '0.2.152', codexCliVersion: '0.153.0',
  }).run();
  ({ listVpsRuntimeSnapshots } = await import('@/lib/server/agent/vpsRuntimeSnapshot'));
});

describe('listVpsRuntimeSnapshots', () => {
  it('reads only the browser-safe runtime columns', () => {
    const row = listVpsRuntimeSnapshots().find((item) => item.id === 'snapshot-vps');
    expect(row).toBeDefined();
    // Agent-level fields plus EVERY backend column the registry declares
    // (§14.102) — derived, so a new provider extends this set by declaring
    // its columns rather than by editing a literal here.
    const backendColumns = SESSION_PROVIDERS.flatMap((p) => {
      const b = PROVIDERS[p].backend;
      return [b.availability.column, b.loggedInColumn, ...b.versions.map((v) => v.column)];
    });
    expect(Object.keys(row!).sort()).toEqual([...new Set([
      'id', 'agentStatus', 'agentVersion', 'agentPyzSha', 'agentLastError',
      ...backendColumns,
    ])].sort());
    expect(row).not.toHaveProperty('ip');
    expect(row).not.toHaveProperty('sshUser');
  });
});
