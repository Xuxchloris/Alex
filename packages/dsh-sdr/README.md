# `@xuxchloris/dsh-sdr`

[![npm version](https://img.shields.io/npm/v/@xuxchloris/dsh-sdr?logo=npm)](https://www.npmjs.com/package/@xuxchloris/dsh-sdr)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/Xuxchloris/deepseek-harness-sdr-plugin/blob/main/LICENSE)

DeepSeek Harness 的 SDR 数字员工插件，当前已实际验证 `0.1.0-rc.7` 和 `0.1.1-rc.2`，提供九阶段外贸获客流程、知识检索、客户去重、人工审批和审计日志。

Email、WhatsApp、CRM 默认 dry-run，不会发送真实消息；运行时不依赖 Python 环境。

完整说明、架构图和验收记录见[仓库根目录 README](https://github.com/Xuxchloris/deepseek-harness-sdr-plugin#readme)。

## 安装

当前已实际验证 DeepSeek Harness `0.1.0-rc.7` 和 `0.1.1-rc.2`、Node.js `20+`。官方 master 若要求更高 Node.js 版本，以其说明为准。

```powershell
dsh plugin --profile web add @xuxchloris/dsh-sdr
dsh web
```

重启 Web 后新建会话，在模式菜单选择「SDR 数字员工」。源码安装：

```powershell
git clone https://github.com/Xuxchloris/deepseek-harness-sdr-plugin.git
cd deepseek-harness-sdr-plugin
dsh plugin --profile web add ".\packages\dsh-sdr"
dsh web
```

preset 写入 `$DSH_HOME/.agent-presets/sdr`；Windows 未设置 `DSH_HOME` 时是 `%USERPROFILE%\.dsh\.agent-presets\sdr`。安装器不会覆盖没有 `dsh-sdr` 管理标记的同名 preset。

## 使用

在 SDR 模式中输入任务，例如「开发 3 个美国户外用品客户」。Agent 调用 `sdr_create_task` 和 `sdr_next_step` 推进，阶段顺序由服务端决定。第 6 阶段 `sdr_review_drafts` 列出开发信草稿，等人工选择；全部草稿批准后，`sdr_continue_after_approval` 才放行后续阶段。批准凭证绑定草稿哈希，草稿改过需要重新审批。

没有 DSH Web 时，在源码仓库的 `packages/dsh-sdr` 目录下跑离线测试：

```powershell
npm.cmd test
node "..\..\scripts\demo_dsh_sdr.mjs"
```

模式菜单没出现时，重新执行 `dsh plugin --profile web add ...`，重启 `dsh web` 并新建会话。审批工具返回 `fetch failed` 说明当前会话不支持 agent 交互提问，任务会冻结在审批阶段，不会跳过审批继续执行。

## 数据与配置

任务状态默认保存在 `%USERPROFILE%\.dsh\.dsh-sdr\state.json`，可用 `DSH_SDR_DATA_FILE` 改路径。知识库默认是本地原子 JSON adapter；生产环境可注入 PostgreSQL：

```js
const knowledge = new PostgresKnowledgeRepository({ pool, embedder, reranker });
const sdr = new SdrService({ store, knowledge });
await knowledge.ensureSchema();
```

知识库支持全文召回、可选 embedding、混合排序、reranker、来源版本和 Recall@K/MRR 评测。数据库、embedding 服务和凭证由部署环境提供，不进入工具参数或审计日志。

允许 Agent 写入用户确认过的知识：

```powershell
$env:DSH_SDR_AGENT_KNOWLEDGE = '1'
```

允许 Agent 补充非敏感 connector 配置：

```powershell
$env:DSH_SDR_AGENT_CONFIG = '1'
```

Agent 只能写白名单字段和凭证引用名，写不了密码、token、API key 的值。`DSH_SDR_AGENT_LIVE_CONFIG=1` 只保存 live 配置，不会自动启用真实发送。

## 工具

`sdr_create_task`、`sdr_next_step`、`sdr_review_drafts`、`sdr_continue_after_approval`、`sdr_get_task`、`sdr_get_report`、`sdr_audit_log`、`sdr_knowledge_search`、`sdr_knowledge_upsert`、`sdr_knowledge_list`、`sdr_knowledge_evaluate`、`sdr_connector_status`、`sdr_configure_connector`。

没有 `send_email` 或通用 `send` 工具。默认 connector 的 `send()` 返回 `blocked-dry-run`。

## 发布

发布由仓库根目录的 `.github/workflows/npm-publish.yml` 完成，只响应 `dsh-sdr-v*` 标签，发布前跑 `npm test`，用 GitHub Actions OIDC + npm Trusted Publishing，不需要长期 npm token。

```powershell
npm version patch
git tag dsh-sdr-v0.2.3
git push origin dsh-sdr-v0.2.3
```

## 许可证

MIT。仓库不含 `.env`、真实客户数据和 API key。
