// What a transcript probe answer means (sync refonte C16, CLAUDE.md §14.24).
// Pure, browser-safe.
//
// The probe (`GET …/sessions/[id]/probe`) is O(1) on the hub and REV-GATED:
// it pushes one heartbeat to this tab's SSE connection before answering, so
// once the SSE has delivered everything ≤ `p.rev`, every frame of this
// session ≤ `p.rev` has been seen by a focused connection. Only then can a
// mismatch be blamed on a lost frame — before, it is just traffic in flight.
// A repair is ONE clean window GET (windowSync.ts), never an incremental
// merge.

import { cmpRev, type SyncRev } from '@/lib/sync/rev';
import type { SessionProbeResponse } from '@/lib/types/api';
import type { WindowReason } from './windowSync';

export type RepairDecision = { action: 'none' } | { action: 'wait'; untilRev: SyncRev }
  | { action: 'window'; reason: WindowReason } | { action: 'reconnect'; reason: string };

/** Two registry heartbeat periods (8 s each, eventConnections.ts): a
 *  connection still behind the probe's revision after that is not merely
 *  slow — the probe pushed it a heartbeat ≥ that revision. */
export const PROBE_LAG_RECONNECT_MS = 16_000;

export function decideRepair(p: SessionProbeResponse, l: {
  inFlight: boolean; epoch: number | null;
  lastRev: SyncRev | null; sessionFrameRev: SyncRev | null; knownRowIds: ReadonlySet<number>;
  knownPendingIds: ReadonlySet<string>; waitingSinceMs: number | null; nowMs: number;
}): RepairDecision {
  // A window GET answers everything the probe could ask, and more.
  if (l.inFlight) return { action: 'none' };
  // No stream position yet (the SSE has not said hello): nothing to compare.
  // The window GET of the mount (or of the coming resync) is the repair.
  if (l.epoch == null) return { action: 'none' };
  // Another hub process: every revision we hold is meaningless.
  if (p.epoch !== l.epoch) return { action: 'window', reason: 'epoch' };
  // Our connection does not carry this session's focused frames.
  if (!p.focused) return { action: 'window', reason: 'unfocused' };
  // The SSE has not delivered up to the probe's revision yet: wait for it
  // (the heartbeat the probe pushed is on its way), unless that has lasted
  // too long — then the connection itself is broken.
  const at: SyncRev = { epoch: p.epoch, rev: p.rev };
  if (cmpRev(l.lastRev, at) < 0) {
    if (l.waitingSinceMs != null && l.nowMs - l.waitingSinceMs >= PROBE_LAG_RECONNECT_MS) {
      return { action: 'reconnect', reason: 'probe-lag' };
    }
    return { action: 'wait', untilRev: at };
  }
  // A frame of this session the hub routed to browsers never reached us.
  const seen = l.sessionFrameRev && l.sessionFrameRev.epoch === p.epoch ? l.sessionFrameRev.rev : 0;
  if (p.sessionRev > seen) return { action: 'window', reason: 'missed-frame' };
  // A rendered row we hold no trace of (frame lost before the bus, or a row
  // written without one).
  if (p.newRowsTruncated || p.newRows.some((id) => !l.knownRowIds.has(id))) {
    return { action: 'window', reason: 'unknown-row' };
  }
  // The gates differ (symmetric: a ghost card or a missing one).
  const pending = new Set(p.pendingIds);
  if (pending.size !== l.knownPendingIds.size || [...pending].some((id) => !l.knownPendingIds.has(id))) {
    return { action: 'window', reason: 'gate' };
  }
  return { action: 'none' };
}
