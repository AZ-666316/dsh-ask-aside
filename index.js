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

function diagFile() {
  return join(stateDir(), 'dsh-ask-aside-diag.json')
}

function readDiag() {
  try {
    return JSON.parse(readFileSync(diagFile(), 'utf8'))
  } catch {
    return null
  }
}

function writeDiag(payload) {
  const file = diagFile()
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(payload, null, 2), 'utf8')
  renameSync(temp, file)
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

        if (url.pathname === `${ROUTE}/diag` && method === 'GET') {
          send(res, 200, { ok: true, diag: readDiag() })
          return
        }

        if (url.pathname === `${ROUTE}/diag` && method === 'POST') {
          const raw = await readBody(req)
          let payload
          try {
            payload = JSON.parse(raw === '' ? '{}' : raw)
          } catch {
            send(res, 400, { ok: false, error: 'bad-json' })
            return
          }
          writeDiag(payload)
          send(res, 200, { ok: true })
          return
        }

        send(res, 404, { ok: false, error: 'not-found' })
      } catch (error) {
        send(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
      }
    }
  }), 'dsh-ask-aside: /dsh-ask-aside/api/{status,map}')
}