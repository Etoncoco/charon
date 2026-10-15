'use client';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

// In-memory store of "drafts" for the input area (textarea for messages to
// Claude), indexed by session id.
//
// Persistence is deliberately ephemeral:
//   - Module-level Map → survives component re-mounts triggered by
//     `<ClaudeSessionView key={selectedId}>` (session switch).
//   - No localStorage / sessionStorage → an F5 wipes everything. This is the
//     expected behavior (per user request): we keep the draft while
//     navigating between sessions, no more.
//
// Consumed by `app/ClaudeSessionView.tsx` via the `useInputDraft` hook.

const drafts = new Map<string, string>();

export function getDraft(sessionId: string): string {
  return drafts.get(sessionId) ?? '';
}

export function setDraft(sessionId: string, value: string): void {
  // Emptying the string ⇒ removes the entry (avoids the Map growing
  // indefinitely when the user sends their message or clears everything).
  if (value) drafts.set(sessionId, value);
  else drafts.delete(sessionId);
}

export function clearDraft(sessionId: string): void {
  drafts.delete(sessionId);
}

/** Does any session hold unsent text? (A new-build auto-reload waits while it
 *  does — globalEventStream.ts § maybeReloadForBuild.) */
export function hasNonEmptyDraft(): boolean {
  for (const v of drafts.values()) if (v.trim()) return true;
  return false;
}

// Other unsaved-input surfaces (a typed question answer, a commit message, a
// dirty editor buffer): component state an auto-reload would lose. Each one
// marks itself (`markUnsavedInput` / `useUnsavedInput`) or registers a
// predicate (`registerUnsavedSource`); `hasUnsavedInput()` is the union with
// the composer drafts.
const unsavedMarks = new Set<string>();
const unsavedSources = new Set<() => boolean>();

export function markUnsavedInput(key: string, unsaved: boolean): void {
  if (unsaved) unsavedMarks.add(key); else unsavedMarks.delete(key);
}

export function registerUnsavedSource(source: () => boolean): () => void {
  unsavedSources.add(source);
  return () => { unsavedSources.delete(source); };
}

export function hasUnsavedInput(): boolean {
  if (hasNonEmptyDraft() || unsavedMarks.size > 0) return true;
  for (const src of unsavedSources) { try { if (src()) return true; } catch { /* ignore */ } }
  return false;
}

/** Marks the calling component as holding unsaved input while `unsaved`. */
export function useUnsavedInput(unsaved: boolean): void {
  const key = useId();
  useEffect(() => {
    markUnsavedInput(key, unsaved);
    return () => markUnsavedInput(key, false);
  }, [key, unsaved]);
}

/**
 * React hook that exposes `[input, setInput]` like a regular `useState`,
 * but wired to the shared store.
 *
 * - Lazy initialization from the store → no flash of empty input on mount.
 * - In-render reconciliation when `sessionId` changes on the same component
 *   instance without a keyed remount (defensive: if a parent ever swaps the
 *   prop in place, we resync via a ref vs prop comparison — the "derived state
 *   from props" pattern without useEffect — no flash, no loop).
 * - Each mutation writes to the store, which makes usage transparent:
 *   call-sites do `setInput(value)` as before.
 */
export function useInputDraft(sessionId: string): [string, (v: string) => void] {
  const [input, setInputState] = useState<string>(() => getDraft(sessionId));
  const lastSidRef = useRef(sessionId);
  if (lastSidRef.current !== sessionId) {
    lastSidRef.current = sessionId;
    setInputState(getDraft(sessionId));
  }
  const setInput = useCallback(
    (v: string) => {
      setInputState(v);
      setDraft(sessionId, v);
    },
    [sessionId],
  );
  return [input, setInput];
}
