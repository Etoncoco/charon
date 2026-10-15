import type { SessionProvider } from './sessionCapabilities';

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

/** Whose usage a gauge shows: the profile's name, else its verified login
 *  email, else "Account N" (N = profile number, 1 = the default login). */
export function accountDisplayName(
  profile: Pick<AccountProfile, 'name' | 'email'> | null | undefined, number = 1,
): string {
  return profile?.name?.trim() || profile?.email?.trim() || `Account ${number}`;
}
