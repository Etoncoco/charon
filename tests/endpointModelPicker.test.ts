import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import EndpointModelPicker, { EndpointModelCompatibility } from '@/app/EndpointModelPicker';
import type { CustomEndpoint, EndpointCheck, EndpointEngine } from '@/lib/customEndpoints';

(globalThis as { React?: typeof React }).React = React;

function check(engine: EndpointEngine, model: string, ok: boolean, error?: string): EndpointCheck {
  return { engine, model, ok, streaming: ok, tools: ok, error };
}
const endpoint: CustomEndpoint = {
  name: 'Go', baseUrl: 'https://opencode.ai/zen/go', auth: 'none', model: 'responses-model',
  models: [
    { id: 'responses-model', checks: { codex: check('codex', 'responses-model', true) } },
    { id: 'messages-model', checks: {
      claude: check('claude', 'messages-model', true),
      codex: check('codex', 'messages-model', false, 'Model is not supported for format openai'),
    } },
    { id: 'temporary-failure', checks: {
      claude: check('claude', 'temporary-failure', false, 'HTTP 500: Internal server error'),
      codex: check('codex', 'temporary-failure', false, 'HTTP 500: Internal server error'),
    } },
    { id: 'untested-model' },
  ],
};

describe('endpoint model catalog', () => {
  it('shows failed, untested and other-engine models as selectable choices in configuration', () => {
    const html = renderToStaticMarkup(createElement(EndpointModelPicker, {
      endpoint, kind: 'codex', value: endpoint.model, onChange: () => {},
      presentation: 'list', includeUnverified: true,
    }));
    for (const model of endpoint.models!) expect(html).toContain(`>${model.id}<`);
    expect(html.match(/role="menuitemradio"/g)).toHaveLength(4);
    expect(html).not.toContain('disabled=""');
    expect(html).toContain('Claude · Available (verified)');
    expect(html).toContain('Codex · Last test failed: Model is not supported for format openai');
    expect(html).toContain('Claude · Last test failed: HTTP 500: Internal server error');
    expect(html).toContain('Codex · Not tested');
    expect(html).toContain('class="endpoint-model-badge" data-state="verified" data-current="true" title="Codex');
    expect(html).toContain('class="endpoint-model-badge" data-state="failed" data-current="true" title="Codex');
    expect(html).toContain('class="endpoint-model-badge" data-state="unknown"');
    expect(html).toContain('<span aria-hidden="true">✓</span>Claude');
    expect(html).toContain('<span aria-hidden="true">×</span>Codex');
    expect(html).toContain('<span aria-hidden="true">?</span>Codex');
  });

  it('keeps the session runtime picker restricted to the engine-verified models', () => {
    const html = renderToStaticMarkup(createElement(EndpointModelPicker, {
      endpoint, kind: 'codex', value: endpoint.model, onChange: () => {}, presentation: 'list',
    }));
    expect(html.match(/role="menuitemradio"/g)).toHaveLength(1);
    expect(html).toContain('responses-model');
    expect(html).not.toContain('messages-model');
    expect(html).not.toContain('temporary-failure');
    expect(html).not.toContain('untested-model');
  });

  it('reports legacy checks only for their tested model and escapes provider error text', () => {
    const legacy: CustomEndpoint = { ...endpoint, models: [], checks: {
      codex: check('codex', endpoint.model, false, '<script>alert(1)</script>'),
    } };
    const failed = renderToStaticMarkup(createElement(EndpointModelCompatibility, { endpoint: legacy, model: endpoint.model }));
    expect(failed).toContain('Codex · Last test failed: &lt;script&gt;');
    expect(failed).not.toContain('<script>');
    const other = renderToStaticMarkup(createElement(EndpointModelCompatibility, { endpoint: legacy, model: 'another-model' }));
    expect(other).toContain('Codex · Not tested');
    expect(other).not.toContain('Last test failed');
  });
});
