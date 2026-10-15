import { describe, expect, it } from 'vitest';
import { decideRepair, PROBE_LAG_RECONNECT_MS } from '@/app/sync/repairPolicy';
import type { SessionProbeResponse } from '@/lib/types/api';

const E = 1_700_000_000_000;
const probe = (o: Partial<SessionProbeResponse> = {}): SessionProbeResponse => ({
  epoch: E, rev: 100, sessionRev: 90, focused: true, maxMessageId: 50,
  newRows: [], newRowsTruncated: false, pendingIds: [], ...o,
});
const local = (o: Partial<Parameters<typeof decideRepair>[1]> = {}): Parameters<typeof decideRepair>[1] => ({
  inFlight: false, epoch: E, lastRev: { epoch: E, rev: 100 }, sessionFrameRev: { epoch: E, rev: 90 },
  knownRowIds: new Set<number>(), knownPendingIds: new Set<string>(), waitingSinceMs: null, nowMs: 1_000_000, ...o,
});

describe('decideRepair', () => {
  it('nothing missing ⇒ none', () => {
    expect(decideRepair(probe(), local())).toEqual({ action: 'none' });
  });

  it('a window in flight ⇒ none, whatever the probe says', () => {
    expect(decideRepair(probe({ epoch: 7, focused: false, sessionRev: 999, newRows: [1] }), local({ inFlight: true })))
      .toEqual({ action: 'none' });
  });

  it('no stream position yet ⇒ none (the mount/resync window is the repair)', () => {
    expect(decideRepair(probe({ sessionRev: 999 }), local({ epoch: null, lastRev: null }))).toEqual({ action: 'none' });
  });

  it('another epoch ⇒ window(epoch)', () => {
    expect(decideRepair(probe({ epoch: E + 1 }), local())).toEqual({ action: 'window', reason: 'epoch' });
  });

  it('this connection is not focused on the session ⇒ window(unfocused)', () => {
    expect(decideRepair(probe({ focused: false }), local())).toEqual({ action: 'window', reason: 'unfocused' });
  });

  it('the stream is behind the probe ⇒ wait until its revision', () => {
    expect(decideRepair(probe({ sessionRev: 999 }), local({ lastRev: { epoch: E, rev: 99 } })))
      .toEqual({ action: 'wait', untilRev: { epoch: E, rev: 100 } });
    expect(decideRepair(probe(), local({ lastRev: null }))).toEqual({ action: 'wait', untilRev: { epoch: E, rev: 100 } });
  });

  it('still behind after two heartbeat periods ⇒ reconnect(probe-lag)', () => {
    const behind = { lastRev: { epoch: E, rev: 99 }, waitingSinceMs: 1_000_000 };
    expect(decideRepair(probe(), local({ ...behind, nowMs: 1_000_000 + PROBE_LAG_RECONNECT_MS - 1 })).action).toBe('wait');
    expect(decideRepair(probe(), local({ ...behind, nowMs: 1_000_000 + PROBE_LAG_RECONNECT_MS })))
      .toEqual({ action: 'reconnect', reason: 'probe-lag' });
    expect(PROBE_LAG_RECONNECT_MS).toBe(16_000);
  });

  it('a session frame this tab never saw ⇒ window(missed-frame)', () => {
    expect(decideRepair(probe({ sessionRev: 91 }), local())).toEqual({ action: 'window', reason: 'missed-frame' });
    expect(decideRepair(probe({ sessionRev: 1 }), local({ sessionFrameRev: null })))
      .toEqual({ action: 'window', reason: 'missed-frame' });
    // A frame rev of another epoch counts as nothing seen.
    expect(decideRepair(probe({ sessionRev: 5 }), local({ sessionFrameRev: { epoch: E - 1, rev: 500 } })))
      .toEqual({ action: 'window', reason: 'missed-frame' });
  });

  it('a summary-only change (summary frames counted on both sides) ⇒ none', () => {
    // stop ⇒ status + session_unread + session_summary: the hub's sessionRev
    // and the tab's frame rev both end on the summary frame.
    expect(decideRepair(probe({ rev: 120, sessionRev: 118 }),
      local({ lastRev: { epoch: E, rev: 120 }, sessionFrameRev: { epoch: E, rev: 118 } }))).toEqual({ action: 'none' });
    expect(decideRepair(probe({ sessionRev: 0 }), local({ sessionFrameRev: null }))).toEqual({ action: 'none' });
  });

  it('an unknown rendered row ⇒ window(unknown-row)', () => {
    expect(decideRepair(probe({ newRows: [51, 52] }), local({ knownRowIds: new Set([51]) })))
      .toEqual({ action: 'window', reason: 'unknown-row' });
    expect(decideRepair(probe({ newRows: [51, 52] }), local({ knownRowIds: new Set([51, 52]) })))
      .toEqual({ action: 'none' });
  });

  it('a truncated row list ⇒ window(unknown-row)', () => {
    expect(decideRepair(probe({ newRowsTruncated: true }), local())).toEqual({ action: 'window', reason: 'unknown-row' });
  });

  it('gates differ either way ⇒ window(gate)', () => {
    expect(decideRepair(probe({ pendingIds: ['p1'] }), local())).toEqual({ action: 'window', reason: 'gate' });
    expect(decideRepair(probe(), local({ knownPendingIds: new Set(['ghost']) })))
      .toEqual({ action: 'window', reason: 'gate' });
    expect(decideRepair(probe({ pendingIds: ['a'] }), local({ knownPendingIds: new Set(['b']) })))
      .toEqual({ action: 'window', reason: 'gate' });
    expect(decideRepair(probe({ pendingIds: ['b', 'a'] }), local({ knownPendingIds: new Set(['a', 'b']) })))
      .toEqual({ action: 'none' });
  });

  it('precedence: epoch > unfocused > wait > missed-frame > unknown-row > gate', () => {
    const all = { epoch: E + 1, focused: false, sessionRev: 999, newRows: [77], pendingIds: ['x'] };
    expect(decideRepair(probe(all), local({ lastRev: { epoch: E, rev: 1 } })).action).toBe('window');
    expect(decideRepair(probe({ ...all, epoch: E }), local({ lastRev: { epoch: E, rev: 1 } })))
      .toEqual({ action: 'window', reason: 'unfocused' });
    expect(decideRepair(probe({ ...all, epoch: E, focused: true }), local({ lastRev: { epoch: E, rev: 1 } })).action)
      .toBe('wait');
    expect(decideRepair(probe({ ...all, epoch: E, focused: true }), local()))
      .toEqual({ action: 'window', reason: 'missed-frame' });
    expect(decideRepair(probe({ ...all, epoch: E, focused: true, sessionRev: 0 }), local()))
      .toEqual({ action: 'window', reason: 'unknown-row' });
    expect(decideRepair(probe({ ...all, epoch: E, focused: true, sessionRev: 0, newRows: [] }), local()))
      .toEqual({ action: 'window', reason: 'gate' });
  });
});
