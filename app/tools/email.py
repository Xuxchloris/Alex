"""阶段5 开发信草稿：LLM 生成 + 合规校验（Guardrails）。

生成流程：内部草稿子 Agent（output_type=DraftEmail）写正文 →
draft_violations 合规校验 → 违规则让模型重写一次 → 仍违规丢弃不入库。
"""

from __future__ import annotations

from pydantic_ai import Agent

from app.guardrails import draft_violations
from app.schemas import DraftEmail
from app.state import SDRTask
from app.tools.data import load_case_notes

DRAFT_PROMPT = (
    "你是外贸开发信写手。根据客户信息与证据写一封个性化开发信。\n"
    "铁律：\n"
    "1) 不得编造联系人姓名、电话、邮箱、微信号等联系信息；\n"
    "2) 不得虚构客户采购意向、下单承诺或成交量；\n"
    "3) 只引用提供的真实客户信息（业务/官网证据）与产品信息；\n"
    "4) 语气专业、简洁、礼貌。"
)


def _build_draft_agent(model) -> Agent:
    return Agent(model, output_type=DraftEmail, system_prompt=DRAFT_PROMPT, name="ai-sdr-draft")


async def _generate(draft_agent: Agent, prompt: str, feedback: str | None = None) -> DraftEmail:
    text = prompt
    if feedback:
        text += "\n\n上次草稿违反合规，请重写（禁止编造联系信息或采购意向）：\n" + feedback
    result = await draft_agent.run(text)
    return result.output


async def run_draft(task: SDRTask, limit: int = 3) -> dict:
    task.require_stage("draft_email")
    from app.llm.client import get_model  # 惰性取模型，避免 import 时连网

    model = get_model()
    draft_agent = _build_draft_agent(model)
    notes = load_case_notes()
    tips = "；".join(n["title"] for n in notes[:2])

    drafts: list[dict] = []
    blocked: list[dict] = []
    for idx, company in enumerate(list(task.scores)[:limit], start=1):
        research = task.research.get(company, {})
        prompt = (
            f"目标客户：{company}\n"
            f"客户业务证据：{research.get('snippet', company)}\n"
            f"产品：{task.plan.get('product', '便携储能电源')}\n"
            f"案例经验：{tips or '无'}\n"
            f"请按 DraftEmail 结构生成开发信。"
        )
        draft = await _generate(draft_agent, prompt)
        issues = draft_violations(draft.subject, draft.body)
        if issues:
            draft = await _generate(draft_agent, prompt, "；".join(issues))
            issues = draft_violations(draft.subject, draft.body)
        if issues:
            blocked.append({"company": company, "violations": issues})
            continue  # 合规红线：不合规草稿不入库

        drafts.append({
            "email_id": f"draft_{idx:02d}",
            "company": company,
            "subject": draft.subject,
            "body": draft.body,
            "citations": research.get("evidence", []),
            "case_notes": tips,
            "guardrail": "passed",
        })

    task.drafts = drafts
    task.advance("email_draft")
    return {
        "drafts": len(drafts),
        "draft_ids": [d["email_id"] for d in drafts],
        "blocked_by_guardrail": blocked,
    }
