'use client';
import { useEffect, useSyncExternalStore } from 'react';
import type { AccountProfile } from '@/lib/accountProfiles';
import { api } from '@/lib/api';
import { invalidateCodexModels } from './codexModelsCache';
import { subscribeAll } from './globalEventStream';

let profiles: AccountProfile[] = [];
const empty: AccountProfile[] = [];
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;
let unsubscribe: (() => void) | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

export function refreshAccountProfiles(): Promise<void> {
  if (inflight) return inflight;
  inflight = api.getAccountProfiles().then((result) => {
    profiles = result.profiles;
    for (const listener of listeners) listener();
  }).catch(() => {}).finally(() => { inflight = null; });
  return inflight;
}

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

export function useAccountProfiles(vpsId?: string): AccountProfile[] {
  const all = useSyncExternalStore(subscribe, () => profiles, () => empty);
  useEffect(() => { void refreshAccountProfiles(); }, []);
  return vpsId ? all.filter((p) => p.vpsId === vpsId) : all;
}
