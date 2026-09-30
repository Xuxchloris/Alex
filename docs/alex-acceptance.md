# Alex v0.1 验收记录

验证日期：2026-09-30。执行环境：Node.js 24.19.0、Python 3.12.14、系统 Chromium。这是首版工程验证记录，不是获客成功报告。

## 已完成的工程验证

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

## 真实公网验收：尚未通过

已执行以下连接诊断，目标仅为核验已知真实官网，不代表替用户预选行业或市场：

```bash
npm run smoke:live -- \
  --request '连接验收：核验 Medline 真实官网的公开公司信息，仅保存可直接观察的证据，不推断客户匹配。' \
  --urls https://www.medline.com/
```

本次任务返回 `unavailable`；错误为 `source_unavailable: Website could not be loaded.`，`actualCount=0`、`matchedCount=0`、`needsReviewCount=0`。验收脚本以非零状态退出。真实数据目录检查保存客户数为 0，没有以 fixture 或合成客户补数。

`/api/health` 返回服务可用、`browserAvailable=true`、`modelConfigured=false`、`sourceMode=live-only`、`discoveryStatus=unverified`。当前云环境的出口访问受限，实际公司站点和搜索来源尚未通过；模型密钥也未绑定。因此自然语言规划、模型核验和模型开发信的真实联调尚未通过。

已保存云环境安装/启动脚本、动态目标网站的网络要求和 `ALEX_LLM_API_KEY` 秘密绑定要求。保存草稿不会自动应用网络配置或生成密钥；需要在环境设置中应用并安全配置密钥后，再按用户实际任务进行验收。

## 下一次真实验收

1. 用户描述产品、市场、客户类型与约束，Alex 读取已存资料并询问缺失信息。
2. 执行任务，逐条核对实际公司官网、抓取时间、正文引用和公开联系方式；不足的数量与阻断原因保留。
3. 重跑任务，确认重复公司不被计为新客户；归档后仍参与查重。
4. 暂停、重启并恢复同一任务；创建备份并恢复到新空目录，检查客户 ID、记忆、证据与检查点。

Google Maps 专用获客适配器、授权海关企业交易数据、外部消息发送和生产多租户部署仍需后续实现及独立真实验收。
