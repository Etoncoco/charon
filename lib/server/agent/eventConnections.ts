import 'server-only';
import { setSessionFocusChecker, type GlobalSessionEvent } from './sessionOps';
import {
  currentRev, installFrameRouter, setConnStatsProvider, type Frame,
} from '@/lib/server/sync/syncBus';
import { frameReaches } from '@/lib/server/sync/frameRouting';

// eventConnections
// ─────────────────────────────────────────────────────────────────────────────
// Registry of multiplexed SSE connections (/api/claude/events). Each browser
// client opens ONE persistent SSE on mount, identified by a connId (UUID
// generated on the client side). The focus (sessionId currently being
// watched) is mutable via POST /api/claude/focus — no close/reopen on switch.
//
// Fan-out = ONE router on the sync bus (lib/server/sync/syncBus.ts), installed
// once per process: every frame is encoded once at publish and the SAME
// Uint8Array is pushed to each LIVE connection it reaches —
// `frameRouting.ts § FRAME_CLASS` decides (low → every connection, focused →
// the connection focused on its session; CLAUDE.md §14.16).
//
// A connection registers with `live:false` and its route flips it with
// `markConnectionLive` in the SAME synchronous tick, right after its
// snapshot/replay lines are enqueued: a frame published meanwhile is ≤ that
// snapshot's revision, hence already inside it. The registry's heartbeat
// (one 8 s timer for every connection) carries `id: <epoch>.<currentRev>`:
// every frame ≤ that rev this connection should see was pushed synchronously
// before it. A connection that is not registered (or not yet live) gets no
// heartbeat, so the client's watchdog reconnects it (§14.15).
//
// When a client switches focus:
//   1. Client POST /focus { conn, sessionId } → updates the focus
//   2. Client GET /api/claude/sessions/[id] → reloads the persisted history
//   3. SSE continues flowing — from now on the high-volume events of the
//      new session arrive

const HEARTBEAT_MS = 8_000;

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
  /** Legacy in-process sink (object form); `push` wins when both are set. */
  send?: (ev: GlobalSessionEvent) => void;
  /** Raw SSE bytes: the shared, already-encoded bus chunk (never mutated). */
  push?: (chunk: Uint8Array) => void;
  /** Bytes queued for this connection (sync stats only). */
  queuedBytes?: () => number;
  /** false until the route enqueued its snapshot/replay (router + heartbeat skip it). */
  live: boolean;
  close: (reason: string) => void;
  focus: string | null;
  focusSeq: number;
  visible: boolean;
  /** Last proof of a human at this device (ms); 0 = none. */
  attentionAt: number;
  /** `attentionAt` comes from the URL's `attentive=1`, not from a POST. The
   *  browser's native EventSource reconnect REUSES the URL it was built with,
   *  so that flag can be hours stale: the first `attentive:false` report on
   *  this conn clears it (a POST's proof is never cleared, FM9). */
  attentionFromUrl: boolean;
  /** A client that never reports attention (pre-attention JS): attended = visible. */
  legacyAttention: boolean;
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
 *  (legacy client): the attention state is left as it is. `true` is a proof
 *  of attention (`attentionAt = now`); `false` switches the conn to
 *  attention reporting and never erases a POST's proof: POSTs can land out
 *  of order (FM9), and a stale `false` must not erase a newer attention POST.
 *  It DOES clear attention granted only by the URL's `attentive=1` (a native
 *  EventSource reconnect replays the URL it was built with, however old).
 *  Idleness comes from the monotonic ATTENTION_WINDOW_MS expiry alone (the
 *  focus route still skips the read-ack of an `attentive:false` POST). */
function applyPresence(conn: ConnState, visible: boolean, attentive: boolean | undefined, now: number): void {
  conn.visible = visible;
  if (attentive !== undefined) {
    conn.legacyAttention = false;
    if (attentive) {
      conn.attentionAt = now;
      conn.attentionFromUrl = false;
    } else if (conn.attentionFromUrl) {
      // The URL flag is no proof (a native reconnect replays a stale URL);
      // the client's own report says idle.
      conn.attentionAt = 0;
      conn.attentionFromUrl = false;
    }
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

const encoder = new TextEncoder();

function deliver(conn: ConnState, f: Frame, ev: Record<string, unknown>): void {
  try {
    if (conn.push) conn.push(f.chunk);
    else conn.send?.(ev as GlobalSessionEvent);
  } catch { /* a dying stream cannot veto the others */ }
}

// The router: one pass over the registry per published frame.
installFrameRouter((f, ev) => {
  if (f.route === 'internal') return;
  for (const conn of connections.values()) {
    if (conn.live && frameReaches(f, conn.focus)) deliver(conn, f, ev);
  }
});

setConnStatsProvider(() => {
  let outboxBytes = 0;
  for (const c of connections.values()) {
    try { outboxBytes += c.queuedBytes?.() ?? 0; } catch { /* stats only */ }
  }
  return { conns: connections.size, outboxBytes };
});

// ── Registry heartbeat ──────────────────────────────────────────────────────
// A TYPED data frame (EventSource never surfaces `: comment` lines to JS), so
// the client's watchdog sees liveness. One process-wide timer, started with
// the first connection and stopped with the last.
const gHb = globalThis as unknown as {
  _eventConnectionsHeartbeat?: { timer: ReturnType<typeof setInterval> | null };
};
const hb = gHb._eventConnectionsHeartbeat ??= { timer: null };

function heartbeatChunk(): Uint8Array {
  const { epoch, rev } = currentRev();
  return encoder.encode(`id: ${epoch}.${rev}\ndata: ${JSON.stringify({ type: 'heartbeat', ts: Date.now() })}\n\n`);
}

/** One heartbeat (encoded once) to every LIVE raw connection. */
export function pushHeartbeats(): number {
  let chunk: Uint8Array | null = null;
  let n = 0;
  for (const conn of connections.values()) {
    if (!conn.live || !conn.push) continue;
    chunk ??= heartbeatChunk();
    try { conn.push(chunk); n++; } catch { /* closing */ }
  }
  return n;
}

function ensureHeartbeat(): void {
  if (hb.timer) return;
  hb.timer = setInterval(pushHeartbeats, HEARTBEAT_MS);
  hb.timer.unref?.();
}

function stopHeartbeatIfIdle(): void {
  if (connections.size > 0 || !hb.timer) return;
  clearInterval(hb.timer);
  hb.timer = null;
}

/**
 * Push one heartbeat to this connection now (the probe: everything the SSE
 * owes it up to the response's revision is then queued before that frame).
 * false when the connection is unknown, not live, or has no raw sink.
 */
export function pushHeartbeatTo(connId: string): boolean {
  const conn = connections.get(connId);
  if (!conn || !conn.live || !conn.push) return false;
  try { conn.push(heartbeatChunk()); return true; } catch { return false; }
}

/**
 * The route enqueued this connection's snapshot/replay: route bus frames to it
 * from now on and send its first heartbeat (NEVER before its snapshot end, or
 * a connection dying mid-snapshot would adopt that revision). Same synchronous
 * tick as the registration and the snapshot read.
 */
export function markConnectionLive(connId: string): boolean {
  const conn = connections.get(connId);
  if (!conn) return false;
  conn.live = true;
  pushHeartbeatTo(connId);
  return true;
}

/**
 * Register an SSE connection (one stream instance), `live:false` until
 * `markConnectionLive`. The bus router then delivers matching frames to `push`
 * (raw shared chunk) or, without it, to `send` (event object). Returns the
 * unregister function of THIS stream: call it when the stream ends (abort,
 * cancel, close); it never touches a newer registration of the same connId.
 */
export function registerConnection(opts: {
  connId: string;
  send?: (ev: GlobalSessionEvent) => void;
  push?: (chunk: Uint8Array) => void;
  queuedBytes?: () => number;
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
  // close): end the old stream THEN replace it. Its own unregister runs inside
  // close() while it is still the registered one; a later one finds the
  // replacement and leaves it. Once replaced in the Map, the bus router no
  // longer reaches it (even if its close() was a no-op).
  const existing = connections.get(connId);
  if (existing) {
    try { existing.close('superseded'); } catch {}
  }

  const now = Date.now();
  const conn: ConnState = {
    connId,
    streamId: ++registry.nextStreamId,
    proto: opts.proto ?? 1,
    send: opts.send,
    push: opts.push,
    queuedBytes: opts.queuedBytes,
    live: false,
    close: opts.close ?? (() => {}),
    focus: opts.initialFocus ?? null,
    focusSeq: Math.max(0, Math.floor(opts.initialFocusSeq ?? 0)),
    visible: opts.initialVisible ?? true,
    attentionAt: opts.initialAttentive ? now : 0,
    attentionFromUrl: opts.initialAttentive === true,
    legacyAttention: opts.initialAttentive === undefined,
  };
  connections.set(connId, conn);
  ensureHeartbeat();

  let done = false;
  return () => {
    if (done) return;
    done = true;
    // Tab closed / SSE dropped while watching → remember it was just being
    // watched, so a finish during the gap doesn't mark it unread (§14.47).
    const t = Date.now();
    if (isAttended(conn, t)) stampAttended(conn.focus, t);
    // Identity, not key (G8): a superseded stream's late close must never
    // delete its replacement.
    if (connections.get(connId) === conn) connections.delete(connId);
    stopHeartbeatIfIdle();
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
  conn.attentionFromUrl = false;
  return { ok: true, focus: conn.focus, visible: conn.visible };
}

/** The registered connection's current focus; `undefined` = no such
 *  connection (the session probe's `focused`). Read-only. */
export function connectionFocusOf(connId: string): string | null | undefined {
  return connections.get(connId)?.focus;
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
