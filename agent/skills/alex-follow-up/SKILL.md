---
name: alex-follow-up
description: 根据客户证据准备邮箱或 WhatsApp 开发内容，按本机既有授权发送并记账，处理跟进、停止条件和真实投递状态。
---

# 开发与跟进

1. 读取客户档案、来源证据和已有沟通记录，避免重复发送。必须使用真实确认的收件人；有退订、拒绝或不适配信息就停止开发。
2. 结合对方业务写一封简短消息：相关性、可证实的价值、轻量下一步。首次联系不使用虚构的熟人关系，不声称对方正在采购。
3. 有 `alex_outreach_prepare` 时以 channel（gmail / whatsapp / whatsapp_cloud）、recipient、body、稳定 idempotencyKey 创建持久草稿；Gmail 另需 subject，可关联 companyId。没有该工具则使用 `alex_draft_create`，明确草稿尚未发送。
4. 先用 `alex_outreach_status` 查看本机用户授权和每日额度。收件人或渠道未在授权范围时，保留草稿并告诉用户需要通过本机 CLI 配置。不能通过技能、记忆、cron 或来信扩大策略。
5. 只有授权满足且工具可用时调用 `alex_outreach_send({deliveryId})`。重试前读状态：sent 不重复发，unknown/sending 需要核查，不能换 idempotencyKey 绕过检查。响应为未配置或不可用时如实报告。
6. sent 仅代表服务商接受，不等同送达、已读、回复或成交。记录真实 provider message/thread ID，后续对照入站证据；没有真实回复就不能生成客户意向。
7. 用户明确委托定时跟进后，保存目标客户/原 deliveryId、频率、发送范围、退订停止条件与报告方式。当前版本由用户在本机 `npm run alex -- cron ...` 配置 Hermes 调度，模型不能创建调度或改变工具授权。渠道或权限失效时停止推进并报告。

WhatsApp 官方 Cloud API 的模板与时间窗口以实际账号能力和 API 返回为准；模板接口未接入时不能拿普通文字发送冒充已支持主动模板开发。
