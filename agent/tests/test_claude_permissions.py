"""Claude permission modes: what the PreToolUse hook and can_use_tool answer.

normal/acceptEdits are emulated by the hook in SDK `default`; `auto` is the
CLI's native auto mode (the hook stays silent); `bypass` allows in the hook AND
answers the CLI's own escalations in `_can_use_tool`. `plan` was retired.
"""
import asyncio
import os
import sys
import types
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from charon_agent.session import AgentSession, _sdk_permission_mode  # noqa: E402


class _Allow:
    def __init__(self, updated_input=None):
        self.updated_input = updated_input


class _Deny:
    def __init__(self, message=""):
        self.message = message


def _fake_sdk():
    sdk = types.ModuleType("claude_agent_sdk")
    sdk.PermissionResultAllow = _Allow
    sdk.PermissionResultDeny = _Deny
    return sdk


class ClaudePermissionModeTest(unittest.TestCase):
    def make(self, mode):
        self.events = []
        return AgentSession(
            "s1", cwd="/tmp", name="demo", permission_mode=mode,
            claude_session_id=None, emit=self.events.append,
            on_state_change=lambda: None,
        )

    def hook(self, session, tool, tool_input):
        return asyncio.run(session._pre_tool_use(
            {"tool_name": tool, "tool_input": tool_input}, "toolu_1", None))

    def test_sdk_mode_mapping(self):
        self.assertEqual(_sdk_permission_mode("auto"), "auto")
        for mode in ("normal", "acceptEdits", "bypass"):
            self.assertEqual(_sdk_permission_mode(mode), "default")

    def test_retired_plan_loads_as_normal(self):
        self.assertEqual(self.make("plan").permission_mode, "normal")
        self.assertEqual(self.make("bypass").permission_mode, "bypass")

    def test_auto_leaves_the_decision_to_the_cli_classifier(self):
        s = self.make("auto")
        self.assertEqual(self.hook(s, "Bash", {"command": "rm -rf build"}), {})
        self.assertFalse([e for e in self.events if e.get("event") == "permission_request"])

    def test_bypass_allows_in_the_hook(self):
        s = self.make("bypass")
        out = self.hook(s, "Bash", {"command": "rm -rf build"})
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "allow")

    def test_bypass_answers_cli_escalations_without_a_card(self):
        s = self.make("bypass")
        ctx = types.SimpleNamespace(tool_use_id="toolu_2",
                                    decision_reason="Dangerous rm operation")
        with mock.patch.dict(sys.modules, {"claude_agent_sdk": _fake_sdk()}):
            out = asyncio.run(s._can_use_tool("Bash", {"command": 'rm -f "$d/$a"'}, ctx))
        self.assertIsInstance(out, _Allow)
        self.assertFalse([e for e in self.events if e.get("event") == "permission_request"])

    def test_other_modes_put_cli_escalations_on_a_card(self):
        for mode in ("normal", "acceptEdits", "auto"):
            s = self.make(mode)
            ctx = types.SimpleNamespace(tool_use_id="toolu_3", decision_reason="x")

            async def run():
                task = asyncio.ensure_future(s._can_use_tool("Bash", {"command": "x"}, ctx))
                await asyncio.sleep(0)
                s._pending_perms["perm_toolu_3"].set_result(True)
                return await task

            with mock.patch.dict(sys.modules, {"claude_agent_sdk": _fake_sdk()}):
                out = asyncio.run(run())
            self.assertIsInstance(out, _Allow, mode)
            self.assertTrue([e for e in self.events if e.get("event") == "permission_request"], mode)


if __name__ == "__main__":
    unittest.main()
