import 'server-only';
import type { SessionProvider } from '@/lib/sessionCapabilities';
import type { ProfileStatus } from './accountProfiles';

const runtime = globalThis as unknown as {
  _accountProfileStatus?: Map<string, ProfileStatus>;
  _accountIdentityChecked?: Set<string>;
  _cursorIdentities?: Map<string, string | null>;
};
export const profileStatuses = runtime._accountProfileStatus ??= new Map();
/** VPSes whose account probe has ANSWERED at least once in this process (even
 *  with a failure). Until then the usage poller waits: a poll made before the
 *  identity is known lands in a private bucket and is wasted (§14.72). */
export const identityChecked: Set<string> = runtime._accountIdentityChecked ??= new Set();
export const statusKey = (vpsId: string, provider: SessionProvider, profile = 'default') => `${vpsId}:${provider}:${profile}`;
/** The login email of each VPS's Cursor key, as `cursor_auth_status` last
 *  reported it (null = signed out / no email). Cursor has no account_profiles
 *  probe: this is the header button's only official identity. In memory. */
export const cursorIdentities: Map<string, string | null> = runtime._cursorIdentities ??= new Map();
