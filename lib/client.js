/**
 * dsh-ask-aside — 浏览器端。
 *
 * 做一件事：**读正文时遇到不懂的词，选中 → 点「提问」→ 右侧栏里问**，
 * 回答发生在一条独立会话里，主对话一个字都不会被插入。
 *
 * 两条上下文路线（面板顶部可切）：
 *   - 继承上下文（默认）：`ctx.remote.session.fork({ sessionId })` 复制主会话，
 *     子会话带着完整历史前缀出发 —— 回答最准，并且命中前缀缓存，token 更省。
 *   - 只看引文：`ctx.remote.session.create(...)` 新建空会话，只把引文+问题发过去 ——
 *     最省 token，适合"这个词是什么意思"这类自足问题。
 *
 * 流式：`ctx.remote.session.follow({ ..., assistantStream: true })`。
 * DSH 0.2.x 起日志里不再写 `assistant/chunk`，不开 assistantStream 就只能等整轮
 * 结束才看得到字。
 *
 * 平台约束（踩过的坑）：
 *   - `inject` 里只放确定存在的服务（sessions / remote / workspaces）。右侧栏的
 *     `sidebarRightTabs` / `sidebarRight` / `slots` 一律用 `ctx.get()` 探测：
 *     cordis 没有可选依赖，注入一个不存在的服务会让 fiber 挂起，整个 web 白屏。
 *   - `requestId` 用 `crypto.getRandomValues` 自己拼 UUID —— `crypto.randomUUID`
 *     需要安全上下文，而 DSH 常常跑在明文 http 的局域网地址上。
 */
window.__ModuleLoader__.load({
  id: 'dsh-ask-aside',
  factory(require) {
    'use strict'

    const React = require('react')
    const ReactDomClient = require('react-dom/client')
    const h = React.createElement

    const TAB_ID = 'dsh-ask-aside:ask'
    const TAB_KIND = 'ask-aside'
    const TAB_ORDER = 92
    /** 选区超过这个长度不予处理：那不是"一个词"，更像整段复制。 */
    const MAX_SELECTION_CHARS = 2000
    /** follow 打开时回看多少条历史（够覆盖一次问答往返即可）。 */
    const FOLLOW_MAX_MESSAGES = 60
    const POPOVER_GAP = 8
    /** 主对话 → 侧线会话的映射存放在宿主侧（见 index.js），重启后仍认得出。 */
    const MAP_ROUTE = '/dsh-ask-aside/api/map'
    /** 任务进度：优先读 dsh-progress-widget 的接口（字段最全），没装就读宿主那条兜底路由。 */
    const PROGRESS_ROUTE = '/dsh-progress/status'
    /** 与本插件同作者的「进度」tab 插件：多任务文件口，装了就也能读到。 */
    const PROGRESS_TAB_ROUTE = '/dsh-progress-tab/api/status'
    const PROGRESS_HOST_ROUTE = '/dsh-ask-aside/api/progress'
    const PROGRESS_POLL_MS = 1500
    /** 任务结束后进度带在面板上留多久（能看见"✅ 已结束"，又不长期占地方）。 */
    const PROGRESS_DONE_HOLD_MS = 6000
    const HIDE_STYLE_ID = 'daa-hide'
    /** 宿主自带的「引用文本」按钮文案；浮层要贴着它排，避免两个按钮叠在一起。 */
    const HOST_QUOTE_LABEL = '引用文本'

    /* ------------------------------------------------------------------ */
    /* 一、纯工具                                                          */
    /* ------------------------------------------------------------------ */

    function mintRequestId() {
      const bytes = new Uint8Array(16)
      globalThis.crypto.getRandomValues(bytes)
      bytes[6] = (bytes[6] & 0x0f) | 0x40
      bytes[8] = (bytes[8] & 0x3f) | 0x80
      const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    }

    function unwrapRemote(result, what) {
      if (!result || result.ok !== true) {
        const error = result && result.error
        const text = error && typeof error.code === 'string'
          ? `${error.code}: ${error.message}`
          : 'unknown error'
        throw new Error(`${what} 失败：${text}`)
      }
      return result.value
    }

    function textOfContent(content) {
      if (!Array.isArray(content)) return ''
      const parts = []
      for (const block of content) {
        if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text)
        }
      }
      return parts.join('\n')
    }

    function textOfStreamChunk(chunk) {
      if (!chunk || typeof chunk !== 'object') return ''
      return chunk.type === 'text-delta' && typeof chunk.text === 'string' ? chunk.text : ''
    }

    function failureOfStreamChunk(chunk) {
      if (!chunk || typeof chunk !== 'object' || chunk.type !== 'finish') return undefined
      const reason = chunk.reason
      if (!reason || typeof reason !== 'object') return undefined
      if (reason.kind !== 'error' && reason.kind !== 'aborted') return undefined
      const failure = reason.failure
      if (failure && typeof failure === 'object') {
        if (typeof failure.message === 'string' && failure.message !== '') return failure.message
        if (typeof failure.code === 'string' && failure.code !== '') return failure.code
      }
      return String(reason.kind)
    }

    /**
     * 屏幕上这个会话的 id。
     * `sessions.list` 的 { byId } 里，`retainedBy.mainView > 0` 的那一行就是主视图
     * 正在渲染的会话（多个时取最近更新的）。
     */
    function resolveCurrentSessionId(list) {
      if (list === undefined || list === null) return undefined
      const rows = list.byId || {}
      const order = list.ids || Object.keys(rows)
      const rank = new Map(order.map((id, index) => [id, index]))
      let best
      for (const [key, row] of Object.entries(rows)) {
        if (!row || (row.retainedBy && row.retainedBy.mainView ? row.retainedBy.mainView : 0) <= 0) continue
        const id = row.id === undefined || row.id === '' ? key : row.id
        const candidate = {
          id,
          updatedAt: row.updatedAt === undefined ? Number.NEGATIVE_INFINITY : row.updatedAt,
          rank: rank.has(id) ? rank.get(id) : Number.POSITIVE_INFINITY
        }
        if (best === undefined || candidate.updatedAt > best.updatedAt
          || (candidate.updatedAt === best.updatedAt && candidate.rank < best.rank)) best = candidate
      }
      return best === undefined ? undefined : best.id
    }

    function currentSessionIdOf(ctx) {
      try {
        const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
        return resolveCurrentSessionId(sessions && sessions.list && sessions.list.getSnapshot())
      } catch (error) {
        return undefined
      }
    }

    function workspaceIdOf(ctx, sessionId) {
      try {
        const workspaces = ctx.workspaces
        const items = workspaces && workspaces.list && workspaces.list.getSnapshot().items
        if (!Array.isArray(items)) return undefined
        for (const workspace of items) {
          if (!workspace || !Array.isArray(workspace.sessionIds)) continue
          if (workspace.sessionIds.indexOf(sessionId) !== -1) return workspace.workspaceId
        }
      } catch (error) {
        // 落回 cwd
      }
      return undefined
    }

    function cwdOf(ctx, sessionId) {
      try {
        const sessions = ctx.sessions
        const byId = sessions && sessions.list && sessions.list.getSnapshot().byId
        return byId && byId[sessionId] ? byId[sessionId].cwd : undefined
      } catch (error) {
        return undefined
      }
    }

    /* ------------------------------------------------------------------ */
    /* 二、会话日志折叠（把事件流变成可渲染的行）                           */
    /* ------------------------------------------------------------------ */

    function isVisible(event, view) {
      const seq = typeof event.seq === 'number' ? event.seq : 0
      return seq > view.endSeedSeq
    }

    /**
     * 把一条会话事件折进 view。
     *
     * fork 子会话的日志是 `[种子史…, session/end-seed, 自己的消息…]`，只有
     * end-seed 之后的部分属于这次追问；嵌套 fork 会有多个标记，取最后一个。
     */
    function foldSessionEvent(view, event) {
      if (!event || typeof event !== 'object' || typeof event.type !== 'string') return false
      const seq = typeof event.seq === 'number' ? event.seq : 0
      if (event.type === 'session/end-seed') {
        view.endSeedSeq = Math.max(view.endSeedSeq, seq)
        return false
      }
      if (!isVisible(event, view)) return false
      const data = event.data || {}
      if (event.type === 'user/message') {
        const sourceKind = data.source && data.source.kind
        // 插件注入的上下文（runtime-context、技能目录）也走 user/message，但不该出现在面板里。
        if (sourceKind !== undefined && sourceKind !== 'user') return false
        const text = textOfContent(data.content)
        if (text !== '') view.rows.push({ role: 'user', text })
        return true
      }
      if (event.type === 'assistant/message') {
        const text = textOfContent(data.content)
        if (text !== '') {
          view.rows.push({ role: 'assistant', text })
          view.live = null
        }
        return true
      }
      if (event.type === 'assistant/attempt') {
        // 失败/中断的尝试只有 attempt，没有 message；成功的那次由 message 承担。
        const folded = foldStreamRecords(data.stream)
        if (folded.failure !== undefined) {
          view.rows.push({ role: 'assistant', text: folded.text, failure: folded.failure })
          view.live = null
          return true
        }
        return false
      }
      if (event.type === 'turn/end') {
        view.live = null
        view.turnEnded = true
        return true
      }
      return false
    }

    function foldStreamRecords(records) {
      if (!Array.isArray(records)) return { text: '' }
      let text = ''
      let failure
      for (const record of records) {
        if (!record || typeof record !== 'object') continue
        if (record.type === 'text-chunks' && Array.isArray(record.texts)) {
          for (const part of record.texts) if (typeof part === 'string') text += part
        } else if (record.type === 'chunk') {
          text += textOfStreamChunk(record.chunk)
          if (failure === undefined) failure = failureOfStreamChunk(record.chunk)
        }
      }
      return failure === undefined ? { text } : { text, failure }
    }

    function emptyView() {
      return { rows: [], live: null, endSeedSeq: -1, turnEnded: false }
    }

    /* ------------------------------------------------------------------ */
    /* 三、状态                                                            */
    /* ------------------------------------------------------------------ */

    function createStore() {
      let state = {
        parentSessionId: '',
        sideSessionId: null,
        strategy: 'inherit',
        usedStrategy: null,
        quote: null,
        rows: [],
        live: null,
        phase: 'idle',
        notice: null,
        error: null
      }
      const listeners = new Set()
      return {
        get() { return state },
        subscribe(callback) {
          listeners.add(callback)
          return () => { listeners.delete(callback) }
        },
        patch(next) {
          const merged = Object.assign({}, state, next)
          let changed = false
          for (const key of Object.keys(merged)) if (!Object.is(merged[key], state[key])) { changed = true; break }
          if (!changed) return
          state = merged
          for (const listener of listeners) { try { listener() } catch (error) { console.warn('[dsh-ask-aside] listener 失败：', error) } }
        },
        beginAsk(parentSessionId, quote) {
          state = {
            parentSessionId,
            sideSessionId: null,
            strategy: state.strategy,
            usedStrategy: null,
            quote,
            rows: [],
            live: null,
            phase: 'idle',
            notice: null,
            error: null
          }
          for (const listener of listeners) { try { listener() } catch (error) { /* noop */ } }
        },
        reset(parentSessionId) {
          state = {
            parentSessionId,
            sideSessionId: null,
            strategy: state.strategy,
            usedStrategy: null,
            quote: null,
            rows: [],
            live: null,
            phase: 'idle',
            notice: null,
            error: null
          }
          for (const listener of listeners) { try { listener() } catch (error) { /* noop */ } }
        }
      }
    }

    const store = createStore()

    /* ------------------------------------------------------------------ */
    /* 四、样式                                                            */
    /* ------------------------------------------------------------------ */

    const CSS = `
.daa-pop{position:fixed;z-index:2147483000;display:flex;gap:6px;transform:translate(-50%,0);pointer-events:auto}
.daa-btn{corner-shape:round;background:var(--dsw-alias-button-floating-fill,rgba(40,40,44,.86));--dsw-elevation-stroke-color:var(--dsw-alias-border-l3,rgba(255,255,255,.12));box-shadow:var(--dsw-elevation-panel,0 6px 20px rgba(0,0,0,.35));color:var(--dsw-alias-label-primary,#f2f2f2);font:var(--dsw-font-xs-13,13px/18px ui-sans-serif,system-ui,sans-serif);cursor:pointer;border:none;border-radius:999px;padding:5px 10px;line-height:18px;transition:background .15s ease}
.daa-btn:hover{background:var(--dsw-alias-button-floating-hover,rgba(56,56,62,.92))}
.daa-btn:active{transform:translateY(.5px)}
.daa-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4b7dff);outline-offset:2px}

/* 老版 dsh-study-ask 也在选区上方挂了一个「提问」按钮，跟我们重复了。
   用户只要一个，并且以它原来的位置为准（我们照它的位置摆），所以把它的藏掉；
   点开还是走本插件的右侧问答面板。它自己的「提问对话」标签不受影响。 */
.dsa-pop{display:none!important}

.daa-root{display:flex;flex-direction:column;height:100%;min-height:0;width:100%;min-width:0;box-sizing:border-box;font:var(--dsw-font-xs-13,13px/20px ui-sans-serif,system-ui,sans-serif);color:var(--dsw-alias-label-primary,#e8e8e8);background:transparent}
.daa-head{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-secondary,rgba(255,255,255,.08));flex:none}
.daa-title{font-weight:600;font-size:13px}
.daa-badge{font-size:11px;line-height:16px;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-secondary,rgba(255,255,255,.14));color:var(--dsw-alias-label-secondary,#9a9a9a);white-space:nowrap}
.daa-grow{flex:1}
.daa-link{background:none;border:none;color:var(--dsw-alias-label-secondary,#8f8f8f);font:inherit;font-size:12px;cursor:pointer;padding:2px 6px;border-radius:6px}
.daa-link:hover{color:var(--dsw-alias-label-primary,#fff);background:var(--dsw-alias-fill-secondary,rgba(255,255,255,.06))}
.daa-link:disabled{opacity:.45;cursor:default}

.daa-quote{margin:10px 12px 0;padding:8px 10px;border-left:3px solid var(--dsw-alias-brand-primary,#4b7dff);background:var(--dsw-alias-fill-secondary,rgba(255,255,255,.04));border-radius:6px;color:var(--dsw-alias-label-secondary,#b4b4b4);font-size:12px;line-height:1.6;max-height:132px;overflow:auto;white-space:pre-wrap;word-break:break-word;flex:none}
.daa-quote-role{font-size:11px;opacity:.7;margin-bottom:2px}

.daa-modes{display:flex;gap:6px;padding:10px 12px 0;flex:none;flex-wrap:wrap}
.daa-chip{border:1px solid var(--dsw-alias-border-secondary,rgba(255,255,255,.14));background:transparent;color:var(--dsw-alias-label-secondary,#9a9a9a);border-radius:999px;padding:3px 10px;font:inherit;font-size:12px;cursor:pointer}
.daa-chip:hover{color:var(--dsw-alias-label-primary,#fff)}
.daa-chip-on{border-color:var(--dsw-alias-brand-primary,#4b7dff);color:var(--dsw-alias-label-primary,#fff);background:rgba(75,125,255,.14)}

.daa-scroll{flex:1;min-height:0;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:12px}
.daa-hint{color:var(--dsw-alias-label-secondary,#8f8f8f);font-size:12px;line-height:1.8;padding:14px 12px}
.daa-hint b{color:var(--dsw-alias-label-primary,#e8e8e8);font-weight:600}
.daa-row{display:flex;flex-direction:column;gap:3px}
.daa-role{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#8f8f8f)}
.daa-me .daa-role{color:var(--dsw-alias-brand-primary,#6b9eff)}
.daa-body{white-space:pre-wrap;word-break:break-word}
.daa-p{margin:0 0 6px}
.daa-p:last-child{margin-bottom:0}
.daa-h{margin:8px 0 4px;font-weight:600}
.daa-ul{margin:0 0 6px;padding-left:18px}
.daa-pre{margin:6px 0;padding:8px 10px;border-radius:6px;background:var(--dsw-alias-fill-secondary,rgba(0,0,0,.35));overflow:auto;font-size:12px;line-height:1.5;white-space:pre}
.daa-code-inline{background:var(--dsw-alias-fill-secondary,rgba(255,255,255,.08));border-radius:4px;padding:0 4px;font-size:12px}
.daa-fail{color:#ef4444;font-size:12px;margin-top:2px}
.daa-sending{color:var(--dsw-alias-label-secondary,#8f8f8f);font-size:12px}
.daa-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:currentColor;margin-right:6px;animation:daa-pulse 1.1s ease-in-out infinite}
@keyframes daa-pulse{0%,100%{opacity:.25}50%{opacity:1}}

.daa-composer{display:flex;flex-direction:column;gap:8px;width:100%;min-width:0;box-sizing:border-box;padding:10px 12px;border-top:1px solid var(--dsw-alias-border-secondary,rgba(255,255,255,.08));flex:none}
.daa-box{display:flex;flex-direction:column;gap:4px;width:100%;min-width:0;box-sizing:border-box;padding:8px 10px 6px;border-radius:14px;border:1px solid var(--dsw-alias-border-secondary,rgba(255,255,255,.14));background:var(--dsw-alias-fill-secondary,rgba(255,255,255,.04));transition:border-color .12s}
.daa-box:focus-within{border-color:var(--dsw-alias-border-primary,rgba(255,255,255,.26))}
.daa-input{width:100%;min-width:0;box-sizing:border-box;resize:none;min-height:22px;max-height:120px;padding:2px 2px 0;border:none;background:transparent;color:inherit;font:inherit;outline:none}
.daa-boxrow{display:flex;align-items:center;justify-content:space-between;gap:8px}
.daa-send{width:28px;height:28px;flex:none;display:flex;align-items:center;justify-content:center;border:none;border-radius:999px;background:var(--dsw-alias-brand-primary,#4b7dff);color:#fff;font-size:15px;line-height:1;cursor:pointer;padding:0 0 1px;transition:filter .12s,background .12s}
.daa-send:hover:enabled{filter:brightness(1.08)}
.daa-send:disabled{background:var(--dsw-alias-fill-tertiary,rgba(255,255,255,.1));color:var(--dsw-alias-label-tertiary,#6f6f6f);cursor:default;filter:none}
.daa-files{display:flex;flex-wrap:wrap;gap:6px;width:100%;min-width:0;max-width:100%}
.daa-file{display:flex;align-items:center;gap:6px;min-width:0;max-width:100%;padding:4px 6px;border-radius:8px;background:var(--dsw-alias-fill-secondary,rgba(255,255,255,.06));border:1px solid var(--dsw-alias-border-secondary,rgba(255,255,255,.1))}
.daa-file-img{width:26px;height:26px;max-width:26px;max-height:26px;border-radius:6px;object-fit:cover;flex:0 0 26px}
.daa-file-ext{display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:6px;flex:none;font-size:9px;letter-spacing:.04em;background:var(--dsw-alias-fill-tertiary,rgba(255,255,255,.1));color:var(--dsw-alias-label-secondary,#9a9a9a)}
.daa-file-name{max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-secondary,#b0b0b0)}
.daa-file-x{border:none;background:transparent;color:var(--dsw-alias-label-secondary,#9a9a9a);cursor:pointer;font-size:14px;line-height:1;padding:0 2px;flex:none}
.daa-file-x:hover{color:var(--dsw-alias-label-primary,#e8e8e8)}
input.daa-fileinput,.daa-fileinput{display:none!important}
.daa-clip{width:26px;height:26px;flex:none;display:flex;align-items:center;justify-content:center;border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,#9a9a9a);font-size:17px;line-height:1;cursor:pointer;padding:0 0 1px;transition:color .12s,background .12s}
.daa-clip:hover:enabled{color:var(--dsw-alias-label-primary,#e8e8e8);background:var(--dsw-alias-fill-tertiary,rgba(255,255,255,.08))}
.daa-clip:disabled{opacity:.35;cursor:default}
.daa-entry{width:22px;height:22px;flex:none;display:inline-flex;align-items:center;justify-content:center;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#9a9a9a);cursor:pointer;padding:0;transition:color .12s,background .12s}
.daa-entry:hover{color:var(--dsw-alias-label-primary,#e8e8e8);background:var(--dsw-alias-fill-tertiary,rgba(255,255,255,.08))}
.daa-root-drop{box-shadow:inset 0 0 0 2px var(--dsw-alias-brand-primary,#4b7dff)}
.daa-err{padding:0 12px 8px;color:#ef4444;font-size:12px}

/* 面板顶部那条任务进度带：主对话在跑长任务时，不用去主对话里翻，这里就能看见"到哪一步了"。
   数据来自 agent 上报的 $DSH_HOME/dsh-progress.json（宿主路由）或进度插件，没有任务时整条不渲染。 */
.daa-prog{flex:none;margin:8px 12px 0;border:1px solid var(--dsw-alias-border-secondary,rgba(255,255,255,.08));background:var(--dsw-alias-fill-secondary,rgba(255,255,255,.04));border-radius:10px;padding:7px 10px 8px;font-size:12px;line-height:18px;cursor:pointer;user-select:none;transition:border-color .15s ease,background .15s ease}
.daa-prog:hover{background:var(--dsw-alias-fill-tertiary,rgba(255,255,255,.07))}
.daa-prog-row{display:flex;align-items:center;gap:6px;min-width:0}
.daa-prog-dot{width:7px;height:7px;border-radius:50%;flex:none;background:#4b7dff}
.daa-prog-run .daa-prog-dot{animation:daa-pulse 1.1s ease-in-out infinite}
.daa-prog-task{font-weight:600;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.daa-prog-label{flex:none;max-width:44%;font-size:11px;color:var(--dsw-alias-label-secondary,#9a9a9a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.daa-prog-time{flex:none;color:var(--dsw-alias-label-tertiary,#7a7a7a);font-variant-numeric:tabular-nums;font-size:11px}
.daa-prog-bar{display:block;height:3px;margin-top:7px;border-radius:999px;background:rgba(255,255,255,.12);overflow:hidden}
.daa-prog-bar i{display:block;height:100%;border-radius:999px;background:currentColor;transition:width .3s ease}
.daa-prog-sub{display:flex;align-items:center;gap:6px;margin-top:5px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#7a7a7a);min-width:0}
.daa-prog-sub-t{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.daa-prog-sub-e{flex:none;font-variant-numeric:tabular-nums}
.daa-prog-run .daa-prog-bar{color:var(--dsw-alias-brand-primary,#4b7dff)}
.daa-prog-warn{border-color:rgba(245,158,11,.45)}
.daa-prog-warn .daa-prog-dot{background:#f59e0b}
.daa-prog-warn .daa-prog-bar{color:#f59e0b}
.daa-prog-warn .daa-prog-label,.daa-prog-warn .daa-prog-sub{color:#f59e0b}
.daa-prog-bad{border-color:rgba(239,68,68,.45)}
.daa-prog-bad .daa-prog-dot{background:#ef4444}
.daa-prog-bad .daa-prog-bar{color:#ef4444}
.daa-prog-bad .daa-prog-label,.daa-prog-bad .daa-prog-sub{color:#ef4444}
.daa-prog-done{border-color:rgba(34,197,94,.4)}
.daa-prog-done .daa-prog-dot{background:#22c55e}
.daa-prog-done .daa-prog-bar{color:#22c55e}
.daa-prog-done .daa-prog-label,.daa-prog-done .daa-prog-sub{color:#22c55e}
.daa-prog-steps{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;padding-top:6px;border-top:1px dashed var(--dsw-alias-border-secondary,rgba(255,255,255,.1));cursor:default}
.daa-prog-step{font-size:11px;line-height:16px;padding:1px 8px;border-radius:999px;background:rgba(255,255,255,.06);color:var(--dsw-alias-label-secondary,#9a9a9a)}
.daa-prog-step-done{color:var(--dsw-alias-label-tertiary,#7a7a7a)}
.daa-prog-step-now{background:rgba(75,125,255,.18);color:var(--dsw-alias-label-primary,#e8e8e8)}
.daa-prog-act{flex-basis:100%;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#9a9a9a);margin-top:2px;word-break:break-word}
.daa-prog-empty{flex-basis:100%;font-size:11px;color:var(--dsw-alias-label-tertiary,#7a7a7a)}

/* 进度已经显示在面板顶部了，面板开着时把 dsh-progress-widget 的悬浮条收起来（同一件事不必占两处）。
   没装那个插件时这条规则什么也不做。 */
html[data-ask-aside-panel="1"] #dsh-progress-widget{display:none}

/* 视频皮肤插件（dsh-video-skin）的透明度圆钮是 position:fixed 贴屏幕右下角的，
   右栏一打开就被压在面板上，看着像面板里的按钮。这里只在「问答」面板挂载期间
   把它让到侧栏左边，不改第三方文件，面板关掉立刻回原位。 */
html[data-ask-aside-panel="1"] #dsvs-knobs-pill{right:calc(16px + var(--daa-sidebar-inset,0px));transition:opacity 220ms ease,transform 220ms ease,background 220ms ease,right 200ms ease}
html[data-ask-aside-panel="1"] #dsvs-knobs{right:calc(16px + var(--daa-sidebar-inset,0px))}

/* 上面那个圆钮自带的浏览器原生 title 提示框（慢、方、和主题不搭），换成自己的。 */
.daa-vtip{position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%) translateY(2px);z-index:2147483000;padding:5px 9px;border-radius:8px;background:var(--dsw-alias-button-floating-fill,rgba(30,30,34,.95));color:var(--dsw-alias-label-primary,#f2f2f2);font:var(--dsw-font-xs-13,12px/16px ui-sans-serif,system-ui,"Microsoft YaHei",sans-serif);white-space:nowrap;box-shadow:0 6px 20px rgba(0,0,0,.4),0 0 0 1px var(--dsw-alias-border-l3,rgba(255,255,255,.12));opacity:0;pointer-events:none;transition:opacity .14s ease,transform .14s ease}
#dsvs-knobs-pill:hover .daa-vtip,#dsvs-knobs-pill:focus-visible .daa-vtip{opacity:1;transform:translateX(-50%) translateY(0)}
`

    function ensureStyle() {
      // 插件是热重载的：新的 JS 会装进同一个页面，但上一版留下的 <style> 还在。
      // 早先这里看到标签就 return，结果一直是旧样式（输入框窄、大图按原尺寸撑开）。
      // 所以每次 apply 都把内容重写一遍。
      const existing = document.getElementById('daa-style')
      if (existing !== null) {
        if (existing.textContent !== CSS) existing.textContent = CSS
        return
      }
      const tag = document.createElement('style')
      tag.id = 'daa-style'
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /* ------------------------------------------------------------------ */
    /* 五、选区监听                                                        */
    /* ------------------------------------------------------------------ */

    const ROLE_OF_KIND = { user: 'user', assistant: 'agent', system: 'agent' }

    function roleOfKind(kind) {
      return ROLE_OF_KIND[kind] || 'agent'
    }

    function chatAnchorOf(node) {
      let element = node
      if (element && element.nodeType !== 1) element = element.parentElement
      if (!element || typeof element.closest !== 'function') return null
      return element.closest('[data-chat-anchor-key]')
    }

    function createSelectionController() {
      const listeners = new Set()
      let snapshot = { selection: null }
      let debounce = null
      let disposed = false

      function emit(selection) {
        if (disposed) return
        if (selection === null && snapshot.selection === null) return
        snapshot = { selection }
        for (const listener of listeners) { try { listener() } catch (error) { /* noop */ } }
      }

      function readSelection() {
        if (disposed) return null
        const selection = window.getSelection()
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
        const text = selection.toString().trim()
        if (text === '' || text.length > MAX_SELECTION_CHARS) return null
        const range = selection.getRangeAt(0)
        const startAnchor = chatAnchorOf(range.startContainer)
        const endAnchor = chatAnchorOf(range.endContainer)
        if (!startAnchor || startAnchor !== endAnchor) return null
        if (startAnchor.hasAttribute('data-streaming') || startAnchor.querySelector('[data-streaming]')) return null
        if (startAnchor.closest('[data-ask-aside]')) return null
        // 跨行选区：getBoundingClientRect 有时只给出首行，取所有行矩形求并集更稳。
        const rects = typeof range.getClientRects === 'function' ? Array.from(range.getClientRects()) : []
        const usable = rects.filter(item => item.width > 0 || item.height > 0)
        const box = usable.length > 0
          ? usable.reduce((acc, item) => ({
              left: Math.min(acc.left, item.left),
              top: Math.min(acc.top, item.top),
              right: Math.max(acc.right, item.right),
              bottom: Math.max(acc.bottom, item.bottom)
            }), { left: usable[0].left, top: usable[0].top, right: usable[0].right, bottom: usable[0].bottom })
          : range.getBoundingClientRect()
        if (!box || (box.right - box.left === 0 && box.bottom - box.top === 0)) return null
        const rect = {
          left: box.left,
          top: box.top,
          right: box.right,
          bottom: box.bottom,
          width: box.right - box.left,
          height: box.bottom - box.top
        }
        return {
          text,
          rect,
          role: roleOfKind(startAnchor.getAttribute('data-chat-flow-kind') || ''),
          messageId: startAnchor.getAttribute('data-chat-anchor-key') || ''
        }
      }

      function schedule() {
        if (debounce !== null) clearTimeout(debounce)
        debounce = setTimeout(() => {
          debounce = null
          emit(readSelection())
        }, 180)
      }

      const onSelectionChange = () => { schedule() }
      const onMouseUp = () => { setTimeout(() => { emit(readSelection()) }, 0) }
      const onKeyUp = (event) => { if (event.key === 'Escape') emit(null); else schedule() }
      const onScroll = () => { emit(null) }

      document.addEventListener('selectionchange', onSelectionChange)
      document.addEventListener('mouseup', onMouseUp)
      document.addEventListener('keyup', onKeyUp)
      window.addEventListener('scroll', onScroll, true)

      return {
        subscribe(callback) {
          listeners.add(callback)
          return () => { listeners.delete(callback) }
        },
        getSnapshot() { return snapshot },
        clear() { emit(null) },
        dispose() {
          disposed = true
          document.removeEventListener('selectionchange', onSelectionChange)
          document.removeEventListener('mouseup', onMouseUp)
          document.removeEventListener('keyup', onKeyUp)
          window.removeEventListener('scroll', onScroll, true)
          listeners.clear()
        }
      }
    }

    /* ------------------------------------------------------------------ */
    /* 六、发问流程                                                        */
    /* ------------------------------------------------------------------ */

    let stopFollow = null

    function stopFollowing() {
      const stop = stopFollow
      stopFollow = null
      if (typeof stop === 'function') { try { stop() } catch (error) { /* noop */ } }
    }

    function composeFirstMessage(quote, question) {
      const who = quote.role === 'user' ? '我' : '助手'
      const quoted = quote.text.split('\n').map(line => `> ${line}`).join('\n')
      return `${quoted}\n\n（以上是我从你之前的回答里选的${who}原文）\n\n${question}`
    }

    /** 同一条侧线的后续轮次：只带引文，不再解释「以上是引文」。 */
    function composeQuotedMessage(quote, question) {
      if (quote === null) return question
      const quoted = quote.text.split('\n').map(line => `> ${line}`).join('\n')
      return `${quoted}\n\n${question}`
    }

    /**
     * 「主对话 → 侧线」映射。宿主侧落盘，客户端只缓存一份。
     * 有它才做得到「一个主对话只留一条旁支」，并且重启后仍认回同一条。
     */
    let sideMap = {}

    function sideIdsOf(entry) {
      if (entry === null || typeof entry !== 'object') return []
      const ids = []
      if (typeof entry.side === 'string' && entry.side !== '') ids.push(entry.side)
      if (Array.isArray(entry.retired)) {
        for (const id of entry.retired) if (typeof id === 'string' && id !== '' && !ids.includes(id)) ids.push(id)
      }
      return ids
    }

    /** 把已有侧线从左侧会话列表里藏掉；只能靠 data-row-key，属尽力而为。 */
    function applyHideRules() {
      let tag = document.getElementById(HIDE_STYLE_ID)
      if (tag === null) {
        tag = document.createElement('style')
        tag.id = HIDE_STYLE_ID
        document.head.appendChild(tag)
      }
      const ids = []
      for (const key of Object.keys(sideMap)) {
        for (const id of sideIdsOf(sideMap[key])) if (!ids.includes(id)) ids.push(id)
      }
      tag.textContent = ids.map(id => `[data-row-key="session:${id}"]{display:none !important}`).join('\n')
    }

    async function refreshSideMap() {
      try {
        const response = await fetch(MAP_ROUTE, { method: 'GET', headers: { accept: 'application/json' } })
        if (response.ok) {
          const body = await response.json()
          if (body && body.ok === true && body.map && typeof body.map === 'object') sideMap = body.map
        }
      } catch (error) {
        // 宿主半没起来时静默降级：每次提问新建一条，不影响提问本身。
        console.warn('[dsh-ask-aside] 读取侧线映射失败：', error)
      }
      applyHideRules()
      return sideMap
    }

    async function saveSideMapping(parentSessionId, sideSessionId, strategy) {
      const previous = sideMap[parentSessionId]
      const retired = new Set(previous && Array.isArray(previous.retired) ? previous.retired : [])
      if (previous && previous.side !== sideSessionId) retired.add(previous.side)
      retired.delete(sideSessionId)
      sideMap[parentSessionId] = {
        side: sideSessionId,
        strategy: strategy === 'quote' ? 'quote' : 'inherit',
        at: Date.now(),
        ...(retired.size > 0 ? { retired: Array.from(retired) } : {})
      }
      applyHideRules()
      try {
        await fetch(MAP_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ parent: parentSessionId, side: sideSessionId, strategy })
        })
      } catch (error) {
        console.warn('[dsh-ask-aside] 写入侧线映射失败（本次仍可用）：', error)
      }
    }

    function knownSideSession(sessionId) {
      const entry = sideMap[sessionId]
      return entry !== undefined && typeof entry.side === 'string' && entry.side !== '' ? entry : null
    }

    function sessionAlive(ctx, sessionId) {
      try {
        const snapshot = ctx.sessions.list.getSnapshot()
        return !!(snapshot && snapshot.byId && snapshot.byId[sessionId])
      } catch (error) {
        return false
      }
    }

    /** 有旧侧线就沿用，没有才新建——这就是「一个主对话一条旁支」。 */
    async function ensureSideSession(ctx, parentSessionId, strategy) {
      const entry = knownSideSession(parentSessionId)
      if (entry !== null && sessionAlive(ctx, entry.side)) {
        return { sessionId: entry.side, strategy: entry.strategy, reused: true }
      }
      const created = await createSideSession(ctx, parentSessionId, strategy)
      await saveSideMapping(parentSessionId, created.sessionId, created.strategy)
      return { sessionId: created.sessionId, strategy: created.strategy, reused: false }
    }

    /** 侧线在左栏里看不见，给它一个能认出来的名字，方便在会话列表/归档里找回。 */
    async function renameSideSession(ctx, sessionId, quote) {
      const raw = quote && typeof quote.text === 'string' ? quote.text : ''
      const snippet = raw.replace(/\s+/g, ' ').trim().slice(0, 18)
      const title = snippet === '' ? '❓ 划词提问' : `❓ ${snippet}`
      try {
        unwrapRemote(await ctx.remote.session.rename({ sessionId, title }), 'rename session')
      } catch (error) {
        console.warn('[dsh-ask-aside] 侧线命名失败（不影响使用）：', error)
      }
    }

    async function createSideSession(ctx, parentSessionId, strategy) {
      if (strategy === 'inherit') {
        try {
          const forked = unwrapRemote(await ctx.remote.session.fork({ sessionId: parentSessionId }), 'fork')
          return { sessionId: forked.sessionId, strategy: 'inherit' }
        } catch (error) {
          // 父会话正在回答时 fork 不可用（fork-unavailable）：退化成只看引文，
          // 而不是让用户点了没反应。
          console.warn('[dsh-ask-aside] fork 失败，退化为「只看引文」：', error)
        }
      }
      const workspaceId = workspaceIdOf(ctx, parentSessionId)
      const cwd = workspaceId === undefined ? cwdOf(ctx, parentSessionId) : undefined
      const created = unwrapRemote(await ctx.remote.session.create(
        workspaceId !== undefined ? { workspaceId } : cwd !== undefined ? { cwd } : {}
      ), 'create session')
      return { sessionId: created.sessionId, strategy: 'quote' }
    }

    function startFollowing(ctx, sessionId) {
      stopFollowing()
      const controller = new AbortController()
      let cancelled = false
      const view = emptyView()

      const publish = (phase) => {
        if (cancelled) return
        const next = { rows: view.rows.slice(), live: view.live === null ? null : Object.assign({}, view.live) }
        if (phase !== undefined) next.phase = phase
        else if (store.get().phase === 'sending' && (view.rows.length > 0 || view.live !== null)) next.phase = 'streaming'
        store.patch(next)
      }

      const onSnapshot = (frame) => {
        const records = Array.isArray(frame.records) ? frame.records : []
        view.rows = []
        view.endSeedSeq = -1
        view.turnEnded = false
        for (const record of records) {
          const event = record && record.event ? record.event : record
          if (event && event.type === 'session/end-seed' && typeof event.seq === 'number') {
            view.endSeedSeq = Math.max(view.endSeedSeq, event.seq)
          }
        }
        // 回看窗口里没有 fork 边界，且还有更早的历史：不把种子史灌进面板
        // （宁可少显示，也不要把主对话整段倒出来）。
        const seedHidden = frame.hasMore === true && view.endSeedSeq < 0
        if (!seedHidden) {
          for (const record of records) {
            const event = record && record.event ? record.event : record
            foldSessionEvent(view, event)
          }
        }
        const baseline = frame.assistantStream
        if (baseline && baseline.activeAttempt) {
          const folded = foldStreamRecords(baseline.activeAttempt.stream)
          view.live = folded.failure === undefined ? { text: folded.text } : { text: folded.text, failure: folded.failure }
        }
        const phase = view.live !== null && view.live.text !== '' ? 'streaming' : undefined
        publish(phase)
      }

      const onEvent = (event) => {
        const changed = foldSessionEvent(view, event)
        if (!changed) return
        publish(event.type === 'turn/end' ? 'idle' : (view.live ? 'streaming' : undefined))
      }

      const onLive = (frame) => {
        if (!frame || typeof frame !== 'object') return
        if (frame.type === 'start') {
          view.live = { text: '' }
          publish('streaming')
          return
        }
        if (frame.type === 'chunk') {
          if (view.live === null) view.live = { text: '' }
          view.live.text += textOfStreamChunk(frame.chunk)
          const failure = failureOfStreamChunk(frame.chunk)
          if (failure !== undefined) view.live.failure = failure
          publish('streaming')
          return
        }
        if (frame.type === 'end') {
          const outcome = frame.outcome || {}
          if (outcome.kind === 'abandoned') { view.live = null; publish() }
        }
      }

      void (async () => {
        try {
          const frames = ctx.remote.session.follow(
            { address: { kind: 'session', sessionId }, maxMessages: FOLLOW_MAX_MESSAGES, assistantStream: true },
            controller.signal
          )
          for await (const frame of frames) {
            if (cancelled) return
            if (frame.type === 'snapshot') onSnapshot(frame)
            else if (frame.type === 'event') onEvent(frame.event)
            else if (frame.type === 'assistant-stream') onLive(frame.frame)
          }
        } catch (error) {
          if (!cancelled) console.warn('[dsh-ask-aside] follow 中断：', error)
        }
      })()

      stopFollow = () => {
        cancelled = true
        try { controller.abort() } catch (error) { /* noop */ }
      }
    }

    async function sendQuestion(ctx, question, attachments) {
      const text = question.trim()
      const files = Array.isArray(attachments) ? attachments : []
      if (text === '' && files.length === 0) return
      const state = store.get()
      if (state.phase === 'sending') return
      if (state.parentSessionId === '' && state.sideSessionId === null) {
        store.patch({ phase: 'error', error: '找不到当前会话，无法提问。' })
        return
      }
      const opening = state.sideSessionId === null && state.rows.length === 0
      let composed = text
      if (text !== '' && state.quote !== null) {
        composed = opening ? composeFirstMessage(state.quote, text) : composeQuotedMessage(state.quote, text)
      }
      store.patch({ phase: 'sending', error: null, notice: null })
      try {
        let sideSessionId = state.sideSessionId
        let reused = false
        if (sideSessionId === null) {
          const ensured = await ensureSideSession(ctx, state.parentSessionId, state.strategy)
          sideSessionId = ensured.sessionId
          reused = ensured.reused === true
          store.patch({ sideSessionId, usedStrategy: ensured.strategy })
          startFollowing(ctx, sideSessionId)
          if (!reused) void renameSideSession(ctx, sideSessionId, state.quote)
        }
        const content = []
        if (composed !== '') content.push({ type: 'text', text: composed })
        if (files.length > 0) {
          store.patch({ notice: `正在上传 ${files.length} 个附件…` })
          content.push(...await uploadAttachments(ctx, sideSessionId, files))
          store.patch({ notice: null })
        }
        unwrapRemote(await ctx.remote.session.prompt({
          requestId: mintRequestId(),
          sessionId: sideSessionId,
          mode: 'queue',
          content
        }), 'prompt')
        if (state.quote !== null) store.patch({ quote: null })
      } catch (error) {
        const message = error && error.message ? error.message : String(error)
        store.patch({ phase: 'error', error: message, notice: null })
      }
    }

    /**
     * 「新对话」：换一条新的旁支，老的继续藏起来但仍在磁盘映射里。
     */
    async function startNewThread(ctx, parentSessionId) {
      if (parentSessionId === '') return
      stopFollowing()
      store.reset(parentSessionId)
      store.patch({ phase: 'sending', error: null })
      try {
        const created = await createSideSession(ctx, parentSessionId, store.get().strategy)
        await saveSideMapping(parentSessionId, created.sessionId, created.strategy)
        store.patch({ sideSessionId: created.sessionId, usedStrategy: created.strategy, phase: 'idle', error: null })
        startFollowing(ctx, created.sessionId)
      } catch (error) {
        const message = error && error.message ? error.message : String(error)
        store.patch({ phase: 'error', error: message })
      }
    }

    /* ------------------------------------------------------------------ */
    /* 六点五、附件                                                        */
    /* ------------------------------------------------------------------ */

    const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
    const MAX_ATTACHMENTS = 8

    function imageMediaTypeOf(file) {
      const type = String((file && file.type) || '').toLowerCase()
      return IMAGE_MEDIA_TYPES.includes(type) ? type : ''
    }

    function attachmentChipFrom(file) {
      const mediaType = imageMediaTypeOf(file)
      let previewUrl = ''
      if (mediaType !== '') {
        try { previewUrl = URL.createObjectURL(file) } catch (error) { previewUrl = '' }
      }
      return {
        id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        blob: file,
        name: String(file.name || ''),
        bytes: Number(file.size || 0),
        mediaType,
        previewUrl
      }
    }

    /**
     * 把选好的附件送进宿主，拿到可以写进 prompt 的 receipt。
     * 文件走 fileUpload.upload，图片优先走 uploadImage（宿主会规范化尺寸/格式）。
     */
    async function uploadAttachments(ctx, sessionId, items) {
      const service = typeof ctx.get === 'function' ? ctx.get('fileUpload') : undefined
      if (!service || typeof service.upload !== 'function') {
        throw new Error('这个 DSH 没有提供附件上传服务（fileUpload），附件发不出去。')
      }
      const parts = []
      for (const item of items) {
        const name = item.name === '' ? undefined : item.name
        const result = item.mediaType !== '' && typeof service.uploadImage === 'function'
          ? await service.uploadImage(sessionId, item.blob, item.mediaType, name)
          : await service.upload(sessionId, item.blob, name)
        const value = unwrapRemote(result, 'upload')
        parts.push({ type: 'file', receiptId: value.receiptId })
      }
      return parts
    }

    /* ------------------------------------------------------------------ */
    /* 七、渲染：极简 markdown                                             */
    /* ------------------------------------------------------------------ */

    function renderInline(text, prefix) {
      const nodes = []
      const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g
      let last = 0
      let match
      let index = 0
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > last) nodes.push(text.slice(last, match.index))
        const token = match[0]
        if (token.charCodeAt(0) === 96) {
          nodes.push(h('code', { key: `${prefix}-c${index++}`, className: 'daa-code-inline' }, token.slice(1, -1)))
        } else {
          nodes.push(h('strong', { key: `${prefix}-b${index++}` }, token.slice(2, -2)))
        }
        last = match.index + token.length
      }
      if (last < text.length) nodes.push(text.slice(last))
      return nodes
    }

    function renderMarkdown(text) {
      const lines = String(text).split('\n')
      const blocks = []
      let index = 0
      let listItems = null
      while (index < lines.length) {
        const line = lines[index]
        if (/^\s*```/.test(line)) {
          const buffer = []
          index += 1
          while (index < lines.length && !/^\s*```/.test(lines[index])) { buffer.push(lines[index]); index += 1 }
          index += 1
          blocks.push(h('pre', { key: `pre-${index}`, className: 'daa-pre' }, h('code', null, buffer.join('\n'))))
          continue
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading) {
          blocks.push(h('div', { key: `hd-${index}`, className: 'daa-h' }, renderInline(heading[2], `hd${index}`)))
          index += 1
          listItems = null
          continue
        }
        const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
        if (bullet) {
          if (listItems === null) {
            listItems = []
            blocks.push(h('ul', { key: `ul-${index}`, className: 'daa-ul' }, listItems))
          }
          listItems.push(h('li', { key: `li-${index}` }, renderInline(bullet[1], `li${index}`)))
          index += 1
          continue
        }
        listItems = null
        if (line.trim() === '') { index += 1; continue }
        const buffer = [line]
        index += 1
        while (index < lines.length && lines[index].trim() !== ''
          && !/^\s*```/.test(lines[index])
          && !/^#{1,6}\s/.test(lines[index])
          && !/^\s*[-*]\s+/.test(lines[index])) {
          buffer.push(lines[index])
          index += 1
        }
        blocks.push(h('p', { key: `p-${index}`, className: 'daa-p' }, renderInline(buffer.join('\n'), `p${index}`)))
      }
      return blocks
    }

    /* ------------------------------------------------------------------ */
    /* 八、划词浮层                                                        */
    /* ------------------------------------------------------------------ */

    function servicesOf(ctx) {
      const get = typeof ctx.get === 'function' ? key => ctx.get(key) : () => undefined
      const tabs = get('sidebarRightTabs')
      const sidebar = get('sidebarRight')
      const slots = get('slots')
      if (!tabs || typeof tabs.register !== 'function') return undefined
      if (!sidebar || typeof sidebar.openTab !== 'function') return undefined
      if (!slots || typeof slots.register !== 'function' || typeof slots.inject !== 'function') return undefined
      return { tabs, sidebar, slots }
    }

    function openAskTab(ctx, sessionId) {
      const services = servicesOf(ctx)
      if (services === undefined) {
        console.warn('[dsh-ask-aside] 右侧栏服务还没就绪，本次提问只保留了引文。')
        return
      }
      const options = { params: { at: Date.now() } }
      try {
        if (typeof services.sidebar.openTabIn === 'function' && sessionId !== '') {
          services.sidebar.openTabIn(sessionId, TAB_KIND, options)
        } else {
          services.sidebar.openTab(TAB_KIND, options)
        }
      } catch (error) {
        console.warn('[dsh-ask-aside] 打开右侧栏 tab 失败：', error)
      }
    }

    /**
     * 找宿主自带的「引用文本」按钮。我们不再贴着它排，只在撞上时躲开，
     * 免得两个浮层在同一块像素上重叠。
     */
    function hostQuoteButtonRect() {
      const buttons = document.querySelectorAll('button')
      for (const button of buttons) {
        const label = (button.textContent || '').trim()
        if (label !== HOST_QUOTE_LABEL) continue
        const rect = button.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) return rect
      }
      return null
    }

    const POPOVER_HEIGHT = 30
    const POPOVER_HALF_WIDTH = 32

    function overlaps(a, b) {
      return a.top < b.bottom && b.top < a.bottom && a.left < b.right && b.left < a.right
    }

    /**
     * 纯函数：算出「提问」按钮放哪儿，好单测。
     * 位置跟老版 study-ask 那个按钮一致——贴在选区上方；上方顶到屏幕就翻到下方；
     * 再让开宿主的「引用文本」（它一般就在选区下面）。
     */
    function planPopoverPlacement(rect, viewport, anchor) {
      const center = rect.left + rect.width / 2
      const left = Math.max(POPOVER_HALF_WIDTH + 4, Math.min(center, viewport.width - POPOVER_HALF_WIDTH - 4))
      const above = rect.top - POPOVER_GAP - POPOVER_HEIGHT
      const below = rect.bottom + POPOVER_GAP
      const fitsAbove = above >= 8
      const fitsBelow = below + POPOVER_HEIGHT <= viewport.height - 8
      let top = fitsAbove ? above : (fitsBelow ? below : Math.max(8, viewport.height - 8 - POPOVER_HEIGHT))
      if (anchor !== null && anchor !== undefined) {
        const mine = { left: left - POPOVER_HALF_WIDTH, right: left + POPOVER_HALF_WIDTH, top, bottom: top + POPOVER_HEIGHT }
        if (overlaps(mine, anchor)) {
          const wasAbove = top === above
          if (wasAbove && fitsBelow) top = below
          else if (!wasAbove && fitsAbove) top = above
        }
      }
      return { left, top }
    }

    function placePopover(selection) {
      return planPopoverPlacement(
        selection.rect,
        { width: window.innerWidth, height: window.innerHeight },
        hostQuoteButtonRect()
      )
    }

    function PopoverHost(props) {
      useSelection(props.controller)
      const [, bumpTick] = React.useState(0)
      const selection = props.controller.getSnapshot().selection
      // 宿主的「引用文本」往往比我们的浮层晚一两帧出现，再量一次位置好躲开它。
      React.useEffect(() => {
        if (selection === null) return undefined
        const timer = setTimeout(() => bumpTick(tick => tick + 1), 60)
        return () => clearTimeout(timer)
      }, [selection])
      if (selection === null) return null
      const placement = placePopover(selection)
      return h('div', { className: 'daa-pop', 'data-ask-aside': 'popover', style: { left: placement.left, top: placement.top } },
        h('button', {
          type: 'button',
          className: 'daa-btn',
          title: '在右侧栏里问这句话',
          onMouseDown: event => { event.preventDefault() },
          onMouseUp: event => { event.preventDefault() },
          onClick: event => {
            event.preventDefault()
            event.stopPropagation()
            const sessionId = currentSessionIdOf(props.ctx) || ''
            if (sessionId === '') {
              console.warn('[dsh-ask-aside] 找不到当前会话，无法打开提问面板。')
              return
            }
            store.beginAsk(sessionId, {
              text: selection.text,
              role: selection.role,
              messageId: selection.messageId
            })
            props.controller.clear()
            openAskTab(props.ctx, sessionId)
          }
        }, '提问')
      )
    }

    function useSelection(controller) {
      return React.useSyncExternalStore(controller.subscribe, controller.getSnapshot)
    }

    function mountPopover(ctx) {
      if (!ReactDomClient || typeof ReactDomClient.createRoot !== 'function') return
      // 热重载时旧模块挂的浮层宿主还留在 body 里，先清掉，免得两个浮层叠着。
      for (const stale of Array.from(document.querySelectorAll('[data-ask-aside="root"]'))) stale.remove()
      const host = document.createElement('div')
      host.setAttribute('data-ask-aside', 'root')
      document.body.appendChild(host)
      const controller = createSelectionController()
      const root = ReactDomClient.createRoot(host)
      root.render(h(PopoverHost, { controller, ctx }))
      ctx.effect(() => () => {
        try { root.unmount() } catch (error) { /* noop */ }
        if (host.parentNode) host.parentNode.removeChild(host)
        controller.dispose()
      })
    }

    /* ------------------------------------------------------------------ */
    /* 九、右侧栏面板                                                      */
    /* ------------------------------------------------------------------ */

    function makePanel(ctx) {
      return function AskAsidePanel(props) {
        ensureStyle()
        const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
        const state = React.useSyncExternalStore(store.subscribe, store.get)
        const [draft, setDraft] = React.useState('')
        const [files, setFiles] = React.useState([])
        const [dragging, setDragging] = React.useState(false)
        const scrollRef = React.useRef(null)
        const rootRef = React.useRef(null)
        const inputRef = React.useRef(null)
        const fileInputRef = React.useRef(null)
        const filesRef = React.useRef(files)
        filesRef.current = files

        // 换会话 = 换上下文：上一个会话的引文和待发附件都不该跟着跑过来。
        React.useEffect(() => {
          const current = store.get()
          if (sessionId !== '' && current.parentSessionId !== sessionId) {
            stopFollowing()
            store.reset(sessionId)
            setFiles(previous => {
              for (const item of previous) if (item.previewUrl !== '') URL.revokeObjectURL(item.previewUrl)
              return []
            })
          }
        }, [sessionId])

        React.useEffect(() => () => {
          for (const item of filesRef.current) if (item.previewUrl !== '') URL.revokeObjectURL(item.previewUrl)
        }, [])

        // 首次挂载时如果已经有一条追问（切换 tab 又切回来），把它重新接上。
        React.useEffect(() => {
          const current = store.get()
          if (current.sideSessionId !== null && stopFollow === null) startFollowing(ctx, current.sideSessionId)
          return () => { stopFollowing() }
        }, [])

        // 这个主对话以前问过的话，直接把那条旁支接回来——不新开会话。
        React.useEffect(() => {
          let cancelled = false
          void refreshSideMap().then(() => {
            if (cancelled) return
            const current = store.get()
            if (current.sideSessionId !== null || current.parentSessionId === '') return
            const entry = knownSideSession(current.parentSessionId)
            if (entry === null || !sessionAlive(ctx, entry.side)) return
            store.patch({ sideSessionId: entry.side, usedStrategy: entry.strategy })
            if (stopFollow === null) startFollowing(ctx, entry.side)
          })
          return () => { cancelled = true }
        }, [sessionId])

        React.useEffect(() => {
          const node = scrollRef.current
          if (node !== null) node.scrollTop = node.scrollHeight
        }, [state.rows, state.live, state.phase])

        // 主对话在跑长任务时，把「到哪一步了」贴到面板顶部（四原则第 3 条：主动汇报）。
        const progressSessionId = state.parentSessionId === '' ? sessionId : state.parentSessionId
        const progressTask = useMainProgress(progressSessionId)

        // 面板在右栏里占多宽 → 写成 CSS 变量，顺便让视频皮肤的圆钮给面板让位。
        React.useEffect(() => {
          const node = rootRef.current
          syncSidebarInset(node)
          const onResize = () => syncSidebarInset(rootRef.current)
          window.addEventListener('resize', onResize)
          let observer = null
          if (typeof ResizeObserver === 'function' && node !== null) {
            observer = new ResizeObserver(onResize)
            observer.observe(node)
          }
          return () => {
            window.removeEventListener('resize', onResize)
            if (observer !== null) observer.disconnect()
            try { document.documentElement.removeAttribute('data-ask-aside-panel') } catch (error) { /* 忽略 */ }
          }
        }, [])

        React.useEffect(() => {
          if (state.quote !== null && inputRef.current !== null) inputRef.current.focus()
        }, [state.quote])

        const dropFiles = (list) => {
          const incoming = Array.from(list || []).filter(file => Number(file.size || 0) > 0)
          if (incoming.length === 0) return
          setFiles(previous => {
            const next = previous.slice()
            for (const file of incoming) {
              if (next.length >= MAX_ATTACHMENTS) break
              const exists = next.some(item => item.name === file.name && item.bytes === file.size)
              if (exists) continue
              next.push(attachmentChipFrom(file))
            }
            return next
          })
        }

        const removeFile = (id) => {
          setFiles(previous => {
            const item = previous.find(entry => entry.id === id)
            if (item && item.previewUrl !== '') URL.revokeObjectURL(item.previewUrl)
            return previous.filter(entry => entry.id !== id)
          })
        }

        const send = () => {
          const question = draft.trim()
          const pending = files.slice()
          if (question === '' && pending.length === 0) return
          // 从侧栏「+」直接进来的面板第一次渲染时 parentSessionId 还没落，
          // 用宿主给的 sessionId 补上，否则会被判成"找不到当前会话"。
          if (store.get().parentSessionId === '' && sessionId !== '') store.reset(sessionId)
          setDraft('')
          setFiles([])
          // 预览图已经没用了就可以回收；blob 本身还留给上传。
          for (const item of pending) if (item.previewUrl !== '') URL.revokeObjectURL(item.previewUrl)
          void sendQuestion(ctx, question, pending)
        }

        // 不划词也能问：面板本身就是入口，有当前会话、或者已经有一条旁支就够。
        const canType = state.quote !== null || state.sideSessionId !== null || sessionId !== ''
        const hasPayload = draft.trim() !== '' || files.length > 0
        const canSend = state.phase !== 'sending' && canType && hasPayload
        const parentForActions = state.parentSessionId === '' ? sessionId : state.parentSessionId

        const header = h('div', { className: 'daa-head' },
          h('span', { className: 'daa-title' }, '问答'),
          state.sideSessionId !== null
            ? h('span', { className: 'daa-badge' }, state.usedStrategy === 'inherit' ? '承接上下文' : '仅引文')
            : null,
          h('span', { className: 'daa-grow' }),
          state.sideSessionId !== null
            ? h('button', {
                type: 'button',
                className: 'daa-link',
                onClick: () => {
                  const workspace = ctx.get('uiWorkspace')
                  if (workspace && typeof workspace.openSession === 'function') {
                    workspace.openSession(state.sideSessionId)
                  } else {
                    console.warn('[dsh-ask-aside] 这个 DSH 没有 uiWorkspace.openSession，无法跳转。')
                  }
                }
              }, '在会话中打开')
            : null,
          h('button', {
            type: 'button',
            className: 'daa-link',
            onClick: () => { void startNewThread(ctx, parentForActions) }
          }, '新对话')
        )

        const quoteCard = state.quote === null ? null : h('div', { className: 'daa-quote', 'data-ask-aside': 'quote' },
          h('div', { className: 'daa-quote-role' }, state.quote.role === 'user' ? '引用我的原文' : '引用助手的原文'),
          state.quote.text
        )

        const chips = state.sideSessionId !== null ? null : h('div', { className: 'daa-modes' },
          h('button', {
            type: 'button',
            className: state.strategy === 'inherit' ? 'daa-chip daa-chip-on' : 'daa-chip',
            onClick: () => store.patch({ strategy: 'inherit' }),
            title: 'fork 主会话：带着完整历史回答，最准；命中前缀缓存，token 也最省'
          }, '继承上下文'),
          h('button', {
            type: 'button',
            className: state.strategy === 'quote' ? 'daa-chip daa-chip-on' : 'daa-chip',
            onClick: () => store.patch({ strategy: 'quote' }),
            title: '新建空会话，只发引文和问题：最省 token，适合自足的问题'
          }, '只看引文')
        )

        const rows = state.rows.map((row, index) => h('div', {
          key: `row-${index}`,
          className: row.role === 'user' ? 'daa-row daa-me' : 'daa-row'
        },
          h('div', { className: 'daa-role' }, row.role === 'user' ? '我' : '助手'),
          h('div', { className: 'daa-body' }, renderMarkdown(row.text)),
          row.failure === undefined ? null : h('div', { className: 'daa-fail' }, `回答失败：${row.failure}`)
        ))

        const live = state.live === null ? null : h('div', { className: 'daa-row' },
          h('div', { className: 'daa-role' }, '助手'),
          h('div', { className: 'daa-body' }, renderMarkdown(state.live.text)),
          state.live.failure === undefined ? null : h('div', { className: 'daa-fail' }, `回答失败：${state.live.failure}`)
        )

        const waiting = (state.phase === 'sending' || (state.phase === 'streaming' && state.live === null && state.rows.length < 2))
          ? h('div', { className: 'daa-sending' }, h('span', { className: 'daa-dot' }),
              state.notice !== null && state.notice !== undefined
                ? state.notice
                : state.phase === 'sending' ? '正在建立侧线会话…' : '正在回答…')
          : null

        const hint = (state.rows.length === 0 && state.live === null)
          ? h('div', { className: 'daa-hint' },
              h('div', null, h('b', null, '选中正文里看不懂的词，点「提问」')),
              h('div', null, '也可以停在这个面板里直接问——它会接着这个主对话的上下文回答，主对话不会被插入任何内容；'),
              h('div', null, '这条旁支每个主对话只留一条，已从左侧列表里隐藏，问过的话切回来自动接着聊。')
            )
          : null

        const scroll = h('div', { className: 'daa-scroll', ref: scrollRef },
          hint, rows, live, waiting,
          state.error === null ? null : h('div', { className: 'daa-fail' }, state.error)
        )

        const rail = files.length === 0 ? null : h('div', { className: 'daa-files' },
          files.map(item => h('div', { key: item.id, className: 'daa-file' },
            item.previewUrl !== ''
              ? h('img', { className: 'daa-file-img', src: item.previewUrl, alt: '' })
              : h('span', { className: 'daa-file-ext' }, (item.name.split('.').pop() || 'FILE').slice(0, 4).toUpperCase()),
            h('span', { className: 'daa-file-name', title: item.name }, item.name === '' ? '未命名' : item.name),
            h('button', {
              type: 'button',
              className: 'daa-file-x',
              title: '移除这个附件',
              onClick: () => removeFile(item.id)
            }, '×')
          ))
        )

        const composer = h('div', { className: 'daa-composer' },
          rail,
          h('input', {
            ref: fileInputRef,
            className: 'daa-fileinput',
            type: 'file',
            multiple: true,
            tabIndex: -1,
            hidden: true,
            style: { display: 'none' },
            onChange: event => {
              dropFiles(event.target.files)
              event.target.value = ''
            }
          }),
          h('div', { className: 'daa-box' },
            h('textarea', {
              ref: inputRef,
              className: 'daa-input',
              rows: 1,
              placeholder: state.quote !== null
                ? '这个词是什么意思 / 为什么这么判断…'
                : (state.sideSessionId === null ? '直接问：这一步为什么这么做 / 这个词是什么意思…' : '接着问这条旁支…'),
              value: draft,
              disabled: !canType,
              onChange: event => setDraft(event.target.value),
              onPaste: event => {
                const pasted = event.clipboardData && event.clipboardData.files
                if (pasted && pasted.length > 0) {
                  event.preventDefault()
                  dropFiles(pasted)
                }
              },
              onKeyDown: event => {
                if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send() }
              }
            }),
            h('div', { className: 'daa-boxrow' },
              h('button', {
                type: 'button',
                className: 'daa-clip',
                title: '添加图片或文件（也可以直接粘贴或拖进来）',
                disabled: !canType,
                onClick: () => {
                  const node = fileInputRef.current
                  if (node !== null) node.click()
                }
              }, '＋'),
              h('button', { type: 'button', className: 'daa-send', disabled: !canSend, onClick: send, title: '发送' }, '↑')
            )
          )
        )

        return h('div', {
          ref: rootRef,
          className: dragging ? 'daa-root daa-root-drop' : 'daa-root',
          'data-ask-aside': 'panel',
          onDragOver: event => {
            event.preventDefault()
            if (!dragging) setDragging(true)
          },
          onDragLeave: event => {
            if (event.currentTarget.contains(event.relatedTarget)) return
            setDragging(false)
          },
          onDrop: event => {
            event.preventDefault()
            setDragging(false)
            if (event.dataTransfer) dropFiles(event.dataTransfer.files)
          }
        }, header, progressTask === null ? null : h(ProgressStrip, { key: 'progress', task: progressTask }), quoteCard, chips, scroll, composer)
      }
    }


    /* ------------------------------------------------------------------ */
    /* 九点五、与视频皮肤插件协同（把它的固定定位控件让开右栏 + 换掉原生提示） */
    /* ------------------------------------------------------------------ */

    const VIDEO_PILL_ID = 'dsvs-knobs-pill'
    const VIDEO_TIP_CLASS = 'daa-vtip'
    const VIDEO_TIP_TEXT = '聊天背景透明度（Alt+B）'

    /**
     * dsh-video-skin 的圆钮只挂了个原生 title，悬停是浏览器自带的方框提示。
     * 这里把 title 摘掉、塞一个主题化的气泡进去；它的 DOM 是异步建的，所以还要监听。
     */
    function decorateVideoSkin() {
      try {
        const pill = document.getElementById(VIDEO_PILL_ID)
        if (pill === null) return
        if (pill.querySelector('.' + VIDEO_TIP_CLASS) !== null) return
        pill.removeAttribute('title')
        pill.dataset.daaTip = '1'
        const tip = document.createElement('span')
        tip.className = VIDEO_TIP_CLASS
        tip.textContent = VIDEO_TIP_TEXT
        pill.appendChild(tip)
      } catch (error) {
        console.warn('[dsh-ask-aside] 美化视频皮肤按钮的提示失败：', error)
      }
    }

    function watchVideoSkin() {
      decorateVideoSkin()
      if (typeof MutationObserver !== 'function') return () => {}
      let last = 0
      const observer = new MutationObserver(() => {
        const now = Date.now()
        if (now - last < 400) return
        last = now
        decorateVideoSkin()
      })
      observer.observe(document.body, { childList: true, subtree: true })
      return () => { try { observer.disconnect() } catch (error) { /* 忽略 */ } }
    }

    /**
     * 面板自己是右栏里的一块，宽度由宿主的侧栏决定；把「离视口右边多远」写成 CSS 变量，
     * 上面那两条规则就能把贴在屏幕右下角的第三方圆钮让到面板左边。
     */
    function syncSidebarInset(node) {
      try {
        const html = document.documentElement
        if (node === null || node === undefined || !node.isConnected) {
          html.removeAttribute('data-ask-aside-panel')
          return
        }
        const rect = node.getBoundingClientRect()
        const inset = Math.max(0, Math.round(window.innerWidth - rect.left))
        html.style.setProperty('--daa-sidebar-inset', inset + 'px')
        html.setAttribute('data-ask-aside-panel', '1')
      } catch (error) {
        console.warn('[dsh-ask-aside] 计算侧栏占位失败：', error)
      }
    }

    /* ------------------------------------------------------------------ */
    /* 九点七、任务进度带（把「主对话跑到哪一步」搬进侧栏）                   */
    /* ------------------------------------------------------------------ */

    /** 把毫秒时长写成「12 秒 / 3 分 05 秒 / 1 小时 4 分」。 */
    function formatProgressDuration(ms) {
      const total = Math.max(0, Math.round((Number(ms) || 0) / 1000))
      if (total < 60) return `${total} 秒`
      const minutes = Math.floor(total / 60)
      const seconds = total % 60
      if (minutes < 60) return seconds === 0 ? `${minutes} 分` : `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`
      const hours = Math.floor(minutes / 60)
      const rest = minutes % 60
      return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`
    }

    /**
     * 从两个来源的返回里挑出「属于这个主对话」的那条任务。
     * - dsh-progress-widget 的 /dsh-progress/status：{ ok, task, tasks, live, activeCount }
     * - 宿主兜底的 /dsh-ask-aside/api/progress：{ ok, task }
     * 认领规则：任务带 session/id 且等于当前会话 id 才算；都没带（早期上报）时退而用唯一那条。
     */
    function pickProgressTask(payload, sessionId) {
      if (payload === null || payload === undefined || typeof payload !== 'object' || payload.ok === false) return null
      const wanted = typeof sessionId === 'string' ? sessionId : ''
      const candidates = []
      if (Array.isArray(payload.tasks)) {
        for (const item of payload.tasks) if (item !== null && typeof item === 'object' && !Array.isArray(item)) candidates.push(item)
      }
      if (payload.task !== null && typeof payload.task === 'object' && !Array.isArray(payload.task)) candidates.push(payload.task)
      if (candidates.length === 0) return null

      const owned = candidates.filter(item => (typeof item.id === 'string' && item.id !== '' && item.id === wanted) ||
        (typeof item.session === 'string' && item.session !== '' && item.session === wanted))
      const anonymous = candidates.filter(item => (item.id === undefined || item.id === '') && (item.session === undefined || item.session === ''))
      let matched = null
      if (wanted !== '') matched = owned[0] || null
      else matched = candidates[0]
      if (matched === null && wanted !== '' && owned.length === 0 && anonymous.length === 1) matched = anonymous[0]
      if (matched === null) return null

      const stages = Array.isArray(matched.stages) ? matched.stages.filter(stage => typeof stage === 'string' && stage !== '') : []
      const lastIndex = Math.max(0, stages.length - 1)
      const current = Math.max(0, Math.min(lastIndex, Math.round(Number(matched.current) || 0)))
      return {
        id: typeof matched.id === 'string' ? matched.id : '',
        source: typeof matched.source === 'string' ? matched.source : '',
        task: typeof matched.task === 'string' ? matched.task : '',
        project: typeof matched.project === 'string' ? matched.project : '',
        stages,
        current,
        pct: Math.max(0, Math.min(100, Math.round(Number(matched.pct) || 0))),
        action: typeof matched.action === 'string' ? matched.action : '',
        issue: typeof matched.issue === 'string' ? matched.issue : '',
        etaMin: Math.max(0, Math.round(Number(matched.etaMin) || 0)),
        status: typeof matched.status === 'string' && matched.status !== '' ? matched.status : 'running',
        steps: Math.max(0, Math.round(Number(matched.steps) || 0)),
        auto: matched.auto === true,
        startedAt: Number(matched.startedAt) || 0,
        updatedAt: Number(matched.updatedAt) || 0,
        staleMin: Number(matched.staleMin) || 0
      }
    }

    async function readMainProgress(sessionId) {
      if (typeof fetch !== 'function') return null
      const sources = [PROGRESS_ROUTE, PROGRESS_TAB_ROUTE]
      if (sessionId !== '') sources.push(`${PROGRESS_HOST_ROUTE}?session=${encodeURIComponent(sessionId)}`)
      for (const source of sources) {
        try {
          const response = await fetch(source, { headers: { accept: 'application/json' }, cache: 'no-store' })
          if (response === undefined || response === null || response.ok !== true) continue
          const payload = await response.json()
          const task = pickProgressTask(payload, sessionId)
          if (task !== null) return task
        } catch (error) {
          // 进度插件没装 / 宿主半还没起来：静默换下一个来源，进度只是锦上添花
        }
      }
      return null
    }

    function progressSignature(task) {
      if (task === null) return ''
      return [task.id, task.task, task.status, task.current, task.pct, task.steps, task.etaMin, task.updatedAt, task.action, task.issue, task.stages.join(',')].join('|')
    }

    /** 面板打开期间每 1.5 秒看一次进度；内容没变就不 setState（别让整块面板每秒重渲染）。 */
    function useMainProgress(sessionId) {
      const [task, setTask] = React.useState(null)
      const signatureRef = React.useRef('')
      React.useEffect(() => {
        if (sessionId === '') {
          signatureRef.current = ''
          setTask(null)
          return () => {}
        }
        let stopped = false
        let timer = null
        const tick = async () => {
          const next = await readMainProgress(sessionId)
          if (stopped) return
          const signature = progressSignature(next)
          if (signature !== signatureRef.current) {
            signatureRef.current = signature
            setTask(next)
          }
          timer = setTimeout(() => { void tick() }, PROGRESS_POLL_MS)
        }
        void tick()
        return () => {
          stopped = true
          if (timer !== null) { clearTimeout(timer); timer = null }
        }
      }, [sessionId])
      return task
    }

    /**
     * 一条很薄的进度带：任务名 + 阶段/进度 + 已用/预计，点一下展开阶段清单和当前动作。
     * 没有任务时返回 null（完全不占地方）；结束/失败会变绿/变红，6 秒后自己收走。
     */
    function ProgressStrip(props) {
      const task = props.task === undefined ? null : props.task
      const [now, setNow] = React.useState(() => Date.now())
      const [open, setOpen] = React.useState(false)
      const [hidden, setHidden] = React.useState(false)
      const key = task === null ? '' : `${task.id}|${task.task}|${task.status}|${task.updatedAt}`
      const finished = task !== null && (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled')

      React.useEffect(() => { setOpen(false); setHidden(false) }, [key])
      React.useEffect(() => {
        if (task === null || !finished) return () => {}
        setNow(Date.now())
        const timer = setTimeout(() => setHidden(true), PROGRESS_DONE_HOLD_MS)
        return () => clearTimeout(timer)
      }, [key, finished])
      React.useEffect(() => {
        if (task === null || finished) return () => {}
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
      }, [key, finished])

      if (task === null || hidden) return null

      const status = task.status
      const tone = status === 'blocked' ? 'daa-prog-warn'
        : status === 'failed' ? 'daa-prog-bad'
          : finished ? 'daa-prog-done' : 'daa-prog-run'
      const elapsed = task.startedAt > 0 ? formatProgressDuration(Math.max(0, now - task.startedAt)) : ''
      const stageCount = task.stages.length
      const stageLabel = stageCount > 0 ? `${task.current + 1}/${stageCount} ${task.stages[task.current]}` : (task.auto ? `第 ${task.steps > 0 ? task.steps : 1} 步` : '')
      const statusLabel = status === 'blocked' ? '卡住了'
        : status === 'failed' ? '失败'
          : status === 'done' ? '已结束'
            : status === 'cancelled' ? '已取消' : ''
      // 第一行只放「任务名 + 阶段 + 用时」：窄面板里挤不下就省略，不硬塞动作文字。
      const rowLabel = statusLabel !== '' ? statusLabel : (stageLabel === '' ? '进行中' : stageLabel)
      const eta = finished || task.etaMin <= 0 ? '' : `预计还需约 ${task.etaMin} 分`
      const subText = status === 'blocked'
        ? (task.issue === '' ? '在等你处理，处理完我会接着跑' : task.issue)
        : status === 'failed'
          ? (task.issue === '' ? '任务失败，点开看详情' : task.issue)
          : status === 'cancelled' ? (task.issue === '' ? '任务已取消' : task.issue)
            : finished ? '' : task.action

      const row = React.createElement('div', { className: 'daa-prog-row' },
        React.createElement('span', { className: 'daa-prog-dot' }),
        React.createElement('span', { className: 'daa-prog-task', title: task.task }, task.task === '' ? '当前任务' : task.task),
        React.createElement('span', { className: 'daa-prog-label', title: rowLabel }, rowLabel),
        React.createElement('span', { className: 'daa-prog-time' }, elapsed)
      )
      const bar = React.createElement('span', { className: 'daa-prog-bar' },
        React.createElement('i', { style: { width: `${Math.max(0, Math.min(100, task.pct))}%` } })
      )
      // 第二行：正在干的具体动作 / 卡住的问题，右边跟预计；没有就整行不占高度。
      const sub = subText === '' && eta === '' ? null : React.createElement('div', { className: 'daa-prog-sub' },
        React.createElement('span', { className: 'daa-prog-sub-t', title: subText }, subText),
        eta === '' ? null : React.createElement('span', { className: 'daa-prog-sub-e' }, eta)
      )

      let details = null
      if (open) {
        const steps = task.stages.map((stage, index) => React.createElement('span', {
          key: `stage-${index}`,
          className: index < task.current ? 'daa-prog-step daa-prog-step-done'
            : index === task.current ? 'daa-prog-step daa-prog-step-now' : 'daa-prog-step'
        }, `${index < task.current ? '✓ ' : index === task.current ? '▶ ' : ''}${index + 1}. ${stage}`))
        details = React.createElement('div', { className: 'daa-prog-steps' },
          ...steps,
          task.action === '' ? null : React.createElement('div', { className: 'daa-prog-act' }, `当前动作：${task.action}`),
          task.staleMin > 0 ? React.createElement('div', { className: 'daa-prog-act' }, `⚠ agent 已 ${task.staleMin} 分钟没更新进度（最后上报到这里，不再往前猜）`) : null,
          task.issue !== '' && status !== 'blocked' ? React.createElement('div', { className: 'daa-prog-act' }, `说明：${task.issue}`) : null,
          steps.length === 0 && task.action === '' ? React.createElement('div', { className: 'daa-prog-empty' }, '这条任务没有分阶段，只有整体进度。') : null
        )
      }

      return React.createElement('div', {
        className: `daa-prog ${tone}`,
        'data-ask-aside': 'progress',
        title: open ? '收起任务步骤' : '展开任务步骤',
        onClick: () => setOpen(value => !value)
      }, row, bar, sub, details)
    }

    /* ------------------------------------------------------------------ */
    /* 九、主输入框左侧入口（挨着 + 号）                                    */
    /* ------------------------------------------------------------------ */

    /**
     * 主聊天框左下角那一排按钮里的一个小入口。以前这里的东西是 study-ask 的，
     * 关掉那个插件后用户觉得「+ 号那块功能被改了」，所以用我们自己的入口补上：
     * 点一下就打开右侧栏的「问答」，不划词也能问。
     */
    function ComposerEntry(ctx) {
      return function AskAsideComposerEntry(props) {
        const provided = props !== undefined && props !== null && typeof props.sessionId === 'string' ? props.sessionId : ''
        const onClick = () => {
          let target = provided
          if (target === '') {
            try { target = resolveCurrentSessionId(ctx.sessions) || '' } catch (error) { target = '' }
          }
          openAskTab(ctx, target)
        }
        return React.createElement('button', {
          type: 'button',
          className: 'daa-entry',
          title: '在右侧栏里接着这个对话问（不打断主对话）',
          'aria-label': '问答',
          'data-ask-aside': 'entry',
          onClick
        }, React.createElement('svg', {
          width: 14,
          height: 14,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true'
        }, React.createElement('path', {
          d: 'M3 3.4h10v6.2H7.6l-2.9 2.5v-2.5H3z',
          stroke: 'currentColor',
          strokeWidth: 1.25,
          strokeLinejoin: 'round',
          strokeLinecap: 'round'
        })))
      }
    }

    /* ------------------------------------------------------------------ */
    /* 十、注册                                                            */
    /* ------------------------------------------------------------------ */

    function registerTab(ctx, services) {
      const disposers = []
      disposers.push(services.tabs.register({
        id: TAB_ID,
        kind: TAB_KIND,
        priority: 'extension',
        title: () => '问答',
        guide: [{
          id: 'ask-aside',
          order: TAB_ORDER,
          title: () => '问答',
          description: () => '不划词也能直接问：在右侧栏里接着主对话的上下文追问，不打断主对话'
        }]
      }))
      disposers.push(services.slots.inject('sidebar.right.pane.tab', () => services.slots.register({
        name: 'sidebar.right.pane.tab',
        key: TAB_ID
      }, makePanel(ctx))))
      disposers.push(services.slots.inject('conversation.input.left', () => services.slots.register({
        name: 'conversation.input.left',
        id: 'ask-aside.entry',
        order: 850
      }, ComposerEntry(ctx))))
      return () => {
        for (const dispose of disposers.reverse()) {
          try { dispose() } catch (error) { console.warn('[dsh-ask-aside] 注销失败：', error) }
        }
      }
    }

    function apply(ctx) {
      try {
        ensureStyle()
        mountPopover(ctx)
        // 视频皮肤那个圆钮的提示框换成自己的（它的 DOM 是异步建的，所以要盯着）。
        const unwatchVideoSkin = watchVideoSkin()
        // 页面一加载就把历史侧线藏起来（映射在宿主侧，重启后仍然有效）。
        void refreshSideMap()

        let tries = 0
        let timer = null
        let disposeTab = null
        let stopped = false

        const stop = () => {
          stopped = true
          if (timer !== null) { clearTimeout(timer); timer = null }
        }

        const tick = () => {
          if (stopped) return
          const services = servicesOf(ctx)
          if (services !== undefined) {
            try {
              disposeTab = registerTab(ctx, services)
              console.info('[dsh-ask-aside] 已在右侧栏注册「问答」tab')
            } catch (error) {
              console.warn('[dsh-ask-aside] 注册右侧栏 tab 失败（划词浮层仍可用）：', error)
            }
            return
          }
          if (++tries > 240) return
          timer = setTimeout(tick, tries < 30 ? 16 : 500)
        }
        tick()

        ctx.effect(() => () => {
          stop()
          stopFollowing()
          unwatchVideoSkin()
          if (disposeTab !== null) disposeTab()
        })
      } catch (error) {
        console.warn('[dsh-ask-aside] apply 失败：', error)
      }
    }

    return {
      apply,
      inject: ['sessions', 'remote', 'remote.session', 'workspaces'],
      __test__: {
        composeFirstMessage,
        composeQuotedMessage,
        foldSessionEvent,
        foldStreamRecords,
        emptyView,
        createStore,
        renderMarkdown,
        attachmentChipFrom,
        uploadAttachments,
        imageMediaTypeOf,
        decorateVideoSkin,
        syncSidebarInset,
        pickProgressTask,
        formatProgressDuration,
        progressSignature,
        planPopoverPlacement
      }
    }
  }
})