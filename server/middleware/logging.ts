import { randomUUID } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'

// Номер запроса и журнал в JSON: метод, путь без query, статус, время.
// Ни IP, ни тела, ни параметров — query может содержать токен, тело — персональные данные.

declare module 'hono' {
  interface ContextVariableMap {
    requestId: string
    rateLimited: string
  }
}

const RID = /^[A-Za-z0-9._-]{8,64}$/

export function log(level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields })
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

export function requestLog(): MiddlewareHandler {
  return async (c, next) => {
    const incoming = c.req.header('x-request-id')
    const rid = incoming && RID.test(incoming) ? incoming : randomUUID()
    c.set('requestId', rid)
    const started = performance.now()
    await next()
    c.res.headers.set('X-Request-Id', rid)
    const path = c.req.path
    // Статику не логируем — шум; API, вебхуки и ошибки — всегда
    if (!path.startsWith('/api/') && !path.startsWith('/bots/') && c.res.status < 400) return
    log(c.res.status >= 500 ? 'error' : c.res.status >= 400 ? 'warn' : 'info', 'request', {
      rid,
      method: c.req.method,
      path,
      status: c.res.status,
      ms: Math.round(performance.now() - started),
      ...(c.get('rateLimited') ? { limit: c.get('rateLimited') } : {}),
    })
  }
}
