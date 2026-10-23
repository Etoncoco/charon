// The sidebar's focus chips (Sidebar § cs-focus): list only what finished
// unread and/or what is running. The two ADD up — both on admits either kind —
// and no chip on admits everything. "Unread" is the cards' own ✓ (attention
// 'unread', §14.47); "running" is the header nav's "Working": a working status,
// or a busy shell.
import { attentionForRow, rowStatus, shellAttention } from '@/lib/sessionAttention';
import { isWorkingStatus } from './sessionUnread';
import type { SessionListItem } from '@/lib/types/api';

export type Focus = { unread: boolean; running: boolean };
export type FocusFacts = { unread: boolean; running: boolean };

type FocusShell = { id: string; unreadFinish?: boolean; liveStatus?: string | null; exited?: boolean };

export function sessionFocusFacts(s: SessionListItem, selectedId: string | null): FocusFacts {
  return {
    unread: attentionForRow(s, { viewedHere: s.id === selectedId }) === 'unread',
    running: isWorkingStatus(rowStatus(s)),
  };
}

export function shellFocusFacts(sh: FocusShell, selectedShellId: string | null): FocusFacts {
  return {
    unread: shellAttention(sh, { viewedHere: sh.id === selectedShellId }) === 'unread',
    running: !sh.exited && sh.liveStatus === 'busy',
  };
}

export function focusAdmits(focus: Focus, facts: FocusFacts): boolean {
  if (!focus.unread && !focus.running) return true;
  return (focus.unread && facts.unread) || (focus.running && facts.running);
}

/** What the sidebar says when a focus is on and nothing matches. */
export function focusEmptyText(focus: Focus): string {
  return focus.unread && focus.running ? 'Nothing unread or running.' : focus.unread ? 'Nothing unread.' : 'Nothing running.';
}
