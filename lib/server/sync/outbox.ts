// Per-connection SSE outbox (CLAUDE.md §14.14/§14.15, sync refonte G9).
// Pure (no DB): the events route owns one per stream.
//
// Pull-driven: frames are queued here and moved into the ReadableStream only
// while its `desiredSize > 0` (ByteLengthQueuingStrategy, HWM 512 KiB), so a
// slow consumer piles up HERE, where it is measured — never in the stream's
// unbounded internal queue. Chunks are the bus's shared, once-encoded
// Uint8Arrays (never copied, never mutated).
//
// ⚠ Non-re-entrant: Node webstreams call `pull()` SYNCHRONOUSLY from inside
// `controller.enqueue()` while `desiredSize > 0`; a nested drain would
// enqueue a later chunk before the one being enqueued returns — wire
// reordering. `draining` turns the nested call into a no-op; the outer loop
// continues in order.
//
// Bounds: the initial replay/snapshot (everything pushed before `markLive()`)
// is exempt; once live, bytes queued BEYOND what is left of it over
// OUTBOX_LIVE_MAX close the connection ('outbox'). The process-wide sum over
// every outbox above OUTBOX_GLOBAL_MAX closes the connection with the largest
// queue ('outbox-global'). A close is never a silent drop: the client
// reconnects with `since` and resumes from the ring (RESUME_MAX_BYTES) or
// resyncs explicitly.

/** Live overflow per conn beyond its initial replay/snapshot. */
export const OUTBOX_LIVE_MAX = 4 << 20;
/** Σ queued bytes, all conns (frames are shared chunks: a pressure metric). */
export const OUTBOX_GLOBAL_MAX = 64 << 20;
/** > OUTBOX_LIVE_MAX so an overflow-closed conn can usually resume. */
export const RESUME_MAX_BYTES = 16 << 20;
/** The stream's own queue (ByteLengthQueuingStrategy highWaterMark). */
export const OUTBOX_HWM = 512 << 10;

export type Outbox = {
  push(chunk: Uint8Array): void;
  /** The initial replay/snapshot is queued: live bounds apply from now on. */
  markLive(): void;
  /** Move queued chunks into the stream while it wants more (the stream's `pull`). */
  drain(): void;
  queuedBytes(): number;
  /** Forget the queue and leave the process-wide budget (stream ended). */
  dispose(): void;
};

type OutboxEntry = { queuedBytes(): number; overflow(): void };
type OutboxRegistry = { boxes: Set<OutboxEntry>; total: number };

// One process-wide object (§14.106): every module copy shares the budget.
function registry(): OutboxRegistry {
  const g = globalThis as unknown as { __charonOutbox?: OutboxRegistry };
  return g.__charonOutbox ??= { boxes: new Set(), total: 0 };
}

/** Σ bytes queued in every outbox (tests, stats). */
export function outboxTotalBytes(): number { return registry().total; }

export function createOutbox(
  ctrl: ReadableStreamDefaultController<Uint8Array>,
  close: (reason: string) => void,
): Outbox {
  const R = registry();
  const q: Uint8Array[] = [];
  let head = 0;
  let qBytes = 0;
  let initialLeft = 0;
  let live = false;
  let draining = false;
  let disposed = false;

  const take = (bytes: number) => {
    qBytes -= bytes;
    R.total -= bytes;
    if (initialLeft > 0) initialLeft = Math.max(0, initialLeft - bytes);
  };

  const drain = () => {
    if (draining || disposed) return;
    draining = true;
    try {
      while (head < q.length && (ctrl.desiredSize ?? 0) > 0) {
        const c = q[head];
        q[head++] = undefined as unknown as Uint8Array;
        take(c.byteLength);
        ctrl.enqueue(c);
      }
      if (head === q.length) { q.length = 0; head = 0; }
      else if (head > 1024) { q.splice(0, head); head = 0; }
    } catch {
      // The stream is gone (closed/errored): the route's close unregisters.
      dispose();
      close('enqueue-failed');
    } finally {
      draining = false;
    }
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    R.total -= qBytes;
    qBytes = 0;
    initialLeft = 0;
    q.length = 0;
    head = 0;
    R.boxes.delete(entry);
  };

  const entry: OutboxEntry = {
    queuedBytes: () => qBytes,
    overflow: () => { dispose(); close('outbox-global'); },
  };
  R.boxes.add(entry);

  const push = (chunk: Uint8Array) => {
    if (disposed) return;
    q.push(chunk);
    qBytes += chunk.byteLength;
    R.total += chunk.byteLength;
    if (live && qBytes - initialLeft > OUTBOX_LIVE_MAX) {
      dispose();
      close('outbox');
      return;
    }
    if (R.total > OUTBOX_GLOBAL_MAX) {
      let largest: OutboxEntry | null = null;
      for (const b of R.boxes) if (!largest || b.queuedBytes() > largest.queuedBytes()) largest = b;
      largest?.overflow();
      if (disposed) return;
    }
    drain();
  };

  return {
    push,
    markLive() {
      if (live) return;
      live = true;
      initialLeft = qBytes;
    },
    drain,
    queuedBytes: () => qBytes,
    dispose,
  };
}
