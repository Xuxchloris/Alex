# Alex 的入口与 Hermes 能力对照

Alex v0.3 是基于 Hermes 原生 profile 的外贸专家 Agent。日常入口是对话与消息网关；Web 页面用于管理和复核。客户、资料、研究任务和浏览器由同一个本机业务服务管理，Hermes profile 另持久保存 Agent 会话、记忆与外发账本。

## 选择入口

| 入口 | 适合的用法 | 本轮范围 |
| --- | --- | --- |
| Alex Agent | 对话交代外贸任务，研究客户、查邮件、在授权范围内开发跟进 | 独立 Hermes profile、28 项领域工具、4 项普通技能和品牌皮肤 |
| Alex Web | 看客户、来源、任务、浏览器，人工接管和复核 | 可选管理页，默认 `http://127.0.0.1:3210` |
| MCP stdio | 在支持 MCP 的客户端中调用 Alex | 19 个固定业务工具，经本机 API 访问；没有独立数据库 |
| 远程 SSH 隧道 | 使用长期运行的 Linux 服务，同时从自己电脑看 Web | 将远端 loopback 端口转发到本机；不公开 Alex API |

企业资料更新、任务执行和浏览器操作需要本机 API 认证。客户外发另需 owner 在本机配置渠道、确切收件人与额度；旧 Web 草稿审批不能授权这些外发工具。人工抢回浏览器控制权和数据恢复仍不属于 Agent 工具。

## Hermes 原生扩展

安装步骤以[Agent 使用说明](alex-agent.md)为准。先启动业务服务，使用 `npm run alex -- init` 经官方 profile installer 安装独立 Alex，再运行 `npm run alex -- model`、`npm run alex -- chat`。为启动进程设置：

```text
ALEX_API_URL=http://127.0.0.1:3210
ALEX_API_TOKEN_FILE=/absolute/path/to/alex-data/api-token
```

token 文件由 Alex 首次启动生成，工具在内部读取。不要将 token 值写进技能、提示词或工具参数。显式 `ALEX_API_TOKEN` 也可通过安全环境绑定；它不是模型 API key。

源码固定参考版为官方 Hermes `v2026.9.24` / v0.21.5，代码 commit `f97608f178d1ffeca59860195ab7da295f7c8e5f`；本机安装与 28 工具真实加载验证使用 v0.21.3、commit `db39ee3f2892185087bb2432eac242361056fc19`。28 项工具由原有 17 项业务工具和 11 项 Gmail/外发/跟进工具组成。仓库发行 SOUL、技能、皮肤和插件，复用已安装 Hermes，不维护另一份 Hermes core；旧 Desktop 侧栏仅是可选管理页入口。

原生 profile 安装、插件注册、技能加载与卸载清理已验证；模型和渠道真实账号端到端仍分别验收。代码调用链、精确版本与继承范围见[Hermes 源码研究](alex-hermes-study.md)。

## 从 Telegram、飞书等平台使用

这些平台入口由 Hermes 原生 Messaging Gateway 提供。通过 `npm run alex -- gateway setup` 配置 Alex 独立 profile 的平台凭证和 owner 允许名单，再运行 `npm run alex -- gateway run`。Alex 另实现 Gmail 查读与新邮件外发、WhatsApp 文本外发和通信账本；它们仍依赖真实账号及上游渠道。不要把客户全部加入能指挥 Agent 的 owner 名单。能力详情见[渠道接入](alex-channels.md)。

官方 `v2026.9.24` 的[平台文档](https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/website/docs/user-guide/messaging/index.md)和源码包含：

| 类别 | Hermes 官方入口 |
| --- | --- |
| 常见聊天与办公 | Telegram、Discord、Slack、Google Chat、WhatsApp、WhatsApp Cloud API、Signal、Mattermost、Matrix、Microsoft Teams、LINE |
| 中国用户常见平台 | DingTalk、Feishu/Lark、WeCom、WeCom Callback、Weixin、QQ、Yuanbao |
| 其他消息入口 | SMS、Email、BlueBubbles、Photon、ntfy、Raft、IRC、Buzz、SimpleX、Home Assistant |
| 集成与实验入口 | OpenAI-compatible API server、Webhooks、MS Graph webhook；Hermes Relay 为实验性连接器 |

该清单来自指定版本的官方文档与 adapter 配置，不代表本轮已登录或测试这些平台。不同平台需要各自账号、凭证、依赖和事件配置，某些适配器通过 bundled plugin 注册；不能只看一个枚举就假设全部平台已经连接。

Alex 的配置入口为 `npm run alex -- gateway setup`，服务状态可用 `npm run alex -- gateway status` 检查。当前默认模型不开放 cronjob 工具，定时安排由用户在本机 `npm run alex -- cron ...` 管理。具体认证、接收对象和平台权限遵循对应官方文档；配置已保存不等于真实账号已连接。

当前 Alex 只有一个本机业务工作空间。Hermes 的每聊天会话和平台用户标识不会自动把 Alex 变成多租户系统；只让获授权的使用者进入这一工作空间。不同企业应使用独立实例、数据目录和端口，直到团队隔离功能完成。

## MCP stdio

先启动 Alex。MCP 客户端随后启动一个 stdio 服务进程：

```bash
npm run --silent gateway:mcp
```

stdio 的标准输出必须只包含 MCP 消息，因此 npm 入口使用 `--silent`。客户端配置的工作目录不确定时，直接使用服务文件的真实绝对路径：

```json
{
  "mcpServers": {
    "alex": {
      "command": "node",
      "args": ["/absolute/path/to/Alex/services/alex-mcp/index.mjs"],
      "env": {
        "ALEX_API_URL": "http://127.0.0.1:3210",
        "ALEX_API_TOKEN_FILE": "/absolute/path/to/alex-data/api-token"
      }
    }
  }
}
```

路径按你的安装修改。文件路径不是秘密值；token 内容由进程读取，不由模型提供。MCP 使用标准 stdio 与固定工具 schema，连接只允许 loopback origin、禁止重定向，并绕过外部代理连接本机。详细配置和边界见[MCP 集成说明](../integrations/mcp/README.md)。

19 个工具复用原有 17 个 Hermes 业务工具，并增加 `alex_health` 和 `alex_task_cancel`。它没有跟随 Hermes 插件增加 11 项邮箱/外发/跟进工具。MCP 进程不启动第二份业务服务、不自建数据库、不读取 bootstrap 取 token，也不提供审批、外发或恢复工具。未知 token、服务未启动或人工接管应返回实际错误。

## 远程使用

长期运行的 Alex、Hermes 网关和 MCP 业务连接可以部署在同一 Linux 主机。用户从自己的电脑通过 SSH 看 Web：

```bash
ssh -N -L 3210:127.0.0.1:3210 <ssh-user>@<server>
```

连接保持运行，打开本机 `http://127.0.0.1:3210`。本机端口冲突时可用 `13210:127.0.0.1:3210` 并打开对应 `13210` 地址。远程服务器的 `127.0.0.1` 指向服务器，用户电脑的 `127.0.0.1` 指向用户电脑；直接复制地址不会让两台机器互通。

这里建议将 Agent 与业务服务放在同机，只给 Web 建隧道。不要把 API 改成公网监听，也不要把 token 贴进聊天。需要远程 HTTP MCP、OAuth、多用户登录或公网 Web 部署时，应先完成对应权限和隔离设计。

## 对照 Hermes：继承通用能力，补齐外贸档案

对照基线为上述固定官方版本。下表的“已有”指工程实现及适用范围，真实连接验证另见[验收记录](alex-acceptance.md)。

| 能力 | Hermes 官方已有能力 | Alex 本轮实现 | 后续 / 当前限制 |
| --- | --- | --- | --- |
| 持续对话 | CLI、Desktop、Gateway 会话与跨会话检索 | 独立 Alex profile 使用 Hermes Agent；Web 会话为辅助入口 | 各平台真实连接未验收 |
| 长期记忆 | `MEMORY.md`、`USER.md`、memory 工具、会话搜索与可选 memory provider | SQLite 企业事实版本、带来源记忆、稳定客户 ID、证据、归档查重 | Hermes 对话记忆不代替客户业务数据库；团队隔离待开发 |
| 技能迭代 | 按需技能、Hub、Agent 管理与创建技能 | SOUL + 入门、研究、跟进 4 项普通技能；插件兼容技能保留 | 尚无通过长期真实任务验证的自主行业学习闭环 |
| 浏览器 | 通用浏览器与 computer-use 工具生态 | 同一 Chromium 的 DOM 证据、画面、Agent/人工控制权与暂停恢复 | 公网访问受环境阻断；无验证码绕过 |
| 多入口 | 原生 Messaging Gateway、插件、MCP 客户端等 | Hermes 28 工具 + MCP stdio 19 业务工具 + 可选 Web 管理页 | 渠道需要实际配置与逐项验收 |
| 外贸获客 | 可用通用工具开展研究，需自行组织业务流程 | 真实搜索外链→官网核验→去重→证据→待复核档案 | 首轮公网获客尚未通过；Google Maps/海关专用适配器待接入 |
| 客户沟通 | Google Workspace、消息平台 adapter | Gmail 查读/线程同步/回复/跟进，WhatsApp 文本发送、确切收件人策略、持久账本及退订 | 真实账号 E2E 未验收，Cloud 主动模板和投递回执未实现 |
| 备份与运行 | 官方 profile、session 和网关服务机制 | 一致数据库备份、校验恢复、单实例服务配置 | 异地副本由部署者配置；云开发环境不等于长期托管 |

Hermes 有自己的原生 Windows 安装支持，不代表 Alex 的 Linux 锁与运行脚本可以直接在原生 Windows/macOS 运行。Alex 当前支持路径见[部署指南](alex-deployment.md)。
