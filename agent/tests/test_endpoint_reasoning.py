"""DeepSeek's plaintext reasoning must survive Codex's summary-only replay."""
import copy
import http.client
import json
import os
import sys
import threading
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from charon_agent.endpoint_proxy import EndpointProxy, request_body
from charon_agent.endpoint_responses import reasoning_input


GO = {'baseUrl': 'https://opencode.ai/zen/go', 'model': 'deepseek-v4.1-flash',
      'auth': 'bearer', 'token': 'upstream-secret'}


def history():
    return {'model': GO['model'], 'input': [
        {'role': 'user', 'content': 'Check the result.'},
        {'type': 'reasoning', 'id': 'rs_one', 'content': None, 'encrypted_content': None,
         'summary': [{'type': 'summary_text', 'text': 'Vérifier\n'},
                     {'type': 'summary_text', 'text': 'avec les deux outils.'}]},
        {'type': 'message', 'role': 'assistant', 'content': [
            {'type': 'output_text', 'text': 'Checking.'}]},
        {'type': 'function_call', 'call_id': 'call_one', 'name': 'check', 'arguments': '{}'},
        {'type': 'function_call', 'call_id': 'call_two', 'name': 'check', 'arguments': '{}'},
        {'type': 'function_call_output', 'call_id': 'call_one', 'output': 'OK'},
        {'type': 'function_call_output', 'call_id': 'call_two', 'output': 'OK'},
    ]}


class EndpointReasoningTests(unittest.TestCase):
    def test_plaintext_replay_preserves_every_character_and_tool_pair(self):
        original = history()
        saved = copy.deepcopy(original)
        result = request_body(original, GO, 'codex')
        self.assertEqual(result['input'][1]['content'], [
            {'type': 'reasoning_text', 'text': 'Vérifier\n'},
            {'type': 'reasoning_text', 'text': 'avec les deux outils.'}])
        self.assertEqual(result['input'][1]['summary'], original['input'][1]['summary'])
        self.assertEqual(result['input'][2:], original['input'][2:])
        self.assertEqual(original, saved)
        self.assertIs(reasoning_input(result, GO, 'codex'), result)

    def test_content_can_be_absent_null_or_empty_and_all_turns_are_repaired(self):
        for value in ('absent', None, []):
            body = history()
            reasoning = body['input'][1]
            if value == 'absent': reasoning.pop('content')
            else: reasoning['content'] = value
            body['input'] += [{'role': 'user', 'content': 'Again.'}, copy.deepcopy(reasoning)]
            result = reasoning_input(body, GO, 'codex')
            self.assertTrue(result['input'][1]['content'])
            self.assertEqual(result['input'][1]['content'], result['input'][-1]['content'])

    def test_native_ciphertext_actual_content_and_empty_or_unknown_summaries_are_untouched(self):
        variants = [
            {'encrypted_content': 'native-ciphertext'},
            {'content': [{'type': 'reasoning_text', 'text': 'Full reasoning.'}]},
            {'summary': []}, {'summary': None},
            {'summary': [{'type': 'other', 'text': 'Unknown.'}]},
            {'summary': [{'type': 'summary_text', 'text': None}]},
        ]
        for variant in variants:
            body = history()
            body['input'][1].update(variant)
            with self.subTest(variant=variant):
                self.assertIs(reasoning_input(body, GO, 'codex'), body)

    def test_other_providers_models_engines_and_string_input_are_untouched(self):
        for engine, url, model in [
            ('claude', GO['baseUrl'], GO['model']),
            ('codex', 'https://api.openai.com', GO['model']),
            ('codex', 'https://opencode.ai.example/zen/go', GO['model']),
            ('codex', 'https://opencode.ai/zen/another', GO['model']),
            ('codex', GO['baseUrl'], 'gpt-6.1-sol'),
        ]:
            body = {**history(), 'model': model}
            self.assertIs(reasoning_input(body, {**GO, 'baseUrl': url}, engine), body)
        body = {'model': GO['model'], 'input': 'Hello'}
        self.assertIs(reasoning_input(body, GO, 'codex'), body)

    def test_real_http_relay_sends_reasoning_content_after_parallel_tool_results(self):
        received = []

        class Upstream(BaseHTTPRequestHandler):
            def log_message(self, *args): pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                received.append(body)
                valid = bool(body['input'][1].get('content'))
                self.send_response(200 if valid else 400)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(b'{"ok":true}' if valid else b'{"error":"reasoning_content missing"}')

        server = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        real_opener = urllib.request.build_opener()

        class RoutedOpener:
            def open(self, request, **kwargs):
                return real_opener.open(urllib.request.Request(
                    f'http://127.0.0.1:{server.server_port}/v1/responses',
                    data=request.data, headers=dict(request.headers)), **kwargs)

        relay = EndpointProxy(lambda: GO, 'codex')
        client = http.client.HTTPConnection('127.0.0.1', relay.server.server_port, timeout=5)
        try:
            with patch('charon_agent.endpoint_proxy.urllib.request.build_opener', return_value=RoutedOpener()):
                client.request('POST', '/v1/responses', json.dumps(history()),
                               {'Authorization': 'Bearer ' + relay.token})
                response = client.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(json.loads(response.read()), {'ok': True})
            self.assertEqual(received[0]['input'][1]['content'][0]['text'], 'Vérifier\n')
            self.assertEqual(received[0]['input'][2:], history()['input'][2:])
        finally:
            client.close()
            relay.stop()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == '__main__': unittest.main()
