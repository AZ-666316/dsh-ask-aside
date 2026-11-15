/**
 * dsh-ask-aside — host half.
 *
 * 这个插件的工作几乎全在客户端（划词浮层 + 右侧栏「问答」tab，见 lib/client.js）。
 * 宿主侧只做两件事：
 *   1. 让 client 半随 profile 一起下发（dsh.client 声明 + 本文件被 patch 引入）；
 *   2. 提供一个只读状态路由，方便确认插件真的挂载了：
 *        GET /dsh-ask-aside/api/status
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-ask-aside'
export const inject = ['webServer']

const HERE = dirname(fileURLToPath(import.meta.url))
const ROUTE = '/dsh-ask-aside/api'

function version() {
  try {
    return JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version
  } catch {
    return 'unknown'
  }
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
    handler: (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        if (url.pathname !== `${ROUTE}/status`) {
          send(res, 404, { ok: false, error: 'not-found' })
          return
        }
        send(res, 200, { ok: true, name, version: pluginVersion, startedAt, route: ROUTE, pluginDir: HERE })
      } catch (error) {
        send(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
      }
    }
  }), 'dsh-ask-aside: /dsh-ask-aside/api/status')
}