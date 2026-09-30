# Alex 的邮箱、WhatsApp 与客户沟通

用户通过消息指挥 Agent，由 Hermes Gateway 的 owner 名单控制。Agent 联系客户，则经过 Alex 的收件人策略和持久通信账本。

## 当前实现

| 渠道 | 能力 | 接入条件与限制 |
| --- | --- | --- |
| Gmail | 搜索、读信、带主题发送；保存 message ID / thread ID | 当前 Alex profile 的 Google Workspace OAuth；发送为新邮件，尚无同线程回复参数；未完成真实账号端到端验收 |
| WhatsApp / Baileys | 通过已配对 bridge 发送文本 | `npm run alex -- whatsapp` 配对，bridge 可用；无送达/已读回执接入 |
| WhatsApp Cloud | 通过运行中 Gateway 的 adapter 发送文本 | Business 配置与可达 webhook；已有服务会话文本路径，无冷启动模板和独立 CLI sender |
| IMAP/SMTP | Hermes 邮件网关接收 owner 指令并回复 | `gateway setup` 配置邮箱与 owner；不是 Alex 通用客户邮箱管理器，不通过其通用回复接口发送开发信 |

Gmail 复用 Hermes 官方 `skills/productivity/google-workspace/scripts/google_api.py`，固定执行文件与参数，正文通过标准输入；模型不能指定任意脚本或凭据。首次 OAuth 按 [Hermes Google Workspace 设置步骤](https://github.com/NousResearch/hermes-agent/blob/db39ee3f2892185087bb2432eac242361056fc19/skills/productivity/google-workspace/SKILL.md)完成。执行官方 `scripts/setup.py` 前，将 `HERMES_HOME` 设为实际的 `~/.alex/profiles/alex`；通过 `--check` 核验该 profile 的授权。OAuth client、浏览器授权与代码交换均在用户本机完成，不复制默认 Hermes 的 token。

```bash
npm run alex -- gateway setup
npm run alex -- whatsapp
# 或：npm run alex -- whatsapp-cloud
npm run alex -- gateway run
```

`EMAIL_ALLOWED_USERS`、`WHATSAPP_ALLOWED_USERS`、`WHATSAPP_CLOUD_ALLOWED_USERS` 是可以指挥 Agent 的操作者，不要把全部客户加入。当前支持 owner 驱动的研究与沟通，尚无客户与 owner 权限完全隔离的多客户自动客服路由。

## 本机配置外发范围

默认不允许外发。用户在自己的终端授权一个确切收件人与每日上限。下面的 `.test` 地址仅作说明，不可投递：

```bash
npm run alex -- outreach show
npm run alex -- outreach allow gmail buyer@example.test --daily-limit 5
npm run alex -- outreach revoke gmail buyer@example.test
npm run alex -- outreach disable
```

WhatsApp 使用带国家码的纯数字号码，渠道名为 `whatsapp` 或 `whatsapp_cloud`。不支持通配符。授权表示允许 Agent 在额度内给该收件人发送准备好的内容；需要逐条审阅时，先让它准备草稿，核对后再授权并要求发送。

策略位于 profile 的 `alex-outreach-policy.json`，模型工具不能修改。默认权限配置见[Agent 文档](alex-agent.md)；用户自行启用终端、文件写入或额外消息工具时应重新评估权限。

## 工具与状态

- `alex_mailbox_search` / `alex_mailbox_get`：Gmail 搜索结果和邮件内容，标为外部材料。
- `alex_outreach_prepare`：保存渠道、收件人、主题、正文与可选 companyId，不发送。
- `alex_outreach_list` / `alex_outreach_status`：历史、授权范围、额度和实际状态。
- `alex_outreach_send`：检查授权、日额度和退订，原子占用一次尝试后调用渠道。
- `alex_outreach_suppress`：保存退订或禁止联系，优先于允许名单，模型不能解除。

同幂等键禁止改变内容。相同渠道、收件人和正文重复准备会返回已有记录。`sending` 在请求前落盘，重启后不盲目重发。超时或缺少明确回执记作 `unknown`，用户应先复查服务商历史。额度按 UTC 日期计算，包含不确定尝试。

`sent` 只在服务商确认成功并给出消息 ID 时写入，含义是**服务商接受**，不能证明送达、已读、客户同意或业务转化。当前没有自动对账、投递 webhook 或自动解除不确定状态。

用户可立即 `outreach disable`；退订持久阻断。账本快照用 `npm run alex -- backup-outreach <新的文件路径>`，输出哈希与记录数，拒绝覆盖已有文件。

## 验收

离线测试注入发送适配器，覆盖持久化、重复调用、授权撤销、日限额、退订、并发、超时、消息 ID 与快照，不给任何客户发消息。真实账号验收需要配置账号，并明确指定用户自己控制的测试收件人及内容后单独执行。
