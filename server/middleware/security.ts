import type { MiddlewareHandler } from 'hono'
import { log } from './logging'

// Заголовки безопасности и защита от запросов с чужих сайтов.

/** ID счётчиков из окружения. null у счётчика — он выключен */
export type AnalyticsIds = { metrika: string | null; vk: string | null }

type SecurityOptions = {
  /** Разрешённые источники (origin) для изменяющих запросов: адрес сайта и т. п. */
  allowedOrigins: string[]
  /** Счётчики: домены Яндекс Метрики и пикселя VK Рекламы попадают в CSP, только если задан их ID */
  analytics?: AnalyticsIds | null
  /** Отдавать HSTS — только когда сайт открыт по HTTPS */
  hsts: boolean
}

/** ID счётчика — только цифры: в метатег, адрес скрипта и CSP не попадёт ничего постороннего (как в src/lib/analytics.ts) */
const ID_RE = /^\d{4,12}$/

/**
 * Счётчики из METRIKA_ID и VK_PIXEL_ID (VITE_METRIKA_ID — прежнее имя). Пересборка сайта не нужна: сервер сам
 * ставит метатег analytics в страницу и открывает домены в CSP. Нет ни одного ID — null: ни метатега, ни доменов
 */
export function analyticsFromEnv(env: NodeJS.ProcessEnv): AnalyticsIds | null {
  const pick = (name: string, raw: string | undefined) => {
    const v = raw?.trim() ?? ''
    if (!v) return null
    if (ID_RE.test(v)) return v
    log('warn', 'analytics', { note: `${name} — не номер счётчика (от 4 до 12 цифр), счётчик выключен` })
    return null
  }
  const ids = { metrika: pick('METRIKA_ID', env.METRIKA_ID || env.VITE_METRIKA_ID), vk: pick('VK_PIXEL_ID', env.VK_PIXEL_ID) }
  return ids.metrika || ids.vk ? ids : null
}

/** Метатег для src/lib/analytics.ts: <meta name="analytics" content='{"metrika":…,"vk":…}'> */
export const analyticsMeta = (ids: AnalyticsIds) => `<meta name="analytics" content='${JSON.stringify({ metrika: ids.metrika, vk: ids.vk })}' />`

// Домены счётчиков. Метрика: скрипт tag.js и хиты на mc.yandex.ru (.com — для посетителей не из России),
// yastatic.net — её модули; вебвизор выключен (src/lib/analytics.ts), но соединение wss Метрика открывает и без него.
// Пиксель VK Рекламы: скрипт code.js и хиты на top-fwz1.mail.ru, у части кабинетов — top-fragment.mail.ru
const METRIKA = ['https://mc.yandex.ru', 'https://mc.yandex.com']
const METRIKA_SCRIPTS = [...METRIKA, 'https://yastatic.net']
const METRIKA_WS = ['wss://mc.yandex.ru', 'wss://mc.yandex.com']
const VK = ['https://top-fwz1.mail.ru', 'https://top-fragment.mail.ru']

/** Политика CSP. Без счётчиков — только свой сайт; домены каждого счётчика — только при его ID */
export function csp(analytics: AnalyticsIds | null = null) {
  const ym = Boolean(analytics?.metrika)
  const vk = Boolean(analytics?.vk)
  const list = (...groups: (string[] | false)[]) => groups.flatMap((g) => (g ? g : [])).map((d) => ` ${d}`).join('')
  return [
    "default-src 'self'",
    `script-src 'self'${list(ym && METRIKA_SCRIPTS, vk && VK)}`,
    // Атрибуты style ставят React и motion; внешних стилей нет
    "style-src 'self' 'unsafe-inline'",
    // data: — размытые превью фото и SVG-иконки; blob: — картинки, которые собирает браузер
    `img-src 'self' data: blob:${list(ym && METRIKA, vk && VK)}`,
    "font-src 'self' data:",
    `connect-src 'self'${list(ym && METRIKA, ym && METRIKA_WS, vk && VK)}`,
    // Ролики «Смена изнутри» — со своего сайта (server/middleware/video.ts)
    "media-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(ym ? [`frame-src${list(METRIKA)}`] : []),
  ].join('; ')
}

/** Файлы, которые показывают на чужих сайтах: превью ссылок (public/og) и иконка для экрана «Домой» */
const shareable = (path: string) => path.startsWith('/og/') || path === '/apple-touch-icon.png'

export function securityHeaders({ analytics = null, hsts }: Omit<SecurityOptions, 'allowedOrigins'>): MiddlewareHandler {
  const policy = csp(analytics)
  return async (c, next) => {
    await next()
    const h = c.res.headers
    h.set('Content-Security-Policy', policy)
    h.set('X-Content-Type-Options', 'nosniff')
    h.set('X-Frame-Options', 'DENY')
    h.set('Referrer-Policy', 'strict-origin-when-cross-origin')
    h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()')
    h.set('Cross-Origin-Opener-Policy', 'same-origin')
    // Картинки превью ссылок и иконку забирают мессенджеры и чужие страницы — им можно, остальное только своему сайту
    h.set('Cross-Origin-Resource-Policy', shareable(c.req.path) ? 'cross-origin' : 'same-origin')
    if (hsts) h.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains')
    h.delete('X-Powered-By')
  }
}

/**
 * Только свой сайт. CORS-заголовки не выдаём вовсе — браузер не даст чужим страницам читать ответы.
 * Изменяющие запросы с заголовком Origin от чужого сайта отклоняем (защита от CSRF).
 * Запросы без Origin (curl, мессенджеры с вебхуками, сервер-сервер) пропускаем — у них свои проверки.
 */
export function sameOrigin({ allowedOrigins }: Pick<SecurityOptions, 'allowedOrigins'>): MiddlewareHandler {
  const allowed = new Set(allowedOrigins.map((o) => o.replace(/\/$/, '')))
  return async (c, next) => {
    const method = c.req.method
    if (method === 'OPTIONS') return c.body(null, 204)
    const origin = c.req.header('origin')
    const changes = method !== 'GET' && method !== 'HEAD'
    if (changes && origin && !c.req.path.startsWith('/bots/')) {
      const self = new URL(c.req.url).origin
      if (origin !== self && !allowed.has(origin)) return c.json({ error: 'forbidden_origin' }, 403)
    }
    await next()
  }
}

/** Источники, которым разрешено отправлять формы: сайт, публичный адрес и dev-сервер Vite */
export function originsFromEnv(env: NodeJS.ProcessEnv): string[] {
  const list = [env.SITE_URL, env.PUBLIC_URL, ...(env.ALLOWED_ORIGINS ?? '').split(',')]
    .map((s) => s?.trim())
    .filter((s): s is string => Boolean(s))
    .flatMap((s) => {
      try {
        return [new URL(s).origin]
      } catch {
        return []
      }
    })
  if (env.NODE_ENV !== 'production') list.push('http://localhost:5180', 'http://127.0.0.1:5180')
  return [...new Set(list)]
}
