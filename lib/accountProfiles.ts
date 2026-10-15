import { asSessionProvider, type SessionProvider } from './sessionCapabilities';

export const DEFAULT_ACCOUNT_PROFILE = 'default';
export type AccountProfile = {
  id: string;
  vpsId: string;
  provider: SessionProvider;
  number: number;
  name: string;
  loggedIn: boolean | null;
  accountKey?: string | null;
  /** Login identity the agent verified (public, like the account menu's). */
  email?: string | null;
  /** The provider's own name for that login (Claude `displayName`), never the profile name. */
  displayName?: string | null;
  /** Public plan / organization of that login (the account menu's fields). */
  subscriptionType?: string | null;
  organization?: string | null;
};

export function accountProfileId(config: unknown): string {
  if (typeof config === 'string') {
    try { config = JSON.parse(config); } catch { return DEFAULT_ACCOUNT_PROFILE; }
  }
  if (config && typeof config === 'object' && !('accountProfile' in config) && 'codexConfig' in config) {
    return accountProfileId((config as { codexConfig: unknown }).codexConfig);
  }
  const id = (config as { accountProfile?: unknown } | null)?.accountProfile;
  return typeof id === 'string' && id ? id : DEFAULT_ACCOUNT_PROFILE;
}

export function accountProfileNumber(config: unknown): number {
  if (typeof config === 'string') {
    try { config = JSON.parse(config); } catch { return 1; }
  }
  if (config && typeof config === 'object' && !('accountProfileNumber' in config) && 'codexConfig' in config) {
    return accountProfileNumber((config as { codexConfig: unknown }).codexConfig);
  }
  const n = (config as { accountProfileNumber?: unknown } | null)?.accountProfileNumber;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : 1;
}

export function profileUsageKey(vpsId: string, provider: SessionProvider, profile = DEFAULT_ACCOUNT_PROFILE): string {
  return `${vpsId}:${provider}:${profile}`;
}

export function profileLabel(providerName: string, profile: AccountProfile): string {
  return `${providerName}${profile.number > 1 ? ` ${profile.number}` : ''}${profile.name ? ` · ${profile.name}` : ''}`;
}

/** The profile a session runs on: matched by (VPS, provider, profile id) —
 *  two profiles on one VPS must never resolve to each other. */
export function sessionAccountProfile(
  profiles: readonly AccountProfile[],
  session: { vpsId?: string | null; kind?: string | null; codexConfig?: unknown } | null | undefined,
): AccountProfile | undefined {
  if (!session) return undefined;
  const provider = asSessionProvider(session.kind);
  const id = accountProfileId(session);
  return profiles.find((p) => p.vpsId === session.vpsId && p.provider === provider && p.id === id);
}

/** Whose usage a gauge shows: the SAME `profileLabel` the menus and badges
 *  use ("Claude 2 · work"), plus the verified login email when the profile
 *  has no name. Unknown profile ⇒ provider + number. */
export function usageAccountLabel(
  providerName: string, profile: AccountProfile | null | undefined, number = 1,
): string {
  if (!profile) return `${providerName}${number > 1 ? ` ${number}` : ''}`;
  const email = profile.name.trim() ? '' : profile.email?.trim() ?? '';
  return `${profileLabel(providerName, profile)}${email ? ` · ${email}` : ''}`;
}
