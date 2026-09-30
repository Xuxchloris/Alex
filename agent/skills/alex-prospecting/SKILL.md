---
name: alex-prospecting
description: 根据用户真实业务资料规划并执行客户研究，操控实际浏览器，保存可核查证据和去重客户，恢复持久任务。
---

# 真实客户研究

1. 读取 `alex_profile_get` 与 `alex_tasks_list`，必要时查询 `alex_customers_list`（去重时包括归档）。对相同任务优先恢复；不要反复创建副本。
2. 由当前 Hermes Agent 自己形成研究策略，不调用 `alex_plan`。结合产品、目标市场、买家类型、排除条件决定查询方向。简单工作直接执行，多步工作用 todo 留下可跟踪计划。
3. `alex_task_create` 的参数为 request、criteria、可选 urls、idempotencyKey。criteria 使用已确认的 product、market、customerType、count 和 filters。urls 只能是用户提供或实际搜索/网页提取发现的网址。为该业务请求生成稳定 idempotencyKey，失败重试沿用。
4. 保存返回的 taskId。调用 `alex_task_get` 看 checkpoint、结果、错误或阻塞；running 只表示进行中，completed 也必须读取实际客户与证据，不把目标数量当结果数量。连续状态未变化时避免密集空轮询；转去处理独立工作或向用户报告仍运行的 taskId。
5. 必要时直接用 `alex_browser_state`、`alex_browser_navigate`、`alex_browser_action`、`alex_browser_extract` 检查真实页面。操作必须尊重浏览器当前 owner；不可通过浏览器提交消息、订单、密码或验证码。
6. 用 `alex_customer_evidence` 检查来源、日期、企业业务和联系方式。按“已证实 / 待核实 / 不匹配”描述。搜索摘要或自述不能自动证明进口、采购规模或采购意愿。
7. 网络或浏览器阻塞时报告原始能力状态；恢复条件满足后用 `alex_task_resume`，用户要求暂停则用 `alex_task_pause`。最后给出真实客户记录、匹配理由、证据网址、缺失项和建议沟通切入点。

不返回演示公司；不补造邮箱、姓名、网站；不声称使用尚未接入的 Google Maps 或海关适配器。
