import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { revealLine, revealView, subscribeReveal, subscribeView, type FileViewIntent } from '@/app/revealLine';

/**
 * The hand-off from a search hit to the editor pane (§14.84).
 *
 * Both delivery paths matter and they are easy to get wrong in opposite
 * directions: dropping the request when the file is not open yet (the common
 * case — you click a result for a file you have never opened), and dropping it
 * when the file IS open (the second-click case — the pane does not remount, so
 * a prop would never change).
 */
describe('revealLine', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('delivers live to an editor that is already mounted', () => {
    const seen: number[] = [];
    const off = subscribeReveal('v1', '/srv/app', 'src/a.ts', (n) => seen.push(n));
    revealLine('v1', '/srv/app', 'src/a.ts', 42);
    expect(seen).toEqual([42]);
    off();
  });

  it('parks the request until the editor mounts, then drains it once', () => {
    revealLine('v1', '/srv/app', 'src/b.ts', 7);
    const seen: number[] = [];
    const off = subscribeReveal('v1', '/srv/app', 'src/b.ts', (n) => seen.push(n));
    // Parked requests arrive after paint — CodeMirror cannot scroll to a line
    // it has not measured yet.
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual([7]);
    off();

    // One-shot: reopening the same file must not resurrect the old jump.
    const again: number[] = [];
    const off2 = subscribeReveal('v1', '/srv/app', 'src/b.ts', (n) => again.push(n));
    vi.advanceTimersByTime(10);
    expect(again).toEqual([]);
    off2();
  });

  it('forgets a parked request nobody ever claimed', () => {
    revealLine('v1', '/srv/app', 'src/ghost.ts', 12);
    vi.advanceTimersByTime(31_000);
    const seen: number[] = [];
    const off = subscribeReveal('v1', '/srv/app', 'src/ghost.ts', (n) => seen.push(n));
    vi.advanceTimersByTime(10);
    expect(seen).toEqual([]);
    off();
  });

  it('keys on (vps, root, path) — the same relative path in two projects is two files', () => {
    const a: number[] = [];
    const b: number[] = [];
    const offA = subscribeReveal('v1', '/srv/one', 'index.ts', (n) => a.push(n));
    const offB = subscribeReveal('v1', '/srv/two', 'index.ts', (n) => b.push(n));
    revealLine('v1', '/srv/two', 'index.ts', 3);
    expect(a).toEqual([]);
    expect(b).toEqual([3]);
    offA(); offB();
  });

  it('a torn-down pane stops receiving, and its request parks instead', () => {
    const seen: number[] = [];
    const off = subscribeReveal('v1', '/srv/app', 'src/c.ts', (n) => seen.push(n));
    off();
    revealLine('v1', '/srv/app', 'src/c.ts', 9);
    expect(seen).toEqual([]);
    const next: number[] = [];
    const off2 = subscribeReveal('v1', '/srv/app', 'src/c.ts', (n) => next.push(n));
    vi.advanceTimersByTime(1);
    expect(next).toEqual([9]);
    off2();
  });

  it('a listener that throws does not stop the others', () => {
    const seen: number[] = [];
    const offBad = subscribeReveal('v1', '/srv/app', 'src/d.ts', () => { throw new Error('dead pane'); });
    const offGood = subscribeReveal('v1', '/srv/app', 'src/d.ts', (n) => seen.push(n));
    expect(() => revealLine('v1', '/srv/app', 'src/d.ts', 5)).not.toThrow();
    expect(seen).toEqual([5]);
    offBad(); offGood();
  });
});

/**
 * The view an open gesture asks for: a chat link renders, the explorer shows
 * the format's default. Same two delivery paths as a line, but a parked view
 * lands AT ONCE — the pane drains it from a layout effect, before paint.
 */
describe('revealView', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('a parked view is drained synchronously, once', () => {
    revealView('v1', '/srv/app', 'index.html', 'rendered');
    const seen: FileViewIntent[] = [];
    const off = subscribeView('v1', '/srv/app', 'index.html', (v) => seen.push(v));
    expect(seen).toEqual(['rendered']);
    off();
    const again: FileViewIntent[] = [];
    const off2 = subscribeView('v1', '/srv/app', 'index.html', (v) => again.push(v));
    vi.advanceTimersByTime(10);
    expect(again).toEqual([]);
    off2();
  });

  it('an open pane switches live, and the latest gesture wins', () => {
    const seen: FileViewIntent[] = [];
    const off = subscribeView('v1', '/srv/app', 'README.md', (v) => seen.push(v));
    revealView('v1', '/srv/app', 'README.md', 'rendered');
    revealView('v1', '/srv/app', 'README.md', 'default');
    expect(seen).toEqual(['rendered', 'default']);
    off();
  });

  it('is its own channel: a view request is not a line, nor the reverse', () => {
    const lines: number[] = [];
    const views: FileViewIntent[] = [];
    const offL = subscribeReveal('v1', '/srv/app', 'doc.md', (n) => lines.push(n));
    const offV = subscribeView('v1', '/srv/app', 'doc.md', (v) => views.push(v));
    revealLine('v1', '/srv/app', 'doc.md', 4);
    revealView('v1', '/srv/app', 'doc.md', 'default');
    expect(lines).toEqual([4]);
    expect(views).toEqual(['default']);
    offL(); offV();
  });

  it('a re-parked request is not cut short by the previous one\'s expiry', () => {
    revealView('v1', '/srv/app', 'late.md', 'rendered');
    vi.advanceTimersByTime(20_000);
    revealView('v1', '/srv/app', 'late.md', 'rendered');
    vi.advanceTimersByTime(15_000);
    const seen: FileViewIntent[] = [];
    const off = subscribeView('v1', '/srv/app', 'late.md', (v) => seen.push(v));
    expect(seen).toEqual(['rendered']);
    off();
  });
});
