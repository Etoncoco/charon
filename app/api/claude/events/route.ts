import { getModelNotices } from '@/lib/server/claude/modelNotices';
import { and, eq } from 'drizzle-orm';
import {
  db, claudeSessions, claudePendingPermissions, claudePendingQuestions,
} from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { seedInitialData } from '@/lib/server/seed';
import { markConnectionLive, registerConnection } from '@/lib/server/agent/eventConnections';
import { peekStream } from '@/lib/server/agent/sessionOps';
import type { GlobalSessionEvent } from '@/lib/server/agent/sessionOps';
import { expireStalePendingInteractions } from '@/lib/server/agent/pendingInteractions';
import { listVpsRuntimeSnapshots } from '@/lib/server/agent/vpsRuntimeSnapshot';
import { listInstalls } from '@/lib/server/install/installSession';
import { timeSection } from '@/lib/server/perf/loopLag';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/claude/events?conn=<uuid>&focus=<sid>
//
// Multiplexed SSE: replaces the old endpoints
// `/api/claude/sessions/[id]/stream` and `/api/claude/interactions/stream`.
// The browser client opens ONE persistent SSE at mount; session changes
// are handled via POST /api/claude/focus without close/reopen.
//
// Initial snapshot: statuses of all live sessions + pendings in DB.
// Then: live bus frames (`id: <epoch>.<rev>`, encoded once at publish) routed
// by focus, and the registry heartbeat (cf. eventConnections.ts).
export async function GET(req: Request) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;

  // Cold-start safety net (CLAUDE.md §14.45). A browser tab that survives a
  // `systemctl restart charon` reconnects its singleton SSE HERE without any
  // SSR render, so without this call the AgentClientPool + SessionStream maps
  // would stay empty (no SSH proxy, no attached stream) and no live agent
  // event would ever arrive on the reconnected SSE — "frozen until F5". This
  // is the ONE endpoint every live tab is guaranteed to hit after a restart.
  // seedInitialData is idempotent (guarded), so this is ~free after boot.
  try { seedInitialData(); } catch {}

  const url = new URL(req.url);
  const connId = url.searchParams.get('conn');
  if (!connId || connId.length < 8 || connId.length > 64) {
    return new Response('missing or invalid conn id', { status: 400 });
  }
  const initialFocus = url.searchParams.get('focus');
  const initialVisible = url.searchParams.get('visible') !== '0';
  const initialFocusSeqRaw = Number(url.searchParams.get('focusSeq') ?? 0);
  const initialFocusSeq = Number.isSafeInteger(initialFocusSeqRaw) && initialFocusSeqRaw >= 0
    ? initialFocusSeqRaw : 0;

  const encoder = new TextEncoder();
  let unregister: (() => void) | null = null;

  const sseStream = new ReadableStream<Uint8Array>({
    start(controller) {
      timeSection('SSE start', () => {
      let closed = false;
      const push = (chunk: Uint8Array) => {
        if (closed) return;
        // Backpressure (P0.5): `desiredSize` goes negative when the client
        // stops reading (frozen tab, dead network pre-timeout) — the stream's
        // internal queue is unbounded and every enqueue would pile up in hub
        // memory. Past a generous threshold, DROP: SSE is the fast path only,
        // the 5s poll (§14.24) is the no-freeze contract and resyncs the
        // client from SQLite the moment it comes back. Lives in sendRaw so
        // EVERY producer shares the policy (session events, install events,
        // heartbeats — a dropped heartbeat even helps: the client watchdog
        // reconnects a conn this stuck).
        try {
          const ds = (controller as { desiredSize?: number | null }).desiredSize;
          if (typeof ds === 'number' && ds < 0) {
            // A silent drop can lose a permission or stop forever. Closing is
            // explicit: EventSource reconnects and receives a fresh snapshot.
            close();
            return;
          }
        } catch {}
        try {
          controller.enqueue(chunk);
        } catch {
          closed = true;
        }
      };
      // Snapshot frames are per-connection: no `id:` (bus frames carry theirs).
      const sendNow = (ev: GlobalSessionEvent | Record<string, unknown>) => {
        push(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        if (unregister) { unregister(); unregister = null; }
        try { controller.close(); } catch {}
      };

      // Register BEFORE reading the snapshot, NOT live: the bus router skips
      // this connection until `markConnectionLive` below, in this same
      // synchronous tick — a frame published meanwhile is already reflected
      // by the snapshot. Duplicate status/pending events are harmless because
      // client queues are id-keyed. Installs and model notices are bus
      // frames too (LOW), so they need no subscription of their own.
      unregister = registerConnection({
        connId, push, initialFocus, initialFocusSeq, initialVisible,
      });
      sendNow({ type: 'model_notices', notices: getModelNotices() });

      // Initial snapshot: status of all sessions + pendings. This lets the
      // client populate its sidebar immediately without depending on
      // GET /api/claude/sessions (which will also be called in parallel but
      // these status events cover it partially).
      //
      // Historical note: we used to filter `status='killed'` sessions here.
      // Since the kill->delete refactor (cf. CLAUDE.md §10), this status is
      // no longer persisted. The filter is kept as an idempotent safeguard
      // in case pre-migration data resurfaces, but should never match.
      try {
        // VPS runtime state is live-only after this point, so replay a full,
        // browser-safe snapshot on EVERY EventSource connection (including
        // reconnects). We registered first and buffer concurrent live events;
        // therefore a newer update always drains after this snapshot.
        for (const v of listVpsRuntimeSnapshots()) {
          sendNow({
            type: 'vps_status',
            sessionId: v.id,
            agentStatus: v.agentStatus as 'unknown' | 'ok' | 'missing' | 'error',
            agentVersion: v.agentVersion,
            agentPyzSha: v.agentPyzSha,
            agentLastError: v.agentLastError,
            sdkVersion: v.sdkVersion,
            codexAvailable: v.codexAvailable,
            codexSdkVersion: v.codexSdkVersion,
            codexCliVersion: v.codexCliVersion,
            claudeLoggedIn: v.claudeLoggedIn,
            codexLoggedIn: v.codexLoggedIn,
          });
        }

        const rows = db.select({ id: claudeSessions.id, status: claudeSessions.status })
          .from(claudeSessions).all();
        for (const row of rows) {
          if (row.status === 'killed') continue;
          // Prefer the live (in-memory) status over the DB one if available.
          const live = peekStream(row.id);
          const effective = live ? live.status : row.status;
          sendNow({ type: 'status', sessionId: row.id, status: effective as any });
        }
        // Pendings: provider deadlines continue while the browser/hub is
        // disconnected. Repair expired rows before rebuilding the queues.
        expireStalePendingInteractions();
        // Replay live ones once to repopulate the client queues
        // (the cross-session popup + the focused session need them).
        const perms = db.select().from(claudePendingPermissions).where(
          eq(claudePendingPermissions.status, 'pending'),
        ).all();
        for (const p of perms) {
          let input: any = {};
          try { input = JSON.parse(p.toolInput); } catch {}
          sendNow({
            type: 'permission_request', sessionId: p.sessionId, id: p.id,
            tool: p.toolName, input, expiresAt: p.expiresAt ?? undefined,
          });
        }
        const qs = db.select().from(claudePendingQuestions).where(
          eq(claudePendingQuestions.status, 'pending'),
        ).all();
        for (const q of qs) {
          let payload: any = {};
          try { payload = JSON.parse(q.payload); } catch {}
          if (q.kind === 'question' || q.kind === 'async_question') {
            sendNow({
              type: 'user_question', sessionId: q.sessionId, id: q.id,
              questions: payload, expiresAt: q.expiresAt ?? undefined,
              delivery: q.kind === 'async_question' ? 'async' : undefined,
              createdAt: q.createdAt,
              snapshot: true,
            });
          } else if (q.kind === 'exit_plan') {
            sendNow({
              type: 'exit_plan_request', sessionId: q.sessionId, id: q.id,
              plan: payload?.plan ?? '', expiresAt: q.expiresAt ?? undefined,
            });
          }
        }
      } catch {}

      // Initial snapshot of installs: sends an install_started for each
      // install still active. Lets the client (Sidebar / popup) update
      // at mount without depending on a separate GET.
      try {
        for (const inst of listInstalls()) {
          if (inst.status === 'running') {
            sendNow({
              type: 'install_started',
              installId: inst.id, vpsId: inst.vpsId, vpsName: inst.vpsName,
              status: 'running',
            });
          }
        }
      } catch {}

      // Snapshot enqueued: route bus frames here from now on. The registry
      // sends the first heartbeat now and every 8 s after (a TYPED data
      // frame — EventSource never surfaces `: comment` lines; the client's
      // 20 s watchdog reconnects a silent stream).
      markConnectionLive(connId);

      // @ts-ignore — AbortSignal listener
      req.signal?.addEventListener('abort', close);
      });
    },
    cancel() {
      if (unregister) { unregister(); unregister = null; }
    },
  }, new ByteLengthQueuingStrategy({ highWaterMark: 512 * 1024 }));

  return new Response(sseStream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
