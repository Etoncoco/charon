import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({}));

import { REMOTE_UPLOAD_DIRNAME, uploadDirIgnoreCommand } from '@/lib/server/claude/attachments';

// The upload's real shell, run against real repos: `.charon-uploads/` must be
// ignored as a DIRECTORY (what the explorer asks), not only its contents.

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

/** Exit 0 = ignored, 1 = not (check-ignore's own verdict). */
function ignored(cwd: string, rel: string): boolean {
  try {
    git(cwd, 'check-ignore', '-q', rel);
    return true;
  } catch {
    return false;
  }
}

function upload(cwd: string) {
  fs.mkdirSync(path.join(cwd, REMOTE_UPLOAD_DIRNAME), { recursive: true });
  execFileSync('sh', ['-c', uploadDirIgnoreCommand(cwd)]);
  fs.writeFileSync(path.join(cwd, REMOTE_UPLOAD_DIRNAME, 'shot.png'), 'x');
}

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charon-uploads-'));
  git(dir, 'init', '-q');
  return dir;
}

describe('uploadDirIgnoreCommand', () => {
  it('ignores the directory itself, not only its contents', () => {
    const dir = repo();
    upload(dir);
    expect(ignored(dir, REMOTE_UPLOAD_DIRNAME)).toBe(true);
    expect(ignored(dir, `${REMOTE_UPLOAD_DIRNAME}/shot.png`)).toBe(true);
    expect(git(dir, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    // The user's own .gitignore is never written.
    expect(fs.existsSync(path.join(dir, '.gitignore'))).toBe(false);
  });

  it('anchors the rule at a cwd below the repo root, and writes it once', () => {
    const dir = repo();
    const cwd = path.join(dir, 'sub dir', "it's");
    fs.mkdirSync(cwd, { recursive: true });
    upload(cwd);
    upload(cwd);
    const rel = path.relative(dir, path.join(cwd, REMOTE_UPLOAD_DIRNAME));
    expect(ignored(dir, rel)).toBe(true);
    // Only that one: a sibling folder of the same name elsewhere is untouched.
    expect(ignored(dir, REMOTE_UPLOAD_DIRNAME)).toBe(false);
    const exclude = fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n').filter((l) => l === `/${rel}/`)).toHaveLength(1);
  });

  it('never fails outside a repo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charon-uploads-'));
    expect(() => upload(dir)).not.toThrow();
    expect(fs.readFileSync(path.join(dir, REMOTE_UPLOAD_DIRNAME, '.gitignore'), 'utf8')).toBe('*\n');
  });
});
