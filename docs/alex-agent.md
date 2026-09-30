# 运行 Alex 外贸专家 Agent

Alex 将 Hermes 的执行内核与外贸领域工具组成独立 profile。日常入口是对话，管理页面用于核对记录和接管浏览器。

## 准备运行环境

- Hermes：上游源码接口以 `v2026.9.24` / `f97608f` 为参考，本机兼容验证版本另见验收记录。按 [Hermes 官方仓库](https://github.com/NousResearch/hermes-agent) 安装。
- 业务服务：Node.js 24.5+、Linux / WSL2、`flock` 和 Chromium。
- Windows 可运行原生 Hermes，同时让 WSL2 运行业务服务。原生 Windows 业务后端仍未作为支持基线。

仓库根目录执行 `npm ci`。自定义浏览器使用 `ALEX_CHROMIUM_PATH`；持久业务目录使用 `ALEX_DATA_DIR`。服务默认 `127.0.0.1:3210`，首次生成 `api-token` 文件。已有环境可运行 `npm run doctor` 检查业务后端依赖。

## 安装和配置 Agent

Linux / WSL2：

```bash
npm run alex -- init
npm run alex -- model
npm run alex -- start
```

Windows PowerShell（替换发行版、用户和实际目录）：

```powershell
npm run alex -- connect --token-file '\\wsl.localhost\Ubuntu-22.04\home\YOUR_USER\.local\share\alex\data\api-token'
npm run alex -- init
npm run alex -- model
npm run alex -- chat
```

启动器优先寻找本机 Hermes 安装，也可用 `ALEX_HERMES_EXECUTABLE` 指定可执行文件。`ALEX_AGENT_ROOT` 可以指定新的绝对根目录，默认 `~/.alex`；实际 profile 为其中的 `profiles/alex`。

`start` 在 Linux/WSL2 上复用已就绪服务，或启动自己的业务子进程再进入对话；正常退出、会话失败或中断后关闭自己启动的服务。Windows 原生侧只连接已运行的 WSL2 服务。需要持续 Gateway/后台巡检时，单独用 `npm start` 运行常驻业务服务，不依赖短期聊天启动的子进程。

`connect` 将本机 origin 和 token 文件路径保存到 `~/.alex/connection.json`，不复制 token 内容。之后的新终端自动读取，显式环境变量仍优先；使用默认仓库数据目录时无需 connect。Agent `doctor` 通过只读业务请求验证真实凭据，不打印客户数据，也不调用模型或邮箱；模型/OAuth 文件存在仅算静态配置，仍须实测。

启动器在创建子进程前设置独立 `HERMES_HOME`，不复制默认 Hermes 凭据、会话或账号，也不改变默认 profile。重复 `init` 保留已有配置。模型配置、OAuth、配对和网关设置均属于这个独立 profile。

`ALEX_API_TOKEN_FILE` 是业务 API 认证路径；Hermes 模型凭据是另一层配置。Agent 自己分析需求并调用领域工具，不要求再给 Web 规划器配置第二份模型。管理页面独立对话需要时才使用 `ALEX_LLM_API_KEY`。

## 日常命令

| 命令 | 用途 |
| --- | --- |
| `npm run alex -- start` | Linux/WSL2 自动启动或复用业务服务，再进入对话 |
| `npm run alex -- chat` | 与 Alex 交流；额外会话参数交给 Hermes 原生 CLI |
| `npm run alex -- model` | 配置或选择 Agent 模型 |
| `npm run alex -- status` | 核查 profile、Hermes 和业务服务，不调用模型 |
| `npm run alex -- doctor` | 检查实际业务认证、模型配置提示、Gmail 配置和 Gateway 状态 |
| `npm run alex -- agenda --all` | 查看持久客户跟进、停止原因与待复核状态 |
| `npm run alex -- routine install` | 幂等安装暂停的 Hermes 后台跟进任务；见[后台运行](alex-background.md) |
| `npm run alex -- tools list` | 检查领域工具是否加载 |
| `npm run alex -- gateway setup` | 配置消息入口及 owner 范围 |
| `npm run alex -- gateway run` | 持续运行网关 |
| `npm run alex -- whatsapp` | WhatsApp 账号配对 |
| `npm run alex -- whatsapp-cloud` | 配置 Cloud 渠道 |
| `npm run alex -- cron --help` | 用户本机配置 Hermes 定时工作 |
| `npm run alex -- update` | 更新身份、技能、插件和皮肤，保留已有配置 |

升级先拉取仓库和安装依赖，再执行 `update`。默认模型可用 Alex、skills、memory、session_search 和 todo；定时任务由用户 CLI 配置，避免模型通过调度执行脚本或另行投递。若自行增加工具，请按实际权限重新核验。

## 工作流程

1. 首次交流确认产品、目标国家和买家类型，逐步补充认证、产能、起订量、交期等真实事实。
2. 提供研究目标或已知官网。Alex 复查任务和客户，创建研究并读取真实状态；无法访问的来源保留失败原因。
3. 查看公司匹配理由、来源时间、原文和公开联系信息。身份不确定或字段缺失保持待核实。
4. 接入渠道后查询回复、准备开发内容。只有本机策略授权的确切收件人才能发送；用户可随时撤销范围或停用发送。
5. 持续跟进复用客户和通信记录。退订进入持久抑制名单；不确定发送结果不自动重试。

在 `http://127.0.0.1:3210` 可查看档案与接管 Chromium。用户接管期间，Agent 的浏览器操作返回明确阻断。

## 数据与备份

| 位置 | 内容 |
| --- | --- |
| `ALEX_DATA_DIR`（默认仓库 `work/alex`） | 客户、来源、业务资料、研究任务、管理页面会话 |
| `~/.alex/profiles/alex` | Hermes 配置、会话、技能、记忆与网关状态 |
| profile 下 `state/alex/outreach.sqlite3` | 开发消息、尝试、服务商 ID、退订、线程消息与跟进日程 |
| profile 下 `alex-outreach-policy.json` | 用户在本机配置的发送范围与额度 |

业务数据库执行 `npm run backup`；恢复用 `node scripts/alex-backup.mjs restore <备份目录> <新的空数据目录>`，校验哈希和 SQLite 完整性。外发账本使用 `npm run alex -- backup-outreach <新的SQLite文件路径>` 在线快照，包含退订，拒绝覆盖旧文件。

完整 Agent 迁移还需要独立 profile：先停止对话、Gateway 与定时进程，再备份该目录，恢复到新的独立根目录。profile 可能包含账号凭据，应保存在用户自己的受保护备份位置，不要提交 Git。**业务备份与外发账本快照不包含整套 Hermes 会话和凭据，不能单独称为完整 Agent 备份。**

当前支持个人工作空间；远程运行与 SSH 访问见[业务服务部署](alex-deployment.md)。
