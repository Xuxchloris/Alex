"""Offline email lifecycle tests. No real mailbox, model, or send is used."""

import base64
from contextlib import redirect_stdout, closing
from email import message_from_bytes
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


outreach = load("alex_followup_test_outreach", "outreach.py")
transport = load("alex_followup_test_transport", "gmail_transport.py")


class FollowupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.calls = []
        self.now = "2026-09-30T08:00:00.000000+00:00"
        self.service = outreach.OutreachService(self.home, self.sender)
        self.service._now = lambda: self.now
        outreach.write_policy(self.home, {"version": 1, "enabled": True, "daily_limit": 5,
                                          "allowed_recipients": {"gmail": ["buyer@example.org"]}})
        self.anchor = self.service.prepare(channel="gmail", recipient="buyer@example.org", subject="Fixture offer",
                                           body="Fixture initial message", companyId="fixture-company", idempotencyKey="initial")
        self.service.send(self.anchor["id"])
        self.now = "2026-09-30T10:00:00.000000+00:00"

    def sender(self, record, home):
        self.calls.append(record)
        return {"success": True, "message_id": f"sent{len(self.calls)}", "thread_id": "thread1"}

    def message(self, id="sent1", sender="Owner <owner@example.org>", recipient="buyer@example.org",
                labels=None, timestamp="1790755200000", thread="thread1"):
        return {"id": id, "threadId": thread, "from": sender, "to": recipient,
                "subject": "Fixture offer", "internalDate": timestamp,
                "rfcMessageId": f"<{id}@example.org>", "labels": ["SENT"] if labels is None else labels,
                "body": "Clearly labelled email fixture"}

    def thread(self, *messages):
        return {"id": "thread1", "messages": [self.message(), *messages]}

    def sync(self, *messages):
        with patch.object(outreach, "_call_gmail", return_value=self.thread(*messages)):
            return self.service.mailbox_sync(deliveryId=self.anchor["id"])

    def schedule(self):
        return self.service.followup_schedule(deliveryId=self.anchor["id"], dueAt="2026-09-30T17:00:00+08:00", note="Owner-requested fixture follow-up")

    def draft(self, followup):
        return self.service.prepare(channel="gmail", recipient="buyer@example.org", subject="Re: Fixture offer",
                                    body="Fixture reminder", companyId="fixture-company", idempotencyKey="follow-up",
                                    followupId=followup["id"])

    def test_thread_sync_is_idempotent_read_only_and_survives_restart_and_backup(self):
        first = self.sync()
        self.assertEqual(first["added"], 1)
        self.assertEqual(self.sync()["added"], 0)
        self.assertTrue(first["mailboxReadOnly"])
        self.assertTrue(first["untrustedContent"])
        self.assertEqual(len(self.calls), 1)
        followup = self.schedule()
        reopened = outreach.OutreachService(self.home, self.sender)
        self.assertEqual(reopened.followups_list()["followups"][0]["id"], followup["id"])
        snapshot = self.home / "snapshot.sqlite3"
        counts = reopened.backup(snapshot)["counts"]
        self.assertEqual(counts["mailbox_messages"], 1)
        self.assertEqual(counts["followups"], 1)

    def test_matching_customer_reply_stops_reminder_without_claiming_buying_intent(self):
        self.sync()
        followup = self.schedule()
        draft = self.draft(followup)
        reply = self.message(id="reply1", sender="Buyer <buyer@example.org>", recipient="owner@example.org",
                             labels=["INBOX"], timestamp="1790758800000")
        with patch.object(outreach, "_call_gmail", return_value=self.thread(reply)):
            with self.assertRaises(outreach.OutreachError) as error:
                self.service.send(draft["id"])
        self.assertEqual(error.exception.code, "followup_stopped")
        row = self.service.followups_list(includeClosed=True)["followups"][0]
        self.assertEqual(row["status"], "replied")
        self.assertEqual(row["reason"], "reply1")
        self.assertEqual(self.service.status(draft["id"])["status"], "prepared")
        self.assertEqual(self.service.status()["attempts_today"], 1)
        self.assertEqual(len(self.calls), 1)

    def test_prior_or_other_sender_or_sent_mail_does_not_count_as_new_customer_reply(self):
        self.schedule()
        self.sync(self.message(id="old", sender="buyer@example.org", labels=["INBOX"], timestamp="1790750000000"),
                  self.message(id="other", sender="other@example.org", labels=["INBOX"], timestamp="1790758800000"),
                  self.message(id="self", sender="buyer@example.org", labels=["SENT"], timestamp="1790758800000"))
        self.assertEqual(self.service.followups_list()["followups"][0]["status"], "scheduled")

    def test_schedule_after_known_reply_does_not_reopen_contact(self):
        self.sync(self.message(id="reply1", sender="buyer@example.org", labels=[], timestamp="1790758800000"))
        self.assertEqual(self.schedule()["status"], "replied")
        self.assertEqual(self.schedule()["status"], "replied")

    def test_due_send_syncs_again_and_sends_in_thread_exactly_once(self):
        self.sync()
        followup = self.schedule()
        draft = self.draft(followup)
        with patch.object(outreach, "_call_gmail", return_value=self.thread()) as call:
            self.assertEqual(self.service.send(draft["id"])["status"], "sent")
            self.assertEqual(self.service.send(draft["id"])["status"], "sent")
        self.assertEqual(call.call_count, 1)
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.calls[-1]["reply_thread_id"], "thread1")
        self.assertEqual(self.calls[-1]["reply_rfc_id"], "<sent1@example.org>")
        self.assertEqual(self.service.followups_list(includeClosed=True)["followups"][0]["status"], "sent")

    def test_unavailable_mailbox_blocks_followup_before_attempt_and_can_retry_later(self):
        self.sync()
        draft = self.draft(self.schedule())
        with patch.object(outreach, "_call_gmail", side_effect=RuntimeError("private provider detail")):
            with self.assertRaises(outreach.OutreachError):
                self.service.send(draft["id"])
        self.assertEqual(self.service.status(draft["id"])["status"], "prepared")
        self.assertEqual(self.service.status()["attempts_today"], 1)
        self.assertEqual(len(self.calls), 1)

    def test_timezone_due_check_cancellation_and_suppression(self):
        self.sync()
        followup = self.schedule()
        self.assertEqual(followup["due_at"], "2026-09-30T09:00:00.000000+00:00")
        self.now = "2026-09-30T08:30:00.000000+00:00"
        draft = self.draft(followup)
        with patch.object(outreach, "_call_gmail", side_effect=AssertionError("not yet due")):
            with self.assertRaises(outreach.OutreachError):
                self.service.send(draft["id"])
        self.assertEqual(self.service.followups_list(dueOnly=True)["followups"], [])
        self.service.suppress(channel="gmail", recipient="buyer@example.org", reason="Fixture opt-out")
        self.assertEqual(self.service.followups_list(includeClosed=True)["followups"][0]["status"], "cancelled")
        self.assertEqual(self.schedule()["status"], "cancelled")
        self.assertEqual(len(self.calls), 1)

    def test_cancel_is_persistent_and_conflicting_reschedule_fails(self):
        followup = self.schedule()
        self.service.followup_cancel(followupId=followup["id"], reason="Owner cancelled")
        self.assertEqual(self.schedule()["status"], "cancelled")
        with self.assertRaises(outreach.OutreachError):
            self.service.followup_schedule(deliveryId=self.anchor["id"], dueAt="2026-10-01T12:00:00Z", note="reset")
        for date in ("tomorrow", "2026-10-01T12:00:00", "2026-09-30T01:00:00Z"):
            with self.assertRaises(outreach.OutreachError):
                self.service.followup_schedule(deliveryId=self.anchor["id"], dueAt=date, note="bad")

    def test_unknown_attempt_is_visible_for_review_and_not_resent(self):
        self.sync()
        draft = self.draft(self.schedule())
        self.service.sender = lambda record, home: {"success": True}
        with patch.object(outreach, "_call_gmail", return_value=self.thread()):
            self.assertEqual(self.service.send(draft["id"])["status"], "unknown")
        self.assertEqual(self.service.followups_list()["followups"][0]["status"], "needs_review")
        with self.assertRaises(outreach.OutreachError):
            self.service.send(draft["id"])

    def test_two_drafts_cannot_claim_the_same_followup_twice(self):
        self.sync()
        followup = self.schedule()
        first = self.draft(followup)
        second = self.service.prepare(channel="gmail", recipient="buyer@example.org", subject="Re: Fixture offer",
                                      body="Changed reminder fixture", companyId="fixture-company", idempotencyKey="second-draft",
                                      followupId=followup["id"])
        with patch.object(outreach, "_call_gmail", return_value=self.thread()):
            self.service.send(first["id"])
            with self.assertRaises(outreach.OutreachError):
                self.service.send(second["id"])
        self.assertEqual(len(self.calls), 2)  # original + exactly one reminder

    def test_provider_thread_mismatch_is_uncertain_and_never_automatically_resent(self):
        self.sync()
        draft = self.draft(self.schedule())
        self.service.sender = lambda record, home: {"success": True, "message_id": "id", "thread_id": "wrong-thread"}
        with patch.object(outreach, "_call_gmail", return_value=self.thread()):
            result = self.service.send(draft["id"])
        self.assertEqual(result["status"], "unknown")
        self.assertEqual(self.service.followups_list()["followups"][0]["status"], "needs_review")
        with self.assertRaises(outreach.OutreachError):
            self.service.send(draft["id"])

    def test_reply_binding_rejects_changed_contact_subject_unknown_message_and_header_injection(self):
        self.sync()
        args = dict(channel="gmail", recipient="buyer@example.org", subject="Re: Fixture offer", body="Reply fixture",
                    idempotencyKey="reply", replyToMessageId="sent1")
        for changes in ({"recipient": "other@example.org"}, {"subject": "different"}, {"replyToMessageId": "missing"}):
            with self.assertRaises(outreach.OutreachError):
                self.service.prepare(**{**args, **changes})
        result = self.service.prepare(**args)
        self.assertEqual(self.service.prepare(**args)["id"], result["id"])
        with self.assertRaises(outreach.OutreachError):
            self.service.prepare(**{**args, "replyToMessageId": None})
        with self.service._connect() as db:
            db.execute("UPDATE mailbox_messages SET rfc_message_id=?", ("<x@y>\r\nBcc: evil@example.org",))
        with self.assertRaises(outreach.OutreachError):
            self.service.prepare(**{**args, "idempotencyKey": "other"})

    def test_inbound_reply_uses_exact_sender_and_original_subject(self):
        self.sync(self.message(id="reply1", sender="Buyer <buyer@example.org>", labels=["INBOX"], timestamp="1790758800000"))
        reply = self.service.prepare(channel="gmail", recipient="buyer@example.org", subject="Fixture offer",
                                     body="Actual draft of fixture reply", idempotencyKey="reply", replyToMessageId="reply1")
        self.assertEqual(reply["reply_message_id"], "reply1")
        with patch.object(outreach, "_call_gmail", return_value={"status": "sent", "id": "next", "threadId": "thread1"}) as call:
            outreach.send_via_hermes(reply, self.home)
        self.assertEqual(call.call_args.args[0], "gmail_thread_send")
        self.assertEqual(call.call_args.args[1]["to"], "buyer@example.org")

    def test_invalid_thread_results_leave_no_partial_records_or_reply_states(self):
        self.schedule()
        good = self.message(id="reply1", sender="buyer@example.org", labels=[], timestamp="1790758800000")
        variants = [{"id": "wrong", "messages": [good]}, self.thread({**good, "internalDate": "invalid"}),
                    self.thread({**good, "threadId": "other"}), {"id": "thread1", "messages": [good]}]
        for result in variants:
            with patch.object(outreach, "_call_gmail", return_value=result):
                with self.assertRaises(outreach.OutreachError):
                    self.service.mailbox_sync(deliveryId=self.anchor["id"])
            with self.service._connect() as db:
                self.assertEqual(db.execute("SELECT count(*) FROM mailbox_messages").fetchone()[0], 0)
            self.assertEqual(self.service.followups_list()["followups"][0]["status"], "scheduled")

    def test_old_delivery_schema_migrates_without_losing_ids_or_idempotency(self):
        old_home = self.home / "old"
        path = old_home / outreach.LEDGER_PATH
        path.parent.mkdir(parents=True)
        with closing(sqlite3.connect(path)) as db:
            db.execute("""CREATE TABLE deliveries (id TEXT PRIMARY KEY,idem_key TEXT UNIQUE,payload_hash TEXT,
                channel TEXT,recipient TEXT,subject TEXT,body TEXT,company_id TEXT,status TEXT,
                provider_message_id TEXT,provider_thread_id TEXT,error_code TEXT,created_at TEXT,updated_at TEXT,attempted_at TEXT)""")
            with self.service._connect() as source:
                row = source.execute("SELECT * FROM deliveries WHERE id=?", (self.anchor["id"],)).fetchone()
                db.execute("INSERT INTO deliveries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", tuple(row)[:15])
            db.commit()
        upgraded = outreach.OutreachService(old_home, self.sender)
        found = upgraded.prepare(channel="gmail", recipient="buyer@example.org", subject="Fixture offer", body="Fixture initial message",
                                 companyId="fixture-company", idempotencyKey="initial")
        self.assertEqual(found["id"], self.anchor["id"])
        self.assertEqual(found["status"], "sent")


class GmailTransportTests(unittest.TestCase):
    def test_threaded_message_has_rfc_headers_and_exact_recipient_for_both_backends(self):
        args = {"to": "buyer@example.org", "subject": "Re: Fixture offer", "body": "你好，fixture",
                "thread_id": "thread1", "rfc_message_id": "<original@example.org>"}
        for gws in (False, True):
            calls = []
            class Service:
                def users(self): return self
                def messages(self): return self
                def send(self, **kwargs): calls.append(kwargs); return self
                def execute(self): return {"id": "fixture-id", "threadId": "thread1"}
            def run_gws(parts, **kwargs):
                self.assertEqual(parts, ["gmail", "users", "messages", "send"])
                calls.append(kwargs)
                return {"id": "fixture-id", "threadId": "thread1"}
            module = {"_gws_binary": lambda: gws, "_run_gws": run_gws, "build_service": lambda *args: Service()}
            with redirect_stdout(io.StringIO()):
                transport.execute(module, "gmail_thread_send", args)
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0]["body"]["threadId"], "thread1")
            mime = message_from_bytes(base64.urlsafe_b64decode(calls[0]["body"]["raw"]))
            self.assertEqual(mime["To"], args["to"])
            self.assertEqual(mime["In-Reply-To"], args["rfc_message_id"])
            self.assertEqual(mime["References"], args["rfc_message_id"])
            self.assertIsNone(mime["Cc"])
            self.assertEqual(mime.get_payload(decode=True).decode(), args["body"])

    def test_thread_read_is_bounded_and_never_modifies_labels(self):
        raw = {"id": "m1", "threadId": "t1", "internalDate": "1790755200000", "labelIds": ["INBOX"]}
        calls = []
        def run_gws(parts, **kwargs):
            calls.append(parts)
            return {"id": "t1", "messages": [raw]}
        module = {"_gws_binary": lambda: True, "_run_gws": run_gws,
                  "_headers_dict": lambda msg: {"from": "buyer@example.org", "message-id": "<m1@example.org>"},
                  "_extract_message_body": lambda msg: "x" * 6001}
        output = io.StringIO()
        with redirect_stdout(output):
            transport.execute(module, "gmail_thread", {"thread_id": "t1"})
        message = json.loads(output.getvalue())["messages"][0]
        self.assertEqual(len(message["body"]), 6000)
        self.assertTrue(message["bodyTruncated"])
        self.assertEqual(calls, [["gmail", "users", "threads", "get"]])


if __name__ == "__main__":
    unittest.main()
