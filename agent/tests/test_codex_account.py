"""Account inspection must unwrap SDK unions without exporting credentials."""
import enum
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from charon_agent import codex_login


class Plan(enum.Enum):
    plus = "plus"


class CodexAccountTest(unittest.IsolatedAsyncioTestCase):
    async def probe(self, account=None, error=None):
        client = SimpleNamespace(
            account=AsyncMock(return_value=SimpleNamespace(account=account), side_effect=error),
            close=AsyncMock(),
        )
        with patch.object(codex_login, "CODEX_AVAILABLE", True), \
                patch.object(codex_login, "make_codex_config", return_value=None), \
                patch.object(codex_login, "AsyncCodex", return_value=client):
            result = await codex_login.auth_status()
        client.close.assert_awaited_once()
        return result

    async def test_chatgpt_union_exports_only_identity(self):
        account = SimpleNamespace(root=SimpleNamespace(
            email="alice@example.com", plan_type=Plan.plus, type="chatgpt",
            access_token="private", refresh_token="private", api_key="private",
        ))
        self.assertEqual(await self.probe(account), {
            "ok": True, "logged_in": True, "email": "alice@example.com",
            "subscription_type": "plus", "auth_method": "chatgpt",
        })

    async def test_api_key_account_has_no_invented_subscription(self):
        self.assertEqual(await self.probe(SimpleNamespace(type="apiKey", api_key="private")),
                         {"ok": True, "logged_in": True, "auth_method": "apiKey"})

    async def test_no_account_is_confirmed_logout(self):
        self.assertEqual(await self.probe(), {"ok": True, "logged_in": False})

    async def test_failure_is_unknown_and_never_echoes_credentials(self):
        result = await self.probe(error=RuntimeError("private credential"))
        self.assertFalse(result["ok"])
        self.assertNotIn("logged_in", result)
        self.assertNotIn("private", str(result))


if __name__ == "__main__":
    unittest.main()
