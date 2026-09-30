# 让 Alex 在后台持续跟进

本轮提供 Gmail 的持久跟进日程和 Hermes 原生巡检任务。研究任务仍使用已有 task/checkpoint；WhatsApp 入站和 Cloud 主动模板尚未接入。

## 先完成连接

执行 `npm run alex -- doctor`，确认业务服务认证成功，再在 Alex 独立 profile 中配置模型和 Gmail。diagnostic 显示配置存在不代表模型推理或 OAuth 网络已通过；首次用用户自己控制的测试邮箱验收。连接方法见 [Agent 使用](alex-agent.md) 和 [渠道](alex-channels.md)。

后台运行需要业务服务与 Hermes Gateway 持续运行，不能只关闭聊天窗口便认为 Agent 已经常驻。

```bash
# 终端一：业务服务
npm start
# 终端二：Gateway，在当前终端持续运行
npm run alex -- gateway run
```

正式服务安装可使用 Hermes 原生 `gateway install` 和仓库已有业务服务部署模板；本轮没有替用户新安装系统服务。

## 安排跟进

对话中让 Alex 读取已发送邮件、同步真实线程，再提出明确要求，例如：“这封开发邮件若客户没有回复，10 月 2 日北京时间上午 10 点跟进一次；有回复或退订立即停止。”

Agent 使用 `alex_followup_schedule` 持久保存记录。保存记录不启动后台进程。每封原始邮件只允许一项计划，重复调用返回原记录，修改为不同时间或目的会提示冲突；取消不能删除已发生的联系历史。

本机可直接检查：

```bash
npm run alex -- agenda
npm run alex -- agenda --due
npm run alex -- agenda --all
```

状态包括 scheduled（待执行）、replied（收到较晚的同联系人回信）、cancelled、sending、sent、needs_review。收到自动回复也先停止旧催发，不推断为采购意向。sending/needs_review 需要核对服务商结果，不自动再次发送。

## 安装巡检任务

```bash
npm run alex -- routine install --every-hours 1
```

命令输出真实 jobId；首次创建为暂停状态，便于先完成模型、账号和常驻进程配置。同名任务已存在时复用，保留用户调整的频率和状态，不重复创建。

完成配置后，用输出中的实际 jobId：

```bash
npm run alex -- cron resume <jobId>
npm run alex -- cron status
npm run alex -- cron list --all
# 需要停止时：
npm run alex -- cron pause <jobId>
```

执行历史、手动运行和修改频率沿用 `npm run alex -- cron --help`。默认巡检结果保存在本机；没有配置消息投递目标时不会主动给你的 WhatsApp 或邮箱发通知。

巡检最多处理 20 项：读取日程、同步线程、停止已回复/退订项、准备到期跟进，并仅在既有确切收件人策略内发送。草稿携带 followupId，发送函数会再次查信与核验状态。策略没有授权时只保留草稿，不能通过 cron 绕过。新计划和第二轮跟进仍由用户委托，不无限催发。

## 当前边界

- 没有邮件 webhook；这是用户启用后的定时读取，时效取决于巡检频率。
- 仅关联已发送 Gmail 的真实 thread ID；转到全新主题的邮件、其他联系人和转发不会被自动认定为该条回复。
- 每次同步最多 200 封，保存每封最多 6000 字符摘要及截断标记；完整读信继续用 mailbox_get。超出上限或字段无效时报告阻塞。
- 邮件读取与发送不是服务商原子事务；刚好在最后一次检查后到达的回复仍可能与发送交错。
- 真实账号和模型尚未完成端到端验收。离线测试和原生任务创建成功，不能证明后台真实业务已跑通。
