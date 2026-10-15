// Per-ACCOUNT header buttons (app/AccountNav.tsx, CLAUDE.md §11): which logins
// this hub uses, across every VPS. Pure and browser-safe — no React, no clock.
//
// One group = provider + login identity (`AccountProfile.accountKey`, the
// agent's hash of the native account ids: VPS- and profile-independent, the
// same key the usage poller shares gauges on, §14.58/§14.72). The same login
// on three VPSes is ONE group. A profile with no verified identity (Cursor
// never has one; a default profile until its VPS was probed) is its own
// group, keyed (vps, provider, profile): an unverified identity is never
// shared (§14.72).
//
// Sessions on a custom endpoint are left out: they bill the endpoint, not the
// login (§4 customEndpoints). The global nav still lists them.
import type { SessionListItem } from '@/lib/types/api';
import type { AccountUsage } from '@/lib/server/claude/types';
import { SESSION_PROVIDERS, asSessionProvider, type SessionProvider } from './sessionCapabilities';
import { providerName, providerText } from './providerText';
import {
  accountProfileId, accountProfileNumber, profileUsageKey, sessionAccountProfile, usageAccountLabel,
  type AccountProfile,
} from './accountProfiles';
import { accountUsageReadAt } from '@/app/accountUsageState';

export type AccountMember = {
  vpsId: string;
  profileId: string;
  /** Null when the session names a profile the store does not (yet) list. */
  profile: AccountProfile | null;
  /** `profileUsageKey(vps, provider, profile)` — the usage store's key. */
  usageKey: string;
  /** Number of this member's sessions in the group. */
  sessionCount: number;
};

export type AccountGroup = {
  /** `acct:<provider>:<accountKey>` or `local:<vps>:<provider>:<profile>`. */
  key: string;
  provider: SessionProvider;
  accountKey: string | null;
  /** Sorted by VPS id, then profile number. Never empty. */
  members: AccountMember[];
  sessions: SessionListItem[];
  /** Short visible label (the logo carries the provider). */
  label: string;
  /** Full identity: provider + profile + email + VPSes (tooltip/aria). */
  title: string;
  /** `usageAccountLabel` of the best profile — what the usage popover shows. */
  accountLabel: string;
  email: string | null;
  signedIn: boolean;
  vpsNames: string[];
};

export function accountGroupKey(
  provider: SessionProvider, vpsId: string, profileId: string, profile: AccountProfile | null | undefined,
): string {
  const key = profile?.accountKey;
  return key ? `acct:${provider}:${key}` : `local:${vpsId}:${provider}:${profileId}`;
}

type Draft = {
  key: string;
  provider: SessionProvider;
  accountKey: string | null;
  members: Map<string, AccountMember>;
  sessions: SessionListItem[];
  /** Fallback profile number when no profile row is known (session-only). */
  number: number;
};

export function buildAccountGroups(input: {
  sessions: readonly SessionListItem[];
  profiles: readonly AccountProfile[];
  enabled: Readonly<Record<SessionProvider, boolean>>;
  vpsName: (vpsId: string) => string;
}): AccountGroup[] {
  const { sessions, profiles, enabled, vpsName } = input;
  const drafts = new Map<string, Draft>();
  const member = (provider: SessionProvider, vpsId: string, profileId: string, profile: AccountProfile | null, number: number) => {
    const key = accountGroupKey(provider, vpsId, profileId, profile);
    let d = drafts.get(key);
    if (!d) {
      d = { key, provider, accountKey: profile?.accountKey || null, members: new Map(), sessions: [], number };
      drafts.set(key, d);
    }
    const usageKey = profileUsageKey(vpsId, provider, profileId);
    let m = d.members.get(usageKey);
    if (!m) {
      m = { vpsId, profileId, profile, usageKey, sessionCount: 0 };
      d.members.set(usageKey, m);
    } else if (!m.profile && profile) {
      m.profile = profile;
    }
    return { d, m };
  };

  for (const s of sessions) {
    if (s.endpoint?.active) continue;
    const provider = asSessionProvider(s.kind);
    const profile = sessionAccountProfile(profiles, s) ?? null;
    const { d, m } = member(provider, s.vpsId, accountProfileId(s), profile, accountProfileNumber(s));
    d.sessions.push(s);
    m.sessionCount += 1;
  }
  for (const p of profiles) {
    if (p.loggedIn !== true || !enabled[p.provider]) continue;
    member(p.provider, p.vpsId, p.id, p, p.number);
  }

  const groups = [...drafts.values()].map((d): AccountGroup => {
    const members = [...d.members.values()].sort((a, b) =>
      a.vpsId.localeCompare(b.vpsId) || (a.profile?.number ?? 0) - (b.profile?.number ?? 0)
      || a.profileId.localeCompare(b.profileId));
    const known = members.map((m) => m.profile).filter((p): p is AccountProfile => !!p)
      .sort((a, b) => a.number - b.number);
    const named = known.find((p) => p.name.trim());
    const email = known.map((p) => p.email?.trim()).find((e): e is string => !!e) ?? null;
    const best = named ?? known[0] ?? null;
    const number = best?.number ?? d.number;
    const name = providerName(d.provider);
    const label = named?.name.trim() || email || `${name}${number > 1 ? ` ${number}` : ''}`;
    const accountLabel = usageAccountLabel(name, best, number);
    const vpsNames = [...new Set(members.map((m) => vpsName(m.vpsId)))];
    return {
      key: d.key,
      provider: d.provider,
      accountKey: d.accountKey,
      members,
      sessions: d.sessions,
      label,
      title: '',
      accountLabel,
      email,
      signedIn: known.some((p) => p.loggedIn === true),
      vpsNames,
    };
  });

  // Two different logins that would read alike get their machine appended.
  const clashing = groups.filter((g) => groups.some((o) => o !== g && o.provider === g.provider && o.label === g.label));
  for (const g of clashing) g.label = `${g.label} · ${g.vpsNames.join(', ')}`;
  for (const g of groups) {
    const full = g.email && !g.accountLabel.includes(g.email) ? `${g.accountLabel} · ${g.email}` : g.accountLabel;
    g.title = providerText.accountButton(g.provider, full, g.vpsNames);
  }

  // Stable order: buttons never move under the pointer on activity.
  const rank = (p: SessionProvider) => SESSION_PROVIDERS.indexOf(p);
  return groups.sort((a, b) =>
    rank(a.provider) - rank(b.provider) || a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
}

/** The group's gauges: the newest reading over its members. A reading stamped
 *  with ANOTHER login never shows (§14.58); a good reading outranks a failure. */
export function accountGroupUsage(
  group: AccountGroup, usageByKey: Readonly<Record<string, AccountUsage | undefined>>,
): AccountUsage | null {
  let best: AccountUsage | null = null;
  for (const m of group.members) {
    const u = usageByKey[m.usageKey];
    if (!u) continue;
    const expected = group.accountKey ?? m.profile?.accountKey ?? null;
    if (expected && u.accountKey && u.accountKey !== expected) continue;
    if (!best
      || (u.ok && !best.ok)
      || (u.ok === best.ok && accountUsageReadAt(u) > accountUsageReadAt(best))) best = u;
  }
  return best;
}

/** The member whose usage this tab fetches: one with sessions, else a
 *  signed-in one, else the first. */
export function accountGroupRepresentative(group: AccountGroup): AccountMember {
  return group.members.find((m) => m.sessionCount > 0)
    ?? group.members.find((m) => m.profile?.loggedIn === true)
    ?? group.members[0];
}
