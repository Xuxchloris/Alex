# Alex 本地开发与部署

Alex v0.1 是本地单用户工作台。核心数据、浏览器和研究服务在一个 Node.js 进程内工作；Hermes 扩展通过本机 HTTP 调用。使用当前 checkout，不需要创建新的 Git worktree。

## 安装与启动

需要 Node.js 24.5+（使用 `--use-env-proxy`），Python 仅用于可选 Hermes 插件及其测试。使用 lockfile 安装：

```bash
node --version
npm ci
npm start
```

默认地址 `http://127.0.0.1:3210`。服务使用 Node 的 `.env` 加载选项；保留已有 `.env`，只添加 Alex 所需配置，或在启动环境中注入。`.env.example` 中旧 Python 配置不是 Alex 的必需项。

默认读取系统 Chromium `/usr/bin/chromium`。没有该路径时，可通过操作系统官方包安装 Chromium，或使用 Playwright 官方浏览器下载：

```bash
npm exec playwright-core install chromium
node --input-type=module -e "import { chromium } from 'playwright-core'; console.log(chromium.executablePath())"
```

把返回的可执行文件绝对路径设为 `ALEX_CHROMIUM_PATH`，再启动。Chromium 还需要系统运行库，Linux 按对应发行版官方说明补齐；不要关闭 TLS 或下载完整性验证。云环境已有 Chromium 时直接复用。

## 环境变量

| 变量 | 默认值 / 用途 |
| --- | --- |
| `ALEX_PORT` | `3210`；本机服务端口 |
| `ALEX_DATA_DIR` | 项目 `work/alex/`；SQLite、浏览器本地状态和 token |
| `ALEX_BACKUP_DIR` | 数据目录 `backups/`；可指向另外的数据盘 |
| `ALEX_CHROMIUM_PATH` | `/usr/bin/chromium`；实际浏览器文件 |
| `ALEX_LLM_BASE_URL` | `https://api.deepseek.com/v1`；OpenAI 兼容模型地址 |
| `ALEX_LLM_MODEL` | `deepseek-chat`；规划模型 |
| `ALEX_LLM_API_KEY` | 未设置；自然语言规划密钥 |
| `ALEX_API_TOKEN` | 未设置时服务生成并存入数据目录 `api-token`；自定义值至少 24 字符 |
| `ALEX_API_URL` | Hermes 默认 `http://127.0.0.1:3210`；仅允许回环 HTTP(S) origin |
| `ALEX_API_TOKEN_FILE` | Hermes 读取服务 token 文件的绝对路径；也支持 `ALEX_DATA_DIR/api-token` |
| `HTTPS_PROXY` / `https_proxy` | 环境已有代理时使用支持的出口配置 |

模型密钥和本地 API token 用途不同。插件不把它们放进工具 schema。不要打印令牌文件、dump 环境变量或提交浏览器登录状态。

缺少模型密钥时仍可管理档案和浏览器；自然语言规划显示 unavailable，不能生成默认行业代替用户需求。研究真实公司 URL 或明确的结构化条件不代表模型已经连接成功。

## 真实研究与网络

研究服务访问实际搜索网站和客户官网，来源与公司证据一同保存。公司数量、失败地址和阻断状态以实际结果为准；没有真实邮箱或电话就留空。

部署网络需要允许模型域名、搜索来源及实际客户网站，目标域名由任务决定。网络受限时在环境设置中追加所需域名，保留现有规则。来源权限、验证码和登录可由用户在共享浏览器接管处理，保存检查点后继续。

Google Maps 专用查询、授权海关企业交易数据库和付费客户数据 API 尚未接入。普通网页浏览不代表这些来源稳定可用；新增适配器需要真实权限、证据和回归场景。

## 同一浏览器与人工操作

工作台显示研究服务控制的 Chromium 画面。用户接管后任务暂停，人工导航、点击、输入和滚动作用于同一会话；Agent 接口拒绝接管期间的修改。交还后继续保存的任务。

浏览器针对公共 HTTP(S) 来源，拒绝内网、回环目标和不允许的重定向；受控本地网页只在显式测试配置中使用。不能绕过验证码或关闭 TLS 验证。网页文本是证据，不是工具权限或用户授权。

Agent 持有浏览器时只允许 GET/HEAD 网络请求，网站的表单 POST 和后台写请求会被拒绝。需要登录或提交表单时先由用户接管，人工操作完成后交还。

开发信是供人工复核的草稿，审批结果绑定完整内容。当前没有真实外发渠道；Hermes 不暴露审批工具。人工复核和接管在工作台完成。

## 数据与备份

浏览器先检查目的地址和重定向，研究任务拒绝私有/回环地址。DNS 预检与代理侧解析之间仍可能有时间差；不可信网站的强网络隔离需要可信出口代理/防火墙禁止私有地址，不能只依赖这一预检。当前版本不作多租户网络隔离承诺。原生 DNS 不可用时，经过 HTTPS 代理访问固定 `dns.google` 做 TLS 验证的备用解析；仍会拒绝解析出的私有地址。配置网络时需允许该备用目的。

默认数据目录为 `work/alex/`，被 Git 忽略；业务库为 `alex.sqlite3`。企业资料版本、记忆、客户、来源证据、草稿、检查点和审计持久保存。归档不移除查重身份；单用户 scope 来自服务配置，不接受任意请求租户 ID。

不要删除数据目录来解决失败。先看实际错误和检查点；重启后从同一 task ID 继续。

运行中可在工作台创建业务备份，或用 CLI：

```bash
npm run backup
```

备份生成一致的业务 SQLite 副本和完整性 manifest，保存库内证据和业务历史。浏览器登录状态、API token 和模型密钥不作为业务备份内容，恢复后重新配置。直接复制 SQLite 主文件可能漏掉 WAL 中已提交事务，应使用受支持入口。

把备份另存至其他磁盘或备份系统；默认同机副本不提供异地容灾。服务定时检查本地备份，重要操作后建议主动备份。

恢复到**新的空目录**：

```bash
node scripts/alex-backup.mjs restore <backup-directory> <new-empty-data-directory>
```

1. 停止原服务，保留原数据目录。
2. 执行恢复，验证 manifest 和校验和，拒绝覆盖已有数据。
3. 检查结果，设 `ALEX_DATA_DIR` 为新目录，启动 `npm start`。
4. 确认资料、客户、记忆和任务读回；按需重新登录来源网站，重新绑定 Hermes token 文件。

恢复不是 Agent 工具。多实例部署、数据盘备份需另行设计；本地 SQLite 不宣称可水平扩展。

## Hermes v2026.9.24

使用[集成说明](../integrations/hermes/README.md)。此仓库没有 vendoring 或 fork 完整 Hermes；扩展固定参考官方 tag，不是不断变化的 main。

Python 扩展注册 17 个工具和 `alex:trade-research` 技能，连接同一本地服务。token 从配置内部读取，认证头不会转发到重定向或远程域名。

Desktop 扩展用 `@hermes/plugin-sdk` 注册页面和侧栏，按钮通过系统浏览器打开工作台；它没有嵌入整个 Alex UI，也不等于完整桌面分发。自定义端口时直接打开对应 Alex 地址。

## 验证与常见故障

```bash
npm test
python integrations/hermes/test_plugin.py
npm run test:legacy
```

测试中的受控网站和离线响应验证边界。真实验收另检查实际 URL、抓取时间、正文证据、公开联系方式、重复运行客户 ID、重启恢复和备份读回。fixture 公司不计入真实结果。

| 现象 | 下一步 |
| --- | --- |
| `node:sqlite` 不可用或 Node 过低 | 使用 Node 24.5+，重跑 `npm ci` |
| 浏览器无法启动 | 核对执行文件、系统运行库和资源 |
| 模型未配置 / unavailable | 安全配置密钥并检查地址与网络，不使用示例凭证 |
| `human_has_control` | 用户在工作台交还，再继续原任务 |
| Hermes `missing_token` | 先启动 Alex，配置正确 token 文件并重启 Hermes，不读 bootstrap |
| 搜索或网站被阻断 | 保存错误和检查点，处理实际网络、权限或验证码 |
| 数量不足 / partial | 查看实际来源及失败地址，不能填造客户 |
| 备份 checksum 不匹配 | 停止恢复，检查副本，不能修改预期校验值强行通过 |

云任务已经隔离，使用当前 checkout。安装和排障保留现有文件、lockfile 和凭证绑定；不 dump 密钥或创建新工作树。
