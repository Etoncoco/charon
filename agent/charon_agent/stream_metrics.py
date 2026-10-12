"""Timed native SDK counters; never derive tokens from received text or bytes."""
from __future__ import annotations

import math
from typing import Any


def counter(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value) or value < 0 or int(value) != value:
        return None
    return int(value)


class TurnThroughput:
    def __init__(self) -> None:
        self.started_at: float | None = None
        self.finished_at: float | None = None

    def observe(self, payload: dict[str, Any], now: float) -> None:
        event = payload.get("event")
        if event == "status" and payload.get("status") == "thinking":
            if self.started_at is None or self.finished_at is not None:
                self.started_at, self.finished_at = now, None
        elif event == "stop" or event == "status" and payload.get("status") != "thinking":
            if self.started_at is not None and self.finished_at is None:
                self.finished_at = now
        elif event == "usage":
            # Adapters may supply a normalized counter when the SDK's ordinary
            # output_tokens describes one request rather than the whole turn.
            tokens = counter(payload.pop("_sdk_output_tokens", payload.get("output_tokens")))
            elapsed = payload.get("duration_ms") if payload.get("final") else None
            if elapsed is None and self.started_at is not None:
                end = now if self.finished_at is None else self.finished_at
                elapsed = int((end - self.started_at) * 1000)
            if tokens is not None and counter(elapsed) is not None and elapsed > 0:
                payload["sdk_throughput"] = {"output_tokens": tokens, "elapsed_ms": elapsed}
