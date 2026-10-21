"""shell_activity — when a shell has FINISHED something (CLAUDE.md §14.42).

Every case drives the pure state machine with a fake clock and fake /proc
probes; the last class checks the probes against a real bash in a real PTY.
"""
import os
import pty
import select
import shutil
import sys
import time
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from charon_agent.shell_activity import (  # noqa: E402
    COMMAND_MIN_S, QUIET_S, ShellActivity, process_name, read_foreground,
    tty_is_raw, tty_path,
)

SHELL = 100     # bash's own process group
CLAUDE = 200
NPM = 300


class Term:
    """The fake terminal: who is in the foreground, in which mode."""

    def __init__(self, proc: bool = True) -> None:
        self.proc = proc
        self.fg = SHELL
        self.raw = {SHELL: True, CLAUDE: True, NPM: False}
        self.names = {SHELL: "bash", CLAUDE: "claude", NPM: "npm install"}

    def foreground(self):
        return (self.fg, SHELL) if self.proc else None

    def is_raw(self):
        return self.raw.get(self.fg) if self.proc else None

    def name(self, pgid):
        return self.names.get(pgid)


class Run:
    def __init__(self, term: Term) -> None:
        self.term = term
        self.t = 1000.0
        self.a = ShellActivity(term.foreground, term.is_raw, term.name)
        self.events: list = []
        self.next_tick = self.t + 1.0

    def key(self, data: str) -> None:
        self.a.input(data, self.t)

    def out(self) -> None:
        ev = self.a.output(self.t)
        if ev:
            self.events.append(ev)

    def wait(self, seconds: float, *, output_every: float | None = None) -> None:
        """Advance the clock tick by tick (1 s), optionally streaming output."""
        end = self.t + seconds
        next_out = self.t + output_every if output_every else None
        while True:
            self.t = min(x for x in (end, self.next_tick, next_out) if x is not None)
            if next_out is not None and self.t >= next_out - 1e-9:
                self.out()
                next_out += output_every
            if self.t >= self.next_tick - 1e-9:
                self.events.extend(self.a.tick(self.t))
                self.next_tick += 1.0
            if self.t >= end - 1e-9:
                return

    def finished(self):
        return [v for k, v in self.events if k == "finished"]


class SubmitAnchors(unittest.TestCase):
    def test_typing_without_enter_never_alerts(self):
        r = Run(Term())
        for ch in "git commit -m 'a long message being typed'":
            r.key(ch)
            r.out()        # its echo
            r.wait(0.2)
        r.wait(30)
        self.assertEqual(r.finished(), [])

    def test_a_resize_repaint_is_neither_work_nor_busy(self):
        r = Run(Term())
        r.term.fg = CLAUDE
        r.a.resize(r.t)
        r.wait(1.2, output_every=0.1)   # claude repainting its whole transcript
        r.wait(60)
        self.assertEqual(r.finished(), [])
        self.assertNotIn(("status", "busy"), r.events)

    def test_output_nobody_asked_for_never_alerts(self):
        r = Run(Term())
        r.wait(20, output_every=0.5)     # a background job's log at the prompt
        r.wait(30)
        self.assertEqual(r.finished(), [])

    def test_terminal_reports_are_not_a_human(self):
        r = Run(Term())
        r.term.fg = CLAUDE
        r.key("hello\r")
        r.wait(1.5)
        r.wait(10, output_every=0.2)
        r.key("\x1b[I")                  # focus-in report while it answers
        r.key("\x1b[12;40R")             # cursor position report
        r.wait(QUIET_S + 2)
        self.assertEqual(len(r.finished()), 1)


class Commands(unittest.TestCase):
    def test_a_silent_long_command_alerts_when_the_prompt_returns(self):
        r = Run(Term())
        r.key("sleep 30\r")
        r.term.fg = NPM
        r.term.names[NPM] = "sleep"
        r.wait(30)
        r.term.fg = SHELL
        r.wait(3)
        [f] = r.finished()
        self.assertEqual(f["reason"], "command")
        self.assertEqual(f["command"], "sleep")
        self.assertGreaterEqual(f["work_seconds"], 29)

    def test_output_gaps_inside_a_command_are_not_its_end(self):
        r = Run(Term())
        r.key("npm install\r")
        r.term.fg = NPM
        r.wait(8, output_every=0.3)
        r.wait(15)                       # a long silent phase
        r.wait(8, output_every=0.3)
        self.assertEqual(r.finished(), [])
        r.term.fg = SHELL
        r.wait(3)
        [f] = r.finished()
        self.assertEqual((f["reason"], f["command"]), ("command", "npm install"))
        r.wait(60)
        self.assertEqual(len(r.finished()), 1)

    def test_a_quick_command_says_nothing(self):
        r = Run(Term())
        r.key("ls\r")
        r.out()
        r.wait(30)
        self.assertEqual(r.finished(), [])

    def test_a_short_command_says_nothing(self):
        r = Run(Term())
        r.key("git pull\r")
        r.term.fg = NPM
        r.wait(COMMAND_MIN_S - 3, output_every=1)
        r.term.fg = SHELL
        r.wait(5)
        self.assertEqual(r.finished(), [])

    def test_a_command_the_user_ended_says_nothing(self):
        r = Run(Term())
        r.key("tail -f log\r")
        r.term.fg = NPM
        r.wait(40, output_every=2)
        r.key("\x03")                    # Ctrl-C
        r.wait(0.3)
        r.term.fg = SHELL
        r.wait(5)
        self.assertEqual(r.finished(), [])

    def test_typing_into_a_running_command_keeps_its_start(self):
        r = Run(Term())
        r.key("./install.sh\r")
        r.term.fg = NPM
        r.wait(20, output_every=1)
        r.key("y\r")                     # answers its [y/N]
        r.wait(25, output_every=1)
        r.term.fg = SHELL
        r.wait(3)
        [f] = r.finished()
        self.assertGreaterEqual(f["work_seconds"], 44)

    def test_reattached_under_a_running_build(self):
        r = Run(Term())
        r.term.fg = NPM
        r.a.adopt(r.t)
        r.wait(20, output_every=1)
        r.term.fg = SHELL
        r.wait(3)
        self.assertEqual(len(r.finished()), 1)

    def test_reattached_to_an_idle_tui_adopts_nothing(self):
        r = Run(Term())
        r.term.fg = CLAUDE
        r.a.adopt(r.t)
        self.assertIsNone(r.a.job)


class InteractivePrograms(unittest.TestCase):
    def test_claude_answering_a_message_alerts_once(self):
        r = Run(Term())
        r.term.fg = CLAUDE
        for ch in "explain this":
            r.key(ch)
            r.out()
            r.wait(0.1)
        r.key("\r")
        r.wait(25, output_every=0.1)     # spinner, then the answer
        r.wait(QUIET_S + 1)
        [f] = r.finished()
        self.assertEqual((f["reason"], f["command"]), ("turn", "claude"))
        self.assertGreaterEqual(f["work_seconds"], 24)
        # Nothing afterwards, a repaint included.
        r.wait(60)
        r.a.resize(r.t)
        r.wait(1, output_every=0.1)
        r.wait(60)
        self.assertEqual(len(r.finished()), 1)

    def test_every_message_gets_its_own_alert(self):
        r = Run(Term())
        r.term.fg = CLAUDE
        for _ in range(3):
            r.key("next\r")
            r.wait(12, output_every=0.2)
            r.wait(QUIET_S + 1)
        self.assertEqual(len(r.finished()), 3)

    def test_a_quick_answer_says_nothing(self):
        r = Run(Term())
        r.term.fg = CLAUDE
        r.key("hi\r")
        r.wait(3, output_every=0.2)
        r.wait(30)
        self.assertEqual(r.finished(), [])

    def test_waits_while_the_user_types(self):
        r = Run(Term())
        r.term.fg = CLAUDE
        r.key("go\r")
        r.wait(15, output_every=0.2)
        for ch in "the next message, typed slowly":
            r.key(ch)
            r.wait(0.5)
        self.assertEqual(r.finished(), [])
        r.wait(QUIET_S + 1)               # walked away mid-sentence
        self.assertEqual(len(r.finished()), 1)

    def test_a_silent_computation_alerts_when_it_answers(self):
        r = Run(Term())
        r.term.fg = CLAUDE                # a REPL: raw, in the foreground
        r.key("time.sleep(30); print('x')\r")
        r.wait(30)
        r.out()
        r.wait(QUIET_S + 1)
        self.assertEqual(len(r.finished()), 1)

    def test_launched_with_a_prompt_from_the_shell(self):
        r = Run(Term())
        r.key("claude 'fix the tests'\r")
        r.term.fg = CLAUDE
        r.wait(40, output_every=0.2)
        r.wait(QUIET_S + 1)
        [f] = r.finished()
        self.assertEqual(f["reason"], "turn")

    def test_exiting_the_program_says_nothing(self):
        r = Run(Term())
        r.key("claude\r")
        r.term.fg = CLAUDE
        r.wait(2, output_every=0.2)       # its banner
        r.wait(600)
        r.key("/exit\r")
        r.wait(0.5)
        r.term.fg = SHELL
        r.wait(5)
        self.assertEqual(r.finished(), [])

    def test_without_proc_silence_ends_a_job(self):
        r = Run(Term(proc=False))
        r.key("make\r")
        r.wait(12, output_every=0.3)
        r.wait(QUIET_S + 1)
        self.assertEqual(len(r.finished()), 1)


class BusyDot(unittest.TestCase):
    def test_echo_is_not_busy_and_work_settles(self):
        r = Run(Term())
        r.key("a")
        r.out()
        self.assertEqual(r.events, [])
        r.wait(2)
        r.out()
        self.assertEqual(r.events, [("status", "busy")])
        r.wait(3)
        self.assertEqual(r.events[-1], ("status", "active"))


@unittest.skipUnless(sys.platform.startswith("linux") and shutil.which("bash")
                     and os.path.isdir("/proc/self"), "needs Linux /proc and bash")
class RealTerminal(unittest.TestCase):
    def test_probes_follow_bash_and_its_foreground(self):
        pid, fd = pty.fork()
        if pid == 0:
            os.environ["PS1"] = "$ "
            os.execvp("bash", ["bash", "--norc", "--noprofile", "-i"])

        def drain(seconds):
            end = time.time() + seconds
            while time.time() < end:
                if select.select([fd], [], [], 0.05)[0]:
                    try:
                        os.read(fd, 65536)
                    except OSError:
                        return

        try:
            drain(1.0)
            tty = tty_path(pid)
            self.assertIsNotNone(tty)
            fg, own = read_foreground(pid)
            self.assertEqual(fg, own)
            os.write(fd, b"sleep 3\r")
            drain(1.0)
            fg, own = read_foreground(pid)
            self.assertNotEqual(fg, own)
            self.assertEqual(process_name(fg), "sleep")
            self.assertIs(tty_is_raw(tty), False)
            drain(2.8)
            fg, own = read_foreground(pid)
            self.assertEqual(fg, own)
        finally:
            os.write(fd, b"exit\r")
            drain(0.3)
            try:
                os.kill(pid, 9)
            except ProcessLookupError:
                pass
            os.waitpid(pid, 0)
            os.close(fd)


if __name__ == "__main__":
    unittest.main()
