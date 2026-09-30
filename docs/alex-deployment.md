# Alex 运行与部署指南

Alex v0.2 是一个单用户、持久数据的外贸工作台。日常运行建议放在自己的电脑，长期运行建议用 Linux 主机 / VPS 和持久数据盘；Web 通过本机地址或 SSH 隧道使用。Codex 云环境用于开发、测试与改代码，不能当作已提供的长期托管服务。

使用步骤见[操作手册](alex-user-guide.md)，Agent 入口见[网关指南](alex-gateways.md)。当前公网与模型验收状态见[验收记录](alex-acceptance.md)。

## 选择运行方式

| 环境 | 推荐路线 | 已验证与限制 |
| --- | --- | --- |
| Linux / WSL2 | Node.js 24.5+、Chromium、`util-linux` 的 `flock` | 原生服务和生命周期测试已在本轮 Linux 云环境执行；WSL2 单独启动未实测 |
| Windows | Docker Desktop 的 Linux 容器，或 WSL2 中走 Linux 路线 | 提供容器配置；本轮未在 Windows 运行。原生 Windows Node 路线不受支持 |
| macOS | Docker Desktop 的 Linux 容器 | 提供容器配置；本轮未在 macOS 运行。原生 macOS 缺少本轮 Linux 锁机制 |
| Linux VPS / 固定服务器 | 同一数据目录单实例，systemd 或 Docker；从本机用 SSH 隧道 | 提供 service 和 Compose 文件；本轮 systemd 实机服务安装未执行 |
| Codex 云开发环境 | 当前 checkout 安装、工程测试和改代码 | 需要实际允许的出口和模型绑定；没有自动保证常驻、稳定公网地址或长期数据托管 |

本轮 Docker daemon 可访问，Compose 配置校验通过；实际构建被 Docker Hub 的网络 `Forbidden` 阻断，没有已完成的容器启动和持久卷验收。下面是对应仓库配置的运行步骤，不将配置校验写成部署成功。

## Linux / WSL2 本机运行

使用 Node 官方或可信系统来源安装 Node.js 24.5+，并安装实际 Chromium 与 `flock`。Debian 系 Linux 可使用系统 Chromium 和 `util-linux`；具体安装按发行版官方说明进行。使用当前 checkout，不需要创建新工作树。

```bash
node --version
flock --version
npm ci
npm run doctor
npm start
```

首次运行 doctor 时服务尚未启动可以显示连接不可用；启动后另开终端重跑，检查实际运行状态。默认 Web 地址为 `http://127.0.0.1:3210`，不要把模型密钥或 API token 贴进页面聊天。

系统 Chromium 不在自动发现位置时，将其真实绝对路径设置为 `ALEX_CHROMIUM_PATH`。也可以使用 Playwright 官方下载，再取得执行文件路径：

```bash
npm exec playwright-core install chromium
node --input-type=module -e "import { chromium } from 'playwright-core'; console.log(chromium.executablePath())"
```

Linux 仍需对应浏览器运行库。没有关闭 TLS、签名或下载校验的安装路线。

在现有 `.env` 中只补充缺少的 Alex 配置，或使用启动进程的安全环境绑定。不要覆盖已经存在的配置。Node 启动命令会读取项目 `.env`；旧 Python 的 `LLM_*` 与 `FEISHU_*` 不是 Alex 服务的必需配置。

## 运行配置

| 变量 | 默认值 / 用途 |
| --- | --- |
| `ALEX_PORT` | `3210`；本机端口 |
| `ALEX_DATA_DIR` | 项目 `work/alex/`；持久数据库、浏览器状态、token 和锁文件 |
| `ALEX_BACKUP_DIR` | 数据目录 `backups/`；本机业务快照，可配置到独立数据盘 |
| `ALEX_CHROMIUM_PATH` | 自动发现系统浏览器或 Playwright 安装；使用真实执行文件路径 |
| `ALEX_LLM_BASE_URL` | `https://api.deepseek.com/v1`；OpenAI-compatible 模型地址 |
| `ALEX_LLM_MODEL` | `deepseek-chat`；规划、核验和草稿模型 |
| `ALEX_LLM_API_KEY` | 默认缺失；由用户安全配置真实 key |
| `ALEX_API_TOKEN` | 缺失时服务生成数据目录中的 `api-token`；显式值至少 24 字符 |
| `ALEX_BIND_HOST` | 原生 `127.0.0.1`；容器配置使用 `0.0.0.0` 并只发布宿主 loopback |
| `ALEX_LOCAL_PROXY_IP` | 默认空；只信任一个明确私有 IPv4 的本机容器代理 peer |
| `HTTPS_PROXY` / `https_proxy` | 沿用可用的受支持出口代理 |
| `ALEX_API_URL`、`ALEX_API_TOKEN_FILE` | Hermes/MCP 连接本机服务，详见[网关指南](alex-gateways.md) |

模型 key 与本机访问 token 是两种凭据。业务资料里也不要保存密钥。配置变更后重启服务，看到“已配置”不等于真实模型调用或来源查询已经成功。

来源域名由用户任务决定。允许模型域名、搜索来源和实际公司网站，保留原有网络规则；原生 DNS 不可用时浏览器的受支持代理解析还需要固定 DoH 目的可达。网络失败、验证码和来源权限不足应保存实际错误，不通过禁用 TLS 或造客户解决。

## Docker Desktop 或 Linux Docker

在仓库根目录执行，Docker daemon 需要能取得 Node 基础镜像、系统包和锁定的 npm 依赖：

```bash
docker compose --env-file .env -f deploy/alex/compose.yaml config --quiet
docker compose --env-file .env -f deploy/alex/compose.yaml up --build -d
docker compose --env-file .env -f deploy/alex/compose.yaml ps
```

先建立含实际 Alex 配置的 `.env`，保留现有文件；如果配置放在另一私密路径，用该真实路径替换 `--env-file .env`。不要运行会完整输出展开密钥的配置打印命令，配置检查使用 `--quiet`。

Compose 文件将服务端口发布到宿主 `127.0.0.1:${ALEX_PORT:-3210}`，容器内部端口固定 `3210`。数据保存在 named volume `alex-data` 对应的 `/data/alex`，应用以非 root 用户运行，设置 `restart: unless-stopped`。容器重建保留该 volume；停止容器不等于删除数据。

配置的专用 bridge 默认网段 `172.29.241.0/24`，网关 `172.29.241.1`。如果与既有网络冲突，成对修改 `ALEX_DOCKER_SUBNET` 和 `ALEX_DOCKER_GATEWAY`，不要把任意网段或 forwarded header 设为可信身份。接口同时检查实际 peer、Host、Origin 和认证，当前部署仍面向本机用户。

查看服务状态与诊断：

```bash
docker compose --env-file .env -f deploy/alex/compose.yaml logs --tail=80 alex
docker compose --env-file .env -f deploy/alex/compose.yaml exec alex node scripts/alex-doctor.mjs --json
```

停止但保留数据：

```bash
docker compose --env-file .env -f deploy/alex/compose.yaml down
```

不要使用 `down --volumes` 或删除业务 volume 来修复启动问题。重要数据应另做业务备份和外部副本；Docker volume 的存在本身不是异地备份。

容器内创建在线一致性业务备份也可以执行：

```bash
docker compose --env-file .env -f deploy/alex/compose.yaml exec alex node scripts/alex-backup.mjs
```

该命令返回备份位置与清单，副本仍在业务 volume 中。还需将完整备份目录复制到独立存储。容器外的 Hermes/MCP 不会自动看到 named volume 中的 token 文件。需要这种用法时，把同一显式 `ALEX_API_TOKEN` 安全绑定到 Alex 与 Agent 启动环境，仍通过宿主 loopback 端口连接；不要输出或在聊天中复制 token。已有 Linux 原生部署也可直接使用受限权限的 token 文件。

## Linux 常驻服务

示例文件为 [`deploy/alex/alex.service`](../deploy/alex/alex.service) 和 [`alex.env.example`](../deploy/alex/alex.env.example)。它约定：

| 项目 | 路径 / 设置 |
| --- | --- |
| 代码 | `/opt/alex`，提前完成 `npm ci` |
| 服务用户 | 系统用户及组 `alex` |
| Node | `/usr/bin/node`，需要 24.5+；按真实路径改 `ExecStart` |
| 配置 | `/etc/alex/alex.env`，仅管理员可读，不进入仓库 |
| 数据 | `/var/lib/alex`，仅 `alex` 可写 |
| 监听 | `127.0.0.1`，从本机或 SSH 隧道访问 |

先把经过验证的 checkout 放到 `/opt/alex` 并安装依赖，创建专用系统用户。若目录、用户或配置已存在，应保留并检查，不能覆盖已有数据。为新的数据与配置目录设置权限：

```bash
sudo install -d -o alex -g alex -m 0700 /var/lib/alex
sudo install -d -m 0750 /etc/alex
```

仅在配置文件不存在时，用示例创建 `/etc/alex/alex.env`，设 `0600`，通过受限的本机编辑或秘密绑定填入真实配置。service 使用 `ProtectSystem=strict` 和 `ReadWritePaths=/var/lib/alex`；将备份目录改到别处时还需给该实际目录合适的用户权限及 service 写权限。

确认 `ExecStart` 的 Node 路径和 Chromium 路径后安装服务：

```bash
sudo install -m 0644 deploy/alex/alex.service /etc/systemd/system/alex.service
sudo systemctl daemon-reload
sudo systemctl enable --now alex
sudo systemctl status alex
```

NVM 安装在用户 home 下的 Node 不一定能被这个 service 使用；不要仅在交互 shell 中验证。选择 service 可访问的受信任 Node 安装，或修改真实执行文件路径与相应服务权限。

远程浏览器通过 SSH 隧道打开：

```bash
ssh -N -L 3210:127.0.0.1:3210 <ssh-user>@<server>
```

打开用户电脑的 `http://127.0.0.1:3210`。Hermes 网关如需常驻，按其官方 service 配置单独运行在同机。Alex 当前没有公网多用户认证部署，不把本机 API 暴露为团队 SaaS。

## 数据保留、升级与恢复

持久目录包含业务数据库、会话、资料、客户、证据、任务、草稿与浏览器状态。`api-token` 与浏览器 Cookie 是敏感运行文件；业务备份不包含这些凭据。`.alex-process.lock` 是单实例内核锁文件，不要删除它来强行启动第二个进程。

同一个 `ALEX_DATA_DIR` 只运行一个 Alex 服务。锁冲突先停止旧进程，再启动新实例；不同企业的实例需要各自数据目录和端口，不能通过修改请求里的 workspace ID 共享隔离。

升级前通过 Web 或 `npm run backup` 创建一致业务快照，确认另外保存的完整副本，再停止旧服务、更新代码和锁定依赖、启动并核对原数据。不要直接复制运行中 SQLite 主文件；WAL 可能包含尚未合并的已提交数据。

恢复到新空目录的完整命令与核对步骤见[操作手册](alex-user-guide.md#备份与恢复)。原生部署设置 `ALEX_DATA_DIR` 为恢复目录再启动；容器部署需将恢复后的独立目录 / volume 作为新的 `/data/alex` 挂载，保留旧 volume。不要在正在运行的容器数据目录内覆盖 SQLite。

自动备份只在服务运行期间检查，本地快照与异地副本应分别维护。长期 VPS 使用持久磁盘，并把业务备份复制到独立存储；停止一台云开发机器不会自动替你完成这些运行保障。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| `data_lock_unavailable` | Linux / WSL2 安装 `util-linux`；Windows/macOS 使用 Docker 路线 |
| `data_directory_locked` | 查找并停止使用同一目录的旧服务，不删锁文件或数据 |
| 端口已占用 | 停止旧进程或设置另一 `ALEX_PORT` |
| 浏览器不可用 | 核对可执行文件、Linux 运行库及实际资源，重启并跑 doctor |
| 模型配置了仍失败 | 检查真实模型端点、key 绑定和网络；查看实际失败状态 |
| Docker 构建 `Forbidden` | 修复镜像与依赖源的实际网络权限，不把配置校验当启动成功 |
| `human_has_control` | 在工作台交还，再继续原任务 |
| 客户数量不足或来源阻断 | 查看任务证据和失败地址，按实际限制处理后恢复 |
| 备份校验失败 | 保留原库和副本，停止恢复，不改预期校验值 |

doctor 检查运行前提和本机健康，不等于通过真实获客、模型或平台连接验收。
