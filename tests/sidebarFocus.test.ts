import { describe, expect, it } from 'vitest';
import type { SessionListItem } from '@/lib/types/api';
import { focusAdmits, focusEmptyText, sessionFocusFacts, shellFocusFacts } from '@/app/sidebarFocus';

// The sidebar's focus chips: "unread" (the cards' ✓) and "running" (working
// status, busy shell) ADD up; none on admits everything.
const session = (extra: Partial<SessionListItem> & Record<string, unknown>): SessionListItem => ({
  id: 's', vpsId: 'v', name: 's', cwd: '/p', kind: 'claude', status: 'active', createdAt: 1, ...extra,
} as unknown as SessionListItem);

describe('sidebar focus chips', () => {
  const unread = sessionFocusFacts(session({ id: 'u', unreadStop: 1 }), null);
  const running = sessionFocusFacts(session({ id: 'r', status: 'thinking' }), null);
  const idle = sessionFocusFacts(session({ id: 'i' }), null);

  it('reads unread and running the way the cards do', () => {
    expect(unread).toEqual({ unread: true, running: false });
    expect(running).toEqual({ unread: false, running: true });
    expect(idle).toEqual({ unread: false, running: false });
    // The open session's ✓ is not drawn, so it is not "unread" here either.
    expect(sessionFocusFacts(session({ id: 'u', unreadStop: 1 }), 'u').unread).toBe(false);
  });

  it('no chip on admits everything', () => {
    for (const f of [unread, running, idle]) expect(focusAdmits({ unread: false, running: false }, f)).toBe(true);
  });

  it('each chip admits its own kind, and both add up', () => {
    expect([unread, running, idle].map((f) => focusAdmits({ unread: true, running: false }, f))).toEqual([true, false, false]);
    expect([unread, running, idle].map((f) => focusAdmits({ unread: false, running: true }, f))).toEqual([false, true, false]);
    expect([unread, running, idle].map((f) => focusAdmits({ unread: true, running: true }, f))).toEqual([true, true, false]);
  });

  it('a busy shell runs; an exited one does not; an unattended finish is unread', () => {
    expect(shellFocusFacts({ id: 'a', liveStatus: 'busy' }, null).running).toBe(true);
    expect(shellFocusFacts({ id: 'b', liveStatus: 'busy', exited: true }, null).running).toBe(false);
    expect(shellFocusFacts({ id: 'c', unreadFinish: true, liveStatus: 'idle' }, null).unread).toBe(true);
  });

  it('says what is missing when nothing matches', () => {
    expect(focusEmptyText({ unread: true, running: false })).toBe('Nothing unread.');
    expect(focusEmptyText({ unread: false, running: true })).toBe('Nothing running.');
    expect(focusEmptyText({ unread: true, running: true })).toBe('Nothing unread or running.');
  });
});
