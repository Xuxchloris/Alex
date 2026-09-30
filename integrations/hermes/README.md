# Alex Agent 的 Hermes 原生集成

Alex v0.4 以独立 Hermes profile 运行为外贸专家 Agent。本目录提供 28 项原生工具：17 项原有业务工具和 11 项 Gmail/外发/跟进工具。Agent 发行包、SOUL、4 项普通技能和品牌 skin 位于 [`agent/`](../../agent/)，本机业务服务与共享浏览器继续独立运行。

固定参考版为官方 `v2026.9.24` / v0.21.5，代码 commit `f97608f178d1ffeca59860195ab7da295f7c8e5f`。本轮真实安装和加载验证使用 v0.21.3、commit `db39ee3f2892185087bb2432eac242361056fc19`。具体循环、工具派发、profile、记忆与渠道源码见[研究记录](../../docs/alex-hermes-study.md)。Python 业务插件使用标准库；实际 Gmail/WhatsApp 传输还依赖已安装 Hermes 的官方脚本、账号和网关。

## 安装独立 Alex Agent

先在项目根目录安装依赖并启动业务服务（Windows 后端使用 WSL2）：

```bash
npm ci
npm start
```

配置业务认证路径，然后安装独立 profile、选择模型并进入对话：

```bash
export ALEX_API_TOKEN_FILE="/absolute/path/to/alex-data/api-token"
npm run alex -- init
npm run alex -- model
npm run alex -- chat
```

默认安装到 `~/.alex/profiles/alex`，不复制默认 Hermes 凭据或会话。启动器使用官方 `profile install`，重复 init 保留用户配置；`npm run alex -- update` 用官方更新机制刷新插件与技能。`ALEX_AGENT_ROOT` 可指定独立绝对根目录，`ALEX_HERMES_EXECUTABLE` 可指定已安装的 Hermes。Windows 路径与完整命令见[Agent 文档](../../docs/alex-agent.md)。

在 **Hermes 启动进程**配置路径，修改为真实绝对路径：

```text
ALEX_API_URL=http://127.0.0.1:3210
ALEX_API_TOKEN_FILE=/absolute/path/to/project/work/alex/api-token
```

这是路径，不是 token 值。Alex 首次启动生成文件；插件只在内部读取，不返回给模型。自定义数据目录可用 `ALEX_DATA_DIR` 定位 `api-token`。如果 Alex 使用显式 `ALEX_API_TOKEN` 而未生成文件，通过安全环境绑定给 Hermes 同一变量。不要调用 bootstrap 取 token，也不要把 token 写进工具参数、技能或对话。

运行 `npm run alex -- tools list` 检查工具。兼容插件技能用 `skill_view("alex:trade-research")` 读取，它不自动进入普通技能索引；profile 的 onboarding、prospecting、follow-up、daily-review 四项技能解决这一发现差异。

`desktop/plugin.js` 保留可选管理页入口，不是 Alex 的主要对话入口，也不是完整 Hermes Desktop 分发。远程 Hermes 网关的 `127.0.0.1` 不能访问另一台电脑；当前要求 Agent 进程与业务服务同机或明确配置受控转发。

## 工具边界

| 工具组 | 功能 |
| --- | --- |
| `alex_profile_get/update` | 企业资料读取与明确事实更新 |
| `alex_memory_search/add` | 带来源的持久记忆 |
| `alex_plan` | 旧调用方兼容；Alex Agent 自己规划，不调用第二层规划器 |
| `alex_task_create/get`、`alex_tasks_list`、`alex_task_resume/pause` | 创建、查询和恢复任务 |
| `alex_customers_list`、`alex_customer_evidence` | 客户历史、归档记录与出处 |
| `alex_draft_create` | 待人工复核草稿 |
| `alex_browser_state/navigate/action/extract` | 同一个浏览器，遵守人工接管 |
| `alex_mailbox_search/get` | 只读查询实际 Gmail；邮件是外部材料 |
| `alex_mailbox_sync` | 持久同步原发送线程、按消息 ID 去重、回复停止旧催发 |
| `alex_followup_schedule`、`alex_followups_list`、`alex_followup_cancel` | 带时区的持久跟进日程和停止状态 |
| `alex_outreach_prepare/list/status/send/suppress` | 草稿、确切收件人授权、持久通信账本、真实渠道调用与退订 |

业务 API 使用 `X-Alex-Token`，强制回环 origin、禁止重定向并绕过出口代理。工具不接受任意 workspace、凭证或 endpoint，不提供 token 获取、数据恢复或抢回人工控制权。

客户外发默认关闭。owner 在本机策略中授予确切渠道、收件人与每日额度，模型不能修改策略；旧 Web 草稿审批不构成外发授权。Gmail 支持查读、原线程同步/回复和持久跟进；WhatsApp 支持已连接渠道的文本路径，Cloud 尚无主动模板发送。真实账号端到端未验收，`sent` 只代表服务商接受。详见[渠道文档](../../docs/alex-channels.md)。

默认 Agent 工具集为 Alex、skills、memory、session_search 和 todo。通用执行、文件、额外消息与 cronjob 工具不向模型开放；用户可在本机通过 `npm run alex -- cron ...` 配置调度。MCP 网关仍只有原有 19 项业务工具，不含这 11 项邮箱/外发/跟进工具。

工具返回 `{ok, result}` 或 `{ok:false, code, error}`。接管错误等待用户交还；部署错误修复实际配置，不改用演示响应。

## 验证

```bash
python -m unittest discover -s integrations/hermes -p 'test_*.py'
```

离线测试验证注册、HTTP 契约、认证、禁止重定向、人工接管、外发持久化与权限边界；测试适配器不会联系客户。fixture 不是获客数据，真实模型、账号、外部来源与正式投递须分别验收。

本轮使用上述 v0.21.3 的真实 `PluginManager` 加载全部 28 项工具与技能，验证卸载清理和官方 Desktop surface 检查；没有替代 `PluginContext`。请在已安装 Hermes 的 Python 环境运行：

```bash
python integrations/hermes/verify_native.py
```

该验证使用临时 Hermes home，不改用户插件配置，不调用模型和外部网站；它不等于完整 Hermes Desktop 启动验收。

官方参考：[Python 插件](https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/website/docs/user-guide/features/plugins.md)、[Desktop SDK](https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/website/docs/developer-guide/desktop-plugin-sdk.md)。
