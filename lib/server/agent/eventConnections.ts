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

type ConnState = {
  /** Legacy in-process sink (object form); `push` wins when both are set. */
  send?: (ev: GlobalSessionEvent) => void;
  /** Raw SSE bytes: the shared, already-encoded bus chunk (never mutated). */
  push?: (chunk: Uint8Array) => void;
  /** Bytes queued for this connection (sync stats only). */
  queuedBytes?: () => number;
  /** false until the route enqueued its snapshot/replay (router + heartbeat skip it). */
  live: boolean;
  focus: string | null;
  focusSeq: number;
  visible: boolean;
};

const gReg = globalThis as unknown as { _eventConnections?: Map<string, ConnState> };
if (!gReg._eventConnections) gReg._eventConnections = new Map();
const connections: Map<string, ConnState> = gReg._eventConnections;

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

// "Recently viewed" grace for the finished-unread marker (CLAUDE.md §14.47).
// `focusCountFor` is instantaneous: the moment a user navigates away from a
// session its focus count drops to 0. But an agent's turn frequently finishes a
// second or two AFTER the user switches (or steps back to the session list), so
// the `stop` would land with nobody "focused" and wrongly flip the session the
// user was just reading to green "unread". We therefore remember the last time
// each session had/lost focus and treat a finish within RECENT_VIEW_GRACE_MS as
// "still being viewed". Covers the switch-away race + brief SSE-reconnect gaps.
const RECENT_VIEW_GRACE_MS = 12_000;
const gView = globalThis as unknown as { _lastViewAt?: Map<string, number> };
if (!gView._lastViewAt) gView._lastViewAt = new Map();
const lastViewAt: Map<string, number> = gView._lastViewAt;

function touchView(sessionId: string | null | undefined): void {
  if (sessionId) lastViewAt.set(sessionId, Date.now());
}

/**
 * "Is this session being viewed, or was it within the last few seconds?" Used
 * by the stop handler to decide whether to light the finished-unread marker.
 */
export function wasRecentlyViewed(sessionId: string): boolean {
  for (const conn of connections.values()) {
    if (conn.visible && conn.focus === sessionId) return true;
  }
  const t = lastViewAt.get(sessionId);
  return t != null && Date.now() - t < RECENT_VIEW_GRACE_MS;
}

/**
 * Register an SSE connection (`live:false` until `markConnectionLive`). The
 * router delivers matching bus frames to `push` (raw chunk) or, without it,
 * to `send` (event object). Returns an unregister function to call when the
 * SSE closes (req abort).
 */
export function registerConnection(opts: {
  connId: string;
  send?: (ev: GlobalSessionEvent) => void;
  push?: (chunk: Uint8Array) => void;
  queuedBytes?: () => number;
  initialFocus?: string | null;
  initialFocusSeq?: number;
  initialVisible?: boolean;
}): () => void {
  // If a connId already exists (e.g. client reconnected before we detected
  // the close), the new registration replaces it.
  const conn: ConnState = {
    send: opts.send,
    push: opts.push,
    queuedBytes: opts.queuedBytes,
    live: false,
    focus: opts.initialFocus ?? null,
    focusSeq: Math.max(0, Math.floor(opts.initialFocusSeq ?? 0)),
    visible: opts.initialVisible ?? true,
  };
  connections.set(opts.connId, conn);
  ensureHeartbeat();

  return () => {
    const c = connections.get(opts.connId);
    if (!c) return;
    // Tab closed / SSE dropped while focused → remember we were just viewing it,
    // so a finish during the gap doesn't immediately mark it unread (§14.47).
    if (c.visible) touchView(c.focus);
    connections.delete(opts.connId);
    stopHeartbeatIfIdle();
  };
}

/**
 * Change the focus of a connection. Returns true if found, false otherwise.
 * The SSE keeps flowing; starting with the next event, the filter uses
 * the new focus.
 */
export function setConnectionFocus(
  connId: string,
  sessionId: string | null,
  focusSeq: number,
  visible = true,
): { ok: boolean; applied: boolean; focus: string | null; focusSeq: number } {
  const conn = connections.get(connId);
  if (!conn) return { ok: false, applied: false, focus: null, focusSeq: 0 };
  // Latest-wins ordering across concurrent HTTP requests. A slow POST for A
  // arriving after the user's newer switch to B can no longer clobber B.
  if (focusSeq <= conn.focusSeq) {
    return { ok: true, applied: false, focus: conn.focus, focusSeq: conn.focusSeq };
  }
  // Stamp BOTH the session being left and the one being entered as "viewed just
  // now", so the recently-viewed grace covers a turn that finishes immediately
  // after a switch (the user was reading it a moment ago). cf. CLAUDE.md §14.47.
  if (conn.visible && conn.focus !== sessionId) touchView(conn.focus);
  conn.focus = sessionId;
  conn.focusSeq = focusSeq;
  conn.visible = visible;
  if (visible) touchView(sessionId);
  else if (sessionId) lastViewAt.delete(sessionId);
  return { ok: true, applied: true, focus: conn.focus, focusSeq: conn.focusSeq };
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

// Wire the "is this session currently being viewed (or was, a few seconds
// ago)?" check into sessionOps so its `stop` handler can decide whether to
// light the "finished, unread" marker (a finish the user is already watching —
// or just navigated away from — shouldn't mark itself unread). Reverse of the
// setVpsStatusEmitter injection — keeps the dependency one-directional at
// module-eval time while letting sessionOps query focus at runtime. The grace
// window (wasRecentlyViewed) is what fixes the switch-away race. cf. §14.47.
setSessionFocusChecker((sessionId) => wasRecentlyViewed(sessionId));
