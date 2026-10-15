'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { NotificationSession } from '@/lib/notificationPreferences';
import { useBrowserNotifications } from './browserNotifications';
import { subscribeAll, subscribeReconnect } from './globalEventStream';
import { createLatestGate } from './sync/revResource';

const NOTIFICATION_REFRESH_DEBOUNCE_MS = 500;

export default function NotificationExceptions({ onOpen }: { onOpen: (session: NotificationSession) => void }) {
  const browser = useBrowserNotifications();
  const [sessions, setSessions] = useState<NotificationSession[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    // Latest-started answer wins; triggers are debounced (a burst of status
    // frames across sessions was one GET per frame, R3 A16).
    const gate = createLatestGate();
    const refresh = () => {
      const n = gate.next();
      return api.notificationSessions()
        .then((rows) => { if (alive && gate.isLatest(n)) { setSessions(rows); setError(null); } })
        .catch((e) => { if (alive && gate.isLatest(n)) setError(e.message); });
    };
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => { debounce = null; void refresh(); }, NOTIFICATION_REFRESH_DEBOUNCE_MS);
    };
    void refresh();
    const unsubscribe = subscribeAll((ev) => {
      if (ev.type === 'settings_changed' || ev.type === 'session_list_changed' || ev.type === 'status') schedule();
    });
    const reconnect = subscribeReconnect(schedule);
    return () => { alive = false; unsubscribe(); reconnect(); if (debounce) clearTimeout(debounce); };
  }, []);
  const exceptions = sessions.filter((s) => s.telegramException || browser.sessions?.[s.id])
    .sort((a, b) => (a.name || a.cwd).localeCompare(b.name || b.cwd));
  return <section className="notification-exceptions">
    <button className="notification-disclosure" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span><strong>Exceptions</strong><small>Sessions with custom notification settings</small></span>
      <span className="notification-count">{exceptions.length}</span><span aria-hidden="true">{open ? '⌄' : '›'}</span>
    </button>
    {open && <div className="notification-exception-list">
      {error ? <p className="notification-error" role="alert">{error}</p> : exceptions.length === 0
        ? <p className="notification-intro">No exceptions. All sessions use global settings.</p>
        : exceptions.map((s) => <button key={s.id} type="button" className="notification-disclosure" onClick={() => onOpen(s)}>
          <span><strong>{s.name || s.cwd.split('/').filter(Boolean).pop() || s.id.slice(0, 8)}</strong>
            <small>{s.vpsName} · {s.status === 'sleeping' ? 'sleeping' : s.status}</small>
            <small>{[browser.sessions?.[s.id] ? 'Browser' : '', s.telegramException ? 'Telegram' : ''].filter(Boolean).join(' · ')}</small></span>
          <span aria-hidden="true">›</span>
        </button>)}
    </div>}
  </section>;
}
