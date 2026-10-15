// The frames a transcript received while its window GET was in flight (sync
// refonte C16, CLAUDE.md §14.107). Pure, browser-safe, no React.
//
// Every delivered frame is applied live AND, while the journal is active,
// recorded with its bus revision. When the window answer (stamped R) lands,
// the snapshot replaces the transcript state and the frames with rev > R are
// re-dispatched from here (`takeAfter`): nothing received during the request
// is lost, nothing in the snapshot is applied twice.
//
// Bounded (G9): 4000 frames / 4 MiB. The OLDEST frames are evicted first and
// `droppedUpTo` remembers the highest revision lost that way — a snapshot
// older than it cannot be completed from the journal (windowSync then asks
// for another window, reason `overflow`).

import { cmpRev, type SyncRev } from '@/lib/sync/rev';

export const JOURNAL_MAX_FRAMES = 4000;
export const JOURNAL_MAX_BYTES = 4 << 20;

type Entry<E> = { ev: E; rev: SyncRev; bytes: number };

export class TranscriptJournal<E> {
  private readonly maxFrames: number;
  private readonly maxBytes: number;
  private entries: Entry<E>[] = [];
  private head = 0;                 // index of the oldest live entry (amortised shift)
  private bytes = 0;
  private on = false;
  private dropped: SyncRev | null = null;

  constructor(o?: { maxFrames?: number; maxBytes?: number }) {
    this.maxFrames = Math.max(1, o?.maxFrames ?? JOURNAL_MAX_FRAMES);
    this.maxBytes = Math.max(1, o?.maxBytes ?? JOURNAL_MAX_BYTES);
  }

  /** Start recording. Idempotent: an active journal keeps what it holds (it
   *  spans aborted requests and reruns). */
  begin(): void {
    this.on = true;
  }

  /** Stop recording and forget everything (incl. `droppedUpTo`). */
  end(): void {
    this.on = false;
    this.entries = [];
    this.head = 0;
    this.bytes = 0;
    this.dropped = null;
  }

  get active(): boolean {
    return this.on;
  }

  /** The highest revision evicted by the caps since `begin()`, else null. */
  get droppedUpTo(): SyncRev | null {
    return this.dropped;
  }

  /** Frames currently held (tests, diagnostics). */
  get size(): number {
    return this.entries.length - this.head;
  }

  /** Record one delivered frame (no-op while inactive). */
  record(ev: E, rev: SyncRev, bytes: number): void {
    if (!this.on) return;
    const size = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
    this.entries.push({ ev, rev, bytes: size });
    this.bytes += size;
    while (this.size > 0 && (this.size > this.maxFrames || this.bytes > this.maxBytes)) {
      const old = this.entries[this.head++];
      this.bytes -= old.bytes;
      if (cmpRev(old.rev, this.dropped) > 0) this.dropped = old.rev;
    }
    if (this.head > 1024 && this.head * 2 > this.entries.length) {
      this.entries = this.entries.slice(this.head);
      this.head = 0;
    }
  }

  /** The held frames with rev > `rev`, in arrival order. Does NOT clear: a
   *  rerun's later snapshot takes what follows it again. */
  takeAfter(rev: SyncRev): Array<{ ev: E; rev: SyncRev }> {
    const out: Array<{ ev: E; rev: SyncRev }> = [];
    for (let i = this.head; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (cmpRev(e.rev, rev) > 0) out.push({ ev: e.ev, rev: e.rev });
    }
    return out;
  }
}
