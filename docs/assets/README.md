# Alex 品牌与演示

## v0.3 Agent 品牌

新主页使用 `alex-agent-icon.png`（透明图标）和 `alex-agent-social-preview.png`（2:1 分享横幅，低于 1 MB）。深海蓝 A / 翼形与珊瑚橙方向切口对应 Alex 的外贸 Agent 身份。生成工具、完整提示词、尺寸与源文件记录见[品牌来源说明](alex-agent-brand-notes.md)。

`alex-agent.gif` 是实际 Hermes AIAgent + Alex 插件/API/SQLite 的工具执行记录可视化，1100×640、12.6 秒。模型决定为脚本 fixture，画面持续标注；它不是实际模型推理或客户获客成果。原生循环跨两个进程执行 10 次工具调用，验证重启读取资料、同一草稿去重、默认拒绝外发，真实发送与生产客户均为 0。详见[完整 trace](alex-agent-demo-manifest.json)。

在 Linux / WSL2 安装 Hermes Python 环境、Chromium 和 ffmpeg 后复现：

```bash
ALEX_HERMES_PYTHON=/path/to/hermes/venv/bin/python \
ALEX_CHROMIUM_PATH=/path/to/chromium \
npm run demo:agent -- --output-dir /tmp/alex-agent-preview
```

脚本使用临时 HOME / HERMES_HOME、独立业务数据和模型客户端替身，不读取实际账号。GIF 的 HTML 帧展示实际回调输出；不是终端屏幕录像。上游精确版本和执行边界随 manifest 保存。

GitHub Social preview 是仓库设置项，不随提交自动生效；README 已直接引用新横幅。下列旧素材保留作为 v0.2 功能记录。

## v0.2 管理页面素材

| 素材 | 用途 |
| --- | --- |
| `alex-logo.png` | 原创透明图标；应用与 favicon 使用同一标识 |
| `alex-banner.png` | README 横幅，2:1 |
| `alex-social-preview.jpg` | 同一横幅的 JPEG 导出，低于 1 MB |

图标与横幅于 2026-09-30 使用图像生成工具制作，以 A、导航箭头与地球轨道呈现品牌。JPEG 仅为文件格式导出。素材随项目按 MIT 分发。

GitHub 仓库没有独立头像字段。图标放在 README 和应用中；管理员可在 **Settings → General → Social preview → Edit → Upload an image** 上传 `alex-social-preview.jpg`。这项设置不随 Git push 自动应用，也不会修改个人账号头像。

## 功能演示

这里的动图与截图来自实际运行的 Alex 界面和 Chromium。每个画面都标注 **“功能演示 · 测试网站（非真实获客数据）”**。

录制使用本机受控网站、测试产品与测试联系资料，验证软件流程。它不展示真实客户发现结果，也不代表公网搜索、地图或海关来源已通过验收。演示不调用模型；自然语言对话能力应按独立模型配置与会话测试评估。

- [工作台演示 GIF](alex-workbench.gif)：约 11 秒，宽度 1000 像素。
- [原始封面截图](alex-workbench-cover.png)：保留完整截图分辨率，方便放大核对。
- [画面联系表](alex-workbench-contactsheet.png)：查看整个录制序列。
- [演示核验记录](alex-demo-manifest.json)：列出步骤、时长和通过的断言。

演示依次执行：用户填写业务记忆 → 提供测试网站 → 浏览器读取网页并存档证据 → 查看公开测试联系方式 → 归档 → 再次研究同一网站并确认只有一个客户编号 → 创建本机备份 → 接管同一个浏览器 → 在画面上点击网页按钮 → 交还控制权。

公司在此演示中属于待人工复核档案。没有模型匹配结果时，不将其描述为合格客户。本机备份的保存画面也不代表已经建立异地副本。

## 重新录制

先按项目安装说明准备 Node.js、npm 依赖和 Chromium。素材编码还需要 Python 3 与 Pillow；它们是录制工具依赖，不是应用运行依赖。

```sh
node scripts/alex-record-demo.mjs
```

如果当前 Python 没有 Pillow，可以在独立虚拟环境中准备：

```sh
python3 -m venv /tmp/alex-demo-venv
/tmp/alex-demo-venv/bin/python -m pip install Pillow==12.3.0
ALEX_DEMO_PYTHON=/tmp/alex-demo-venv/bin/python node scripts/alex-record-demo.mjs
```

默认更新本目录的演示 GIF、封面、联系表和核验记录。要先核对输出，可使用：

```sh
node scripts/alex-record-demo.mjs --output-dir /tmp/alex-demo-preview
```

录制脚本为数据、浏览器和备份创建独立临时目录，生成临时访问令牌，完成后清理。它不读取用户令牌、不使用 `work/alex`，也会拒绝将素材输出到现有用户资料或备份目录。截图中的测试标签通过录制浏览器显示，网页本身也标有受控测试说明；浏览器画面始终来自实际会话。
