/**
 * dsh-ask-aside 渲染测试：用真实 React + jsdom 把「问答」面板和浮层真正渲染一遍。
 *
 *   node render-test.cjs
 *
 * 依赖（不进插件产物）：
 *   D:\大肥鱼工作区\dsh-plugins\patches\render-harness 里的 react@19 / react-dom@19 / jsdom
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert')
const { createRequire } = require('node:module')

const HARNESS = 'D:/大肥鱼工作区/dsh-plugins/patches/render-harness'
const harnessRequire = createRequire(path.join(HARNESS, 'package.json'))
const { JSDOM } = harnessRequire('jsdom')
const React = harnessRequire('react')
const ReactDOMClient = harnessRequire('react-dom/client')

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' })
const { window } = dom

// 把宿主页面里我们会用到的全局补上
globalThis.window = window
globalThis.document = window.document
try { globalThis.navigator = window.navigator } catch { /* Node 20+ 的 navigator 只读，忽略即可 */ }
globalThis.MutationObserver = window.MutationObserver
globalThis.requestAnimationFrame = window.requestAnimationFrame || ((fn) => setTimeout(() => fn(Date.now()), 16))
globalThis.cancelAnimationFrame = window.cancelAnimationFrame || clearTimeout
globalThis.HTMLElement = window.HTMLElement
globalThis.Node = window.Node
globalThis.getComputedStyle = window.getComputedStyle
window.innerHeight = 900
window.innerWidth = 1440
if (!window.matchMedia) window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })

// 选区：默认没有选中
window.getSelection = () => ({ isCollapsed: true, rangeCount: 0, toString: () => '', getRangeAt: () => null })

/* ---------------- 加载 bundle ---------------- */

const loaded = []
window.__ModuleLoader__ = { load(definition) { loaded.push(definition) } }

const source = fs.readFileSync(path.join(__dirname, 'lib', 'client.js'), 'utf8')
vm.runInThisContext(source, { filename: 'lib/client.js' })
assert.strictEqual(loaded.length, 1, '应当注册一个模块定义')

const bundle = loaded[0].factory((name) => {
  if (name === 'react') return React
  if (name === 'react-dom/client') return ReactDOMClient
  throw new Error(`意外的 require：${name}`)
})

/* ---------------- apply：注册 tab + 挂浮层 ---------------- */

const captured = { tabs: [], slots: [] }
const services = {
  sidebarRightTabs: { register: (tab) => { captured.tabs.push(tab); return () => {} } },
  sidebarRight: { openTab() {}, openTabIn() {}, focus() {}, isExpanded: () => false, active: () => null },
  slots: {
    register: (definition, component) => { captured.slots.push({ definition, component }); return definition },
    inject: (name, run) => { run(); return () => {} }
  }
}

const sessionStore = {
  getSnapshot: () => ({
    ids: ['session-1'],
    byId: { 'session-1': { id: 'session-1', cwd: 'D:/大肥鱼工作区' } },
    mainView: 'session-1',
    retainedBy: { mainView: 1 }
  }),
  subscribe: () => () => {}
}

const ctx = {
  get: (name) => {
    if (name === 'sidebarRightTabs') return services.sidebarRightTabs
    if (name === 'sidebarRight') return services.sidebarRight
    if (name === 'slots') return services.slots
    if (name === 'sessions') return { list: sessionStore }
    return undefined
  },
  effect: (run) => { run() },
  remote: { session: {} },
  sessions: { list: sessionStore },
  workspaces: { list: { getSnapshot: () => ({ items: [] }) } }
}

bundle.apply(ctx)

assert.strictEqual(captured.tabs.length, 1, '应当注册一个 tab 类型')
assert.strictEqual(captured.slots.length, 1, '应当注册一个面板')
assert.strictEqual(captured.slots[0].definition.name, 'sidebar.right.pane.tab')

/* ---------------- 真正渲染面板 ---------------- */

const container = window.document.createElement('div')
window.document.body.appendChild(container)
const Panel = captured.slots[0].component
assert.strictEqual(typeof Panel, 'function', '面板应当是函数组件')
const root = ReactDOMClient.createRoot(container)
root.render(React.createElement(Panel, { sessionId: 'session-1' }))

async function settle(ms = 120) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  await settle(200)

  const text = container.textContent || ''
  assert.ok(text.includes('问答'), `面板应显示标题，实际：${JSON.stringify(text.slice(0, 120))}`)
  assert.ok(/引文|选中|提问/.test(text), `面板应有空态提示，实际：${JSON.stringify(text.slice(0, 120))}`)
  // 没有引文时不该能发问
  const textarea = container.querySelector('textarea')
  assert.ok(textarea, '应当有输入框')
  assert.strictEqual(textarea.disabled, true, '没有引文时输入框应禁用')

  // 浮层：没有选区时不渲染任何东西
  const popoverNodes = Array.from(window.document.body.children).filter((node) => node.getAttribute && node.getAttribute('data-ask-aside') === 'popover')
  assert.strictEqual(popoverNodes.length, 0, '未选中文字时不应挂浮层')

  console.log('RENDER TEST OK — 面板挂载、空态、输入框禁用、浮层静默 全部通过')

  root.unmount()
  dom.window.close()
}

main().catch((error) => {
  console.error('RENDER TEST FAILED')
  console.error(error)
  process.exit(1)
})