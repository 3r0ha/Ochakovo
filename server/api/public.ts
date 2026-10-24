import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { checkApplication, type ApplicationInput } from '@shared/applications'
import { contacts, myths, perks, steps } from '@shared/content/content'
import { departments } from '@shared/content/departments'
import { stages } from '@shared/content/production'
import { quiz } from '@shared/content/quiz'
import { vacancies } from '@shared/content/vacancies'
import { consentError, publicApplication, type ApplyError } from '@shared/applicationInput'
import type { SiteConfig } from '@shared/siteConfig'
import { acceptApplication } from '../candidate/intake'
import { botLinkFor, withdrawApplication } from '../candidate/rights'
import { statusForToken } from '../candidate/status'
import { normalizeApplication } from '../db'
import type { FunnelEventType } from '../db/hr'
import type { ApiDeps } from './index'

// Открытые маршруты сайта: контент, приём заявок и анонимные события воронки

/**
 * Белый список событий воронки. game_start — нажали «Играть», share — поделились; у них вид (kind): game, money
 * или invite — он ложится в колонку task (миграция 020). Очков, точности и всего прочего сервер не принимает и не хранит
 */
export const eventTypes = ['visit', 'task_done', 'apply_open', 'application', 'game_start', 'share'] as const
export type EventType = (typeof eventTypes)[number]
// company — первая попытка контрольных вопросов о компании (/game?t=quiz)
const tasks = ['game', 'money', 'quiz', 'myth', 'company']
const kinds = ['game', 'money', 'invite']

/** Тело события: случайный id браузера, тип, задание или вид и метка источника — без личных данных. null — 400 */
export function parseEvent(raw: unknown) {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  if (typeof e.visitor !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(e.visitor)) return null
  if (!eventTypes.includes(e.type as EventType)) return null
  const type = e.type as EventType
  let task: string | null = null
  if (type === 'task_done') {
    if (!tasks.includes(e.task as string)) return null
    task = e.task as string
  } else if (type === 'game_start' || type === 'share') {
    // «Играть» без вида — это «Поймай брак»; поделиться можно только известным
    const kind = e.kind ?? (type === 'game_start' ? 'game' : undefined)
    if (!kinds.includes(kind as string)) return null
    task = kind as string
  }
  const source = typeof e.source === 'string' && /^[\p{L}\p{N}_.:-]{1,64}$/u.test(e.source) ? e.source : null
  return { visitor: e.visitor, type, task, source }
}

/** Имя бота для ссылки t.me/<имя> или max.ru/<ник>: без @ и адреса; странное значение — как не заданное */
export function botName(raw: string | undefined, channel: 'telegram' | 'max'): string | null {
  const v = (raw ?? '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(channel === 'telegram' ? /^(t\.me|telegram\.me)\//i : /^(web\.)?max\.ru\//i, '')
    .replace(/^@/, '')
  const ok = channel === 'telegram' ? /^[A-Za-z][A-Za-z0-9_]{3,31}$/ : /^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$/
  return ok.test(v) ? v : null
}

/**
 * Настройки сайта во время работы: имя бота — только если его адаптер поднялся (bots.active()) и имя задано
 * в TELEGRAM_BOT_USERNAME или MAX_BOT_NICK. Иначе null, и сайт не показывает кнопку бота, которая никуда не ведёт
 */
export function siteConfig({ bots, env }: Pick<ApiDeps, 'bots' | 'env'>): SiteConfig {
  const active = new Set(bots.active())
  return {
    bots: {
      telegram: active.has('telegram') ? botName(env.TELEGRAM_BOT_USERNAME, 'telegram') : null,
      max: active.has('max') ? botName(env.MAX_BOT_NICK, 'max') : null,
    },
    assistant: env.GIGACHAT_AUTH_KEY ? 'gigachat' : 'offline',
  }
}

export function publicRoutes({ storage, repo, bots, env }: Pick<ApiDeps, 'storage' | 'repo' | 'bots' | 'env'>) {
  const app = new Hono()

  // GET /api/config → SiteConfig (shared/siteConfig.ts): имена ботов и режим помощника, без секретов. Кэш — минута
  app.get('/api/config', (c) => c.json(siteConfig({ bots, env }), 200, { 'cache-control': 'public, max-age=60' }))

  app.get('/api/content', (c) =>
    c.json({ vacancies, departments, quiz, myths, perks, steps, contacts, stages }, 200, {
      'cache-control': 'public, max-age=300',
    }),
  )

  // POST /api/applications — заявка из формы на сайте. Ответы (shared/applicationInput.ts):
  // 201 — заявка без полей HR; 422 {error:'validation', errors, codes} — поля или согласие (errors.consent).
  // Обязательны поля кейса: фамилия, имя, дата рождения (с 18 лет: codes.birthDate — underage или bad_birth_date),
  // вуз или колледж или «Уже не учусь», когда может выйти (и месяц при «С определённого месяца»);
  // 409 {error:'already_applied'} — тот же телефон или ник за последние 10 минут, без номера и токена той заявки;
  // 429 {error:'phone_limit', retryAfter} и Retry-After — больше трёх заявок с одного телефона или ника за час.
  // Лимит по IP (429 rate_limited) ставит server/middleware/rate-limit.ts
  app.post('/api/applications', bodyLimit({ maxSize: 32 * 1024 }), async (c) => {
    const raw = (await c.req.json().catch(() => null)) as Partial<ApplicationInput> | null
    if (!raw || typeof raw !== 'object') return c.json({ error: 'invalid-json' }, 400)
    // С сайта приходят только заявки из формы: канал, id пользователя бота и источник согласия задаёт сервер
    const input = normalizeApplication({ ...raw, channel: 'web', channelUserId: undefined, consentSource: 'site_form' })
    // Портфолио и дату рождения проверяем как ввели: нормализация молча отбрасывает неверную ссылку и нечитаемую дату
    const { errors, codes } = checkApplication(
      { ...input, portfolio: typeof raw.portfolio === 'string' ? raw.portfolio : '', birthDate: typeof raw.birthDate === 'string' ? raw.birthDate : '' },
      { candidate: true },
    )
    const consent = consentError(input)
    if (consent) errors.consent = consent
    if (Object.keys(errors).length) return c.json({ error: 'validation', errors, codes } satisfies ApplyError, 422)

    const result = await acceptApplication(storage, input)
    if (!result.ok && result.error === 'already_applied') return c.json({ error: 'already_applied' } satisfies ApplyError, 409)
    if (!result.ok) return c.json({ error: 'phone_limit', retryAfter: result.retryAfter } satisfies ApplyError, 429, { 'Retry-After': String(result.retryAfter) })
    // Кандидату не нужны поля отдела персонала
    return c.json(publicApplication(result.application), 201)
  })

  // GET /api/applications/:id/status, заголовок x-status-token — статус заявки для самого кандидата.
  // Неизвестный номер, чужой токен, старая заявка без токена, обезличенная — одинаково 404
  app.get('/api/applications/:id/status', async (c) => {
    c.header('cache-control', 'no-store')
    const token = c.req.header('x-status-token') ?? ''
    const status = await statusForToken(storage.sql, c.req.param('id'), token)
    return status ? c.json(status) : c.json({ error: 'not_found' }, 404)
  })

  // ── Права кандидата: заголовок x-status-token, как у статуса. Чужой ключ и удалённая заявка — одинаково 404 ──

  // POST /api/applications/:id/withdraw — «Отозвать согласие и удалить заявку»: личные данные стираются сразу,
  // задачи HR по заявке снимаются, в журнале удаления — «кандидат». Дальше статус по этому ключу — 404
  app.post('/api/applications/:id/withdraw', async (c) => {
    c.header('cache-control', 'no-store')
    const done = await withdrawApplication(storage, c.req.param('id'), c.req.header('x-status-token') ?? '')
    return done ? c.json({ status: 'withdrawn' }) : c.json({ error: 'not_found' }, 404)
  })

  // POST /api/applications/:id/bot-link → {telegram?, max?} — только диплинки с одноразовым кодом привязки (сутки).
  // Только для поднявшихся ботов с заданным именем, как кнопки в /api/config; ботов нет — 404. Лимит — в rate-limit.ts
  app.post('/api/applications/:id/bot-link', async (c) => {
    c.header('cache-control', 'no-store')
    const links = await botLinkFor(storage, c.req.param('id'), c.req.header('x-status-token') ?? '', siteConfig({ bots, env }).bots)
    return links ? c.json(links) : c.json({ error: 'not_found' }, 404)
  })

  // POST /api/events {visitor, type: visit|task_done|apply_open|application|game_start|share, task?, kind?, source?}
  // Принимает и обычный JSON, и navigator.sendBeacon (text/plain). Отвечает 204 без тела.
  app.post('/api/events', bodyLimit({ maxSize: 2 * 1024 }), async (c) => {
    const text = await c.req.text().catch(() => '')
    let raw: unknown = null
    try {
      raw = JSON.parse(text)
    } catch {
      return c.json({ error: 'invalid-json' }, 400)
    }
    const event = parseEvent(raw)
    if (!event) return c.json({ error: 'invalid-event' }, 400)
    // Новые типы (game_start, share) база принимает с миграции 020; тип FunnelEventType в server/db/funnel.ts — у HR-воронки
    await repo.addEvent({ ...event, type: event.type as FunnelEventType })
    return c.body(null, 204)
  })

  return app
}
