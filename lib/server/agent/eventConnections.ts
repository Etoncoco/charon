import 'server-only';
import { subscribeGlobalSessionEvents, setSessionFocusChecker, type GlobalSessionEvent } from './sessionOps';

// eventConnections
// ─────────────────────────────────────────────────────────────────────────────
// Registry of multiplexed SSE connections (/api/claude/events). Each browser
// client opens ONE persistent SSE on mount, identified by a connId (UUID
// generated on the client side). The focus (sessionId currently being
// watched) is mutable via POST /api/claude/focus — no close/reopen on switch.
//
// Fan-out rules:
//   - "Low-volume" events (status, mode_changed, ready, session_id,
//     permission_request, user_question, exit_plan_request,
//     interaction_resolved, error) → forwarded to ALL connections
//     (for sidebar badges + cross-session permissions popup).
//   - "High-volume" events (assistant_text, thinking, generation_progress, tool_use, tool_result,
//     edit_snapshot, user_echo, stop, prefill_input,
//     reconnecting, blocking_error, scheduled_resume, peer_message_status) →
//     forwarded ONLY to the connection that has the session
//     in focus. The client loads the history via GET in parallel.
//
// When a client switches focus:
//   1. Client POST /focus { conn, sessionId } → updates the focus
//   2. Client GET /api/claude/sessions/[id] → reloads the persisted history
//   3. SSE continues flowing — from now on the high-volume events of the
//      new session arrive

const LOW_VOLUME_EVENTS = new Set<string>([
  'status', 'mode_changed', 'ready', 'session_id',
  'permission_request', 'user_question', 'exit_plan_request',
  'interaction_resolved', 'error',
  // Rare-but-cross-tab events: a user can have the same session open in two
  // tabs (e.g. desktop + mobile/phone). All three should update the header
  // badge regardless of which tab is "focused" on the SSE multiplex.
  'model_changed', 'effort_changed', 'effective_model',
  // Shell live lifecycle status (sessionId = shellId, agent >= 0.9.0). Shells
  // are NOT the SSE's "focused session", so this must broadcast to every tab
  // to color the shell tabs/dots (blue "thinking" while busy). See
  // sessionOps.ts § emitGlobalShellStatus.
  'shell_status',
  // Live VPS agent-status flips (sessionId = vpsId) — sidebar badges on every
  // tab. See sessionOps.ts § emitGlobalVpsStatus.
  'vps_status',
  // Per-session "finished, unread" marker flips (sessionId = session id). Must
  // reach EVERY tab regardless of SSE focus: the whole point is to light up a
  // BACKGROUND (non-focused) session's sidebar card the moment it finishes.
  // See sessionOps.ts § markSessionRead / stop handler (CLAUDE.md §14.47).
  'session_unread',
  // Running background-task count (sessionId = session id): the sidebar card
  // shows it for EVERY session, not just the focused one (§14.91).
  'session_bg_tasks',
  // The Claude session SET changed (created / imported / deleted). A pure
  // "refetch the list" ping → must reach EVERY tab so the sidebar updates live
  // across tabs AND devices (a session started on a phone shows on the desktop
  // without an F5). See sessionOps.ts § emitGlobalSessionListChanged (§14.52).
  'session_list_changed',
  // Workspace layout — shared across devices, so it must reach every tab.
  'tabs_changed', 'settings_changed',
  // Account-usage gauges (sessionId = vpsId). ACCOUNT-global (not focus-scoped),
  // so every tab's header widget must update regardless of which session the SSE
  // is focused on. Source: usagePoll.ts → emitGlobalAccountUsage. §14.58.
  'account_usage',
  'account_profiles_changed',
  // Who is reading/writing which file, right now (sessionId = vpsId). The
  // explorer showing it is not necessarily the focused session's — with
  // several agents on one machine, the whole point is seeing the OTHERS.
  // One event per tool call, deduped hub-side. §14.88
  'file_activity',
  // What the running CLI can do (agent >= 0.36.0, sessionId = session id).
  // Drives capability-gated affordances, so every tab showing that session
  // must agree — and it is emitted once per CLI start, not per turn.
  'session_info',
  // Typed turn failure (auth/billing). Same cross-tab reasoning as `error`:
  // a session that just lost its credentials must light up everywhere, not
  // only in whichever tab happened to be focused. §14.65/68.
  'turn_error',
  // Rate-limit state off the stream. The limit is ACCOUNT-wide, so every tab
  // wants it regardless of which session it is focused on — same reasoning as
  // account_usage, which it complements rather than replaces (§14.72).
  'rate_limit',
  // The ids of every pending gate (sessionId 'pending'): sent once per legacy
  // SSE connect, after the pending replays, so the cross-session feed can drop
  // ghosts the snapshot no longer lists. Never published on the bus today.
  'pending_snapshot',
]);

function isLowVolume(type: string): boolean {
  return LOW_VOLUME_EVENTS.has(type);
}

// ── Registry (CLAUDE.md §14.15/§14.106) ──────────────────────────────────────
// One registered connection per connId, identified by its STREAM instance:
// `streamId` is a process-wide monotonic counter, and every unregister closes
// over its OWN ConnState. A reconnect with the same connId (the client gave up
// on a stream the proxy never reported closed) supersedes the old one: the old
// stream is CLOSED (its heartbeat with it), then replaced — and its late
// close/abort can no longer delete the replacement (the measured zombie conn:
// registered on paper, heartbeating, receiving nothing, every focus POST
// `ok:false`).
type ConnState = {
  connId: string;
  streamId: number;
  proto: 1 | 2;
  send?: (ev: GlobalSessionEvent) => void;
  push?: (chunk: Uint8Array) => void; // set by the sync bus route (C11)
  close: (reason: string) => void;
  focus: string | null;
  focusSeq: number;
  visible: boolean;
  /** Last proof of a human at this device (ms); 0 = none. */
  attentionAt: number;
  /** A client that never reports attention (pre-attention JS): attended = visible. */
  legacyAttention: boolean;
  unsubBus: (() => void) | null;
};

/** "Attended" = visible AND input on that device within this window (I10). */
export const ATTENTION_WINDOW_MS = 120_000;

// "Recently watched" grace for the finished-unread marker (CLAUDE.md §14.47).
// An agent's turn frequently finishes a second or two AFTER the user switches
// away (or the tab's SSE drops), so a finish within RECENT_VIEW_GRACE_MS of an
// ATTENDED conn leaving the session still counts as watched. Stamped only by
// attended conns switching away or unregistering — never by an idle or hidden
// one, which is not watching anything.
const RECENT_VIEW_GRACE_MS = 12_000;

type ConnRegistry = {
  connections: Map<string, ConnState>;
  lastAttendedAt: Map<string, number>;
  nextStreamId: number;
};
// One process-wide object (§14.106): the registry must be the same for every
// module copy that registers, focuses or asks "is it watched?".
const registry: ConnRegistry = ((globalThis as unknown as { __charonConns?: ConnRegistry })
  .__charonConns ??= { connections: new Map(), lastAttendedAt: new Map(), nextStreamId: 0 });
const connections = registry.connections;
const lastAttendedAt = registry.lastAttendedAt;

function isAttended(conn: ConnState, now: number): boolean {
  if (!conn.visible) return false;
  return conn.legacyAttention || now - conn.attentionAt <= ATTENTION_WINDOW_MS;
}

function stampAttended(sessionId: string | null, now: number): void {
  if (!sessionId) return;
  lastAttendedAt.set(sessionId, now);
  if (lastAttendedAt.size > 512) {
    for (const [id, at] of lastAttendedAt) {
      if (now - at >= RECENT_VIEW_GRACE_MS) lastAttendedAt.delete(id);
    }
  }
}

/** Apply a client's presence report. `attentive` undefined = not reported
 *  (legacy client): the attention state is left as it is. */
function applyPresence(conn: ConnState, visible: boolean, attentive: boolean | undefined, now: number): void {
  conn.visible = visible;
  if (attentive !== undefined) {
    conn.legacyAttention = false;
    conn.attentionAt = attentive ? now : 0;
  }
  // Hidden (or idle) on its focus: that device stopped watching it, so no
  // stale grace keeps muting the marker either (§14.47).
  if (!isAttended(conn, now) && conn.focus) lastAttendedAt.delete(conn.focus);
}

/**
 * "Is this session being watched right now — or was it, a few seconds ago?"
 * True iff an ATTENDED conn (visible + input within ATTENTION_WINDOW_MS; a
 * legacy client: visible) is focused on it, or an attended conn left it within
 * RECENT_VIEW_GRACE_MS. Used by the stop handler and the background-finish
 * timer to decide whether to light the finished-unread marker: a forgotten,
 * visible desktop tab no longer mutes it for every other device.
 */
export function isBeingWatched(sessionId: string): boolean {
  const now = Date.now();
  for (const conn of connections.values()) {
    if (conn.focus === sessionId && isAttended(conn, now)) return true;
  }
  const t = lastAttendedAt.get(sessionId);
  return t != null && now - t < RECENT_VIEW_GRACE_MS;
}

/** Historical name of isBeingWatched. */
export const wasRecentlyViewed = isBeingWatched;

/**
 * Register an SSE connection (one stream instance). Wires it to the global bus
 * (when `send` is given) and applies the focus filter. Returns the unregister
 * function of THIS stream: call it when the stream ends (abort, cancel, close);
 * it never touches a newer registration of the same connId.
 */
export function registerConnection(opts: {
  connId: string;
  send?: (ev: GlobalSessionEvent) => void;
  push?: (chunk: Uint8Array) => void;
  close?: (reason: string) => void;
  initialFocus?: string | null;
  initialFocusSeq?: number;
  initialVisible?: boolean;
  /** `attentive=1|0` on the URL; undefined ⇒ a legacy client (attended = visible). */
  initialAttentive?: boolean;
  proto?: 1 | 2;
}): () => void {
  const { connId } = opts;
  // Same connId again (the client reconnected before we saw the old stream
  // close): end the old stream — its heartbeat and its bus subscription with
  // it — THEN replace it. Its own unregister runs inside close() while it is
  // still the registered one; a later one finds the replacement and leaves it.
  const existing = connections.get(connId);
  if (existing) {
    try { existing.close('superseded'); } catch {}
    try { existing.unsubBus?.(); } catch {}
    existing.unsubBus = null;
  }

  const now = Date.now();
  const conn: ConnState = {
    connId,
    streamId: ++registry.nextStreamId,
    proto: opts.proto ?? 1,
    send: opts.send,
    push: opts.push,
    close: opts.close ?? (() => {}),
    focus: opts.initialFocus ?? null,
    focusSeq: Math.max(0, Math.floor(opts.initialFocusSeq ?? 0)),
    visible: opts.initialVisible ?? true,
    attentionAt: opts.initialAttentive ? now : 0,
    legacyAttention: opts.initialAttentive === undefined,
    unsubBus: null,
  };
  const send = opts.send;
  if (send) {
    conn.unsubBus = subscribeGlobalSessionEvents((ev) => {
      if (isLowVolume(ev.type) || ev.sessionId === conn.focus) {
        try { send(ev); } catch {}
      }
    });
  }
  connections.set(connId, conn);

  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (conn.unsubBus) { try { conn.unsubBus(); } catch {} conn.unsubBus = null; }
    // Tab closed / SSE dropped while watching → remember it was just being
    // watched, so a finish during the gap doesn't mark it unread (§14.47).
    const t = Date.now();
    if (isAttended(conn, t)) stampAttended(conn.focus, t);
    // Identity, not key (G8): a superseded stream's late close must never
    // delete its replacement.
    if (connections.get(connId) === conn) connections.delete(connId);
  };
}

/**
 * Change the focus (and presence) of a connection. The SSE keeps flowing;
 * starting with the next event, the filter uses the new focus.
 *
 * Latest-wins by `focusSeq` across concurrent HTTP requests:
 *   - `seq < cur` ⇒ not applied (a slow POST for A cannot clobber a newer B);
 *   - `seq === cur` and the same session ⇒ idempotent re-apply of
 *     visible/attentive (unless `routingOnly`), `applied:true`;
 *   - `seq === cur` and another session ⇒ not applied;
 *   - `seq > cur` ⇒ applied (`routingOnly`: focus/focusSeq only — the atomic
 *     focus of a window GET carries no presence report).
 * `ok:false` = no such connection (never created here).
 */
export function setConnectionFocus(
  connId: string,
  sessionId: string | null,
  focusSeq: number,
  visible = true,
  opts?: { attentive?: boolean; routingOnly?: boolean },
): { ok: boolean; applied: boolean; focus: string | null; focusSeq: number } {
  const conn = connections.get(connId);
  if (!conn) return { ok: false, applied: false, focus: null, focusSeq: 0 };
  const now = Date.now();
  if (focusSeq < conn.focusSeq || (focusSeq === conn.focusSeq && sessionId !== conn.focus)) {
    return { ok: true, applied: false, focus: conn.focus, focusSeq: conn.focusSeq };
  }
  if (focusSeq > conn.focusSeq) {
    // Leaving a session this conn was watching: the grace covers a turn that
    // finishes right after the switch (cf. CLAUDE.md §14.47).
    if (conn.focus !== sessionId && isAttended(conn, now)) stampAttended(conn.focus, now);
    conn.focus = sessionId;
    conn.focusSeq = focusSeq;
  }
  if (!opts?.routingOnly) applyPresence(conn, visible, opts?.attentive, now);
  return { ok: true, applied: true, focus: conn.focus, focusSeq: conn.focusSeq };
}

/**
 * A proof of attention from the device behind `connId` (POST /focus
 * `{kind:'attention'}`: input after an idle spell, then periodically). Revives
 * the conn's attended state for ATTENTION_WINDOW_MS. Never changes focus.
 */
export function noteConnectionAttention(connId: string): { ok: boolean; focus: string | null; visible: boolean } {
  const conn = connections.get(connId);
  if (!conn) return { ok: false, focus: null, visible: false };
  conn.legacyAttention = false;
  conn.attentionAt = Date.now();
  return { ok: true, focus: conn.focus, visible: conn.visible };
}

/**
 * Count the connections that have this session in focus. Used by the
 * "×N clients connected" badge shown in the sidebar/header.
 */
export function focusCountFor(sessionId: string): number {
  let n = 0;
  for (const c of connections.values()) if (c.focus === sessionId) n++;
  return n;
}

// Wire the "is this session being watched?" check into sessionOps so its
// `stop` handler and background-finish timer can decide whether to light the
// "finished, unread" marker (a finish the user is watching — or just navigated
// away from — shouldn't mark itself unread). The slot lives in `hubHooks()`
// (§14.106): this module exists only in the route copy, while boot-attached
// streams run the instrumentation copy's sessionOps. cf. §14.47.
setSessionFocusChecker((sessionId) => isBeingWatched(sessionId));
