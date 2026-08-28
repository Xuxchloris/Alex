"""Pydantic AI 2.23.0 驱动的 SDR Agent 循环。

Agent 由 LLM 主导决策、按 9 阶段 SOP 依次调用工具；
阶段前置校验由每个工具内部的 require_stage 保证，邮件未批绝不可发。
结案时由独立的报告子 Agent 用 output_type 产出结构化 SDRReport。
"""

from __future__ import annotations

import json

from pydantic_ai import Agent
from pydantic_ai.models import Model
from pydantic_ai.mcp import MCPToolset
from pydantic_ai.tools import Tool

from app.schemas import Intent, SDRReport
from app.state import SDRTask, save_task
from app.tools import build_tools
from app.tools.mcp import build_mcp_toolsets

SOP_PROMPT = """你是一名外贸客户开发 AI 员工(SDR),严格按照以下 SOP 处理任务。

必须按顺序经过 9 个阶段,每完成一个阶段就调用对应工具推进,并把产出写回任务对象:
1. task_parse        任务解析 -> 调用 plan_task 拆解目标市场/产品/数量
2. prospect_discovery 客户发现 -> 调用 search_prospects 找潜在客户
3. company_research   公司背调 -> 调用 research_company 逐家调研
4. prospect_scoring   客户评分 -> 调用 score_prospects 按匹配度打分
5. email_draft        开发信草稿 -> 调用 draft_email 为高价值客户写邮件
6. human_approval     人工审批 -> 必须先调用 request_approval 挂起等待人工批准
7. follow_up_plan     跟进计划 -> 调用 plan_follow_ups 制定跟进节奏
8. quotation_pack     报价素材 -> 调用 build_quotation_pack 准备报价/产品资料
9. close              结案 -> 调用 close_task 汇总交付并结束

铁律:
- 严格按阶段顺序执行,绝不可跳阶段或乱序调用工具;工具自带阶段前置校验,越权会抛 StageError。
- 到达 human_approval 阶段,必须先调用 request_approval 请求人工批准,得到批准后才能继续。
- 绝不未经审批调用 send_email;只有 request_approval 获得人工批准后才允许发送邮件。
- 每一步的产出都要通过工具落回任务对象(prospects/research/scores/drafts 等字段),
  不要只停留在对话里。
- 9 个阶段全部走完后调用 close_task 结案。
"""


def build_agent(
    model: Model | None = None,
    tools: list[Tool] | None = None,
    toolsets: list[MCPToolset] | None = None,
    max_concurrency: int | None = 5,
) -> Agent:
    """构造 SDR Agent。

    model 可为 None，运行前通过 run_sdr(..., model=model) 注入。
    max_concurrency: 背调/搜索等阶段允许并行调用的工具数。
    """
    agent = Agent(
        model=model,
        deps_type=SDRTask,
        system_prompt=SOP_PROMPT,
        tools=tools if tools is not None else build_tools(),
        toolsets=toolsets if toolsets is not None else build_mcp_toolsets(),
        name="ai-sdr",
        max_concurrency=max_concurrency,
    )
    return agent


REPORT_PROMPT = (
    "你是外贸客户开发任务的结案报告生成器。根据提供的任务执行摘要，"
    "严格用结构化字段生成结案报告；数字必须与摘要一致，不得编造。"
)


def build_report_agent(model: Model | None = None) -> Agent:
    """独立的报告子 Agent：output_type=SDRReport，产出类型安全结案报告。"""
    return Agent(
        model=model,
        output_type=SDRReport,
        system_prompt=REPORT_PROMPT,
        name="ai-sdr-report",
    )


INTENT_PROMPT = (
    "你是任务意图判断器。判断用户的话是否是一个「外贸客户开发」任务——"
    "即是否包含找客户、开发客户、写开发信、跟进、报价、找分销商/买家等明确意图。\n"
    "闲聊、问候、与客户开发无关的问题一律判为非任务。"
)


def build_intent_agent(model: Model | None = None) -> Agent:
    """意图判断子 Agent：判断一句话要不要跑 SDR 工作流。"""
    return Agent(
        model=model,
        output_type=Intent,
        system_prompt=INTENT_PROMPT,
        name="ai-sdr-intent",
    )


async def judge_intent(text: str, model: Model) -> Intent:
    """判断用户输入是不是客户开发任务。"""
    agent = build_intent_agent(model)
    result = await agent.run(text)
    return result.output


def _sanitize(value):
    """把任意对象转成可 JSON 序列化的值（防止事件内容混入非原始类型）。"""
    if isinstance(value, dict):
        return {str(k): _sanitize(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_sanitize(v) for v in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def _args_of(part) -> dict:
    """取工具调用的参数（args_as_dict 是方法，需调用）。"""
    getter = getattr(part, "args_as_dict", None)
    if callable(getter):
        return getter() or {}
    return getter or {}


async def run_sdr_stream(
    task: SDRTask,
    model: Model | None = None,
    agent: Agent | None = None,
    prompt: str | None = None,
):
    """框架级执行流：自动审计 + 每步持久化 + 进度事件（替代手动 audit）。

    消费 run_stream_events：
    - 每次工具调用自动写入 audit_log（框架保证，业务代码不再手动审计）
    - 每步把任务状态落盘（断点续跑）
    - 逐条产出事件给调用方（飞书/前端实时推送）：
      {"type":"tool_call","tool","args"} / {"type":"tool_result",...} / {"type":"done","stage","output"}
    """
    if agent is None:
        agent = build_agent(model=model)
    async with agent.run_stream_events(prompt or task.task, deps=task) as stream:
        async for ev in stream:
            kind = getattr(ev, "event_kind", None)
            if kind == "function_tool_call":
                part = getattr(ev, "part", None)
                name = getattr(part, "tool_name", None) or "?"
                args = _args_of(part)
                task.audit(f"tool_call:{name}", {"args": _sanitize(args)})
                save_task(task)
                yield {"type": "tool_call", "tool": name, "args": args}
            elif kind == "function_tool_result":
                part = getattr(ev, "part", None)
                name = getattr(part, "tool_name", None) or "?"
                content = getattr(ev, "content", None)
                if content is None:
                    content = getattr(part, "content", None)
                task.audit(f"tool_result:{name}", {"result": _sanitize(content)})
                save_task(task)
                yield {"type": "tool_result", "tool": name, "result": content}
            elif hasattr(ev, "output"):
                yield {"type": "done", "stage": task.stage, "output": ev.output}
                return


async def run_sdr(
    task: SDRTask,
    model: Model | None = None,
    agent: Agent | None = None,
    prompt: str | None = None,
    structured: bool = True,
) -> dict:
    """运行一次 SDR 任务（可分段续跑），返回结果摘要与结构化结案报告。

    agent 未传时用 build_agent(model=model) 现造；deps 传入任务对象，
    工具通过 RunContext[SDRTask].deps 就地修改任务状态。
    审计与持久化由 run_sdr_stream 的框架级事件流完成。
    prompt 缺省用任务原文；续跑时传推进指令即可。
    structured=True 且任务已到 close 阶段时，用报告子 Agent 生成 SDRReport。
    """
    output = None
    try:
        async for ev in run_sdr_stream(task, model=model, agent=agent, prompt=prompt):
            if ev.get("type") == "done":
                output = ev.get("output")
    except Exception as e:  # 兜底：工具/网络异常不丢任务状态，携带部分进度
        return {
            "task_id": task.task_id,
            "stage": task.stage,
            "audit_entries": len(task.audit_log),
            "model_output": output,
            "error": str(e),
        }
    out: dict = {
        "task_id": task.task_id,
        "stage": task.stage,
        "audit_entries": len(task.audit_log),
        "model_output": output,
    }
    if structured and task.stage == "close":
        rep_agent = build_report_agent(model=model)
        rep_result = await rep_agent.run(
            f"任务 {task.task_id} 已执行到阶段 {task.stage}。"
            f"请根据以下执行摘要生成结案报告:\n"
            f"{json.dumps(task.to_dict(), ensure_ascii=False, indent=2)}"
        )
        out["report"] = rep_result.output.model_dump()
    return out
