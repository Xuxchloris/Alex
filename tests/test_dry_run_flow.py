import pytest

pytest.importorskip("pydantic_ai")
pytest.importorskip("mcp")

from app.mcp import server
from app.state import SDRTask
from app.tools import close, discovery, gates, planning, quotation, research, scoring


def test_dry_run_reaches_close_after_approval():
    task = SDRTask(task_id="T-dry", task="开发 3 个美国户外用品客户")
    server._dry_plan(task)
    assert server._summary(task)["task_id"] == task.task_id
    discovery.run_discovery(task)
    research.run_research(task)
    scoring.run_scoring(task)
    server._dry_drafts(task)
    assert all(
        draft["draft_hash"] == gates.draft_fingerprint(task, draft["email_id"])
        for draft in task.drafts
    )

    for draft in task.drafts:
        gates.request_approval(task, draft["email_id"])
        gates.approve_email(task, draft["email_id"], draft_hash=draft["draft_hash"])
    gates.advance_after_approval(task)
    planning.run_followups(task)
    quotation.run_quotation(task)
    result = close.run_close(task)

    assert task.stage == "close"
    assert result["summary"]["approved"] == len(task.drafts)
    assert result["summary"]["drafts"] == len(task.drafts)
