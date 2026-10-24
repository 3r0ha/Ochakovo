import { createHash, timingSafeEqual } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { REF_CODE_RE } from '@shared/applicationInput'
import { mediaRoots, mediaUrl, type MediaRoot } from '../channels/media'
import type { Registry } from '../channels/registry'
import { ChatQueue } from '../channels/render'
import type { Channel, DialogEngine, DialogEvent, DialogReply, DialogUser, HandleMeta, SiteProgress } from '../dialog/types'
import { clientIp } from '../middleware/client-ip'

// Единый диалоговый API, картинки для веб-чата и вебхуки мессенджеров

const channels: Channel[] = ['telegram', 'max', 'web']

/**
 * Снаружи /api/dialog открыт только чату на сайте (channel: 'web'). Боты Telegram и MAX зовут движок
 * внутри процесса. Иначе любой мог бы назваться чужим id из Telegram — id не секрет — и узнать статус
 * его заявки или отправить заявку от его имени. Для внешнего канала — серверный токен DIALOG_API_TOKEN
 * (от 24 символов) в заголовке x-dialog-token
 */
function trustedCaller(c: Context, env: NodeJS.ProcessEnv = process.env) {
  const configured = env.DIALOG_API_TOKEN ?? ''
  if (configured.length < 24) return false
  const given = Buffer.from(c.req.header('x-dialog-token') ?? '')
  const expected = Buffer.from(configured)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

// ── Картинки для веб-чата ────────────────────────────────────────────────
// Движок отдаёт картинки путями на диске; адреса /api/media/gen/… и /api/media/pub/… строит mediaUrl (server/channels/media.ts)

const mediaTypes: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
}

/** Файл внутри корня или null — никаких выходов через .. и абсолютные пути */
function insideRoot(base: string, rel: string): string | null {
  const file = resolve(base, rel)
  return file === base || !file.startsWith(base + sep) ? null : file
}

/** Ответ для веб-канала: вместо пути на диске — адрес картинки. Заявка из чата (application) уходит сайту как есть */
function forWeb(reply: DialogReply) {
  return {
    ...reply,
    messages: reply.messages.map(({ image, ...rest }) => {
      const url = image ? mediaUrl(image.path) : null
      return url ? { ...rest, image: { url } } : rest
    }),
  }
}

/** Ответ внешнему каналу: заявку с токеном отдаём только чату на сайте */
function forChannel(reply: DialogReply): DialogReply {
  const { application: _drop, ...rest } = reply
  return rest
}

/** Проверка тела /api/dialog: только известные типы событий и разумные длины */
function parseDialog(body: unknown): { user: DialogUser; event: DialogEvent } | null {
  if (!body || typeof body !== 'object') return null
  const { user, event } = body as { user?: Partial<DialogUser>; event?: Partial<DialogEvent> & Record<string, unknown> }
  if (!user || !channels.includes(user.channel as Channel) || typeof user.id !== 'string' || !user.id || user.id.length > 64) return null
  const str = (v: unknown, max: number) => typeof v === 'string' && v.length <= max
  const cleanUser: DialogUser = {
    channel: user.channel as Channel,
    id: user.id,
    firstName: str(user.firstName, 64) ? user.firstName : undefined,
    username: str(user.username, 64) ? user.username : undefined,
  }
  if (!event) return null
  switch (event.type) {
    case 'start':
      return { user: cleanUser, event: { type: 'start', payload: str(event.payload, 64) ? (event.payload as string) : undefined } }
    case 'action':
      return str(event.action, 64) ? { user: cleanUser, event: { type: 'action', action: event.action as string } } : null
    case 'text':
      return str(event.text, 4096) ? { user: cleanUser, event: { type: 'text', text: event.text as string } } : null
    case 'contact':
      return str(event.phone, 32) ? { user: cleanUser, event: { type: 'contact', phone: event.phone as string } } : null
    default:
      return null
  }
}

/** Прогресс заданий с сайта: только известные поля разумного вида, остальное отбрасываем */
function parseSiteProgress(raw: unknown): SiteProgress | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const out: SiteProgress = {}
  for (const key of ['game', 'money', 'quiz', 'myth'] as const) if (r[key] === true) out[key] = true
  if (typeof r.quizVacancy === 'string' && /^[a-z0-9-]{1,64}$/.test(r.quizVacancy)) out.quizVacancy = r.quizVacancy
  if (Array.isArray(r.months)) {
    const months = [...new Set(r.months.filter((m): m is number => Number.isInteger(m) && m >= 3 && m <= 9))].sort((a, b) => a - b)
    if (months.length) out.months = months
  }
  if (Number.isInteger(r.conveyorBest) && (r.conveyorBest as number) >= 0 && (r.conveyorBest as number) <= 1000) out.conveyorBest = r.conveyorBest as number
  return Object.keys(out).length ? out : undefined
}

/** Данные чата на сайте: прогресс заданий, заявка этого браузера и его код приглашения. Каждое поле — в теле или в meta */
function parseWebMeta(body: unknown): HandleMeta | undefined {
  const b = body as { siteProgress?: unknown; application?: unknown; refCode?: unknown; meta?: { application?: unknown; refCode?: unknown } }
  const siteProgress = parseSiteProgress(b.siteProgress)
  // Заявка этого браузера для «Что с моей заявкой»: {id, token}
  const rawApp = b.application ?? b.meta?.application
  const application =
    rawApp && typeof rawApp === 'object' && typeof (rawApp as { id?: unknown }).id === 'string' && typeof (rawApp as { token?: unknown }).token === 'string'
      ? { id: String((rawApp as { id: string }).id).slice(0, 16), token: String((rawApp as { token: string }).token).slice(0, 64) }
      : undefined
  // Личный код приглашения браузера (src/lib/ref.ts): кривой код отбрасываем, запрос всё равно обрабатываем
  const rawRef = b.refCode ?? b.meta?.refCode
  const refCode = typeof rawRef === 'string' && REF_CODE_RE.test(rawRef) ? rawRef : undefined
  const meta: HandleMeta = { ...(siteProgress ? { siteProgress } : {}), ...(application ? { application } : {}), ...(refCode ? { refCode } : {}) }
  return Object.keys(meta).length ? meta : undefined
}

/** Сколько нажатий в минуту принимаем от одного чата: живой человек столько не делает, скрипт упрётся */
export const CHAT_PRESSES_PER_MINUTE = 40

/**
 * Лимит «perMinute в минуту» по ключу: ведро на perMinute запросов, которое пополняется с той же скоростью.
 * Отдаёт null, если запрос принят, или через сколько секунд повторить
 */
function minuteLimiter(perMinute: number, now: () => number) {
  const buckets = new Map<string, { tokens: number; updated: number }>()
  // Раз в минуту выбрасываем полные вёдра, чтобы память не росла от одноразовых чатов и адресов
  const sweep = setInterval(() => {
    const t = now()
    for (const [key, b] of buckets) if (b.tokens + ((t - b.updated) / 60_000) * perMinute >= perMinute) buckets.delete(key)
  }, 60_000)
  sweep.unref?.()
  return (key: string): number | null => {
    const t = now()
    const b = buckets.get(key) ?? { tokens: perMinute, updated: t }
    b.tokens = Math.min(perMinute, b.tokens + ((t - b.updated) / 60_000) * perMinute)
    b.updated = t
    buckets.set(key, b)
    if (b.tokens < 1) return Math.max(1, Math.ceil(((1 - b.tokens) / perMinute) * 60))
    b.tokens -= 1
    return null
  }
}

/** Неудачные запросы к вебхукам с одного адреса в минуту; верные запросы мессенджера не ограничиваются */
const WEBHOOK_FAILURES_PER_MINUTE = 30

/** Сравнение секретов за постоянное время: сравниваем хеши, так длина секрета тоже не утекает */
function sameSecret(given: string, expected: string) {
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b) && given.length > 0
}

type DialogRoutesDeps = {
  engine: DialogEngine | null
  bots: Registry
  /** Часы для лимитов — подменяются в проверках */
  now?: () => number
  /** Сколько нажатий в минуту принимать от одного чата */
  chatPerMinute?: number
}

export function dialogRoutes({ engine, bots, now = Date.now, chatPerMinute = CHAT_PRESSES_PER_MINUTE }: DialogRoutesDeps) {
  const app = new Hono()
  // Запросы одного чата идут по очереди, как у адаптеров мессенджеров: два быстрых «Отправить» не создают две заявки
  const queue = new ChatQueue()
  const perChat = minuteLimiter(chatPerMinute, now)

  // POST /api/dialog {user:{channel,id,firstName?,username?}, event:{type:'start'|'action'|'text'|'contact',…}, siteProgress?, application?, refCode?}
  // → DialogReply {messages:[{text, image?, buttons?, replace?, input?}], notice?, application?}
  // Его зовёт чат на сайте; другой канал снаружи — только с серверным токеном (trustedCaller).
  // Больше CHAT_PRESSES_PER_MINUTE нажатий в минуту из одного чата → 429 {error:'rate_limited', retryAfter} и Retry-After.
  app.post('/api/dialog', bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
    if (!engine) return c.json({ error: 'engine-unavailable' }, 503)
    const body = await c.req.json().catch(() => null)
    const parsed = parseDialog(body)
    if (!parsed) return c.json({ error: 'invalid-dialog-request' }, 400)
    const web = parsed.user.channel === 'web'
    if (!web && !trustedCaller(c)) return c.json({ error: 'forbidden_channel' }, 403)

    const key = `${parsed.user.channel}:${parsed.user.id}`
    const retryAfter = perChat(key)
    if (retryAfter !== null) {
      c.header('Retry-After', String(retryAfter))
      return c.json({ error: 'rate_limited', retryAfter }, 429)
    }

    const meta = web ? parseWebMeta(body) : undefined
    const reply = await queue.run(key, () => engine.handle(parsed.user, parsed.event, meta))
    return c.json(web ? forWeb(reply) : forChannel(reply))
  })

  // Картинки веб-чата: GET /api/media/gen/<путь> и /api/media/pub/<путь>
  app.get('/api/media/:root/*', async (c) => {
    const key = c.req.param('root') as MediaRoot
    const base = mediaRoots[key]
    if (!base) return c.notFound()
    let rel: string
    try {
      rel = decodeURIComponent(c.req.path.slice(`/api/media/${key}/`.length))
    } catch {
      return c.notFound()
    }
    const type = mediaTypes[extname(rel).toLowerCase()]
    const file = type ? insideRoot(base, rel) : null
    if (!file || !existsSync(file) || !statSync(file).isFile()) return c.notFound()
    return c.body(await readFile(file), 200, { 'content-type': type, 'cache-control': 'public, max-age=86400' })
  })

  // ── Вебхуки мессенджеров ──────────────────────────────────────────────

  // Принимаем только запросы с секретом, который сервер передал мессенджеру при регистрации вебхука.
  // Без PUBLIC_URL секрета нет (бот опрашивает API сам) — тогда и без токена бота любой запрос получает 403.
  // Лимит считает только отклонённые запросы: верные апдейты мессенджера не задерживаются никогда.
  const failures = minuteLimiter(WEBHOOK_FAILURES_PER_MINUTE, now)

  const webhook = (channel: 'telegram' | 'max', secretHeader: string) => async (c: Context) => {
    const entry = bots.get(channel)
    const secret = entry?.secret
    const ok = Boolean(entry && engine && secret && sameSecret(c.req.header(secretHeader) ?? '', secret) && (entry.adapter.verifyWebhook?.(c.req.raw.headers) ?? true))
    if (!ok || !entry || !engine) {
      const retryAfter = failures(clientIp(c))
      if (retryAfter !== null) {
        c.header('Retry-After', String(retryAfter))
        return c.json({ error: 'rate_limited', retryAfter }, 429)
      }
      return c.json({ error: 'forbidden' }, 403)
    }
    const { adapter } = entry
    const body = await c.req.json().catch(() => null)
    // Мессенджеру сразу отвечаем 200, иначе он будет повторять доставку; ошибки — в лог
    adapter.handleWebhook(engine, body).catch((e) => console.error(`[bots] ${channel}: ошибка обработки вебхука`, e))
    return c.json({ ok: true })
  }

  app.post('/bots/telegram', bodyLimit({ maxSize: 1024 * 1024 }), webhook('telegram', 'x-telegram-bot-api-secret-token'))
  app.post('/bots/max', bodyLimit({ maxSize: 1024 * 1024 }), webhook('max', 'x-max-bot-api-secret'))

  return app
}
