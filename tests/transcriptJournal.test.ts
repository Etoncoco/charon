import { describe, expect, it } from 'vitest';
import { TranscriptJournal } from '@/app/sync/transcriptJournal';

const R = (rev: number, epoch = 1) => ({ epoch, rev });

describe('TranscriptJournal', () => {
  it('records only while active; begin is idempotent', () => {
    const j = new TranscriptJournal<string>();
    j.record('lost', R(1), 10);
    expect(j.active).toBe(false);
    expect(j.takeAfter(R(0))).toEqual([]);
    j.begin();
    j.record('a', R(2), 10);
    j.begin();                                 // keeps what it holds
    j.record('b', R(3), 10);
    expect(j.takeAfter(R(0)).map((e) => e.ev)).toEqual(['a', 'b']);
  });

  it('takeAfter returns frames > rev in arrival order and does NOT clear', () => {
    const j = new TranscriptJournal<string>();
    j.begin();
    j.record('r5', R(5), 1);
    j.record('r3', R(3), 1);                   // arrival order, not rev order
    j.record('r7', R(7), 1);
    expect(j.takeAfter(R(4))).toEqual([{ ev: 'r5', rev: R(5) }, { ev: 'r7', rev: R(7) }]);
    expect(j.takeAfter(R(4)).map((e) => e.ev)).toEqual(['r5', 'r7']);
    expect(j.takeAfter(R(6)).map((e) => e.ev)).toEqual(['r7']);
    expect(j.size).toBe(3);
  });

  it('compares epochs first', () => {
    const j = new TranscriptJournal<string>();
    j.begin();
    j.record('old-epoch', R(99, 1), 1);
    j.record('new-epoch', R(1, 2), 1);
    expect(j.takeAfter(R(50, 1)).map((e) => e.ev)).toEqual(['old-epoch', 'new-epoch']);
    expect(j.takeAfter(R(0, 2)).map((e) => e.ev)).toEqual(['new-epoch']);
  });

  it('the frame cap evicts the oldest and reports droppedUpTo', () => {
    const j = new TranscriptJournal<number>({ maxFrames: 3 });
    j.begin();
    for (let i = 1; i <= 5; i++) j.record(i, R(i), 1);
    expect(j.takeAfter(R(0)).map((e) => e.ev)).toEqual([3, 4, 5]);
    expect(j.droppedUpTo).toEqual(R(2));
  });

  it('the byte cap evicts the oldest and reports droppedUpTo', () => {
    const j = new TranscriptJournal<string>({ maxBytes: 100 });
    j.begin();
    j.record('a', R(1), 40);
    j.record('b', R(2), 40);
    expect(j.droppedUpTo).toBeNull();
    j.record('c', R(3), 40);                  // 120 > 100 ⇒ 'a' goes
    expect(j.takeAfter(R(0)).map((e) => e.ev)).toEqual(['b', 'c']);
    expect(j.droppedUpTo).toEqual(R(1));
  });

  it('defaults: 4000 frames / 4 MiB', () => {
    const j = new TranscriptJournal<number>();
    j.begin();
    for (let i = 1; i <= 4001; i++) j.record(i, R(i), 1);
    expect(j.size).toBe(4000);
    expect(j.droppedUpTo).toEqual(R(1));
    const k = new TranscriptJournal<number>();
    k.begin();
    k.record(1, R(1), 3 << 20);
    k.record(2, R(2), 2 << 20);
    expect(k.droppedUpTo).toEqual(R(1));
  });

  it('end() clears the frames, droppedUpTo and stops recording', () => {
    const j = new TranscriptJournal<number>({ maxFrames: 1 });
    j.begin();
    j.record(1, R(1), 1);
    j.record(2, R(2), 1);
    expect(j.droppedUpTo).toEqual(R(1));
    j.end();
    expect(j.active).toBe(false);
    expect(j.droppedUpTo).toBeNull();
    expect(j.takeAfter(R(0))).toEqual([]);
    j.record(3, R(3), 1);
    expect(j.size).toBe(0);
  });
});
