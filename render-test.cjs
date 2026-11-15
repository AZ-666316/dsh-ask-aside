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
    ids: ['session-1', 'session-side-1'],
    byId: {
      'session-1': { id: 'session-1', cwd: 'D:/大肥鱼工作区' },
      'session-side-1': { id: 'session-side-1', cwd: 'D:/大肥鱼工作区' }
    },
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

// 宿主侧「主对话 → 侧线」映射的替身。先给空，后面再换成「已经有一条旁支」。
function stubMap(map) {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, map }) })
}
stubMap({})

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
  // 面板本身就是入口：有当前会话就能直接问，不要求先划词
  const textarea = container.querySelector('textarea')
  assert.ok(textarea, '应当有输入框')
  assert.strictEqual(textarea.disabled, false, '有当前会话时输入框应可用（侧栏直接问）')
  assert.ok(String(textarea.placeholder).includes('直接问'), `占位符应提示直接问，实际：${JSON.stringify(textarea.placeholder)}`)

  // 浮层：没有选区时不渲染任何东西
  const popoverNodes = Array.from(window.document.body.children).filter((node) => node.getAttribute && node.getAttribute('data-ask-aside') === 'popover')
  assert.strictEqual(popoverNodes.length, 0, '未选中文字时不应挂浮层')

  /* ---- 场景二：宿主连会话 id 都没给 → 不能乱发 ---- */
  const containerMissing = window.document.createElement('div')
  window.document.body.appendChild(containerMissing)
  const rootMissing = ReactDOMClient.createRoot(containerMissing)
  rootMissing.render(React.createElement(Panel, {}))
  await settle(120)
  const textareaMissing = containerMissing.querySelector('textarea')
  assert.ok(textareaMissing, '应当有输入框')
  assert.strictEqual(textareaMissing.disabled, true, '连会话 id 都没有时输入框应当禁用')
  rootMissing.unmount()

  /* ---- 场景三：这个主对话以前问过 → 重新挂面板应当认回同一条旁支 ---- */
  stubMap({ 'session-1': { side: 'session-side-1', strategy: 'inherit', at: Date.now() } })
  const container2 = window.document.createElement('div')
  window.document.body.appendChild(container2)
  const root2 = ReactDOMClient.createRoot(container2)
  root2.render(React.createElement(Panel, { sessionId: 'session-1' }))
  await settle(220)

  const text2 = container2.textContent || ''
  assert.ok(text2.includes('承接上下文'), `应当认回已有旁支并显示「承接上下文」，实际：${JSON.stringify(text2.slice(0, 160))}`)
  const textarea2 = container2.querySelector('textarea')
  assert.ok(textarea2, '应当有输入框')
  assert.strictEqual(textarea2.disabled, false, '已有旁支时应当可以直接接着问')
  const hideTag = window.document.getElementById('daa-hide')
  assert.ok(hideTag, '应当注入隐藏侧线会话的样式')
  assert.ok(hideTag.textContent.includes('[data-row-key="session:session-side-1"]'), `应当隐藏侧线会话行，实际：${JSON.stringify(hideTag.textContent)}`)

  root2.unmount()

  /* ---- 场景四：附件入口 + 上传契约（图片走 uploadImage，文件走 upload） ---- */
  const container3 = window.document.createElement('div')
  window.document.body.appendChild(container3)
  const root3 = ReactDOMClient.createRoot(container3)
  root3.render(React.createElement(Panel, { sessionId: 'session-1' }))
  await settle(200)
  const clip = container3.querySelector('.daa-clip')
  assert.ok(clip, '应当有添加附件的按钮')
  assert.strictEqual(clip.disabled, false, '有当前会话时应当可以加附件')
  assert.ok(container3.querySelector('input.daa-fileinput'), '应当有隐藏的 file input')
  assert.ok((container3.textContent || '').includes('图片 / 文件'), '应当提示支持图片与文件')
  root3.unmount()

  const calls = []
  // Node 的 URL.createObjectURL 不认 jsdom 的 File，测试里给个替身（生产环境是浏览器原生）。
  const createdUrls = []
  URL.createObjectURL = (blob) => { createdUrls.push(blob); return `blob:test/${createdUrls.length}` }
  URL.revokeObjectURL = () => {}
  const uploadCtx = {
    get: (name) => (name === 'fileUpload' ? {
      upload: async (sessionId, blob, name) => { calls.push(['upload', sessionId, blob.name, name]); return { ok: true, value: { receiptId: `r-file-${calls.length}` } } },
      uploadImage: async (sessionId, blob, mediaType, name) => { calls.push(['uploadImage', sessionId, blob.name, mediaType, name]); return { ok: true, value: { receiptId: `r-image-${calls.length}` } } }
    } : undefined)
  }
  const png = new window.File([Buffer.from('89504e47', 'hex')], 'shot.png', { type: 'image/png' })
  const pdf = new window.File([Buffer.from('25504446', 'hex')], 'paper.pdf', { type: 'application/pdf' })
  const parts = await bundle.__test__.uploadAttachments(uploadCtx, 'session-side-1', [
    bundle.__test__.attachmentChipFrom(png),
    bundle.__test__.attachmentChipFrom(pdf)
  ])
  assert.deepStrictEqual(calls.map((call) => call[0]), ['uploadImage', 'upload'], `图片应走 uploadImage、文件走 upload，实际：${JSON.stringify(calls)}`)
  assert.deepStrictEqual(parts, [
    { type: 'file', receiptId: 'r-image-1' },
    { type: 'file', receiptId: 'r-file-2' }
  ], `附件应当变成 prompt 的 file 内容块，实际：${JSON.stringify(parts)}`)

  const noService = await bundle.__test__.uploadAttachments({ get: () => undefined }, 'session-1', [bundle.__test__.attachmentChipFrom(pdf)])
    .then(() => null, (error) => error)
  assert.ok(noService instanceof Error, '没有 fileUpload 服务时应当抛错')
  assert.ok(noService.message.includes('fileUpload'), `错误信息应点明 fileUpload，实际：${JSON.stringify(noService.message)}`)

  console.log('RENDER TEST OK — 面板挂载、空态、侧栏直接问、浮层静默、旁支复用、附件入口与上传契约 全部通过')

  root.unmount()
  dom.window.close()
}

main().catch((error) => {
  console.error('RENDER TEST FAILED')
  console.error(error)
  process.exit(1)
})