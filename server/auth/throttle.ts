import type { Context, MiddlewareHandler } from 'hono'
import { clientIp } from '../middleware/client-ip'

// Задержка после неверных паролей — на пару «почта + IP». Подбор пароля к одной почте с одного адреса
// замедляется: после трёх промахов подряд следующий вход можно пробовать через 5 с, потом 10, 20, 40 с… до 5 минут.
// Почту целиком не блокируем: с другого адреса (настоящий сотрудник из офиса) вход работает сразу.
// Отдельно действует лимит по IP на все почты сразу (правило hr-login в server/middleware/rate-limit.ts).
// Счёт — в памяти процесса: при нескольких экземплярах сервера каждый считает свои попытки.

export type ThrottleOptions = {
  /** После скольких промахов подряд начинается задержка */
  free?: number
  /** Задержка после первого промаха сверх бесплатных, мс; дальше удваивается */
  baseMs?: number
  /** Потолок задержки, мс */
  maxMs?: number
  /** Через сколько после последнего промаха пара забывается, мс */
  forgetMs?: number
  now?: () => number
}

export const THROTTLE_DEFAULTS = { free: 3, baseMs: 5_000, maxMs: 5 * 60_000, forgetMs: 15 * 60_000 } as const

type Entry = { failures: number; until: number; last: number }

/**
 * Счётчик промахов по ключу. wait(key) — сколько секунд ещё ждать (0 — можно пробовать),
 * fail(key) — промах, ok(key) — удачный вход: счёт обнуляется
 */
export function createThrottle(opts: ThrottleOptions = {}) {
  const { free, baseMs, maxMs, forgetMs } = { ...THROTTLE_DEFAULTS, ...opts }
  const now = opts.now ?? Date.now
  const entries = new Map<string, Entry>()

  const sweep = () => {
    const t = now()
    for (const [k, e] of entries) if (t - e.last > forgetMs && t >= e.until) entries.delete(k)
  }
  const timer = setInterval(sweep, 60_000)
  timer.unref()

  const live = (key: string) => {
    const e = entries.get(key)
    if (e && now() - e.last > forgetMs && now() >= e.until) {
      entries.delete(key)
      return undefined
    }
    return e
  }

  return {
    /** Секунды до следующей попытки; 0 — можно сейчас */
    wait(key: string): number {
      const e = live(key)
      const left = e ? e.until - now() : 0
      return left > 0 ? Math.ceil(left / 1000) : 0
    },
    /** Промах: начиная с free-го подряд — задержка baseMs, 2 × baseMs, 4 × baseMs… не больше maxMs. Возвращает задержку в секундах */
    fail(key: string): number {
      const t = now()
      const e = live(key) ?? { failures: 0, until: 0, last: t }
      e.failures += 1
      e.last = t
      const over = e.failures - free + 1
      const delay = over > 0 ? Math.min(maxMs, baseMs * 2 ** (over - 1)) : 0
      e.until = t + delay
      entries.set(key, e)
      return Math.ceil(delay / 1000)
    },
    ok(key: string) {
      entries.delete(key)
    },
    failures(key: string): number {
      return live(key)?.failures ?? 0
    },
    size: () => entries.size,
    stop: () => clearInterval(timer),
  }
}

export type Throttle = ReturnType<typeof createThrottle>

/** Тело запроса до 16 КБ без расхода самого запроса: обработчик входа прочитает его сам */
async function bodyEmail(c: Context): Promise<string> {
  const length = Number(c.req.header('content-length') ?? 0)
  if (length > 16 * 1024) return ''
  try {
    const text = await c.req.raw.clone().text()
    if (text.length > 16 * 1024) return ''
    const body = JSON.parse(text) as { email?: unknown } | null
    return typeof body?.email === 'string' ? body.email.trim().toLowerCase().slice(0, 254) : ''
  } catch {
    return ''
  }
}

/**
 * Обёртка входа в панель: ставится перед обработчиком POST /api/hr/login, одна на экземпляр API —
 * app.use('/api/hr/login', loginGuard()) до маршрутов панели. Пока пара «почта + IP» ждёт —
 * 429 rate_limited с Retry-After, пароль даже не проверяется. После ответа обработчика: 401 — промах, 200 — счёт сброшен.
 * Без почты в теле — пропускает как есть (обработчик сам ответит 401)
 */
export function loginGuard(throttle: Throttle = createThrottle()): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== 'POST') return next()
    const email = await bodyEmail(c)
    if (!email) return next()
    const key = `${email}|${clientIp(c)}`
    const wait = throttle.wait(key)
    if (wait > 0) {
      c.header('Retry-After', String(wait))
      return c.json({ error: 'rate_limited', retryAfter: wait }, 429)
    }
    await next()
    if (c.res.status === 401) {
      const delay = throttle.fail(key)
      if (delay > 0) c.res.headers.set('Retry-After', String(delay))
    } else if (c.res.status === 200) throttle.ok(key)
  }
}
