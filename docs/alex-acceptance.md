# Alex 验收记录

## v0.4：客户回复、持续跟进与安装维护

验证日期：2026-09-30。对照 Hermes 的原生 profile、工具、技能和 cron 实现，以及 Deep Agents 的持久状态与评估思路，补齐本轮可独立验收的能力。具体差距和下一阶段见 [成熟项目对照](alex-benchmark.md)，运行方式见 [后台跟进](alex-background.md)。

| 验证 | 实际结果 |
| --- | --- |
| Gmail 回复与跟进 | 57 项 Python 插件测试通过；覆盖线程同步去重、同线程回复、收件人绑定、客户回复停止跟进、发送前重查、退订、到期判断、并发认领、结果不确定时停止重发、旧数据库迁移和备份 |
| 启动与连接 | WSL2 启动器 12/12 通过，包括真实业务服务启动、隔离数据、结束清理和复用已有服务；连接文件只保存令牌路径 |
| 完整 Node 回归 | GitHub Ubuntu CI 完整 Alex 88/88、旧 Node 11/11 通过，无跳过；包含实际 Chromium、业务服务、SQLite、MCP 和进程生命周期 |
| Hermes 原生验证 | 本机 Hermes 0.21.3、提交 `db39ee3f2892185087bb2432eac242361056fc19`；真实 PluginManager 注册 28 项工具，Desktop surface、卸载清理通过；真实临时 cron 存储验证任务默认暂停和重复安装幂等 |
| 本机升级 | 官方 profile update 已更新到 v0.4.0，4 项外贸技能已安装；升级前备份原通信账本，现有配置保留；实际业务 API 认证和 Chromium 检查通过 |
| 后台任务 | 本机已安装每小时巡检任务，状态为暂停、投递位置为本地；模型未选择、Gmail 未配置、Gateway 未运行，尚未执行任何后台获客或发送 |
| CI 范围 | 实现提交 `2b91770783db94292c52b6c8f5fae62cd6ea6fa3` 的 [4 组 CI 全部通过](https://github.com/Xuxchloris/Alex/actions/runs/36723464980)；Windows 启动器 11 通过、1 项 Linux 专用服务启动测试跳过，通信账本 57/57；Ubuntu Python 兼容测试 61/61 |

本轮邮箱测试使用明确的服务商 fixture，真实模型调用 0、真实邮箱调用 0、客户消息发送 0；没有向生产库写入测试客户。Gmail 的实际 OAuth 权限、真实线程收发和 Hermes Gateway 连续运行仍待账号配置后验收。线程读取与发送之间存在无法完全消除的来信竞态；服务商接受不等于送达或已读。

本轮没有完成 WhatsApp 模板消息与回执、真实公网获客、Google Maps / 海关适配器、多人权限、容器端到端或 macOS 验收。以下版本记录保留当时状态，其中 v0.3 的“Gmail 只发新邮件”等描述已由 v0.4 实现更新。

## v0.3：外贸专家 Agent

验证日期：2026-09-30。Alex 以 Hermes 原生 profile distribution 运行，独立 SOUL、三项外贸技能、品牌皮肤与 24 项领域工具已安装到本机独立 profile。

| 验证 | 实际结果 |
| --- | --- |
| 原生安装与更新 | Windows Hermes 0.21.3，提交 `db39ee3f2892185087bb2432eac242361056fc19`；官方 profile install / update 实际成功，重复 init 保留配置；未复制默认账号或会话 |
| 插件注册 | 真实 PluginManager 注册 24 工具、行业技能，卸载清理与 Desktop surface 检查通过 |
| 默认工具 | 实际 CLI 列表确认 alex、skills、memory、session_search、todo 启用；终端、文件与 cronjob 等关闭；定时任务由用户 CLI 配置 |
| Node 测试 | Linux / WSL2 83/83，通过实际 Chromium、HTTP、SQLite、MCP、启动隔离和更新路径；旧 Node 11/11 |
| Python 插件 | 40/40，包含 11 项业务 API 契约与 29 项邮箱、外发、退订、配额、幂等、并发、异常和备份测试 |
| Python 全量兼容 | WSL2 `python -m pytest -q` 44/44，通过上述插件测试与 4 项旧 Python 测试 |
| 实际 Agent 循环 | WSL 已安装 Hermes `0434a9a5ec743aed90cd5ac9a1ba872b4f2202af`，两次独立 AIAgent 进程共执行 10 次真实领域工具；重启后业务资料、草稿 ID 和唯一记录保持一致 |
| 演示边界 | 模型决定为脚本 fixture，真实模型调用 0、生产客户 0、发送尝试 0；真实插件/API/SQLite 未替换；完整 trace 随 GIF 提交 |
| 仓库信息 | About、主页链接与 Topics 已通过 GitHub API 更新并读回核验，README 使用新的专属图标、横幅和 Agent GIF |

外发测试没有连接实际 Gmail/WhatsApp，也没有发送客户消息。本机独立 Agent 的模型与渠道仍待配置；公网获客尚未成功验收。Gmail 当前只发新邮件，没有同线程回复参数；Cloud 没有主动模板或投递/已读回执。业务 API 的模型配置状态属于可选管理页面规划器，不能代表 Hermes Agent 模型是否配置。

Agent GIF 是实际工具回调的 HTML 可视化，不是终端录像；[核验清单](assets/alex-agent-demo-manifest.json)记录精确运行版本、输入与结果。GitHub Social preview 作为单独设置项，不能以 README 横幅或 git push 代替其上传验收。旧版本记录保留如下。

## Windows 本机 WSL2 交付

验证日期：2026-09-30。已从 GitHub 临时分支恢复原始 v0.2 提交 `db242bda95c25e2622f56452cc4c54e75720abf2`，文件树为 `af0c369aafa184d6fd2c47890cbd38f98d5aaf94`，源码及图标、GIF、文档均已落到本机。仓库已实际重命名为 [Xuxchloris/Alex](https://github.com/Xuxchloris/Alex)。

| 验证 | 本机实际结果 |
| --- | --- |
| 运行环境 | Ubuntu 22.04 WSL2、Node 24.21.0、Chromium / Chrome for Testing 153.0.8010.12；独立运行时安装，未替换默认 Node |
| 工程测试 | lockfile `npm ci`、现有 Alex 75/75、旧 Node 11/11、Hermes Python 11/11、原 Python 4/4 通过，无跳过；测试使用独立临时数据 |
| 诊断修复 | 修复官方 Playwright 浏览器 `Google Chrome for Testing` 版本输出被误报为不可用；新增回归与其余 runtime 测试合计 8/8 通过 |
| 实际服务 | Windows 浏览器打开本机 `127.0.0.1:3210`；健康接口和 doctor 通过，浏览器已启动，业务数据位于 WSL 原生文件系统 |
| 实际 MCP | 官方 SDK 客户端连通运行中的服务，列出 19 工具并读取真实健康状态；浏览器可用、模型未配置 |
| 在线备份恢复 | 运行中创建一致性业务快照，恢复到独立空目录；SHA256、SQLite 完整性、资料、会话列表和客户数核对通过；没有向生产库写入测试客户 |

真实公网验收仍未通过：在独立验收工作空间核验 `https://www.medline.com/`，实际任务返回 `unavailable` / `source_unavailable: Website could not be loaded.`，`actualCount=0`。通过本机代理重试的命令被自动审批拦截，未执行。生产客户数仍为 0；此连接检查不代表客户匹配或获客成果。

`ALEX_LLM_API_KEY` 仍未配置。自然语言规划与模型回复、Google Maps / 海关专用适配器、Docker 容器、正式 systemd、macOS / Windows 原生后端、完整 Hermes Desktop 与消息平台仍未完成实际部署验收。以下云环境记录保留当时状态，WSL2 的新增验收以上表为准。

## v0.2：会话、网关与运行完善

验证日期：2026-09-30。最终 lockfile 重装通过，Alex **75/75** 项测试通过，旧 Node 插件 **11/11**、Python **15/15** 项通过。

| 验证 | 结果与实际范围 |
| --- | --- |
| 多轮会话 | 用户消息、历史提案、重启恢复、临时/永久资料边界、模型引用裁掉否定前缀的拒绝、并发轮次和备份恢复通过 |
| 中文工作台 | 实际 Chromium 验证补充上一轮信息、重载同一提案、重复执行仍为同一 task ID；新会话切换期间阻止重叠提交；无密钥仅存用户消息 |
| 标准 MCP | 官方 SDK `1.31.0` 客户端通过真实 stdio 子进程验证 19 个工具、schema、认证、代理/跳转限制及令牌遮蔽 |
| 实际本机服务 + MCP | 已连接运行中的 Alex `0.2.0`，19 个工具可列出，实际健康/资料/归档客户读取成功；Chromium 可用，保存客户数仍为 0 |
| 进程与数据 | 同数据目录生命周期锁、重复启动、父进程崩溃释放、慢启动中丢锁拒绝、端口占用回收、浏览器启动/关闭竞态通过 |
| 运行诊断 | `npm run --silent doctor -- --json` 通过；缺模型密钥和未验证公网明确给出 warning，未打印凭证 |
| 品牌与 GIF | 原创图标、横幅、Social preview 导出及 GIF 已制作；12 帧、11.15 秒、1000×750，实际浏览器操作且始终标注测试网站 |
| Docker | daemon 可用；Compose 配置解析通过。实际 build 在拉取 DockerHub 基础镜像时返回 Forbidden，镜像/容器/卷重启未实测 |

GIF 的稳定客户 ID、归档查重、重载记忆、备份与人工点击断言通过，无模型调用，无生产工作空间使用，无前端异常；核验结果在 `docs/assets/alex-demo-manifest.json`。它展示软件流程，不代表真实客户发现成功。

仍未验收：真实模型调用与公网获客、Hermes 消息平台登录、完整 Desktop 启动、Windows/macOS/WSL2 运行、systemd 安装运行、Docker 镜像及容器持久卷。运行配置和操作路径已写入部署、入口与用户手册，不能把模板存在当作服务已部署。

云环境安装/启动配置草稿已更新为 v0.2，保留网络与模型密钥要求。仓库改名/description 的 GitHub API 写请求仍返回 Forbidden；Git 推送与仓库设置是不同路径。GitHub Social preview 也不会通过 push 自动设置。

## v0.1：初次基础验收

验证日期：2026-09-30。执行环境：Node.js 24.19.0、Python 3.12.14、系统 Chromium。这是首版工程验证记录，不是获客成功报告。

### 已完成的工程验证

| 验证 | 结果 | 覆盖范围 |
| --- | --- | --- |
| `npm ci --cache /workspace/.cache/npm` | 通过 | lockfile 可重装；仅依赖固定版本 `playwright-core` |
| `npm test` | 46 项通过 | 持久记忆、资料版本、任务恢复、取消、身份查重、归档、来源证据、备份恢复、浏览器接管、HTTP 边界和中文工作台 |
| `npm run test:legacy` | 11 项通过 | 原 DSH 插件兼容性 |
| `.venv/bin/python -m pytest -q` | 15 项通过 | 原 Python 项目与 Hermes 标准库插件验证 |
| 官方 Hermes 插件加载器 | 通过 | 固定 `v2026.9.24`，17 个工具、`alex:trade-research` 技能、Desktop 入口注册与卸载清理 |

Hermes 原生加载器通过临时、隔离的官方 checkout 和虚拟环境验证，命令见 `integrations/hermes/README.md`；该 checkout 和凭证不进入项目仓库。没有声称完整 Hermes Desktop 分发已构建。

浏览器测试实际启动 Chromium，访问隔离的受控 HTTP 页面。工作台集成验证了用户自行指定业务资料、真实 DOM 提取、公开联系方式显示、CSV、归档、备份以及接管和交还。受控网站及模型替身只是可重复的测试输入，不能计为公网客户。

验收 CLI 的 4 项本机 HTTP 测试还验证了控制请求绕过环境代理、拒绝重定向，并在成功响应、错误响应和无效 JSON 中避免回显访问令牌。

### 真实公网验收：尚未通过

已执行以下连接诊断，目标仅为核验已知真实官网，不代表替用户预选行业或市场：

```bash
npm run smoke:live -- \
  --request '连接验收：核验 Medline 真实官网的公开公司信息，仅保存可直接观察的证据，不推断客户匹配。' \
  --urls https://www.medline.com/
```

本次任务返回 `unavailable`；错误为 `source_unavailable: Website could not be loaded.`，`actualCount=0`、`matchedCount=0`、`needsReviewCount=0`。验收脚本以非零状态退出。真实数据目录检查保存客户数为 0，没有以 fixture 或合成客户补数。

`/api/health` 返回服务可用、`browserAvailable=true`、`modelConfigured=false`、`sourceMode=live-only`、`discoveryStatus=unverified`。当前云环境的出口访问受限，实际公司站点和搜索来源尚未通过；模型密钥也未绑定。因此自然语言规划、模型核验和模型开发信的真实联调尚未通过。

已保存云环境安装/启动脚本、动态目标网站的网络要求和 `ALEX_LLM_API_KEY` 秘密绑定要求。保存草稿不会自动应用网络配置或生成密钥；需要在环境设置中应用并安全配置密钥后，再按用户实际任务进行验收。

### 下一次真实验收

1. 用户描述产品、市场、客户类型与约束，Alex 读取已存资料并询问缺失信息。
2. 执行任务，逐条核对实际公司官网、抓取时间、正文引用和公开联系方式；不足的数量与阻断原因保留。
3. 重跑任务，确认重复公司不被计为新客户；归档后仍参与查重。
4. 暂停、重启并恢复同一任务；创建备份并恢复到新空目录，检查客户 ID、记忆、证据与检查点。

Google Maps 专用获客适配器、授权海关企业交易数据、外部消息发送和生产多租户部署仍需后续实现及独立真实验收。
