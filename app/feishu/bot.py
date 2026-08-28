"""飞书机器人（长连接）：自然语言收任务 → 审批卡片 → 回发结果。

长连接模式：机器人主动连飞书（websocket），无需 HTTPS 回调地址，
适合无域名的云服务器。部署在 FastAPI lifespan 里后台线程运行。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading

import lark_oapi as lark
from lark_oapi.api.im.v1 import CreateMessageRequest, CreateMessageRequestBody
from lark_oapi.event.callback.model.p2_card_action_trigger import P2CardActionTriggerResponse
from lark_oapi.event.dispatcher_handler import EventDispatcherHandler
from lark_oapi.ws import Client as WsClient

from app.state import SDRTask

log = logging.getLogger("feishu.bot")

APPROVE_ACTION = "approve_all"

# 内存任务表：chat_id -> SDRTask（演示级；生产应落库）
_TASKS: dict[str, SDRTask] = {}
_http: lark.Client | None = None


def _get_http() -> lark.Client:
    global _http
    if _http is None:
        _http = (
            lark.Client.builder()
            .app_id(os.getenv("FEISHU_APP_ID", ""))
            .app_secret(os.getenv("FEISHU_APP_SECRET", ""))
            .log_level(lark.LogLevel.WARNING)
            .build()
        )
    return _http


def send_text(chat_id: str, text: str) -> None:
    req = (
        CreateMessageRequest.builder()
        .receive_id_type("chat_id")
        .request_body(
            CreateMessageRequestBody.builder()
            .receive_id(chat_id)
            .msg_type("text")
            .content(json.dumps({"text": text}, ensure_ascii=False))
            .build()
        )
        .build()
    )
    resp = _get_http().im.v1.message.create(req)
    if not resp.success():
        log.warning("send_text failed: %s %s", resp.code, resp.msg)


def send_card(chat_id: str, card: dict) -> None:
    req = (
        CreateMessageRequest.builder()
        .receive_id_type("chat_id")
        .request_body(
            CreateMessageRequestBody.builder()
            .receive_id(chat_id)
            .msg_type("interactive")
            .content(json.dumps(card, ensure_ascii=False))
            .build()
        )
        .build()
    )
    resp = _get_http().im.v1.message.create(req)
    if not resp.success():
        log.warning("send_card failed: %s %s", resp.code, resp.msg)


def _approval_card(task: SDRTask) -> dict:
    lines = [f"任务 {task.task_id} 已执行到「{task.stage}」，以下开发信待你审批："]
    for d in task.drafts:
        lines.append(f"- {d['email_id']}  **{d['company']}**\n  {d.get('subject', '')}")
    return {
        "config": {"wide_screen_mode": True},
        "header": {"title": {"tag": "plain_text", "content": "AI 员工：待审批开发信"}},
        "elements": [
            {"tag": "markdown", "content": "\n".join(lines)},
            {
                "tag": "action",
                "actions": [
                    {
                        "tag": "button",
                        "text": {"tag": "plain_text", "content": "全部批准"},
                        "type": "primary",
                        "value": {"action": APPROVE_ACTION, "task_id": task.task_id},
                    }
                ],
            },
        ],
    }


def _run_agent(task: SDRTask, prompt: str | None = None) -> dict:
    """跑 agent（阻塞，在后台线程里调用），返回 run_sdr 结果。"""
    from app.agent.agent import judge_intent, run_sdr
    from app.llm.client import get_model

    return asyncio.run(run_sdr(task, model=get_model(), prompt=prompt, structured=False))


def _approve_and_continue(task: SDRTask, chat_id: str, approver: str) -> None:
    from app.tools import gates

    pending = [
        d["email_id"]
        for d in task.drafts
        if task.approvals.get(d["email_id"], {}).get("status") != "approved"
    ]
    for eid in pending:
        gates.approve_email(task, eid, approver=approver)
    send_text(chat_id, f"已批准 {len(pending)} 封，继续执行…")
    result = _run_agent(
        task,
        prompt=(
            "人工审批已全部完成。请调用 advance_after_approval 确认批准完成，"
            "然后依次执行跟进计划、报价素材、结案，直到任务结束。"
        ),
    )
    if result.get("error"):
        send_text(chat_id, f"续跑出错：{result['error']}\n已执行到阶段：{task.stage}")
        return
    drafts = "\n".join(f"- {d['company']}: {d['email_id']}" for d in task.drafts)
    send_text(
        chat_id,
        f"任务 {task.task_id} 结案完成，阶段：{task.stage}\n"
        f"草稿：\n{drafts}\n审计条目：{len(task.audit_log)}",
    )


_INTRO = (
    "我是 ai-sdr，外贸客户开发 AI 员工。\n"
    "把你想开发的客户目标发给我就行，例如：\n"
    "「帮我找 5 个美国做户外用品的客户」\n"
    "我会自动找客户、背调、评分、写开发信，经你审批后继续生成跟进计划。\n"
    "审批时回复「批准」或点卡片按钮即可。"
)

_GREETING_KEYWORDS = (
    "你好", "您好", "hi", "hello", "你是谁", "做什么", "干嘛", "干嘛的",
    "能干什么", "能干嘛", "帮助", "help", "怎么用", "介绍下", "介绍一下",
)


def _completion_summary(task: SDRTask) -> str:
    """无论模型有没有最终输出，都从任务状态拼一份结果汇总。"""
    lines = [f"任务 {task.task_id} 执行完成，阶段：{task.stage}"]
    if task.prospects:
        names = "、".join(p["company"] for p in task.prospects[:5])
        lines.append(f"- 找到客户 {len(task.prospects)} 家：{names}")
    else:
        lines.append("- 找到客户：0 家（样例数据里可能没有匹配的产品/市场）")
    if task.scores:
        top = "、".join(f"{c}({s['score']})" for c, s in list(task.scores.items())[:3])
        lines.append(f"- 评分 Top：{top}")
    if task.drafts:
        for d in task.drafts:
            lines.append(f"- 草稿 {d['email_id']} {d['company']}：{d.get('subject', '')}")
    else:
        lines.append("- 开发信草稿：0 封")
    lines.append(f"- 跟进计划：{len(task.follow_ups)} 条")
    lines.append(f"- 审计条目：{len(task.audit_log)} 条")
    return "\n".join(lines)


def handle_message(data) -> None:
    msg = data.event.message if data and data.event else None
    if msg is None or msg.message_type != "text":
        return
    chat_id = msg.chat_id
    try:
        text = json.loads(msg.content).get("text", "")
    except Exception:
        text = msg.content or ""
    text = text.strip().replace("@_user_1", "").strip()
    if not text:
        return

    # 打招呼/自我介绍/帮助：直接回复，不启动工作流
    if any(k in text.lower() for k in _GREETING_KEYWORDS):
        send_text(chat_id, _INTRO)
        return

    # 审批命令
    if text in ("批准", "批准全部", "approve"):
        task = _TASKS.get(chat_id)
        if task and task.stage == "human_approval":
            operator = (data.event.sender.sender_id.open_id if data.event.sender else "feishu")
            threading.Thread(target=_approve_and_continue, args=(task, chat_id, operator), daemon=True).start()
        else:
            send_text(chat_id, "当前没有待审批的任务。")
        return

    def worker() -> None:
        from app.agent.agent import judge_intent
        from app.llm.client import get_model

        task = SDRTask(task_id=f"FS{len(_TASKS) + 1}", task=text)
        _TASKS[chat_id] = task

        # 意图判断：不是客户开发任务就正常回复，不启动工作流
        intent = None
        try:
            intent = asyncio.run(judge_intent(text, get_model()))
            log.info("intent %s -> is_task=%s", text[:20], intent.is_task)
        except Exception as e:
            log.warning("intent judge failed: %s", e)
        if intent is None:
            # 判断失败：保守按「非任务」处理，绝不盲跑工作流
            send_text(chat_id, "我是外贸客户开发 AI 员工。\n\n" + _INTRO)
            return
        if not intent.is_task:
            send_text(chat_id, f"我主要负责外贸客户开发。{intent.reason}\n\n" + _INTRO)
            return

        send_text(chat_id, f"收到任务，AI 员工开始干活（任务 {task.task_id}）…")
        result = _run_agent(task)
        if result.get("error"):
            send_text(chat_id, f"执行出错：{result['error']}\n已执行到阶段：{task.stage}")
            return
        if task.stage == "task_parse" and not task.audit_log:
            # 一个工具都没调：模型没理解，不假报完成
            send_text(
                chat_id,
                "这个指令我没太理解。请给我一个具体的客户开发任务，例如：\n"
                "「帮我找 5 个美国做户外用品的客户」",
            )
            return
        if task.stage == "human_approval" and task.drafts:
            send_card(chat_id, _approval_card(task))
        else:
            send_text(chat_id, _completion_summary(task))

    threading.Thread(target=worker, daemon=True).start()


def handle_card_action(data) -> P2CardActionTriggerResponse:
    action = data.event.action if data and data.event else None
    value = action.value or {}
    ctx = data.event.context if data and data.event else None
    chat_id = ctx.open_chat_id if ctx else None
    task = _TASKS.get(chat_id) if chat_id else None
    operator = (
        data.event.operator.open_id
        if data and data.event and data.event.operator
        else "feishu"
    )

    if task and value.get("action") == APPROVE_ACTION:
        threading.Thread(
            target=_approve_and_continue, args=(task, chat_id, operator), daemon=True
        ).start()

    return P2CardActionTriggerResponse()


def start() -> None:
    """启动长连接机器人（阻塞；建议后台线程调用）。"""
    app_id = os.getenv("FEISHU_APP_ID", "")
    app_secret = os.getenv("FEISHU_APP_SECRET", "")
    if not app_id or not app_secret:
        raise RuntimeError("FEISHU_APP_ID / FEISHU_APP_SECRET 未配置")
    handler = (
        EventDispatcherHandler.builder("", "")
        .register_p2_im_message_receive_v1(handle_message)
        .register_p2_card_action_trigger(handle_card_action)
        .build()
    )
    ws = WsClient(app_id, app_secret, event_handler=handler, log_level=lark.LogLevel.WARNING)
    log.info("飞书机器人已启动（长连接）")
    ws.start()
