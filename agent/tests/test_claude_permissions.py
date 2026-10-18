"""Claude permission modes: what the PreToolUse hook and can_use_tool answer.

normal / acceptEdits / auto ARE the CLI's own modes: the hook stays silent and
whatever still needs a person reaches `_can_use_tool`, which puts a card up
with the CLI's reason and its own "don't ask again" suggestions. `bypass`
allows in the hook AND answers those escalations. `plan` was retired.
"""
import asyncio
import os
import sys
import types
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from charon_agent.session import AgentSession, _rule_string, _sdk_permission_mode  # noqa: E402


class _Allow:
    def __init__(self, updated_input=None, updated_permissions=None):
        self.updated_input = updated_input
        self.updated_permissions = updated_permissions


class _Deny:
    def __init__(self, message=""):
        self.message = message


class _Rule:
    def __init__(self, tool_name, rule_content=None):
        self.tool_name = tool_name
        self.rule_content = rule_content


class _Update:
    """Shape of claude_agent_sdk.PermissionUpdate."""

    def __init__(self, type, rules=None, behavior=None, mode=None, destination=None):
        self.type, self.rules, self.behavior = type, rules, behavior
        self.mode, self.destination = mode, destination

    def to_dict(self):
        out = {"type": self.type, "destination": self.destination}
        if self.rules is not None:
            out["rules"] = [{"toolName": r.tool_name, "ruleContent": r.rule_content}
                            for r in self.rules]
            out["behavior"] = self.behavior
        if self.mode is not None:
            out["mode"] = self.mode
        return out


def _fake_sdk():
    sdk = types.ModuleType("claude_agent_sdk")
    sdk.PermissionResultAllow = _Allow
    sdk.PermissionResultDeny = _Deny
    return sdk


class ClaudePermissionModeTest(unittest.TestCase):
    def make(self, mode, config=None):
        self.events = []
        s = AgentSession(
            "s1", cwd="/tmp", name="demo", permission_mode=mode,
            claude_session_id=None, emit=self.events.append,
            on_state_change=lambda: None, session_config=config,
        )

        async def _no_save():
            return None
        s._save_state = _no_save
        return s

    def hook(self, session, tool, tool_input):
        return asyncio.run(session._pre_tool_use(
            {"tool_name": tool, "tool_input": tool_input}, "toolu_1", None))

    def ask(self, session, ctx, answer):
        """Run `_can_use_tool` until it raises a card, then answer it."""
        async def run():
            task = asyncio.ensure_future(session._can_use_tool("Bash", {"command": "x"}, ctx))
            await asyncio.sleep(0)
            perm_id = "perm_" + ctx.tool_use_id
            self.assertTrue(session.respond_permission(perm_id, **answer))
            return await task

        with mock.patch.dict(sys.modules, {"claude_agent_sdk": _fake_sdk()}):
            return asyncio.run(run())

    def cards(self):
        return [e for e in self.events if e.get("event") == "permission_request"]

    def test_sdk_mode_mapping(self):
        self.assertEqual(_sdk_permission_mode("normal"), "default")
        self.assertEqual(_sdk_permission_mode("acceptEdits"), "acceptEdits")
        self.assertEqual(_sdk_permission_mode("auto"), "auto")
        self.assertEqual(_sdk_permission_mode("bypass"), "default")

    def test_retired_plan_loads_as_normal(self):
        self.assertEqual(self.make("plan").permission_mode, "normal")
        self.assertEqual(self.make("bypass").permission_mode, "bypass")

    def test_native_modes_leave_the_decision_to_the_cli(self):
        for mode in ("normal", "acceptEdits", "auto"):
            s = self.make(mode)
            self.assertEqual(self.hook(s, "Bash", {"command": "rm -rf build"}), {}, mode)
            self.assertEqual(self.hook(s, "Write", {"file_path": "/tmp/x"}), {}, mode)
            self.assertFalse(self.cards(), mode)

    def test_charon_peer_tools_never_ask(self):
        s = self.make("normal")
        out = self.hook(s, "mcp__charon_peer__send_message", {})
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "allow")

    def test_bypass_allows_in_the_hook(self):
        s = self.make("bypass")
        out = self.hook(s, "Bash", {"command": "rm -rf build"})
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "allow")

    def test_bypass_answers_cli_escalations_without_a_card(self):
        s = self.make("bypass")
        ctx = types.SimpleNamespace(tool_use_id="toolu_2", suggestions=[],
                                    decision_reason="Dangerous rm operation")
        with mock.patch.dict(sys.modules, {"claude_agent_sdk": _fake_sdk()}):
            out = asyncio.run(s._can_use_tool("Bash", {"command": 'rm -f "$d/$a"'}, ctx))
        self.assertIsInstance(out, _Allow)
        self.assertFalse(self.cards())

    def test_card_carries_the_cli_reason_and_suggestions(self):
        s = self.make("normal")
        rule = _Update("addRules", [_Rule("Bash", "npm test:*")], "allow",
                       destination="localSettings")
        ctx = types.SimpleNamespace(tool_use_id="toolu_3", suggestions=[rule],
                                    decision_reason="needs approval")
        out = self.ask(s, ctx, {"allow": True})
        self.assertIsInstance(out, _Allow)
        self.assertIsNone(out.updated_permissions)
        card = self.cards()[0]
        self.assertEqual(card["reason"], "needs approval")
        self.assertEqual(card["suggestions"][0]["rules"][0]["ruleContent"], "npm test:*")
        self.assertEqual(s.session_config["allowedTools"], [])

    def test_picked_rule_is_handed_back_and_remembered(self):
        s = self.make("normal", {"allowedTools": ["Edit"]})
        rule = _Update("addRules", [_Rule("Bash", "npm test:*")], "allow",
                       destination="localSettings")
        ctx = types.SimpleNamespace(tool_use_id="toolu_4", suggestions=[rule],
                                    decision_reason=None)
        out = self.ask(s, ctx, {"allow": True, "suggestion": 0})
        self.assertEqual(out.updated_permissions, [rule])
        self.assertEqual(s.session_config["allowedTools"], ["Edit", "Bash(npm test:*)"])

    def test_picked_mode_switch_becomes_the_session_mode(self):
        s = self.make("normal")
        switch = _Update("setMode", mode="acceptEdits", destination="session")
        ctx = types.SimpleNamespace(tool_use_id="toolu_5", suggestions=[switch],
                                    decision_reason=None)
        out = self.ask(s, ctx, {"allow": True, "suggestion": 0})
        self.assertEqual(out.updated_permissions, [switch])
        self.assertEqual(s.permission_mode, "acceptEdits")
        self.assertTrue([e for e in self.events if e.get("event") == "mode_changed"])

    def test_deny_ignores_a_suggestion(self):
        s = self.make("normal")
        rule = _Update("addRules", [_Rule("Bash", "ls:*")], "allow")
        ctx = types.SimpleNamespace(tool_use_id="toolu_6", suggestions=[rule],
                                    decision_reason=None)
        out = self.ask(s, ctx, {"allow": False, "suggestion": 0})
        self.assertIsInstance(out, _Deny)
        self.assertEqual(s.session_config["allowedTools"], [])

    def test_remembered_rules_survive_a_config_replace(self):
        s = self.make("normal", {"allowedTools": ["Bash(git status:*)"]})
        asyncio.run(s.apply_session_config({"allowedTools": ["Edit"]}))
        self.assertEqual(s.session_config["allowedTools"], ["Edit", "Bash(git status:*)"])

    def test_rule_spelling(self):
        self.assertEqual(_rule_string(_Rule("Bash", "npm test:*")), "Bash(npm test:*)")
        self.assertEqual(_rule_string(_Rule("WebFetch")), "WebFetch")
        self.assertEqual(_rule_string({"toolName": "Read", "ruleContent": "//etc/**"}), "Read(//etc/**)")
        self.assertEqual(_rule_string(_Rule("")), "")


if __name__ == "__main__":
    unittest.main()
