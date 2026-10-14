import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('server-only', () => ({}));

// tests/setup/hermeticDb.ts (vitest setupFiles) must have pointed this file at a
// throwaway database BEFORE anything opened one: this file sets no
// DATABASE_URL of its own, exactly like the tests that used to reach the live
// ./data/charon.db through a transitive lib/db import.
describe('hermetic vitest database', () => {
  it('opens a temp-dir database, never ./data/charon.db', async () => {
    const tmp = fs.realpathSync(os.tmpdir());
    const envPath = process.env.DATABASE_URL ?? '';
    expect(fs.realpathSync(path.dirname(envPath)).startsWith(tmp)).toBe(true);

    await import('@/lib/db');
    const name = (globalThis as any)._sqlite.name as string;
    expect(name.startsWith(os.tmpdir())).toBe(true);
    expect(name).toBe(envPath);
    expect(path.resolve(name)).not.toBe(path.resolve('data', 'charon.db'));
  });

  it('refuses a path that resolves to the runtime database', async () => {
    const before = process.env.DATABASE_URL;
    const { assertHermeticDbPath } = await import('./setup/hermeticDb');
    // The setup module is cached, not re-run: the open DB keeps its env.
    expect(process.env.DATABASE_URL).toBe(before);
    const repoRoot = path.resolve(__dirname, '..');
    expect(() => assertHermeticDbPath(path.join(repoRoot, 'data', 'charon.db'))).toThrow(/runtime database/);
    // lib/db's own fallback is cwd-relative.
    expect(() => assertHermeticDbPath('./data/charon.db', { cwd: '/srv/elsewhere' })).toThrow(/runtime database/);
    // Through a symlinked directory too.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charon-hermetic-'));
    fs.mkdirSync(path.join(dir, 'repo', 'data'), { recursive: true });
    fs.symlinkSync(path.join(dir, 'repo', 'data'), path.join(dir, 'alias'));
    expect(() => assertHermeticDbPath(path.join(dir, 'alias', 'charon.db'), {
      repoRoot: path.join(dir, 'repo'), cwd: dir,
    })).toThrow(/runtime database/);
    // Anything else passes, resolved.
    expect(assertHermeticDbPath(path.join(dir, 't.db'), { repoRoot: path.join(dir, 'repo') }))
      .toBe(path.join(dir, 't.db'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // The shell (or a sourced .env) may export the LIVE path: the setup must
  // replace it, not merely fill a missing value — a `??=` would pass the test
  // above whenever the shell exports nothing. Re-evaluates the setup module
  // with the hostile value in place; nothing here opens a database.
  it('overrides a DATABASE_URL inherited from the shell', async () => {
    const before = process.env.DATABASE_URL;
    const hostile = path.join(path.resolve(__dirname, '..'), 'data', 'charon.db');
    let installed = '';
    process.env.DATABASE_URL = hostile;
    try {
      vi.resetModules();
      await import('./setup/hermeticDb');
      installed = process.env.DATABASE_URL ?? '';
      expect(installed).not.toBe(hostile);
      expect(installed).not.toBe(before);
      expect(path.basename(installed)).toBe('t.db');
      expect(fs.realpathSync(path.dirname(installed))
        .startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
    } finally {
      process.env.DATABASE_URL = before;
      // The re-run's own afterAll may never fire (registered mid-test).
      if (installed && installed !== hostile) {
        fs.rmSync(path.dirname(installed), { recursive: true, force: true });
      }
    }
  });
});
