'use client';
import { useCallback, useEffect, useSyncExternalStore } from 'react';

/**
 * The explorer's "hide git-ignored" switch, one value for every tree.
 *
 * Browser-local on purpose, like the sidebar's view chips (`showPaused.ts`):
 * it is a way of LOOKING at a folder, not a fact about it, and a phone
 * browsing one file should not re-filter a desktop's tree.
 *
 * Hydration matches the sidebar's: the first render shows everything (the
 * server has no localStorage and must render the same markup), and the stored
 * choice is read after mount.
 */

export const HIDE_IGNORED_KEY = 'hub.tree.hideIgnored.v1';

const g = globalThis as unknown as {
  __charonHideIgnored?: boolean;
  __charonHideIgnoredSubs?: Set<() => void>;
  __charonHideIgnoredRead?: boolean;
};
g.__charonHideIgnoredSubs ??= new Set<() => void>();

function notify(): void {
  for (const fn of g.__charonHideIgnoredSubs!) fn();
}

function getSnapshot(): boolean {
  return g.__charonHideIgnored ?? false;
}

function subscribe(fn: () => void): () => void {
  g.__charonHideIgnoredSubs!.add(fn);
  return () => { g.__charonHideIgnoredSubs!.delete(fn); };
}

function write(next: boolean): void {
  if (getSnapshot() === next) return;
  g.__charonHideIgnored = next;
  try { localStorage.setItem(HIDE_IGNORED_KEY, next ? '1' : '0'); } catch {}
  notify();
}

/** Adopt the stored choice, once per tab and never during render. */
function hydrate(): void {
  if (g.__charonHideIgnoredRead) return;
  g.__charonHideIgnoredRead = true;
  try {
    if (localStorage.getItem(HIDE_IGNORED_KEY) === '1') {
      g.__charonHideIgnored = true;
      notify();
    }
  } catch {}
}

/** `[hideIgnored, toggle]`. */
export function useTreeHideIgnored(): [boolean, () => void] {
  const value = useSyncExternalStore(subscribe, getSnapshot, () => false);
  useEffect(() => { hydrate(); }, []);
  return [value, useCallback(() => { write(!getSnapshot()); }, [])];
}
