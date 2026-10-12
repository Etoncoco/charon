"""Native counter timing and provider normalization, without installed SDKs."""
import os
import sys
import types
import tempfile
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from charon_agent.stream_metrics import TurnThroughput
from charon_agent.codex_session import CodexSession
from charon_agent.cursor_session import CursorSession


class NativeThroughputTests(unittest.TestCase):
    def test_server_attaches_timing_to_live_usage_and_removes_internal_fields(self):
        from charon_agent.server import Server
        with tempfile.TemporaryDirectory() as root:
            server = Server(socket_path=Path(root) / 'agent.sock', state_path=Path(root) / 'state.json')
            server.sessions['s'] = types.SimpleNamespace()
            client = Mock()
            server.subscribers['s'] = {client}
            with patch('charon_agent.server.time.monotonic', side_effect=[10, 13]):
                server._emit({'event': 'status', 'session_id': 's', 'status': 'thinking'})
                payload = {'event': 'usage', 'session_id': 's', 'output_tokens': 20, '_sdk_output_tokens': 120}
                server._emit(payload)
            self.assertEqual(payload['sdk_throughput'], {'output_tokens': 120, 'elapsed_ms': 3000})
            self.assertNotIn('_sdk_output_tokens', payload)
            self.assertNotIn('seq', payload)
            self.assertEqual(len(server.rings['s']), 1)  # only status is durable
            self.assertEqual(client.send_json.call_args.args[0], payload)

    def test_uses_native_counts_and_freezes_the_elapsed_time_after_stop(self):
        metrics = TurnThroughput()
        metrics.observe({'event': 'status', 'status': 'thinking'}, 10)
        metrics.observe({'event': 'status', 'status': 'thinking'}, 11)
        usage = {'event': 'usage', 'output_tokens': 120}
        metrics.observe(usage, 13)
        self.assertEqual(usage['sdk_throughput'], {'output_tokens': 120, 'elapsed_ms': 3000})
        metrics.observe({'event': 'stop'}, 15)
        final = {'event': 'usage', 'output_tokens': 200, 'final': True}
        metrics.observe(final, 30)
        self.assertEqual(final['sdk_throughput'], {'output_tokens': 200, 'elapsed_ms': 5000})
        metrics.observe({'event': 'status', 'status': 'thinking'}, 40)
        again = {'event': 'usage', 'output_tokens': 10}
        metrics.observe(again, 41)
        self.assertEqual(again['sdk_throughput']['elapsed_ms'], 1000)

    def test_prefers_final_sdk_duration_and_does_not_invent_a_start(self):
        metrics = TurnThroughput()
        unknown = {'event': 'usage', 'output_tokens': 10}
        metrics.observe(unknown, 30)
        self.assertNotIn('sdk_throughput', unknown)
        final = {'event': 'usage', 'output_tokens': 200, 'duration_ms': 5000, 'final': True}
        metrics.observe(final, 30)
        self.assertEqual(final['sdk_throughput'], {'output_tokens': 200, 'elapsed_ms': 5000})

    def test_rejects_missing_invalid_or_estimated_counters(self):
        metrics = TurnThroughput()
        metrics.observe({'event': 'status', 'status': 'thinking'}, 10)
        for tokens in [None, -1, float('nan'), float('inf'), True, '100', 1.5]:
            usage = {'event': 'usage', 'output_tokens': 100, '_sdk_output_tokens': tokens}
            metrics.observe(usage, 11)
            self.assertNotIn('sdk_throughput', usage)
            self.assertNotIn('_sdk_output_tokens', usage)
        estimated = {'event': 'generation_progress', 'characters': 4000}
        metrics.observe(estimated, 11)
        self.assertNotIn('sdk_throughput', estimated)

    def test_codex_counts_all_requests_but_excludes_old_thread_tokens(self):
        session = CodexSession.__new__(CodexSession)
        session._last_usage = None
        session._sdk_output_base = 1000
        for total, last, expected in [(1120, 120, 120), (1320, 200, 320), (1320, 200, 320)]:
            breakdown = lambda output: types.SimpleNamespace(output_tokens=output, input_tokens=100)
            value = types.SimpleNamespace(total=breakdown(total), last=breakdown(last))
            note = type('ThreadTokenUsageUpdatedNotification', (), {'token_usage': value})()
            usage = session._translate(note)[0]
            self.assertEqual(usage['_sdk_output_tokens'], expected)
            self.assertEqual(usage['output_tokens'], last)  # accounting contract stays unchanged
        final_note = type('TurnCompletedNotification', (), {'turn': types.SimpleNamespace(status='completed')})()
        final = session._translate(final_note)[0]
        self.assertEqual(final['_sdk_output_tokens'], 320)

    def test_codex_first_update_derives_a_baseline_from_the_native_last_request(self):
        session = CodexSession.__new__(CodexSession)
        session._last_usage = None
        value = types.SimpleNamespace(total=types.SimpleNamespace(output_tokens=1120),
                                      last=types.SimpleNamespace(output_tokens=120, input_tokens=10))
        note = type('ThreadTokenUsageUpdatedNotification', (), {'token_usage': value})()
        self.assertEqual(session._translate(note)[0]['_sdk_output_tokens'], 120)
        self.assertEqual(session._sdk_output_base, 1000)

    def test_cursor_uses_sdk_run_usage_not_one_turn_slice(self):
        session = CursorSession.__new__(CursorSession)
        session._run = types.SimpleNamespace(usage=types.SimpleNamespace(output_tokens=320))
        session._emit = Mock()
        session._on_message(types.SimpleNamespace(type='usage', usage=types.SimpleNamespace(output_tokens=200)))
        usage = session._emit.call_args.kwargs
        self.assertEqual(usage['output_tokens'], 200)
        self.assertEqual(usage['_sdk_output_tokens'], 320)


if __name__ == '__main__':
    unittest.main()
