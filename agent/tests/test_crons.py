"""Tests for charon_agent.crons — when a session's scheduled tasks fire next.

stdlib unittest only. Run with:
    python3 agent/tests/test_crons.py

The times are the CLI's own: a fixture that drifts from its scheduler makes
the hub announce a fire that never comes. The expectations below are what
`CronList` printed for the same tasks (Europe/Paris).
"""
import asyncio
import os
import sys
import time
import types
import unittest
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from charon_agent import crons  # noqa: E402
from charon_agent.crons import next_fire_ms, next_match, parse_cron, scheduled_tasks  # noqa: E402
from charon_agent.session import AgentSession  # noqa: E402


def ms(y, mo, d, h, mi, s=0):
    return int(time.mktime(datetime(y, mo, d, h, mi, s).timetuple())) * 1000


class _Tz(unittest.TestCase):
    def setUp(self):
        self._tz = os.environ.get("TZ")
        os.environ["TZ"] = "Europe/Paris"
        time.tzset()

    def tearDown(self):
        if self._tz is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = self._tz
        time.tzset()


class ParseTest(_Tz):
    def test_fields(self):
        self.assertEqual(parse_cron("37 9 28 10 *")[:4], [[37], [9], [28], [10]])
        self.assertEqual(parse_cron("*/15 * * * *")[0], [0, 15, 30, 45])
        self.assertEqual(parse_cron("0 9 * * 1-5")[4], [1, 2, 3, 4, 5])
        # Sunday is 0 and 7, as in the CLI.
        self.assertEqual(parse_cron("0 9 * * 7")[4], [0])
        self.assertEqual(parse_cron("0 9 * * 5-7")[4], [0, 5, 6])

    def test_refuses_what_the_cli_refuses(self):
        for bad in ("", "* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *",
                    "*/0 * * * *", "5-1 * * * *", "MON * * * *", "* * * * 8"):
            self.assertIsNone(parse_cron(bad), bad)


class NextMatchTest(_Tz):
    def test_strictly_after_the_minute(self):
        f = parse_cron("* * * * *")
        self.assertEqual(next_match(f, ms(2026, 10, 28, 10, 0, 30)), ms(2026, 10, 28, 10, 1))
        self.assertEqual(next_match(f, ms(2026, 10, 28, 10, 0)), ms(2026, 10, 28, 10, 1))

    def test_day_of_month_or_day_of_week(self):
        # Vixie cron: both restricted ⇒ either matches.
        f = parse_cron("0 9 1 * 1")
        # Wed 28 Oct 2026 → Sun 1 Nov 09:00 (the 1st) beats Mon 2 Nov.
        self.assertEqual(next_match(f, ms(2026, 10, 28, 12, 0)), ms(2026, 11, 1, 9, 0))
        weekdays = parse_cron("30 8 * * 1-5")
        # Fri 30 Oct 2026 09:00 → Mon 2 Nov 08:30.
        self.assertEqual(next_match(weekdays, ms(2026, 10, 30, 9, 0)), ms(2026, 11, 2, 8, 30))

    def test_across_dst(self):
        # Paris leaves summer time on Sun 25 Oct 2026: 09:00 is still 09:00 local.
        f = parse_cron("0 9 * * *")
        got = next_match(f, ms(2026, 10, 24, 12, 0))
        self.assertEqual(datetime.fromtimestamp(got / 1000), datetime(2026, 10, 25, 9, 0))

    def test_nothing_within_a_year(self):
        self.assertIsNone(next_match(parse_cron("0 0 31 2 *"), ms(2026, 10, 28, 0, 0)))


class NextFireTest(_Tz):
    NOW = None

    def setUp(self):
        super().setUp()
        self.now = ms(2026, 10, 28, 10, 51)

    def test_recurring_daily_carries_the_cli_offset(self):
        # CronList: "4a0671cb — Every day at 8:07 PM … next run Oct 28 8:37pm".
        self.assertEqual(next_fire_ms("7 20 * * *", True, "4a0671cb", self.now), ms(2026, 10, 28, 20, 37))

    def test_recurring_inside_its_offset_window_is_still_today(self):
        self.assertEqual(next_fire_ms("7 20 * * *", True, "4a0671cb", ms(2026, 10, 28, 20, 20)),
                         ms(2026, 10, 28, 20, 37))
        self.assertEqual(next_fire_ms("7 20 * * *", True, "4a0671cb", ms(2026, 10, 28, 20, 38)),
                         ms(2026, 10, 29, 20, 37))

    def test_recurring_offset_is_a_fraction_of_half_the_period(self):
        # 0x80000000 / 2^32 = 0.5 → 0.5 × 0.5 × 10 min = 2.5 min after each
        # slot: the 10:50 slot has not fired yet at 10:51.
        self.assertEqual(next_fire_ms("*/10 * * * *", True, "80000000", self.now),
                         ms(2026, 10, 28, 10, 52, 30))
        # A non-hex id offsets nothing (the CLI's NaN → 0).
        self.assertEqual(next_fire_ms("*/10 * * * *", True, "zzzzzzzz", self.now), ms(2026, 10, 28, 11, 0))

    def test_one_shot_exact_unless_on_the_half_hour(self):
        # CronList: "c8eeae28 — 13 19 29 10 * (one-shot) … next run Oct 29 7:13pm".
        self.assertEqual(next_fire_ms("13 19 29 10 *", False, "c8eeae28", self.now), ms(2026, 10, 29, 19, 13))
        # On :30 the CLI fires up to 90 s early (here half of it).
        self.assertEqual(next_fire_ms("30 21 28 10 *", False, "80000000", self.now),
                         ms(2026, 10, 28, 21, 30) - 45_000)

    def test_one_shot_whose_time_passed_is_unknown_not_next_year(self):
        self.assertIsNone(next_fire_ms("37 9 28 10 *", False, "289396d5", self.now))

    def test_invalid_cron(self):
        self.assertIsNone(next_fire_ms("nope", True, "4a0671cb", self.now))


class WireTest(_Tz):
    def test_absent_is_not_empty(self):
        self.assertIsNone(scheduled_tasks(None))
        self.assertIsNone(scheduled_tasks({"id": "x"}))
        self.assertEqual(scheduled_tasks([]), [])

    def test_normalizes_and_bounds(self):
        now = ms(2026, 10, 28, 10, 51)
        got = scheduled_tasks([
            {"id": "4a0671cb", "schedule": "7 20 * * *", "recurring": True, "prompt": "p" * 5000},
            {"id": "", "schedule": "* * * * *"}, "junk", {"id": "x", "schedule": None},
            {"id": "bad", "schedule": "not a cron", "recurring": False, "prompt": 3},
        ], now)
        self.assertEqual(len(got), 2)
        self.assertEqual(got[0]["next_fire_at"], ms(2026, 10, 28, 20, 37))
        self.assertEqual(len(got[0]["prompt"]), crons.PROMPT_MAX)
        self.assertEqual(got[1], {"id": "bad", "schedule": "not a cron", "recurring": False,
                                  "prompt": "", "next_fire_at": None})

    def test_local_tz(self):
        tz = crons.local_tz()
        self.assertIn(tz["name"], ("CET", "CEST"))
        self.assertIn(tz["offset_min"], (60, 120))


class HookTest(_Tz):
    def _session(self):
        out = []
        s = types.SimpleNamespace(_emit=lambda ev, **f: out.append({"event": ev, **f}))
        return s, out

    def test_stop_hook_lists_the_tasks(self):
        s, out = self._session()
        asyncio.run(AgentSession._on_stop_hook(s, {
            "background_tasks": [],
            "session_crons": [{"id": "4a0671cb", "schedule": "7 20 * * *", "recurring": True, "prompt": "recheck"}],
        }, None, None))
        self.assertEqual(out[0]["event"], "turn_end")
        self.assertEqual([t["id"] for t in out[0]["scheduled_tasks"]], ["4a0671cb"])
        self.assertIn("offset_min", out[0]["schedule_tz"])
        self.assertNotIn("session_crons", out[0])

    def test_stop_hook_without_the_list_says_nothing_about_it(self):
        s, out = self._session()
        asyncio.run(AgentSession._on_stop_hook(s, {"background_tasks": []}, None, None))
        self.assertNotIn("scheduled_tasks", out[0])


class UnpromptedTurnTest(unittest.TestCase):
    """A turn the CLI opens by itself: a scheduled task's fire carries no
    message of its own, so the agent says the turn was unprompted and the hub
    names the task that was due."""

    def _session(self, notified=False):
        out = []
        s = types.SimpleNamespace(_emit=lambda ev, **f: out.append({"event": ev, **f}), _bg_notified=notified)
        return s, out

    @staticmethod
    def _ev(name, **attrs):
        return type(name, (), attrs)()

    def test_a_stream_opener_is_reported(self):
        s, out = self._session()
        AgentSession._note_unprompted_turn(s, self._ev("StreamEvent"))
        self.assertEqual(out, [{"event": "unprompted_turn"}])

    def test_a_background_wake_up_is_not(self):
        s, out = self._session(notified=True)
        AgentSession._note_unprompted_turn(s, self._ev("StreamEvent"))
        self.assertEqual(out, [])
        # Consumed: the next unprompted turn is judged on its own.
        self.assertFalse(s._bg_notified)
        AgentSession._note_unprompted_turn(s, self._ev("AssistantMessage"))
        self.assertEqual(out, [{"event": "unprompted_turn"}])

    def test_a_prompt_carried_by_the_opener_rides_along(self):
        s, out = self._session()
        AgentSession._note_unprompted_turn(s, self._ev("UserMessage", content="[Recheck] look", origin=None))
        self.assertEqual(out, [{"event": "unprompted_turn", "prompt": "[Recheck] look"}])

    def test_peer_and_task_notification_openers_speak_for_themselves(self):
        s, out = self._session()
        for kind in ("peer", "task-notification"):
            origin = types.SimpleNamespace(kind=kind)
            AgentSession._note_unprompted_turn(s, self._ev("UserMessage", content="x", origin=origin))
        self.assertEqual(out, [])


if __name__ == "__main__":
    unittest.main()
