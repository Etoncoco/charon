'use client';
// "Is a human at this device?" — the client half of ATTENDED viewing
// (CLAUDE.md §14.47, SPEC I10). Viewed = visible AND input on this device
// within the last 120 s: a forgotten desktop tab left on a session must not
// swallow the green "finished, unread" cue for the phone, and an idle tab must
// not acknowledge a finish nobody read.
//
// Input = passive capture of pointerdown/keydown/wheel/touchstart, plus the
// tab becoming visible. The SSE URL carries `attentive=1|0`, every focus POST
// carries `attentive`, and on an idle→active transition the device proves its
// attention at once (POST /focus `{kind:'attention'}`), then at most once per
// 30 s while active and a session is focused (the server's window is 120 s).
//
// `createAttentionTracker` is the pure core (unit-tested, clock injected); the
// module-level singleton below wires it to the DOM for globalEventStream.

export const ATTENTION_WINDOW_MS = 120_000;
export const ATTENTION_POST_INTERVAL_MS = 30_000;

export type AttentionTracker = {
  /** A user input (or the tab turning visible) happened now. */
  noteInput(): void;
  /** The tab turned visible: input too, but the focus re-POST that
   *  globalEventStream sends on that same event (carrying `attentive:true`)
   *  is the proof — no second POST. */
  noteVisible(): void;
  isAttentive(): boolean;
};

export function createAttentionTracker(deps: {
  now: () => number;
  isVisible: () => boolean;
  /** A session is focused on this tab's connection (periodic proofs only then). */
  hasFocus: () => boolean;
  /** Send POST /focus `{kind:'attention'}`. */
  post: () => void;
  /** Initial input time (a page load is a user action); default = now. */
  initialInputAt?: number;
}): AttentionTracker {
  let lastInputAt = deps.initialInputAt ?? deps.now();
  let lastPostAt = Number.NEGATIVE_INFINITY;
  const attentiveAt = (t: number) => deps.isVisible() && t - lastInputAt <= ATTENTION_WINDOW_MS;
  return {
    noteInput() {
      const t = deps.now();
      const wasAttentive = attentiveAt(t);
      lastInputAt = t;
      if (!deps.isVisible()) return;
      if (!wasAttentive) {
        // idle → active: prove it at once (acknowledges what the tab shows).
        lastPostAt = t;
        deps.post();
        return;
      }
      if (deps.hasFocus() && t - lastPostAt >= ATTENTION_POST_INTERVAL_MS) {
        lastPostAt = t;
        deps.post();
      }
    },
    noteVisible() {
      const t = deps.now();
      lastInputAt = t;
      lastPostAt = t;
    },
    isAttentive() {
      return attentiveAt(deps.now());
    },
  };
}

// ── DOM singleton ───────────────────────────────────────────────────────────
let tracker: AttentionTracker | null = null;

const docVisible = () => typeof document !== 'undefined' && document.visibilityState === 'visible';

/**
 * Wire the tracker to the window once (idempotent). `post` and `hasFocus` come
 * from globalEventStream, which owns the connection id and the focus.
 */
export function installAttentionTracking(post: () => void, hasFocus: () => boolean): void {
  if (tracker || typeof window === 'undefined') return;
  const t = createAttentionTracker({ now: () => Date.now(), isVisible: docVisible, hasFocus, post });
  tracker = t;
  const onInput = () => t.noteInput();
  const opts: AddEventListenerOptions = { capture: true, passive: true };
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
    window.addEventListener(type, onInput, opts);
  }
  document.addEventListener('visibilitychange', () => {
    if (docVisible()) t.noteVisible();
  });
}

/** visible && an input within the last 120 s. Before installation: visible. */
export function isAttentive(): boolean {
  return tracker ? tracker.isAttentive() : docVisible();
}
