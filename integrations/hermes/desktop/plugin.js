// Hermes Desktop v2026.9.24 disk/unified plugin: plain ESM, no build step.
import { host, ROUTES_AREA, SIDEBAR_NAV_AREA } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'

export default {
  id: 'alex',
  name: 'Alex · 智能外贸助手',
  register(ctx) {
    function AlexPage() {
      return jsxs('div', {
        className: 'flex h-full flex-col gap-4 p-6 text-sm',
        children: [
          jsx('h1', { className: 'text-xl font-semibold', children: 'Alex · 智能外贸助手' }),
          jsx('p', { children: '长期业务记忆、真实客户档案、证据和可接管的浏览器由本机 Alex 工作台保存。Hermes 的 Alex 工具连接同一服务。' }),
          jsx('p', { children: '先在项目目录运行 npm start，再打开工作台。本扩展提供入口；浏览器操作与人工复核在 Alex 工作台完成。' }),
          jsx('button', {
            type: 'button',
            className: 'w-fit rounded border px-4 py-2',
            onClick: async () => {
              const opened = await ctx.os.openExternal('http://127.0.0.1:3210')
              if (!opened) host.notify({ kind: 'info', message: '请在本机浏览器打开 http://127.0.0.1:3210' })
            },
            children: '打开 Alex 工作台'
          }),
          jsx('p', { className: 'text-(--ui-text-tertiary)', children: '此入口仅连接本机默认端口。远程 Hermes 网关需单独配置本机 Alex 服务；扩展不会获取或显示 API token。' })
        ]
      })
    }
    ctx.register({ id: 'page', area: ROUTES_AREA, data: { path: '/alex' }, render: () => jsx(AlexPage, {}) })
    ctx.register({ id: 'nav', area: SIDEBAR_NAV_AREA, data: { path: '/alex', label: 'Alex 外贸助手', codicon: 'globe' } })
  }
}
