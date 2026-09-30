"""Offline native registration/HTTP contract tests; fixture responses are not customer discovery."""

import importlib.util
import json
import os
import sys
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch


PLUGIN_DIR = Path(__file__).parent
spec = importlib.util.spec_from_file_location("alex_plugin_under_test", PLUGIN_DIR / "__init__.py")
plugin = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = plugin
spec.loader.exec_module(plugin)


class Context:
    def __init__(self):
        self.tools = {}
        self.skills = {}

    def register_tool(self, **kwargs):
        self.tools[kwargs["name"]] = kwargs

    def register_skill(self, **kwargs):
        self.skills[kwargs["name"]] = kwargs


class PluginTests(unittest.TestCase):
    def setUp(self):
        self.context = Context()
        plugin.register(self.context)
        self.calls = []
        self.reply = {"status": "queued", "id": "task-fixture"}
        self.status = 200
        tests = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.respond()

            def do_POST(self):
                self.respond()

            def respond(self):
                length = int(self.headers.get("Content-Length", "0"))
                payload = json.loads(self.rfile.read(length)) if length else None
                tests.calls.append((self.command, self.path, dict(self.headers), payload))
                self.send_response(tests.status)
                if tests.status == 302:
                    self.send_header("Location", "https://example.org/receive-token")
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(tests.reply).encode())

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.environment = patch.dict(os.environ, {
            "ALEX_API_URL": f"http://127.0.0.1:{self.server.server_port}",
            "ALEX_API_TOKEN": "contract-only-not-a-real-secret",
        }, clear=True)
        self.environment.start()

    def tearDown(self):
        self.environment.stop()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def call(self, name, params=None):
        return json.loads(self.context.tools[name]["handler"](params or {}, session_key="fixture"))

    def test_registers_native_schemas_and_readable_bundled_skill_without_network(self):
        from alex_plugin_under_test.outreach import OUTREACH_TOOLS
        self.assertEqual(set(self.context.tools), set(plugin.TOOLS) | set(OUTREACH_TOOLS))
        for name, tool in self.context.tools.items():
            self.assertEqual(tool["schema"]["name"], name)
            self.assertEqual(tool["toolset"], "alex")
        skill = self.context.skills["trade-research"]["path"]
        self.assertTrue(skill.is_file())
        self.assertEqual(skill.read_text(encoding="utf-8"), (PLUGIN_DIR.parent.parent / "skills/alex/SKILL.md").read_text(encoding="utf-8"))
        self.assertFalse(any(word in name for name in self.context.tools for word in ("approve", "authorize", "token", "bootstrap", "takeover", "release")))
        self.assertIn("alex_outreach_send", self.context.tools)
        self.assertEqual(self.calls, [])

    def test_task_creation_preserves_contract_and_authentication(self):
        params = {"request": "Find real suppliers", "criteria": {"product": "user supplied"},
                  "urls": ["https://example.org"], "idempotencyKey": "stable-key"}
        result = self.call("alex_task_create", params)
        self.assertTrue(result["ok"])
        method, path, headers, body = self.calls[-1]
        self.assertEqual((method, path, body), ("POST", "/api/tasks", params))
        self.assertEqual(headers["X-Alex-Token"], os.environ["ALEX_API_TOKEN"])
        self.assertNotIn(os.environ["ALEX_API_TOKEN"], json.dumps(result))

    def test_get_routes_are_authenticated_and_browser_uses_agent_endpoints(self):
        cases = [("alex_profile_get", {}, "GET", "/api/profile"),
                 ("alex_browser_extract", {}, "GET", "/api/agent/browser/extract"),
                 ("alex_browser_navigate", {"url": "https://example.org"}, "POST", "/api/agent/browser/navigate"),
                 ("alex_browser_action", {"type": "scroll", "deltaY": 500}, "POST", "/api/agent/browser/action"),
                 ("alex_task_resume", {"taskId": "saved-task"}, "POST", "/api/tasks/saved-task/resume")]
        for name, params, method, path in cases:
            self.assertTrue(self.call(name, params)["ok"])
            self.assertEqual(self.calls[-1][:2], (method, path))
            self.assertEqual(self.calls[-1][2]["X-Alex-Token"], os.environ["ALEX_API_TOKEN"])

    def test_reads_token_file_without_returning_it(self):
        with tempfile.TemporaryDirectory() as directory:
            token_file = Path(directory) / "api-token"
            token_file.write_text("file-credential-value")
            with patch.dict(os.environ, {"ALEX_API_TOKEN": "", "ALEX_API_TOKEN_FILE": str(token_file)}):
                self.assertTrue(self.call("alex_profile_get")["ok"])
        self.assertEqual(self.calls[-1][2]["X-Alex-Token"], "file-credential-value")

    def test_missing_token_blocks_before_http_and_never_uses_bootstrap(self):
        with patch.dict(os.environ, {"ALEX_API_TOKEN": ""}):
            result = self.call("alex_profile_get")
        self.assertEqual(result["code"], "missing_token")
        self.assertEqual(self.calls, [])

    def test_remote_origin_and_redirect_do_not_receive_token(self):
        with patch.dict(os.environ, {"ALEX_API_URL": "https://example.org"}):
            self.assertEqual(self.call("alex_profile_get")["code"], "invalid_api_url")
        self.assertEqual(self.calls, [])
        self.status = 302
        self.assertEqual(self.call("alex_profile_get")["code"], "redirect_blocked")
        self.assertEqual(len(self.calls), 1)

    def test_human_ownership_error_is_preserved_without_retry(self):
        self.status, self.reply = 409, {"code": "human_has_control", "error": "Human owns browser"}
        result = self.call("alex_browser_navigate", {"url": "https://example.org"})
        self.assertEqual(result["code"], "human_has_control")
        self.assertEqual(len(self.calls), 1)

    def test_unknown_arguments_cannot_add_workspace_credentials_or_arbitrary_route(self):
        for key in ("workspaceId", "token", "actor", "path"):
            result = self.call("alex_task_create", {"request": "test", key: "injected"})
            self.assertEqual(result["code"], "invalid_arguments")
        self.assertEqual(self.calls, [])

    def test_evidence_reads_archived_customer_provenance(self):
        evidence = [{"url": "https://example.org", "text": "HTTP contract fixture only"}]
        self.reply = {"id": "company-fixture", "name": "Fixture", "archived": True, "evidence": evidence}
        result = self.call("alex_customer_evidence", {"companyId": "company-fixture"})
        self.assertEqual(result["result"]["evidence"], evidence)
        self.assertEqual(self.calls[-1][1], "/api/companies/company-fixture")

    def test_unexpected_credential_echo_is_redacted_recursively(self):
        credential = 'a-credential-with-"-quotes'
        self.reply = {credential: {"text": "prefix " + credential, "items": [credential]}}
        with patch.dict(os.environ, {"ALEX_API_TOKEN": credential}):
            result = self.call("alex_profile_get")
        self.assertTrue(result["ok"])
        self.assertEqual(result["result"]["[redacted]"]["items"], ["[redacted]"])
        self.assertNotIn(credential, json.dumps(result))

    def test_invalid_token_and_port_do_not_make_http_requests(self):
        with patch.dict(os.environ, {"ALEX_API_TOKEN": "credential\r\ninjected-header"}):
            self.assertEqual(self.call("alex_profile_get")["code"], "missing_token")
        with patch.dict(os.environ, {"ALEX_API_URL": "http://127.0.0.1:not-a-port"}):
            self.assertEqual(self.call("alex_profile_get")["code"], "invalid_api_url")
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
