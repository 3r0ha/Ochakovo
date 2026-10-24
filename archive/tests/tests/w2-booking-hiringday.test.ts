// День найма, w2-bk-3: особая дата с адресом, часами и местами в каждом часе; ссылка с меткой (/?src=hiringday,
// в боте start=hiringday); после заявки кандидат сам выбирает час. День с двумя часами по два места: пятый кандидат
// видит «мест нет». Оформление в тот же день не обещаем. Время — от текущего момента.
// Запуск: pnpm test w2-booking-hiringday (часть с PostgreSQL создаёт и удаляет свою базу)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CONSENT_VERSION, interviewDefaults, type HrApplication } from '../../shared/applications'
import { hourKey, mskAt, mskParts } from '../../shared/workdays'
import { createApp } from '../../server/app'
import { createAssistant } from '../../server/assistant/assistant'
import { hashPassword } from '../../server/auth/password'
import { bookingDeps, bookingState } from '../../server/booking'
import { hiringDayHours, hiringDayProblem, hiringHourProblem, isHiringLabel } from '../../server/booking/hours'
import { HIRING_NOTE, hiringFullText, offerMessage } from '../../server/booking/text'
import type { Adapter, Registry } from '../../server/channels/registry'
import { normalizeApplication, PostgresStorage } from '../../server/db'
import { HrRepo } from '../../server/db/hr'
import { createEngine } from '../../server/dialog/engine'
import type { DialogReply } from '../../server/dialog/types'
import { offlineProvider } from '../../server/llm/offline'
import type { RateRule } from '../../server/middleware/rate-limit'
import { serverSettled, withTestDb } from './_db'

process.env.HR_NOTIFY_DELAY_SECONDS = '0'

const DAY = 864e5
const SITE = 'https://season.example.ru'
const now = Date.now()
const tomorrow = mskParts(now + DAY).day
const birth = (years: number) => new Date(Date.now() - years * 365.25 * 864e5).toISOString().slice(0, 10)
const textOf = (r: DialogReply) => r.messages.map((m) => m.text).join('\n\n')
const hourActions = (r: DialogReply) => r.messages.flatMap((m) => (m.buttons ?? []).flat()).flatMap((b) => (b.kind === 'action' && /^b:\d/.test(b.action) ? [b.action] : []))

test('часы дня найма: только часы дня, места дня, до часа до начала; суббота — можно', () => {
  let sat = tomorrow
  while (mskParts(mskAt(sat, 12)).dow !== 6) sat = new Date(Date.parse(`${sat}T00:00:00Z`) + DAY).toISOString().slice(0, 10)
  const d = { day: sat, hours: [11, 10, 14], capacity: 2 }
  const all = hiringDayHours(d, { load: {}, now })
  assert.deepEqual(all.map((h) => mskParts(h).hour), [10, 11, 14], 'по порядку, в выходной тоже')
  const full = hiringDayHours(d, { load: { [hourKey(mskAt(sat, 10))]: 2, [hourKey(mskAt(sat, 11))]: 1 }, now })
  assert.deepEqual(full.map((h) => mskParts(h).hour), [11, 14], 'час с двумя записанными закрыт, с одним — открыт')
  assert.equal(hiringHourProblem(mskAt(sat, 10), d, now), null)
  assert.equal(hiringHourProblem(mskAt(sat, 12), d, now), 'off_hours')
  assert.equal(hiringHourProblem(new Date(mskAt(sat, 10).getTime() + DAY), d, now), 'off_day', 'воскресенье — не тот день')
  assert.equal(hiringHourProblem(new Date(mskAt(sat, 10).getTime() + 60e3), d, now), 'not_hour')
  // В сам день найма — до часа до начала
  const today = mskParts(now).day
  const soon = { day: today, hours: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23], capacity: 1 }
  for (const h of hiringDayHours(soon, { load: {}, now })) assert.ok(h.getTime() >= now + 3600e3)

  assert.equal(hiringDayProblem({ day: tomorrow, hours: [10, 11], capacity: 2 }, now), null)
  assert.match(hiringDayProblem({ day: mskParts(now - 2 * DAY).day, hours: [10], capacity: 2 }, now)!, /прошла/)
  assert.match(hiringDayProblem({ day: tomorrow, hours: [], capacity: 2 }, now)!, /часы/)
  assert.match(hiringDayProblem({ day: tomorrow, hours: [10, 10], capacity: 2 }, now)!, /без повторов/)
  assert.match(hiringDayProblem({ day: tomorrow, hours: [10], capacity: 0 }, now)!, /Мест в часе/)
  assert.match(hiringDayProblem({ day: 'завтра', hours: [10], capacity: 2 }, now)!, /дату/)
  assert.match(hiringDayProblem({ day: mskParts(now + 200 * DAY).day, hours: [10], capacity: 2 }, now)!, /полгода/)
  for (const ok of ['hiringday', 'hiringday-mgupp', 'hiringday-2-potok']) assert.ok(isHiringLabel(ok), ok)
  for (const bad of ['', 'fair-mgupp', 'hiringday_mgupp', 'HiringDay', 'hiringday-', `hiringday-${'x'.repeat(40)}`]) assert.ok(!isHiringLabel(bad), bad)
})

test('сообщение бота на день найма: «выбери час», оформление в тот же день не обещаем, «мест нет»', () => {
  const d = { day: tomorrow, address: 'Москва, ул. Рябиновая, 44, проходная 2' }
  const hours = [9, 10, 11, 12, 13].map((h) => mskAt(tomorrow, h))
  const m = offerMessage({ id: 'K7M2QX', vacancyId: '' }, hours, { hiringDay: d })
  assert.match(m.text, /^\*\*День найма: выбери час собеседования\*\*/)
  assert.ok(m.text.includes(`Адрес: ${d.address}.`) && m.text.includes(HIRING_NOTE), m.text)
  assert.ok(!/(в тот же день|сразу)\s+оформ/i.test(m.text), 'не обещаем оформление в тот же день')
  for (const row of m.buttons!) assert.ok(row.length <= 3, 'не больше трёх часов в ряду')
  const full = offerMessage({ id: 'K7M2QX', vacancyId: '' }, [], { hiringDay: d })
  assert.match(full.text, /^\*\*День найма: мест нет\*\*/)
  assert.ok(full.text.includes(hiringFullText(tomorrow)) && full.text.includes('мест нет'), full.text)
  assert.ok(full.buttons!.flat().some((b) => b.kind === 'action' && b.action === 'b:none'))
  for (const t of [m.text, full.text]) assert.ok(!t.includes('!'))
})

test('PostgreSQL: день найма 2 часа × 2 места — четверо записываются по ссылке, пятый видит «мест нет»', async () => {
  await withTestDb('w2-booking-hiringday', async (sql) => {
    const adapter = { startPolling: async () => {}, handleWebhook: async () => {}, sendTo: async () => {} } as unknown as Adapter
    const bots: Registry = { get: (c) => (c === 'telegram' ? { adapter, secret: undefined } : undefined), active: () => ['telegram'], failed: () => [], start: () => {} }
    const rules: RateRule[] = [{ name: 'api', burst: 100000, perMinute: 100000, match: (_m, p) => p.startsWith('/api/') }]
    const env = { NODE_ENV: 'test', SITE_URL: SITE, TELEGRAM_BOT_USERNAME: 'ochakovo_test_bot' }
    const storage = new PostgresStorage(sql)
    const repo = new HrRepo(sql)
    await repo.createUser({ email: 'admin@hiring.test', name: 'Админ', role: 'admin', passwordHash: await hashPassword('проверка-пароля-1') })
    const app = await createApp({ storage, engine: null, bots, hrToken: '', env, rateRules: rules })
    await serverSettled(sql)
    const engine = createEngine(storage, { siteUrl: SITE, assistant: createAssistant({ provider: offlineProvider(), log: () => {} }) })
    const login = await app.request('/api/hr/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@hiring.test', password: 'проверка-пароля-1' }) })
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
    const hr = async <T = Record<string, unknown>>(method: string, path: string, body?: unknown) => {
      const res = await app.request(path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { cookie, 'content-type': 'application/json', 'x-hr-request': '1' } })
      return { status: res.status, body: (await res.json()) as T }
    }
    let n = 0
    const apply = async (extra: Record<string, unknown> = {}) => {
      n++
      const res = await app.request('/api/applications', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.50.0.${n}` },
        body: JSON.stringify({ name: `Найм${n}`, lastName: 'Днева', phone: `+7 495 400-00-${String(n).padStart(2, '0')}`, birthDate: birth(20), school: 'МГУПП', startReady: 'now', consent: true, consentVersion: CONSENT_VERSION, source: 'hiringday', ...extra }),
      })
      assert.equal(res.status, 201, await res.clone().text())
      return (await res.json()) as { id: string; statusToken: string }
    }
    type St = { offered: boolean; hours: string[]; booked: string | null; full: boolean; hiringDay: { day: string; address: string } | null; address: string; error?: string }
    const cand = async (method: string, a: { id: string; statusToken: string }, path = '', body?: unknown) => {
      const res = await app.request(`/api/applications/${a.id}/booking${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-status-token': a.statusToken } })
      return { status: res.status, body: (await res.json()) as St }
    }
    type Day = { id: number; day: string; hours: number[]; capacity: number; address: string; label: string; booked: Record<string, number>; offers: number; links: { site: string; telegram?: string } }

    // Проверка полей дня найма
    assert.equal((await hr('POST', '/api/hr/booking/days', { day: mskParts(now - 2 * DAY).day, hours: [10, 11], capacity: 2 })).status, 422)
    assert.equal((await hr('POST', '/api/hr/booking/days', { day: tomorrow, hours: [], capacity: 2 })).status, 422)
    assert.equal((await hr('POST', '/api/hr/booking/days', { day: tomorrow, hours: [10], capacity: 2, label: 'ярмарка' })).status, 422)

    const address = 'Москва, ул. Рябиновая, 44, проходная 2'
    const created = await hr<{ day: Day }>('POST', '/api/hr/booking/days', { day: tomorrow, hours: [11, 10], capacity: 2, address, note: 'Для выпускников колледжей' })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const day = created.body.day
    assert.deepEqual({ day: day.day, hours: day.hours, capacity: day.capacity, label: day.label, booked: day.booked, offers: day.offers }, {
      day: tomorrow,
      hours: [10, 11],
      capacity: 2,
      label: 'hiringday',
      booked: { '10:00': 0, '11:00': 0 },
      offers: 0,
    })
    assert.equal(day.links.site, `${SITE}/?src=hiringday`)
    assert.equal(day.links.telegram, 'https://t.me/ochakovo_test_bot?start=hiringday')
    const dup = await hr<{ message: string }>('POST', '/api/hr/booking/days', { day: tomorrow, hours: [12], capacity: 2 })
    assert.equal(dup.status, 422)
    assert.match(dup.body.message, /Метка hiringday уже у дня найма/)

    // Четверо пришли по ссылке с сайта
    const people = [await apply(), await apply(), await apply(), await apply()]
    const first = await cand('GET', people[0])
    assert.equal(first.body.offered, true)
    assert.deepEqual(first.body.hiringDay, { day: tomorrow, address })
    assert.deepEqual(first.body.hours, [mskAt(tomorrow, 10).toISOString(), mskAt(tomorrow, 11).toISOString()])
    assert.equal(first.body.full, false)
    const hist = await hr<{ history: { comment: string; userName: string }[] }>('GET', `/api/hr/applications/${people[0].id}`)
    assert.ok(hist.body.history.some((h) => h.userName === 'Система' && /^День найма, [а-я]+, \d+ [а-я]+: кандидат выбирает час на сайте или в боте$/.test(h.comment)), JSON.stringify(hist.body.history))
    const ten = mskAt(tomorrow, 10).toISOString()
    const eleven = mskAt(tomorrow, 11).toISOString()
    for (const [i, at] of [ten, ten, eleven, eleven].entries()) {
      const r = await cand('POST', people[i], '', { startsAt: at })
      assert.equal(r.status, 200, JSON.stringify(r.body))
    }
    const a0 = (await hr<{ application: HrApplication; history: { comment: string }[] }>('GET', `/api/hr/applications/${people[0].id}`)).body
    assert.equal(a0.application.status, 'interview')
    assert.equal(a0.application.interview?.address, address, 'адрес дня найма')
    assert.equal(a0.application.interview?.bring, interviewDefaults.bring)
    assert.equal(a0.application.interview?.selfBooked, true)
    assert.ok(a0.history.some((h) => h.comment === 'Самозапись: кандидат выбрал время на сайте, день найма'))

    // Пятый — из бота по start=hiringday: «мест нет»
    const fifth = await storage.saveApplication(
      normalizeApplication({ channel: 'telegram', channelUserId: 'tg-hd-5', name: 'Пятый', lastName: 'Днев', phone: '+7 495 400-00-55', birthDate: birth(19), school: 'МГУПП', startReady: 'now', consent: true, consentVersion: CONSENT_VERSION, consentSource: 'telegram', source: 'hiringday' }),
    )
    const st = await bookingState(bookingDeps(sql, bots, env), fifth.id)
    assert.deepEqual({ offered: st.offered, hours: st.hours, full: st.full }, { offered: true, hours: [], full: true })
    const bot = await engine.handle({ channel: 'telegram', id: 'tg-hd-5' }, { type: 'action', action: 'b:list' })
    assert.match(textOf(bot), /^\*\*День найма: мест нет\*\*/)
    assert.ok(textOf(bot).includes('Все часы дня найма'), textOf(bot))
    assert.deepEqual(hourActions(bot), [])
    // Пятый с сайта тоже видит «мест нет», а попытка записаться на занятый час — «уже заняли»
    const fifthSite = await apply()
    const full = await cand('GET', fifthSite)
    assert.deepEqual({ offered: full.body.offered, hours: full.body.hours, full: full.body.full }, { offered: true, hours: [], full: true })
    const taken = await cand('POST', fifthSite, '', { startsAt: ten })
    assert.equal(taken.status, 409)

    const listedRes = await hr<Day[]>('GET', '/api/hr/booking/days')
    assert.equal(listedRes.status, 200, JSON.stringify(listedRes.body))
    const listed = listedRes.body
    assert.deepEqual(listed.map((d) => [d.booked, d.offers]), [[{ '10:00': 2, '11:00': 2 }, 6]])

    // Отмена освобождает место — пятый видит 10:00
    assert.equal((await cand('DELETE', people[0])).status, 200)
    assert.deepEqual((await cand('GET', fifthSite)).body.hours, [ten])
    const botAgain = await engine.handle({ channel: 'telegram', id: 'tg-hd-5' }, { type: 'action', action: 'b:list' })
    assert.match(textOf(botAgain), /^\*\*День найма: выбери час собеседования\*\*/)
    const booked = await engine.handle({ channel: 'telegram', id: 'tg-hd-5' }, { type: 'action', action: hourActions(botAgain)[0] })
    assert.match(textOf(booked), /^\*\*Записано на собеседование: /)
    assert.ok(textOf(booked).includes('Оформление — потом: дату назовёт HR.'))

    // Не по ссылке дня найма — выбора нет
    const other = await apply({ source: 'fair-mgupp' })
    assert.equal((await cand('GET', other)).body.offered, false)

    // HR отозвал предложение дня найма — оно само не возвращается
    const withdrawn = await apply()
    assert.equal((await cand('GET', withdrawn)).body.offered, true)
    await hr('DELETE', `/api/hr/booking/${withdrawn.id}`)
    assert.equal((await cand('GET', withdrawn)).body.offered, false)

    // День найма отменили: кто не выбрал час — часов не видит, записанные остаются, новые по ссылке выбора не получают
    assert.deepEqual((await hr('DELETE', `/api/hr/booking/days/${day.id}`)).body, { closed: true })
    assert.equal((await cand('GET', fifthSite)).body.offered, false)
    assert.equal((await cand('GET', people[1])).body.booked, ten)
    const late = await apply()
    assert.equal((await cand('GET', late)).body.offered, false)
    assert.deepEqual((await hr('DELETE', `/api/hr/booking/days/${day.id}`)).body, { closed: false })
    // Метка снова свободна для нового дня
    assert.equal((await hr('POST', '/api/hr/booking/days', { day: tomorrow, hours: [15], capacity: 1 })).status, 201)
  })
})
