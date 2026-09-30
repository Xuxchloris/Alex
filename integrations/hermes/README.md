# Alex 的 Hermes 原生扩展

兼容基线为 Hermes 官方 **v2026.9.24**：`plugin.yaml`、Python `register(ctx)`、`ctx.register_tool`、`ctx.register_skill`，以及原生 Desktop 的 `@hermes/plugin-sdk`。扩展连接独立运行的本机 Alex 服务及共享浏览器。

官方 `v2026.9.24` 对应代码 commit：`f97608f178d1ffeca59860195ab7da295f7c8e5f`；`e3dd27ee2d8b011737a4eea8e3eb3d711ab78690` 是该发布的 annotated tag 对象 ID。验证源码由 `git archive v2026.9.24` 导出，已与该代码 commit 的 loader、manifest、Desktop SDK 及参考文档逐字节核对。Python 插件无需第三方依赖；Desktop 文件是未编译 ESM，仅用 Hermes SDK 和 React runtime，提供工作台入口，不含完整 Hermes 程序。

## 安装到已有 Hermes

先在项目根目录安装并启动 Alex：

```bash
npm ci
npm start
```

保留现有插件和配置。在**尚不存在** Alex 插件目录时安装：

```bash
alex_plugin_root="${HERMES_HOME:-$HOME/.hermes}/plugins"
if test ! -e "$alex_plugin_root/alex"; then
  mkdir -p "$alex_plugin_root"
  cp -R integrations/hermes "$alex_plugin_root/alex"
  hermes plugins enable alex
else
  echo "Alex plugin already exists; inspect it before updating."
fi
```

已有目录时先检查再更新代码，不盲目覆盖文件。系统路径和云沙箱按各自授权范围处理。也可放入可信项目的 `.hermes/plugins/alex/`，该模式需设置 `HERMES_ENABLE_PROJECT_PLUGINS=true`。

在 **Hermes 启动进程**配置路径，修改为真实绝对路径：

```text
ALEX_API_URL=http://127.0.0.1:3210
ALEX_API_TOKEN_FILE=/absolute/path/to/project/work/alex/api-token
```

这是路径，不是 token 值。Alex 首次启动生成文件；插件只在内部读取，不返回给模型。自定义数据目录可用 `ALEX_DATA_DIR` 定位 `api-token`。如果 Alex 使用显式 `ALEX_API_TOKEN` 而未生成文件，通过安全环境绑定给 Hermes 同一变量。不要调用 bootstrap 取 token，也不要把 token 写进工具参数、技能或对话。

重启 Hermes 后检查工具。技能用 `skill_view("alex:trade-research")` 读取；插件技能不一定自动出现在 available-skills，按官方发现规则加载。

Hermes Desktop 的 unified package 扫描 `desktop/plugin.js`。在 Capabilities → Plugins 打开 Alex，侧栏进入页面，点击“打开 Alex 工作台”。自定义端口直接打开对应本机地址。远程 Hermes 网关不能用其 `127.0.0.1` 操作另一台电脑的 Alex；当前要求插件进程与 Alex 服务同机。

## 工具边界

| 工具组 | 功能 |
| --- | --- |
| `alex_profile_get/update` | 企业资料读取与明确事实更新 |
| `alex_memory_search/add` | 带来源的持久记忆 |
| `alex_plan` | 结合已有资料规划研究 |
| `alex_task_create/get`、`alex_tasks_list`、`alex_task_resume/pause` | 创建、查询和恢复任务 |
| `alex_customers_list`、`alex_customer_evidence` | 客户历史、归档记录与出处 |
| `alex_draft_create` | 待人工复核草稿 |
| `alex_browser_state/navigate/action/extract` | 同一个浏览器，遵守人工接管 |

业务 API 使用 `X-Alex-Token`。客户端强制回环 origin、禁止重定向、绕过出口代理连接本机。工具不接受任意 workspace、凭证或 endpoint，不提供审批、真实外发、token 获取、数据恢复或抢回人工控制权。

工具返回 `{ok, result}` 或 `{ok:false, code, error}`。接管错误等待用户交还；部署错误修复实际配置，不改用演示响应。

## 验证

```bash
python integrations/hermes/test_plugin.py
```

离线测试验证注册、HTTP 契约、认证、凭证文件、禁止重定向和人工接管错误。fixture 不是获客数据。完整 Hermes 桌面构建、真实模型调用与外部来源验证依赖实际环境，应分别报告。

本次还在隔离 Python 环境中用官方 tag 的真实 `PluginManager` 加载全部 17 个工具与技能，并验证卸载清理及官方 Desktop surface 检查；没有替代 `PluginContext`。安装了该版本 Hermes 的开发者可运行：

```bash
python integrations/hermes/verify_native.py
```

该验证使用临时 Hermes home，不改用户插件配置，不调用模型和外部网站；它不等于完整 Hermes Desktop 启动验收。

官方参考：[Python 插件](https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/website/docs/user-guide/features/plugins.md)、[Desktop SDK](https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/website/docs/developer-guide/desktop-plugin-sdk.md)。
