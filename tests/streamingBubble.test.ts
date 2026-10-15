import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import Message from '@/app/Message';
import { liveStreamingMessage } from '@/app/sync/transcriptReducer';
import type { Msg } from '@/app/sessionTypes';

// The vitest transform is classic JSX: components without a React import
// (icons, AgentLogo, the strip) read the global.
(globalThis as { React?: typeof React }).React = React;

vi.mock('@/app/tabStore', () => ({ openTab: vi.fn() }));
vi.mock('@/app/revealLine', () => ({ revealLine: vi.fn() }));

// S2 (sync refonte C09): a bubble is bordered only once `stop` names it final.
function bubbleClass(m: Msg, streaming = false): string {
  const html = renderToStaticMarkup(createElement(Message, { m, streaming }));
  const match = /class="(bubble [^"]*)"/.exec(html);
  if (!match) throw new Error(`no bubble in ${html}`);
  return match[1];
}

describe('assistant bubble border (S2)', () => {
  it('the streaming bubble is intermediate (borderless)', () => {
    const live = liveStreamingMessage([], { assistant: 'typing…', streamingInto: null, thinkingOpen: '' })!;
    expect(live).toMatchObject({ id: '__streaming', assistantFinal: 0 });
    expect(bubbleClass(live, true)).toContain('intermediate');
    // Even a streaming bubble carrying no flag stays borderless.
    expect(bubbleClass({ id: '__streaming', role: 'assistant', content: 'x', createdAt: 0 }, true)).toContain('intermediate');
  });

  it('a final row is bordered', () => {
    expect(bubbleClass({ id: 'm1', role: 'assistant', content: 'done', createdAt: 1, assistantFinal: 1 }))
      .not.toContain('intermediate');
  });

  it('an intermediate row is borderless; a legacy NULL row stays bordered', () => {
    expect(bubbleClass({ id: 'm2', role: 'assistant', content: 'mid', createdAt: 1, assistantFinal: 0 }))
      .toContain('intermediate');
    expect(bubbleClass({ id: 'm3', role: 'assistant', content: 'old', createdAt: 1, assistantFinal: null }))
      .not.toContain('intermediate');
  });

  it('only assistant bubbles are ever intermediate', () => {
    expect(bubbleClass({ id: 'm4', role: 'user', content: 'hi', createdAt: 1, assistantFinal: 0 }, true))
      .not.toContain('intermediate');
  });
});
