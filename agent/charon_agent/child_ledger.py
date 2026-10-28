"""Provider children must not outlive the daemon that spawned them (§14.113).

`KillMode=process` (§14.44) is what lets shell holders survive a restart, and
it applies to EVERY process in the unit. A daemon that exits cleanly stops its
sessions first, so their CLIs (Claude, the Codex app-server, the Cursor bridge,
language servers) go with it. A daemon that is SIGKILLed (OOM, `kill -9`)
cannot: its children are reparented to the user manager and carry on. A Claude
CLI in the middle of a turn keeps running its tool calls (invisibly, nobody
reads its stdout any more) while the next daemon resumes the SAME session: two
writers on one transcript, and the ghost can keep launching jobs.

Nothing in the kernel tells a new daemon who its predecessor's children were,
so the daemon writes them down: every few seconds it lists its direct children
that share its session id (holders `setsid`, so they never qualify) and records
pid + start time in `children.json` beside state.json. At boot (after the
socket check proved no other daemon owns this instance, §14.97, and before any
session is restored) every recorded child still alive with the same start time
and the same session id is a ghost: SIGTERM, then SIGKILL after a grace period.

Never a pattern match on command lines: a user's own `claude` in a shell, a
second hub's agent (§14.70) and a session's background jobs all look alike.
The ledger names only processes this instance spawned itself. Their own
children (a tool's job) are not ours to judge and are left alone.
"""
from __future__ import annotations

import asyncio
import json
import os
import signal
import sys
import time
from pathlib import Path
from typing import Any

LEDGER_NAME = "children.json"
RECORD_INTERVAL_S = 5.0
TERM_GRACE_S = 3.0
PROC = Path("/proc")


def proc_stat(pid: int, proc: Path = PROC) -> tuple[str, int, int, int] | None:
    """(state, ppid, sid, start ticks) of `pid`, or None once it is gone."""
    try:
        raw = (proc / str(pid) / "stat").read_text()
        # comm (field 2) is parenthesised and may itself hold spaces or ')'.
        fields = raw[raw.rindex(")") + 2:].split()
        return fields[0], int(fields[1]), int(fields[3]), int(fields[19])
    except (OSError, ValueError, IndexError):
        return None


def _comm(pid: int, proc: Path) -> str:
    try:
        return (proc / str(pid) / "comm").read_text().strip() or "?"
    except OSError:
        return "?"


def _boot_id(proc: Path) -> str:
    try:
        return (proc / "sys" / "kernel" / "random" / "boot_id").read_text().strip()
    except OSError:
        return ""


def children_of(pid: int, proc: Path = PROC) -> set[int]:
    """Direct children of `pid`.

    A child is listed under the THREAD that forked it, so every task is read.
    Kernels built without CONFIG_PROC_CHILDREN have no such file: scan every
    pid's ppid instead.
    """
    found: set[int] = set()
    supported = False
    try:
        tasks = list((proc / str(pid) / "task").iterdir())
    except OSError:
        tasks = []
    for task in tasks:
        try:
            text = (task / "children").read_text()
        except OSError:
            continue
        supported = True
        found.update(int(x) for x in text.split() if x.isdigit())
    if supported:
        return found
    try:
        entries = list(proc.iterdir())
    except OSError:
        return found
    for entry in entries:
        if entry.name.isdigit():
            st = proc_stat(int(entry.name), proc)
            if st is not None and st[1] == pid:
                found.add(int(entry.name))
    return found


def _alive(pid: int, start: int, proc: Path) -> bool:
    st = proc_stat(pid, proc)
    return st is not None and st[0] != "Z" and st[3] == start


class ChildLedger:
    """Keeps `children.json` naming this daemon's own provider children."""

    def __init__(self, state_dir: Path, *, proc: Path = PROC) -> None:
        self.path = Path(state_dir) / LEDGER_NAME
        self._proc = proc
        self._written: str | None = None

    def snapshot(self, pid: int | None = None) -> dict[str, Any] | None:
        me = os.getpid() if pid is None else pid
        mine = proc_stat(me, self._proc)
        if mine is None:
            return None  # no /proc: nothing to record, nothing to reap
        kids = []
        for child in sorted(children_of(me, self._proc)):
            st = proc_stat(child, self._proc)
            # A child in its own session detached on purpose (shell holders).
            if st is None or st[0] == "Z" or st[2] != mine[2]:
                continue
            kids.append({"pid": child, "start": st[3], "comm": _comm(child, self._proc)})
        return {
            "boot_id": _boot_id(self._proc),
            "daemon": {"pid": me, "start": mine[3], "sid": mine[2]},
            "children": kids,
        }

    def record(self) -> bool:
        """Rewrite the ledger when its content changed. Never raises."""
        try:
            snap = self.snapshot()
            if snap is None:
                return False
            text = json.dumps(snap, sort_keys=True)
            if text == self._written:
                return False
            tmp = self.path.with_name(self.path.name + ".tmp")
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as fh:
                fh.write(text)
            os.replace(tmp, self.path)
            self._written = text
            return True
        except Exception as e:
            print(f"[children] ledger write failed: {e}", file=sys.stderr, flush=True)
            return False

    async def loop(self, interval_s: float = RECORD_INTERVAL_S) -> None:
        while True:
            self.record()
            await asyncio.sleep(interval_s)


def orphans(state_dir: Path, *, proc: Path = PROC) -> list[dict[str, Any]]:
    """The previous daemon's recorded children that are still running."""
    try:
        ledger = json.loads((Path(state_dir) / LEDGER_NAME).read_text())
        daemon = ledger["daemon"]
        d_pid, d_start, d_sid = int(daemon["pid"]), int(daemon["start"]), int(daemon["sid"])
        recorded = list(ledger.get("children") or [])
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        return []
    if not ledger.get("boot_id") or ledger.get("boot_id") != _boot_id(proc):
        return []  # a reboot took them all, and pids/start times restarted
    if _alive(d_pid, d_start, proc):
        return []  # that daemon still runs: its children are its own
    me = os.getpid()
    found = []
    for child in recorded:
        try:
            pid, start = int(child["pid"]), int(child["start"])
        except (TypeError, KeyError, ValueError):
            continue
        st = proc_stat(pid, proc)
        if (st is None or st[0] == "Z" or st[3] != start or st[2] != d_sid
                or pid == me or st[1] == me):
            continue
        found.append({"pid": pid, "start": start, "comm": str(child.get("comm") or "?")})
    return found


def _signal(pid: int, sig: int) -> None:
    try:
        os.kill(pid, sig)
    except OSError:
        pass


async def reap_orphans(state_dir: Path, *, grace_s: float = TERM_GRACE_S,
                       proc: Path = PROC) -> list[dict[str, Any]]:
    """SIGTERM every orphan, SIGKILL the ones still there after `grace_s`."""
    targets = orphans(state_dir, proc=proc)
    for t in targets:
        _signal(t["pid"], signal.SIGTERM)
    deadline = time.monotonic() + grace_s
    alive = targets
    while alive and time.monotonic() < deadline:
        await asyncio.sleep(0.1)
        alive = [t for t in alive if _alive(t["pid"], t["start"], proc)]
    for t in alive:
        _signal(t["pid"], signal.SIGKILL)
    return targets
