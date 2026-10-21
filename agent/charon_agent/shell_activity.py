"""When has a shell FINISHED something? (agent >= 0.106.0, CLAUDE.md §14.42)

A pure state machine fed by `AgentShell` (keystrokes, resizes, PTY output, a
1 s tick) that returns what to emit. Its only I/O is the three `/proc` probes
it is built with, so the tests drive every case with fakes and a fake clock.

The invariant: a "finished" alert ANSWERS A SUBMIT. Work starts when the user
sends Enter (a command line, a message to claude/codex, an answer to a
prompt). Output nobody asked for never opens a job: a TUI repainting itself
after a resize (every device that opens the shell resizes it), the echo of
typing, a background job's log, the terminal answering a query.

A job ends one of two ways:
  · its COMMAND returned to the prompt: the terminal's foreground process
    group (`tpgid`, /proc/<bash>/stat) left the group the Enter reached and
    the prompt came back. Exact for any command, silent or chatty, however
    long. Announced if it ran >= COMMAND_MIN_S and the user did not end it
    (a key within USER_END_GUARD_S: Ctrl-C, `q`, `/exit`).
  · the PROGRAM it was typed into stays in the foreground reading the
    keyboard raw (claude, codex, a REPL, ssh, tmux): it answered for
    >= TURN_MIN_S after the Enter, then stayed quiet QUIET_S with no key.
    A cooked-mode foreground (npm install, a script, `sleep`) never ends on
    silence — only on its return to the prompt.
Without a foreground view (no /proc) every job takes the second path.
"""
from __future__ import annotations

import os
import re
import termios
from dataclasses import dataclass
from typing import Any, Callable, Optional

QUIET_S = 6.0            # an interactive program's answer is over after this much silence
TURN_MIN_S = 5.0         # …and was worth announcing if it lasted this long
COMMAND_MIN_S = 10.0     # a command that returned to the prompt after this long
USER_END_GUARD_S = 3.0   # a key this close to the end = the user ended it (and is there)
ECHO_GUARD_S = 1.0       # output this soon after input is its echo, not work
REDRAW_GUARD_S = 1.5     # output this soon after a resize is a repaint, not work
BUSY_SETTLE_S = 1.5      # quiet gap before the "busy" dot clears
PROMPT_TICKS = 2         # consecutive ticks at the prompt before a command counts as done
PENDING_MAX_S = 1800.0   # an interactive submit nothing answered is forgotten after this

# Input the TERMINAL sends on its own (device attributes, cursor position,
# focus in/out, colour and mode reports): no human, no submit. Its own echo
# still counts as echo.
_TERMINAL_REPORT = re.compile(
    r"(?:\x1b\[[0-9;?>$]*[cnRIOy]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))+\Z"
)

ForegroundProbe = Callable[[], Optional[tuple[int, int]]]
RawProbe = Callable[[], Optional[bool]]
NameProbe = Callable[[int], Optional[str]]


@dataclass
class _Job:
    submitted: float            # the Enter that opened it
    started: float              # when its foreground program started (earlier when typed into one)
    fg0: Optional[int]          # foreground group the Enter reached (None = no foreground view)
    fg: Optional[int]           # last foreground group seen
    command: Optional[str] = None
    moved: bool = False         # the foreground left fg0 at some point
    work: Optional[float] = None    # last output that answered it
    prompt_since: Optional[float] = None
    prompt_ticks: int = 0


class ShellActivity:
    """One per shell. `input`/`resize`/`output` record, `tick` decides.

    Returned events: ("status", "busy"|"active") for the live dot, and
    ("finished", {...}) for the alert (`reason` "command"|"turn")."""

    def __init__(self, foreground: ForegroundProbe, raw: RawProbe, name: NameProbe) -> None:
        self._foreground = foreground
        self._raw = raw
        self._name = name
        self.job: Optional[_Job] = None
        self.busy = False
        self._last_input = float("-inf")    # any input: what output may be the echo of
        self._last_key = float("-inf")      # a human's input: presence
        self._last_resize = float("-inf")
        self._last_output = float("-inf")   # last output counted as work

    # ── recording ─────────────────────────────────────────────────────────

    def input(self, data: str, now: float) -> None:
        self._last_input = now
        if _TERMINAL_REPORT.match(data):
            return
        self._last_key = now
        if "\r" not in data and "\n" not in data:
            return
        fg = self._foreground()
        cur = fg[0] if fg else None
        prev = self.job
        started, command = now, None
        if prev is not None and fg is not None and cur != fg[1] and cur == prev.fg:
            # Typed into the program the open job already watches (a message
            # to claude, `y` to a script): the same program, the same start.
            started, command = prev.started, prev.command
        self.job = _Job(submitted=now, started=started, fg0=cur, fg=cur, command=command)

    def resize(self, now: float) -> None:
        self._last_resize = now

    def output(self, now: float) -> Optional[tuple[str, Any]]:
        if now - self._last_input < ECHO_GUARD_S or now - self._last_resize < REDRAW_GUARD_S:
            return None
        self._last_output = now
        if self.job is not None:
            self.job.work = now
        if self.busy:
            return None
        self.busy = True
        return ("status", "busy")

    def adopt(self, now: float) -> None:
        """Re-attached to a shell already running a non-interactive command
        (the agent restarted under a build): watch for its return to the
        prompt as if it had just been typed."""
        if self.job is not None:
            return
        fg = self._foreground()
        if fg is None or fg[0] == fg[1] or self._raw() is not False:
            return
        self.job = _Job(submitted=now, started=now, fg0=fg[1], fg=fg[0],
                        command=self._name(fg[0]), moved=True)

    # ── deciding ──────────────────────────────────────────────────────────

    def tick(self, now: float) -> list[tuple[str, Any]]:
        out: list[tuple[str, Any]] = []
        if self.busy and now - self._last_output >= BUSY_SETTLE_S:
            self.busy = False
            out.append(("status", "active"))
        job = self.job
        if job is None:
            return out
        fg = self._foreground() if job.fg0 is not None else None
        if fg is not None:
            cur, shell = fg
            if cur != job.fg:
                job.fg = cur
            if cur != shell and job.command is None:
                job.command = self._name(cur)
            if cur != job.fg0:
                job.moved = True
            if cur == shell:
                if job.prompt_since is None:
                    job.prompt_since = now
                job.prompt_ticks += 1
            else:
                job.prompt_since, job.prompt_ticks = None, 0
            if job.prompt_ticks >= PROMPT_TICKS:
                # Back at the prompt. Nothing seen running = an instant
                # command or an empty line: nothing to announce.
                self.job = None
                ended = job.prompt_since if job.prompt_since is not None else now
                if job.moved or job.fg0 != shell:
                    ran = ended - job.started
                    if ran >= COMMAND_MIN_S and self._last_key < ended - USER_END_GUARD_S:
                        out.append(("finished", self._finished(job, "command", ran, now)))
                return out
            interactive = cur != shell and self._raw() is True
        else:
            interactive = True
        if not interactive:
            return out
        if job.work is None:
            if now - job.submitted >= PENDING_MAX_S:
                self.job = None
            return out
        if now - job.work >= QUIET_S and now - self._last_key >= QUIET_S:
            self.job = None
            worked = job.work - job.submitted
            if worked >= TURN_MIN_S:
                out.append(("finished", self._finished(job, "turn", worked, now)))
        return out

    def _finished(self, job: _Job, reason: str, seconds: float, now: float) -> dict[str, Any]:
        return {
            "reason": reason,
            "work_seconds": round(seconds, 1),
            "command": job.command,
            # Hubs older than 0.106.0 word the alert from these.
            "idle_seconds": round(max(0.0, now - (job.work or now)), 1),
            "burst_seconds": round(seconds, 1),
            "burst_bytes": 0,
        }


# ── /proc probes (Linux) ─────────────────────────────────────────────────────

def read_foreground(pid: int) -> Optional[tuple[int, int]]:
    """(foreground process group of pid's terminal, pid's own group)."""
    try:
        with open(f"/proc/{pid}/stat", "rb") as fh:
            data = fh.read()
    except OSError:
        return None
    end = data.rfind(b")")
    fields = data[end + 2:].split() if end >= 0 else []
    try:
        pgrp, tpgid = int(fields[2]), int(fields[5])
    except (IndexError, ValueError):
        return None
    return (tpgid, pgrp) if tpgid > 0 and pgrp > 0 else None


def tty_path(pid: int) -> Optional[str]:
    try:
        path = os.readlink(f"/proc/{pid}/fd/0")
    except OSError:
        return None
    return path if path.startswith("/dev/pts/") else None


def tty_is_raw(path: Optional[str]) -> Optional[bool]:
    """Whether the terminal's canonical (line) mode is OFF: a program reading
    keys one by one. Opened per call — never held: the holder learns that bash
    exited from the slave side closing."""
    if not path:
        return None
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOCTTY | os.O_NONBLOCK)
    except OSError:
        return None
    try:
        return not (termios.tcgetattr(fd)[3] & termios.ICANON)
    except termios.error:
        return None
    finally:
        os.close(fd)


def process_name(pid: int) -> Optional[str]:
    try:
        with open(f"/proc/{pid}/comm", "rb") as fh:
            raw = fh.read(64)
    except OSError:
        return None
    name = "".join(ch for ch in raw.decode("utf-8", "replace").strip() if ch.isprintable())
    return name[:32] or None
