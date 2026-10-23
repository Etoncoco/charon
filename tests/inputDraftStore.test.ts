import { describe, expect, it } from 'vitest';
import { clearDraft, getDraft, hasNonEmptyDraft, setDraft, subscribeDrafts } from '@/app/inputDraftStore';

describe('inputDraftStore', () => {
  it('notifies only when a session gains or loses text, never per keystroke', () => {
    let calls = 0;
    const off = subscribeDrafts(() => { calls += 1; });
    setDraft('d1', 'h');
    setDraft('d1', 'he');
    setDraft('d1', 'hello');
    expect(calls).toBe(1);
    expect(hasNonEmptyDraft()).toBe(true);
    setDraft('d1', '');
    expect(calls).toBe(2);
    expect(hasNonEmptyDraft()).toBe(false);
    off();
  });

  it('whitespace alone is not a draft, but is still kept verbatim', () => {
    let calls = 0;
    const off = subscribeDrafts(() => { calls += 1; });
    setDraft('d2', '   \n');
    expect(calls).toBe(0);
    expect(hasNonEmptyDraft()).toBe(false);
    expect(getDraft('d2')).toBe('   \n');
    setDraft('d2', '  x');
    expect(calls).toBe(1);
    clearDraft('d2');
    expect(calls).toBe(2);
    expect(getDraft('d2')).toBe('');
    off();
  });
});
