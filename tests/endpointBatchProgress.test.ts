import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EndpointBatchProgress } from '@/app/CustomEndpointsSettings';
import type { EndpointBatch } from '@/lib/types/api';

(globalThis as { React?: typeof React }).React = React;
const batch: EndpointBatch = {
  id: 'job', vpsId: 'vps', status: 'running', total: 8, completed: 3,
  passed: { claude: 2, codex: 0 }, failed: { claude: 0, codex: 1 },
  active: [{ endpointId: 'go', name: 'Go', model: 'mini', engine: 'codex' }],
};

describe('endpoint batch progress', () => {
  it('shows saved counts per engine, the running model and an accessible progress indicator', () => {
    const html = renderToStaticMarkup(createElement(EndpointBatchProgress, { batch }));
    expect(html).toContain('Testing compatibility…');
    expect(html).toContain('3 / 8 checks');
    expect(html).toContain('aria-label="Endpoint compatibility tests" max="8" value="3"');
    expect(html).toContain('Claude · 2 verified · 0 failed');
    expect(html).toContain('Codex · 0 verified · 1 failed');
    expect(html).toContain('Go · mini · Codex');
  });

  it('keeps partial progress visible after cancellation or interruption and escapes error details', () => {
    const stopped = renderToStaticMarkup(createElement(EndpointBatchProgress, { batch: { ...batch, status: 'cancelled', active: [] } }));
    expect(stopped).toContain('Tests stopped — completed results saved');
    expect(stopped).toContain('3 / 8 checks');
    const error = renderToStaticMarkup(createElement(EndpointBatchProgress, { batch: { ...batch, status: 'error', active: [], error: 'Connection <failed>' } }));
    expect(error).toContain('Tests interrupted — completed results saved');
    expect(error).toContain('Connection &lt;failed&gt;');
  });
});
