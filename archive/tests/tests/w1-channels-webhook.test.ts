// Вебхуки Telegram и MAX: секрет создаётся сам, без верного секрета — 403, чужой чат не доходит до движка.
// Реестр адаптеров: упавшая фабрика видна в failed(). Мессенджеры — фейковый HTTP API, без сети.
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, test } from 'node:test'
import { dialogRoutes } from '../../server/api/dialog'
import { createMaxAdapter } from '../../server/channels/max'
import { generateWebhookSecret, loadAdapters, type AdapterFactory } from '../../server/channels/registry'
import { createTelegramAdapter } from '../../server/channels/telegram'
import type { DialogEngine, DialogEvent, DialogUser } from '../../server/dialog/types'

type Hit = { url: string; headers: IncomingMessage['headers']; json: any }

let api: { base: string; hits: Hit[]; close(): Promise<void> }

before(async () => {
  const hits: Hit[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      hits.push({ url: req.url ?? '/', headers: req.headers, json: raw ? JSON.parse(raw) : null })
      res.writeHead(200, { 'content-type': 'application/json' })
      // Ответ годится и Telegram (ok/result), и MAX (success)
      res.end(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 1, type: 'private' } }, success: true }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  api = { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits, close: () => new Promise<void>((r) => server.close(() => r())) }
})
after(() => api.close())

const quiet = () => {
  const lines: string[] = []
  const push = (...a: unknown[]) => void lines.push(a.map(String).join(' '))
  return { lines, log: { info: push, warn: push, error: push } }
}

/** Фабрики настоящих адаптеров, которые ходят в фейковый API */
const fakeFactories = (): Record<'telegram' | 'max', AdapterFactory> => ({
  telegram: (token, o) => createTelegramAdapter(token, { ...o, apiBase: api.base, log: quiet().log }),
  max: (token, o) => createMaxAdapter(token, { ...o, apiBase: api.base, log: quiet().log, chatInterval: 0 }),
})

function stubEngine() {
  const events: { user: DialogUser; event: DialogEvent }[] = []
  const engine: DialogEngine = {
    async handle(user, event) {
      events.push({ user, event })
      return { messages: [{ text: 'Ответ' }] }
    },
  }
  return { engine, events }
}

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('таймаут ожидания')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const tgUpdate = (id: number, from: number, chat: number, text = 'привет') => ({
  update_id: id,
  message: { message_id: id, from: { id: from, first_name: 'Тест' }, chat: { id: chat, type: 'private' }, text },
})

const post = (app: { request: (p: string, i: RequestInit) => Response | Promise<Response> }, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

const WEBHOOK_ENV = { PUBLIC_URL: 'https://season.example.ru', TELEGRAM_BOT_TOKEN: 'tg-token', MAX_BOT_TOKEN: 'max-token', TELEGRAM_WEBHOOK_SECRET: '', MAX_WEBHOOK_SECRET: '' }

describe('секрет вебхука', () => {
  test('создаётся сам: 32 байта, подходит Telegram и MAX, в журнал — без значения', async () => {
    const { lines, log } = quiet()
    const bots = await loadAdapters({ ...WEBHOOK_ENV }, { factories: fakeFactories(), log })
    const tg = bots.get('telegram')!.secret!
    const max = bots.get('max')!.secret!
    for (const s of [tg, max]) {
      assert.ok(s.length >= 32, `секрет короче 32 знаков: ${s.length}`)
      assert.match(s, /^[A-Za-z0-9-]+$/)
    }
    assert.notEqual(tg, max)
    assert.equal(lines.filter((l) => l.includes('секрет вебхука сгенерирован')).length, 2)
    assert.ok(!lines.some((l) => l.includes(tg) || l.includes(max)), 'секрет попал в журнал')
    assert.deepEqual(bots.failed(), [])
    assert.notEqual(generateWebhookSecret(), generateWebhookSecret())
  })

  test('уходит в setWebhook (secret_token) и в подписку MAX (secret)', async () => {
    const bots = await loadAdapters({ ...WEBHOOK_ENV }, { factories: fakeFactories(), log: quiet().log })
    const { engine } = stubEngine()
    api.hits.length = 0
    const ctrl = new AbortController()
    bots.start(engine, { publicUrl: WEBHOOK_ENV.PUBLIC_URL, signal: ctrl.signal })
    await until(() => api.hits.length >= 2)
    ctrl.abort()
    const setWebhook = api.hits.find((h) => h.url.endsWith('/bottg-token/setWebhook'))!
    assert.equal(setWebhook.json.url, 'https://season.example.ru/bots/telegram')
    assert.equal(setWebhook.json.secret_token, bots.get('telegram')!.secret)
    assert.ok(setWebhook.json.secret_token.length >= 32)
    const subscription = api.hits.find((h) => h.url === '/subscriptions')!
    assert.equal(subscription.json.url, 'https://season.example.ru/bots/max')
    assert.equal(subscription.json.secret, bots.get('max')!.secret)
  })

  test('заданный в окружении секрет используется как есть, кривой — адаптер не поднимается', async () => {
    const { lines, log } = quiet()
    const configured = 'Abc-def_0123456789-abcdefghijklmnopqrs'
    const ok = await loadAdapters({ ...WEBHOOK_ENV, TELEGRAM_WEBHOOK_SECRET: configured }, { factories: fakeFactories(), log })
    assert.equal(ok.get('telegram')!.secret, configured)
    assert.equal(lines.filter((l) => l.includes('сгенерирован')).length, 1, 'сгенерирован только секрет MAX')
    const bad = await loadAdapters({ ...WEBHOOK_ENV, MAX_WEBHOOK_SECRET: 'пароль с пробелом' }, { factories: fakeFactories(), log: quiet().log })
    assert.deepEqual(bad.failed(), ['max'])
    assert.deepEqual(bad.active(), ['telegram'])
  })

  test('без PUBLIC_URL секрета нет: бот опрашивает API сам', async () => {
    const bots = await loadAdapters({ ...WEBHOOK_ENV, PUBLIC_URL: '', TELEGRAM_WEBHOOK_SECRET: 'Abc-def_0123456789-abcdefghijklmnopqrs' }, { factories: fakeFactories(), log: quiet().log })
    assert.equal(bots.get('telegram')!.secret, undefined)
    assert.equal(bots.get('max')!.secret, undefined)
  })
})

describe('маршруты /bots/*', () => {
  test('без заголовка и с чужим секретом — 403, с верным — 200 и апдейт доходит до движка', async () => {
    const bots = await loadAdapters({ ...WEBHOOK_ENV }, { factories: fakeFactories(), log: quiet().log })
    const { engine, events } = stubEngine()
    const app = dialogRoutes({ engine, bots })
    api.hits.length = 0
    const tgSecret = bots.get('telegram')!.secret!
    const maxSecret = bots.get('max')!.secret!

    assert.equal((await post(app, '/bots/telegram', tgUpdate(1, 42, 42))).status, 403)
    assert.equal((await post(app, '/bots/telegram', tgUpdate(2, 42, 42), { 'x-telegram-bot-api-secret-token': '' })).status, 403)
    assert.equal((await post(app, '/bots/telegram', tgUpdate(3, 42, 42), { 'x-telegram-bot-api-secret-token': maxSecret })).status, 403)
    assert.equal((await post(app, '/bots/telegram', tgUpdate(4, 42, 42), { 'x-telegram-bot-api-secret-token': tgSecret.slice(0, -1) })).status, 403)
    assert.equal(events.length, 0)

    const okRes = await post(app, '/bots/telegram', tgUpdate(5, 42, 42), { 'x-telegram-bot-api-secret-token': tgSecret })
    assert.equal(okRes.status, 200)
    await until(() => events.length === 1)
    assert.deepEqual(events[0].user.id, '42')

    const maxBody = { update_type: 'bot_started', user: { user_id: 7, first_name: 'Тест' } }
    assert.equal((await post(app, '/bots/max', maxBody)).status, 403)
    assert.equal((await post(app, '/bots/max', maxBody, { 'x-max-bot-api-secret': tgSecret })).status, 403)
    assert.equal((await post(app, '/bots/max', maxBody, { 'x-max-bot-api-secret': maxSecret })).status, 200)
    await until(() => events.length === 2)
    assert.equal(events[1].user.channel, 'max')
    // Ответы уходят после ответа 200 — дожидаемся их, чтобы они не попали в следующую проверку
    await until(() => api.hits.some((h) => h.url.endsWith('/sendMessage')) && api.hits.some((h) => h.url.startsWith('/messages')))
  })

  test('апдейт from=111, chat=999 с верным секретом: движок не вызван, sendMessage нет', async () => {
    const bots = await loadAdapters({ ...WEBHOOK_ENV }, { factories: fakeFactories(), log: quiet().log })
    const { engine, events } = stubEngine()
    const app = dialogRoutes({ engine, bots })
    api.hits.length = 0
    const res = await post(app, '/bots/telegram', tgUpdate(10, 111, 999, 'что с моей заявкой'), { 'x-telegram-bot-api-secret-token': bots.get('telegram')!.secret! })
    assert.equal(res.status, 200)
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(events.length, 0)
    const toStranger = api.hits.filter((h) => ['111', '999'].includes(String(h.json?.chat_id)))
    assert.deepEqual(toStranger, [], 'бот ответил в чужой чат')
    assert.equal(api.hits.filter((h) => h.url.endsWith('/sendMessage')).length, 0)
  })

  test('без PUBLIC_URL, без бота или без движка — 403 при любом заголовке', async () => {
    const configured = 'Abc-def_0123456789-abcdefghijklmnopqrs'
    const polling = await loadAdapters({ ...WEBHOOK_ENV, PUBLIC_URL: '', TELEGRAM_WEBHOOK_SECRET: configured }, { factories: fakeFactories(), log: quiet().log })
    const { engine, events } = stubEngine()
    const app = dialogRoutes({ engine, bots: polling })
    assert.equal((await post(app, '/bots/telegram', tgUpdate(20, 42, 42), { 'x-telegram-bot-api-secret-token': configured })).status, 403)
    assert.equal((await post(app, '/bots/max', { update_type: 'bot_started', user: { user_id: 7 } }, { 'x-max-bot-api-secret': '' })).status, 403)

    const none = dialogRoutes({ engine, bots: await loadAdapters({}) })
    assert.equal((await post(none, '/bots/telegram', tgUpdate(21, 42, 42), { 'x-telegram-bot-api-secret-token': 'x' })).status, 403)
    assert.equal((await post(none, '/bots/max', {})).status, 403)

    const bots = await loadAdapters({ ...WEBHOOK_ENV }, { factories: fakeFactories(), log: quiet().log })
    const noEngine = dialogRoutes({ engine: null, bots })
    assert.equal((await post(noEngine, '/bots/telegram', tgUpdate(22, 42, 42), { 'x-telegram-bot-api-secret-token': bots.get('telegram')!.secret! })).status, 403)
    assert.equal(events.length, 0)
  })

  test('лимит считает только отклонённые запросы: подбор упирается в 429, верные апдейты проходят', async () => {
    const bots = await loadAdapters({ ...WEBHOOK_ENV }, { factories: fakeFactories(), log: quiet().log })
    const { engine } = stubEngine()
    let t = Date.now()
    const app = dialogRoutes({ engine, bots, now: () => t })
    const secret = bots.get('telegram')!.secret!
    // Верные апдейты не тратят лимит (апдейты из чужого чата: 200 без ответа, чтобы не слать сообщения)
    for (let i = 0; i < 50; i++) assert.equal((await post(app, '/bots/telegram', tgUpdate(100 + i, 111, 999), { 'x-telegram-bot-api-secret-token': secret })).status, 200)
    const statuses: number[] = []
    for (let i = 0; i < 30; i++) statuses.push((await post(app, '/bots/telegram', tgUpdate(200 + i, 42, 42), { 'x-telegram-bot-api-secret-token': 'guess' + i })).status)
    assert.deepEqual(statuses, Array(30).fill(403))
    const limited = await post(app, '/bots/telegram', tgUpdate(300, 42, 42), { 'x-telegram-bot-api-secret-token': 'guess' })
    assert.equal(limited.status, 429)
    assert.ok(Number(limited.headers.get('retry-after')) >= 1)
    // Верный секрет проходит и во время лимита
    assert.equal((await post(app, '/bots/telegram', tgUpdate(301, 111, 999), { 'x-telegram-bot-api-secret-token': secret })).status, 200)
    t += 60_000
    assert.equal((await post(app, '/bots/telegram', tgUpdate(302, 42, 42), { 'x-telegram-bot-api-secret-token': 'guess' })).status, 403)
  })
})

describe('registry.failed()', () => {
  test('упавшая фабрика — канал в failed(), остальные работают', async () => {
    const { lines, log } = quiet()
    const factories = {
      ...fakeFactories(),
      telegram: () => {
        throw new Error('сломанный адаптер')
      },
    }
    const bots = await loadAdapters({ TELEGRAM_BOT_TOKEN: 'tg-token', MAX_BOT_TOKEN: 'max-token' }, { factories, log })
    assert.deepEqual(bots.failed(), ['telegram'])
    assert.deepEqual(bots.active(), ['max'])
    assert.equal(bots.get('telegram'), undefined)
    assert.ok(lines.some((l) => l.includes('не удалось подключить telegram') && l.includes('сломанный адаптер')))
    assert.ok(!lines.some((l) => l.includes('tg-token')), 'токен попал в журнал')
  })

  test('без токенов ботов нет и отказов нет', async () => {
    const bots = await loadAdapters({ TELEGRAM_BOT_TOKEN: ' ', MAX_BOT_TOKEN: '' })
    assert.deepEqual(bots.active(), [])
    assert.deepEqual(bots.failed(), [])
  })

  test('настоящие модули подключаются из server/channels', async () => {
    const bots = await loadAdapters({ TELEGRAM_BOT_TOKEN: 'tg-token', MAX_BOT_TOKEN: 'max-token' }, { log: quiet().log })
    assert.deepEqual(bots.active().sort(), ['max', 'telegram'])
    assert.deepEqual(bots.failed(), [])
  })
})
