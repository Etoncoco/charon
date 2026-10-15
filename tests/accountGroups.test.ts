import { describe, expect, it } from 'vitest';
import type { SessionListItem } from '@/lib/types/api';
import type { AccountProfile } from '@/lib/accountProfiles';
import type { AccountUsage } from '@/lib/server/claude/types';
import {
  accountGroupKey, accountGroupRepresentative, accountGroupUsage, buildAccountGroups,
} from '@/lib/accountGroups';
import { navAttentionClass, rowOf } from '@/app/HeaderSessionNav';

const s = (id: string, extra: Partial<SessionListItem> & Record<string, unknown> = {}): SessionListItem => ({
  id, vpsId: 'a', name: id, cwd: '/p', kind: 'claude', status: 'active', createdAt: 1, ...extra,
} as unknown as SessionListItem);

const prof = (extra: Partial<AccountProfile>): AccountProfile => ({
  id: 'default', vpsId: 'a', provider: 'claude', number: 1, name: '', loggedIn: true,
  accountKey: null, email: null, ...extra,
});

const ALL_ON = { claude: true, codex: true, cursor: true };
const names: Record<string, string> = { a: 'alpha', b: 'beta' };
const vpsName = (id: string) => names[id] ?? id;
const build = (sessions: SessionListItem[], profiles: AccountProfile[], enabled = ALL_ON) =>
  buildAccountGroups({ sessions, profiles, enabled, vpsName });

describe('buildAccountGroups — one group per login across VPSes', () => {
  it('the same accountKey on two VPSes (different profile ids) is ONE group with both sessions', () => {
    const profiles = [
      prof({ vpsId: 'a', accountKey: 'K', email: 'me@x.io' }),
      prof({ vpsId: 'b', id: 'p2', number: 2, accountKey: 'K', email: 'me@x.io' }),
    ];
    const groups = build([
      s('s1', { vpsId: 'a' }),
      s('s2', { vpsId: 'b', accountProfile: 'p2', accountProfileNumber: 2 }),
    ], profiles);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('acct:claude:K');
    expect(groups[0].members.map((m) => m.usageKey)).toEqual(['a:claude:default', 'b:claude:p2']);
    expect(groups[0].sessions.map((x) => x.id).sort()).toEqual(['s1', 's2']);
    expect(groups[0].vpsNames).toEqual(['alpha', 'beta']);
    expect(groups[0].title).toContain('me@x.io');
    expect(groups[0].title).toContain('alpha, beta');
  });

  it('the key includes the provider', () => {
    const groups = build([], [prof({ accountKey: 'K' }), prof({ provider: 'codex', accountKey: 'K' })]);
    expect(groups.map((g) => g.key)).toEqual(['acct:claude:K', 'acct:codex:K']);
  });

  it('no identity ⇒ one group per (vps, provider, profile); Cursor never merges across VPSes', () => {
    const groups = build([
      s('c1', { kind: 'cursor', vpsId: 'a' }),
      s('c2', { kind: 'cursor', vpsId: 'b' }),
    ], [prof({ provider: 'cursor', vpsId: 'a' }), prof({ provider: 'cursor', vpsId: 'b' })]);
    expect(groups.map((g) => g.key)).toEqual(['local:a:cursor:default', 'local:b:cursor:default']);
    // Two unnamed logins would read alike: the machine tells them apart.
    expect(groups.map((g) => g.label)).toEqual(['Cursor · alpha', 'Cursor · beta']);
  });

  it('a session whose profile is unknown falls back to its own (vps, provider, profile) group', () => {
    const groups = build([s('x', { kind: 'codex', vpsId: 'b', accountProfile: 'p7', accountProfileNumber: 3 })], []);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe(accountGroupKey('codex', 'b', 'p7', null));
    expect(groups[0].label).toBe('Codex 3');
  });

  it('custom-endpoint sessions bill the endpoint, not the login: excluded', () => {
    const groups = build([s('e', { endpoint: { active: { id: 'ep' } } } as unknown as Partial<SessionListItem>)], []);
    expect(groups).toEqual([]);
  });

  it('visibility: sessions, or a signed-in profile on an enabled backend', () => {
    const off = { ...ALL_ON, codex: false };
    expect(build([], [prof({ provider: 'codex', accountKey: 'C' })], off)).toEqual([]);
    expect(build([s('x', { kind: 'codex' })], [prof({ provider: 'codex', accountKey: 'C' })], off)
      .map((g) => g.key)).toEqual(['acct:codex:C']);
    expect(build([], [prof({ loggedIn: false }), prof({ vpsId: 'b', loggedIn: null })])).toEqual([]);
    expect(build([], [prof({ accountKey: 'K' })]).map((g) => g.key)).toEqual(['acct:claude:K']);
  });

  it('label: profile name > email > provider + number; stable provider-then-label order', () => {
    const groups = build([], [
      prof({ provider: 'codex', accountKey: 'C', email: 'z@x.io' }),
      prof({ accountKey: 'K1', name: 'work', email: 'w@x.io' }),
      prof({ vpsId: 'b', id: 'p2', number: 2, accountKey: 'K2' }),
      prof({ vpsId: 'b', accountKey: 'K0', email: 'a@x.io' }),
    ]);
    expect(groups.map((g) => [g.provider, g.label])).toEqual([
      ['claude', 'a@x.io'], ['claude', 'Claude 2'], ['claude', 'work'], ['codex', 'z@x.io'],
    ]);
    const work = groups.find((g) => g.label === 'work')!;
    expect(work.accountLabel).toBe('Claude · work');
    expect(work.title).toContain('w@x.io');
  });
});

describe('accountGroupUsage / representative', () => {
  const u = (extra: Partial<AccountUsage>): AccountUsage => ({ ok: true, fetchedAt: 1, ...extra } as AccountUsage);
  const [group] = build([s('s2', { vpsId: 'b', accountProfile: 'p2' })], [
    prof({ vpsId: 'a', accountKey: 'K' }),
    prof({ vpsId: 'b', id: 'p2', number: 2, accountKey: 'K' }),
  ]);

  it('newest good reading across members; another login\'s reading never shows', () => {
    expect(accountGroupUsage(group, {})).toBeNull();
    const older = u({ fetchedAt: 10, accountKey: 'K' });
    const newer = u({ fetchedAt: 20, accountKey: 'K' });
    expect(accountGroupUsage(group, { 'a:claude:default': older, 'b:claude:p2': newer })).toBe(newer);
    const foreign = u({ fetchedAt: 99, accountKey: 'OTHER' });
    expect(accountGroupUsage(group, { 'a:claude:default': foreign, 'b:claude:p2': older })).toBe(older);
    const failed = u({ ok: false, fetchedAt: 50, accountKey: 'K' });
    expect(accountGroupUsage(group, { 'a:claude:default': failed, 'b:claude:p2': older })).toBe(older);
  });

  it('the representative is a member with sessions', () => {
    expect(accountGroupRepresentative(group).usageKey).toBe('b:claude:p2');
  });
});

describe('per-account attention = the global nav predicate over its sessions', () => {
  it('a blocked session on another VPS of the same login lights its account orange, like the global nav', () => {
    const sessions = [
      s('done', { vpsId: 'a', unreadStop: 1 }),
      s('blocked', { vpsId: 'b', accountProfile: 'p2', status: 'thinking', pendingBlocking: 1, pendingAsync: 0 }),
      s('other', { kind: 'codex', vpsId: 'a', unreadStop: 1 }),
    ];
    const groups = build(sessions, [
      prof({ vpsId: 'a', accountKey: 'K' }),
      prof({ vpsId: 'b', id: 'p2', number: 2, accountKey: 'K' }),
      prof({ provider: 'codex', accountKey: 'C' }),
    ]);
    const cls = (xs: SessionListItem[], viewed: string | null = null) => navAttentionClass(xs.map((x) => rowOf(x, viewed)));
    expect(groups.map((g) => [g.key, cls(g.sessions)])).toEqual([
      ['acct:claude:K', 'has-waiting'], ['acct:codex:C', 'has-unread'],
    ]);
    expect(cls(sessions)).toBe('has-waiting');
    // Viewing the only unread session here clears it, as on the global nav.
    expect(cls(groups[1].sessions, 'other')).toBe('');
  });
});
