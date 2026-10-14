import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { loopLagSnapshot } from '@/lib/server/perf/loopLag';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/perf — the hub's event-loop health in numbers (lib/server/perf/
// loopLag.ts): lag percentiles, stalls in the last hour and the ring of slow
// sections, whose labels may carry session ids. Authenticated like every
// /api/* route (middleware + the gate below); /api/health, the public probe,
// stays as it is.
export async function GET() {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  return NextResponse.json(
    { loop: loopLagSnapshot() },
    { headers: { 'cache-control': 'no-store' } },
  );
}
