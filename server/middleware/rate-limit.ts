import type { Context, MiddlewareHandler } from 'hono'
import { clientIp } from './client-ip'

// Ограничение частоты запросов: «ведро с жетонами» на пару (правило, IP).
// Хранится в памяти процесса — при нескольких экземплярах лимит считается на каждый отдельно.

export type RateRule = {
  /** Имя правила — попадает в ключ и в лог */
  name: string
  /** Сколько запросов можно сделать подряд */
  burst: number
  /** Сколько жетонов возвращается в минуту */
  perMinute: number
  /** Какие запросы считает правило */
  match: (method: string, path: string) => boolean
}

type Bucket = { tokens: number; updated: number }

// На ярмарке и в общежитии весь зал выходит в интернет с одного адреса Wi-Fi. Поэтому по IP — только потолки
// от шквала запросов, а повторы и лимит заявок одного человека считаются по телефону или нику (server/candidate/intake.ts)
export const defaultRules: RateRule[] = [
  // Заявки: 30 подряд с одного адреса (очередь у стенда), дальше 10 в минуту
  { name: 'applications', burst: 30, perMinute: 10, match: (m, p) => m === 'POST' && p === '/api/applications' },
  // Вход в HR-панель: подбор пароля
  { name: 'hr-login', burst: 5, perMinute: 0.5, match: (m, p) => m === 'POST' && p === '/api/hr/login' },
  // Диалог: потолок 400 в минуту на адрес. Частоту одного чата ограничивает server/api/dialog.ts
  { name: 'dialog', burst: 400, perMinute: 400, match: (m, p) => m === 'POST' && p === '/api/dialog' },
  // Статус заявки: страница спрашивает его при открытии и при возвращении на вкладку
  { name: 'application-status', burst: 60, perMinute: 60, match: (m, p) => m === 'GET' && /^\/api\/applications\/[^/]+\/status$/.test(p) },
  // Права кандидата по ключу заявки: отзыв согласия и ссылка на бота (новая ссылка гасит прежнюю)
  { name: 'withdraw', burst: 10, perMinute: 5, match: (m, p) => m === 'POST' && /^\/api\/applications\/[^/]+\/withdraw$/.test(p) },
  { name: 'bot-link', burst: 20, perMinute: 6, match: (m, p) => m === 'POST' && /^\/api\/applications\/[^/]+\/bot-link$/.test(p) },
  // Самозапись: запись, перенос, отмена и «ни одно не подходит» — как у отзыва; список часов — как у статуса
  { name: 'booking', burst: 20, perMinute: 10, match: (m, p) => (m === 'POST' || m === 'DELETE') && /^\/api\/applications\/[^/]+\/booking(\/none)?$/.test(p) },
  { name: 'booking-read', burst: 60, perMinute: 60, match: (m, p) => m === 'GET' && /^\/api\/applications\/[^/]+\/booking$/.test(p) },
  // «Как дела на смене» на странице «Моя заявка»: ответ и «Пусть HR позвонит»
  { name: 'checkin', burst: 20, perMinute: 10, match: (m, p) => m === 'POST' && /^\/api\/applications\/[^/]+\/checkin(\/call)?$/.test(p) },
  // Картинки чата
  { name: 'media', burst: 120, perMinute: 240, match: (m, p) => m === 'GET' && p.startsWith('/api/media/') },
  // Остальной API: контент, события воронки, HR-панель
  { name: 'api', burst: 300, perMinute: 600, match: (_m, p) => p.startsWith('/api/') && !p.startsWith('/api/health') },
]

export function rateLimit(rules: RateRule[] = defaultRules, now: () => number = Date.now): MiddlewareHandler {
  const buckets = new Map<string, Bucket>()

  // Раз в минуту выбрасываем полностью восстановившиеся вёдра, чтобы память не росла
  const sweep = setInterval(() => {
    const t = now()
    for (const [key, b] of buckets) {
      const rule = rules.find((r) => key.startsWith(`${r.name}|`))
      if (!rule || b.tokens + ((t - b.updated) / 60_000) * rule.perMinute >= rule.burst) buckets.delete(key)
    }
  }, 60_000)
  sweep.unref()

  return async (c: Context, next) => {
    const rule = rules.find((r) => r.match(c.req.method, c.req.path))
    if (!rule) return next()

    const key = `${rule.name}|${clientIp(c)}`
    const t = now()
    const b = buckets.get(key) ?? { tokens: rule.burst, updated: t }
    b.tokens = Math.min(rule.burst, b.tokens + ((t - b.updated) / 60_000) * rule.perMinute)
    b.updated = t

    if (b.tokens < 1) {
      buckets.set(key, b)
      const retry = Math.max(1, Math.ceil(((1 - b.tokens) / rule.perMinute) * 60))
      c.header('Retry-After', String(retry))
      c.set('rateLimited', rule.name)
      return c.json({ error: 'rate_limited', retryAfter: retry }, 429)
    }

    b.tokens -= 1
    buckets.set(key, b)
    await next()
  }
}
