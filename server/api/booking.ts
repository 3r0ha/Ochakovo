import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { requireHr } from '../auth/session'
import {
  book,
  bookingDeps,
  bookingState,
  cancelBooking,
  closeHiringDay,
  createHiringDay,
  listHiringDays,
  noneFits,
  offerBooking,
  offerInfo,
  openOffers,
  registerBookingRuntime,
  withdrawOffer,
} from '../booking'
import { EXPIRED_TEXT, INVALID_TEXT, NO_OFFER_TEXT, STARTED_TEXT, TAKEN_TEXT } from '../booking/text'
import { tokenMatches } from '../candidate/status'
import type { ApiDeps } from './index'
import { siteConfig } from './public'

// Самозапись на собеседование (w2-booking).
//
// HR (сессия панели, изменяющие запросы — с заголовком x-hr-request):
//   POST   /api/hr/booking/offer {ids}  «Предложить выбрать время» → {offered: [{id, notify, detail}], failed: [{id, error}]}
//   GET    /api/hr/booking              открытые предложения для списка: [{applicationId, state, expiresAt, noneAt, booked}]
//   GET    /api/hr/booking/:id          предложение по заявке для карточки: состояние, кто и когда, какие часы видит кандидат
//   DELETE /api/hr/booking/:id          отозвать предложение (назначенное собеседование остаётся)
//   GET    /api/hr/booking/days         дни найма: часы, места, сколько записано по часам, ссылки с меткой дня
//   POST   /api/hr/booking/days         {day: ГГГГ-ММ-ДД, hours: [10, 11], capacity, address?, label?, note?} → 201 {day}
//   DELETE /api/hr/booking/days/:id     отменить день найма: по ссылке больше не записываются
//
// День найма: заявка с меткой дня (/?src=hiringday, в боте start=hiringday) сразу получает выбор часа этого дня.
//
// Кандидат (заголовок x-status-token, как у статуса; чужой ключ и удалённая заявка — одинаково 404):
//   GET    /api/applications/:id/booking       {offered, hours: ISO[], booked: ISO|null, address, bring, expiresAt, noneAt}
//   POST   /api/applications/:id/booking       {startsAt} — записаться или перенести. 409 taken — «Это время уже заняли»
//                                              и свежие hours; 422 invalid — не из рабочих часов; 410 — предложения нет
//   DELETE /api/applications/:id/booking       отменить запись — место освобождается. 409 started — уже началось
//   POST   /api/applications/:id/booking/none  «Ни одно время не подходит — позвоните»: задача HR «перезвонить»
//
// Без предложения HR выбрать время нельзя, срок ответа HR не меняется.

export function routes(deps: ApiDeps): Hono {
  const app = new Hono()
  const hr = requireHr(deps.repo)
  const json = bodyLimit({ maxSize: 16 * 1024 })
  const bigJson = bodyLimit({ maxSize: 64 * 1024 })
  const b = bookingDeps(deps.storage.sql, deps.bots, deps.env)
  // Бот на этой же базе ставит напоминания в те же боты, что и панель
  registerBookingRuntime(deps.storage.sql, { bots: deps.bots, env: deps.env })

  // ── HR ────────────────────────────────────────────────────────────────

  app.post('/api/hr/booking/offer', hr, bigJson, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { ids?: unknown } | null
    const ids = Array.isArray(body?.ids) ? [...new Set(body.ids.filter((x): x is string => typeof x === 'string' && x.length <= 16))].slice(0, 500) : []
    if (!ids.length) return c.json({ error: 'validation', message: 'Выбери хотя бы одну заявку' }, 422)
    return c.json(await offerBooking(b, ids, c.get('hrUser')))
  })

  app.get('/api/hr/booking', hr, async (c) => c.json(await openOffers(b)))

  /** Ссылки дня найма: сайт с меткой и боты, если подключены */
  const links = (label: string) => {
    const names = siteConfig({ bots: deps.bots, env: deps.env }).bots
    return {
      site: `${b.siteUrl.replace(/\/$/, '')}/?src=${label}`,
      ...(names.telegram ? { telegram: `https://t.me/${names.telegram}?start=${label}` } : {}),
      ...(names.max ? { max: `https://max.ru/${names.max}?start=${label}` } : {}),
    }
  }

  // Маршруты дней найма — раньше /api/hr/booking/:id, иначе «days» примется за номер заявки
  app.get('/api/hr/booking/days', hr, async (c) => c.json((await listHiringDays(b)).map((d) => ({ ...d, links: links(d.label) }))))

  app.post('/api/hr/booking/days', hr, json, async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return c.json({ error: 'invalid-json' }, 400)
    const r = await createHiringDay(b, body, c.get('hrUser'))
    if (!r.ok) return c.json({ error: 'validation', message: r.message }, 422)
    return c.json({ day: { ...r.day, links: links(r.day.label) } }, 201)
  })

  app.delete('/api/hr/booking/days/:id', hr, async (c) => {
    const id = Number(c.req.param('id'))
    return c.json({ closed: Number.isInteger(id) && id > 0 ? await closeHiringDay(b, id) : false })
  })

  app.get('/api/hr/booking/:id', hr, async (c) => {
    const info = await offerInfo(b, c.req.param('id'))
    return info ? c.json(info) : c.json({ error: 'not_found' }, 404)
  })

  app.delete('/api/hr/booking/:id', hr, async (c) => c.json({ withdrawn: await withdrawOffer(b, c.req.param('id'), c.get('hrUser')) }))

  // ── Кандидат ──────────────────────────────────────────────────────────

  /** Ключ из браузера подходит к заявке; иначе 404 без подробностей */
  const candidate = async (c: Context) => {
    c.header('cache-control', 'no-store')
    const id = c.req.param('id') ?? ''
    return (await tokenMatches(deps.storage.sql, id, c.req.header('x-status-token') ?? '')) ? id : null
  }
  const gone = (c: Context) => c.json({ error: 'not_found' }, 404)
  /** Ответ кандидату без служебного состояния: часы, запись, адрес */
  const publicState = async (id: string) => {
    const { applicationId: _id, vacancyId: _v, ...rest } = await bookingState(b, id)
    return rest
  }

  app.get('/api/applications/:id/booking', async (c) => {
    const id = await candidate(c)
    return id ? c.json(await publicState(id)) : gone(c)
  })

  app.post('/api/applications/:id/booking', json, async (c) => {
    const id = await candidate(c)
    if (!id) return gone(c)
    const body = (await c.req.json().catch(() => null)) as { startsAt?: unknown } | null
    const startsAt = typeof body?.startsAt === 'string' ? new Date(body.startsAt) : null
    if (!startsAt || Number.isNaN(startsAt.getTime())) return c.json({ error: 'invalid', message: INVALID_TEXT }, 422)
    const r = await book(b, id, startsAt, 'site')
    if (r.ok) return c.json({ ...(await publicState(id)), startsAt: r.startsAt, moved: r.moved })
    if (r.error === 'taken') return c.json({ error: 'taken', message: TAKEN_TEXT, hours: r.hours }, 409)
    if (r.error === 'invalid') return c.json({ error: 'invalid', message: INVALID_TEXT, hours: r.hours }, 422)
    return c.json({ error: r.error, message: r.error === 'expired' ? EXPIRED_TEXT : NO_OFFER_TEXT }, 410)
  })

  app.delete('/api/applications/:id/booking', async (c) => {
    const id = await candidate(c)
    if (!id) return gone(c)
    const r = await cancelBooking(b, id, 'site')
    if (r.ok) return c.json(await publicState(id))
    if (r.error === 'started') return c.json({ error: 'started', message: STARTED_TEXT }, 409)
    return c.json({ error: 'no_booking', message: 'Записи на собеседование нет' }, 410)
  })

  app.post('/api/applications/:id/booking/none', async (c) => {
    const id = await candidate(c)
    if (!id) return gone(c)
    const r = await noneFits(b, id)
    if (r.ok) return c.json({ ok: true, repeated: r.repeated })
    return c.json({ error: r.error, message: r.error === 'expired' ? EXPIRED_TEXT : NO_OFFER_TEXT }, 410)
  })

  return app
}
