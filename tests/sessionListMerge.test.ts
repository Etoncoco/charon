import { describe, it, expect } from 'vitest';
import { createListRefresher, reuseSessionRows } from '@/app/sessionListMerge';
import type { SessionListItem } from '@/lib/types/api';

// INTERIM list-GET writer (app/sessionListMerge.ts, deleted by C15): one GET in
// flight, and an older response never reverts a newer live patch.

const mkRow = (id: string, o: Partial<SessionListItem> = {}): SessionListItem => ({
  id, status: 'active', liveStatus: 'thinking', unreadStop: 0, runningBgTasks: 0,
  pendingPermissions: 0, firstUserMessage: null,
  ...o,
} as unknown as SessionListItem);

type Resp = { sessions: SessionListItem[] };

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('createListRefresher', () => {
  it('an older response never reverts a newer live patch', async () => {
    const gets: Array<ReturnType<typeof deferred<Resp>>> = [];
    const applied: SessionListItem[][] = [];
    const r = createListRefresher<Resp>({
      fetch: () => { const d = deferred<Resp>(); gets.push(d); return d.promise; },
      apply: (_resp, rows) => applied.push(rows),
    });
    const done = r.refresh();                             // GET starts: session still thinking
    r.notePatch('a', { liveStatus: 'active', unreadStop: 1 });   // the stop arrives live
    gets[0].resolve({ sessions: [mkRow('a', { liveStatus: 'thinking', unreadStop: 0 }), mkRow('b')] });
    await done;
    expect(applied.length).toBe(1);
    expect(applied[0][0]).toMatchObject({ id: 'a', liveStatus: 'active', unreadStop: 1 });
    expect(applied[0][1]).toMatchObject({ id: 'b', liveStatus: 'thinking' });
    // Still held: the response did not include it.
    expect(r.pendingPatches()).toBe(2);

    // A GET started AFTER the patch is authoritative: the patch is forgotten.
    const done2 = r.refresh();
    gets[1].resolve({ sessions: [mkRow('a', { liveStatus: 'sleeping', unreadStop: 0 })] });
    await done2;
    expect(applied[1][0]).toMatchObject({ liveStatus: 'sleeping', unreadStop: 0 });
    expect(r.pendingPatches()).toBe(0);
  });

  it('the latest patch of a field wins; untouched rows keep their identity', () => {
    const r = createListRefresher<Resp>({ fetch: async () => ({ sessions: [] }), apply: () => {} });
    r.notePatch('a', { runningBgTasks: 2 });
    r.notePatch('a', { runningBgTasks: 0 });
    const b = mkRow('b');
    const rows = r.overlay([mkRow('a', { runningBgTasks: 5 }), b], 0);
    expect(rows[0].runningBgTasks).toBe(0);
    expect(rows[1]).toBe(b);
    const same = [mkRow('a', { runningBgTasks: 0 })];
    expect(r.overlay(same, 0)).toBe(same);                // nothing to change ⇒ same array
  });

  it('N triggers during a flight ⇒ at most 2 GETs', async () => {
    const gets: Array<ReturnType<typeof deferred<Resp>>> = [];
    const r = createListRefresher<Resp>({
      fetch: () => { const d = deferred<Resp>(); gets.push(d); return d.promise; },
      apply: () => {},
    });
    const first = r.refresh();
    for (let i = 0; i < 10; i++) void r.refresh();
    expect(gets.length).toBe(1);
    gets[0].resolve({ sessions: [] });
    await new Promise((res) => setTimeout(res, 0));
    expect(gets.length).toBe(2);                          // exactly one rerun
    gets[1].resolve({ sessions: [] });
    await first;
    expect(gets.length).toBe(2);
    // Idle again: the next trigger starts a fresh GET.
    const again = r.refresh();
    expect(gets.length).toBe(3);
    gets[2].resolve({ sessions: [] });
    await again;
  });

  it('a failed GET does not wedge the refresher', async () => {
    let n = 0;
    const applied: number[] = [];
    const r = createListRefresher<Resp>({
      fetch: async () => { n++; if (n === 1) throw new Error('down'); return { sessions: [] }; },
      apply: () => applied.push(n),
    });
    await r.refresh();
    expect(applied).toEqual([]);
    await r.refresh();
    expect(applied).toEqual([2]);
  });
});

describe('reuseSessionRows (W2 review: fresh `gates` arrays defeated the guard)', () => {
  const gated = (id: string, o: Partial<SessionListItem> = {}) => JSON.parse(JSON.stringify(mkRow(id, {
    gates: [{ id: 'g1', kind: 'permission', blocking: true, createdAt: 1, expiresAt: null, title: 'Bash' }],
    endpoint: { name: 'relay' }, ...o,
  } as any))) as SessionListItem;

  it('an unchanged list (fresh JSON identities) keeps the previous array', () => {
    const prev = [gated('a'), gated('b')];
    const next = [gated('a'), gated('b')];
    expect(reuseSessionRows(prev, next)).toBe(prev);
  });

  it('a changed row is new, the unchanged ones keep their identity', () => {
    const prev = [gated('a'), gated('b')];
    const next = [gated('a'), gated('b', { gates: [] } as any)];
    const out = reuseSessionRows(prev, next);
    expect(out).not.toBe(prev);
    expect(out[0]).toBe(prev[0]);
    expect(out[1]).toBe(next[1]);
  });

  it('a reorder or a removal is a change', () => {
    const prev = [gated('a'), gated('b')];
    const swapped = reuseSessionRows(prev, [gated('b'), gated('a')]);
    expect(swapped).not.toBe(prev);
    expect(swapped[0]).toBe(prev[1]);
    expect(reuseSessionRows(prev, [gated('a')])).toEqual([prev[0]]);
  });
});
