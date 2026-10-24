// Вкладка «Рассылка» (w2-cn-3) на настоящем сервере и своей базе, с фейковыми адаптерами мессенджеров.
// Трое подписаны, один отписан — уходит двоим, журнал «2 доставлено»; после «Не присылать» человека нет в следующей
// рассылке; повтор раньше недели блокируется; тем, кто не подписывался, ничего не уходит; заблокировавший бота
// попадает в журнал и выпадает из рассылок; «До конца приёма» — только при заданном сроке; тексты без дат; только админ.
// Запуск: pnpm test w2-channels-broadcast (нужен PostgreSQL, база создаётся и удаляется сама)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import * as hrBroadcast from '../../server/api/hr-broadcast'
import { createApp } from '../../server/app'
import { hashPassword } from '../../server/auth/password'
import { broadcastDone, broadcastMessage, deadlineTitle, todayMsk } from '../../server/channels/broadcast'
import type { Adapter, Registry } from '../../server/channels/registry'
import { TelegramApiError } from '../../server/channels/telegram'
import { PostgresStorage, type Sql } from '../../server/db'
import { HrRepo } from '../../server/db/hr'
import { createEngine } from '../../server/dialog/engine'
import type { DialogUser, OutMessage } from '../../server/dialog/types'
import type { RateRule } from '../../server/middleware/rate-limit'
import { serverSettled, withTestDb } from './_db'

const password = 'проверка-пароля-1'
const rules: RateRule[] = [{ name: 'api', burst: 100000, perMinute: 100000, match: (_m, p) => p.startsWith('/api/') }]

type Sent = { channel: string; userId: string; messages: OutMessage[]; at: number }

/** Боты с фейковой отправкой: что ушло — в sent; blocked — id тех, кто заблокировал бота */
function fakeBots(channels: ('telegram' | 'max')[], blocked = new Set<string>()) {
  const sent: Sent[] = []
  const adapter = (channel: 'telegram' | 'max'): Adapter => ({
    channel,
    startPolling: async () => {},
    handleWebhook: async () => {},
    async sendTo(userId, messages) {
      if (blocked.has(userId)) throw new TelegramApiError('sendMessage', 403, 'Forbidden: bot was blocked by the user')
      sent.push({ channel, userId, messages, at: Date.now() })
    },
  })
  const adapters = Object.fromEntries(channels.map((c) => [c, { adapter: adapter(c), secret: undefined }]))
  const bots: Registry = { get: (c) => adapters[c], active: () => channels, failed: () => [], start: () => {} }
  return { bots, sent, blocked }
}

async function setup(sql: Sql, bots: Registry) {
  const storage = new PostgresStorage(sql)
  const repo = new HrRepo(sql)
  await repo.createUser({ email: 'admin@cast.test', name: 'Админ', role: 'admin', passwordHash: await hashPassword(password) })
  await repo.createUser({ email: 'hr@cast.test', name: 'Вера', role: 'hr', passwordHash: await hashPassword(password) })
  const engine = createEngine(storage, { siteUrl: 'https://season.example.ru' })
  const app = await createApp({ storage, engine, bots, hrToken: '', env: { NODE_ENV: 'test', SITE_URL: 'https://season.example.ru' }, rateRules: rules })
  await serverSettled(sql)
  // Те же маршруты рассылки, но с маленькими пачками: видно, что отправка идёт порциями
  const cast = new Hono().route('/', hrBroadcast.routes({ storage, repo, engine, bots, env: {} }, { batch: 2, pauseMs: 40 }))
  const login = async (email: string) => {
    const res = await app.request('/api/hr/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })
    return (res.headers.get('set-cookie') ?? '').split(';')[0]
  }
  const admin = await login('admin@cast.test')
  const hr = await login('hr@cast.test')
  const call = async <T>(method: string, path: string, body?: unknown, cookie = admin) => {
    const res = await cast.request(path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { cookie, 'content-type': 'application/json', 'x-hr-request': '1' } })
    return { status: res.status, body: (await res.json()) as T }
  }
  /** Действие человека в боте — тем же движком, что у Telegram и MAX */
  const bot = (user: DialogUser, action: string) => engine.handle(user, { type: 'action', action })
  return { app, call, bot, hr, engine }
}

type Entry = { id: number; status: string; recipients: number; delivered: number; blocked: number; failed: number; skippedRecent: number; skippedOffline: number; unsubscribed: number; text: string }

const tg = (id: string): DialogUser => ({ channel: 'telegram', id })
const max = (id: string): DialogUser => ({ channel: 'max', id })

/** Сдвинуть «последнюю рассылку» всем на восемь дней назад — как будто прошла неделя */
const weekLater = (sql: Sql) => sql`update bot_users set last_broadcast_at = last_broadcast_at - interval '8 days' where last_broadcast_at is not null`

const plusDays = (n: number) => {
  const d = new Date(`${todayMsk()}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

test('рассылка: подписанным и не отписавшимся, раз в неделю, «Не присылать», заблокировавшие, журнал', async () => {
  await withTestDb('w2-channels-cast', async (sql) => {
    const { bots, sent, blocked } = fakeBots(['telegram'])
    const { call, bot, hr, engine } = await setup(sql, bots)

    // Набор закрыт — отправить нечего
    let state = (await call<{ kinds: Record<string, string | null>; recruit: { state: string } }>('GET', '/api/hr/broadcast')).body
    assert.equal(state.recruit.state, 'closed')
    assert.ok(state.kinds.open && state.kinds.deadline)
    assert.equal((await call('PUT', '/api/hr/broadcast/recruit', { state: 'open', endsOn: null })).status, 200)

    // Трое подписаны в Telegram, третий отписался; четвёртый просто открыл бота; пятый подписан в MAX, но бот MAX не подключён
    for (const id of ['101', '102', '103']) await bot(tg(id), 'rm:any')
    await bot(tg('103'), 'rm:off')
    await engine.handle(tg('104'), { type: 'start' })
    await bot(max('201'), 'rm:any')
    // В чате на сайте подписки нет; даже если строка есть — сайт рассылку не получает
    await sql`insert into bot_users (channel, user_id, remind_at) values ('web', 'w1', now())`

    const preview = await call<{ text: string; audience: { total: number; ready: number; offline: number; recent: number }; views: { telegram: unknown[]; max: unknown[] } }>(
      'POST',
      '/api/hr/broadcast/preview',
      { kind: 'open', segment: 'all' },
    )
    assert.equal(preview.status, 200)
    assert.deepEqual({ ...preview.body.audience, byChannel: undefined }, { total: 3, ready: 2, recent: 0, offline: 1, byChannel: undefined })
    assert.ok(preview.body.views.telegram.length && preview.body.views.max.length, 'вид в обоих мессенджерах')

    const first = await call<{ broadcast: Entry }>('POST', '/api/hr/broadcast', { kind: 'open', segment: 'all' })
    assert.equal(first.status, 202, JSON.stringify(first.body))
    await broadcastDone(first.body.broadcast.id)
    assert.deepEqual(sent.map((s) => s.userId).sort(), ['101', '102'], 'ушло двоим подписанным')
    for (const s of sent) {
      const buttons = s.messages[0].buttons!.flat()
      assert.ok(buttons.some((b) => b.kind === 'action' && b.text === 'Не присылать' && b.action === 'rm:off'), 'в каждом сообщении «Не присылать»')
    }
    let entry = (await call<Entry>('GET', `/api/hr/broadcast/${first.body.broadcast.id}`)).body
    assert.equal(entry.status, 'done')
    assert.equal(entry.delivered, 2, 'журнал: 2 доставлено')
    assert.equal(entry.recipients, 3)
    assert.equal(entry.skippedOffline, 1, 'подписчик MAX без бота MAX — не отправлено')

    // Повтор раньше недели блокируется
    const again = await call<{ error: string; message: string }>('POST', '/api/hr/broadcast', { kind: 'open', segment: 'all' })
    assert.equal(again.status, 422)
    assert.equal(again.body.error, 'nobody')
    assert.match(again.body.message, /меньше недели/)
    assert.equal(sent.length, 2)

    // «Не присылать» из сообщения рассылки: журнал считает отписку, в следующую рассылку человек не попадает
    await bot(tg('101'), 'rm:off')
    entry = (await call<Entry>('GET', `/api/hr/broadcast/${first.body.broadcast.id}`)).body
    assert.equal(entry.unsubscribed, 1)

    // Через неделю: 102 получает, 101 и 103 отписаны; 105 подписался и заблокировал бота
    await bot(tg('105'), 'rm:any')
    blocked.add('105')
    await weekLater(sql)
    sent.length = 0
    const second = await call<{ broadcast: Entry }>('POST', '/api/hr/broadcast', { kind: 'open', segment: 'all' })
    assert.equal(second.status, 202)
    await broadcastDone(second.body.broadcast.id)
    assert.deepEqual(sent.map((s) => s.userId), ['102'])
    entry = (await call<Entry>('GET', `/api/hr/broadcast/${second.body.broadcast.id}`)).body
    assert.equal(entry.delivered, 1)
    assert.equal(entry.blocked, 1, 'журнал: заблокировали бота')
    const [b105] = await sql<{ blocked_at: Date | null; last_broadcast_at: Date | null }[]>`select blocked_at, last_broadcast_at from bot_users where user_id = '105'`
    assert.ok(b105.blocked_at, 'отметка о блокировке')
    assert.equal(b105.last_broadcast_at, null, 'недоставленное не считается рассылкой этой недели')

    // Заблокировавший выпадает из рассылок, пока сам не вернётся в бота
    await weekLater(sql)
    let aud = (await call<{ audience: { total: number } }>('POST', '/api/hr/broadcast/preview', { kind: 'open', segment: 'all' })).body.audience
    assert.equal(aud.total, 2, '102 и 201; 105 заблокировал бота')
    await engine.handle(tg('105'), { type: 'text', text: 'меню' })
    aud = (await call<{ audience: { total: number } }>('POST', '/api/hr/broadcast/preview', { kind: 'open', segment: 'all' })).body.audience
    assert.equal(aud.total, 3, 'вернулся в бота — снова получает')

    // Журнал: обе рассылки, новые сверху
    const list = (await call<{ broadcasts: Entry[]; subscribers: { total: number; byChannel: Record<string, number> } }>('GET', '/api/hr/broadcast')).body
    assert.deepEqual(
      list.broadcasts.map((b) => b.id),
      [second.body.broadcast.id, first.body.broadcast.id],
    )
    assert.deepEqual(list.subscribers.byChannel, { telegram: 2, max: 1 })

    // Только администратор
    assert.equal((await call('GET', '/api/hr/broadcast', undefined, hr)).status, 403)
    assert.equal((await call('POST', '/api/hr/broadcast', { kind: 'open', segment: 'all' }, hr)).status, 403)
  })
})

test('сегменты: по направлению — подписанные на него и на любое; прошли задания без заявки', async () => {
  await withTestDb('w2-channels-segments', async (sql) => {
    const { bots } = fakeBots(['telegram', 'max'])
    const { call, bot } = await setup(sql, bots)
    await call('PUT', '/api/hr/broadcast/recruit', { state: 'open', endsOn: null })
    await bot(tg('1'), 'rm:quality')
    await bot(tg('2'), 'rm:any')
    await bot(max('3'), 'rm:logistics')
    await bot(tg('4'), 'rm:production')
    // 4 прошёл задание, заявки нет; 1 прошёл задание, но заявка есть
    await sql`update sessions set data = jsonb_set(data, '{progress}', '{"game": 3}') where user_id in ('1', '4')`
    await sql`insert into applications (id, channel, channel_user_id, name) values ('APP1', 'telegram', '1', 'Проверка')`

    const audience = async (body: unknown) => (await call<{ audience: { total: number } }>('POST', '/api/hr/broadcast/preview', body)).body.audience.total
    assert.equal(await audience({ kind: 'open', segment: 'all' }), 4)
    assert.equal(await audience({ kind: 'open', segment: 'dept', dept: 'quality' }), 2, 'лаборатория и «любое направление»')
    assert.equal(await audience({ kind: 'open', segment: 'dept', dept: 'logistics' }), 2)
    assert.equal(await audience({ kind: 'open', segment: 'tasks' }), 1, 'только прошедший задание без заявки')

    const p = (await call<{ text: string }>('POST', '/api/hr/broadcast/preview', { kind: 'open', segment: 'dept', dept: 'quality' })).body
    assert.match(p.text, /Направление «Лаборатория»/)
    assert.equal((await call('POST', '/api/hr/broadcast', { kind: 'open', segment: 'dept', dept: 'нет-такого' })).status, 422)
  })
})

test('«До конца приёма» — только при заданном сроке и не раньше чем за неделю', async () => {
  await withTestDb('w2-channels-deadline', async (sql) => {
    const { bots, sent } = fakeBots(['telegram'])
    const { call, bot } = await setup(sql, bots)
    await bot(tg('1'), 'rm:any')

    await call('PUT', '/api/hr/broadcast/recruit', { state: 'open', endsOn: null })
    let r = await call<{ error: string; message: string }>('POST', '/api/hr/broadcast', { kind: 'deadline', segment: 'all' })
    assert.equal(r.status, 422)
    assert.equal(r.body.error, 'kind_unavailable')
    assert.match(r.body.message, /не задан/)

    assert.equal((await call('PUT', '/api/hr/broadcast/recruit', { state: 'open', endsOn: plusDays(20) })).status, 200)
    r = await call('POST', '/api/hr/broadcast', { kind: 'deadline', segment: 'all' })
    assert.equal(r.status, 422, 'за 20 дней до срока «неделя» была бы неправдой')

    // Срок в прошлом и кривой срок не сохраняются
    assert.equal((await call('PUT', '/api/hr/broadcast/recruit', { state: 'open', endsOn: plusDays(-1) })).status, 422)
    assert.equal((await call('PUT', '/api/hr/broadcast/recruit', { state: 'open', endsOn: 'завтра' })).status, 422)

    await call('PUT', '/api/hr/broadcast/recruit', { state: 'open', endsOn: plusDays(7) })
    const p = (await call<{ text: string; unavailable: string | null }>('POST', '/api/hr/broadcast/preview', { kind: 'deadline', segment: 'all' })).body
    assert.equal(p.unavailable, null)
    assert.match(p.text, /До конца приёма заявок осталась неделя/)
    const ok = await call<{ broadcast: { id: number } }>('POST', '/api/hr/broadcast', { kind: 'deadline', segment: 'all' })
    assert.equal(ok.status, 202)
    await broadcastDone(ok.body.broadcast.id)
    assert.equal(sent.length, 1)

    await call('PUT', '/api/hr/broadcast/recruit', { state: 'closed', endsOn: plusDays(7) })
    assert.equal((await call('POST', '/api/hr/broadcast', { kind: 'open', segment: 'all' })).status, 422, 'набор закрыт')
  })
})

test('тексты рассылки без дат, с прямым заголовком и «Не присылать»', () => {
  const datePattern = /\d{1,2}[./]\d{1,2}|(19|20)\d{2}|\d\s*(январ|феврал|марта|апрел|мая|июн|июл|август|сентябр|октябр|ноябр|декабр)/i
  const texts = [
    broadcastMessage('open').text,
    broadcastMessage('open', { dept: 'production' }).text,
    ...[0, 1, 3, 5, 7].map((d) => broadcastMessage('deadline', { daysLeft: d }).text),
  ]
  for (const t of texts) {
    assert.doesNotMatch(t, datePattern, t)
    assert.doesNotMatch(t, /!/)
    assert.match(t, /Не присылать/)
    assert.match(t, /^\*\*[^*]+\*\*/, 'первым — заголовок')
  }
  assert.equal(deadlineTitle(7), 'До конца приёма заявок осталась неделя')
  assert.equal(deadlineTitle(3), 'До конца приёма заявок осталось 3 дня')
  assert.equal(deadlineTitle(1), 'До конца приёма заявок остался один день')
  assert.equal(deadlineTitle(0), 'Сегодня последний день приёма заявок')
})

test('отправка пачками: не больше пачки за раз, между пачками пауза', async () => {
  await withTestDb('w2-channels-batches', async (sql) => {
    const { bots, sent } = fakeBots(['telegram'])
    const { call, bot } = await setup(sql, bots)
    await call('PUT', '/api/hr/broadcast/recruit', { state: 'open', endsOn: null })
    for (const id of ['1', '2', '3', '4', '5']) await bot(tg(id), 'rm:any')
    const r = await call<{ broadcast: { id: number } }>('POST', '/api/hr/broadcast', { kind: 'open', segment: 'all' })
    assert.equal(r.status, 202)
    // Пока первая отправляется, вторая не начинается
    assert.equal((await call('POST', '/api/hr/broadcast', { kind: 'open', segment: 'all' })).status, 409)
    await broadcastDone(r.body.broadcast.id)
    assert.equal(sent.length, 5)
    // Пачки по 2 с паузой 40 мс: третье сообщение уходит не раньше чем через паузу после первого
    assert.ok(sent[2].at - sent[0].at >= 35, `пауза между пачками: ${sent[2].at - sent[0].at} мс`)
    assert.ok(sent[4].at - sent[2].at >= 35)
  })
})
