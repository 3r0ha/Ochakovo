// /api/dialog: очередь по чату, лимит нажатий на чат, заявка в ответе сайту, код приглашения.
// Движок — заглушка: проверяется маршрут, сценарии бота проверяет dialog-test.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { Hono } from 'hono'
import { CHAT_PRESSES_PER_MINUTE, dialogRoutes } from '../../server/api/dialog'
import type { Registry } from '../../server/channels/registry'
import type { DialogApplication, DialogEngine, DialogEvent, DialogUser, HandleMeta } from '../../server/dialog/types'
import { defaultRules, rateLimit } from '../../server/middleware/rate-limit'

const bots: Registry = { get: () => undefined, active: () => [], failed: () => [], start: () => {} }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Заглушка движка с честной гонкой: «Отправить» читает состояние, ждёт базу и только потом пишет.
 * Без очереди два одновременных нажатия оба видят «ещё не отправлено» и создают две заявки
 */
function racyEngine(delay = 30) {
  const sent = new Set<string>()
  const applications: DialogApplication[] = []
  const calls: { user: DialogUser; event: DialogEvent; meta?: HandleMeta }[] = []
  const engine: DialogEngine = {
    async handle(user, event, meta) {
      calls.push({ user, event, meta })
      if (event.type === 'action' && event.action === 'a:ok') {
        const already = sent.has(user.id)
        await sleep(delay)
        if (already) return { messages: [{ text: 'Заявка уже у HR' }] }
        sent.add(user.id)
        const application: DialogApplication = { id: String(applications.length + 1), token: 't'.repeat(32), name: 'Аня', phone: '+79991234567', contact: '', vacancyId: 'any', friend: '' }
        applications.push(application)
        return { messages: [{ text: `Заявка №${application.id} у HR` }], application }
      }
      if (event.type === 'action' && event.action === 'slow') await sleep(delay)
      return { messages: [{ text: 'Ок' }] }
    },
  }
  return { engine, applications, calls }
}

type App = { request: (path: string, init: RequestInit) => Response | Promise<Response> }

const press = (app: App, body: unknown, headers: Record<string, string> = {}) =>
  app.request('/api/dialog', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

const web = (id: string, action: string, extra: Record<string, unknown> = {}) => ({ user: { channel: 'web', id }, event: { type: 'action', action }, ...extra })

describe('очередь по чату', () => {
  test('два одновременных «Отправить» из одного чата — одна заявка', async () => {
    const { engine, applications } = racyEngine()
    const app = dialogRoutes({ engine, bots })
    const [a, b] = await Promise.all([press(app, web('chat-1', 'a:ok')), press(app, web('chat-1', 'a:ok'))])
    assert.equal(a.status, 200)
    assert.equal(b.status, 200)
    assert.equal(applications.length, 1)
    const bodies = [await a.json(), await b.json()] as { application?: DialogApplication }[]
    assert.equal(bodies.filter((r) => r.application).length, 1)
  })

  test('разные чаты не ждут друг друга', async () => {
    const { engine } = racyEngine(150)
    const app = dialogRoutes({ engine, bots })
    const started = Date.now()
    await Promise.all(Array.from({ length: 5 }, (_, i) => press(app, web(`parallel-${i}`, 'slow'))))
    assert.ok(Date.now() - started < 600, `чаты шли по очереди: ${Date.now() - started} мс`)
  })

  test('ошибка движка не стопорит очередь чата', async () => {
    let fail = true
    const engine: DialogEngine = {
      async handle() {
        if (fail) {
          fail = false
          throw new Error('сбой')
        }
        return { messages: [{ text: 'Ок' }] }
      },
    }
    const app = new Hono()
    app.onError((_e, c) => c.json({ error: 'internal' }, 500))
    app.route('/', dialogRoutes({ engine, bots }))
    assert.equal((await press(app, web('chat-err', 'm'))).status, 500)
    assert.equal((await press(app, web('chat-err', 'm'))).status, 200)
  })
})

describe('лимит нажатий на чат', () => {
  test(`${CHAT_PRESSES_PER_MINUTE} нажатий подряд проходят, следующее — 429 с Retry-After`, async () => {
    const { engine } = racyEngine(0)
    const t = Date.now()
    const app = dialogRoutes({ engine, bots, now: () => t })
    for (let i = 0; i < CHAT_PRESSES_PER_MINUTE; i++) assert.equal((await press(app, web('burst', 'm'))).status, 200)
    const res = await press(app, web('burst', 'm'))
    assert.equal(res.status, 429)
    const body = (await res.json()) as { error: string; retryAfter: number }
    assert.equal(body.error, 'rate_limited')
    assert.ok(body.retryAfter >= 1)
    assert.equal(res.headers.get('retry-after'), String(body.retryAfter))
    // Другой чат с того же адреса не задет
    assert.equal((await press(app, web('neighbour', 'm'))).status, 200)
  })

  test('100 нажатий за минуту из одного чата упираются в 429', async () => {
    const { engine, calls } = racyEngine(0)
    let t = Date.now()
    const app = dialogRoutes({ engine, bots, now: () => t })
    const statuses: number[] = []
    for (let i = 0; i < 100; i++) {
      statuses.push((await press(app, web('flood', 'm'))).status)
      t += 600
    }
    const limited = statuses.filter((s) => s === 429).length
    assert.ok(limited >= 20, `429 только ${limited} раз`)
    assert.equal(calls.length, 100 - limited, 'отклонённое нажатие дошло до движка')
  })

  test('10 чатов с одного адреса раз в 6 с три минуты подряд — ни одного 429 (вместе с потолком на адрес)', async () => {
    const { engine } = racyEngine(0)
    let t = Date.now()
    const app = new Hono()
    app.use('*', rateLimit(defaultRules, () => t))
    app.route('/', dialogRoutes({ engine, bots, now: () => t }))
    const statuses: number[] = []
    for (let tick = 0; tick < 30; tick++) {
      for (let chat = 0; chat < 10; chat++) statuses.push((await press(app, web(`fair-${chat}`, 'm'), { 'x-forwarded-for': '10.0.0.1' })).status)
      t += 6000
    }
    assert.equal(statuses.length, 300)
    assert.deepEqual([...new Set(statuses)], [200])
  })
})

describe('заявка и код приглашения', () => {
  test('application из ответа движка доходит до сайта', async () => {
    const { engine } = racyEngine(0)
    const app = dialogRoutes({ engine, bots })
    const res = await press(app, web('apply-web', 'a:ok'))
    const body = (await res.json()) as { messages: { text: string }[]; application?: DialogApplication }
    assert.equal(body.messages[0].text, 'Заявка №1 у HR')
    assert.deepEqual(body.application, { id: '1', token: 't'.repeat(32), name: 'Аня', phone: '+79991234567', contact: '', vacancyId: 'any', friend: '' })
  })

  test('внешнему каналу с серверным токеном заявку с токеном не отдаём', async () => {
    const { engine } = racyEngine(0)
    const app = dialogRoutes({ engine, bots })
    const token = 'x'.repeat(32)
    process.env.DIALOG_API_TOKEN = token
    try {
      const res = await press(app, { user: { channel: 'telegram', id: 'tg-1' }, event: { type: 'action', action: 'a:ok' } }, { 'x-dialog-token': token })
      assert.equal(res.status, 200)
      const body = (await res.json()) as { messages: unknown[]; application?: unknown }
      assert.equal(body.messages.length, 1)
      assert.equal(body.application, undefined)
    } finally {
      delete process.env.DIALOG_API_TOKEN
    }
  })

  test('refCode из тела уходит в HandleMeta.refCode, кривой код отбрасывается', async () => {
    const { engine, calls } = racyEngine(0)
    const app = dialogRoutes({ engine, bots })
    const cases: [unknown, string | undefined][] = [
      ['kvas23', 'kvas23'],
      ['KVAS23', undefined],
      ['kvas1', undefined],
      ['kvas10', undefined],
      ['kvas234', undefined],
      [123456, undefined],
      [undefined, undefined],
    ]
    for (const [refCode, expected] of cases) {
      const res = await press(app, web('ref', 'm:friend', { refCode }))
      assert.equal(res.status, 200)
      assert.equal(calls.at(-1)!.meta?.refCode, expected, `refCode ${String(refCode)}`)
    }
    // В обёртке meta — так же, вместе с прогрессом заданий и заявкой браузера
    await press(app, web('ref', 'm', { meta: { refCode: 'abcdef', application: { id: '7', token: 'tok' } }, siteProgress: { game: true } }))
    assert.deepEqual(calls.at(-1)!.meta, { siteProgress: { game: true }, application: { id: '7', token: 'tok' }, refCode: 'abcdef' })
    // Без данных сайта meta не передаётся вовсе
    await press(app, web('ref', 'm'))
    assert.equal(calls.at(-1)!.meta, undefined)
  })

  test('внешний канал не передаёт данные сайта в движок', async () => {
    const { engine, calls } = racyEngine(0)
    const app = dialogRoutes({ engine, bots })
    const token = 'y'.repeat(32)
    process.env.DIALOG_API_TOKEN = token
    try {
      await press(app, { user: { channel: 'max', id: 'max-1' }, event: { type: 'start' }, refCode: 'kvas23', siteProgress: { game: true } }, { 'x-dialog-token': token })
      assert.equal(calls.at(-1)!.meta, undefined)
    } finally {
      delete process.env.DIALOG_API_TOKEN
    }
  })
})
