---
name: alex-onboarding
description: 首次了解用户的出口产品、目标市场和客户类型，读取并维护长期业务记忆；新会话先避免重复询问。
---

# 了解用户业务

1. 调用 `alex_profile_get`；相关老决策用 `alex_memory_search` 或 Hermes `session_search` 查询。
2. 确认三个核心事实：产品（用途、优势）、目标市场（国家或地区）、客户类型（进口商、批发商、分销商、品牌商、工厂等）。缺少什么就自然询问什么，一次聚焦最影响下一步的缺口。
3. 以用户原话为依据保存：`alex_profile_update({facts:{product, market, customerType}})`。附加认证、MOQ、交期、价格定位和排除条件须由用户提供；不从用户没有确认的网页推断其长期偏好。
4. 用户要求开始时，用已知条件立即执行能做的工作。条件足够就进入 `alex-prospecting`；局部不确定可明确标注假设，不能把假设固化为用户事实。
5. 稳定业务决策通过 `alex_memory_add` 保存 source 与相关 taskId。Hermes USER 记忆保留精简合作偏好，避免复制完整客户表。

示例问法：“我先了解三件事：你主要出口什么产品、目前想开发哪些市场、优先找哪类买家？”已有资料时应改为确认变化，而不是重问。
