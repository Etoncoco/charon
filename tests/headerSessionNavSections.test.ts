import * as React from 'react';
import { describe, expect, it } from 'vitest';
import type { SessionListItem } from '@/lib/types/api';

// Classic JSX transform: components read the global React.
(globalThis as { React?: typeof React }).React = React;

import { navSections, rowOf, triggerClickOutcome } from '@/app/HeaderSessionNav';

// W2 review (C10): every session the badge counts as waiting has a row in the
// panel's top sections — a waiting session that is not working (an async
// question on an idle/paused session) used to be in neither Working nor
// Recently finished. Since C15 the rows ARE the summary store: no side feed.
const item = (id: string, extra: Partial<SessionListItem> & Record<string, unknown>): SessionListItem => ({
  id, vpsId: 'v', name: id, cwd: '/p', kind: 'codex', status: 'active', createdAt: 1,
  ...extra,
} as unknown as SessionListItem);

describe('HeaderSessionNav sections', () => {
  it('waiting-but-not-working rows get the Waiting section; working ones stay under Working', () => {
    const rows = [
      item('asyncIdle', { pendingBlocking: 0, pendingAsync: 1 }),
      item('asyncPaused', { status: 'sleeping', pendingBlocking: 0, pendingAsync: 1 }),
      item('blocked', { status: 'thinking', pendingBlocking: 1, pendingAsync: 0 }),
      item('busy', { status: 'thinking' }),
      item('done', {}),
    ].map((s) => rowOf(s, null));
    const { waitingOnly, running, finished } = navSections(rows);
    expect(waitingOnly.map((r) => r.s.id).sort()).toEqual(['asyncIdle', 'asyncPaused']);
    expect(running.map((r) => r.s.id).sort()).toEqual(['blocked', 'busy']);
    expect(finished.map((r) => r.s.id)).toEqual(['done']);
    // Every row the badge counts is listed in a top section.
    const top = new Set([...waitingOnly, ...running].map((r) => r.s.id));
    for (const r of rows.filter((x) => x.waiting)) expect(top.has(r.s.id)).toBe(true);
  });
});

describe('triggerClickOutcome', () => {
  it('a click on a hover-opened panel pins it instead of closing it', () => {
    expect(triggerClickOutcome(true, 'hover')).toBe('pin');
  });
  it('a closed panel opens; a click-opened panel closes', () => {
    expect(triggerClickOutcome(false, 'hover')).toBe('open');
    expect(triggerClickOutcome(false, 'click')).toBe('open');
    expect(triggerClickOutcome(true, 'click')).toBe('close');
  });
});
