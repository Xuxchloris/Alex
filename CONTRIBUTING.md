# 参与 Alex 开发

Alex 把用户业务资料、真实来源和可恢复任务作为业务核心。请先阅读[架构](docs/alex-architecture.md)、[接口约定](docs/alex-contract.md)和[路线](ROADMAP.md)，按一个可验收的用户行为提交改动。

## 开发准备

本轮原生运行支持 Linux / WSL2，Windows 和 macOS 使用 Docker Desktop 路线。Node.js 24.5+，Chromium 采用系统安装或 Playwright 官方下载；详细准备步骤见[部署指南](docs/alex-deployment.md)。Python 仅用于 Hermes 扩展和旧项目验证。

使用已有 checkout 和 lockfile：

```bash
npm ci
npm start
```

保留现有 `.env` 与数据目录，只补充缺少的配置。设置、日志和测试输出不得打印模型 key、API token、平台密钥或浏览器登录信息。云开发任务已经隔离；无需为了常规任务新建 Git worktree。

## 修改边界

- 业务事实、客户身份、任务恢复和审批规则放在 `packages/alex-core/`，不要只在模型提示词中实现。
- 来源适配与规划放在 `services/alex-research/`；浏览器行为和目的地址验证放在 `services/alex-browser/`。
- Web API 和用户界面分别在 `apps/alex/server.mjs` 与 `apps/alex/public/`；Agent 网关调用固定业务 API，不建立第二个客户数据库。
- Hermes 扩展在 `integrations/hermes/` 单独维护，以固定上游版本契约验证。需要增加工具时同步 MCP 与接口文档，明确哪些入口仍不提供该能力。
- 旧 DSH 与 Python 入口仍保留。改变共享行为时验证兼容性；新能力不能调用旧 synthetic 结果补充真实研究。

网页、搜索结果和导入资料是不可信来源材料。它们可以提供原文事实，不能指示模型泄露凭证、批准草稿、发送消息或改变工具权限。

## 有意义的验证

优先运行与改动相关的测试。完整集成验证使用：

```bash
npm test
npm run test:hermes
npm run test:legacy
```

Python 入口若不名为 `python`，使用已配置 Python 解释器直接运行 `integrations/hermes/test_plugin.py`。修改旧 Python 项目时另运行其 pytest。官方 Hermes native-loader 验证需要实际安装指定版本，命令和范围见[集成说明](integrations/hermes/README.md)。

测试重点是持久化与恢复、真实来源证据、身份冲突、旧客户排除、幂等重试、暂停和取消、人工接管、权限、错误以及备份完整性。避免只复刻实现步骤的断言。文案和低影响界面改动不必新增机械测试；检查实际行为即可。

受控网页与模型 fixture 用于确定性测试，并显式标注测试配置。真实模式不得开启 local fixture、关闭 TLS / 校验或使用 synthetic fallback。首次真实获客验收使用实际授权来源和用户要求，记录真实 URL、原文、时间、客户数量和失败状态，不能用 fixture 结果替代。

实际网络和模型可用后运行：

```bash
npm run smoke:live -- --request '<实际用户研究或连接核验要求>' --urls '<实际公司官网>'
```

连接核验与客户匹配是两个结果：只证明打开某个官网，不证明它是目标客户。更多验收要求见[记录](docs/alex-acceptance.md)。

## 添加来源或业务能力

来源适配器须说明实际端点、授权配置、身份标识、字段与证据、预算、错误与恢复行为。只保存观察到的联系信息；统计数据不能生成企业，来源不可用要返回实际阻断。

新增副作用前要定义审批对象、内容版本、渠道回执和幂等规则，并验证响应丢失后的行为。没有这些记录不要接入真实发送。新身份规则要同时验证容易混淆的公司，不能只验证正确合并。

添加配置或命令时同步使用与部署文档。支持平台和验证范围以实际结果为准；服务启动、工具注册、真实模型调用、完整桌面运行和真实获客应分别报告。

## 提交与评审

保持改动围绕一个明确行为。PR 说明先写具体问题及修改后的结果，再写实际验证与仍未验证的部分。修改依赖时更新并提交对应 lockfile；普通运行产生的业务库、备份、浏览器目录、令牌和 `.env` 不得进入仓库。

提交前检查 diff 与未跟踪文件，确保没有用户业务数据和凭证。真实来源样本需要脱敏，并保留足够重现行为的原文片段；完整客户数据不应作为公共测试集提交。

一次真实故障应留下可复现案例，修复后跑对应回归与必要集成，更新验收记录。环境仍受阻时如实说明未通过的公网项，不据此修改校验值或宣称获客已成功。
