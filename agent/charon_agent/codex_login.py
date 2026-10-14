"""Codex ChatGPT login via the DEVICE-CODE flow (agent >= 0.16.0).

Why not `codex login`: on a headless VPS the default browser flow can't
complete — the OAuth callback targets localhost:1455 ON THE VPS. The
openai-codex SDK exposes the ChatGPT device-code flow instead:
start → {verification_url, user_code}; the user opens the URL from ANY
device, types the code, and the app-server itself persists the credentials
(~/.codex/auth.json) on completion — nothing to paste back.

The AsyncCodex client (and its `codex app-server` child) must stay ALIVE for
the whole attempt: the login_id is bound to that process. We therefore keep a
single module-level attempt (a 2nd start cancels the 1st) and close the
client only once the attempt leaves 'pending'.

RPCs (the hub POLLS status — no protocol events, no session binding):
    codex_login_start   {}            → {ok, login_id, verification_url, user_code}
    codex_login_status  {login_id}    → {ok, status: 'pending'|'success'|'error', error?}
    codex_login_cancel  {login_id}    → {ok}
    codex_auth_status   {}            → {ok, logged_in, email?, subscription_type?, auth_method?}
"""
from __future__ import annotations

from .account_profiles import profile_id, profile_env

import asyncio
import time
from typing import Any, Optional

from .codex_session import (
    CODEX_AVAILABLE,
    CODEX_IMPORT_ERROR,
    AsyncCodex,
    make_codex_config,
)

# Device codes expire server-side (~15 min). Reap our attempt a bit before so
# a forgotten modal never leaves an app-server child running for hours.
_TTL_S = 14 * 60


class _Attempt:
    def __init__(self, client: Any, handle: Any) -> None:
        self.client = client
        self.handle = handle
        self.login_id: str = handle.login_id
        self.verification_url: str = handle.verification_url
        self.user_code: str = handle.user_code
        self.status: str = "pending"        # pending | success | error
        self.error: Optional[str] = None
        self.started_at = time.time()
        self.task: Optional[asyncio.Task] = None


_current: Optional[_Attempt] = None
_attempts: dict[str, _Attempt] = {}


async def _close_client(client: Any) -> None:
    try:
        res = client.close()
        if asyncio.iscoroutine(res):
            await asyncio.wait_for(res, timeout=5.0)
    except Exception:
        pass


async def auth_status(account_profile: str = "default") -> dict[str, Any]:
    """Read the effective account; return only public identity metadata."""
    if not CODEX_AVAILABLE:
        return {"ok": False, "error": "Codex SDK unavailable"}
    client = None
    try:
        client = AsyncCodex(make_codex_config(env=profile_env("codex", account_profile) or None))
        response = await asyncio.wait_for(client.account(), timeout=20.0)
        account = getattr(response, "account", None)
        account = getattr(account, "root", account)
        out: dict[str, Any] = {"ok": True, "logged_in": account is not None}
        if account is not None:
            for attr, key in (("email", "email"), ("plan_type", "subscription_type"),
                              ("type", "auth_method")):
                value = getattr(account, attr, None)
                value = getattr(value, "value", value)
                if isinstance(value, str) and value:
                    out[key] = value
        return out
    except Exception:
        return {"ok": False, "error": "Could not read Codex account"}
    finally:
        if client is not None:
            await _close_client(client)


async def _abort(a: _Attempt) -> None:
    """Cancel a pending attempt + tear its client down. Idempotent."""
    if a.task is not None and not a.task.done():
        a.task.cancel()
    if a.status == "pending":
        a.status = "error"
        a.error = a.error or "cancelled"
        try:
            await asyncio.wait_for(a.handle.cancel(), timeout=5.0)
        except Exception:
            pass
    await _close_client(a.client)


async def _watch(a: _Attempt) -> None:
    """Background waiter: resolves the attempt when the user completes (or
    the code expires server-side). Never raises out."""
    try:
        note = await a.handle.wait()
        if bool(getattr(note, "success", False)):
            a.status = "success"
        else:
            a.status = "error"
            a.error = getattr(note, "error", None) or "login failed"
    except asyncio.CancelledError:
        raise
    except Exception as e:
        if a.status == "pending":
            a.status = "error"
            a.error = f"{type(e).__name__}: {e}"
    finally:
        if a.status != "pending":
            # Credentials (if any) are already persisted by the app-server.
            await _close_client(a.client)


async def start(account_profile: str = "default") -> dict[str, Any]:
    """Start a fresh device-code login attempt (cancelling any previous)."""
    global _current
    if not CODEX_AVAILABLE:
        return {"ok": False, "error": CODEX_IMPORT_ERROR or "openai-codex not importable"}
    pid = profile_id(account_profile)
    prev = _attempts.pop(pid, None)
    if pid == "default":
        prev, _current = _current, None
    if prev is not None:
        await _abort(prev)
    client = None
    try:
        client = AsyncCodex(make_codex_config(env=profile_env("codex", account_profile) or None))
        handle = await client.login_chatgpt_device_code()
        a = _Attempt(client, handle)
        a.task = asyncio.create_task(_watch(a))
        _attempts[pid] = a
        if pid == "default":
            _current = a
        return {
            "ok": True,
            "login_id": a.login_id,
            "verification_url": a.verification_url,
            "user_code": a.user_code,
        }
    except Exception as e:
        if client is not None:
            await _close_client(client)
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


async def status(login_id: str, account_profile: str = "default") -> dict[str, Any]:
    """Poll an attempt. Unknown id → ok:False (hub shows 'attempt lost')."""
    global _current
    pid = profile_id(account_profile)
    a = _current if pid == "default" else _attempts.get(pid)
    if a is None or a.login_id != login_id:
        return {"ok": False, "error": "login attempt not found (agent restarted?)"}
    if a.status == "pending" and time.time() - a.started_at > _TTL_S:
        a.error = "device code expired"
        _attempts.pop(pid, None)
        if pid == "default":
            _current = None
        await _abort(a)
        return {"ok": True, "status": "error", "error": "device code expired"}
    out: dict[str, Any] = {"ok": True, "status": a.status}
    if a.error:
        out["error"] = a.error
    return out


async def cancel(login_id: str, account_profile: str = "default") -> dict[str, Any]:
    """Cancel an attempt. Idempotent — unknown id is a no-op success."""
    global _current
    pid = profile_id(account_profile)
    a = _current if pid == "default" else _attempts.get(pid)
    if a is None or a.login_id != login_id:
        return {"ok": True}
    _attempts.pop(pid, None)
    if pid == "default":
        _current = None
    await _abort(a)
    return {"ok": True}


async def cancel_profile(account_profile: str = 'default') -> None:
    pid = profile_id(account_profile)
    current = _current if pid == 'default' else _attempts.get(pid)
    if current is not None:
        await cancel(current.login_id, pid)
