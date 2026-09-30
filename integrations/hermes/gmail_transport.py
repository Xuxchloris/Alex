"""Bounded Gmail thread reads and threaded plain-text sends via Hermes OAuth.

Executed only by outreach.py, in Hermes' Python with its fixed Google script.
No credentials, source paths or operations are supplied by model tools.
"""

import argparse
import base64
from email.mime.text import MIMEText
import json
import runpy
import sys


def execute(module, operation, args):
    if operation in ("gmail_search", "gmail_get", "gmail_send"):
        module[operation](argparse.Namespace(**args))
        return
    if operation not in ("gmail_thread", "gmail_thread_send"):
        raise ValueError("Unsupported Gmail operation")
    gws = module["_gws_binary"]()
    service = None if gws else module["build_service"]("gmail", "v1")
    if operation == "gmail_thread":
        params = {"userId": "me", "id": args["thread_id"], "format": "full"}
        thread = (module["_run_gws"](["gmail", "users", "threads", "get"], params=params)
                  if gws else service.users().threads().get(**params).execute())
        messages = thread.get("messages", [])
        if not isinstance(messages, list) or not 1 <= len(messages) <= 200:
            raise ValueError("Thread is empty or exceeds the 200-message limit")
        output = []
        for message in messages:
            headers = module["_headers_dict"](message)
            body = module["_extract_message_body"](message)
            output.append({
                "id": message["id"], "threadId": message["threadId"],
                "from": headers.get("from", ""), "to": headers.get("to", ""),
                "subject": headers.get("subject", ""), "date": headers.get("date", ""),
                "rfcMessageId": headers.get("message-id", ""),
                "internalDate": message.get("internalDate"),
                "labels": message.get("labelIds", []), "body": body[:6000],
                "bodyTruncated": len(body) > 6000,
            })
        print(json.dumps({"id": thread["id"], "messages": output}, ensure_ascii=False))
        return
    # Values are a saved, validated delivery snapshot. In particular To is not
    # replaced by an untrusted Reply-To header or an inferred thread participant.
    message = MIMEText(args["body"], "plain", "utf-8")
    message["To"] = args["to"]
    message["Subject"] = args["subject"]
    message["In-Reply-To"] = args["rfc_message_id"]
    message["References"] = args["rfc_message_id"]
    body = {"raw": base64.urlsafe_b64encode(message.as_bytes()).decode(), "threadId": args["thread_id"]}
    result = (module["_run_gws"](["gmail", "users", "messages", "send"], params={"userId": "me"}, body=body)
              if gws else service.users().messages().send(userId="me", body=body).execute())
    print(json.dumps({"status": "sent", "id": result["id"], "threadId": result.get("threadId", "")}))


if __name__ == "__main__":
    execute(runpy.run_path(sys.argv[1], run_name="alex_gmail_transport"), sys.argv[2], json.load(sys.stdin))
