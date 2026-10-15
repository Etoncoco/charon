import { describe, expect, it } from 'vitest';
import type { Msg } from '@/app/sessionTypes';
import {
  addOptimisticSend, liveStreamingMessage, newClientMessageId, patchAssistantRows, reduceFlushFrame, reduceRowIdRename,
  reduceSendAck, reduceStop, reduceUserEcho,
  type LiveBuffers, type OptimisticSends, type TranscriptCtx,
} from '@/app/sync/transcriptReducer';

const ctx: TranscriptCtx = { fromJournal: false, view: 'full', provider: 'claude', hubBoundaries: true, nowMs: 1_700_000_000_000 };
const buf = (assistant: string, streamingInto: number | null = null, thinkingOpen = ''): LiveBuffers =>
  ({ assistant, streamingInto, thinkingOpen });
const user = (id: string, content: string): Msg => ({ id, role: 'user', content, createdAt: 1 });
const assistant = (id: string, content: string, assistantFinal: number | null = 0): Msg =>
  ({ id, role: 'assistant', content, createdAt: 1, assistantFinal });

/** What the view draws: the history with the live row substituted, plus the
 *  `__streaming` bubble when there is one. */
function rendered(messages: Msg[], b: LiveBuffers): string[] {
  const live = liveStreamingMessage(messages, b);
  const out = messages.map((m) => live && live.id === m.id ? live.content : m.content);
  if (live?.id === '__streaming') out.push(live.content);
  return out;
}

describe('assistant_flushed', () => {
  it('inserts the buffer as m<rowId>, intermediate, dated by the first delta, and clears the buffer', () => {
    const r = reduceFlushFrame([user('m1', 'hi')], buf('Hello there'),
      { type: 'assistant_flushed', rowId: 7, length: 11, tsMs: 1_700_000_123_456, model: 'opus' }, ctx);
    expect(r.messages[1]).toMatchObject({ id: 'm7', role: 'assistant', content: 'Hello there', model: 'opus',
      assistantFinal: 0, createdAt: 1_700_000_123 });
    expect(r.buf).toEqual(buf(''));
    expect(r.effects).toEqual([]);
  });

  it('replaces the row in place with `content` (a replay extend) without a refetch', () => {
    const msgs = [user('m1', 'hi'), assistant('m7', 'Hel'), user('m9', 'next')];
    const r = reduceFlushFrame(msgs, buf('Hello'),
      { type: 'assistant_flushed', rowId: 7, length: 11, tsMs: null, model: null, content: 'Hello world' }, ctx);
    expect(r.messages.map((m) => [m.id, m.content])).toEqual([['m1', 'hi'], ['m7', 'Hello world'], ['m9', 'next']]);
    expect(r.effects).toEqual([]);
  });

  it('`duplicate` discards the buffer and adds nothing', () => {
    const msgs = [assistant('m7', 'Already here')];
    for (const rowId of [7, null]) {
      const r = reduceFlushFrame(msgs, buf('Already here'),
        { type: 'assistant_flushed', rowId, length: 12, tsMs: null, model: null, duplicate: true }, ctx);
      expect(r.messages).toBe(msgs);
      expect(r.buf.assistant).toBe('');
      expect(r.effects).toEqual([]);
    }
  });

  it('a length mismatch (a lost delta) asks for ONE refetch', () => {
    const r = reduceFlushFrame([], buf('Hel'),
      { type: 'assistant_flushed', rowId: 3, length: 5, tsMs: null, model: null }, ctx);
    expect(r.effects).toEqual([{ kind: 'refetch', reason: expect.any(String), rowId: 3 }]);
    expect(r.messages[0]).toMatchObject({ id: 'm3', content: 'Hel' });
  });

  it('a content-less cut of ANOTHER row over a reopened buffer is a mismatch too (refetch, row named)', () => {
    // A stale snapshot re-seeded the buffer with row 10's tail; row 11 is new.
    const r = reduceFlushFrame([assistant('m10', 'Hello world')], buf(' worldNew text', 10),
      { type: 'assistant_flushed', rowId: 11, length: 8, tsMs: null, model: null }, ctx);
    expect(r.effects).toEqual([{ kind: 'refetch', reason: expect.any(String), rowId: 11 }]);
  });

  it('patchAssistantRows heals the named rows from a GET answer, leaves the rest alone', () => {
    const msgs = [user('m1', 'q'), assistant('m3', 'Hel'), assistant('m4', 'kept')];
    const rows = [{ id: 3, role: 'assistant', content: 'Hello' }, { id: 4, role: 'assistant', content: 'other' }];
    const out = patchAssistantRows(msgs, rows, [3]);
    expect(out.map((m) => m.content)).toEqual(['q', 'Hello', 'kept']);
    expect(out[1]).toMatchObject({ id: 'm3', assistantFinal: 0 });
    // Nothing to change: same array back.
    expect(patchAssistantRows(out, rows, [3, 9])).toBe(out);
  });

  it('a replayed flush of a row already on screen does not duplicate it', () => {
    const first = reduceFlushFrame([], buf('Text'),
      { type: 'assistant_flushed', rowId: 4, length: 4, tsMs: null, model: null }, ctx);
    const again = reduceFlushFrame(first.messages, buf('Text'),
      { type: 'assistant_flushed', rowId: 4, length: 4, tsMs: null, model: null }, ctx);
    expect(again.messages.filter((m) => m.id === 'm4')).toHaveLength(1);
  });
});

describe('assistant_reopened (SIGTERM partial)', () => {
  it('renders the buffer INTO m<rowId>, and the next flush replaces it: the text appears once', () => {
    let messages = [user('m1', 'q'), assistant('m5', 'The answer is')];
    let b = buf('');
    const opened = reduceFlushFrame(messages, b, { type: 'assistant_reopened', rowId: 5, length: 13 }, ctx);
    messages = opened.messages; b = opened.buf;
    expect(b.streamingInto).toBe(5);
    b = { ...b, assistant: ' forty-two' };                 // the remainder deltas
    expect(rendered(messages, b)).toEqual(['q', 'The answer is forty-two']);
    expect(liveStreamingMessage(messages, b)).toMatchObject({ id: 'm5', assistantFinal: 0 });
    const flushed = reduceFlushFrame(messages, b, { type: 'assistant_flushed', rowId: 5, length: 23, tsMs: null,
      model: null, content: 'The answer is forty-two' }, ctx);
    expect(flushed.buf).toEqual(buf(''));
    expect(flushed.effects).toEqual([]);
    expect(rendered(flushed.messages, flushed.buf)).toEqual(['q', 'The answer is forty-two']);
    expect(flushed.messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
  });

  it('an empty reopened buffer shows the row as it is (no streaming bubble)', () => {
    expect(liveStreamingMessage([assistant('m5', 'x')], buf('', 5))).toBeNull();
  });

  it('falls back to the __streaming bubble when the row is not in the window', () => {
    expect(liveStreamingMessage([], buf('tail', 5))).toMatchObject({ id: '__streaming', content: 'tail', assistantFinal: 0 });
  });

  it('a content-less flush of the reopened row appends the buffer to it', () => {
    const r = reduceFlushFrame([assistant('m5', 'Head')], buf(' tail', 5),
      { type: 'assistant_flushed', rowId: 5, length: 9, tsMs: null, model: null }, ctx);
    expect(r.messages).toEqual([expect.objectContaining({ id: 'm5', content: 'Head tail' })]);
    expect(r.effects).toEqual([]);
  });
});

describe('thinking_flushed', () => {
  const open = (id: string, content: string): Msg =>
    ({ id, role: 'thinking', content, createdAt: 1, thinkingDelta: true });

  it('renames the open bubble to its row and clears the open text', () => {
    const r = reduceFlushFrame([open('th-x', 'reasoning')], buf('', null, 'reasoning'),
      { type: 'thinking_flushed', rowId: 12, length: 9 }, ctx);
    expect(r.messages).toEqual([expect.objectContaining({ id: 'm12', content: 'reasoning' })]);
    expect(r.buf.thinkingOpen).toBe('');
  });

  it('replaces the open part with `content` on a replay extend', () => {
    const r = reduceFlushFrame([open('m10', 'first. partial')], buf('', null, 'partial'),
      { type: 'thinking_flushed', rowId: 12, length: 13, content: 'partial block' }, ctx);
    expect(r.messages[0]).toMatchObject({ id: 'm10', content: 'first. partial block' });
  });
});

describe('user_echo ↔ clientMessageId', () => {
  const send = () => addOptimisticSend([user('m1', 'earlier')], new Map(), 'cmid-1', 'hello', 5);

  it('echo BEFORE the POST response: the bubble becomes m<rowId>, the ack changes nothing', () => {
    const s = send();
    const echoed = reduceUserEcho(s.messages, s.sends,
      { type: 'user_echo', content: 'hello', createdAt: 5, rowId: 9, clientMessageId: 'cmid-1' });
    expect(echoed.messages.map((m) => m.id)).toEqual(['m1', 'm9']);
    const acked = reduceSendAck(echoed.messages, echoed.sends, 'cmid-1', 9);
    expect(acked.messages.map((m) => m.id)).toEqual(['m1', 'm9']);
  });

  it('POST response BEFORE the echo: renamed at the ack, the echo adds nothing', () => {
    const s = send();
    const acked = reduceSendAck(s.messages, s.sends, 'cmid-1', 9);
    expect(acked.messages.map((m) => m.id)).toEqual(['m1', 'm9']);
    expect(acked.sends.get('cmid-1')).toMatchObject({ rowId: 9 });
    const echoed = reduceUserEcho(acked.messages, acked.sends,
      { type: 'user_echo', content: 'hello', createdAt: 5, rowId: 9, clientMessageId: 'cmid-1' });
    expect(echoed.messages.map((m) => m.id)).toEqual(['m1', 'm9']);
    expect(echoed.sends.size).toBe(0);
  });

  it('an unknown id is a foreign echo — appended once, never matched by content', () => {
    const s = send();
    const foreign = { type: 'user_echo' as const, content: 'hello', createdAt: 6, rowId: 11, clientMessageId: 'other' };
    const once = reduceUserEcho(s.messages, s.sends, foreign);
    expect(once.messages.map((m) => m.id)).toEqual(['m1', 'u-cmid-1', 'm11']);
    expect(once.sends.has('cmid-1')).toBe(true);
    expect(reduceUserEcho(once.messages, once.sends, foreign).messages).toHaveLength(3);
  });

  it('an id-less echo (older hub) consumes our send by content, oldest first', () => {
    let sends: OptimisticSends = new Map();
    let messages: Msg[] = [];
    ({ messages, sends } = addOptimisticSend(messages, sends, 'a', 'same', 1));
    ({ messages, sends } = addOptimisticSend(messages, sends, 'b', 'same', 2));
    const r = reduceUserEcho(messages, sends, { type: 'user_echo', content: 'same', createdAt: 1 });
    expect(r.messages).toBe(messages);
    expect([...r.sends.keys()]).toEqual(['b']);
  });

  it('generates ids the input route accepts', () => {
    for (let i = 0; i < 5; i++) expect(newClientMessageId()).toMatch(/^[A-Za-z0-9-]{1,64}$/);
  });
});

describe('row ids on tool frames', () => {
  it('a tool_result with rowId renames its tr-live-<sdkId> progress row in place', () => {
    let messages: Msg[] = [];
    messages = reduceRowIdRename(messages, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {}, rowId: 20 });
    messages = [...messages, { id: 'tr-live-toolu_1', role: 'tool_result', content: '{"content":"par"}', createdAt: 1 }];
    messages = reduceRowIdRename(messages, { type: 'tool_result', tool_use_id: 'toolu_1', content: 'done', is_error: false, rowId: 21 });
    expect(messages.map((m) => m.id)).toEqual(['m20', 'm21']);
    expect(JSON.parse(messages[1].content)).toMatchObject({ tool_use_id: 'toolu_1', content: 'done' });
  });

  it('replayed tool frames with the same rowId do not duplicate rows', () => {
    const use = { type: 'tool_use' as const, id: 'toolu_2', name: 'Read', input: {}, rowId: 30 };
    const res = { type: 'tool_result' as const, tool_use_id: 'toolu_2', content: 'x', is_error: false, rowId: 31 };
    let messages = reduceRowIdRename(reduceRowIdRename([], use), res);
    messages = reduceRowIdRename(reduceRowIdRename(messages, use), res);
    expect(messages.map((m) => m.id)).toEqual(['m30', 'm31']);
  });

  it('without rowId (older hub) the historical live ids are kept', () => {
    const messages = reduceRowIdRename([], { type: 'tool_result', tool_use_id: 'toolu_3', content: 'x', is_error: false });
    expect(messages[0].id).toBe('tr-live-toolu_3');
  });
});

describe('stop', () => {
  it('marks m<finalAssistantId> final', () => {
    const out = reduceStop([assistant('m3', 'a'), assistant('m4', 'b')], { type: 'stop', finalAssistantId: 4 }, ctx);
    expect(out.map((m) => m.assistantFinal)).toEqual([0, 1]);
  });

  it('the optimistic a… fallback is legacy-only', () => {
    const msgs = [assistant('a123', 'b')];
    expect(reduceStop(msgs, { type: 'stop', finalAssistantId: 4 }, { hubBoundaries: true })[0].assistantFinal).toBe(0);
    expect(reduceStop(msgs, { type: 'stop', finalAssistantId: 4 }, { hubBoundaries: false })[0].assistantFinal).toBe(1);
  });

  it('closes an open reasoning bubble', () => {
    const out = reduceStop([{ id: 'th', role: 'thinking', content: 'x', createdAt: 1, thinkingDelta: true }],
      { type: 'stop' }, ctx);
    expect(out[0].thinkingClosed).toBe(true);
  });
});
