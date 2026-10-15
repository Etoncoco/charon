import { afterEach, describe, expect, it, vi } from 'vitest';

// `instrumentation.ts § register()` is the ONLY production caller of
// startLoopLagMonitor (sync refonte C00): without it there is no `[eventloop]`
// line and `/api/perf` reads zeros. It must arm the monitor after the seed,
// even when the seed throws, and only in the nodejs runtime outside
// `next build` (§14.12).

const seed = vi.hoisted(() => ({ fail: false, calls: 0 }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/seed', () => ({
  seedInitialData: () => {
    seed.calls++;
    if (seed.fail) throw new Error('seed failed');
  },
}));

type LoopLagState = { started?: boolean };
const loopLag = () => (globalThis as { __charonLoopLag?: LoopLagState }).__charonLoopLag;

afterEach(async () => {
  (await import('@/lib/server/perf/loopLag')).stopLoopLagMonitor();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  seed.fail = false;
  seed.calls = 0;
});

describe('instrumentation register()', () => {
  it.each([false, true])('nodejs: arms the loop-lag monitor after the seed (seed throws: %s)', async (fail) => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('NEXT_PHASE', '');
    seed.fail = fail;
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { register } = await import('@/instrumentation');
      await register();
      expect(seed.calls).toBe(1);
      expect(loopLag()?.started).toBe(true);
    } finally {
      quiet.mockRestore();
      log.mockRestore();
    }
  });

  it.each([
    ['the edge runtime', { NEXT_RUNTIME: 'edge', NEXT_PHASE: '' }],
    ['next build', { NEXT_RUNTIME: 'nodejs', NEXT_PHASE: 'phase-production-build' }],
  ])('%s: neither seeds nor arms a timer', async (_label, env) => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    vi.useFakeTimers();
    const { register } = await import('@/instrumentation');
    await register();
    expect(seed.calls).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(loopLag()?.started ?? false).toBe(false);
  });
});
