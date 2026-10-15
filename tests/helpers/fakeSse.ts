import { vi } from 'vitest';

// A stubbed browser for app/globalEventStream.ts (no DOM environment, SPEC
// §11): window/document/EventSource/fetch globals and a handle on every
// EventSource the transport opens, to push frames into it.

export class FakeEventSource {
  static all: FakeEventSource[] = [];
  readyState = 0;
  onmessage: ((e: { data: string; lastEventId: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeEventSource.all.push(this); }
  close() { this.closed = true; this.readyState = 2; }
  addEventListener() {}
  open() { this.readyState = 1; this.onopen?.(); }
  /** One SSE message: `id` = the `id:` line (the browser keeps the last one). */
  send(frame: Record<string, unknown>, id = '') {
    this.onmessage?.({ data: JSON.stringify(frame), lastEventId: id });
  }
  fail() { this.onerror?.(); }
}

export type FakeBrowser = {
  reload: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
  doc: { visibilityState: 'visible' | 'hidden' };
  fire(target: 'window' | 'document', type: string): void;
};

export function installFakeBrowser(opts: { fetch?: (url: string, init?: RequestInit) => unknown } = {}): FakeBrowser {
  FakeEventSource.all = [];
  const handlers: Record<string, Array<() => void>> = {};
  const add = (target: string) => (type: string, cb: () => void) => {
    (handlers[`${target}:${type}`] ??= []).push(cb);
  };
  const reload = vi.fn();
  const doc = {
    visibilityState: 'visible' as 'visible' | 'hidden',
    addEventListener: add('document'),
    removeEventListener: () => {},
  };
  vi.stubGlobal('window', {
    addEventListener: add('window'), removeEventListener: () => {}, location: { reload },
  });
  vi.stubGlobal('document', doc);
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('EventSource', FakeEventSource);
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const body = opts.fetch?.(url, init) ?? { ok: true };
    return { status: 200, json: async () => body };
  });
  vi.stubGlobal('fetch', fetch);
  return {
    reload, fetch, doc,
    fire(target, type) { for (const cb of handlers[`${target}:${type}`] ?? []) cb(); },
  };
}

export const lastEs = () => FakeEventSource.all[FakeEventSource.all.length - 1];

export function sinceOf(es: FakeEventSource): string | null {
  return new URL(es.url, 'http://x').searchParams.get('since');
}
