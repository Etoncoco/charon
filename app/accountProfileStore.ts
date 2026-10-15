'use client';
import { useEffect, useSyncExternalStore } from 'react';
import type { AccountProfile } from '@/lib/accountProfiles';
import { api } from '@/lib/api';
import { invalidateCodexModels } from './codexModelsCache';
import { subscribeAll } from './globalEventStream';
import { createRerunner } from './sync/revResource';

let profiles: AccountProfile[] = [];
/** The first GET has SETTLED (success or failure): before it, every session
 *  looks profile-less and the header's account buttons would split one login
 *  per VPS, then merge and reorder under the pointer. */
let loaded = false;
const empty: AccountProfile[] = [];
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

// One GET at a time; an invalidation during the flight reruns it ONCE after
// (never joins it: the in-flight answer may predate the change — R3 F14).
const rerunner = createRerunner(async () => {
  try {
    const result = await api.getAccountProfiles();
    profiles = result.profiles;
  } finally {
    loaded = true;
    for (const listener of listeners) listener();
  }
});

export function refreshAccountProfiles(): Promise<void> {
  return rerunner.trigger();
}
/** Alias (the resync handler's name for it). */
export const refresh = refreshAccountProfiles;

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    if (!unsubscribe) unsubscribe = subscribeAll((event) => {
      if (event.type === 'account_profiles_changed') invalidateCodexModels(event.sessionId);
      if (event.type === 'account_profiles_changed' || event.type === 'vps_status') void refreshAccountProfiles();
    });
    if (!timer) timer = setInterval(() => { if (!document.hidden) void refreshAccountProfiles(); }, 30_000);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) {
        unsubscribe?.(); unsubscribe = null;
        if (timer) clearInterval(timer);
        timer = null;
      }
    };
}

export function useAccountProfilesLoaded(): boolean {
  return useSyncExternalStore(subscribe, () => loaded, () => false);
}

export function useAccountProfiles(vpsId?: string): AccountProfile[] {
  const all = useSyncExternalStore(subscribe, () => profiles, () => empty);
  useEffect(() => { void refreshAccountProfiles(); }, []);
  return vpsId ? all.filter((p) => p.vpsId === vpsId) : all;
}
