import { describe, expect, it } from 'vitest';
import {
  appendOpenThinking, appendThinkingMessage, applyThinkingFlushed, closeThinkingMessage,
  openThinkingCreatedAt, openThinkingNeedsReload, prependMessagePage, reconcileOpenThinking,
} from '@/app/thinkingMessages';
import { rebuildStateFromMessages, type PersistedMessage } from '@/app/sessionRebuild';
import type { Msg } from '@/app/sessionTypes';

const fragment = (content: string, id: number): Msg => ({
  id: `m${id}`, role: 'thinking', content, createdAt: id, thinkingDelta: true,
});
const event = (text: string, id: number): PersistedMessage => ({
  id, role: 'event', content: JSON.stringify({ type: 'thinking', text }), createdAt: id,
});

describe('streamed thinking bubbles', () => {
  it('appends exact tokens to one stable bubble without mutating previous state', () => {
    const parts = ['CODEX_VERSION', ' shows', ' ', '0', '.', '154', '.', '0', '\n', 'é 🧠'];
    let messages: Msg[] = [];
    for (const [index, text] of parts.entries()) {
      const snapshot = structuredClone(messages);
      const next = appendThinkingMessage(messages, fragment(text, index + 1));
      expect(messages).toEqual(snapshot);
      expect(next).toHaveLength(1);
      expect(next[0]).toMatchObject({ id: 'm1', createdAt: 1, content: parts.slice(0, index + 1).join('') });
      messages = next;
    }
    expect(appendThinkingMessage(messages, fragment('', 99))).toBe(messages);
  });

  it.each(['user', 'assistant', 'tool_use', 'tool_result', 'error', 'compaction', 'external', 'plan'])(
    'starts a new bubble after %s', (role) => {
      const middle = { id: 'boundary', role, content: 'boundary', createdAt: 2 };
      const messages = appendThinkingMessage([fragment('before', 1), middle], fragment('after', 3));
      expect(messages.map((m) => m.content)).toEqual(['before', 'boundary', 'after']);
    },
  );

  it('keeps complete SDK/imported blocks separate from streamed fragments', () => {
    const complete = { id: 'complete', role: 'thinking', content: 'Full thought.', createdAt: 1 };
    expect(appendThinkingMessage([complete], { ...complete, id: 'next' })).toHaveLength(2);
    expect(appendThinkingMessage([complete], fragment('delta', 2))).toHaveLength(2);
    expect(appendThinkingMessage([fragment('delta', 2)], complete)).toHaveLength(2);
  });

  it('closes a block on stop so a later turn cannot continue it', () => {
    const messages = [fragment('before', 1)];
    const closed = closeThinkingMessage(messages);
    expect(messages[0].thinkingClosed).toBeUndefined();
    expect(closeThinkingMessage(closed)).toBe(closed);
    expect(appendThinkingMessage(closed, fragment('after', 2))).toHaveLength(2);
  });

  it.each(['codex', 'cursor'] as const)('rebuilds old fragmented %s history exactly like live delivery', (provider) => {
    const parts = ['0', '.', '154', '.', '0', '\nNext ', 'thought'];
    const rows = parts.map((text, index) => event(text, index + 1));
    const live = parts.reduce((messages, text, index) =>
      appendThinkingMessage(messages, fragment(text, index + 1)), [] as Msg[]);
    const rebuilt = rebuildStateFromMessages(rows, 'thinking', provider).messages;
    expect(rebuilt).toEqual(live);
    expect(rebuilt).toHaveLength(1);
    expect(rebuildStateFromMessages(rows, 'thinking', provider).messages).toEqual(rebuilt);
  });

  it('preserves Claude block boundaries and imported reasoning rows', () => {
    const rows = [event('First thought.', 1), event('Second thought.', 2)];
    expect(rebuildStateFromMessages(rows, 'active', 'claude').messages).toHaveLength(2);
    const imported = rows.map((row) => ({ ...row, role: 'thinking', content: 'Complete thought.' }));
    expect(rebuildStateFromMessages(imported, 'active', 'codex').messages).toHaveLength(2);
  });

  it('ignores control-plane updates but respects the durable end of a turn', () => {
    const rows = [
      event('a', 1),
      { id: 2, role: 'event', content: JSON.stringify({ type: 'tool_activity' }), createdAt: 2 },
      event('b', 3),
      { id: 4, role: 'event', content: JSON.stringify({ type: 'turn_usage' }), createdAt: 4 },
      event('c', 5),
    ];
    const messages = rebuildStateFromMessages(rows, 'active', 'codex').messages;
    expect(messages.map((m) => m.content)).toEqual(['ab', 'c']);
  });

  it('rejoins a streamed block split between older and current history pages', () => {
    const rows = [event('first ', 1), event('second ', 2), event('third', 3)];
    const older = rebuildStateFromMessages(rows.slice(0, 2), 'active', 'codex').messages;
    const current = rebuildStateFromMessages(rows.slice(2), 'active', 'codex').messages;
    expect(prependMessagePage(older, current))
      .toEqual(rebuildStateFromMessages(rows, 'active', 'codex').messages);
    expect(older[0].content).toBe('first second ');
    expect(current[0].content).toBe('third');
    expect(prependMessagePage(closeThinkingMessage(older), current)).toHaveLength(2);
  });
});

// Delta providers' reasoning is ONE row per block hub-side (CLAUDE.md §14.17):
// the browser keeps the open block live, renames it when the hub announces its
// row (`thinking_flushed`) and re-adds it after a refetch (`streamingThinking`).
describe('hub-cut reasoning blocks', () => {
  it('reconcileOpenThinking keeps the local block only while it extends the server one', () => {
    expect(reconcileOpenThinking('abc', 'abcdef')).toBe('abcdef');   // deltas arrived after the GET read
    expect(reconcileOpenThinking('abc', 'abc')).toBe('abc');
    expect(reconcileOpenThinking('abcdef', 'abc')).toBe('abcdef');   // the browser is behind
    expect(reconcileOpenThinking('new block', 'stale')).toBe('new block');
    expect(reconcileOpenThinking('abc', '')).toBe('abc');
    expect(reconcileOpenThinking('', 'abc')).toBe('abc');            // caller passes a non-empty server only
  });

  it('the open block joins the persisted head of the same block after a rebuild', () => {
    const rebuilt = rebuildStateFromMessages([event('first ', 7)], 'thinking', 'codex').messages;
    const shown = appendOpenThinking(rebuilt, 'second', 99);
    expect(shown).toEqual([{ ...rebuilt[0], content: 'first second' }]);
    expect(appendOpenThinking([], 'alone', 99)).toEqual([
      { id: 'th-open', role: 'thinking', content: 'alone', thinkingDelta: true, createdAt: 99 },
    ]);
    const afterTool = [...rebuilt, { id: 'm8', role: 'tool_use', content: '{}', createdAt: 8 }];
    expect(appendOpenThinking(afterTool, 'next', 99).map((m) => m.id)).toEqual(['m7', 'm8', 'th-open']);
  });

  it('thinking_flushed renames a live bubble to its row id, keeping it open', () => {
    const live = appendThinkingMessage([], { ...fragment('a', 1), id: 'th-live' });
    const flushed = applyThinkingFlushed(live, { rowId: 42 }, 'a');
    expect(flushed).toEqual([{ ...live[0], id: 'm42' }]);
    // The same id the rebuild gives the persisted row.
    expect(rebuildStateFromMessages([event('a', 42)], 'thinking', 'codex').messages[0].id).toBe('m42');
    // Still open: the next block's fragments join it, like adjacent rows on rebuild.
    expect(appendThinkingMessage(flushed, { ...fragment('b', 2), id: 'th-next' })).toEqual([
      { ...live[0], id: 'm42', content: 'ab' },
    ]);
  });

  it('thinking_flushed keeps an m… id (the first fragment row) and never duplicates an id', () => {
    const head = [{ ...fragment('a', 1), id: 'm10' }];
    expect(applyThinkingFlushed(head, { rowId: 12 }, 'a')).toBe(head);
    const clash = [{ id: 'm5', role: 'assistant', content: 'x', createdAt: 1 }, { ...fragment('b', 2), id: 'th-x' }];
    expect(applyThinkingFlushed(clash, { rowId: 5 }, 'b')).toBe(clash);
  });

  it('thinking_flushed with content replaces the block part of the bubble', () => {
    const bubble = [{ ...fragment('earlier block|abc', 1), id: 'm3' }];
    expect(applyThinkingFlushed(bubble, { rowId: 9, content: 'abcdef' }, 'abc')[0].content)
      .toBe('earlier block|abcdef');
    expect(applyThinkingFlushed(bubble, { rowId: 9, content: 'xyz' }, 'not a suffix')[0].content).toBe('xyz');
  });

  it('thinking_flushed leaves closed bubbles and other last messages alone', () => {
    const closed = closeThinkingMessage([{ ...fragment('a', 1), id: 'th-1' }]);
    expect(applyThinkingFlushed(closed, { rowId: 3 }, 'a')).toBe(closed);
    const tool = [{ ...fragment('a', 1), id: 'th-1' }, { id: 'tu', role: 'tool_use', content: '{}', createdAt: 2 }];
    expect(applyThinkingFlushed(tool, { rowId: 3 }, 'a')).toBe(tool);
    const block = [{ id: 'th-c', role: 'thinking', content: 'Claude block', createdAt: 1 }];
    expect(applyThinkingFlushed(block, { rowId: 3 }, '')).toBe(block);
  });
});

// The delta poll while the hub holds an open block (no row lands until it
// closes): the clean reload is due only when the screen cannot hold it.
describe('openThinkingNeedsReload (5 s delta poll)', () => {
  it('no open block, or the screen holds it (or more): synced', () => {
    expect(openThinkingNeedsReload('', 'anything', null)).toBe(false);
    expect(openThinkingNeedsReload('I need to', 'I need to', 'I need')).toBe(false);
    expect(openThinkingNeedsReload('I need to', 'I need to check', null)).toBe(false);
  });

  it('a hole or another block (neither text extends the other): reload at once', () => {
    expect(openThinkingNeedsReload('I need to check', 'I need check', null)).toBe(true);
    expect(openThinkingNeedsReload('second block', 'first block', null)).toBe(true);
  });

  it('behind by frames in flight is normal; still lacking what the server held a tick ago is not', () => {
    expect(openThinkingNeedsReload('I need to check', 'I need', null)).toBe(false);
    expect(openThinkingNeedsReload('I need to check', 'I need to check', 'I need to')).toBe(false);
    expect(openThinkingNeedsReload('I need to check the', 'I need to', 'I need to check')).toBe(true);
    expect(openThinkingNeedsReload('I need to check the', '', 'I need')).toBe(true);
    // A tick of another block proves nothing about this one.
    expect(openThinkingNeedsReload('I need to check the', 'I need', 'other block')).toBe(false);
  });
});

describe('openThinkingCreatedAt', () => {
  it('dates the open bubble by its first delta, else now (unix seconds)', () => {
    expect(openThinkingCreatedAt(1_700_000_000_999, 1_800_000_000_000)).toBe(1_700_000_000);
    expect(openThinkingCreatedAt(null, 1_800_000_000_500)).toBe(1_800_000_000);
    expect(openThinkingCreatedAt(undefined, 1_800_000_000_500)).toBe(1_800_000_000);
  });
});
