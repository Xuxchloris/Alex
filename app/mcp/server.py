"""FastMCP server exposing the existing SDR state machine to DSH.

The server deliberately does not publish approve_email or send_email. Approval
is completed by the DSH native gate, while the Python send出口 remains the
authoritative business check in app.tools.gates.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
from typing import Literal

from mcp.server.fastmcp import FastMCP
from starlette.requests import Request
from starlette.responses import JSONResponse

from app.state import SDRTask, STAGES
from app.storage.repository import TaskRepository
from app.tools import close, discovery, email, gates, planning, quotation, research, scoring
from app.tools.data import load_case_notes


StageName = Literal[
    "task_parse",
    "prospect_discovery",
    "company_research",
    "prospect_scoring",
    "email_draft",
    "human_approval",
    "follow_up_plan",
    "quotation_pack",
    "close",
]


def _flag(name: str, default: bool = True) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.lower() not in {"0", "false", "no", "off"}


DRY_RUN = _flag("DSH_SDR_DRY_RUN", True)
REPO = TaskRepository()
mcp = FastMCP(
    "dsh-sdr",
    instructions="外贸获客 SDR 状态机。严格按阶段调用，邮件只允许草稿和已审批后的受控队列。",
    host=os.getenv("DSH_SDR_MCP_HOST", "127.0.0.1"),
    port=int(os.getenv("DSH_SDR_MCP_PORT", "8765")),
    streamable_http_path="/mcp",
)


def _summary(task: SDRTask) -> dict:
    return {
        "task_id": task.task_id,
        "task": task.task,
        "stage": task.stage,
        "market": task.market or task.plan.get("market", ""),
        "product": task.product or task.plan.get("product", ""),
        "prospects_count": len(task.prospects),
        "drafts_count": len(task.drafts),
        "approvals": task.approvals,
        "follow_ups_count": len(task.follow_ups),
        "quotation_count": len(task.quotation_pack),
        "dry_run": DRY_RUN,
    }


def _find_market(text: str) -> str:
    for keyword, code in (("美国", "US"), ("欧盟", "EU"), ("欧洲", "EU"), ("日本", "JP"), ("东南亚", "SEA")):
        if keyword in text:
            return code
    return "US"


def _find_count(text: str) -> int:
    match = re.search(r"(\d+)\s*(?:个|家)", text)
    return int(match.group(1)) if match else 0


def _dry_plan(task: SDRTask) -> dict:
    task.require_stage("plan_task")
    task.plan = {
        "submit": task.task,
        "market": task.market or _find_market(task.task),
        "product": task.product or (task.task.split("客户", 1)[0].strip() or "户外用品"),
        "target_count": _find_count(task.task),
        "available_prospects": 0,
    }
    task.market = task.plan["market"]
    task.product = task.plan["product"]
    task.advance("task_parse")
    return {"plan": task.plan, "stage": task.stage}


def _stable_draft(task: SDRTask, company: str, index: int) -> dict:
    evidence = task.research.get(company, {}).get("evidence", [])
    product = task.plan.get("product", "户外用品")
    subject = f"{product} catalogue for {company}"
    body = (
        f"Hello {company} team,\n\n"
        f"We noticed your public business profile in the outdoor market. "
        f"Our synthetic demo catalogue includes {product}. "
        "Would a short catalogue review be useful?\n\n"
        "Best regards,\nSDR demo team"
    )
    draft_hash = hashlib.sha256(f"{subject}\n{body}".encode("utf-8")).hexdigest()
    return {
        "email_id": f"draft_{index:02d}",
        "company": company,
        "subject": subject,
        "body": body,
        "citations": evidence,
        "case_notes": [n["title"] for n in load_case_notes()[:2]],
        "guardrail": "passed",
        "draft_hash": draft_hash,
    }


def _dry_drafts(task: SDRTask, limit: int = 3) -> dict:
    task.require_stage("draft_email")
    task.drafts = [_stable_draft(task, company, index) for index, company in enumerate(list(task.scores)[:limit], 1)]
    task.advance("email_draft")
    return {"drafts": task.drafts, "stage": task.stage, "dry_run": True}


def _pending(task: SDRTask) -> list[dict]:
    return [
        draft for draft in task.drafts
        if task.approvals.get(draft["email_id"], {}).get("status") != "approved"
    ]


@mcp.tool()
def create_task(task: str, market: str = "", product: str = "") -> dict:
    """创建一个 SDR 任务，返回 task_id。"""
    existing = REPO.list()
    seq = max((int(t.task_id[1:]) for t in existing if t.task_id.startswith("T") and t.task_id[1:].isdigit()), default=0) + 1
    item = SDRTask(task_id=f"T{seq}", task=task, market=market, product=product)
    item.audit("mcp:create_task", {"task": task, "dry_run": DRY_RUN})
    REPO.save(item)
    return _summary(item)


@mcp.tool()
async def run_sdr_stage(task_id: str, stage: StageName) -> dict:
    """按当前阶段执行一个 SOP 阶段；阶段顺序由 Python 状态机校验。"""
    task = REPO.get(task_id)
    if task is None:
        return {"error": f"task not found: {task_id}"}
    if stage != task.stage:
        return {"error": f"stage mismatch: requested {stage}, current {task.stage}"}
    if stage == "task_parse":
        result = _dry_plan(task) if DRY_RUN else await planning.run_plan(task)
    elif stage == "prospect_discovery":
        result = discovery.run_discovery(task)
    elif stage == "company_research":
        result = research.run_research(task)
    elif stage == "prospect_scoring":
        result = scoring.run_scoring(task)
    elif stage == "email_draft":
        result = _dry_drafts(task) if DRY_RUN else await email.run_draft(task)
    elif stage == "human_approval":
        result = request_approval(task_id)
    elif stage == "follow_up_plan":
        result = planning.run_followups(task)
    elif stage == "quotation_pack":
        result = quotation.run_quotation(task)
    elif stage == "close":
        result = close.run_close(task)
    else:
        return {"error": f"unsupported stage: {stage}"}
    task.audit("mcp:stage", {"stage": stage, "dry_run": DRY_RUN})
    REPO.save(task)
    return {"result": result, "task": _summary(task)}


@mcp.tool()
def request_approval(task_id: str) -> dict:
    """提交所有草稿进入人工审批；不批准、不发送。"""
    task = REPO.get(task_id)
    if task is None:
        return {"error": f"task not found: {task_id}"}
    if task.stage != "human_approval":
        return {"error": f"approval unavailable at stage {task.stage}"}
    for draft in task.drafts:
        gates.request_approval(task, draft["email_id"])
    task.audit("mcp:request_approval", {"pending": len(_pending(task))})
    REPO.save(task)
    return {"task": _summary(task), "drafts": task.drafts, "pending": _pending(task)}


@mcp.tool()
def get_pending_drafts(task_id: str) -> dict:
    """读取审批卡片所需的待批草稿；此工具不改变审批状态。"""
    task = REPO.get(task_id)
    if task is None:
        return {"error": f"task not found: {task_id}"}
    return {"task_id": task_id, "stage": task.stage, "drafts": _pending(task)}


@mcp.tool()
def advance_after_approval(task_id: str) -> dict:
    """仅当所有草稿已有持久化 approved 凭证时推进到跟进阶段。"""
    task = REPO.get(task_id)
    if task is None:
        return {"error": f"task not found: {task_id}"}
    try:
        result = gates.advance_after_approval(task)
    except Exception as exc:
        return {"error": str(exc), "task": _summary(task)}
    task.audit("mcp:advance_after_approval", {})
    REPO.save(task)
    return {"result": result, "task": _summary(task)}


@mcp.tool()
def get_task(task_id: str) -> dict:
    """读取任务当前状态和摘要。"""
    task = REPO.get(task_id)
    return {"error": f"task not found: {task_id}"} if task is None else _summary(task)


@mcp.tool()
def get_audit_log(task_id: str) -> dict:
    """读取 Python 侧可回放审计日志。"""
    task = REPO.get(task_id)
    return {"error": f"task not found: {task_id}"} if task is None else {
        "task_id": task_id,
        "entries": task.audit_log,
        "count": len(task.audit_log),
    }


@mcp.custom_route("/health", methods=["GET"], include_in_schema=False)
async def health(_: Request) -> JSONResponse:
    return JSONResponse({"status": "ok", "service": "dsh-sdr", "dry_run": DRY_RUN})


@mcp.custom_route("/control/approve", methods=["POST"], include_in_schema=False)
async def control_approve(request: Request) -> JSONResponse:
    """Private loopback control path used only by the native DSH approval tool."""
    try:
        body = await request.json()
        task = REPO.get(str(body.get("task_id", "")))
        if task is None:
            return JSONResponse({"error": "task not found"}, status_code=404)
        result = gates.approve_email(
            task,
            str(body.get("email_id", "")),
            approver=str(body.get("approver", "dsh-user")),
            draft_hash=body.get("draft_hash"),
            source=str(body.get("source", "dsh")),
        )
        REPO.save(task)
        return JSONResponse({"result": result, "task": _summary(task)})
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)


@mcp.custom_route("/control/pending", methods=["GET"], include_in_schema=False)
async def control_pending(request: Request) -> JSONResponse:
    task_id = request.query_params.get("task_id", "")
    task = REPO.get(task_id)
    if task is None:
        return JSONResponse({"error": "task not found"}, status_code=404)
    return JSONResponse({"task_id": task_id, "stage": task.stage, "drafts": _pending(task)})


@mcp.custom_route("/control/audit", methods=["GET"], include_in_schema=False)
async def control_audit(request: Request) -> JSONResponse:
    """Private loopback audit projection for the native DSH audit tool."""
    task_id = request.query_params.get("task_id", "")
    task = REPO.get(task_id)
    if task is None:
        return JSONResponse({"error": "task not found"}, status_code=404)
    return JSONResponse({"task_id": task_id, "entries": task.audit_log, "count": len(task.audit_log)})


def main() -> None:
    parser = argparse.ArgumentParser(description="dsh-sdr MCP server")
    parser.add_argument("--transport", choices=("stdio", "streamable-http"), default="stdio")
    args = parser.parse_args()
    mcp.run(transport=args.transport)


if __name__ == "__main__":
    main()
