// Durations and moments as the task bars and their modals print them
// (BgTasksBar, ScheduledTasksBar). Local time, 24h, day/month like
// messageTime.ts.

/** "45 s", "12 min 05 s", "3 h 05 min", "2 d 4 h". `seconds:false` drops the
 *  seconds past the first minute (a countdown that ticks per minute). */
export function fmtDuration(ms: number, { seconds = true }: { seconds?: boolean } = {}): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return seconds ? `${m} min ${String(s % 60).padStart(2, '0')} s` : `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${String(m % 60).padStart(2, '0')} min`;
  const d = Math.floor(h / 24);
  return `${d} d ${h % 24} h`;
}

/** "in 12 min", "in 3 h 05 min"; "now" within the minute; "overdue" past it. */
export function fmtCountdown(targetMs: number, nowMs: number): string {
  const d = targetMs - nowMs;
  if (d < -60_000) return `overdue by ${fmtDuration(-d, { seconds: false })}`;
  if (d < 60_000) return 'now';
  return `in ${fmtDuration(d, { seconds: false })}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "today 20:37", "tomorrow 19:13", "yesterday 08:02", "Thu 19:13" within the
 *  week ahead, else "29/10 19:13" (the year only when it is not this one). */
export function fmtMoment(ms: number, nowMs: number): string {
  const d = new Date(ms);
  const now = new Date(nowMs);
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(d) - day(now)) / 86_400_000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  if (days === -1) return `yesterday ${time}`;
  if (days > 1 && days < 7) return `${WEEKDAYS[d.getDay()]} ${time}`;
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}${d.getFullYear() !== now.getFullYear() ? `/${d.getFullYear()}` : ''}`;
  return `${date} ${time}`;
}
