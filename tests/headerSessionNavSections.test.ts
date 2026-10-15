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

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PULSE_PERIOD_MS, navAttentionClass, pulsePhaseStyle } from '@/app/HeaderSessionNav';

describe('navAttentionClass — the trigger class shared with the account buttons', () => {
  const cls = (xs: SessionListItem[], viewed: string | null = null) => navAttentionClass(xs.map((x) => rowOf(x, viewed)));
  it('blocked or async question ⇒ waiting; unread only ⇒ unread; waiting outranks unread', () => {
    expect(cls([item('b', { status: 'thinking', pendingBlocking: 1, pendingAsync: 0 })])).toBe('has-waiting');
    expect(cls([item('q', { status: 'sleeping', pendingBlocking: 0, pendingAsync: 1 })])).toBe('has-waiting');
    expect(cls([item('u', { unreadStop: 1 })])).toBe('has-unread');
    expect(cls([item('u', { unreadStop: 1 }), item('q', { pendingBlocking: 0, pendingAsync: 1 })])).toBe('has-waiting');
    expect(cls([item('u', { unreadStop: 1 })], 'u')).toBe('');
    expect(cls([item('busy', { status: 'thinking' })])).toBe('');
  });
});

describe('pulse phase lock', () => {
  it('delays each pulse by the wall clock modulo its period', () => {
    expect(pulsePhaseStyle('has-unread', 1800 * 3 + 250)).toEqual({ animationDelay: '-250ms' });
    expect(pulsePhaseStyle('has-waiting', 1300 * 7 + 40)).toEqual({ animationDelay: '-40ms' });
    expect(pulsePhaseStyle('', 12345)).toBeUndefined();
    expect(pulsePhaseStyle('has-unread', 0)).toBeUndefined();
  });

  it('the account button shares the trigger\'s rule and its CSS durations match PULSE_PERIOD_MS', () => {
    const css = readFileSync(path.resolve(__dirname, '../app/claude.css'), 'utf8');
    const rule = (sel: string) => {
      const at = css.indexOf(sel);
      expect(at, sel).toBeGreaterThan(-1);
      return css.slice(at, css.indexOf('}', at));
    };
    expect(rule('.claude-head .hnav-trigger.has-unread, .claude-head .acct-nav-item.has-unread {'))
      .toContain(`row-pulse-green ${PULSE_PERIOD_MS['has-unread'] / 1000}s`);
    expect(rule('.claude-head .hnav-trigger.has-waiting, .claude-head .acct-nav-item.has-waiting {'))
      .toContain(`row-pulse ${PULSE_PERIOD_MS['has-waiting'] / 1000}s`);
  });
});
