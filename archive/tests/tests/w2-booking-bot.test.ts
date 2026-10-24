// Самозапись в боте, w2-bk-2: кандидат из бота видит часы кнопками и записывается; занятый час — сообщение и новый
// список; «Ни одно не подходит» и отмена. Тот же сценарий на хранилище в памяти (симулятор бота) и на PostgreSQL
// через «Предложить выбрать время» из HR-панели. Время — от текущего момента.
// Запуск: pnpm test w2-booking-bot (часть с PostgreSQL создаёт и удаляет свою базу)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CONSENT_VERSION, type HrApplication } from '../../shared/applications'
import { defaultWorkSettings, hourKey } from '../../shared/workdays'
import { createApp } from '../../server/app'
import { createAssistant } from '../../server/assistant/assistant'
import { hashPassword } from '../../server/auth/password'
import { NONE_NOTE } from '../../server/booking'
import { memoryBooking } from '../../server/booking/memory'
import { CANCELLED_TEXT, NO_OFFER_TEXT, NONE_AGAIN_TEXT, NONE_TEXT, TAKEN_TEXT } from '../../server/booking/text'
import type { Adapter, Registry } from '../../server/channels/registry'
import { normalizeApplication, PostgresStorage } from '../../server/db'
import { HrRepo } from '../../server/db/hr'
import { createEngine } from '../../server/dialog/engine'
import { bookingRows } from '../../server/dialog/flows/booking'
import { memoryStorage } from '../../server/dialog/storage'
import type { Button, DialogReply, DialogUser, OutMessage } from '../../server/dialog/types'
import { offlineProvider } from '../../server/llm/offline'
import type { RateRule } from '../../server/middleware/rate-limit'
import { serverSettled, withTestDb } from './_db'

process.env.HR_NOTIFY_DELAY_SECONDS = '0'

const SITE = 'https://season.example.ru'
const assistant = createAssistant({ provider: offlineProvider(), log: () => {} })
const birth = (years: number) => new Date(Date.now() - years * 365.25 * 864e5).toISOString().slice(0, 10)
const textOf = (r: DialogReply | OutMessage[]) => ('messages' in r ? r.messages : r).map((m) => m.text).join('\n\n')
const buttonsOf = (r: DialogReply | OutMessage[]): Button[] => ('messages' in r ? r.messages : r).flatMap((m) => (m.buttons ?? []).flat())
const actions = (r: DialogReply | OutMessage[]) => buttonsOf(r).flatMap((b) => (b.kind === 'action' ? [b.action] : []))
const hourActions = (r: DialogReply | OutMessage[]) => actions(r).filter((a) => /^b:\d{4}-\d{2}-\d{2}T\d{2}$/.test(a))
const press = (engine: ReturnType<typeof createEngine>, user: DialogUser, action: string) => engine.handle(user, { type: 'action', action })

const botApplication = (channelUserId: string, n: number) =>
  normalizeApplication({
    channel: 'telegram',
    channelUserId,
    name: `Бот${n}`,
    lastName: 'Ботова',
    phone: `+7 495 300-00-${String(n).padStart(2, '0')}`,
    birthDate: birth(19),
    school: 'МГУПП',
    startReady: 'now',
    consent: true,
    consentVersion: CONSENT_VERSION,
    consentSource: 'telegram',
  })

test('в памяти (симулятор бота): часы кнопками, запись, занятый час, «ни одно не подходит», отмена', async () => {
  const storage = memoryStorage()
  const booking = memoryBooking(storage)
  const engine = createEngine(storage, { siteUrl: SITE, assistant })
  const u: DialogUser = { channel: 'telegram', id: 'mem-1', firstName: 'Саша' }
  const app = await storage.saveApplication(botApplication('mem-1', 1))

  // Без предложения HR — честно: время назначает отдел персонала
  const before = await press(engine, u, 'b:list')
  assert.equal(textOf(before), NO_OFFER_TEXT)
  const stranger = await press(engine, { channel: 'telegram', id: 'nobody' }, 'b:list')
  assert.match(textOf(stranger), /^Заявки из этого чата я не вижу/)

  booking.offer(app.id)
  const list = await press(engine, u, 'b:list')
  assert.match(textOf(list), /^\*\*Выбери время собеседования\*\*/)
  assert.ok(textOf(list).includes(`Заявка № ${app.id}`))
  const hours = hourActions(list)
  assert.equal(hours.length, 6, actions(list).join(' '))
  assert.ok(actions(list).includes('b:none'))

  const done = await press(engine, u, hours[0])
  assert.match(textOf(done), /^\*\*Записано на собеседование: /)
  assert.equal(done.notice, 'Записано')
  assert.ok(actions(done).includes('b:list') && actions(done).includes('b:cancel'))
  const saved = storage.applications.find((a) => a.id === app.id)!
  assert.equal(saved.status, 'interview')
  assert.equal(saved.interview?.selfBooked, true)
  assert.equal(hourKey(new Date(saved.interview!.startsAt)), hours[0].slice(2))

  // «Другое время»: занятый за секунду до нажатия час — сообщение и новый список без него
  const again = await press(engine, u, 'b:list')
  assert.ok(!hourActions(again).includes(hours[0]), 'выбранный час в списке не повторяется')
  assert.ok(textOf(again).includes('Сейчас записано:'))
  const target = hourActions(again)[0]
  booking.occupy(new Date(Date.parse(`${target.slice(2)}:00:00+03:00`)), defaultWorkSettings.slotCapacity)
  const taken = await press(engine, u, target)
  assert.ok(textOf(taken).startsWith(TAKEN_TEXT), textOf(taken))
  assert.equal(taken.notice, 'Время уже заняли')
  assert.ok(hourActions(taken).length > 0 && !hourActions(taken).includes(target), 'новый список без занятого часа')
  assert.equal(hourKey(new Date(saved.interview!.startsAt)), hours[0].slice(2), 'запись осталась прежней')

  const moved = await press(engine, u, hourActions(taken)[0])
  assert.match(textOf(moved), /^\*\*Собеседование перенесено: /)

  const none = await press(engine, u, 'b:none')
  assert.equal(textOf(none), NONE_TEXT)
  assert.deepEqual(booking.calls, [app.id])
  assert.equal(textOf(await press(engine, u, 'b:none')), NONE_AGAIN_TEXT)

  const cancelled = await press(engine, u, 'b:cancel')
  assert.ok(textOf(cancelled).startsWith(CANCELLED_TEXT), textOf(cancelled))
  assert.equal(saved.status, 'new')
  assert.equal(saved.interview, null)
  assert.ok(hourActions(cancelled).length > 0, 'после отмены — снова часы')
  assert.match(textOf(await press(engine, u, 'b:cancel')), /^Записи на собеседование нет/)

  // Кнопки для «Моей заявки»: выбрать время, а после записи — перенести или отменить
  const ctx = { user: u, storage, meta: {} } as unknown as Parameters<typeof bookingRows>[0]
  assert.deepEqual((await bookingRows(ctx)).flat().map((b) => b.text), ['Выбрать время собеседования'])
  await press(engine, u, hourActions(cancelled)[0])
  assert.deepEqual((await bookingRows(ctx)).flat().map((b) => b.text), ['Другое время', 'Отменить запись'])
  assert.deepEqual(await bookingRows({ ...ctx, user: { channel: 'telegram', id: 'nobody' } }), [])
})

test('чат на сайте: заявка по номеру и ключу браузера', async () => {
  const storage = memoryStorage()
  const booking = memoryBooking(storage)
  const engine = createEngine(storage, { siteUrl: SITE, assistant })
  const app = await storage.saveApplication(normalizeApplication({ ...botApplication('', 2), channel: 'web', consentSource: 'site_chat' }))
  booking.offer(app.id)
  const web: DialogUser = { channel: 'web', id: 'browser-1' }
  const meta = { application: { id: app.id, token: app.statusToken! } }
  const list = await engine.handle(web, { type: 'action', action: 'b:list' }, meta)
  assert.equal(hourActions(list).length, 6)
  const wrong = await engine.handle(web, { type: 'action', action: 'b:list' }, { application: { id: app.id, token: 'x'.repeat(48) } })
  assert.match(textOf(wrong), /^Заявки из этого браузера я не вижу/)
  const done = await engine.handle(web, { type: 'action', action: hourActions(list)[1] }, meta)
  assert.match(textOf(done), /^\*\*Записано на собеседование/)
})

test('PostgreSQL: HR предлагает → кнопки часов в Telegram → запись через бота, напоминание в бот, занятый час', async () => {
  await withTestDb('w2-booking-bot', async (sql) => {
    const sent: { userId: string; messages: OutMessage[] }[] = []
    const adapter = { startPolling: async () => {}, handleWebhook: async () => {}, sendTo: async (userId: string, messages: OutMessage[]) => void sent.push({ userId, messages }) } as unknown as Adapter
    const bots: Registry = { get: (c) => (c === 'telegram' ? { adapter, secret: undefined } : undefined), active: () => ['telegram'], failed: () => [], start: () => {} }
    const rules: RateRule[] = [{ name: 'api', burst: 100000, perMinute: 100000, match: (_m, p) => p.startsWith('/api/') }]
    const storage = new PostgresStorage(sql)
    const repo = new HrRepo(sql)
    await repo.createUser({ email: 'admin@bot-booking.test', name: 'Админ', role: 'admin', passwordHash: await hashPassword('проверка-пароля-1') })
    const app = await createApp({ storage, engine: null, bots, hrToken: '', env: { NODE_ENV: 'test', SITE_URL: SITE }, rateRules: rules })
    await serverSettled(sql)
    const engine = createEngine(storage, { siteUrl: SITE, assistant })
    const login = await app.request('/api/hr/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@bot-booking.test', password: 'проверка-пароля-1' }) })
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
    const hr = async <T>(method: string, path: string, body?: unknown) =>
      (await (await app.request(path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { cookie, 'content-type': 'application/json', 'x-hr-request': '1' } })).json()) as T
    const get = async (id: string) => (await hr<{ application: HrApplication; history: { kind: string; comment: string; userName: string }[] }>('GET', `/api/hr/applications/${id}`))
    await repo.saveWorkSettings({ ...defaultWorkSettings, slotCapacity: 1 })

    const a = await storage.saveApplication(botApplication('tg-501', 1))
    const b = await storage.saveApplication(botApplication('tg-502', 2))
    const ua: DialogUser = { channel: 'telegram', id: 'tg-501' }
    const ub: DialogUser = { channel: 'telegram', id: 'tg-502' }

    const offered = await hr<{ offered: { id: string; notify: string; detail: string }[] }>('POST', '/api/hr/booking/offer', { ids: [a.id, b.id] })
    assert.deepEqual(offered.offered.map((o) => [o.notify, o.detail]), [
      ['sent', 'кнопки с часами отправлены в Telegram'],
      ['sent', 'кнопки с часами отправлены в Telegram'],
    ])
    assert.deepEqual(sent.map((s) => s.userId), ['tg-501', 'tg-502'])
    const offerA = sent[0].messages
    assert.match(textOf(offerA), /^\*\*Выбери время собеседования\*\*/)
    const hoursA = hourActions(offerA)
    assert.equal(hoursA.length, 6)
    const history = (await get(a.id)).history.find((h) => h.comment === 'Предложено выбрать время собеседования')
    assert.ok(history, 'в истории — предложение')

    // Кандидат нажимает первую кнопку из сообщения HR
    const done = await press(engine, ua, hoursA[0])
    assert.match(textOf(done), /^\*\*Записано на собеседование: /)
    let saved = (await get(a.id)).application
    assert.equal(saved.status, 'interview')
    assert.equal(saved.interview?.selfBooked, true)
    assert.equal(hourKey(new Date(saved.interview!.startsAt)), hoursA[0].slice(2))
    assert.ok((await get(a.id)).history.some((h) => h.userName === 'Кандидат' && h.comment === 'Самозапись: кандидат выбрал время в Telegram'))
    // Напоминание накануне — в тот же бот, через очередь
    const reminders = await sql<{ payload: { interviewId: number; via?: string } }[]>`
      select payload from jobs where kind = 'reminder' and status = 'pending' and payload ->> 'applicationId' = ${a.id}`
    assert.equal(reminders.length, 1)
    assert.equal(reminders[0].payload.interviewId, saved.interview!.id)
    assert.equal(reminders[0].payload.via, undefined, 'в бот, а не SMS')

    // Второй кандидат нажимает тот же час из своего сообщения: при норме 1 он уже занят
    const taken = await press(engine, ub, hoursA[0])
    assert.ok(textOf(taken).startsWith(TAKEN_TEXT), textOf(taken))
    assert.ok(hourActions(taken).length > 0 && !hourActions(taken).includes(hoursA[0]), 'новый список без занятого часа')
    assert.equal((await get(b.id)).application.status, 'new')
    const okB = await press(engine, ub, hourActions(taken)[0])
    assert.match(textOf(okB), /^\*\*Записано/)

    // «Ни одно не подходит» — задача HR; отмена — место свободно, напоминание снято
    assert.equal(textOf(await press(engine, ua, 'b:none')), NONE_TEXT)
    assert.equal((await get(a.id)).application.callbackNote, NONE_NOTE)
    const cancelled = await press(engine, ua, 'b:cancel')
    assert.ok(textOf(cancelled).startsWith(CANCELLED_TEXT))
    saved = (await get(a.id)).application
    assert.equal(saved.status, 'new')
    assert.equal(saved.interview, null)
    assert.equal((await sql`select 1 from jobs where kind = 'reminder' and status = 'pending' and payload ->> 'applicationId' = ${a.id}`).length, 0)
    assert.ok(hourActions(cancelled).includes(hoursA[0]), 'освободившийся час снова в списке')
  })
})
