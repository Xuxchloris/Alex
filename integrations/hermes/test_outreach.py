"""Offline behavior tests. All transports are fixtures; no email/WhatsApp is sent."""

import importlib.util
from contextlib import closing, redirect_stdout
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("alex_outreach_under_test", Path(__file__).with_name("outreach.py"))
outreach = importlib.util.module_from_spec(spec)
spec.loader.exec_module(outreach)


class OutreachTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.calls = []
        self.service = outreach.OutreachService(self.home, self.sender)

    def sender(self, record, home):
        self.calls.append((record, home))
        return {"success": True, "message_id": "fixture-provider-id", "thread_id": "fixture-thread"}

    def policy(self, **updates):
        value = {"version": 1, "enabled": True, "daily_limit": 3,
                 "allowed_recipients": {"gmail": ["buyer@example.org"], "whatsapp": ["15555550123"]}}
        value.update(updates)
        (self.home / outreach.POLICY_NAME).write_text(json.dumps(value), encoding="utf-8")

    def prepare(self, **updates):
        args = {"channel": "gmail", "recipient": "buyer@example.org", "subject": "Fixture subject",
                "body": "Clearly labelled unit-test body.", "idempotencyKey": "fixture-request"}
        args.update(updates)
        return self.service.prepare(**args)

    def test_missing_policy_never_sends_and_keeps_prepared(self):
        draft = self.prepare()
        with self.assertRaisesRegex(outreach.OutreachError, "not authorized"):
            self.service.send(draft["id"])
        self.assertEqual(self.calls, [])
        self.assertEqual(self.service.status(draft["id"])["status"], "prepared")
        self.assertEqual(self.service.status()["remaining_today"], 0)

    def test_exact_channel_and_recipient_authorization_rechecked_at_send(self):
        self.policy()
        draft = self.prepare(recipient="other@example.org")
        with self.assertRaises(outreach.OutreachError):
            self.service.send(draft["id"])
        draft = self.prepare(channel="whatsapp_cloud", recipient="15555550123", subject="", idempotencyKey="cloud")
        with self.assertRaises(outreach.OutreachError):
            self.service.send(draft["id"])
        draft = self.prepare(idempotencyKey="revoked")
        self.policy(enabled=False)
        with self.assertRaises(outreach.OutreachError):
            self.service.send(draft["id"])
        self.assertEqual(self.calls, [])

    def test_provider_id_is_required_and_sent_retries_do_not_send_again(self):
        self.policy()
        draft = self.prepare()
        result = self.service.send(draft["id"])
        self.assertEqual(result["status"], "sent")
        self.assertEqual(result["provider_message_id"], "fixture-provider-id")
        self.assertEqual(result["receipt_scope"], "provider_accepted")
        self.service = outreach.OutreachService(self.home, self.sender)
        self.assertEqual(self.service.send(draft["id"])["status"], "sent")
        self.assertEqual(len(self.calls), 1)

    def test_no_id_and_uncertain_error_survive_restart_without_retry(self):
        self.policy()
        for index, reply in enumerate(({"success": True}, {"error": "private provider detail"}, None)):
            draft = self.prepare(idempotencyKey=f"uncertain-{index}", body=f"Fixture attempt {index}")
            self.service.sender = lambda record, home: reply
            result = self.service.send(draft["id"])
            self.assertEqual(result["status"], "unknown")
            self.assertIsNone(result["provider_message_id"])
            self.assertNotIn("private provider detail", json.dumps(result))
            reopened = outreach.OutreachService(self.home, self.sender)
            with self.assertRaises(outreach.OutreachError):
                reopened.send(draft["id"])
        self.assertEqual(self.calls, [])

    def test_exception_after_send_claim_does_not_leak_or_retry(self):
        self.policy()
        def broken(record, home):
            raise TimeoutError("credential-and-provider-body-must-not-leak")
        self.service.sender = broken
        draft = self.prepare()
        result = self.service.send(draft["id"])
        self.assertEqual(result["status"], "unknown")
        self.assertNotIn("must-not-leak", json.dumps(result))
        with self.assertRaises(outreach.OutreachError):
            self.service.send(draft["id"])

    def test_partial_success_is_not_claimed_as_complete_provider_acceptance(self):
        self.policy()
        self.service.sender = lambda record, home: {"success": True, "message_id": "partial-id", "partial_success": True}
        result = self.service.send(self.prepare()["id"])
        self.assertEqual(result["status"], "unknown")
        self.assertIsNone(result["provider_message_id"])

    def test_crash_marker_and_concurrent_attempt_are_not_retried(self):
        self.policy()
        draft = self.prepare()
        entered, release = threading.Event(), threading.Event()
        def slow(record, home):
            entered.set()
            release.wait(5)
            return self.sender(record, home)
        self.service.sender = slow
        thread = threading.Thread(target=self.service.send, args=(draft["id"],))
        thread.start()
        try:
            self.assertTrue(entered.wait(3))
            other = outreach.OutreachService(self.home, self.sender)
            self.assertEqual(other.status(draft["id"])["status"], "sending")
            with self.assertRaises(outreach.OutreachError):
                other.send(draft["id"])
        finally:
            release.set()
            thread.join(5)
        self.assertEqual(len(self.calls), 1)
        crashed = self.prepare(idempotencyKey="crash", body="Crash fixture")
        with closing(sqlite3.connect(self.service.path)) as db, db:
            db.execute("UPDATE deliveries SET status='sending',attempted_at=? WHERE id=?", (self.service._now(), crashed["id"]))
        with self.assertRaises(outreach.OutreachError):
            outreach.OutreachService(self.home, self.sender).send(crashed["id"])

    def test_daily_budget_includes_ambiguous_attempts(self):
        self.policy(daily_limit=1)
        self.service.sender = lambda record, home: {"success": True}
        self.service.send(self.prepare()["id"])
        second = self.prepare(idempotencyKey="second", body="Different fixture message")
        with self.assertRaisesRegex(outreach.OutreachError, "daily outreach limit"):
            self.service.send(second["id"])
        self.assertEqual(self.service.status()["attempts_today"], 1)

    def test_concurrent_different_messages_share_one_daily_budget(self):
        self.policy(daily_limit=1)
        first = self.prepare()
        second = self.prepare(idempotencyKey="second", body="Different fixture message")
        barrier = threading.Barrier(2)
        outcomes = []
        def attempt(delivery):
            barrier.wait()
            try:
                outcomes.append(outreach.OutreachService(self.home, self.sender).send(delivery["id"])["status"])
            except outreach.OutreachError as error:
                outcomes.append(error.code)
        workers = [threading.Thread(target=attempt, args=(draft,)) for draft in (first, second)]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(5)
        self.assertCountEqual(outcomes, ["sent", "daily_limit_reached"])
        self.assertEqual(len(self.calls), 1)

    def test_idempotency_binds_message_and_recipient(self):
        first = self.prepare()
        self.assertEqual(self.prepare()["id"], first["id"])
        for changes in ({"body": "different"}, {"recipient": "different@example.org"}, {"subject": "different"}):
            with self.assertRaises(outreach.OutreachError):
                self.prepare(**changes)
        self.assertEqual(len(self.service.list()), 1)

    def test_plain_text_validation_and_policy_fail_closed(self):
        for changes in ({"body": "MEDIA:/private/file"}, {"subject": "one\nBcc:other@example.org"},
                        {"recipient": "Name <buyer@example.org>"}, {"channel": "smtp"},
                        {"channel": "whatsapp", "recipient": "12000@g.us", "subject": ""}):
            with self.assertRaises(outreach.OutreachError):
                self.prepare(**changes)
        self.policy(allowed_recipients={"gmail": ["*"]})
        with self.assertRaises(outreach.OutreachError):
            self.service.send(self.prepare()["id"])
        self.assertEqual(self.calls, [])

    def test_profiles_have_separate_policy_and_ledger(self):
        self.policy()
        other = outreach.OutreachService(self.home / "other", self.sender)
        draft = other.prepare(channel="gmail", recipient="buyer@example.org", subject="Fixture", body="Fixture", idempotencyKey="same-key")
        with self.assertRaises(outreach.OutreachError):
            other.send(draft["id"])
        self.assertEqual(self.service.list(), [])

    def test_new_request_key_does_not_repeat_identical_uncertain_message(self):
        self.policy()
        self.service.sender = lambda record, home: {"success": True}
        first = self.prepare()
        self.service.send(first["id"])
        second = self.prepare(idempotencyKey="new-key-must-not-hide-retry")
        self.assertEqual(first["id"], second["id"])
        with self.assertRaises(outreach.OutreachError):
            self.service.send(second["id"])

    def test_changed_company_metadata_cannot_disguise_duplicate_message(self):
        self.policy()
        first = self.prepare(companyId="first-company")
        self.service.send(first["id"])
        duplicate = self.prepare(companyId="different-company", idempotencyKey="different-key")
        self.assertEqual(first["id"], duplicate["id"])
        self.assertEqual(self.service.send(duplicate["id"])["status"], "sent")
        self.assertEqual(len(self.calls), 1)
        with self.assertRaises(outreach.OutreachError):
            self.prepare(companyId="different-company")

    def test_missing_oauth_can_be_configured_then_same_draft_sent_once(self):
        self.policy(daily_limit=1)
        self.service = outreach.OutreachService(self.home)
        draft = self.prepare()
        result = type("Result", (), {"returncode": 0, "stdout": '{"status":"sent","id":"fixture-gmail-id"}'})()
        with patch.object(outreach, "_gmail_script", return_value=Path("/fixed/google_api.py")), \
                patch.object(outreach.subprocess, "run", return_value=result) as run:
            with self.assertRaises(outreach.OutreachError) as raised:
                self.service.send(draft["id"])
            self.assertEqual(raised.exception.code, "channel_unavailable")
            self.assertEqual(self.service.status(draft["id"])["status"], "prepared")
            self.assertEqual(self.service.status()["attempts_today"], 0)
            run.assert_not_called()
            (self.home / "google_token.json").write_text("unused-fixture-marker", encoding="utf-8")
            self.assertEqual(self.service.send(draft["id"])["status"], "sent")
            self.assertEqual(self.service.send(draft["id"])["status"], "sent")
            self.assertEqual(run.call_count, 1)
            self.assertEqual(self.service.status()["attempts_today"], 1)

    def test_provider_facing_local_exception_is_still_unknown_and_consumes_budget(self):
        self.policy(daily_limit=1)
        def race(record, home):
            raise outreach.OutreachError("channel_unavailable", "Fixture late configuration race")
        self.service.sender = race
        draft = self.prepare()
        self.assertEqual(self.service.send(draft["id"])["status"], "unknown")
        self.assertEqual(self.service.status()["attempts_today"], 1)
        with self.assertRaises(outreach.OutreachError):
            self.service.send(draft["id"])

    def test_suppression_overrides_authorization_and_survives_restart(self):
        self.policy()
        draft = self.prepare()
        self.service.suppress(channel="gmail", recipient="buyer@example.org", reason="Fixture opt-out")
        reopened = outreach.OutreachService(self.home, self.sender)
        with self.assertRaisesRegex(outreach.OutreachError, "opted out"):
            reopened.send(draft["id"])
        self.assertEqual(reopened.status()["suppressions"][0]["reason"], "Fixture opt-out")
        self.assertEqual(self.calls, [])

    def test_online_backup_preserves_attempts_and_suppressions_and_refuses_overwrite(self):
        self.policy()
        draft = self.prepare()
        self.service.send(draft["id"])
        self.service.suppress(channel="gmail", recipient="buyer@example.org", reason="Fixture")
        snapshot = self.home / "backups" / "outreach.sqlite3"
        result = self.service.backup(snapshot)
        self.assertEqual(result["counts"], {"deliveries": 1, "suppressions": 1})
        self.assertEqual(len(result["sha256"]), 64)
        with closing(sqlite3.connect(snapshot)) as db:
            self.assertEqual(db.execute("SELECT provider_message_id FROM deliveries").fetchone()[0], "fixture-provider-id")
        with self.assertRaises(outreach.OutreachError):
            self.service.backup(snapshot)

    def test_registration_has_no_state_or_transport_side_effect(self):
        class Context:
            def __init__(self):
                self.tools = {}
            def register_tool(self, **kwargs):
                self.tools[kwargs["name"]] = kwargs
        ctx = Context()
        with patch.object(outreach, "OutreachService", side_effect=AssertionError("Registration must be inert")):
            outreach.register_outreach(ctx)
        self.assertEqual(set(ctx.tools), set(outreach.OUTREACH_TOOLS))
        self.assertTrue(all(tool["schema"]["parameters"]["additionalProperties"] is False for tool in ctx.tools.values()))

    def test_whatsapp_transport_calls_the_real_hermes_entrypoint_shape(self):
        import types
        fake = types.ModuleType("tools.send_message_tool")
        calls = []
        fake.send_message_tool = lambda args: calls.append(args) or json.dumps({"success": True, "message_id": "fixture-wa-id"})
        with patch.dict("sys.modules", {"tools.send_message_tool": fake}):
            result = outreach.send_via_hermes({"channel": "whatsapp", "recipient": "15555550123", "body": "Fixture"}, self.home)
        self.assertEqual(calls, [{"action": "send", "target": "whatsapp:15555550123", "message": "Fixture"}])
        self.assertEqual(result["message_id"], "fixture-wa-id")

    def test_gmail_transport_uses_stdin_and_profile_without_exposing_body_in_argv(self):
        (self.home / "google_token.json").write_text("fixture-only", encoding="utf-8")
        result = type("Result", (), {"returncode": 0, "stdout": '{"status":"sent","id":"fixture-gmail-id","threadId":"thread"}'})()
        with patch.object(outreach, "_gmail_script", return_value=Path("/fixed/hermes/google_api.py")), \
                patch.object(outreach.subprocess, "run", return_value=result) as run:
            response = outreach.send_via_hermes({"channel": "gmail", "recipient": "buyer@example.org", "subject": "Fixture", "body": "body-through-stdin"}, self.home)
        argv = run.call_args.args[0]
        options = run.call_args.kwargs
        self.assertNotIn("body-through-stdin", " ".join(argv))
        self.assertEqual(json.loads(options["input"])["body"], "body-through-stdin")
        self.assertEqual(options["env"]["HERMES_HOME"], str(self.home))
        self.assertFalse(options["shell"])
        self.assertEqual(response["message_id"], "fixture-gmail-id")

    def owner_cli(self, *args):
        output = io.StringIO()
        with redirect_stdout(output):
            status = outreach.main(list(args), home=self.home)
        return status, json.loads(output.getvalue())

    def test_owner_allow_persists_exact_permission_and_revoke_blocks_send(self):
        code, empty = self.owner_cli("policy", "show")
        self.assertEqual(code, 0)
        self.assertFalse(empty["result"]["enabled"])
        self.assertFalse((self.home / outreach.POLICY_NAME).exists())
        code, allowed = self.owner_cli("policy", "allow", "gmail", "buyer@example.org", "--daily-limit", "1000")
        self.assertEqual(code, 0)
        self.assertTrue(allowed["result"]["enabled"])
        self.assertEqual(outreach.read_policy(self.home)["daily_limit"], 1000)
        draft = self.prepare()
        self.assertEqual(self.service.send(draft["id"])["status"], "sent")
        self.owner_cli("policy", "revoke", "gmail", "buyer@example.org")
        second = self.prepare(idempotencyKey="second", body="Another fixture")
        with self.assertRaises(outreach.OutreachError):
            self.service.send(second["id"])
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(list(self.home.glob(".alex-outreach-policy-*")), [])

    def test_owner_disable_and_invalid_arguments_never_enable(self):
        code, result = self.owner_cli("policy", "disable")
        self.assertEqual(code, 0)
        self.assertFalse(outreach.read_policy(self.home)["enabled"])
        for recipient in ("*", "buyer@example.org\nBcc: other@example.org", "buyer@example.org;run()"):
            code, result = self.owner_cli("policy", "allow", "gmail", recipient, "--daily-limit", "1")
            self.assertEqual(code, 1)
            self.assertFalse(result["ok"])
            self.assertFalse(outreach.read_policy(self.home)["enabled"])
        for limit in ("0", "1001"):
            code, _ = self.owner_cli("policy", "allow", "gmail", "buyer@example.org", "--daily-limit", limit)
            self.assertEqual(code, 1)
        self.assertEqual(self.calls, [])

    def test_owner_backup_command_creates_verified_snapshot(self):
        self.prepare()
        code, result = self.owner_cli("backup", str(self.home / "backup.sqlite3"))
        self.assertEqual(code, 0)
        self.assertEqual(result["result"]["counts"]["deliveries"], 1)

    def test_mailbox_search_is_read_only_and_discards_non_message_fields(self):
        payload = [{"id": "abc123", "threadId": "thread", "from": "buyer@example.org", "subject": "Fixture reply",
                    "labels": ["INBOX"], "snippet": "Untrusted customer text", "credential": "never expose extra fields"}]
        with patch.object(outreach, "_call_gmail", return_value=payload) as call:
            result = self.service.mailbox_search(query="from:buyer@example.org newer_than:7d", limit=4)
        self.assertEqual(call.call_args.args, ("gmail_search", {"query": "from:buyer@example.org newer_than:7d", "max": 4}, self.home))
        self.assertTrue(result["readOnly"])
        self.assertTrue(result["untrustedContent"])
        self.assertNotIn("credential", result["messages"][0])
        self.assertEqual(self.service.list(), [])
        self.assertEqual(self.calls, [])

    def test_mailbox_get_validates_identity_and_bounds_untrusted_body(self):
        payload = {"id": "abc123", "threadId": "thread", "body": "x" * 60_001}
        with patch.object(outreach, "_call_gmail", return_value=payload):
            result = self.service.mailbox_get(messageId="abc123")
            with self.assertRaises(outreach.OutreachError):
                self.service.mailbox_get(messageId="different-id")
        self.assertEqual(len(result["message"]["body"]), 60_000)
        self.assertTrue(result["message"]["bodyTruncated"])
        with patch.object(outreach, "_call_gmail", side_effect=AssertionError("must not call")):
            for invalid in ("../file", "id;command", "", "id\nother"):
                with self.assertRaises(outreach.OutreachError):
                    self.service.mailbox_get(messageId=invalid)

    def test_mailbox_errors_never_echo_provider_output_or_credential_data(self):
        with patch.object(outreach, "_call_gmail", side_effect=RuntimeError("sensitive-key provider stderr")):
            for action, args in ((self.service.mailbox_search, {"query": "is:unread"}), (self.service.mailbox_get, {"messageId": "abc123"})):
                with self.assertRaises(outreach.OutreachError) as raised:
                    action(**args)
                self.assertEqual(raised.exception.code, "mailbox_unavailable")
                self.assertNotIn("sensitive-key", str(raised.exception))
                self.assertNotIn("stderr", str(raised.exception))

    def test_real_subprocess_uses_fixed_official_entrypoint_contract_and_empty_search(self):
        # A fixture script exercises the actual stdin/Namespace/subprocess path;
        # it has no provider client and reads no credential file.
        script = self.home / "fixture_google_api.py"
        script.write_text("import json\ndef gmail_search(args):\n    assert args.query == 'from:fixture@example.org'\n    assert args.max == 2\n    print('No messages found.')\n", encoding="utf-8")
        (self.home / "google_token.json").write_text("unused-fixture-marker", encoding="utf-8")
        with patch.object(outreach, "_gmail_script", return_value=script):
            result = self.service.mailbox_search(query="from:fixture@example.org", limit=2)
        self.assertEqual(result["messages"], [])

    def test_failed_gmail_subprocess_does_not_reveal_stderr(self):
        (self.home / "google_token.json").write_text("unused-fixture-marker", encoding="utf-8")
        failed = type("Result", (), {"returncode": 1, "stdout": "private response", "stderr": "sensitive credential"})()
        with patch.object(outreach, "_gmail_script", return_value=Path("/fixed/google_api.py")), patch.object(outreach.subprocess, "run", return_value=failed):
            with self.assertRaises(outreach.OutreachError) as raised:
                self.service.mailbox_get(messageId="abc123")
        self.assertNotIn("private", str(raised.exception))
        self.assertNotIn("credential", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
