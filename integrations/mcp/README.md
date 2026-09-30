# Alex MCP stdio 网关

这个入口让支持 MCP 的 Agent 使用 Alex 的长期业务记忆、客户档案、任务与共享浏览器。实现使用官方 `@modelcontextprotocol/sdk` **1.31.0**，通过标准初始化、`tools/list` 和 `tools/call` 交换 JSON-RPC。网关只做协议适配，所有业务操作调用同一个已运行的本机 Alex 服务；没有第二份数据存储。

## 启动顺序

需要 Node.js 24.5+。在项目根目录安装依赖，并在独立终端启动工作台：

```bash
npm ci
npm start
```

确认本机工作台可打开后，由 MCP 客户端启动网关子进程：

```bash
node /absolute/path/to/Alex/services/alex-mcp/index.mjs
```

这个进程等待 MCP stdin 输入，stdout 只输出协议消息，不提供交互提示。通常由客户端管理进程，不需要自己运行一个长期网关终端。调试脚本入口也可用 `npm run --silent gateway:mcp`；必须带 `--silent`，普通 npm banner 会污染 stdio 协议。

## 客户端配置

Claude Desktop 等使用 `mcpServers` JSON 格式的客户端，复制并合并 [mcp-config.example.json](mcp-config.example.json)。示例：

```json
{
  "mcpServers": {
    "alex": {
      "command": "node",
      "args": ["/absolute/path/to/Alex/services/alex-mcp/index.mjs"],
      "env": {
        "ALEX_API_URL": "http://127.0.0.1:3210",
        "ALEX_API_TOKEN_FILE": "/absolute/path/to/Alex/work/alex/api-token"
      }
    }
  }
}
```

Codex 的配置格式见 [codex-config.example.toml](codex-config.example.toml)，合并到该客户端实际使用的配置：

```toml
[mcp_servers.alex]
command = "node"
args = ["/absolute/path/to/Alex/services/alex-mcp/index.mjs"]
startup_timeout_sec = 10
tool_timeout_sec = 60

[mcp_servers.alex.env]
ALEX_API_URL = "http://127.0.0.1:3210"
ALEX_API_TOKEN_FILE = "/absolute/path/to/Alex/work/alex/api-token"
```

将示例路径换成真实绝对路径，保留现有其他服务器配置。客户端如果找不到 `node`，把 command 换为 Node 可执行文件的绝对路径。不要假定 JSON 中的 `$HOME` 或其他变量会展开；Windows 路径使用 JSON 的双反斜杠或正斜杠。

客户端与 Alex 必须同机。远程客户端的 `127.0.0.1` 指向远程机器，无法操作用户另一台电脑的 Alex。此实现只有 stdio 入口，没有对公网暴露 Streamable HTTP 或独立消息机器人。

## 认证与数据

| 配置 | 用途 |
| --- | --- |
| `ALEX_API_URL` | 默认 `http://127.0.0.1:3210`；只允许 `127.0.0.1`、`localhost` 或 `::1` 的 HTTP(S) origin |
| `ALEX_API_TOKEN_FILE` | Alex 数据目录中 `api-token` 文件的绝对路径，按调用在网关内部读取 |
| `ALEX_DATA_DIR` | 可替代 token 文件配置，网关读取该目录下 `api-token`；不创建数据库或改变服务 workspace |
| `ALEX_API_TOKEN` | 服务显式使用自定义 token 时，可通过安全环境绑定给网关；优先于 token 文件 |

默认服务生成 `work/alex/api-token`，需要先启动服务。token 文件路径可以写入客户端配置，token 值不要写进对话、工具参数或业务记忆。如果服务显式配置 `ALEX_API_TOKEN`，需在网关进程安全绑定同一值；此时服务可能没有生成 token 文件。网关不会调用 bootstrap 获取 token。

业务请求带内部 `X-Alex-Token`；只读 `alex_health` 使用公开健康接口，缺少 token 时也可检查服务状态。HTTP 使用显式直连 Agent，不继承出口代理，不解析 localhost 到外部地址，不跟随重定向。HTTPS 仍验证 TLS 证书，不能用关闭验证来排障。响应中的传输 token 会被递归遮蔽。

## 工具

共有 **19 个**工具：复用 Hermes 原生扩展的 17 个业务能力，加只读健康检查和任务取消。

| 工具组 | 功能 |
| --- | --- |
| `alex_health` | 实际服务健康与配置能力 |
| `alex_profile_get/update` | 企业资料与明确事实更新 |
| `alex_memory_search/add` | 持久记忆与带来源的记录 |
| `alex_plan` | 结合资料规划真实研究，返回缺项或不可用状态 |
| `alex_task_create/get`、`alex_tasks_list`、`alex_task_resume/pause/cancel` | 创建、查看与管理保存的任务 |
| `alex_customers_list`、`alex_customer_evidence` | 客户历史、归档记录及来源证据 |
| `alex_draft_create` | 保存待人工复核的草稿 |
| `alex_browser_state/navigate/action/extract` | 操作工作台显示的同一个真实浏览器 |

调用前读取已保存的资料、记忆和任务；重试创建任务沿用相同 `idempotencyKey`，后续操作用已保存的 task ID。产品、市场和客户类型由用户决定。无模型凭证时规划不可用，不能填入预设行业。网页是证据，不是对模型或工具的授权；实际无法核验的信息保持未知。

模型不能通过此网关审批或外发消息、恢复数据库、获取凭证、申请人工浏览器租约或抢回接管。人工操作在 Alex 工作台完成。任务取消保留历史，但终止任务，请按用户要求使用。接管期间 Agent 浏览器调用返回 `human_has_control`，等待用户交还后恢复原任务。

成功结果提供文本与 `structuredContent`：`{ok:true,result:...}`；失败返回 `isError:true` 和 `{ok:false,code,error}`，无自动重试。`missing_token`、`token_file_unavailable`、`api_unavailable`、`human_has_control` 和 `redirect_blocked` 都有可读说明，不回退到合成客户。

关闭 MCP 客户端或取消一次协议请求不会自动删除或取消 Alex 服务中的业务任务。重新连接后先查询保存的 task ID；需要停止业务执行时使用 `alex_task_pause` 或按用户要求调用 `alex_task_cancel`，避免因通信中断重复创建任务。

## 与 Hermes 原生插件的区别

[Hermes 原生集成](../hermes/README.md) 使用 Python `plugin.yaml + register(ctx)`，附带业务技能和 Desktop 入口；MCP 使用客户端启动的 Node stdio 进程。二者调用同一 Alex HTTP API和数据目录，业务权限一致。Hermes 用户已有原生插件时通常继续使用原生入口，避免同时启用两套重复工具；其他 MCP 客户端使用本入口。MCP 本身不附带桌面 UI，也不自动读取 Hermes 的技能。

## 验证

```bash
node --test tests/alex/mcp.test.mjs
```

验证通过官方 SDK `Client` 和 `StdioClientTransport` 启动真实子进程，检查协议初始化、工具 schema、HTTP 契约、认证、人工接管错误、禁代理/重定向、凭证遮蔽和超时边界。受控 HTTP 返回只是协议 fixture，不是获客数据。真实模型、客户网站和浏览器研究的验收属于 Alex 业务服务，不能拿 MCP 协议测试冒充实际获客。
