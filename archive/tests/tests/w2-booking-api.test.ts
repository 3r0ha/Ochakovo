// Самозапись на собеседование, w2-bk-1, на настоящем сервере и своей базе: HR предлагает выбрать время → кандидат
// с сайта видит часы → после выбора у заявки «Собеседование», слот и напоминание, в «Графике» в этом часе +1;
// час с заполненной нормой не предлагается; из одновременных выборов последнего места второй получает
// «Это время уже заняли, выбери другое»; перенос и отмена освобождают место; «Ни одно не подходит» — задача HR.
// Время — от текущего момента. Запуск: pnpm test w2-booking-api (нужен PostgreSQL, база создаётся и удаляется сама)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CONSENT_VERSION, interviewDefaults, type HrApplication } from '../../shared/applications'
import { defaultWorkSettings, hourKey, hrReminderTime, nextWorkTime } from '../../shared/workdays'
import { createApp } from '../../server/app'
import { hashPassword } from '../../server/auth/password'
import { NONE_NOTE } from '../../server/booking'
import { withdrawApplication } from '../../server/candidate/rights'
import { statusForToken } from '../../server/candidate/status'
import type { Adapter, Registry } from '../../server/channels/registry'
import { PostgresStorage, type Sql } from '../../server/db'
import { HrRepo } from '../../server/db/hr'
import { REMIND_NOTE } from '../../server/db/workflow'
import type { OutMessage } from '../../server/dialog/types'
import type { RateRule } from '../../server/middleware/rate-limit'
import { serverSettled, withTestDb } from './_db'

process.env.HR_NOTIFY_DELAY_SECONDS = '0'

const password = 'проверка-пароля-1'
const rules: RateRule[] = [{ name: 'api', burst: 100000, perMinute: 100000, match: (_m, p) => p.startsWith('/api/') }]
const birth = (years: number) => new Date(Date.now() - years * 365.25 * 864e5).toISOString().slice(0, 10)

type Sent = { userId: string; messages: OutMessage[] }
type State = { offered: boolean; hours: string[]; booked: string | null; address: string; bring: string; expiresAt: string | null; noneAt: string | null }
type History = { kind: string; comment: string; toStatus: string; fromStatus: string | null; userName: string; notify: string | null; notifyDetail: string }

function telegram(sent: Sent[]): Registry {
  const adapter = { startPolling: async () => {}, handleWebhook: async () => {}, sendTo: async (userId: string, messages: OutMessage[]) => void sent.push({ userId, messages }) } as unknown as Adapter
  return { get: (c) => (c === 'telegram' ? { adapter, secret: undefined } : undefined), active: () => ['telegram'], failed: () => [], start: () => {} }
}

async function setup(sql: Sql, env: NodeJS.ProcessEnv = {}) {
  const sent: Sent[] = []
  const storage = new PostgresStorage(sql)
  const repo = new HrRepo(sql)
  const admin = await repo.createUser({ email: 'admin@booking.test', name: 'Админ', role: 'admin', passwordHash: await hashPassword(password) })
  const app = await createApp({ storage, engine: null, bots: telegram(sent), hrToken: '', env: { NODE_ENV: 'test', SITE_URL: 'https://season.example.ru', ...env }, rateRules: rules })
  await serverSettled(sql)
  const login = await app.request('/api/hr/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: admin.email, password }) })
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
  assert.ok(cookie, 'вход администратора')
  const hr = async <T = Record<string, unknown>>(method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { cookie, 'content-type': 'application/json', 'x-hr-request': '1' } })
    return { status: res.status, body: (await res.json()) as T }
  }
  let n = 0
  /** Заявка с сайта со всеми полями кейса: номер и ключ «Моей заявки» */
  const apply = async (extra: Record<string, unknown> = {}) => {
    n++
    const res = await app.request('/api/applications', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.40.0.${n}` },
      body: JSON.stringify({
        name: `Кандидат${n}`,
        lastName: 'Записанова',
        phone: `+7 495 ${String(100 + n).padStart(3, '0')}-00-00`,
        birthDate: birth(20),
        school: 'МГУПП',
        startReady: 'now',
        consent: true,
        consentVersion: CONSENT_VERSION,
        ...extra,
      }),
    })
    assert.equal(res.status, 201, await res.clone().text())
    return (await res.json()) as { id: string; statusToken: string }
  }
  /** Запрос кандидата с ключом из браузера */
  const cand = async <T = State & { error?: string; message?: string }>(method: string, a: { id: string; statusToken: string }, path = '', body?: unknown) => {
    const res = await app.request(`/api/applications/${a.id}/booking${path}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'x-status-token': a.statusToken },
    })
    return { status: res.status, body: (await res.json()) as T }
  }
  const details = async (id: string) => (await hr<{ application: HrApplication; history: History[] }>('GET', `/api/hr/applications/${id}`)).body
  /** Сколько собеседований в этом часе в «Графике» — как считает панель: статус «Собеседование», не дубль */
  const graph = async (at: string) => {
    const list = (await hr<HrApplication[]>('GET', '/api/hr/applications')).body
    return list.filter((a) => a.status === 'interview' && a.interview && !a.duplicateOf && hourKey(new Date(a.interview.startsAt)) === hourKey(new Date(at))).length
  }
  return { app, storage, repo, hr, apply, cand, details, graph, sent }
}

test('кандидат с сайта: предложение HR → часы → запись, перенос, отмена, «ни одно не подходит»', async () => {
  await withTestDb('w2-booking-site', async (sql) => {
    const { hr, apply, cand, details, graph } = await setup(sql)
    const a = await apply()

    // Без предложения HR выбора нет
    const before = await cand('GET', a)
    assert.equal(before.status, 200)
    assert.deepEqual({ offered: before.body.offered, hours: before.body.hours, booked: before.body.booked }, { offered: false, hours: [], booked: null })
    assert.equal((await cand('POST', a, '', { startsAt: new Date().toISOString() })).status, 410)

    // Чужой ключ и неизвестный номер — 404 на всех маршрутах
    for (const [m, p] of [['GET', ''], ['POST', ''], ['DELETE', ''], ['POST', '/none']] as const) {
      assert.equal((await cand(m, { id: a.id, statusToken: 'x'.repeat(32) }, p, m === 'POST' ? {} : undefined)).status, 404, `${m} ${p} с чужим ключом`)
      assert.equal((await cand(m, { id: 'NOPE0000', statusToken: a.statusToken }, p, m === 'POST' ? {} : undefined)).status, 404)
    }

    const offered = await hr<{ offered: { id: string; notify: string; detail: string }[]; failed: unknown[] }>('POST', '/api/hr/booking/offer', { ids: [a.id] })
    assert.equal(offered.status, 200)
    assert.deepEqual(offered.body.failed, [])
    assert.equal(offered.body.offered[0].notify, 'skipped')
    assert.match(offered.body.offered[0].detail, /страниц[еа] «Моя заявка»/)
    let d = await details(a.id)
    assert.equal(d.application.status, 'new', 'предложение статус не меняет')
    const offerLine = d.history.find((h) => h.comment === 'Предложено выбрать время собеседования')!
    assert.ok(offerLine && offerLine.userName === 'Админ' && offerLine.notify === 'skipped', JSON.stringify(offerLine))
    // Срок ответа HR прежний: кандидат видит «Заявка у отдела персонала»
    const status = await statusForToken(sql, a.id, a.statusToken)
    assert.equal(status?.stage, 'received')

    const open = await cand('GET', a)
    assert.equal(open.body.offered, true)
    assert.equal(open.body.hours.length, 6)
    assert.equal(open.body.booked, null)
    assert.equal(open.body.address, interviewDefaults.address)
    assert.ok(Math.abs(Date.parse(open.body.expiresAt!) - (Date.now() + 7 * 864e5)) < 60e3, 'срок выбора — неделя')
    const [h0, h1] = open.body.hours
    const g0 = await graph(h0)

    // Запись
    const booked = await cand<State & { startsAt: string; moved: boolean }>('POST', a, '', { startsAt: h0 })
    assert.equal(booked.status, 200, JSON.stringify(booked.body))
    assert.equal(booked.body.startsAt, h0)
    assert.equal(booked.body.booked, h0)
    assert.ok(!booked.body.hours.includes(h0), 'выбранный час в списке не повторяется')
    d = await details(a.id)
    assert.equal(d.application.status, 'interview')
    assert.equal(d.application.interview?.startsAt, h0)
    assert.equal(d.application.interview?.selfBooked, true, 'пометка «самозапись»')
    assert.equal(d.application.interview?.address, interviewDefaults.address)
    assert.equal(d.application.interview?.bring, interviewDefaults.bring)
    const toInterview = d.history.find((h) => h.kind === 'status' && h.toStatus === 'interview')!
    assert.deepEqual(
      { from: toInterview.fromStatus, by: toInterview.userName, comment: toInterview.comment, notify: toInterview.notify },
      { from: 'new', by: 'Кандидат', comment: 'Самозапись: кандидат выбрал время на сайте', notify: null },
      'сообщение кандидату не уходит: время он выбрал сам',
    )
    assert.equal(await graph(h0), g0 + 1, 'в «Графике» в этом часе +1')
    // Напоминание: у кандидата с сайта без бота и SMS — задача HR «Напомнить о собеседовании» накануне.
    // Если рабочего времени до собеседования уже не осталось (запуск вечером в пятницу), задачи нет
    if (hrReminderTime(new Date(h0))) {
      assert.equal(d.application.callbackNote, REMIND_NOTE)
      assert.ok(d.application.callbackAt && Date.parse(d.application.callbackAt) < Date.parse(h0))
    } else assert.equal(d.application.callbackNote, '')
    const st = await statusForToken(sql, a.id, a.statusToken)
    assert.equal(st?.interview?.startsAt, h0, '«Моя заявка» показывает собеседование')

    // То же время ещё раз — ничего не меняется
    const same = await cand<State & { moved: boolean }>('POST', a, '', { startsAt: h0 })
    assert.equal(same.status, 200)
    assert.equal((await details(a.id)).history.length, d.history.length)

    // Перенос: прежний час освобождается
    const moved = await cand<State & { moved: boolean }>('POST', a, '', { startsAt: h1 })
    assert.equal(moved.status, 200)
    assert.equal(moved.body.moved, true)
    assert.equal(moved.body.booked, h1)
    assert.equal(await graph(h0), g0, 'прежний час освободился')
    const g1 = await graph(h1)
    d = await details(a.id)
    assert.equal(d.application.interview?.startsAt, h1)
    assert.equal(d.application.interview?.selfBooked, true)
    assert.ok(d.history.some((h) => h.kind === 'interview' && h.comment === 'Самозапись: кандидат перенёс собеседование на сайте'))
    assert.equal((await sql`select 1 from interviews where application_id = ${a.id} and cancelled_at is null`).length, 1)

    // Время не из списка: полчаса, выходной, вчера — 422 и свежие часы
    for (const bad of [new Date(Date.parse(h1) + 30 * 60e3), new Date(Date.parse(h1) - 2 * 864e5 * 365)]) {
      const r = await cand<{ error: string; hours: string[] }>('POST', a, '', { startsAt: bad.toISOString() })
      assert.equal(r.status, 422, bad.toISOString())
      assert.equal(r.body.error, 'invalid')
      assert.ok(r.body.hours.length > 0)
    }
    assert.equal((await cand('POST', a, '', { startsAt: 'завтра' })).status, 422)

    // Отмена: место освобождается, заявка возвращается в «Новую», напоминание снято, выбрать можно снова
    const cancelled = await cand('DELETE', a)
    assert.equal(cancelled.status, 200)
    assert.equal(cancelled.body.booked, null)
    assert.equal(cancelled.body.offered, true)
    assert.ok(cancelled.body.hours.includes(h1) || cancelled.body.hours.length === 6)
    assert.equal(await graph(h1), g1 - 1, 'место освободилось')
    d = await details(a.id)
    assert.equal(d.application.status, 'new')
    assert.equal(d.application.interview, null)
    assert.equal(d.application.callbackNote, '', 'задача «напомнить» снята')
    assert.ok(d.history.some((h) => h.kind === 'status' && h.fromStatus === 'interview' && h.toStatus === 'new' && /отменил собеседование на сайте, место освободилось/.test(h.comment)))
    assert.equal((await cand('DELETE', a)).status, 410, 'отменять нечего')

    // «Ни одно не подходит»: задача HR позвонить в ближайшее рабочее время; повтор новую задачу не ставит
    const none = await cand<{ ok: boolean; repeated: boolean }>('POST', a, '/none', {})
    assert.deepEqual(none.body, { ok: true, repeated: false })
    d = await details(a.id)
    assert.equal(d.application.callbackNote, NONE_NOTE)
    assert.ok(Math.abs(Date.parse(d.application.callbackAt!) - nextWorkTime(Date.now(), defaultWorkSettings).getTime()) < 120e3)
    const callbacks = d.history.filter((h) => h.kind === 'callback').length
    assert.deepEqual((await cand('POST', a, '/none', {})).body, { ok: true, repeated: true })
    assert.equal((await details(a.id)).history.filter((h) => h.kind === 'callback').length, callbacks)

    // Карточка HR: что с предложением; список открытых предложений; отзыв
    const info = await hr<{ state: string; createdBy: string; noneAt: string | null; hours: string[] }>('GET', `/api/hr/booking/${a.id}`)
    assert.equal(info.body.state, 'open')
    assert.equal(info.body.createdBy, 'Админ')
    assert.ok(info.body.noneAt && info.body.hours.length === 6)
    const list = await hr<{ applicationId: string; state: string }[]>('GET', '/api/hr/booking')
    assert.deepEqual(list.body.map((o) => [o.applicationId, o.state]), [[a.id, 'open']])
    assert.equal((await hr('GET', '/api/hr/booking/NOPE0000')).status, 404)
    assert.deepEqual((await hr('DELETE', `/api/hr/booking/${a.id}`)).body, { withdrawn: true })
    assert.equal((await cand('GET', a)).body.offered, false, 'после отзыва часов нет')
    assert.ok((await details(a.id)).history.some((h) => h.comment === 'Предложение выбрать время отозвано'))
  })
})

test('норма часа: заполненный час не предлагается, последнее место достаётся одному из одновременных', async () => {
  await withTestDb('w2-booking-race', async (sql) => {
    const { repo, hr, apply, cand, graph } = await setup(sql)
    await repo.saveWorkSettings({ ...defaultWorkSettings, slotCapacity: 2 })
    const people = []
    for (let i = 0; i < 6; i++) people.push(await apply())
    const r = await hr<{ offered: unknown[] }>('POST', '/api/hr/booking/offer', { ids: people.map((p) => p.id) })
    assert.equal(r.body.offered.length, 6)
    const [first, ...rest] = people
    const target = (await cand('GET', first)).body.hours[0]
    assert.equal((await cand('POST', first, '', { startsAt: target })).status, 200)
    assert.equal(await graph(target), 1)

    // Четверо одновременно за последнее место
    const racers = rest.slice(0, 4)
    const results = await Promise.all(racers.map((p) => cand<{ error?: string; message?: string; hours?: string[]; booked?: string }>('POST', p, '', { startsAt: target })))
    const won = results.filter((x) => x.status === 200)
    const lost = results.filter((x) => x.status === 409)
    assert.equal(won.length, 1, JSON.stringify(results.map((x) => x.status)))
    assert.equal(lost.length, 3)
    for (const l of lost) {
      assert.equal(l.body.error, 'taken')
      assert.equal(l.body.message, 'Это время уже заняли, выбери другое.')
      assert.ok(l.body.hours!.length > 0 && !l.body.hours!.includes(target), 'свежий список без занятого часа')
    }
    assert.equal(await graph(target), 2, 'норма не превышена')
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from interviews i join applications a on a.id = i.application_id
      where i.cancelled_at is null and a.status = 'interview' and i.starts_at = ${new Date(target)}`
    assert.equal(n, 2)
    const holds = await sql`select 1 from booking_offers where hold_until is not null`
    assert.equal(holds.length, 0, 'временные места сняты')

    // Последний видит часы без заполненного; отмена первого освобождает место — час снова в списке
    const last = rest[4]
    assert.ok(!(await cand('GET', last)).body.hours.includes(target), 'час с заполненной нормой не предлагается')
    assert.equal((await cand('DELETE', first)).status, 200)
    assert.ok((await cand('GET', last)).body.hours.includes(target), 'после отмены час вернулся')
    assert.equal((await cand('POST', last, '', { startsAt: target })).status, 200)
    assert.equal(await graph(target), 2)
  })
})

test('кому нельзя предложить и когда выбор закрывается', async () => {
  await withTestDb('w2-booking-rules', async (sql) => {
    const { storage, hr, apply, cand } = await setup(sql, { SMS_PROVIDER: 'smsru', SMS_API_KEY: 'test-key' })
    const ok = await apply({ phone: '+7 916 555-00-01' })
    const declined = await apply()
    const minor = await apply()
    await sql`update applications set status = 'declined' where id = ${declined.id}`
    await sql`update applications set adult = false, birth_date = null where id = ${minor.id}`
    const noConsent = (await hr<{ application: HrApplication }>('POST', '/api/hr/applications', { name: 'Без Согласия', phone: '+7 495 222-00-01', source: 'phone', consentBasis: 'none' })).body.application
    const manual = (await hr<{ application: HrApplication }>('POST', '/api/hr/applications', { name: 'Ручной Кандидат', phone: '+7 495 222-00-02', source: 'phone', consentBasis: 'hr_verbal' })).body.application
    const dup = await apply()
    await sql`update applications set duplicate_of = ${ok.id} where id = ${dup.id}`

    const r = await hr<{ offered: { id: string; notify: string; detail: string }[]; failed: { id: string; error: string }[] }>('POST', '/api/hr/booking/offer', {
      ids: [ok.id, declined.id, minor.id, noConsent.id, manual.id, dup.id, 'NOPE0000'],
    })
    const failed = Object.fromEntries(r.body.failed.map((f) => [f.id, f.error]))
    assert.match(failed[declined.id], /закрыта отказом/)
    assert.match(failed[minor.id], /нет 18 лет/)
    assert.match(failed[noConsent.id], /Нет согласия/)
    // Ручной кандидат с городским номером: ни бота, ни SMS, ни страницы заявки
    assert.match(failed[manual.id], /некуда прислать/)
    assert.match(failed[dup.id], /дубль заявки/)
    assert.equal(failed.NOPE0000, 'Заявка не найдена')
    assert.equal((await hr('POST', '/api/hr/booking/offer', { ids: [] })).status, 422)

    // Мобильный номер и подключённые SMS: ссылка на «Мою заявку» уходит через очередь
    assert.deepEqual(r.body.offered.map((o) => [o.id, o.notify]), [[ok.id, 'queued']])
    const [job] = await sql<{ payload: { text: string; via: string } }[]>`select payload from jobs where kind = 'notify' and payload ->> 'applicationId' = ${ok.id}`
    assert.equal(job.payload.via, 'sms')
    assert.match(job.payload.text, /^Очаково: выбери время собеседования на странице заявки https:\/\/season\.example\.ru\/apply/)

    // HR сам назначил время после предложения — выбор закрыт
    const slotAt = new Date((await cand('GET', ok)).body.hours[2])
    const patched = await hr('PATCH', `/api/hr/applications/${ok.id}`, { status: 'interview', slot: { startsAt: slotAt.toISOString(), address: interviewDefaults.address, bring: 'паспорт' } })
    assert.equal(patched.status, 200, JSON.stringify(patched.body))
    assert.equal((await cand('GET', ok)).body.offered, false)
    assert.equal((await cand('POST', ok, '', { startsAt: slotAt.toISOString() })).status, 410)

    // Новое предложение после времени от HR: кандидат может выбрать другое, это перенос
    await hr('POST', '/api/hr/booking/offer', { ids: [ok.id] })
    const again = await cand('GET', ok)
    assert.equal(again.body.offered, true)
    assert.equal(again.body.booked, null, 'время назначал HR — это не запись кандидата')
    const pick = again.body.hours.find((h) => h !== slotAt.toISOString())!
    const moved = await cand<State & { moved: boolean }>('POST', ok, '', { startsAt: pick })
    assert.equal(moved.status, 200)
    const app = (await hr<{ application: HrApplication }>('GET', `/api/hr/applications/${ok.id}`)).body.application
    assert.equal(app.interview?.startsAt, pick)
    assert.equal(app.interview?.selfBooked, true)
    // Напоминание у кандидата с мобильным при подключённых SMS — в очереди
    assert.equal((await sql`select 1 from jobs where kind = 'reminder' and status = 'pending' and payload ->> 'applicationId' = ${ok.id}`).length, 1)

    // Срок выбора вышел — выбора нет, запись по-прежнему видна
    const late = await apply()
    await hr('POST', '/api/hr/booking/offer', { ids: [late.id] })
    await sql`update booking_offers set expires_at = now() - interval '1 second' where application_id = ${late.id}`
    assert.equal((await cand('GET', late)).body.offered, false)
    const expired = await cand<{ error: string }>('POST', late, '', { startsAt: pick })
    assert.equal(expired.status, 410)
    assert.equal(expired.body.error, 'expired')
    await sql`update booking_offers set expires_at = now() - interval '1 second' where application_id = ${ok.id} and closed_at is null`
    assert.equal((await cand('GET', ok)).body.booked, pick, 'записанный кандидат запись не теряет')

    // Оформление — выбор закрыт
    await sql`update applications set status = 'hired' where id = ${ok.id}`
    assert.equal((await cand('GET', ok)).body.offered, false)
    assert.equal((await cand('DELETE', ok)).status, 410)

    // Отзыв согласия: ключ больше не подходит — 404
    const gone = await apply()
    await hr('POST', '/api/hr/booking/offer', { ids: [gone.id] })
    await withdrawApplication(storage, gone.id, gone.statusToken)
    assert.equal((await cand('GET', gone)).status, 404)
  })
})

test('миграция 017 ложится и с нуля, и на базу, где поздние миграции уже применены', async () => {
  await withTestDb('w2-booking-migrate', async (sql) => {
    const { migrate } = await import('../../server/db')
    const tables = async () => (await sql<{ t: string }[]>`select table_name as t from information_schema.tables where table_name in ('booking_offers', 'hiring_days') order by 1`).map((r) => r.t)
    assert.deepEqual(await tables(), ['booking_offers', 'hiring_days'])
    // База, где 017 ещё не было, а 018 и дальше уже применены
    await sql`drop table booking_offers`
    await sql`drop table hiring_days`
    await sql`delete from schema_migrations where name = '017_booking.sql'`
    await migrate(sql, { quiet: true })
    assert.deepEqual(await tables(), ['booking_offers', 'hiring_days'])
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from schema_migrations where name = '017_booking.sql'`
    assert.equal(n, 1)
  })
})
