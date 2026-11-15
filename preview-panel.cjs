/**
 * 把「问答」面板渲染成一张静态 HTML，方便用浏览器截图看样式（不进插件产物）。
 *
 *   node preview-panel.cjs
 *   → D:/大肥鱼工作区/dsh-plugins/patches/panel-preview.html
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

const HARNESS = 'D:/大肥鱼工作区/dsh-plugins/patches/render-harness'
const harnessRequire = createRequire(path.join(HARNESS, 'package.json'))
const { JSDOM } = harnessRequire('jsdom')
const React = harnessRequire('react')
const ReactDOMClient = harnessRequire('react-dom/client')

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' })
const { window } = dom
globalThis.window = window
globalThis.document = window.document
try { globalThis.navigator = window.navigator } catch { /* 只读，忽略 */ }
globalThis.MutationObserver = window.MutationObserver
globalThis.requestAnimationFrame = window.requestAnimationFrame
globalThis.cancelAnimationFrame = window.cancelAnimationFrame
window.getSelection = () => ({ isCollapsed: true, rangeCount: 0, toString: () => '', getRangeAt: () => null })
globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, map: {} }) })

const loaded = []
window.__ModuleLoader__ = { load(definition) { loaded.push(definition) } }
const source = fs.readFileSync(path.join(__dirname, 'lib', 'client.js'), 'utf8')
vm.runInThisContext(source, { filename: 'lib/client.js' })

const bundle = loaded[0].factory((name) => {
  if (name === 'react') return React
  if (name === 'react-dom/client') return ReactDOMClient
  throw new Error(`意外的 require：${name}`)
})

const captured = { slots: [] }
const ctx = {
  get: (name) => {
    if (name === 'sidebarRightTabs') return { register: () => () => {} }
    if (name === 'sidebarRight') return { openTab() {}, openTabIn() {}, focus() {}, isExpanded: () => false, active: () => null }
    if (name === 'slots') return { register: (definition, component) => { captured.slots.push({ definition, component }); return definition }, inject: (name, run) => { run(); return () => {} } }
    if (name === 'sessions') return { list: { getSnapshot: () => ({ byId: { 'session-1': { id: 'session-1', cwd: 'D:/大肥鱼工作区' } }, retainedBy: { mainView: 1 } }), subscribe: () => () => {} } }
    return undefined
  },
  effect: (run) => { run() },
  remote: { session: {} },
  sessions: { list: { getSnapshot: () => ({ byId: { 'session-1': { id: 'session-1', cwd: 'D:/大肥鱼工作区' } }, retainedBy: { mainView: 1 } }), subscribe: () => () => {} } },
  workspaces: { list: { getSnapshot: () => ({ items: [] }) } }
}

bundle.apply(ctx)

const Panel = captured.slots[0].component
const container = window.document.createElement('div')
window.document.body.appendChild(container)
ReactDOMClient.createRoot(container).render(React.createElement(Panel, { sessionId: 'session-1' }))

setTimeout(() => {
  const css = window.document.getElementById('daa-style').textContent
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
${css}
html,body{margin:0;height:100%}
body{background:#101218;display:flex;align-items:stretch;color:#e8e8e8;font:13px/20px ui-sans-serif,system-ui,sans-serif}
.stage{width:380px;height:300px;display:flex;flex-direction:column;background:#15171f;margin:16px;border-radius:12px;overflow:hidden}
</style></head><body><div class="stage">${container.innerHTML}</div></body></html>`
  const out = path.join(HARNESS, '..', 'panel-preview.html')
  fs.writeFileSync(out, html, 'utf8')
  console.log('written', out)
  dom.window.close()
}, 400)