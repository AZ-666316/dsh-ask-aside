/**
 * dsh-ask-aside — host half.
 *
 * 这个插件的工作几乎全在客户端（划词浮层 + 右侧栏「问答」tab，见 lib/client.js）。
 * 宿主侧只做两件事：
 *   1. 让 client 半随 profile 一起下发（dsh.client 声明 + 本文件被 patch 引入）；
 *   2. 把「主对话 → 侧线会话」的映射落盘，这样重启之后仍能认回同一条侧线，
 *      不会每问一次就在左栏堆一条新会话。
 *
 * 路由（全部 loopback，无需鉴权）：
 *   GET  /dsh-ask-aside/api/status        插件状态
 *   GET  /dsh-ask-aside/api/map           读取映射
 *   POST /dsh-ask-aside/api/map           写入一条映射 { parent, side, strategy, retired? }
 *   GET  /dsh-ask-aside/api/progress?session=<id>
 *                                         读 $DSH_HOME/dsh-progress.json（agent 上报的任务进度），
 *                                         按会话过滤并丢掉过期数据。面板顶部的进度条带用它；
 *                                         装了 dsh-progress-widget 时客户端优先读那个插件的
 *                                         /dsh-progress/status（字段更全，含自动阶段），这条只是兜底。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-ask-aside'
export const inject = ['webServer']

const HERE = dirname(fileURLToPath(import.meta.url))
const ROUTE = '/dsh-ask-aside/api'
const MAX_BODY = 64 * 1024

function version() {
  try {
    return JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version
  } catch {
    return 'unknown'
  }
}

function stateDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return home
}

function mapFile() {
  return join(stateDir(), 'dsh-ask-aside-map.json')
}

function readMap() {
  try {
    const parsed = JSON.parse(readFileSync(mapFile(), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const map = {}
    for (const [parent, value] of Object.entries(parsed)) {
      if (typeof parent !== 'string' || parent === '') continue
      if (value === null || typeof value !== 'object') continue
      const side = typeof value.side === 'string' ? value.side : ''
      if (side === '') continue
      const retired = Array.isArray(value.retired)
        ? value.retired.filter((id) => typeof id === 'string' && id !== '')
        : []
      map[parent] = {
        side,
        strategy: value.strategy === 'quote' ? 'quote' : 'inherit',
        at: typeof value.at === 'number' ? value.at : 0,
        ...(retired.length > 0 ? { retired } : {})
      }
    }
    return map
  } catch {
    return {}
  }
}

function writeMap(map) {
  const file = mapFile()
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(map, null, 2), 'utf8')
  renameSync(temp, file)
}

/* ------------------------------------------------------------------ */
/* 任务进度（agent 上报协议，见 dsh-progress-widget 的 dsh-progress.json） */
/* ------------------------------------------------------------------ */

/** running 的任务超过这么久没更新就不显示了（别把上次会话的残留当成正在跑）。 */
const PROGRESS_STALE_MS = 10 * 60 * 1000
/** 已结束的任务在面板上留多久。 */
const PROGRESS_DONE_MS = 2 * 60 * 1000

function progressFile() {
  return join(stateDir(), 'dsh-progress.json')
}

/** 与 dsh-progress-tab 插件共用的多任务文件：写一次，tab 和这里的顶部进度带都能看到。 */
function progressTabFile() {
  return join(stateDir(), 'dsh-progress-tab.json')
}

function textOf(value, max) {
  if (typeof value !== 'string') return ''
  const trimmed = value.replace(/\s+/g, ' ').trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

function intOf(value, min, max) {
  const number = Math.round(Number(value))
  if (!Number.isFinite(number)) return min
  return Math.max(min, Math.min(max, number))
}

/** 把一份上报（不管来自哪个文件）规范化成面板能直接用的形状；过期/结束太久返回 null。 */
function normalizeProgressTask(parsed, source) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null

  const status = typeof parsed.status === 'string' ? parsed.status : 'running'
  const now = Date.now()
  const startedAt = Number(parsed.startedAt) || 0
  const updatedAt = Number(parsed.updatedAt) || startedAt
  const endedAt = Number(parsed.endedAt) || 0
  const finished = status === 'done' || status === 'failed' || status === 'cancelled'
  if (finished) {
    if (endedAt > 0 && now - endedAt > PROGRESS_DONE_MS) return null
  } else if (updatedAt > 0 && now - updatedAt > PROGRESS_STALE_MS) {
    return null
  }

  const stages = Array.isArray(parsed.stages)
    ? parsed.stages.filter((stage) => typeof stage === 'string' && stage.trim() !== '').slice(0, 8).map((stage) => textOf(stage, 40))
    : []
  return {
    id: typeof parsed.id === 'string' ? parsed.id : '',
    source,
    task: textOf(parsed.task, 60),
    project: textOf(parsed.project, 40),
    session: typeof parsed.session === 'string' ? parsed.session : '',
    stages,
    current: intOf(parsed.current, 0, Math.max(0, stages.length - 1)),
    pct: intOf(parsed.pct, 0, 100),
    action: textOf(parsed.action, 120),
    issue: textOf(parsed.issue !== undefined ? parsed.issue : parsed.cause, 120),
    etaMin: intOf(parsed.etaMin, 0, 600),
    status,
    steps: intOf(parsed.steps, 0, 9999),
    startedAt,
    updatedAt,
    endedAt
  }
}

/** `<DSH_HOME>/dsh-progress.json`：进度插件/agent 的单条上报格式。 */
function readProgress() {
  try {
    return normalizeProgressTask(JSON.parse(readFileSync(progressFile(), 'utf8')), 'report')
  } catch {
    return null
  }
}

/**
 * `<DSH_HOME>/dsh-progress-tab.json`：dsh-progress-tab 插件用的多任务格式，
 * `{ tasks: [...] }` 或裸数组。用同一个文件，写一次两处（tab 和这里的顶部进度带）都看得到。
 */
function readProgressTabTasks() {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(progressTabFile(), 'utf8'))
  } catch {
    return []
  }
  const list = Array.isArray(parsed) ? parsed : (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.tasks) ? parsed.tasks : [])
  const tasks = []
  for (const item of list) {
    const task = normalizeProgressTask(item, 'tab')
    if (task !== null) tasks.push(task)
  }
  return tasks
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('body-too-large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function send(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  res.end(JSON.stringify(body))
}

export function apply(ctx) {
  const startedAt = new Date().toISOString()
  const pluginVersion = version()

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        const method = (req.method ?? 'GET').toUpperCase()

        if (url.pathname === `${ROUTE}/status`) {
          send(res, 200, { ok: true, name, version: pluginVersion, startedAt, route: ROUTE, pluginDir: HERE })
          return
        }

        if (url.pathname === `${ROUTE}/map` && method === 'GET') {
          send(res, 200, { ok: true, map: readMap() })
          return
        }

        if (url.pathname === `${ROUTE}/progress` && method === 'GET') {
          const wanted = url.searchParams.get('session') ?? ''
          // 三个来源合并：单条上报文件 + 与 dsh-progress-tab 共用的多任务文件。
          const tasks = []
          const reported = readProgress()
          if (reported !== null) tasks.push(reported)
          for (const task of readProgressTabTasks()) tasks.push(task)
          // 带了会话 id 的只认那条会话：别的窗口在跑，不该出现在这个面板上。
          const own = wanted === ''
            ? tasks
            : tasks.filter((task) => task.session === '' || task.session === wanted)
          send(res, 200, { ok: true, tasks: own })
          return
        }

        if (url.pathname === `${ROUTE}/map` && method === 'POST') {
          const raw = await readBody(req)
          let payload
          try {
            payload = JSON.parse(raw === '' ? '{}' : raw)
          } catch {
            send(res, 400, { ok: false, error: 'bad-json' })
            return
          }
          const parent = payload && typeof payload.parent === 'string' ? payload.parent : ''
          const side = payload && typeof payload.side === 'string' ? payload.side : ''
          if (parent === '' || side === '') {
            send(res, 400, { ok: false, error: 'parent-and-side-required' })
            return
          }
          const map = readMap()
          const previous = map[parent]
          const retired = new Set(previous && Array.isArray(previous.retired) ? previous.retired : [])
          if (previous && previous.side !== side) retired.add(previous.side)
          retired.delete(side)
          map[parent] = {
            side,
            strategy: payload.strategy === 'quote' ? 'quote' : 'inherit',
            at: Date.now(),
            ...(retired.size > 0 ? { retired: Array.from(retired) } : {})
          }
          writeMap(map)
          send(res, 200, { ok: true, entry: map[parent] })
          return
        }

        send(res, 404, { ok: false, error: 'not-found' })
      } catch (error) {
        send(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
      }
    }
  }), 'dsh-ask-aside: /dsh-ask-aside/api/{status,map}')
}