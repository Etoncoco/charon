import { describe, it, expect } from 'vitest';
import { applyGitAnswer, nextGitDelay, relatedGitCwd, type GitView } from '../app/gitStore';
import type { GitWorkspaceResponse } from '../lib/types/api';

// The browser half of "a failed poll never clobbers the last good snapshot"
// (§14.76): the tree's colours used to vanish on one reconnect and stay gone
// for the two-minute degraded timer, which read as "only ↻ fixes it".

const good: GitWorkspaceResponse = {
  ok: true, mode: 'single',
  repos: [{ ok: true, isRepo: true, root: '/srv/app', files: [] }],
};
const offline: GitWorkspaceResponse = { ok: false, mode: 'none', repos: [], reason: 'offline', error: 'the agent is not connected' };

function entry(view: GitView = { workspace: null, loading: false, error: null }) {
  return { view, failures: 0, lastFailure: null as never, lastAt: 0, dirty: false };
}

describe('applyGitAnswer', () => {
  it('a failure keeps the last good workspace, with the error beside it', () => {
    const e = entry();
    e.view = applyGitAnswer(e, { workspace: good });
    expect(e.lastAt).toBeGreaterThan(0);
    const seen = e.lastAt;
    const v = applyGitAnswer(e, { workspace: offline });
    expect(v.workspace).toBe(good);
    expect(v.error).toMatch(/not connected/);
    expect(e.failures).toBe(1);
    expect(e.lastAt).toBe(seen);      // a failure is not a fresh answer
  });

  it('with nothing better to show, the failure itself is the view', () => {
    const e = entry();
    const v = applyGitAnswer(e, { workspace: offline });
    expect(v.workspace).toBe(offline);
    expect(v.error).toBeNull();
  });

  it('a transport error keeps whatever was there', () => {
    const e = entry({ workspace: good, loading: false, error: null });
    const v = applyGitAnswer(e, { transportError: 'Failed to fetch' });
    expect(v.workspace).toBe(good);
    expect(v.error).toBe('Failed to fetch');
    expect(e.lastFailure).toBe('transport');
  });

  it('a good answer clears the failure count', () => {
    const e = entry();
    applyGitAnswer(e, { workspace: offline });
    applyGitAnswer(e, { workspace: offline });
    expect(e.failures).toBe(2);
    const v = applyGitAnswer(e, { workspace: good });
    expect(e.failures).toBe(0);
    expect(v.error).toBeNull();
  });
});

describe('nextGitDelay', () => {
  it('retries a fixable failure fast, then backs off', () => {
    const view = { workspace: good, loading: false, error: null };
    const at = (failures: number) => nextGitDelay({ view, failures, lastFailure: 'offline' });
    expect([1, 2, 3, 4, 9].map(at)).toEqual([5_000, 15_000, 30_000, 60_000, 60_000]);
  });

  it('what a retry cannot fix waits long; a plain folder longer', () => {
    const view = { workspace: null, loading: false, error: null };
    expect(nextGitDelay({ view, failures: 1, lastFailure: 'unsupported' })).toBe(120_000);
    expect(nextGitDelay({ view, failures: 1, lastFailure: 'no_git' })).toBe(120_000);
    const none = { workspace: { ok: true, mode: 'none' as const, repos: [] }, loading: false, error: null };
    expect(nextGitDelay({ view: none, failures: 0, lastFailure: null })).toBe(300_000);
    expect(nextGitDelay({ view: { workspace: good, loading: false, error: null }, failures: 0, lastFailure: null }))
      .toBe(30_000);
  });
});

describe('relatedGitCwd', () => {
  it('same folder or one inside the other, on separator boundaries', () => {
    expect(relatedGitCwd('/srv/app', '/srv/app/')).toBe(true);
    expect(relatedGitCwd('/srv/app/src', '/srv/app')).toBe(true);
    expect(relatedGitCwd('/srv/app', '/srv/app/src')).toBe(true);
    expect(relatedGitCwd('/srv/app', '/srv/app-old')).toBe(false);
    expect(relatedGitCwd('/srv/a', '/srv/b')).toBe(false);
    expect(relatedGitCwd('/', '/srv/b')).toBe(true);
  });
});
