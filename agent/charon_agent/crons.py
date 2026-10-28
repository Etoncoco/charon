"""Session-scoped scheduled tasks (CronCreate, ScheduleWakeup, /loop).

The CLI owns them: they live in its memory, come back when the session is
resumed, and fire as a new turn. Its Stop hook lists them at every turn end
(`session_crons`: id, cron, recurring, prompt) but not WHEN each fires next, so
that is computed here, in the daemon's local time, which is the CLI's (its
child inherits our TZ).

Mirrors the CLI's own scheduler (`claude` 2.1.x): a 5-field cron with the Vixie
day-of-month / day-of-week OR, plus its deterministic per-task offset. A
recurring task fires a fraction (from its id) of half its period after its
slot, capped at 30 min; a one-shot landing on :00 or :30 fires up to 90 s
early. The hook omits the last-fire and creation times the CLI schedules from,
so a recurring slot is searched from one cap back (a slot whose offset has not
elapsed yet is still the next fire) and a one-shot from 90 s back.
"""
from __future__ import annotations

import re
import time
from datetime import datetime, timedelta
from typing import Any, Optional

_FIELDS = ((0, 59), (0, 23), (1, 31), (1, 12), (0, 6))
_RECURRING_FRAC = 0.5
_RECURRING_CAP_MS = 30 * 60 * 1000
_ONE_SHOT_MAX_MS = 90 * 1000
_ONE_SHOT_MINUTE_MOD = 30
_HORIZON_DAYS = 366
# A one-shot always targets its next match after creation, so a slot this far
# out means the real one passed while the session was busy or asleep: unknown.
_ONE_SHOT_OVERDUE_MS = 300 * 24 * 3600 * 1000
# The CLI caps the hook's prompt at 1000 chars; never trust that blindly.
PROMPT_MAX = 2000
MAX_TASKS = 100

Fields = list[list[int]]


def _field(spec: str, lo: int, hi: int) -> Optional[list[int]]:
    out: set[int] = set()
    dow = lo == 0 and hi == 6
    for part in spec.split(","):
        m = re.fullmatch(r"\*(?:/(\d+))?", part)
        if m:
            step = int(m.group(1) or 1)
            if step < 1:
                return None
            out.update(range(lo, hi + 1, step))
            continue
        m = re.fullmatch(r"(\d+)-(\d+)(?:/(\d+))?", part)
        if m:
            a, b, step = int(m.group(1)), int(m.group(2)), int(m.group(3) or 1)
            if a > b or step < 1 or a < lo or b > (7 if dow else hi):
                return None
            out.update(0 if dow and v == 7 else v for v in range(a, b + 1, step))
            continue
        if re.fullmatch(r"\d+", part):
            v = int(part)
            if dow and v == 7:
                v = 0
            if v < lo or v > hi:
                return None
            out.add(v)
            continue
        return None
    return sorted(out) or None


def parse_cron(expr: str) -> Optional[Fields]:
    parts = expr.split() if isinstance(expr, str) else []
    if len(parts) != 5:
        return None
    fields: Fields = []
    for spec, (lo, hi) in zip(parts, _FIELDS):
        f = _field(spec, lo, hi)
        if f is None:
            return None
        fields.append(f)
    return fields


def next_match(fields: Fields, after_ms: int) -> Optional[int]:
    """Epoch ms of the first local minute strictly after `after_ms`'s minute
    that matches, within a year; None past that."""
    minutes, hours, doms, months, dows = fields
    all_dom, all_dow = len(doms) == 31, len(dows) == 7
    dom_set, dow_set, month_set = set(doms), set(dows), set(months)

    def day_ok(d: datetime) -> bool:
        wd = (d.weekday() + 1) % 7  # cron: Sunday = 0
        if all_dom and all_dow:
            return True
        if all_dom:
            return wd in dow_set
        if all_dow:
            return d.day in dom_set
        return d.day in dom_set or wd in dow_set

    start = datetime.fromtimestamp((after_ms // 60000 + 1) * 60)
    day = start.replace(hour=0, minute=0)
    for _ in range(_HORIZON_DAYS + 1):
        if day.month in month_set and day_ok(day):
            for h in hours:
                for mi in minutes:
                    cand = day.replace(hour=h, minute=mi)
                    if cand < start:
                        continue
                    ms = int(time.mktime(cand.timetuple())) * 1000
                    if ms > after_ms:
                        return ms
        day += timedelta(days=1)
    return None


def _frac(task_id: str) -> float:
    m = re.match(r"[0-9a-fA-F]+", task_id[:8])
    return int(m.group(0), 16) / 4294967296 if m else 0.0


def next_fire_ms(cron: str, recurring: bool, task_id: str, now_ms: int) -> Optional[int]:
    fields = parse_cron(cron)
    if fields is None:
        return None
    frac = _frac(task_id)
    if recurring:
        slot = next_match(fields, now_ms - _RECURRING_CAP_MS)
        while slot is not None:
            nxt = next_match(fields, slot)
            offset = 0 if nxt is None else int(min(frac * _RECURRING_FRAC * (nxt - slot), _RECURRING_CAP_MS))
            if slot + offset > now_ms:
                return slot + offset
            slot = nxt
        return None
    slot = next_match(fields, now_ms - _ONE_SHOT_MAX_MS)
    if slot is None or slot - now_ms > _ONE_SHOT_OVERDUE_MS:
        return None
    if datetime.fromtimestamp(slot / 1000).minute % _ONE_SHOT_MINUTE_MOD == 0:
        slot -= int(frac * _ONE_SHOT_MAX_MS)
    return slot


def scheduled_tasks(raw: Any, now_ms: Optional[int] = None) -> Optional[list[dict[str, Any]]]:
    """The hook's `session_crons`, normalized for the wire; None when the CLI
    did not send the list at all (absent is not "none scheduled")."""
    if not isinstance(raw, list):
        return None
    now = int(time.time() * 1000) if now_ms is None else now_ms
    out: list[dict[str, Any]] = []
    for t in raw[:MAX_TASKS]:
        if not isinstance(t, dict):
            continue
        tid, cron = t.get("id"), t.get("schedule") or t.get("cron")
        if not isinstance(tid, str) or not tid or not isinstance(cron, str):
            continue
        recurring = bool(t.get("recurring"))
        prompt = t.get("prompt")
        try:
            nxt = next_fire_ms(cron, recurring, tid, now)
        except (ValueError, OverflowError, OSError):
            nxt = None
        out.append({
            "id": tid[:64], "schedule": cron[:120], "recurring": recurring,
            "prompt": prompt[:PROMPT_MAX] if isinstance(prompt, str) else "",
            "next_fire_at": nxt,
        })
    return out


def local_tz() -> dict[str, Any]:
    """What the cron fields mean: the daemon's zone, as the browser needs it
    to say "VPS time" when it is not its own."""
    now = datetime.now().astimezone()
    off = now.utcoffset()
    return {"name": now.tzname() or "", "offset_min": int(off.total_seconds() // 60) if off else 0}
