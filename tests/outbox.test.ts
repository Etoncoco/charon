import { afterEach, describe, expect, it } from 'vitest';
import {
  createOutbox, outboxTotalBytes, OUTBOX_GLOBAL_MAX, OUTBOX_LIVE_MAX, RESUME_MAX_BYTES, type Outbox,
} from '@/lib/server/sync/outbox';

// The per-connection SSE outbox (sync refonte C12, G9): pull-driven,
// non-re-entrant, closes (never drops) on overflow.

const enc = new TextEncoder();
const opened: Outbox[] = [];

afterEach(() => {
  for (const o of opened.splice(0)) o.dispose();
});

/** A real web ReadableStream wired like the events route (pull → drain). */
function stream(hwm: number) {
  const closes: string[] = [];
  let box!: Outbox;
  const rs = new ReadableStream<Uint8Array>({
    start(controller) {
      box = createOutbox(controller, (reason) => {
        closes.push(reason);
        try { controller.close(); } catch { /* closed */ }
      });
      opened.push(box);
    },
    pull() { box.drain(); },
  }, new ByteLengthQueuingStrategy({ highWaterMark: hwm }));
  return { rs, box: () => box, closes };
}

async function readAll(rs: ReadableStream<Uint8Array>, until: (text: string) => boolean): Promise<string> {
  const reader = rs.getReader();
  const dec = new TextDecoder();
  let text = '';
  while (!until(text)) {
    const r = await reader.read();
    if (r.done) break;
    text += dec.decode(r.value, { stream: true });
  }
  reader.releaseLock();
  return text;
}

describe('outbox ordering under backpressure (re-entrancy)', () => {
  it('N lines through a small-HWM stream arrive in exact order with no duplicate', async () => {
    const { rs, box } = stream(64);
    const N = 2000;
    // Pushed while nobody reads: most of it waits in the outbox.
    for (let i = 0; i < N / 2; i++) box().push(enc.encode(`l${i}\n`));
    box().markLive();
    const reading = readAll(rs, (t) => t.includes(`l${N - 1}\n`));
    // More arrive while the consumer pulls (enqueue → synchronous pull).
    for (let i = N / 2; i < N; i++) {
      box().push(enc.encode(`l${i}\n`));
      if (i % 97 === 0) await Promise.resolve();
    }
    const text = await reading;
    expect(text.split('\n').filter(Boolean)).toEqual(Array.from({ length: N }, (_, i) => `l${i}`));
    expect(box().queuedBytes()).toBe(0);
  });

  it('a nested drain from inside enqueue() (Node pull re-entry) never reorders', () => {
    const seen: string[] = [];
    const dec = new TextDecoder();
    let box!: Outbox;
    let desired = 3;
    let depth = 0;
    let maxDepth = 0;
    // A controller that, like Node webstreams, calls back into drain (its
    // `pull`) while enqueue is still on the stack. Without the guard every
    // chunk nests one level deeper (a stack as deep as the backlog).
    const ctrl = {
      get desiredSize() { return desired; },
      enqueue(c: Uint8Array) {
        seen.push(dec.decode(c));
        desired--;
        depth++;
        maxDepth = Math.max(maxDepth, depth);
        box.drain();
        depth--;
      },
      close() {}, error() {},
    } as unknown as ReadableStreamDefaultController<Uint8Array>;
    box = createOutbox(ctrl, () => {});
    opened.push(box);
    for (const s of ['a', 'b', 'c', 'd', 'e']) box.push(enc.encode(s));
    expect(seen).toEqual(['a', 'b', 'c']);
    desired = 10;
    box.drain();
    expect(seen).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(maxDepth).toBe(1);
  });
});

describe('outbox bounds', () => {
  const chunk = new Uint8Array(256 << 10);   // one shared chunk, pushed many times (like bus frames)

  it('live overflow beyond the initial replay closes the conn (outbox)', () => {
    const { box, closes } = stream(512 << 10);
    box().markLive();
    let pushed = 0;
    while (!closes.length && pushed < 100) { box().push(chunk); pushed++; }
    expect(closes).toEqual(['outbox']);
    // HWM (512 KiB) in the stream + > OUTBOX_LIVE_MAX queued here.
    expect(pushed * chunk.byteLength).toBeGreaterThan(OUTBOX_LIVE_MAX);
    expect(pushed * chunk.byteLength).toBeLessThanOrEqual(OUTBOX_LIVE_MAX + (512 << 10) + 2 * chunk.byteLength);
    expect(box().queuedBytes()).toBe(0);     // disposed
  });

  it('a 12 MiB resume (pushed before markLive) does not close; live bytes then count beyond what is left of it', () => {
    const { box, closes } = stream(512 << 10);
    const resume = (12 << 20) / chunk.byteLength;
    for (let i = 0; i < resume; i++) box().push(chunk);
    expect(12 << 20).toBeLessThan(RESUME_MAX_BYTES);
    box().markLive();
    expect(closes).toEqual([]);
    // Up to OUTBOX_LIVE_MAX of live frames on top of the unread resume: still open.
    for (let i = 0; i < OUTBOX_LIVE_MAX / chunk.byteLength; i++) box().push(chunk);
    expect(closes).toEqual([]);
    box().push(chunk);
    expect(closes).toEqual(['outbox']);
  });

  it('the process-wide budget closes the conn with the LARGEST queue', () => {
    const a = stream(1024);
    const b = stream(1024);
    const c = stream(1024);
    // Initial (non-live) queues: never closed by the per-conn bound.
    for (let i = 0; i < (20 << 20) / chunk.byteLength; i++) a.box().push(chunk);
    for (let i = 0; i < (30 << 20) / chunk.byteLength; i++) b.box().push(chunk);
    expect(outboxTotalBytes()).toBeGreaterThan(49 << 20);   // minus the one chunk each stream holds
    let n = 0;
    while (!b.closes.length && n < 200) { c.box().push(chunk); n++; }
    expect(b.closes).toEqual(['outbox-global']);
    expect(a.closes).toEqual([]);
    expect(c.closes).toEqual([]);
    expect(outboxTotalBytes()).toBeLessThanOrEqual(OUTBOX_GLOBAL_MAX);
  });

  it('dispose releases the process-wide bytes', () => {
    const before = outboxTotalBytes();
    const { box } = stream(16);
    for (let i = 0; i < 8; i++) box().push(chunk);
    expect(outboxTotalBytes()).toBeGreaterThan(before);
    box().dispose();
    expect(outboxTotalBytes()).toBe(before);
  });
});
