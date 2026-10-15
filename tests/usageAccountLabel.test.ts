import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UsagePopover } from '../app/UsageMeter';
import { accountDisplayName } from '@/lib/accountProfiles';
import { newestAccountUsage } from '@/app/accountUsageState';
import type { AccountUsage } from '@/lib/server/claude/types';

// The vitest transform is classic JSX.
(globalThis as { React?: typeof React }).React = React;

// Whose usage the popover shows: provider + account, so two accounts on one
// VPS (which can read near-identical numbers) are never confused.
describe('usage account label', () => {
  it('names the account: profile name, else login email, else "Account N"', () => {
    expect(accountDisplayName({ name: 'work', email: 'a@x.io' }, 2)).toBe('work');
    expect(accountDisplayName({ name: '', email: 'a@x.io' }, 2)).toBe('a@x.io');
    expect(accountDisplayName({ name: '  ', email: null }, 3)).toBe('Account 3');
    expect(accountDisplayName(undefined)).toBe('Account 1');
  });

  const usage: AccountUsage = { ok: true, provider: 'claude', fetchedAt: Date.now(),
    fiveHour: { utilization: 25, resetsAt: null }, sevenDay: { utilization: 82, resetsAt: null } };

  it('shows provider and account in the open popover (ok, failed and empty)', () => {
    const ok = renderToStaticMarkup(createElement(UsagePopover, { usage, vpsName: 'box', provider: 'claude', accountName: 'chalomcohen' }));
    expect(ok).toContain('Claude · chalomcohen');
    expect(ok).toContain('aria-label="Account usage: Claude · chalomcohen"');
    const failed = renderToStaticMarkup(createElement(UsagePopover, {
      usage: { ok: false, provider: 'codex', fetchedAt: 1, error: 'unknown' }, provider: 'codex', accountName: 'Account 2' }));
    expect(failed).toContain('Codex · Account 2');
    const empty = renderToStaticMarkup(createElement(UsagePopover, { usage: null, provider: 'codex', accountName: 'b@x.io' }));
    expect(empty).toContain('Codex · b@x.io');
  });
});

describe('account_changed markers in the browser merge', () => {
  const good: AccountUsage = { ok: true, fetchedAt: 1_000, accountKey: 'K', fiveHour: { utilization: 25, resetsAt: null } };
  const marker: AccountUsage = { ok: false, fetchedAt: 9_000, accountKey: 'K', error: 'account_changed' };

  it('a same-login marker never hides (or outlives) that account\'s real reading', () => {
    expect(newestAccountUsage(good, marker)).toBe(good);
    expect(newestAccountUsage(marker, good)).toBe(good);
  });

  it('a marker for a different login still replaces the old account\'s gauges', () => {
    const moved = { ...marker, accountKey: 'OTHER' };
    expect(newestAccountUsage(good, moved)).toBe(moved);
  });
});
