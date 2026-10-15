'use client';
import { resolveAsyncQuestionMessages } from '@/lib/asyncQuestions';
import { mergeSessionTokenUsage, type SessionTokenUsage } from '@/lib/sessionTokenUsage';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sessionApi } from '@/lib/api';
import type {
  Msg, ToolCallEntry, EditSnapshot,
  PermissionRequest, PendingQuestion, PendingExitPlan,
} from './sessionTypes';
import { rebuildStateFromMessages } from './sessionRebuild';
import { reconcileStreamingPreview } from './streamingPreview';
import { ResponseSpeedTracker, type ResponseSpeedSnapshot } from './responseSpeed';
import {
  appendThinkingMessage, closeThinkingMessage, createThinkingLane, openThinkingCreatedAt,
  openThinkingNeedsReload, prependMessagePage, thinkingLaneBeforeFrame, thinkingLaneCommit, thinkingLaneDelta,
  thinkingLaneFlushed, thinkingLaneReopened, thinkingLaneSnapshot, thinkingRowIds,
} from './thinkingMessages';
import {
  applyBgTaskEvent, applyBgTaskProgress, bgTasksAfterWindowAnswer, bgTasksToArray, isBgLaunchToolUse,
  markRunningBgTasksStale, reconcileAuthoritativeBgTasks, bgTasksAfterPollAnswer,
  type BgTask, type BgLaunchCandidate,
} from './bgTasks';
import { publishFsChanged } from './fsChangeBus';
import type {
  WorkerEvent, WorkerStatus,
} from '@/lib/server/claude/types';
import type {
  AgentSessionDetailResponse, AgentSessionMessageWindow,
} from '@/lib/types/api';
import {
  asSessionProvider, defaultSessionMode, isSessionMode, PROVIDERS,
  type SessionMode, type SessionProvider,
} from '@/lib/sessionCapabilities';
import { subscribeSession, setFocus, subscribeReconnect, type EventReception } from './globalEventStream';
import {
  addOptimisticSend, applyFlushFrame, applyUserEchoMatch, flushFrameBuffer, matchUserEcho,
  newClientMessageId, patchAssistantRows, reduceRowIdRename, reduceSendAck, reduceStop,
  type Effect, type LiveBuffers, type OptimisticSends,
} from './sync/transcriptReducer';
import { gateChangesSince, journalGate, mergePendingSnapshot, type GateJournalEntry } from './pendingQueueMerge';

// A live row the hub named (`rowId` ⇒ `m<rowId>`, the rebuild's id): replayed
// frames replace it in place instead of appending a twin.
function upsertMessage(prev: Msg[], row: Msg): Msg[] {
  const idx = prev.findIndex((m) => m.id === row.id);
  if (idx < 0) return [...prev, row];
  const next = prev.slice();
  next[idx] = row;
  return next;
}

// A session's "mode" is a Claude permission mode OR a Codex sandbox level —
// both are stored in the same permission_mode field (cf. schema.ts). Widened
// so codex sessions don't get their sandbox mode reset to 'normal'.
// Compare two interaction-queue snapshots by id sequence. Returns true if
// `a` and `b` reference the same set of items in the same order. Used to
// skip re-renders when the polling delta returns the same pendings list.
function sameQueueById<T extends { id: string }>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id) return false;
    // An async question's in-flight answer (the strip's "sending…").
    if ((a[i] as { delivering?: boolean }).delivering !== (b[i] as { delivering?: boolean }).delivering) return false;
  }
  return true;
}

function sameShallowRecord(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = Object.keys(x);
  if (keys.length !== Object.keys(y).length) return false;
  for (const k of keys) if (x[k] !== y[k]) return false;
  return true;
}

// Merge a freshly-rebuilt edits Map (from a full reload) into the current one
// WITHOUT losing already-loaded diff content.
//
// Since the bandwidth fix (CLAUDE.md §14 gotcha 41) the session GET strips
// edit_snapshot content, so `rebuildStateFromMessages` produces edits whose
// before/after are null — a skeleton listing WHICH files changed, with no
// content. The actual content is fetched separately (loadEdits → /edits) or
// arrives live (edit_snapshot SSE, which DOES carry content). A full reload
// (poll clean-reload, reconnect, tab return) must therefore NOT clobber the
// content we already have with the reload's null skeleton.
//
// Rules:
//   - For each file in the rebuilt skeleton: if we already hold loaded content
//     (before or after non-null), keep it (refresh only the `truncated` flag);
//     otherwise take the skeleton entry (loadEdits will fill it).
//   - Preserve files we loaded earlier that fell outside the current window
//     (the window only carries snapshots near the last 200 chat messages).
//
// Trade-off: a file edited AGAIN while the SSE is down shows its PREVIOUS diff
// until the next mount (the reload skeleton can't tell us the content changed,
// and we keep the old content rather than blank it). Acceptable — the live SSE
// path keeps it current in the common case, and it self-heals on remount.
function mergeEdits(
  prev: Map<string, EditSnapshot>,
  rebuilt: Map<string, EditSnapshot>,
): Map<string, EditSnapshot> {
  const next = new Map<string, EditSnapshot>();
  for (const [k, v] of rebuilt) {
    const old = prev.get(k);
    if (old && (old.before != null || old.after != null)) {
      next.set(k, { ...old, truncated: old.truncated || v.truncated });
    } else {
      next.set(k, v);
    }
  }
  for (const [k, v] of prev) {
    if (!next.has(k)) next.set(k, v);
  }
  return next;
}

// Session-expired (401) handling (CLAUDE.md §14.45, P8). After a long outage
// the 24h sliding session cookie may have lapsed; every API call then 401s
// silently (the SSE can't even surface it). We hard-reload ONCE → middleware
// redirects cleanly to /login?next=… . Module-level guard so concurrent 401s
// (multiple session hooks + the SSE auth probe) don't trigger a reload storm.
let _authReloadDone = false;
function reloadForExpiredSession(): void {
  if (_authReloadDone) return;
  if (typeof window === 'undefined') return;
  _authReloadDone = true;
  try { window.location.reload(); } catch {}
}

// useClaudeSessionStream
// ─────────────────────────────────────────────────────────────────────────────
// Hook that encapsulates all the SSE + state + actions logic for a Claude
// session viewed from the browser. Used by the unified responsive `/`
// (ClaudePanel → ClaudeSessionView), which creates one instance per
// sessionId via `key={selectedId}`.
//
// What this hook does:
//   - Subscribes to events for this session via `globalEventStream` (single
//     multiplexed SSE — no close/reopen on session switch)
//   - POST /api/claude/focus at mount/session change so that the
//     server streams high-volume events (assistant_text, tool_*) for
//     THIS session
//   - Maintains messages/currentAssistant/status/permissionMode/toolCalls/
//     edits/files/permQueue/questionQueue/exitPlanQueue
//   - GET /api/claude/sessions/[id] at mount and when the tab returns to
//     foreground — the DB is the source of truth for history
//   - Batches `assistant_text` deltas via requestAnimationFrame (60Hz max)
//     to avoid re-rendering the subtree on every token
//   - Exposes actions (send/interrupt/forceStop/setMode/doSleep/doResume/
//     doDelete/respondPermission/respondQuestion/respondExitPlan) with
//     pessimistic confirmation (queue empties after server ack, not before)
//
// What this hook does NOT do:
//   - Layout / rendering (consumed by components which style)
//   - Post-kill navigation (the caller does `router.push('...')` in onKilled)
//   - Multi-session state (the caller composes several instances if needed)
//   - Scroll mechanics (chatBodyRef/isAtBottom remain on the caller side)

export type StreamCache = {
  get(id: string): AgentSessionDetailResponse | undefined;
  /** `signal`: the caller no longer needs the answer (view unmounted). */
  fetch(id: string, force?: boolean, signal?: AbortSignal): Promise<AgentSessionDetailResponse>;
  invalidate?(id: string): void;
  /**
   * Extends the cache entry with a window of older messages (loadMore).
   * Allows loaded pages to be preserved across session switch/remount.
   * No-op if the implementation does not support it.
   */
  extendWithOlder?(id: string, older: AgentSessionMessageWindow): void;
};

export type UseClaudeSessionStreamOptions = {
  /**
   * Module-level cache (instant load on mount). Callers pass the shared
   * `sessionCache` (app/sessionCache.ts).
   * If absent: direct refetch on each mount.
   */
  cache?: StreamCache;

  /**
   * Callback called when the user kills the session. The hook doesn't
   * navigate by itself; the caller decides (ClaudePanel → deselect +
   * refresh).
   */
  onKilled?: () => void;
};

export type ClaudeSessionStreamState = {
  // Session metadata
  sessionMeta: AgentSessionDetailResponse['session'] | null;
  // Conversation state
  messages: Msg[];
  currentAssistant: string;
  // Row `m<id>` the live text extends (`assistant_reopened`, or the GET's
  // `streamingExtends`): `currentAssistant` is then only what follows that
  // row's content, drawn into it (transcriptReducer § liveStreamingMessage).
  streamingInto: number | null;
  status: WorkerStatus | null;
  // Claude permission mode OR Codex sandbox level (same DB field, kind-dependent).
  permissionMode: SessionMode;
  // Per-session Claude model / fallback / effort. null = inherit the global
  // default (claudeSettings.claude.default_*). Updated by `model_changed` /
  // `effort_changed` SSE events; mirrored in DB. `pendingApply` flips to
  // true on a setModel/setEffort call against a live SDK client — the change
  // is queued and applies on next sleep+resume. UI should label it as deferred.
  model: string | null;
  fallbackModel: string | null;
  // Claude effort (low..ultracode) OR Codex effort (none..ultra) — free string
  // so both catalogs pass through unmolested. null = inherit the global default.
  effort: string | null;
  modelPendingApply: boolean;
  effortPendingApply: boolean;
  // Model id Anthropic actually used on the last assistant turn. Updated by
  // `effective_model` SSE + by applyApiData on mount/refetch. Null when the
  // agent is < 0.6.0 (no event) or no turn has happened since attach.
  // Independent of the `model` field above which is the user's CONFIGURED
  // value. The two can legitimately differ (alias resolution, fallback).
  effectiveModel: string | null;
  tokenUsage: SessionTokenUsage | null;
  // Current-turn usage (§14.50). Live output drives ThinkingBar; the final
  // frame carries totals and cost for the post-turn status line.
  liveUsage: { output: number; input?: number; final?: boolean; durationMs?: number; costUsd?: number | null } | null;
  responseSpeed: ResponseSpeedSnapshot | null;
  toolCalls: ToolCallEntry[];
  edits: Map<string, EditSnapshot>;
  files: Set<string>;
  // Background tasks (Bash run_in_background / bg subagents) — fed by the
  // bg_task SSE events + rebuilt from history on every refetch. Drives the
  // BgTasksBar above the chat input. cf. app/bgTasks.ts.
  bgTasks: BgTask[];
  // Pending interaction queues
  permQueue: PermissionRequest[];
  questionQueue: PendingQuestion[];
  exitPlanQueue: PendingExitPlan[];
  // Text the agent wants to prefill in the textarea (prefill_input event)
  prefillInput: string | null;
  // Last error displayable to the user
  error: { msg: string } | null;
  // true as long as we've NEVER applied data for this session
  // (neither from the cache, nor from the fetch). Lets the UI differentiate
  // "empty session" from "history loading".
  isLoadingHistory: boolean;
  // true while what is on screen has not been confirmed current by the
  // server: from mount (the cache paints instantly, possibly minutes old)
  // until the first fresh answer, and again during a wake-up catch-up (tab
  // back to the foreground, network back, SSE reconnected). Stays true while
  // that confirmation keeps failing — the view IS out of date then.
  isSyncing: boolean;
  // Latches true once the first full history request has settled. Side
  // requests that are not the conversation (diff contents, the Tools
  // inspector) wait for it so they do not split a slow link with the
  // transcript the user is waiting for.
  historyReady: boolean;
  // Scroll-up pagination: true if there are chat messages older than
  // `oldestChatId` on the server side. False when we've reached the start.
  hasMore: boolean;
  // true while a loadMoreHistory is in flight. The caller can display
  // a spinner at the top of the chat (visual: column-reverse → "at the top").
  isLoadingMore: boolean;
};

export type ClaudeSessionStreamActions = {
  send(content: string): Promise<void>;
  interrupt(): Promise<void>;
  forceStop(): Promise<void>;
  setMode(mode: SessionMode): Promise<void>;
  /**
   * Change the model (and optionally the fallback) for this session.
   * Takes effect at NEXT SDK start — the SDK binds the model at construction
   * time and cannot swap mid-flight. The UI should announce this (badge
   * with "applies on resume"). Pass null to clear back to the global default.
   */
  setModel(model: string | null, fallbackModel?: string | null): Promise<void>;
  /** Change the effort level (Claude or Codex). Same deferred-apply semantics
   *  as setModel for Claude; Codex applies on the next turn. */
  setEffort(effort: string | null): Promise<void>;
  doSleep(): Promise<void>;
  doResume(): Promise<void>;
  // In-place SDK restart (awaited sleep+resume) — applies deferred
  // model/effort immediately (§14.35).
  doRestart(): Promise<void>;
  /** Permanent deletion. The caller MUST have confirmed on the UI side. */
  doDelete(): Promise<void>;
  respondPermission(permId: string, allow: boolean, always?: boolean): Promise<void>;
  respondQuestion(qid: string, answers: Record<string, string> | null): Promise<void>;
  respondExitPlan(qid: string, decision: 'approve' | 'reject', feedback?: string): Promise<void>;
  /** Resets prefillInput after the caller has consumed it. */
  clearPrefillInput(): void;
  /** Forces a refetch from the DB (cache bypass). */
  refetchHistory(): Promise<void>;
  /**
   * Loads a window of older chat messages and prepends them to history.
   * No-op if `hasMore=false`, if `oldestChatId=null`, or if a loadMore
   * is already in progress. The caller triggers it when the user scrolls
   * toward the top of the chat (near the visual limit).
   */
  loadMoreHistory(): Promise<void>;
  /**
   * Declares whether the user is currently reading back through history
   * (i.e. scrolled away from the bottom). While held, the safety-net poll
   * defers its clean full reload — which would otherwise discard every
   * paginated page and yank the scroll position. Releasing flushes any held
   * reload immediately. cf. CLAUDE.md §14 gotcha 24.
   */
  setHistoryHold(hold: boolean): void;
  /** Resets the displayed error. */
  clearError(): void;
};

export function useClaudeSessionStream(
  sessionId: string,
  options: UseClaudeSessionStreamOptions = {},
): ClaudeSessionStreamState & ClaudeSessionStreamActions {
  const { cache, onKilled } = options;
  // Ref for onKilled: callers typically pass an inline arrow (cf.
  // ClaudePanel/ClaudeSessionView), so the `options.onKilled` ref changes on each
  // render. The SSE handler is created in a useEffect with eslint-disable
  // exhaustive-deps — without this pinning, the callback embedded in the
  // `status==='killed'` switch would become stale right after the 1st render.
  const onKilledRef = useRef(onKilled);
  useEffect(() => { onKilledRef.current = onKilled; }, [onKilled]);

  // ── State ──────────────────────────────────────────────────────────────
  const [sessionMeta, setSessionMeta] = useState<AgentSessionDetailResponse['session'] | null>(null);
  const vpsIdRef = useRef('');
  const providerRef = useRef<SessionProvider>(asSessionProvider(undefined));
  const [messages, setMessages] = useState<Msg[]>([]);
  const [currentAssistant, setCurrentAssistant] = useState('');
  const [status, setStatus] = useState<WorkerStatus | null>(null);
  const [permissionMode, setPermissionMode] = useState<SessionMode>('normal');
  // Per-session model / fallback / effort. Initialized from the DB row via
  // applyApiData; updated by `model_changed` / `effort_changed` SSE events.
  // null on either field means "inherit the global default".
  const [model, setModelState] = useState<string | null>(null);
  const [fallbackModel, setFallbackModelState] = useState<string | null>(null);
  const [effort, setEffortState] = useState<string | null>(null);
  // True while a setModel/setEffort change is queued but not yet applied
  // (live SDK client exists → takes effect at next sleep+resume). Reset on
  // the next start (status flips back to 'starting' → 'active'). The UI
  // uses this to render a "applies on resume" hint next to the badge.
  const [modelPendingApply, setModelPendingApply] = useState(false);
  const [effortPendingApply, setEffortPendingApply] = useState(false);
  // Effective model — what Anthropic actually billed for the last turn.
  // Initialized from r.effectiveModel via applyApiData; updated by the
  // effective_model SSE on every change. See ClaudeSessionStreamState.
  const [effectiveModel, setEffectiveModel] = useState<string | null>(null);
  const [liveUsage, setLiveUsage] = useState<ClaudeSessionStreamState['liveUsage']>(null);
  const responseSpeedRef = useRef(new ResponseSpeedTracker());
  const [responseSpeed, setResponseSpeed] = useState<ResponseSpeedSnapshot | null>(null);
  const resetResponseSpeed = useCallback(() => {
    responseSpeedRef.current.reset();
    setResponseSpeed(null);
  }, []);
  useEffect(() => {
    if (status !== 'thinking') {
      responseSpeedRef.current.stopReception();
      setResponseSpeed(responseSpeedRef.current.read(performance.now()));
      return;
    }
    responseSpeedRef.current.start(performance.now());
    setResponseSpeed(responseSpeedRef.current.read(performance.now()));
    const timer = window.setInterval(() => {
      setResponseSpeed(responseSpeedRef.current.read(performance.now()));
    }, 500);
    return () => clearInterval(timer);
  }, [status, resetResponseSpeed]);
  const [tokenUsage, setTokenUsage] = useState<SessionTokenUsage | null>(null);
  const [toolCalls, setToolCalls] = useState<ToolCallEntry[]>([]);
  const [edits, setEdits] = useState<Map<string, EditSnapshot>>(new Map());
  const [files, setFiles] = useState<Set<string>>(new Set());
  const [bgTasks, setBgTasks] = useState<BgTask[]>([]);
  const [permQueue, setPermQueue] = useState<PermissionRequest[]>([]);
  const [questionQueue, setQuestionQueue] = useState<PendingQuestion[]>([]);
  const [exitPlanQueue, setExitPlanQueue] = useState<PendingExitPlan[]>([]);
  const [prefillInput, setPrefillInput] = useState<string | null>(null);
  const [error, setError] = useState<{ msg: string } | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [isSyncing, setIsSyncing] = useState(true);
  const [historyReady, setHistoryReady] = useState(false);
  // A NETWORK response (not the cache) has been applied since mount.
  const freshAppliedRef = useRef(false);
  // Full history requests in flight; the delta probe stands down meanwhile.
  const fullFetchInflightRef = useRef(0);
  // Aborted on unmount: this view's requests stop using the link the moment
  // the user moves to another session.
  const lifetimeRef = useRef<AbortController | null>(null);
  const lifetimeSignal = useCallback(
    () => (lifetimeRef.current ??= new AbortController()).signal,
    [],
  );
  useEffect(() => () => {
    lifetimeRef.current?.abort(new DOMException('session view closed', 'AbortError'));
    lifetimeRef.current = null;
  }, []);
  const markSynced = useCallback(() => {
    setIsSyncing(false);
    setHistoryReady(true);
  }, []);
  // Pagination state. `oldestChatIdRef` is also kept as a ref so it can
  // be read without re-render in the scroll handler (which may spam) and in
  // loadMoreHistory (which must read the latest value before sending the POST).
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const oldestChatIdRef = useRef<number | null>(null);
  const loadMoreInflightRef = useRef(false);

  // ── "The user is reading history" hold (CLAUDE.md §14 gotcha 24) ────────
  // The safety-net poll escalates to a CLEAN FULL RELOAD whenever the cheap
  // `?since=` probe reports new rows, and that reload resets the window to
  // the latest 200 rows: every page the user paginated in vanishes, the
  // browser clamps scrollTop to the now-much-shorter range, and the reader is
  // yanked back toward the bottom — every 5s while a turn runs. So while the
  // user is scrolled away from the bottom we HOLD the reload instead of
  // dropping it: everything else in the poll (status, pending gates, the
  // streaming preview) still reconciles on every tick, live SSE still appends
  // at the bottom, and the held reload runs the instant the user comes back
  // down. Polling is untouched — only the destructive part is deferred, and
  // it is never abandoned.
  const historyHoldRef = useRef(false);
  const pendingReloadRef = useRef(false);

  // (banner-state work removed — replaced by auto-reload-on-recovery in
  // globalEventStream.ts. When the SSE silence > AUTO_RELOAD_THRESHOLD_MS
  // and then recovers, the page hard-reloads — exactly what the user does
  // manually with F5. cf. CLAUDE.md §14 gotcha 24.)

  // streamKey: bump to force re-creation of the SSE (used after
  // doResume — the session restarted and we want a fresh SSE).
  const [streamKey, setStreamKey] = useState(0);

  const assistantBufRef = useRef('');
  // See ClaudeSessionStreamState.streamingInto. The ref is what handlers read.
  const [streamingInto, setStreamingIntoState] = useState<number | null>(null);
  const streamingIntoRef = useRef<number | null>(null);
  const setStreamingInto = useCallback((rowId: number | null) => {
    streamingIntoRef.current = rowId;
    setStreamingIntoState((prev) => prev === rowId ? prev : rowId);
  }, []);
  // The hub cuts assistant bubbles (sync refonte I7): known from the last
  // GET's `features` (or the first `assistant_flushed` frame). Until then the
  // legacy client boundaries apply.
  const hubBoundariesRef = useRef(false);
  // Stop can update a row while an older GET is in flight. Keep the durable
  // finalization receipts so a stale response cannot repaint its border.
  const finalizedAssistantIdsRef = useRef<Set<number>>(new Set());
  // Rendering Markdown at display refresh rate is unnecessary even after the
  // live-tail renderer was made lightweight. A short timer caps React commits
  // around 12Hz while keeping typing/streaming perceptually immediate.
  const assistantFlushTimerRef = useRef<number | null>(null);
  // A delta provider's reasoning (Codex/Cursor), in the pure lane of
  // thinkingMessages.ts: fragments received but not yet committed to
  // `messages` (same ≤80ms commit cap as assistant text, §14.17) and the text
  // of the block still open hub-side (since its last `thinking_flushed`) —
  // reconciled against the GET's `streamingThinking` on a refetch. The timer
  // commits the batch.
  const thinkingLaneRef = useRef(createThinkingLane());
  const thinkingFlushTimerRef = useRef<number | null>(null);
  // The hub's open block as the previous delta poll saw it: frames that stop
  // arriving mid-block leave the screen behind it (openThinkingNeedsReload).
  const polledThinkingRef = useRef<string | null>(null);
  // Ref mirror of `effectiveModel` (state) so flushAssistantBuf — called from
  // SSE handlers whose closure would see a stale state value — can stamp the
  // finalized assistant bubble with the model that actually produced it.
  const effectiveModelRef = useRef<string | null>(null);
  // Background-task registry (cf. app/bgTasks.ts): the ref map is the working
  // copy patched by SSE events; `bgTasks` state is its sorted-array projection
  // (what the BgTasksBar renders). Launch candidates map the Bash
  // run_in_background tool_use id → command string for the 'started' event.
  const bgTasksRef = useRef<Map<string, BgTask>>(new Map());
  const bgLaunchesRef = useRef<Map<string, BgLaunchCandidate>>(new Map());
  // The last window answer could not give the full-history ACTIVE bg set
  // (`backgroundTasksPending`): until a `bg_tasks_snapshot` frame or an
  // authoritative answer settles it, the delta poll asks for it (`bg=1`) —
  // the frame is one-shot and lost if it outruns this view's SSE (§14.24).
  const bgPendingRef = useRef(false);
  // Bumped by every live `bg_task`/`bg_tasks_snapshot` frame and window
  // answer: a `bg=1` poll answer older than one of them is not applied.
  const bgRevisionRef = useRef(0);

  // Optimistically-rendered user messages (`send` shows the bubble + the
  // 'thinking' pill before the POST), keyed by the browser's
  // `clientMessageId` (sent with the POST, echoed on `user_echo`): an echo
  // replaces its bubble by IDENTITY; the content FIFO survives only for
  // echoes lacking the id (an older hub). transcriptReducer.ts.
  const sendsRef = useRef<OptimisticSends>(new Map());
  // Gate ids added/resolved live, by live-event revision: a pending snapshot
  // requested before them must not undo them (app/pendingQueueMerge.ts).
  const gateJournalRef = useRef<GateJournalEntry[]>([]);

  // ── Polling delta state ────────────────────────────────────────────────
  // Highest DB message id we have ever seen for this session. Used as the
  // cursor for the `?since=<id>` delta poll. Updated by applyApiData
  // (initial load + every clean refetch). Polling at
  // 5s is the safety net: even if the SSE silently dies, even if React 19
  // tears down our subscribers via hydration recovery, even if onerror is
  // never fired — the polling loop independently catches up. Together with
  // SSE we have defense in depth (SSE = fast, polling = guaranteed).
  // cf. CLAUDE.md §14 gotcha 24.
  const lastSeenServerIdRef = useRef<number>(0);
  // Whether the initial full load (applyApiData) has succeeded at least
  // once. Distinct from `lastSeenServerId !== 0` because an empty session
  // legitimately has cursor 0 yet must still be polled (so new messages
  // arrive). Until this is true, the safety loop does a full refetch
  // instead of a delta poll. cf. CLAUDE.md §14 gotcha 24.
  const initialLoadDoneRef = useRef<boolean>(false);
  // Guard against concurrent polls. The setInterval fires every 5s but a
  // very slow network could delay a fetch beyond 5s — we don't want to
  // stack pending polls.
  const inflightPollRef = useRef<boolean>(false);
  // AbortController of the in-flight poll, so wake-up handlers can cancel
  // a request that hung while the device was asleep and start fresh.
  const pollAbortRef = useRef<AbortController | null>(null);
  // Timestamp (ms) of the last LOCAL optimistic status change (send→thinking,
  // doSleep→sleeping, doResume→starting). The delta poll reconciles the status
  // pill from the server's authoritative liveStatus on every tick (CLAUDE.md
  // §14.45, RC2), but must NOT clobber a just-set optimistic status during the
  // brief window before the server reflects it — that would flicker. We skip
  // poll-driven status reconciliation within this guard window.
  const lastOptimisticStatusTsRef = useRef<number>(0);
  // Full fetches and live SSE race on different transports. A response that
  // started before a live event must not replace newer queues/config/text.
  const liveEventRevisionRef = useRef(0);
  // Rows a cut left wrong (`refetch.rowId`, length/row mismatch) → the live
  // revision when marked. The reload asked for them is normally DROPPED
  // mid-turn (frames move the revision on); its answer still patches these
  // rows (`patchAssistantRows`) — it started after the hub persisted them. A
  // later cut carrying the row's `content` heals it and unmarks it.
  const dirtyAssistantRowsRef = useRef<Map<number, number>>(new Map());

  // ── Lazy edit-content loading state (CLAUDE.md §14 gotcha 41) ────────────
  // The session GET strips edit_snapshot content; the diff content is fetched
  // separately, on demand, by loadEdits → GET /edits. These guard that fetch.
  const editsLoadInflightRef = useRef(false);
  // file_paths we already attempted to load but couldn't fill (budget-dropped
  // server-side, or a genuinely empty snapshot) — so the auto-load effect
  // doesn't retry them forever.
  const editsLoadAttemptedRef = useRef<Set<string>>(new Set());

  // ── Apply an API payload to local state ────────────────────────────────
  // Full refresh path — used by refetchHistory (initial mount, switch,
  // explicit resync) AND by the polling loop, which does a clean refetch
  // whenever the cheap `?since=` probe reports new rows (see pollDelta).
  // Replaces local state entirely.
  const applyApiData = useCallback((r: AgentSessionDetailResponse, sinceRevision = 0) => {
    if (!r?.session) return;
    if (Array.isArray(r.features)) hubBoundariesRef.current = r.features.includes('assistant_flushed');
    setTokenUsage((prev) => mergeSessionTokenUsage(prev, r.tokenUsage));
    providerRef.current = asSessionProvider(r.session.kind);
    const liveStatus = (r.liveStatus ?? r.session.status) as WorkerStatus;
    const finalizedIds = finalizedAssistantIdsRef.current;
    const rows = finalizedIds.size
      ? r.messages.map((m) => finalizedIds.has(m.id) ? { ...m, assistantFinal: 1 } : m)
      : r.messages;
    const rebuilt = rebuildStateFromMessages(rows, liveStatus, providerRef.current);
    // Streaming preview reconciliation (app/streamingPreview.ts). applyApiData
    // runs on the initial load AND on every poll-triggered clean reload (which
    // can happen every 5s during active SSE streaming), so it must not rewind a
    // smoothly-streaming preview — nor keep one alive after the turn that
    // produced it ended.
    // `streamingExtends` (hub boundaries): the hub's buffer extends a
    // persisted row and `streamingText` is only what follows it — drawn into
    // that row. A buffer held against another row (or none) is not
    // comparable: the server's wins.
    const serverInto = hubBoundariesRef.current ? (r.streamingExtends?.rowId ?? null) : null;
    const nextPreview = serverInto !== streamingIntoRef.current
      ? String(r.streamingText ?? '')
      : reconcileStreamingPreview({
        serverText: String(r.streamingText ?? ''),
        localText: assistantBufRef.current,
        status: liveStatus,
        lastAssistant: serverInto != null ? null : [...rebuilt.messages].reverse()
          .find((m) => m.role === 'assistant')?.content ?? null,
      });
    assistantBufRef.current = nextPreview;
    setCurrentAssistant(nextPreview);
    setStreamingInto(serverInto);
    // A delta provider's open reasoning block is not a row yet (the hub
    // coalesces one row per block, §14.17): show it after the rebuilt history,
    // joined to the persisted head of the same block. Batched fragments are
    // part of the local open text, so the batch is dropped either way.
    let rebuiltMessages = rebuilt.messages;
    if (PROVIDERS[providerRef.current].thinkingDelivery === 'delta') {
      if (thinkingFlushTimerRef.current != null) {
        clearTimeout(thinkingFlushTimerRef.current);
        thinkingFlushTimerRef.current = null;
      }
      polledThinkingRef.current = null;
      rebuiltMessages = thinkingLaneSnapshot(thinkingLaneRef.current, rebuiltMessages,
        String(r.streamingThinking ?? ''), openThinkingCreatedAt(r.streamingThinkingTsMs),
        Math.max(typeof r.maxMessageId === 'number' ? r.maxMessageId : 0, ...thinkingRowIds(r.messages)));
    }
    setMessages(rebuiltMessages);
    setStatus(rebuilt.status);
    setToolCalls(rebuilt.toolCalls);
    // The visible message window is paginated, so it cannot be the liveness
    // oracle: a task launched >200 chat rows ago may still run. Reconcile its
    // recent completion cards with the API's compact full-history ACTIVE set
    // (still warming: keep the running tasks held, bgTasks.ts).
    const reconciledBgTasks = bgTasksAfterWindowAnswer(rebuilt.bgTasks, r, bgTasksRef.current.values());
    bgPendingRef.current = !Array.isArray(r.backgroundTasks) && r.backgroundTasksPending === true;
    bgTasksRef.current = new Map(reconciledBgTasks.map((t) => [t.taskId, { ...t }]));
    bgRevisionRef.current += 1;
    setBgTasks(reconciledBgTasks);
    // Merge (not replace): the rebuilt edits carry no content (the GET strips
    // edit_snapshot content — CLAUDE.md §14 gotcha 41). Keep already-loaded
    // diff content; the auto-load effect refills any stripped skeletons.
    setEdits((prev) => mergeEdits(prev, rebuilt.edits));
    setFiles(rebuilt.files);
    // Mode: Claude sessions use a permission mode; Codex sessions store a
    // sandbox level in the same field — accept both by kind so a codex mode
    // isn't reset to 'normal'.
    const sessKind = asSessionProvider((r.session as { kind?: string })?.kind);
    const pm = r.session?.permissionMode as SessionMode;
    setPermissionMode(
      isSessionMode(sessKind, pm) ? pm : defaultSessionMode(sessKind),
    );
    // Initialize model / fallback / effort from the DB row. The session row
    // schema includes these columns (cf. lib/db/schema.ts § claudeSessions);
    // ClaudeSession (= typeof claudeSessions.$inferSelect) carries them
    // transitively. Effort is a free string (Claude OR Codex catalog) — server
    // side already filters invalid values, so pass it through as-is.
    const sess = r.session as typeof r.session & { model?: string | null; fallbackModel?: string | null; effort?: string | null };
    setModelState(sess.model ?? null);
    setFallbackModelState(sess.fallbackModel ?? null);
    setEffortState(sess.effort || null);
    // Full refetch = the session was reloaded from DB → any pending-apply
    // marker from a previous resume cycle is now stale (either applied or
    // moot). Clear so the UI doesn't show "applies on resume" forever.
    setModelPendingApply(false);
    setEffortPendingApply(false);
    // Effective model is in the GET payload (from peekStream().effectiveModel
    // server-side). Null on first attach (no turn yet) or on old agents. The
    // SSE will deliver it on the next turn either way.
    setEffectiveModel(r.effectiveModel ?? null);
    effectiveModelRef.current = r.effectiveModel ?? null;
    setSessionMeta(r.session);
    vpsIdRef.current = r.session.vpsId;
    // Interaction queues — we inject the sessionId required by the shared
    // type (the API doesn't return it by default).
    // Gates added/resolved live since this request started are re-applied
    // over its snapshot (INTERIM pendingQueueMerge.ts, until C16).
    const sid = r.session.id;
    const { liveAdded, liveResolved } = gateChangesSince(gateJournalRef.current, sinceRevision);
    const snapPerms = ((r.pendingPermissions ?? []) as Omit<PermissionRequest, 'sessionId'>[])
      .map((p) => ({ ...p, sessionId: sid }));
    const snapQuestions = ((r.pendingQuestions ?? []) as Omit<PendingQuestion, 'sessionId'>[])
      .map((q) => ({ ...q, sessionId: sid }));
    const snapExitPlans = ((r.pendingExitPlans ?? []) as Omit<PendingExitPlan, 'sessionId'>[])
      .map((e) => ({ ...e, sessionId: sid }));
    setPermQueue((cur) => mergePendingSnapshot(snapPerms, liveAdded, liveResolved, cur));
    setQuestionQueue((cur) => mergePendingSnapshot(snapQuestions, liveAdded, liveResolved, cur));
    setExitPlanQueue((cur) => mergePendingSnapshot(snapExitPlans, liveAdded, liveResolved, cur));
    // We have data, whether from cache or fresh fetch → we can hide the
    // loader. True-zero-messages = we'll know via messages.length.
    setIsLoadingHistory(false);
    // Reset pagination cursor from the fresh window. `r.hasMore` and
    // `r.oldestChatId` come from the backend (cf. loadMessageWindow). If the
    // response doesn't have them (response cached from an earlier version),
    // we fall back to false/null → pagination simply disabled for this
    // session until the next fresh fetch.
    setHasMore(!!r.hasMore);
    oldestChatIdRef.current = r.oldestChatId ?? null;
    // Update polling cursor. Prefer the server's authoritative
    // `maxMessageId` (true max across ALL roles) over the max id of the
    // returned window — the window can exclude trailing edit_snapshot/event
    // rows, and using the window max made the delta poll return the same
    // rows forever (cursor stuck). MONOTONIC: never let the cursor go
    // backwards (a stale/cached response must not rewind it).
    let maxId = lastSeenServerIdRef.current;
    const serverMax = typeof r.maxMessageId === 'number' ? r.maxMessageId : 0;
    if (serverMax > maxId) maxId = serverMax;
    for (const m of (r.messages ?? []) as { id: number }[]) {
      if (typeof m.id === 'number' && m.id > maxId) maxId = m.id;
    }
    lastSeenServerIdRef.current = maxId;
    // The initial load has produced data → the polling loop can switch
    // from "full refetch" to "delta poll" (even if maxId is still 0 for an
    // empty session).
    initialLoadDoneRef.current = true;
  }, [setStreamingInto]);

  // refetchHistory: used at mount, by the poll's clean reload, on `stop` and
  // when a held reload is released. Cache strategy:
  //   1. Until a fresh answer has landed, a cache entry paints immediately.
  //      After that it is only ever OLDER than the screen: re-applying it on
  //      every reload rewound the chat to the previous snapshot, wiping what
  //      the SSE had appended since.
  //   2. The fresh fetch replaces it.
  // Without cache: a single direct fetch.
  //
  // A response that started before a live event is normally dropped (it would
  // overwrite newer state). Not the FIRST one: the screen then still shows
  // the cache, older than anything the server can answer — dropping it kept a
  // stale transcript up for as long as events streamed (a whole turn).
  const refetchHistory = useCallback(async () => {
    const signal = lifetimeSignal();
    const cached = cache?.get(sessionId);
    if (cached && !freshAppliedRef.current) applyApiData(cached);
    const requestRevision = liveEventRevisionRef.current;
    fullFetchInflightRef.current += 1;
    try {
      const fresh = cache
        ? await cache.fetch(sessionId, true, signal)
        : (await sessionApi.get(sessionId, signal)) as AgentSessionDetailResponse;
      if (signal.aborted) return;
      if (!freshAppliedRef.current || liveEventRevisionRef.current === requestRevision) {
        applyApiData(fresh, requestRevision);
        freshAppliedRef.current = true;
        for (const [rowId, rev] of dirtyAssistantRowsRef.current) {
          if (rev <= requestRevision) dirtyAssistantRowsRef.current.delete(rowId);
        }
      } else if (dirtyAssistantRowsRef.current.size) {
        const due = [...dirtyAssistantRowsRef.current].filter(([, rev]) => rev <= requestRevision).map(([id]) => id);
        if (due.length) {
          for (const id of due) dirtyAssistantRowsRef.current.delete(id);
          const rows = (fresh?.messages ?? []) as Array<{ id: number; role: string; content: string }>;
          setMessages((prev) => patchAssistantRows(prev, rows, due));
        }
      }
      // Dropped or applied, the catch-up has its answer: a drop means live
      // events are flowing, and a cue held for the rest of the turn would be
      // a false alarm.
      markSynced();
    } catch (e) {
      if (signal.aborted) return;
      if (!cached) {
        setError({ msg: String((e as Error)?.message ?? e) });
        setIsLoadingHistory(false); // we drop the loader, the error is displayed
      }
    } finally {
      fullFetchInflightRef.current -= 1;
      // Failed or not, the transcript no longer occupies the link.
      if (!signal.aborted) setHistoryReady(true);
    }
  }, [sessionId, cache, applyApiData, lifetimeSignal, markSynced]);

  // Declare/release the "reading history" hold described above. Called by the
  // view's scroll handler with `!isAtBottom`. Releasing runs a held reload
  // immediately — waiting for the next 5s tick would let the user watch the
  // stale tail for a beat after they scrolled back down.
  const setHistoryHold = useCallback((hold: boolean) => {
    if (historyHoldRef.current === hold) return;
    historyHoldRef.current = hold;
    if (!hold && pendingReloadRef.current) {
      pendingReloadRef.current = false;
      refetchHistory();
    }
  }, [refetchHistory]);

  // ── Lazy edit-content loader (CLAUDE.md §14 gotcha 41) ──────────────────
  // Fetches the latest before/after content per file from the dedicated
  // /edits endpoint and fills the (content-stripped) skeleton entries for
  // `targetPaths`. Only fills entries that are currently unloaded so it never
  // clobbers live edit_snapshot SSE content. Marks any file it couldn't fill
  // as "attempted" so the auto-load effect terminates.
  const loadEdits = useCallback(async (targetPaths: string[]) => {
    if (editsLoadInflightRef.current) return;
    if (targetPaths.length === 0) return;
    editsLoadInflightRef.current = true;
    try {
      const r = await sessionApi.getEdits(sessionId, lifetimeSignal());
      const byPath = new Map(r.edits.map((e) => [e.filePath, e] as const));
      setEdits((prev) => {
        const next = new Map(prev);
        let changed = false;
        for (const path of targetPaths) {
          const cur = next.get(path);
          // Skip if gone, or already loaded/filled live in the meantime.
          if (!cur || cur.before != null || cur.after != null) continue;
          const got = byPath.get(path);
          if (got && (got.before != null || got.after != null)) {
            next.set(path, {
              ...cur,
              before: got.before,
              after: got.after,
              truncated: cur.truncated || got.truncated,
              toolUseId: got.toolUseId || cur.toolUseId,
            });
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      // Anything we asked for but couldn't fill (absent from the response or
      // budget-dropped → null content) is marked attempted, so we don't loop.
      for (const path of targetPaths) {
        const got = byPath.get(path);
        if (!got || (got.before == null && got.after == null)) {
          editsLoadAttemptedRef.current.add(path);
        }
      }
    } catch {
      // Transient (network / 503). Leave `attempted` untouched so the next
      // edits change retries. Silent — the diffs tab is non-critical UI.
    } finally {
      editsLoadInflightRef.current = false;
    }
  }, [sessionId, lifetimeSignal]);

  // ── Delta poll (safety-net loop) ───────────────────────────────────────
  // Independent of the SSE: fetches `GET ?since=<lastSeenServerId>` and
  // applies the delta. Designed to be cheap when nothing changed (most
  // calls return an empty messages array). Coexists with the SSE-driven
  // live updates: SSE is the fast path (sub-second latency), polling is
  // the floor guarantee (max staleness = poll interval = 5s).
  //
  // Why both? Because the SSE has historically been fragile:
  //   - The browser's EventSource may close permanently on a non-200
  //     response from the reverse proxy (CLAUDE.md §14 gotcha 24).
  //   - Hydration errors in React 19 can re-render the entire root,
  //     tearing down our subscribeReconnect listeners.
  //   - Network blips, mobile sleep, proxy buffering, etc.
  // Polling makes ALL of these failure modes self-healing: even if every
  // SSE-related fix breaks tomorrow, the user still sees new messages
  // within 5s. cf. CLAUDE.md §14 gotcha 24.
  const pollDelta = useCallback(async (force = false) => {
    if (inflightPollRef.current) return;
    // Skip background tabs to save battery — visibilitychange handler
    // will trigger an immediate catch-up poll when the tab returns.
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    // Skip when the browser knows it's offline — pointless to fire a
    // request that will immediately ERR_NETWORK. The `online` event
    // handler force-polls the moment connectivity returns.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    // Don't poll before the initial full load has completed — a delta
    // before we know the cursor would either pull the whole history
    // (since=0) or miss the window. safetyTick does the full refetch in
    // that state; once it's done we switch to cheap deltas.
    if (!initialLoadDoneRef.current) return;
    // A full reload in flight answers the same question with more. At mount
    // the probe's cursor comes from the cache, so it would download every
    // row since — tens of KB racing the transcript itself on a slow link.
    // Wake-ups (`force`) still probe: that reload may be a socket the device
    // left hanging when it slept.
    if (!force && fullFetchInflightRef.current > 0) return;
    const since = lastSeenServerIdRef.current;
    const requestRevision = liveEventRevisionRef.current;
    inflightPollRef.current = true;
    const ac = new AbortController();
    pollAbortRef.current = ac;
    try {
      const askBg = bgPendingRef.current;
      const bgRevision = bgRevisionRef.current;
      const r = await sessionApi.pollSince(sessionId, since, ac.signal, askBg ? { bg: true } : undefined) as AgentSessionDetailResponse;
      setTokenUsage((prev) => mergeSessionTokenUsage(prev, r.tokenUsage));
      // The pending bg set, once warm (a frame may have settled it meanwhile).
      // A bg frame handled during the request is newer than this set: skip
      // it, still pending, and ask again next tick (bgTasksAfterPollAnswer).
      const polledBg = askBg && bgPendingRef.current
        ? bgTasksAfterPollAnswer(bgTasksToArray(bgTasksRef.current), r.backgroundTasks as BgTask[] | undefined,
            bgRevision, bgRevisionRef.current)
        : null;
      if (polledBg) {
        bgPendingRef.current = false;
        bgTasksRef.current = new Map(polledBg.map((t) => [t.taskId, { ...t }]));
        bgRevisionRef.current += 1;
        setBgTasks(polledBg);
      }
      // ── Reconcile the status pill from the server's authoritative liveStatus
      // on EVERY tick (CLAUDE.md §14.45, RC2). The quiet poll used to read ONLY
      // `r.messages` and ignored `liveStatus`/`session.status`, so a pure
      // status transition the SSE missed (thinking→active/sleeping with no
      // trailing message row) left the pill — and the ThinkingBar — stuck on
      // 'thinking' until the next FULL-refetch trigger (reconnect / visibility
      // / focus). `liveStatus` is the in-memory stream status (agent ground
      // truth) or, before reconcile re-attaches the stream, the DB row. We skip
      // 'killed' (handled via the 404 path below) and skip briefly after a
      // local optimistic change to avoid flicker against an in-flight action.
      const live = (r?.liveStatus ?? r?.session?.status) as WorkerStatus | undefined;
      if (live && live !== 'killed' && (Date.now() - lastOptimisticStatusTsRef.current) > 4000) {
        setStatus((prev) => (prev === live ? prev : live));
      }
      // The delta endpoint also carries the complete lightweight live
      // envelope. Reconcile it even when no DB message was inserted: a long
      // assistant stream, a permission resolution, or a model change can all
      // happen without advancing the message cursor.
      // Same reconciliation as the full reload, minus the window (the delta
      // poll carries no message history, so the prefix proof isn't available
      // here — the settled rule is, and it is the one that matters for a
      // session whose turn is over). cf. app/streamingPreview.ts.
      if (Array.isArray(r?.features)) hubBoundariesRef.current = r.features.includes('assistant_flushed');
      // Only an answer no live frame overtook may touch the preview: a cut
      // handled meanwhile (`assistant_flushed`) already consumed what this
      // snapshot calls the open buffer / reopened row, and adopting it would
      // draw that text twice and seed the next row with it.
      if (liveEventRevisionRef.current === requestRevision) {
        const serverInto = hubBoundariesRef.current ? (r?.streamingExtends?.rowId ?? null) : null;
        const nextPreview = serverInto !== streamingIntoRef.current
          ? String(r?.streamingText ?? '')
          : reconcileStreamingPreview({
            serverText: String(r?.streamingText ?? ''),
            localText: assistantBufRef.current,
            status: live,
          });
        assistantBufRef.current = nextPreview;
        setCurrentAssistant((prev) => prev === nextPreview ? prev : nextPreview);
        setStreamingInto(serverInto);
      }
      const sid = r?.session?.id ?? sessionId;
      const nextPerms = ((r?.pendingPermissions ?? []) as Omit<PermissionRequest, 'sessionId'>[])
        .map((p) => ({ ...p, sessionId: sid }));
      const nextQuestions = ((r?.pendingQuestions ?? []) as Omit<PendingQuestion, 'sessionId'>[])
        .map((q) => ({ ...q, sessionId: sid }));
      const nextExitPlans = ((r?.pendingExitPlans ?? []) as Omit<PendingExitPlan, 'sessionId'>[])
        .map((ep) => ({ ...ep, sessionId: sid }));
      // The queues were read before any live frame that arrived meanwhile:
      // re-apply those over them (INTERIM pendingQueueMerge.ts, R3 F8).
      const gates = gateChangesSince(gateJournalRef.current, requestRevision);
      const merged = <T extends { id: string }>(prev: T[], snap: T[]) => {
        const next = mergePendingSnapshot(snap, gates.liveAdded, gates.liveResolved, prev);
        return sameQueueById(prev, next) ? prev : next;
      };
      setPermQueue((prev) => merged(prev, nextPerms));
      setQuestionQueue((prev) => merged(prev, nextQuestions));
      // Resolutions also arrive durably through the delta path. Apply them
      // while older pages are held, without replacing the reader's history.
      for (const m of r.messages ?? []) {
        if (m.role !== 'event') continue;
        try {
          const ev = JSON.parse(m.content);
          if (ev.type === 'interaction_resolved' && ev.kind === 'question') {
            setMessages((prev) => resolveAsyncQuestionMessages(prev, ev.id, ev.outcome, ev.answers));
          }
        } catch {}
      }
      setExitPlanQueue((prev) => merged(prev, nextExitPlans));

      if (r?.session) {
        const sess = r.session as typeof r.session & {
          kind?: string; model?: string | null; fallbackModel?: string | null; effort?: string | null;
        };
        const kind = asSessionProvider(sess.kind);
        providerRef.current = kind;
        const nextMode = isSessionMode(kind, sess.permissionMode)
          ? sess.permissionMode as SessionMode
          : defaultSessionMode(kind);
        setPermissionMode((prev) => prev === nextMode ? prev : nextMode);
        setModelState((prev) => prev === (sess.model ?? null) ? prev : sess.model ?? null);
        setFallbackModelState((prev) => prev === (sess.fallbackModel ?? null) ? prev : sess.fallbackModel ?? null);
        setEffortState((prev) => prev === (sess.effort || null) ? prev : sess.effort || null);
        setSessionMeta((prev) => sameShallowRecord(prev, sess) ? prev : sess);
      }
      const polledEffective = r?.effectiveModel ?? null;
      setEffectiveModel((prev) => prev === polledEffective ? prev : polledEffective);
      effectiveModelRef.current = polledEffective;
      const n = r?.messages?.length ?? 0;
      // A delta provider's open reasoning block writes no row until it
      // closes: frames that STOPPED arriving mid-block (a dead focus) would
      // otherwise stay lost while the screen reads "synced" (§14.24). Only
      // then: while frames still flow (a hole left by a reconnect), the
      // reload this escalates to is dropped by refetchHistory's live-revision
      // guard (R3 F17), until the turn goes quiet — the snapshot+journal of
      // step 3 (I6) closes that case, not this poll.
      let thinkingBehind = false;
      if (PROVIDERS[providerRef.current].thinkingDelivery === 'delta') {
        const serverThinking = String(r?.streamingThinking ?? '');
        thinkingBehind = openThinkingNeedsReload(serverThinking, thinkingLaneRef.current.open, polledThinkingRef.current);
        polledThinkingRef.current = serverThinking || null;
      }
      if (n > 0 || thinkingBehind) {
        // Something new on the server. Rather than incrementally merge the
        // delta into local state (which historically produced corrupted
        // state — duplicate React keys, partial tool pairs — that threw
        // during render and looped the error boundary), we do a CLEAN FULL
        // RELOAD: exactly what hitting F5 does, but without losing the SSE
        // or scroll. `refetchHistory` → `applyApiData` →
        // `rebuildStateFromMessages` rebuilds the whole chat from scratch
        // and sets the cursor to the authoritative `maxMessageId`, so the
        // next poll returns 0. cf. CLAUDE.md §14 gotcha 24.
        // …unless the user is reading history right now, in which case the
        // reload is HELD (not dropped) — it would destroy the paginated pages
        // under them. Released the moment they scroll back to the bottom.
        if (historyHoldRef.current) {
          pendingReloadRef.current = true;
        } else {
          if (typeof console !== 'undefined') {
            // eslint-disable-next-line no-console
            console.info(`[charon] poll ${sessionId.slice(0, 8)}: ${n > 0 ? `+${n} row(s) since ${since}` : 'open reasoning behind'} → clean reload`);
          }
          await refetchHistory();
        }
      } else {
        // Nothing persisted that the screen lacks, and the live envelope
        // above is current: the view is up to date.
        markSynced();
      }
    } catch (e) {
      // Network errors are silent — the next tick will retry. We don't
      // want to surface a banner each time the user drops Wi-Fi for 2s.
      // One exception: 404 means the session was deleted server-side
      // (could be SSE-missed, especially if the SSE is currently down).
      // Trigger the same onKilled path so the parent navigates away.
      const msg = String((e as Error)?.message ?? e);
      if (msg.includes('→ 404')) {
        onKilledRef.current?.();
      } else if (msg.includes('→ 401')) {
        // Session expired (24h TTL lapsed during a long outage). Every request
        // now 401s; reload once → /login. cf. CLAUDE.md §14.45 (P8).
        reloadForExpiredSession();
      }
    } finally {
      if (pollAbortRef.current === ac) pollAbortRef.current = null;
      inflightPollRef.current = false;
    }
  }, [sessionId, refetchHistory, markSynced, setStreamingInto]);

  // safetyTick: the unit of work the 5s loop runs. SELF-SUFFICIENT — it
  // does NOT depend on the SSE or on the mount-time refetch ever
  // succeeding:
  //   - cursor not yet set (lastSeenServerId === 0): the initial full load
  //     either hasn't completed or FAILED (e.g. it raced a Charon restart
  //     and 503'd). Do a full refetch here — that sets the cursor. Without
  //     this, a failed initial load left polling permanently disabled
  //     (pollDelta bails on since===0), so the chat stayed frozen until
  //     F5 even though the loop was "running".
  //   - cursor set: cheap delta poll.
  // A full load already in flight is not duplicated (at mount the effect's
  // own refetch is still running when the loop's first tick fires).
  const safetyTick = useCallback((force = false) => {
    if (!initialLoadDoneRef.current) {
      if (fullFetchInflightRef.current === 0) void refetchHistory();
    } else {
      void pollDelta(force);
    }
  }, [refetchHistory, pollDelta]);

  // Force an immediate sync, cancelling any in-flight poll. Used by the
  // wake-up handlers (online / visibilitychange): a poll that was issued
  // before the device slept may still be "in flight" (hung socket), which
  // would block the inflight guard. We abort it and start clean so the
  // user sees fresh data within ~1s of waking, not after the hung
  // request's 12s timeout.
  // `stale`: the screen may have missed a stretch (tab hidden, network or
  // SSE back) — show the syncing cue until the probe confirms or reloads.
  const forcePoll = useCallback((stale = false) => {
    if (stale) setIsSyncing(true);
    if (pollAbortRef.current) {
      try { pollAbortRef.current.abort(); } catch {}
      pollAbortRef.current = null;
    }
    inflightPollRef.current = false;
    safetyTick(true);
  }, [safetyTick]);

  // loadMoreHistory: loads a page of older history, prepends to local
  // state. Triggered by the caller on scroll-up. Idempotent and
  // protected against concurrent calls by loadMoreInflightRef.
  const loadMoreHistory = useCallback(async () => {
    if (loadMoreInflightRef.current) return;
    const cursor = oldestChatIdRef.current;
    if (cursor == null) return;
    if (!hasMore) return;
    loadMoreInflightRef.current = true;
    setIsLoadingMore(true);
    try {
      const older = await sessionApi.loadOlder(sessionId, cursor, 200);
      // Server may return hasMore=false even if the page is non-empty:
      // the old cursor was already the limit. We update anyway.
      const olderRebuilt = rebuildStateFromMessages(
        older.messages,
        (status ?? 'sleeping') as WorkerStatus,
        providerRef.current,
      );
      if (olderRebuilt.messages.length > 0) {
        setMessages((cur) => prependMessagePage(olderRebuilt.messages, cur));
        setToolCalls((cur) => [...olderRebuilt.toolCalls, ...cur]);
        setFiles((cur) => {
          const next = new Set(cur);
          for (const f of olderRebuilt.files) next.add(f);
          return next;
        });
        setEdits((cur) => {
          // For edits: recent snapshots (live or already loaded) take
          // priority — we don't overwrite an existing entry with an older
          // one for the same file_path. Otherwise we'd lose the recent diff.
          const next = new Map(cur);
          for (const [k, v] of olderRebuilt.edits) {
            if (!next.has(k)) next.set(k, v);
          }
          return next;
        });
      }
      // Advance the cursor + hasMore status based on the new limit.
      oldestChatIdRef.current = older.oldestChatId ?? cursor;
      setHasMore(!!older.hasMore);
      // Persist into the cache to preserve pages across switch/remount.
      if (cache?.extendWithOlder && older.messages.length > 0) {
        try { cache.extendWithOlder(sessionId, older); } catch {}
      }
    } catch (e) {
      setError({ msg: String((e as Error)?.message ?? e) });
    } finally {
      setIsLoadingMore(false);
      loadMoreInflightRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, hasMore, cache, status]);

  // ── Subscription to the global event stream ────────────────────────────
  useEffect(() => {
    // Load history from the DB. Independent of the SSE.
    refetchHistory();
    // Signal to the server to stream high-volume events for THIS session
    // on the multiplexed SSE. The SSE doesn't close / doesn't reopen —
    // it's just a POST that changes the filter on the server side. The
    // streamKey (bumped after doResume) triggers refetch + re-focus.
    setFocus(sessionId);

    // Flush assistant buffer: creates a full 'assistant' message and resets.
    // Called before any event that interrupts the text (tool_use, thinking,
    // permission_request, user_question, exit_plan_request, stop).
    const flushAssistantBuf = () => {
      // Cancel a pending preview commit — the boundary flushes immediately.
      if (assistantFlushTimerRef.current != null) {
        clearTimeout(assistantFlushTimerRef.current);
        assistantFlushTimerRef.current = null;
      }
      if (!assistantBufRef.current) return;
      const finalContent = assistantBufRef.current;
      assistantBufRef.current = '';
      setMessages((prev) => [...prev, {
        id: 'a' + Date.now() + Math.random(), role: 'assistant',
        content: finalContent, createdAt: Math.floor(Date.now() / 1000),
        // Per-message model attribution (mirror of the server-side stamp in
        // sessionOps._flushAssistant — the next refetch replaces this bubble
        // with the DB row carrying the authoritative value).
        model: effectiveModelRef.current,
        assistantFinal: 0,
      }]);
      setCurrentAssistant('');
    };

    // Client-side bubble boundary: ONLY against a hub without
    // `assistant_flushed` (sync refonte I7) — the hub cuts bubbles itself
    // and announces each cut before the boundary frame. A connect snapshot's
    // replayed gate (`snapshot: true`) is never a boundary (R3 F16).
    const legacyBoundary = (ev?: { snapshot?: boolean }) => {
      if (hubBoundariesRef.current || ev?.snapshot) return;
      flushAssistantBuf();
    };
    const liveBuffers = (): LiveBuffers => ({
      assistant: assistantBufRef.current,
      streamingInto: streamingIntoRef.current,
      thinkingOpen: thinkingLaneRef.current.open,
    });
    const runEffects = (effects: Effect[]) => {
      for (const e of effects) {
        if (e.kind !== 'refetch') continue;
        if (e.rowId != null) dirtyAssistantRowsRef.current.set(e.rowId, liveEventRevisionRef.current);
        // eslint-disable-next-line no-console
        console.info(`[charon] ${sessionId.slice(0, 8)}: ${e.reason} → clean reload`);
        cache?.invalidate?.(sessionId);
        void refetchHistory();
        break;
      }
    };
    const journal = (id: string, op: 'added' | 'resolved') => {
      gateJournalRef.current = journalGate(gateJournalRef.current, { rev: liveEventRevisionRef.current, id, op });
    };

    // Coalesce token deltas into at most one React commit per 80ms.
    const scheduleAssistantFlush = () => {
      if (assistantFlushTimerRef.current != null) return;
      assistantFlushTimerRef.current = window.setTimeout(() => {
        assistantFlushTimerRef.current = null;
        setCurrentAssistant(assistantBufRef.current);
      }, 80);
    };

    // A delta provider's reasoning fragments: one React commit per 80ms at
    // most, like assistant text (§14.17). The hub already coalesces its
    // frames per 25ms; this caps the browser side.
    const thinkingFragment = () => ({ id: 'th' + Date.now() + Math.random(), createdAt: Math.floor(Date.now() / 1000) });
    const clearThinkingTimer = () => {
      if (thinkingFlushTimerRef.current != null) {
        clearTimeout(thinkingFlushTimerRef.current);
        thinkingFlushTimerRef.current = null;
      }
    };
    const commitThinkingBatch = () => {
      clearThinkingTimer();
      const update = thinkingLaneCommit(thinkingLaneRef.current, thinkingFragment());
      if (update) setMessages(update);
    };
    const scheduleThinkingCommit = () => {
      if (thinkingFlushTimerRef.current != null) return;
      thinkingFlushTimerRef.current = window.setTimeout(() => {
        thinkingFlushTimerRef.current = null;
        commitThinkingBatch();
      }, 80);
    };

    const handleEvent = (ev: WorkerEvent & { sessionId: string }, reception?: EventReception) => {
      liveEventRevisionRef.current += 1;
      // Any other frame lands AFTER the reasoning received before it.
      const committed = thinkingLaneBeforeFrame(thinkingLaneRef.current, ev.type, thinkingFragment());
      if (ev.type !== 'thinking') clearThinkingTimer();
      if (committed) setMessages(committed);
      if (responseSpeedRef.current.observe(ev, reception?.at ?? performance.now(), reception?.bytes)) {
        setResponseSpeed(null);
      } else if (ev.type === 'usage' || ev.type === 'stop') {
        setResponseSpeed(responseSpeedRef.current.read(performance.now()));
      }
      switch (ev.type) {
        case 'status':
          // `'killed'` is no longer a persistent DB state (cf. CLAUDE.md §10):
          // it's a **transient signal** emitted by the server when the session
          // has just been deleted (DB cascade done). The caller wants a
          // redirect (navigation out of the session). We trigger `onKilled`
          // and don't touch the local status to avoid re-rendering a UI
          // that will be unmounted right after.
          if (ev.status === 'killed') {
            onKilledRef.current?.();
            break;
          }
          setStatus(ev.status);
          // The CLI process died with the session: its background children
          // can never notify again — mark running tasks stale.
          if ((ev.status === 'sleeping' || ev.status === 'error')
              && markRunningBgTasksStale(bgTasksRef.current)) {
            setBgTasks(bgTasksToArray(bgTasksRef.current));
          }
          break;
        case 'user_echo': {
          setLiveUsage(null);
          // Our own send (its `clientMessageId`) takes its row's id in place;
          // an unknown id is a foreign send (another tab/device/the server)
          // and appends `m<rowId>` once; an id-less echo (older hub) is
          // matched by content against our sends. transcriptReducer.ts.
          const { sends, match } = matchUserEcho(sendsRef.current, ev);
          sendsRef.current = sends;
          if (match.kind !== 'suppress') setMessages((prev) => applyUserEchoMatch(prev, match, ev));
          break;
        }
        case 'assistant_text':
          assistantBufRef.current += ev.delta;
          scheduleAssistantFlush();
          break;
        case 'assistant_flushed':
        case 'assistant_reopened': {
          // The hub cut the bubble (row `rowId`) or reopened a persisted
          // partial for the deltas that follow (I7, transcriptReducer.ts).
          // The pending ≤80 ms preview commit is superseded by this one.
          hubBoundariesRef.current = true;
          if (assistantFlushTimerRef.current != null) {
            clearTimeout(assistantFlushTimerRef.current);
            assistantFlushTimerRef.current = null;
          }
          const before = liveBuffers();
          const { buf, effects } = flushFrameBuffer(before, ev);
          // The persisted text itself: that row is right again.
          if (ev.type === 'assistant_flushed' && typeof ev.content === 'string' && ev.rowId != null) {
            dirtyAssistantRowsRef.current.delete(ev.rowId);
          }
          assistantBufRef.current = buf.assistant;
          setCurrentAssistant(buf.assistant);
          setStreamingInto(buf.streamingInto);
          const nowMs = Date.now();
          setMessages((prev) => applyFlushFrame(prev, before, ev, { nowMs }));
          runEffects(effects);
          break;
        }
        case 'tool_use': {
          legacyBoundary();
          const filePath = (ev.input && ev.input.file_path) ? String(ev.input.file_path) : null;
          // Background launch → remember the command for the upcoming
          // bg_task 'started' event (correlated by tool_use_id).
          if (isBgLaunchToolUse(ev.name, ev.input)) {
            bgLaunchesRef.current.set(ev.id, {
              command: typeof ev.input?.command === 'string' ? ev.input.command : null,
              description: typeof ev.input?.description === 'string' ? ev.input.description : null,
            });
          }
          setMessages((prev) => reduceRowIdRename(prev, ev));
          // Same id space as the rebuild (the SDK id): a replayed call is
          // not counted twice.
          setToolCalls((prev) => prev.some((c) => c.id === ev.id) ? prev : [...prev, {
            id: ev.id, name: ev.name, input: ev.input,
            startedAt: Math.floor(Date.now() / 1000),
          }]);
          if (filePath) {
            setFiles((prev) => new Set(prev).add(filePath));
          }
          break;
        }
        case 'tool_result':
          // `rowId`: the `tr-live-<sdkId>` row its progress built becomes
          // `m<rowId>` (transcriptReducer § reduceRowIdRename).
          setMessages((prev) => reduceRowIdRename(prev, ev));
          setToolCalls((prev) => prev.map((c) => c.id === ev.tool_use_id
            ? { ...c, result: { content: ev.content, isError: !!ev.is_error } } : c));
          break;
        case 'tool_progress':
          setMessages((prev) => {
            const id = 'tr-live-' + ev.tool_use_id;
            const idx = prev.findIndex((m) => m.id === id);
            let content = ev.delta;
            if (idx >= 0) {
              try { content = String(JSON.parse(prev[idx].content).content ?? '') + ev.delta; } catch {}
            }
            // Bound the browser buffer; the final aggregate replaces it.
            content = content.slice(-256 * 1024);
            const row = { id, role: 'tool_result', content: JSON.stringify({
              type: 'tool_result', tool_use_id: ev.tool_use_id, content, is_error: false,
            }), createdAt: Math.floor(Date.now() / 1000) };
            return idx < 0 ? [...prev, row] : prev.map((m, i) => i === idx ? row : m);
          });
          break;
        case 'edit_progress': {
          const key = ev.file_path;
          setEdits((prev) => {
            const next = new Map(prev);
            next.set(key, { toolUseId: ev.tool_use_id, filePath: key,
              before: null, after: ev.diff, truncated: !!ev.truncated });
            return next;
          });
          setFiles((prev) => new Set(prev).add(key));
          break;
        }
        case 'plan_progress':
        case 'plan_update':
          legacyBoundary();
          setMessages((prev) => {
            const id = `plan:${ev.id}`;
            const row = { id, role: 'plan', content: JSON.stringify({
              ...ev, partial: ev.type === 'plan_progress',
            }),
              createdAt: Math.floor(Date.now() / 1000) };
            const idx = prev.findIndex((m) => m.id === id);
            return idx < 0 ? [...prev, row] : prev.map((m, i) => i === idx ? row : m);
          });
          break;
        case 'tool_activity':
          if (ev.kind === 'filesystem') publishFsChanged(vpsIdRef.current, (ev.detail as any)?.paths);
          // Status/MCP/hook/fs invalidations are control-plane signals. Keep
          // their side effects, but never turn raw protocol JSON into chat.
          break;
        case 'stop': {
          legacyBoundary();
          // Closes the reasoning bubble and marks `m<finalAssistantId>` final
          // (the optimistic `a…` fallback only without hub boundaries).
          const hubBoundaries = hubBoundariesRef.current;
          setMessages((prev) => reduceStop(prev, ev, { hubBoundaries }));
          if (ev.finalAssistantId != null) {
            finalizedAssistantIdsRef.current.add(ev.finalAssistantId);
            // Finalization updates an existing row: the ?since=id poll only
            // notices inserts, so fetch the authoritative stored flag now.
            cache?.invalidate?.(sessionId);
            void refetchHistory();
          }
          break;
        }
        case 'bg_task':
          // Background-task lifecycle (started / updated / finished) — patch
          // the registry and re-project the sorted array for the bar.
          bgRevisionRef.current += 1;
          if (applyBgTaskEvent(bgTasksRef.current, ev, Math.floor(Date.now() / 1000), bgLaunchesRef.current)) {
            setBgTasks(bgTasksToArray(bgTasksRef.current));
          }
          break;
        case 'bg_tasks_snapshot': {
          // The full-history ACTIVE set of a registry that finished warming
          // after a window answer could not give it (backgroundTasksPending).
          bgPendingRef.current = false;
          bgRevisionRef.current += 1;
          const next = reconcileAuthoritativeBgTasks(bgTasksToArray(bgTasksRef.current), ev.tasks as BgTask[]);
          bgTasksRef.current = new Map(next.map((t) => [t.taskId, { ...t }]));
          setBgTasks(next);
          break;
        }
        case 'bg_task_progress':
          // Transient live progress (§14.54): usage + a Workflow run's
          // per-sub-agent fan-out. Not persisted (absent after a refetch of a
          // finished task) — patch the live registry in place.
          if (applyBgTaskProgress(bgTasksRef.current, ev, Math.floor(Date.now() / 1000))) {
            setBgTasks(bgTasksToArray(bgTasksRef.current));
          }
          break;
        case 'error':
          setMessages(closeThinkingMessage);
          setError({ msg: ev.msg });
          break;
        case 'blocking_error':
          // The raw `error` event may have painted a transient banner a moment
          // earlier. This durable chat row is now the authoritative surface;
          // keep one error, not a banner plus the same message underneath.
          setError(null);
          setMessages((prev) => {
            const id = ev.messageId ? `m${ev.messageId}` : 'e' + Date.now() + Math.random();
            const next = { id, role: 'error', content: JSON.stringify(ev.error), createdAt: ev.createdAt };
            const idx = prev.findIndex((m) => m.id === id);
            return idx < 0 ? [...prev, next] : prev.map((m, i) => i === idx ? next : m);
          });
          break;
        case 'scheduled_resume':
          setMessages((prev) => {
            const id = `m${ev.messageId}`;
            const next = { id, role: 'scheduled_resume', content: ev.content, createdAt: ev.createdAt };
            const idx = prev.findIndex((m) => m.id === id);
            return idx < 0 ? [...prev, next] : prev.map((m, i) => i === idx ? next : m);
          });
          break;
        case 'permission_request':
          legacyBoundary();
          journal(ev.id, 'added');
          setPermQueue((q) => q.some((p) => p.id === ev.id) ? q : [...q, {
            id: ev.id, sessionId, tool: ev.tool, input: ev.input,
            createdAt: Math.floor(Date.now() / 1000),
            expiresAt: ev.expiresAt,
          }]);
          break;
        case 'user_question':
          legacyBoundary(ev);
          journal(ev.id, 'added');
          if (ev.delivery === 'async' && !ev.snapshot) {
            setMessages((prev) => prev.some((m) => m.id === `question:${ev.id}`) ? prev : [...prev, {
              id: `question:${ev.id}`, role: 'async_question',
              content: JSON.stringify({ id: ev.id, questions: ev.questions, status: 'pending' }),
              createdAt: ev.createdAt ?? Math.floor(Date.now() / 1000),
            }]);
          }
          setQuestionQueue((q) => q.some((p) => p.id === ev.id) ? q : [...q, {
            id: ev.id, sessionId, questions: ev.questions,
            createdAt: ev.createdAt ?? Math.floor(Date.now() / 1000),
            expiresAt: ev.expiresAt,
            delivery: ev.delivery,
          }]);
          break;
        case 'exit_plan_request':
          legacyBoundary();
          journal(ev.id, 'added');
          setExitPlanQueue((q) => q.some((p) => p.id === ev.id) ? q : [...q, {
            id: ev.id, sessionId, plan: ev.plan ?? '',
            createdAt: Math.floor(Date.now() / 1000),
            expiresAt: ev.expiresAt,
          }]);
          break;
        case 'interaction_resolved':
          journal(ev.id, 'resolved');
          if (ev.kind === 'question') {
            setMessages((prev) => resolveAsyncQuestionMessages(prev, ev.id, ev.outcome ?? 'answered', ev.answers));
          }
          if (ev.kind === 'permission') setPermQueue((q) => q.filter((p) => p.id !== ev.id));
          else if (ev.kind === 'question') setQuestionQueue((q) => q.filter((p) => p.id !== ev.id));
          else if (ev.kind === 'exit_plan') setExitPlanQueue((q) => q.filter((p) => p.id !== ev.id));
          if (ev.outcome === 'expired') {
            setError({
              msg: ev.kind === 'permission'
                ? 'Approval timed out and was automatically denied.'
                : 'The pending question timed out without an answer.',
            });
          }
          break;
        case 'prefill_input':
          setPrefillInput(ev.content || 'continue');
          break;
        case 'reconnecting':
          setError(null);
          break;
        case 'edit_snapshot': {
          const key = ev.file_path;
          setEdits((prev) => {
            const next = new Map(prev);
            const cur = prev.get(key) ?? { toolUseId: ev.tool_use_id, filePath: key, before: null, after: null, truncated: false };
            if (ev.phase === 'before') {
              next.set(key, { ...cur, before: ev.content, truncated: cur.truncated || ev.truncated });
            } else {
              // Codex emits phase 'diff' with the unified diff in `diff`
              // (content null); Claude uses phase 'after' with content. Either
              // lands in `after` — the ToolPanel renders it as a raw patch for
              // codex sessions. cf. CLAUDE.md §14.59.
              const after = ev.content ?? (ev as { diff?: string | null }).diff ?? null;
              next.set(key, { ...cur, after, truncated: cur.truncated || ev.truncated });
            }
            return next;
          });
          setFiles((prev) => new Set(prev).add(key));
          break;
        }
        case 'thinking':
          legacyBoundary();
          if (PROVIDERS[providerRef.current].thinkingDelivery === 'delta') {
            // Streamed fragment: batched, joined to the open bubble on commit.
            thinkingLaneDelta(thinkingLaneRef.current, ev.text);
            scheduleThinkingCommit();
            break;
          }
          // A complete block (Claude): its own bubble, at once — `m<rowId>`
          // when the hub names its row (a replayed block is not shown twice).
          setMessages((prev) => ev.rowId != null && prev.some((m) => m.id === `m${ev.rowId}`)
            ? prev
            : appendThinkingMessage(prev, {
              id: ev.rowId != null ? `m${ev.rowId}` : 'th' + Date.now() + Math.random(), role: 'thinking',
              content: ev.text, createdAt: Math.floor(Date.now() / 1000),
            }));
          break;
        case 'thinking_flushed': {
          // The hub cut the open reasoning block into row `rowId` (§14.17):
          // the bubble keeps going under the rebuild's id (thinkingMessages.ts).
          setMessages(thinkingLaneFlushed(thinkingLaneRef.current, ev));
          break;
        }
        case 'thinking_reopened':
          // A replay rebuilds the hub's open block from its anchor: what this
          // browser got of it live is dropped first (thinkingMessages.ts).
          setMessages(thinkingLaneReopened(thinkingLaneRef.current));
          break;
        case 'compaction':
          // Flush first: the marker must land AFTER the text it follows, or a
          // buffered delta would sort below the boundary and read as "the
          // model still remembered this".
          legacyBoundary();
          setMessages((prev) => upsertMessage(prev, {
            id: ev.rowId != null ? `m${ev.rowId}` : 'cp' + Date.now() + Math.random(), role: 'compaction',
            content: typeof ev.trigger === 'string' ? ev.trigger : '',
            createdAt: Math.floor(Date.now() / 1000),
          }));
          break;
        case 'structured_output': {
          legacyBoundary();
          const structuredJson = JSON.stringify(ev.value, null, 2);
          setMessages((prev) => upsertMessage(prev, {
            id: ev.rowId != null ? `m${ev.rowId}` : 'so' + Date.now() + Math.random(), role: 'structured',
            content: `${ev.truncated ? '_Output truncated by the 512 KiB safety limit._\n\n' : ''}\`\`\`json\n${structuredJson}\n\`\`\``,
            createdAt: Math.floor(Date.now() / 1000),
          }));
          break;
        }
        case 'external_message':
          legacyBoundary();
          setMessages((prev) => upsertMessage(prev, {
            id: ev.rowId != null ? `m${ev.rowId}` : 'ex' + Date.now() + Math.random(), role: 'external',
            content: ev.text, createdAt: Math.floor(Date.now() / 1000),
            from: (ev as { from?: string }).from ?? null,
            fromProvider: (ev as { fromProvider?: SessionProvider }).fromProvider ?? null,
            sourceSessionId: (ev as { sourceSessionId?: string }).sourceSessionId ?? null,
            origin: ev.origin,
            expectsReply: ev.expectsReply ?? null,
            messageId: (ev as { messageId?: string }).messageId ?? null,
            conversationId: (ev as { conversationId?: string }).conversationId ?? null,
            replyTo: (ev as { replyTo?: string }).replyTo ?? null,
          }));
          break;
        case 'peer_message_status':
          legacyBoundary();
          setMessages((prev) => {
            const message: Msg = {
              id: `peer:${ev.messageId}`, role: 'peer_status',
              content: ev.text ?? '', createdAt: Math.floor(Date.now() / 1000),
              messageId: ev.messageId,
              conversationId: ev.conversationId,
              peerStatus: ev.status,
              peerTarget: ev.target ?? null,
              peerTargetSessionId: ev.targetSessionId ?? null,
              peerError: ev.error ?? null,
              fromProvider: ev.targetProvider ?? null,
            };
            const idx = prev.findIndex((m) => m.id === message.id);
            if (idx < 0) return [...prev, message];
            const next = [...prev];
            next[idx] = { ...next[idx], ...message };
            return next;
          });
          break;
        case 'mode_changed':
          setPermissionMode(ev.mode);
          break;
        case 'model_changed':
          setModelState(ev.model ?? null);
          setFallbackModelState(ev.fallbackModel ?? null);
          // appliedAtNextStart=true means a live SDK client exists and the
          // change is queued. The next sleep+resume cycle clears the flag
          // (applyApiData resets it on full reload).
          setModelPendingApply(!!ev.appliedAtNextStart);
          break;
        case 'effort_changed': {
          // The backend already filtered invalid strings (Claude AND Codex
          // catalogs), so pass the value through as a free string. Codex sends
          // appliedAtNextStart=false → no deferred badge.
          const e = (ev.effort as string | null) || null;
          setEffortState(e);
          setEffortPendingApply(!!ev.appliedAtNextStart);
          break;
        }
        case 'effective_model':
          // What Anthropic actually used this turn. Always trustworthy
          // (extracted from AssistantMessage.model). Display in the badge
          // when it differs from the configured `model` field.
          if (typeof ev.model === 'string' && ev.model.length > 0) {
            // Mirror the server: text buffered BEFORE a mid-turn model switch
            // (fallback kicking in) was produced by the PREVIOUS model —
            // finalize it under the old label before adopting the new one.
            if (effectiveModelRef.current && effectiveModelRef.current !== ev.model) {
              legacyBoundary();
            }
            effectiveModelRef.current = ev.model;
            setEffectiveModel(ev.model);
          }
          break;
        case 'session_token_usage':
          setTokenUsage((prev) => mergeSessionTokenUsage(prev, ev.usage));
          break;
        case 'usage':
          if (ev.final) setMessages(closeThinkingMessage);
          // Transient current-turn usage (§14.50); `final` also carries the
          // post-turn duration and cost.
          setLiveUsage({
            output: ev.output_tokens,
            input: ev.input_tokens,
            final: ev.final,
            durationMs: ev.duration_ms,
            costUsd: ev.cost_usd,
          });
          break;
        default: break;
      }
    };

    // Wire the handler to the global stream for this sessionId. The singleton
    // module guarantees we only pay for ONE EventSource for the whole browser.
    const unsubscribe = subscribeSession(sessionId, handleEvent);

    return () => {
      if (assistantFlushTimerRef.current != null) {
        clearTimeout(assistantFlushTimerRef.current);
        assistantFlushTimerRef.current = null;
      }
      if (thinkingFlushTimerRef.current != null) {
        clearTimeout(thinkingFlushTimerRef.current);
        thinkingFlushTimerRef.current = null;
      }
      // The re-run's refetch shows the open block again (streamingThinking).
      thinkingLaneRef.current.batch = '';
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, streamKey, refetchHistory]);

  // Refetch on SSE reconnect (= the EventSource connection was
  // re-established after a drop, typically after a `systemctl restart
  // charon`). The SSE itself is live-only on the Charon side — messages
  // persisted in the DB during the gap are never relayed. Without this
  // refetch, the UI stays frozen on the last pre-drop state, the user
  // had to refresh by hand (cf. CLAUDE.md §14 gotcha 24).
  useEffect(() => {
    const unsub = subscribeReconnect(() => {
      resetResponseSpeed();
      // One coalesced catch-up path. forcePoll aborts a stale request; the
      // delta response carries the live envelope and escalates to one clean
      // reload only when persisted rows actually changed.
      forcePoll(true);
    });
    return () => unsub();
  }, [forcePoll, resetResponseSpeed]);

  // ── Polling safety-net loop ────────────────────────────────────────────
  // Always-on: every 5s the hook polls the server for any messages with
  // id > lastSeenServerId. Independent of the SSE — if everything else
  // fails (SSE dead, subscribeReconnect listeners torn down, React
  // hydration error wreaking havoc), this loop alone keeps the chat in
  // sync within 5s. The poll is cheap (typically returns 0 messages); a
  // full clean refetch only runs when the `?since=` probe reports new rows.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    // First tick fires immediately after mount (not 5s later) so resync
    // happens on session switch / tab return without waiting for the
    // first interval. safetyTick is self-sufficient (full refetch when the
    // cursor isn't set yet, delta otherwise).
    safetyTick();
    const id = setInterval(() => safetyTick(), 5_000);
    return () => {
      clearInterval(id);
      pollAbortRef.current?.abort();
    };
  }, [safetyTick]);

  // ── Auto-load stripped diff content (CLAUDE.md §14 gotcha 41) ────────────
  // The session GET strips edit_snapshot content, so a full reload leaves the
  // edits Map with content-less skeleton entries (before == after == null).
  // Whenever such entries appear, fetch their content from /edits. The
  // `attempted` set bounds this to one fetch per file (no infinite retry on
  // budget-dropped / empty snapshots). Live edit_snapshot SSE events already
  // carry content, so they never enter this path.
  // Waits for `historyReady`: diff contents can weigh hundreds of KB, and on a
  // slow link they would share it with the transcript the user opened.
  useEffect(() => {
    if (!historyReady) return;
    const unloaded: string[] = [];
    for (const [k, v] of edits) {
      if (v.before == null && v.after == null && !editsLoadAttemptedRef.current.has(k)) {
        unloaded.push(k);
      }
    }
    if (unloaded.length === 0) return;
    loadEdits(unloaded);
  }, [edits, loadEdits, historyReady]);

  // Immediate catch-up poll on tab focus / network online — don't wait
  // 5s after the user obviously expects the latest state. Use forcePoll
  // (not pollDelta) so a request that hung while the device slept is
  // aborted and replaced immediately rather than blocking the inflight
  // guard until its 12s timeout.
  //
  // The `window` 'focus' listener is what fixes the notification-click case:
  // clicking a web-push notification calls `client.focus()` in the service
  // worker, which refocuses the browser WINDOW. If the Charon tab was
  // already the active tab (just the window was unfocused — second monitor,
  // another app on top), `visibilityState` never left 'visible', so
  // `visibilitychange` does NOT fire and nothing refetched — the pending
  // question (which arrived live while we weren't looking, or was missed by
  // a throttled SSE) stayed invisible until a manual refresh. 'focus' fires
  // in that case and force-polls, pulling the pending interaction from the DB.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Back from hidden / offline is a real gap → syncing cue. A bare window
    // focus is not (the page stayed visible and live), so it probes quietly.
    const onVisibility = () => {
      resetResponseSpeed();
      if (document.visibilityState === 'visible') forcePoll(true);
    };
    const onOnline = () => { resetResponseSpeed(); forcePoll(true); };
    const onFocus = () => forcePoll();
    // Explicit signal: a notification was clicked targeting a session.
    // ClaudePanel dispatches this on the SW `open-session` message. If it's
    // for THIS session, force an immediate resync (covers the case where the
    // hook was already mounted for this session but missed the live SSE
    // event — e.g. the window was focused the whole time so neither 'focus'
    // nor 'visibilitychange' fired).
    const onNotifOpen = (e: Event) => {
      const sid = (e as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
      if (!sid || sid === sessionId) forcePoll(true);
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    window.addEventListener('focus', onFocus);
    window.addEventListener('charon:notif-open', onNotifOpen as EventListener);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('charon:notif-open', onNotifOpen as EventListener);
    };
  }, [forcePoll, sessionId, resetResponseSpeed]);

  // ── Actions ────────────────────────────────────────────────────────────
  const send = useCallback(async (content: string) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    // Optimistic UI: render the user's bubble + flip the status pill to
    // 'thinking' immediately, instead of waiting for the user_echo / status
    // SSE to round-trip through the remote VPS agent. The bubble is
    // `u-<clientMessageId>`; that id rides the POST (the agent's idempotency
    // key) and comes back on `user_echo` and in the response's `rowId`:
    // whichever arrives first renames the bubble `m<rowId>` in place
    // (transcriptReducer.ts), so a refetch never remounts it.
    //
    // On failure we intentionally keep the bubble + entry: the dominant
    // failure (the agent RPC throwing) happens AFTER the server has already
    // persisted the row and broadcast the echo, so the message IS real. A
    // genuinely-unsent phantom self-heals on the next full refetch
    // (applyApiData replaces wholesale from the DB). cf. CLAUDE.md §14 gotcha 24.
    const clientMessageId = newClientMessageId();
    const added = addOptimisticSend([], sendsRef.current, clientMessageId, trimmed, Math.floor(Date.now() / 1000));
    sendsRef.current = added.sends;
    const bubble = added.messages[0];
    setMessages((prev) => [...prev, bubble]);
    setStatus('thinking');
    lastOptimisticStatusTsRef.current = Date.now();  // guard the poll reconcile (RC2)
    setLiveUsage(null);  // new turn → reset the live token counter (§14.50)
    resetResponseSpeed();
    try {
      const res = await sessionApi.sendInput(sessionId, trimmed, clientMessageId);
      const rowId = typeof res?.rowId === 'number' ? res.rowId : null;
      if (rowId != null) {
        sendsRef.current = reduceSendAck([], sendsRef.current, clientMessageId, rowId).sends;
        setMessages((prev) => reduceSendAck(prev, sendsRef.current, clientMessageId, rowId).messages);
      }
    } catch (e) { setError({ msg: String((e as Error)?.message ?? e) }); }
  }, [sessionId, resetResponseSpeed]);

  const interrupt = useCallback(async () => {
    try { await sessionApi.interrupt(sessionId); }
    catch (e) { setError({ msg: String((e as Error)?.message ?? e) }); }
  }, [sessionId]);

  const forceStop = useCallback(async () => {
    try { await sessionApi.forceStop(sessionId); }
    catch (e) { setError({ msg: String((e as Error)?.message ?? e) }); }
  }, [sessionId]);

  const setMode = useCallback(async (mode: SessionMode) => {
    if (permissionMode === mode) return;
    const prev = permissionMode;
    setPermissionMode(mode); // optimistic — reconciled by the mode_changed SSE
    try { await sessionApi.setMode(sessionId, mode); }
    catch (e) {
      setPermissionMode(prev); // revert: the agent never applied the change
      setError({ msg: String((e as Error)?.message ?? e) });
    }
  }, [sessionId, permissionMode]);

  const setModel = useCallback(async (newModel: string | null, newFallbackModel: string | null = null) => {
    // Idempotency guard: skip the round-trip if both fields already match.
    // (Comparing both prevents a stale fallback from leaking when the user
    // sets only the primary.)
    if (newModel === model && newFallbackModel === fallbackModel) return;
    const prevModel = model;
    const prevFallback = fallbackModel;
    // Optimistic UI — the model_changed SSE will reconcile + set
    // modelPendingApply based on whether a live SDK client exists.
    setModelState(newModel);
    setFallbackModelState(newFallbackModel);
    try {
      await sessionApi.setModel(sessionId, newModel, newFallbackModel);
    } catch (e) {
      setModelState(prevModel);
      setFallbackModelState(prevFallback);
      setError({ msg: String((e as Error)?.message ?? e) });
    }
  }, [sessionId, model, fallbackModel]);

  const setEffort = useCallback(async (newEffort: string | null) => {
    // A pending endpoint selection may differ from the persisted effort; even
    // choosing the persisted value must reach the server to replace that queue.
    const prev = effort;
    setEffortState(newEffort);
    try {
      await sessionApi.setEffort(sessionId, newEffort);
    } catch (e) {
      setEffortState(prev);
      setError({ msg: String((e as Error)?.message ?? e) });
      throw e;
    }
  }, [sessionId, effort]);

  const doSleep = useCallback(async () => {
    // Optimistic: the server marks the DB row 'sleeping' unconditionally
    // (even if the agent is unreachable — cf. sessionOps.sleepSession), so
    // flipping the pill now is always correct and saves the up-to-5s wait
    // for the agent's SDK teardown (session.py stop() awaits the in-flight
    // turn before the RPC returns).
    setStatus('sleeping');
    lastOptimisticStatusTsRef.current = Date.now();  // guard the poll reconcile (RC2)
    try {
      await sessionApi.sleep(sessionId);
    } catch (e) {
      setError({ msg: String((e as Error)?.message ?? e) });
    }
  }, [sessionId]);

  const doResume = useCallback(async () => {
    setError(null);
    setStatus('starting');
    lastOptimisticStatusTsRef.current = Date.now();  // guard the poll reconcile (RC2)
    try {
      await sessionApi.resume(sessionId);
      // Bump streamKey → useEffect closes the old SSE, reloads history,
      // re-attaches handlers. Avoids the UI being stuck on the post-sleep
      // state while the session has restarted on the agent side.
      setStreamKey((k) => k + 1);
    } catch (e) {
      setStatus('sleeping');
      setError({ msg: String((e as Error)?.message ?? e) });
    }
  }, [sessionId]);

  // In-place SDK restart (awaited sleep + resume server-side) — the "apply
  // now" ↻ button next to the pending model/effort badge. The POST returns
  // once the fresh SDK client is up, so the deferred config is applied by
  // the time we clear the ⏳ flags (the refetch after streamKey confirms).
  const doRestart = useCallback(async () => {
    setError(null);
    setStatus('starting');
    lastOptimisticStatusTsRef.current = Date.now();  // guard the poll reconcile (RC2)
    try {
      await sessionApi.restart(sessionId);
      setModelPendingApply(false);
      setEffortPendingApply(false);
      setStreamKey((k) => k + 1);
    } catch (e) {
      // Sleep may have landed while resume failed → 'sleeping' is the safe
      // assumption; the 5s poll reconciles the real status either way.
      setStatus('sleeping');
      setError({ msg: String((e as Error)?.message ?? e) });
    }
  }, [sessionId]);

  // Permanent deletion (DB cascade on the server side). The `onKilled` callback
  // is kept as-is for post-deletion navigation (back to the session list).
  // No confirm() here — it's up to the caller to ask for confirmation before
  // calling the action.
  const doDelete = useCallback(async () => {
    try {
      await sessionApi.remove(sessionId);
      onKilledRef.current?.();
    } catch (e) {
      setError({ msg: String((e as Error)?.message ?? e) });
    }
  }, [sessionId]);

  // Pessimistic acks: we wait for the POST OK before removing the card from
  // the queue. Before, it was optimistic — if the POST failed, the card
  // disappeared but the backend had recorded nothing; on reload it would
  // reappear and the user thought history was broken. Now: POST OK → the
  // queue empties via the `interaction_resolved` event that comes back in
  // SSE (or at worst at the next refetch). POST KO → the card stays, error
  // shown.
  // An answered gate is gone for good: a pending snapshot requested before the
  // answer must not bring it back (pendingQueueMerge.ts). Journaled half a
  // revision up — after the requests already in flight, without counting as
  // a live event (which would drop an in-flight GET).
  const journalLocalResolution = useCallback((id: string) => {
    gateJournalRef.current = journalGate(gateJournalRef.current,
      { rev: liveEventRevisionRef.current + 0.5, id, op: 'resolved' });
  }, []);

  const respondPermission = useCallback(async (permId: string, allow: boolean, always = false) => {
    try {
      await sessionApi.respondPermission(sessionId, permId, allow, always);
      journalLocalResolution(permId);
      // Removal arrives via `interaction_resolved` SSE. Fallback in case the
      // SSE is down: we remove locally (and the server won't send back anything
      // we don't already treat as a no-op via the filter by id).
      setPermQueue((q) => q.filter((p) => p.id !== permId));
    } catch (e) { setError({ msg: String((e as Error)?.message ?? e) }); }
  }, [sessionId, journalLocalResolution]);

  const respondQuestion = useCallback(async (qid: string, answers: Record<string, string> | null) => {
    try {
      await sessionApi.respondQuestion(sessionId, qid, answers);
      journalLocalResolution(qid);
      setQuestionQueue((q) => q.filter((p) => p.id !== qid));
      setMessages((prev) => resolveAsyncQuestionMessages(prev, qid, answers ? 'answered' : 'cancelled', answers));
    } catch (e) { setError({ msg: String((e as Error)?.message ?? e) }); throw e; }
  }, [sessionId, journalLocalResolution]);

  const respondExitPlan = useCallback(async (qid: string, decision: 'approve' | 'reject', feedback?: string) => {
    try {
      await sessionApi.respondExitPlan(sessionId, qid, decision, feedback);
      journalLocalResolution(qid);
      setExitPlanQueue((q) => q.filter((p) => p.id !== qid));
    } catch (e) { setError({ msg: String((e as Error)?.message ?? e) }); }
  }, [sessionId, journalLocalResolution]);

  const clearPrefillInput = useCallback(() => setPrefillInput(null), []);
  const clearError = useCallback(() => setError(null), []);

  return useMemo(() => ({
    sessionMeta, messages, currentAssistant, streamingInto, status, permissionMode,
    model, fallbackModel, effort, modelPendingApply, effortPendingApply,
    effectiveModel, liveUsage, tokenUsage, responseSpeed,
    toolCalls, edits, files, bgTasks,
    permQueue, questionQueue, exitPlanQueue,
    prefillInput, error, isLoadingHistory, isSyncing, historyReady,
    hasMore, isLoadingMore,
    send, interrupt, forceStop, setMode, setModel, setEffort,
    doSleep, doResume, doRestart, doDelete,
    respondPermission, respondQuestion, respondExitPlan,
    clearPrefillInput, refetchHistory, loadMoreHistory, setHistoryHold, clearError,
  }), [
    sessionMeta, messages, currentAssistant, streamingInto, status, permissionMode,
    model, fallbackModel, effort, modelPendingApply, effortPendingApply,
    effectiveModel, liveUsage, tokenUsage, responseSpeed,
    toolCalls, edits, files, bgTasks,
    permQueue, questionQueue, exitPlanQueue,
    prefillInput, error, isLoadingHistory, isSyncing, historyReady,
    hasMore, isLoadingMore,
    send, interrupt, forceStop, setMode, setModel, setEffort,
    doSleep, doResume, doRestart, doDelete,
    respondPermission, respondQuestion, respondExitPlan,
    clearPrefillInput, refetchHistory, loadMoreHistory, setHistoryHold, clearError,
  ]);
}

// Canonical names for shared Claude/Codex consumers. Keep the historical
// exports above so extensions can migrate without a flag day.
export type AgentSessionStreamState = ClaudeSessionStreamState;
export type AgentSessionStreamActions = ClaudeSessionStreamActions;
export const useAgentSessionStream = useClaudeSessionStream;
