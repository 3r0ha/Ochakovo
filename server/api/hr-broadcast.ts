import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { requireHr } from '../auth/session'
import {
  audienceOf,
  broadcastKinds,
  broadcastMessage,
  broadcastSegments,
  getBroadcast,
  getRecruit,
  kindsAvailable,
  listBroadcasts,
  recipients,
  recruitProblem,
  sendableChannels,
  setRecruit,
  startBroadcast,
  subscribers,
  todayMsk,
  type BroadcastDeps,
  type BroadcastKind,
  type BroadcastSegment,
  type Recruit,
} from '../channels/broadcast'
import { renderOutgoing } from '../channels/preview'
import type { ApiDeps } from './index'

// Рассылка подписавшимся на «Напомнить о наборе» и журнал доставки. Только администратор.
//   GET  /api/hr/broadcast            — состояние набора, какие сообщения доступны, подключённые боты, подписчики, журнал
//   PUT  /api/hr/broadcast/recruit    — {state:'open'|'closed', endsOn:'ГГГГ-ММ-ДД'|null} — состояние набора и срок
//   POST /api/hr/broadcast/preview    — {kind, segment, dept?} → текст, вид в Telegram и MAX, сколько получат
//   POST /api/hr/broadcast            — {kind, segment, dept?} → 202 и запись журнала; отправка идёт в фоне
//   GET  /api/hr/broadcast/:id        — запись журнала (ход отправки)
// 422 {error, message} — сообщение сейчас недоступно, некому отправить или нет направления; 409 — рассылка уже идёт.

/** Разбор сообщения и сегмента из тела запроса */
function parseRequest(raw: unknown): { kind: BroadcastKind; segment: BroadcastSegment; dept: string | null } | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!broadcastKinds.includes(r.kind as BroadcastKind) || !broadcastSegments.includes(r.segment as BroadcastSegment)) return null
  const dept = r.segment === 'dept' && typeof r.dept === 'string' ? r.dept.slice(0, 32) : null
  return { kind: r.kind as BroadcastKind, segment: r.segment as BroadcastSegment, dept }
}

export function routes({ storage, repo, bots }: ApiDeps, opts: Partial<Pick<BroadcastDeps, 'batch' | 'pauseMs'>> = {}): Hono {
  const app = new Hono()
  const sql = storage.sql
  const admin = requireHr(repo, ['admin'])
  const json = bodyLimit({ maxSize: 4 * 1024 })
  const deps: BroadcastDeps = { sql, bots, ...opts }

  const state = async (recruit?: Recruit) => {
    const r = recruit ?? (await getRecruit(sql))
    const online = sendableChannels(bots)
    return { recruit: r, kinds: kindsAvailable(r), channels: { telegram: online.includes('telegram'), max: online.includes('max') } }
  }

  app.get('/api/hr/broadcast', admin, async (c) => {
    const [base, subs, list] = await Promise.all([state(), subscribers(sql), listBroadcasts(sql)])
    return c.json({ ...base, subscribers: subs, broadcasts: list })
  })

  app.put('/api/hr/broadcast/recruit', admin, json, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { state?: unknown; endsOn?: unknown } | null
    if (!body) return c.json({ error: 'invalid_json' }, 400)
    const problem = recruitProblem(body, todayMsk())
    if (problem) return c.json({ error: 'validation', message: problem, errors: { recruit: problem } }, 422)
    const endsOn = typeof body.endsOn === 'string' && body.endsOn ? body.endsOn : null
    const recruit = await setRecruit(sql, { state: body.state as Recruit['state'], endsOn }, c.get('hrUser').name)
    return c.json(await state(recruit))
  })

  app.post('/api/hr/broadcast/preview', admin, json, async (c) => {
    const req = parseRequest(await c.req.json().catch(() => null))
    if (!req) return c.json({ error: 'invalid_request' }, 400)
    const recruit = await getRecruit(sql)
    const message = broadcastMessage(req.kind, { dept: req.dept, daysLeft: recruit.daysLeft })
    const audience = audienceOf(await recipients(sql, req), sendableChannels(bots))
    return c.json({
      text: message.text,
      unavailable: kindsAvailable(recruit)[req.kind],
      audience,
      views: { telegram: renderOutgoing('telegram', [message]), max: renderOutgoing('max', [message]) },
    })
  })

  app.post('/api/hr/broadcast', admin, json, async (c) => {
    const req = parseRequest(await c.req.json().catch(() => null))
    if (!req) return c.json({ error: 'invalid_request' }, 400)
    const user = c.get('hrUser')
    const result = await startBroadcast(deps, { ...req, user: { id: user.id || null, name: user.name } })
    if (!result.ok) return c.json({ error: result.error, message: result.message, audience: result.audience }, result.error === 'busy' ? 409 : 422)
    return c.json({ broadcast: result.broadcast, audience: result.audience }, 202)
  })

  app.get('/api/hr/broadcast/:id', admin, async (c) => {
    const id = Number(c.req.param('id'))
    const entry = Number.isInteger(id) && id > 0 ? await getBroadcast(sql, id) : null
    return entry ? c.json(entry) : c.json({ error: 'not_found' }, 404)
  })

  return app
}
