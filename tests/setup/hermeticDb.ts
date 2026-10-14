// Vitest setupFile (vitest.config.ts § test.setupFiles): runs before EVERY test
// file and points it at a private throwaway SQLite path.
//
// lib/db/index.ts opens `DATABASE_URL || ./data/charon.db` at IMPORT time and
// runs PRAGMAs on it (`optimize` may write). On the hub box `./data/charon.db`
// is the LIVE database, and several tests reach lib/db transitively without
// setting the variable themselves — so the default path must be unreachable
// from vitest, whatever the shell exports.
//
// Unconditional on purpose: a DATABASE_URL inherited from the shell (or a
// sourced .env) must not leak into the suite. A test file that assigns its own
// DATABASE_URL at module top still wins: it runs after this file, and every DB
// module is loaded lazily (`await import()`), never at setup time — this file
// must never import lib/db itself.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Symlink-proof spelling of a path whose leaf may not exist yet. */
function canonical(p: string): string {
  const dir = path.dirname(p);
  try { return path.join(fs.realpathSync(dir), path.basename(p)); } catch { return p; }
}

/** Throws when `dbPath` resolves to a runtime database: `<repo>/data/charon.db`
 *  or the cwd-relative default lib/db falls back to. Returns the resolved path. */
export function assertHermeticDbPath(
  dbPath: string,
  opts: { repoRoot?: string; cwd?: string } = {},
): string {
  const cwd = opts.cwd ?? process.cwd();
  const resolved = path.resolve(cwd, dbPath);
  const forbidden = [
    path.join(opts.repoRoot ?? REPO_ROOT, 'data', 'charon.db'),
    path.resolve(cwd, 'data', 'charon.db'),
  ];
  const target = canonical(resolved);
  if (forbidden.some((f) => f === resolved || canonical(f) === target)) {
    throw new Error(`[hermeticDb] refusing to run tests against the runtime database ${resolved}`);
  }
  return resolved;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charon-vitest-'));
process.env.DATABASE_URL = assertHermeticDbPath(path.join(dir, 't.db'));

// Best-effort cleanup once the file's own hooks are done (after-hooks run in
// reverse registration order, and this one registers first). Not a process
// 'exit' listener: the forks pool kills its workers, so those never run.
afterAll(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});
