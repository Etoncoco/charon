import 'server-only';
import { foldSessionEventRows } from '@/lib/server/agent/sessionRowCache';
import {
  applyBgTaskEvent, BG_TASK_MAX_AGE_S, bgTasksToArray, isTerminalBgStatus,
  type BgTask,
} from '@/app/bgTasks';

/**
 * "Does this session still have background work running?" — hub-side.
 *
 * There is no bg-task table: the lifecycle is PERSISTED as ordinary `event`
 * rows (`sessionOps § case 'bg_task'`) and the registry is derived from them,
 * client-side by `app/bgTasks.ts` and here for the two server-side readers —
 * the session's own `background` status (§14.91) and the auto-update quiet gate
 * (`sdkWatch § isVpsBusy`). One reducer for both, because the two used to
 * disagree about what "still running" means and the answer decides whether a
 * VPS gets restarted from under a running task.
 */

/** A "running" task older than this counts as gone: a lost `finished` event
 *  would otherwise wedge a session as forever-busy. Re-exported from the
 *  shared client reducer — the cap must be the same number on both sides or
 *  the bar and the session status disagree about what is still running. */
export { BG_TASK_MAX_AGE_S };

/** The terminal-event rule, shared so the two callers cannot drift — and now
 *  sharing its VOCABULARY with `app/bgTasks.ts` too. The word list used to be
 *  duplicated as a regex here, and the copies disagreed: `error`/`timeout`
 *  ended the task client-side but not here (session stuck violet
 *  `background`), and `stop` — the word a stop_task kill reports — ended it
 *  nowhere. `updated` carries a free-form status string from the SDK, hence
 *  matching on the word rather than on an enum. */
export function isBgTaskDone(
  ev: { kind?: unknown; status?: unknown; terminal?: unknown },
): boolean {
  if (ev.kind === 'finished') return true;
  // agent >= 0.36.0 ships the SDK's own verdict on the event. It outranks our
  // word list: that list is a reimplementation of the SDK constant, and the
  // failure it was written about is precisely "a status word we didn't think
  // of". Older agents omit the flag → fall through to the words.
  if (typeof ev.terminal === 'boolean') return ev.kind === 'updated' && ev.terminal;
  return ev.kind === 'updated' && isTerminalBgStatus(ev.status);
}

/** taskId → startedAt (unix seconds), rebuilt from the persisted event rows —
 *  the alternative is a column that can silently disagree with the rows it is
 *  derived from. The full history is read through an incremental row cache
 *  (sessionRowCache.ts): after the first fold only newer rows are read.
 *
 *  bg rows are few but the cold fold SCANS every row of the session (one LIKE
 *  per event row), so two kinds of readers:
 *  - STRICT (the stream's own status decisions, event-time closures): need
 *    the complete registry now — a cold fold runs to its end synchronously
 *    (it finishes a warming one);
 *  - TOLERANT (`…IfWarm`: the window GET, the session list, the auto-update
 *    quiet gate, a codex stream's attach): get null while a cold fold warms
 *    in 20 k-row slices in the background (G1), and answer conservatively. */
type BgTaskRow = { content: string; createdAt: number; seq: number | null; tsMs: number | null };

/** Session rows per synchronous slice of a TOLERANT cold fold. */
export const BG_FOLD_SLICE_ROWS = 20_000;

function bgFold(sessionId: string, sliceRows?: number): { state: BgTaskRow[]; complete: boolean } {
  return foldSessionEventRows<BgTaskRow[]>('bg', sessionId, {
    likes: ['%"bg_task"%'],
    init: () => [],
    clone: (rows) => rows.slice(),
    step: (rows, row) => {
      rows.push({ content: row.content, createdAt: row.createdAt, seq: row.seq, tsMs: row.tsMs });
      return true;
    },
    ...(sliceRows != null ? { sliceRows, onComplete: () => publishBgWarm(sessionId) } : {}),
  });
}

/** A tolerant cold fold finished: a codex stream whose attach found it cold
 *  seeds its checks now (the same completion whoever started the fold). */
function publishBgWarm(sessionId: string): void {
  void import('@/lib/server/agent/sessionOps')
    .then((m) => m.bgRegistryWarmed(sessionId))
    .catch(() => { /* the next attach seeds it */ });
}

/** STRICT: the complete rows (exported for the incremental-equals-full-scan
 *  tests; readers use the reducers below). */
export function bgTaskRowsFromDb(sessionId: string): BgTaskRow[] {
  try { return bgFold(sessionId).state; } catch { return []; }
}

/** TOLERANT: the complete rows, or null while a cold fold warms. A failing
 *  read answers [] like the strict one (a broken registry never blocks). */
export function bgTaskRowsIfWarm(sessionId: string): BgTaskRow[] | null {
  try {
    const { state, complete } = bgFold(sessionId, BG_FOLD_SLICE_ROWS);
    return complete ? state : null;
  } catch { return []; }
}

/** Tasks whose latest recorded activity predates a native snapshot. A replay
 * sees the CURRENT DB registry, which may contain tasks created after that
 * snapshot. Absence from an older snapshot cannot close those tasks (§14.91).
 * Prefer event time across sequence resets, then seq for same-ms/legacy rows.
 * Missing ordering evidence is deliberately not permission to close work. */
export function bgTaskIdsBeforeEventFromDb(
  sessionId: string,
  boundary: { seq: number | null; tsMs: number | null },
): Set<string> {
  const eligible = new Set<string>();
  for (const row of bgTaskRowsFromDb(sessionId)) {
    try {
      const ev = JSON.parse(row.content);
      if (ev?.type !== 'bg_task' || typeof ev.taskId !== 'string') continue;
      let before = false;
      if (boundary.tsMs != null && row.tsMs != null && row.tsMs !== boundary.tsMs) {
        before = row.tsMs < boundary.tsMs;
      } else if (boundary.seq != null && row.seq != null) {
        before = row.seq < boundary.seq;
      } else if (boundary.tsMs != null) {
        // createdAt has only second precision: an equal second is ambiguous.
        before = row.createdAt < Math.floor(boundary.tsMs / 1000);
      }
      if (before) eligible.add(ev.taskId);
      else eligible.delete(ev.taskId);
    } catch { /* malformed lifecycle rows cannot authorize a closure */ }
  }
  return eligible;
}

/** Task kinds that run tools of their own, hence can own a sub-agent command. */
const BG_OWNER_TASK_TYPES = new Set(['local_agent', 'local_workflow', 'in_process_teammate']);

/** The Stop hook's `background_tasks` skips foreground commands, i.e. those a
 * SUB-AGENT runs itself (agent >= 0.98.3 flags them `ownedBySubagent`). Its
 * silence about one proves nothing while a task that could own it is listed
 * alive; once none is, silence means gone again. Returns the tasks a hook
 * listing `alive` must NOT close. Unflagged rows (older agents) stay closable. */
export function bgTasksHiddenFromStopHook(sessionId: string, alive: ReadonlySet<string>): Set<string> {
  const owned = new Set<string>();
  const types = new Map<string, string>();
  for (const row of bgTaskRowsFromDb(sessionId)) {
    try {
      const ev = JSON.parse(row.content);
      if (ev?.type !== 'bg_task' || typeof ev.taskId !== 'string') continue;
      if (typeof ev.taskType === 'string') types.set(ev.taskId, ev.taskType);
      if (ev.ownedBySubagent === true) owned.add(ev.taskId);
    } catch { /* a corrupt row flags nothing */ }
  }
  const ownerAlive = [...alive].some((id) => BG_OWNER_TASK_TYPES.has(types.get(id) ?? ''));
  return ownerAlive ? owned : new Set();
}

function reduceBgTaskRows(rows: BgTaskRow[]): {
  running: Map<string, number>;
  details: Map<string, BgTask>;
} {
  const running = new Map<string, number>(); // taskId → startedAt
  const details = new Map<string, BgTask>();
  for (const r of rows) {
    try {
      const ev = JSON.parse(r.content);
      if (ev?.type !== 'bg_task' || !ev.taskId) continue;
      applyBgTaskEvent(details, ev, r.createdAt);
      const task = details.get(ev.taskId)!;
      if (task.status !== 'running') running.delete(ev.taskId);
      else running.set(ev.taskId, task.startedAt);
    } catch { /* a corrupt row must not blind the whole registry */ }
  }
  return { running, details };
}

/** STRICT (see `bgTaskRowsFromDb`). */
export function runningBgTasksFromDb(sessionId: string): Map<string, number> {
  return reduceBgTaskRows(bgTaskRowsFromDb(sessionId)).running;
}

/** TOLERANT: null while a cold fold warms (the caller answers conservatively). */
export function runningBgTasksIfWarm(sessionId: string): Map<string, number> | null {
  const rows = bgTaskRowsIfWarm(sessionId);
  return rows ? reduceBgTaskRows(rows).running : null;
}

/** Compact ACTIVE-task projection for the session-detail API. Unlike the
 * chat window it scans the complete lifecycle, then applies the same 24h
 * belief cap as the status/quiet-gate reducer. STRICT. */
export function runningBgTaskDetailsFromDb(
  sessionId: string,
  nowS = Math.floor(Date.now() / 1000),
): BgTask[] {
  return bgTaskDetails(bgTaskRowsFromDb(sessionId), nowS);
}

/** TOLERANT `runningBgTaskDetailsFromDb`: null while a cold fold warms (the
 *  window GET then omits it — the client keeps its window's registry). */
export function runningBgTaskDetailsIfWarm(
  sessionId: string,
  nowS = Math.floor(Date.now() / 1000),
): BgTask[] | null {
  const rows = bgTaskRowsIfWarm(sessionId);
  return rows ? bgTaskDetails(rows, nowS) : null;
}

function bgTaskDetails(rows: BgTaskRow[], nowS: number): BgTask[] {
  const { running, details } = reduceBgTaskRows(rows);
  pruneStaleBgTasks(running, nowS);
  const active = new Map<string, BgTask>();
  for (const [taskId, startedAt] of running) {
    const detail = details.get(taskId);
    active.set(taskId, {
      taskId,
      description: detail?.description ?? null,
      command: detail?.command ?? null,
      toolUseId: detail?.toolUseId ?? null,
      taskType: detail?.taskType ?? null,
      status: 'running',
      startedAt,
      endedAt: null,
      outputFile: detail?.outputFile ?? null,
      summary: null,
      workflowName: detail?.workflowName ?? null,
      usage: null,
      lastToolName: null,
      agents: null,
    });
  }
  return bgTasksToArray(active);
}

/** Drop the tasks too old to still be believed. Mutates, and answers whether
 *  anything is left. */
export function pruneStaleBgTasks(running: Map<string, number>, nowS: number): boolean {
  for (const [id, startedAt] of running) {
    if (nowS - startedAt >= BG_TASK_MAX_AGE_S) running.delete(id);
  }
  return running.size > 0;
}
