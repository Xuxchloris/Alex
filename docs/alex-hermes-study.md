# Hermes 源码研究与 Alex 的实现选择

核验日期：2026-09-30。Alex v0.3 采用 Hermes 原生 profile distribution、插件和技能，让同一个 Agent 内核承担对话、规划、工具调用、记忆及消息路由。客户和证据等结构化业务资产继续由 Alex 服务持久保存。

## 研究版本

- **固定参考版**：[v2026.9.24 / v0.21.5](https://github.com/NousResearch/hermes-agent/commit/f97608f178d1ffeca59860195ab7da295f7c8e5f)，代码提交 `f97608f178d1ffeca59860195ab7da295f7c8e5f`，tree `5849eacde63aaea608ca418821cc84771fce3bec`。额外核对了该提交的 profile、distribution 和 plugin 实现。
- **本机实际审阅与原生加载验证版**：[v0.21.3](https://github.com/NousResearch/hermes-agent/commit/db39ee3f2892185087bb2432eac242361056fc19)，代码提交 `db39ee3f2892185087bb2432eac242361056fc19`。已通过该版本真实 CLI 安装独立 Alex profile，真实插件加载器注册 24 项工具。

下面源码链接固定到实际审阅提交，避免上游主线更新后路径和行为漂移。加载与安装成功不代表模型、邮箱、WhatsApp 或真实客户任务已完成端到端验收。

## 从实际调用链得出的选择

| 机制 | 官方源码 | Alex 如何复用 |
| --- | --- | --- |
| Agent 循环 | [AIAgent](https://github.com/NousResearch/hermes-agent/blob/db39ee3f2892185087bb2432eac242361056fc19/run_agent.py)、[conversation_loop](https://github.com/NousResearch/hermes-agent/blob/db39ee3f2892185087bb2432eac242361056fc19/agent/conversation_loop.py) | 同一循环负责模型请求、重试、工具轮次与完成判断；Alex 不再自建第二个顶层循环 |
| 工具派发 | [model_tools](https://github.com/NousResearch/hermes-agent/blob/db39ee3f2892185087bb2432eac242361056fc19/model_tools.py)、[registry](https://github.com/NousResearch/hermes-agent/blob/db39ee3f2892185087bb2432eac242361056fc19/tools/registry.py) | `register_tool` 接入 Alex 领域工具，返回实际结构化结果 |
| Profile 隔离 | [profiles](https://github.com/NousResearch/hermes-agent/blob/db39ee3f2892185087bb2432eac242361056fc19/hermes_cli/profiles.py)、[CLI 入口](https://github.com/NousResearch/hermes-agent/blob/db39ee3f2892185087bb2432eac242361056fc19/hermes_cli/main.py) | 在启动子进程前设置精确 `HERMES_HOME`，不改变或复制默认 profile |
| 原生发行 | [profile_distribution](https://github.com/NousResearch/hermes-agent/blob/db39ee3f2892185087bb2432eac242361056fc19/hermes_cli/profile_distribution.py) | 官方 `profile install` 安装、`profile update` 更新；保留用户配置和数据 |
| 身份与技能 | [prompt_builder](https://github.com/NousResearch/hermes-agent/blob/db39ee3f2892185087bb2432eac242361056fc19/agent/prompt_builder.py)、[插件接口](https://github.com/NousResearch/hermes-agent/blob/db39ee3f2892185087bb2432eac242361056fc19/hermes_cli/plugins.py) | SOUL 定义外贸身份；普通 profile 技能提供入门、研究与跟进流程 |
| 长期记忆 | [memory_tool](https://github.com/NousResearch/hermes-agent/blob/db39ee3f2892185087bb2432eac242361056fc19/tools/memory_tool.py)、[MemoryStore](https://github.com/NousResearch/hermes-agent/blob/db39ee3f2892185087bb2432eac242361056fc19/tools/memory_tool_store.py) | Hermes 保存精炼偏好和经验，Alex 数据库保存客户、证据和任务事实 |
| 会话与网关 | [turn_facade](https://github.com/NousResearch/hermes-agent/blob/db39ee3f2892185087bb2432eac242361056fc19/agent/turn_facade.py)、[gateway/run_turn](https://github.com/NousResearch/hermes-agent/blob/db39ee3f2892185087bb2432eac242361056fc19/gateway/run_turn.py) | CLI 和消息入口共享 Agent 机制，会话由 Hermes 持久保存 |
| 定时工作 | [cron/scheduler](https://github.com/NousResearch/hermes-agent/blob/db39ee3f2892185087bb2432eac242361056fc19/cron/scheduler.py) | 用户 CLI 配置的任务复用 AIAgent、SOUL 和记忆；默认不向模型开放 cronjob 工具 |
| 品牌皮肤 | [skin_engine](https://github.com/NousResearch/hermes-agent/blob/db39ee3f2892185087bb2432eac242361056fc19/hermes_cli/skin_engine.py) | `skins/alex.yaml` 设置 Alex 名称、欢迎语和视觉品牌，无需改 Hermes core |

`conversation_loop` 在每轮组装模型请求，规范化响应后区分工具调用与最终答复，工具结果经派发器写回上下文；还处理预算、重试、压缩和失败边界。因此 Alex 使用这个成熟循环，领域层只负责真实业务动作。研究时由当前 Agent 自己规划，再调用 `alex_task_create`，不调用保留兼容的 `alex_plan` 形成第二层顶级规划。

## 已落实的工程接口

仓库 `agent/` 提供 SOUL、config、三项普通技能、skin 和 distribution manifest。启动器把它与 `integrations/hermes/` 插件组成发行目录，默认安装到 `~/.alex/profiles/alex`。

```bash
npm run alex -- init
npm run alex -- model
npm run alex -- chat
npm run alex -- gateway setup
npm run alex -- gateway run
```

`plugins.enabled` 显式启用 `alex`。CLI、邮箱、WhatsApp、WhatsApp Cloud 及用户配置的 cron 使用限定的 `alex`、`skills`、`memory`、`session_search`、`todo` 工具集。默认禁用通用终端、文件、代码执行、额外消息与 cronjob 等工具，客户外发通过 Alex 账本与 owner 策略执行。用户可以通过本机 `npm run alex -- cron ...` 配置调度。

一个容易遗漏的上游契约是：`ctx.register_skill()` 注册的 `alex:trade-research` 必须显式 `skill_view`，不会自动出现在普通技能索引。因此 v0.3 将核心流程作为 `agent/skills/` 中的普通技能发行。

## 渠道能力与待验收范围

- [Email adapter](https://github.com/NousResearch/hermes-agent/blob/db39ee3f2892185087bb2432eac242361056fc19/plugins/platforms/email/adapter.py) 用 IMAP 接收、SMTP 回复，是 owner 消息入口。它与管理客户 Gmail 邮箱是两条接入路径。
- Alex 通过 Hermes 官方 Google Workspace 脚本实现 Gmail 搜索、读取与发送新邮件；目前没有同线程回复参数。
- [WhatsApp adapter](https://github.com/NousResearch/hermes-agent/blob/db39ee3f2892185087bb2432eac242361056fc19/plugins/platforms/whatsapp/adapter.py) 使用 Baileys 配对；[Cloud adapter](https://github.com/NousResearch/hermes-agent/blob/db39ee3f2892185087bb2432eac242361056fc19/gateway/platforms/whatsapp_cloud.py) 提供官方 API 文本路径。Alex 未实现主动模板发送或送达、已读回执。

Alex 现有 24 项 Hermes 工具包含原有 17 项业务工具及 7 项邮箱、外发工具。原有 MCP 网关仍为 19 项业务工具，不自动获得这些外发能力。外发权限来自 owner 本机策略，旧 Web 草稿审批不构成这份权限。

当前没有真实账号端到端发送验收，也没有完成真实公网获客闭环。模型、账号登录、扫码、API 权限和来源网络必须逐项验证；测试适配器和品牌 GIF 不代表真实客户结果。详细运行和渠道边界见 [Agent 使用](alex-agent.md)、[渠道接入](alex-channels.md)。
