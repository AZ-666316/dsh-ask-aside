/**
 * dsh-ask-aside 冒烟测试（不依赖浏览器、不依赖 DSH）。
 *
 *   node smoke-test.cjs
 *
 * 覆盖：
 *   1. bundle 能被 loader 加载，导出 apply / inject
 *   2. apply 在服务就绪时注册「问答」tab，并挂上划词浮层
 *   3. 会话日志折叠：fork 种子史被 session/end-seed 挡住、用户/助手消息成行、
 *      失败尝试带出原因、turn/end 收尾
 *   4. 首问拼装包含引文
 *   5. store 的 patch / reset 语义
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert')

/* ---------------- 最小 DOM / React 替身 ---------------- */

function createElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    attributes: {},
    style: {},
    setAttribute(name, value) { this.attributes[name] = String(value) },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null },
    removeAttribute(name) { delete this.attributes[name] },
    appendChild(child) { this.children.push(child); child.parentNode = this; return child },
    removeChild(child) { this.children = this.children.filter(item => item !== child) },
    querySelector() { return null },
    closest() { return null },
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } },
    get parentNode() { return this.__parent || null },
    set parentNode(value) { this.__parent = value }
  }
  return el
}

const head = createElement('head')
const body = createElement('body')
const document = {
  head,
  body,
  createElement,
  getElementById: () => null,
  addEventListener() {},
  removeEventListener() {},
  querySelector: () => null,
  querySelectorAll: () => []
}

const roots = []
const React = {
  createElement(type, props, ...children) {
    return { type, props: Object.assign({}, props, children.length === 0 ? {} : { children }) }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
  useRef(value) { return { current: value } },
  useSyncExternalStore(subscribe, getSnapshot) {
    if (typeof subscribe === 'function') subscribe(() => {})
    return getSnapshot()
  }
}

const loaded = []
const sandbox = {
  window: {
    __ModuleLoader__: { load(definition) { loaded.push(definition) } },
    innerHeight: 900,
    innerWidth: 1440,
    addEventListener() {},
    removeEventListener() {},
    getSelection() { return null }
  },
  document,
  console,
  setTimeout,
  clearTimeout,
  AbortController,
  Uint8Array,
  Array,
  Object,
  Math,
  Number,
  String,
  Boolean,
  JSON,
  Promise,
  Error,
  Date,
  Map,
  Set,
  Symbol
}
sandbox.globalThis = sandbox
sandbox.crypto = { getRandomValues: (array) => { for (let i = 0; i < array.length; i += 1) array[i] = (i * 37 + 11) % 256; return array } }
sandbox.window.document = document
sandbox.window.crypto = sandbox.crypto

const source = fs.readFileSync(path.join(__dirname, 'lib', 'client.js'), 'utf8')
vm.runInNewContext(source, sandbox, { filename: 'lib/client.js' })

assert.strictEqual(loaded.length, 1, '应当只注册一个模块定义')
const definition = loaded[0]
assert.strictEqual(definition.id, 'dsh-ask-aside')

const exportsObject = definition.factory((name) => {
  if (name === 'react') return React
  if (name === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) }
  throw new Error(`意外的 require：${name}`)
})

assert.strictEqual(typeof exportsObject.apply, 'function')
assert.deepStrictEqual(Array.from(exportsObject.inject), ['sessions', 'remote', 'remote.session', 'workspaces'])
const test = exportsObject.__test__
assert.ok(test && typeof test.foldSessionEvent === 'function')

/* ---------------- apply：注册 tab ---------------- */

const registeredTabs = []
const registeredSlots = []
const services = {
  sidebarRightTabs: { register: (tab) => { registeredTabs.push(tab); return () => {} } },
  sidebarRight: { openTab() {}, openTabIn() {} },
  slots: {
    register(definition) { registeredSlots.push(definition); return definition },
    inject(name, run) { run(); return () => {} }
  }
}
const ctx = {
  get: (name) => (name === 'sidebarRightTabs' ? services.sidebarRightTabs
    : name === 'sidebarRight' ? services.sidebarRight
      : name === 'slots' ? services.slots
        : name === 'sessions' ? { list: { getSnapshot: () => ({ byId: {}, ids: [] }) } }
          : undefined),
  effect: (run) => { run() },
  remote: { session: {} },
  sessions: { list: { getSnapshot: () => ({ byId: {}, ids: [] }) } },
  workspaces: { list: { getSnapshot: () => ({ items: [] }) } }
}
exportsObject.apply(ctx)

assert.strictEqual(registeredTabs.length, 1, '应当注册一个 tab 类型')
assert.strictEqual(registeredTabs[0].kind, 'ask-aside')
assert.strictEqual(registeredTabs[0].title(), '问答')
assert.strictEqual(registeredSlots.length, 2, '应当注册一个面板 + 一个主输入框入口')
assert.strictEqual(registeredSlots[0].name, 'sidebar.right.pane.tab')
assert.strictEqual(registeredSlots[0].key, 'dsh-ask-aside:ask')
assert.strictEqual(registeredSlots[1].name, 'conversation.input.left')
assert.strictEqual(registeredSlots[1].id, 'ask-aside.entry')
assert.strictEqual(typeof registeredSlots[0], 'object')

/* ---------------- 日志折叠 ---------------- */

function ev(type, seq, data) { return { type, seq, data } }

{
  const view = test.emptyView()
  // fork 种子史：没有 end-seed 之前一律不该进面板
  view.endSeedSeq = -1
  test.foldSessionEvent(view, ev('session/end-seed', 40, {}))
  test.foldSessionEvent(view, ev('user/message', 20, { content: [{ type: 'text', text: '种子里的话' }] }))
  test.foldSessionEvent(view, ev('user/message', 41, { source: { kind: 'user' }, content: [{ type: 'text', text: '什么是 SBRT？' }] }))
  test.foldSessionEvent(view, ev('assistant/message', 42, { content: [{ type: 'text', text: '立体定向放疗。' }] }))
  test.foldSessionEvent(view, ev('user/message', 43, { source: { kind: 'plugin' }, content: [{ type: 'text', text: '注入的运行时上下文' }] }))
  assert.deepStrictEqual(Array.from(view.rows, r => r.role), ['user', 'assistant'])
  assert.strictEqual(view.rows[0].text, '什么是 SBRT？')
  assert.strictEqual(view.rows[1].text, '立体定向放疗。')
}

{
  const view = test.emptyView()
  view.endSeedSeq = 10
  const changed = test.foldSessionEvent(view, ev('assistant/attempt', 12, {
    stream: [{ type: 'chunk', chunk: { type: 'text-delta', text: '半句' } },
      { type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error', failure: { message: 'upstream 502' } } } }]
  }))
  assert.strictEqual(changed, true)
  assert.strictEqual(view.rows.length, 1)
  assert.strictEqual(view.rows[0].failure, 'upstream 502')
}

{
  const view = test.emptyView()
  view.live = { text: '正在打字' }
  assert.strictEqual(test.foldSessionEvent(view, ev('turn/end', 9, {})), true)
  assert.strictEqual(view.live, null)
}

/* ---------------- 首问拼装 ---------------- */

{
  const text = test.composeFirstMessage({ text: '肾动脉交感神经消融', role: 'assistant' }, '这里指的是什么？')
  assert.ok(text.includes('> 肾动脉交感神经消融'), '应带引用块')
  assert.ok(text.includes('这里指的是什么？'), '应带问题')
  assert.ok(text.includes('原文'))
}

/* ---------------- store ---------------- */

{
  const store = test.createStore()
  store.beginAsk('session-a', { text: '引文', role: 'assistant' })
  assert.strictEqual(store.get().parentSessionId, 'session-a')
  assert.strictEqual(store.get().sideSessionId, null)
  assert.strictEqual(store.get().strategy, 'inherit')
  store.patch({ strategy: 'quote' })
  store.patch({ sideSessionId: 'session-b', usedStrategy: 'quote' })
  assert.strictEqual(store.get().strategy, 'quote')
  // reset 保留策略偏好、清掉引文
  store.reset('session-c')
  assert.strictEqual(store.get().parentSessionId, 'session-c')
  assert.strictEqual(store.get().strategy, 'quote')
  assert.strictEqual(store.get().quote, null)
  // 值没变时不触发订阅（useSyncExternalStore 依赖引用稳定）
  let calls = 0
  store.subscribe(() => { calls += 1 })
  const snapshot = store.get()
  store.patch({ phase: 'idle' })
  assert.strictEqual(store.get(), snapshot, '无变化不应换引用')
  store.patch({ phase: 'error', error: 'x' })
  assert.strictEqual(calls, 1)
}

/* ---------------- 任务进度 ---------------- */

{
  assert.strictEqual(test.formatProgressDuration(12000), '12 秒')
  assert.strictEqual(test.formatProgressDuration(192000), '3 分 12 秒')
  assert.strictEqual(test.formatProgressDuration(3600000), '1 小时')
  assert.strictEqual(test.formatProgressDuration(3840000), '1 小时 4 分')

  const payload = {
    ok: true,
    tasks: [
      { id: 'session-other', task: '别的会话', status: 'running' },
      { id: 'session-1', task: '写代码', stages: ['调研', '实现', '验证'], current: 1, pct: 50, status: 'running', action: '正在编辑 lib/client.js' }
    ]
  }
  const picked = test.pickProgressTask(payload, 'session-1')
  assert.strictEqual(picked.task, '写代码')
  assert.strictEqual(picked.current, 1)
  assert.strictEqual(picked.pct, 50)
  assert.deepStrictEqual(Array.from(picked.stages), ['调研', '实现', '验证'])
  // 不是这个会话的就不显示（否则别的窗口的任务会串到这个面板）
  assert.strictEqual(test.pickProgressTask(payload, 'session-missing'), null)
  assert.strictEqual(test.pickProgressTask(payload, '').task, '别的会话')
  assert.strictEqual(test.pickProgressTask({ ok: false }, 'session-1'), null)
  // 宿主兜底路由：单条匿名 task 也认
  assert.strictEqual(test.pickProgressTask({ ok: true, task: { task: '匿名任务', status: 'blocked' } }, 'session-2').task, '匿名任务')
  // 签名相同 → 面板不重渲染
  assert.strictEqual(test.progressSignature(picked), test.progressSignature(test.pickProgressTask(payload, 'session-1')))
  assert.notStrictEqual(test.progressSignature(picked), test.progressSignature(null))
}

/* ---------------- markdown 渲染器 ---------------- */

{
  const nodes = test.renderMarkdown('# 标题\n\n**粗** 和 `code`\n\n- 一\n- 二\n\n```js\nconst a = 1\n```')
  assert.ok(nodes.length >= 4, `渲染块数过少：${nodes.length}`)
}

console.log('SMOKE TEST OK — tab 注册 / 日志折叠 / 首问拼装 / store / markdown 全部通过')