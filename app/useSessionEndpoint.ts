'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { EndpointState } from '@/lib/customEndpoints';
import { subscribeAll, subscribeReconnect } from './globalEventStream';
import { createLatestGate } from './sync/revResource';

export function useSessionEndpoint(id: string, initial?: EndpointState) {
  const [state, setState] = useState<EndpointState>(initial || { active: null });
  // Latest-STARTED request wins (R3 F13): a slow older answer never
  // overwrites a newer one, whichever trigger issued them.
  const [gate] = useState(createLatestGate);
  const refresh = useCallback(() => {
    const n = gate.next();
    return api.getSessionEndpoint(id).then((r) => { if (gate.isLatest(n)) setState(r); }).catch(() => {});
  }, [id, gate]);
  useEffect(() => {
    let alive = true;
    const sync = () => {
      const n = gate.next();
      api.getSessionEndpoint(id).then((r) => { if (alive && gate.isLatest(n)) setState(r); }).catch(() => {});
    };
    sync();
    const off = subscribeAll((e) => { if (e.type === 'session_list_changed' && e.sessionId === id) sync(); });
    const reconnect = subscribeReconnect(sync);
    return () => { alive = false; off(); reconnect(); };
  }, [id, gate]);
  return [state, refresh] as const;
}
