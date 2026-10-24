// Вкладка «Боты» (w2-cn-2): состояние каналов из окружения и предпросмотр ленты на настоящем сервере и своей базе.
// Без токенов в ленте проходится /start fair-mgupp → «Поймай брак» с картинками → заявка; запросов к мессенджерам нет;
// в базе (заявки, аудитория ботов, сессии, вопросы к Квасычу, воронка) после предпросмотра пусто.
// Раскладка кнопок и тела запросов в ленте совпадают с тем, что отправляют настоящие адаптеры Telegram и MAX.
// Запуск: pnpm test w2-channels-preview (нужен PostgreSQL, база создаётся и удаляется сама)

import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { createApp } from '../../server/app'
import { hashPassword } from '../../server/auth/password'
import { createMaxAdapter } from '../../server/channels/max'
import { createPreview, plainText, renderOutgoing, type PreviewFeed, type ViewButton, type ViewItem } from '../../server/channels/preview'
import type { Adapter, Registry } from '../../server/channels/registry'
import { createTelegramAdapter } from '../../server/channels/telegram'
import { PostgresStorage, type Sql } from '../../server/db'
import { HrRepo } from '../../server/db/hr'
import { createEngine } from '../../server/dialog/engine'
import { memoryStorage } from '../../server/dialog/storage'
import type { OutMessage } from '../../server/dialog/types'
import type { RateRule } from '../../server/middleware/rate-limit'
import { serverSettled, withTestDb } from './_db'

const password = 'проверка-пароля-1'
const noBots: Registry = { get: () => undefined, active: () => [], failed: () => [], start: () => {} }
const rules: RateRule[] = [{ name: 'api', burst: 100000, perMinute: 100000, match: (_m, p) => p.startsWith('/api/') }]
const SID = 'preview0test0sid'

/** Дата рождения человеку двадцати лет — от текущего момента, в виде ДД.ММ.ГГГГ */
function adultBirth() {
  const d = new Date()
  d.setFullYear(d.getFullYear() - 20)
  d.setMonth(0, 15)
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`
}

async function setup(sql: Sql, env: NodeJS.ProcessEnv = {}, bots: Registry = noBots) {
  const storage = new PostgresStorage(sql)
  const repo = new HrRepo(sql)
  await repo.createUser({ email: 'olga@bots.test', name: 'Ольга', role: 'hr', passwordHash: await hashPassword(password) })
  const engine = createEngine(storage, { siteUrl: 'https://season.example.ru' })
  const app = await createApp({ storage, engine, bots, hrToken: '', env: { NODE_ENV: 'test', SITE_URL: 'https://season.example.ru', ...env }, rateRules: rules })
  await serverSettled(sql)
  const login = await app.request('/api/hr/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'olga@bots.test', password }) })
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
  assert.ok(cookie, 'вход HR')
  const call = async <T>(method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { cookie, 'content-type': 'application/json', 'x-hr-request': '1' } })
    return { status: res.status, body: (await res.json()) as T }
  }
  return { app, call }
}

/** Кнопка в ленте: в сообщениях бота снизу вверх, потом в reply-клавиатуре Telegram */
function findButton(feed: PreviewFeed, re: RegExp): { b: ViewButton; ref: { turn: number; msg: number } } {
  for (const i of [...feed.items].reverse()) {
    if (i.kind !== 'bot' || !i.ref) continue
    for (const row of i.buttons) for (const b of row) if (re.test(b.text) && b.kind !== 'link') return { b, ref: i.ref }
  }
  if (feed.keyboard) for (const row of feed.keyboard.rows) for (const b of row) if (re.test(b.text)) return { b, ref: feed.keyboard.ref }
  throw new Error(`в ленте нет кнопки ${re}: ${JSON.stringify(feed.items.slice(-2))}`)
}

const lastBot = (feed: PreviewFeed) => [...feed.items].reverse().find((i): i is Extract<ViewItem, { kind: 'bot' }> => i.kind === 'bot')!

test('без токенов: состояние каналов из окружения, лента /start fair-mgupp → «Поймай брак» → заявка, в базе пусто, в мессенджеры ни одного запроса', async () => {
  await withTestDb('w2-channels-preview', async (sql) => {
    // Любой исходящий запрос из процесса записывается: в предпросмотре их быть не должно
    const outgoing: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      outgoing.push(String(input instanceof Request ? input.url : input))
      return realFetch(input, init)
    }) as typeof fetch
    try {
      const { app, call } = await setup(sql)

      const status = await call<{ site: { engine: boolean }; telegram: { state: string }; max: { state: string }; assistant: string }>('GET', '/api/hr/bots')
      assert.equal(status.status, 200)
      assert.deepEqual(status.body.site, { engine: true })
      assert.equal(status.body.telegram.state, 'off', 'Telegram без токена — «адаптер готов, токен не задан»')
      assert.equal(status.body.max.state, 'off')
      assert.equal(status.body.assistant, 'offline')

      let feed = (await call<PreviewFeed>('POST', '/api/hr/bots/preview', { sid: SID, channel: 'telegram', input: { type: 'start', payload: 'fair-mgupp' } })).body
      assert.equal(feed.items[0].kind, 'user')
      assert.ok(feed.items.some((i) => i.kind === 'note' && i.text.includes('fair-mgupp')), 'метка видна в ленте')
      assert.match(plainText(lastBot(feed).html), /Выбери раздел/)

      const press = async (re: RegExp) => {
        const { b, ref } = findButton(feed, re)
        const input = b.kind === 'contact' ? { type: 'contact' } : { type: 'press', ref, action: b.action, label: b.text }
        const r = await call<PreviewFeed>('POST', '/api/hr/bots/preview', { sid: SID, channel: 'telegram', input })
        assert.equal(r.status, 200, JSON.stringify(r.body))
        feed = r.body
      }
      const say = async (text: string) => {
        feed = (await call<PreviewFeed>('POST', '/api/hr/bots/preview', { sid: SID, channel: 'telegram', input: { type: 'text', text } })).body
      }

      // «Поймай брак»: пять раундов с картинками бутылок
      await press(/^Поймай брак$/)
      await press(/^Начать$/)
      const rounds: string[] = []
      for (let i = 0; i < 5; i++) {
        const round = lastBot(feed)
        assert.match(plainText(round.html), /Раунд \d из 5/)
        assert.ok(round.image?.startsWith('/api/media/'), 'у раунда есть картинка')
        rounds.push(round.image!)
        await press(/^1$/)
      }
      assert.match(plainText(feed.items.map((i) => (i.kind === 'bot' ? i.html : '')).join('\n')), /Поймано \d из 5/)
      // Пути к файлам на диске сервера в ленту не попадают: в теле запроса — путь от корня проекта
      assert.ok(!JSON.stringify(feed).includes(process.cwd()), 'в ленте адрес файла на сервере')
      // Картинка раунда отдаётся сайтом: HR видит её в ленте
      const img = await app.request(rounds[0])
      assert.equal(img.status, 200)
      assert.match(img.headers.get('content-type') ?? '', /^image\//)

      // Заявка: дата рождения → ФИО → контакт кнопкой → учёба → месяцы → когда выйти → вакансия → согласие
      await press(/^Откликнуться/)
      await say(adultBirth())
      await say('Петров Иван')
      assert.ok(feed.keyboard, 'в Telegram кнопка «Отправить номер» — reply-клавиатура под полем ввода')
      assert.equal(feed.placeholder, 'Телефон или @ник')
      await press(/номер/i)
      assert.equal(feed.keyboard, null, 'следующее сообщение убирает reply-клавиатуру')
      await say('МГУПП')
      await press(/^Готово$|^Пока не знаю$/)
      await press(/^Сразу$/)
      await press(/^Оставить эту$|^Любая подходящая$/)
      await press(/согласие/i)
      assert.match(plainText(lastBot(feed).html), /Заявка № \w+ отправлена/)

      // Тот же разговор в виде MAX: та же история, кнопки — inline, «Отправить номер» — request_contact в сообщении
      const max = (await call<PreviewFeed>('GET', `/api/hr/bots/preview?sid=${SID}&channel=max`)).body
      assert.equal(max.channel, 'max')
      assert.equal(max.keyboard, null)
      assert.ok(max.items.some((i) => i.kind === 'bot' && i.buttons.flat().some((b) => b.kind === 'contact')), 'в MAX кнопка контакта стоит в сообщении')
      assert.match(plainText(lastBot(max).html), /Заявка № \w+ отправлена/)

      // В базе ничего: ни заявки, ни аудитории бота, ни сессии, ни вопросов, ни событий воронки
      const counts = await sql<{ t: string; n: number }[]>`
        select 'applications' as t, count(*)::int as n from applications
        union all select 'bot_users', count(*)::int from bot_users
        union all select 'sessions', count(*)::int from sessions
        union all select 'kb_gaps', count(*)::int from kb_gaps
        union all select 'funnel_events', count(*)::int from funnel_events`
      for (const c of counts) assert.equal(c.n, 0, `${c.t}: предпросмотр записал в базу`)
      assert.deepEqual(outgoing, [], 'предпросмотр обратился в сеть')

      // «Начать заново» очищает ленту; чужие и кривые запросы отклоняются
      assert.equal((await call('DELETE', `/api/hr/bots/preview?sid=${SID}`)).status, 200)
      assert.equal((await call<PreviewFeed>('GET', `/api/hr/bots/preview?sid=${SID}&channel=telegram`)).body.items.length, 0)
      assert.equal((await call('POST', '/api/hr/bots/preview', { sid: SID, channel: 'web', input: { type: 'start' } })).status, 400)
      assert.equal((await call('POST', '/api/hr/bots/preview', { sid: SID, channel: 'telegram', input: { type: 'push' } })).status, 400)
      assert.equal((await call('POST', '/api/hr/bots/preview', { sid: 'x', channel: 'telegram', input: { type: 'start' } })).status, 400)
      assert.equal((await app.request('/api/hr/bots')).status, 401, 'без входа состояния каналов нет')
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

test('состояние каналов: поднятый Telegram — «работает» с режимом, не поднявшийся MAX — ошибка', async () => {
  await withTestDb('w2-channels-status', async (sql) => {
    const adapter = { channel: 'telegram', startPolling: async () => {}, handleWebhook: async () => {} } as Adapter
    const bots: Registry = { get: (c) => (c === 'telegram' ? { adapter, secret: 's' } : undefined), active: () => ['telegram'], failed: () => ['max'], start: () => {} }
    const { call } = await setup(sql, { PUBLIC_URL: 'https://season.example.ru', TELEGRAM_BOT_USERNAME: 'ochakovo_bot', GIGACHAT_AUTH_KEY: 'k' }, bots)
    const s = (await call<{ telegram: unknown; max: unknown; assistant: string }>('GET', '/api/hr/bots')).body
    assert.deepEqual(s.telegram, { state: 'running', via: 'webhook', name: 'ochakovo_bot' })
    assert.deepEqual(s.max, { state: 'failed', via: null, name: null })
    assert.equal(s.assistant, 'gigachat')
  })
})

test('сессии предпросмотра живут ограниченно: истекают по времени и вытесняются сверх лимита', async () => {
  let now = 0
  const p = createPreview({ siteUrl: 'https://season.example.ru', ttlMs: 1000, maxSessions: 2, now: () => now })
  await p.send('a', 'telegram', { type: 'start' })
  now += 10
  await p.send('b', 'telegram', { type: 'start' })
  now += 10
  await p.send('c', 'max', { type: 'start' })
  assert.equal(p.size(), 2, 'самая давняя сессия вытеснена')
  assert.equal(p.feed('a', 'telegram').items.length, 0)
  assert.ok(p.feed('c', 'max').items.length > 0)
  now += 5000
  assert.equal(p.feed('b', 'telegram').items.length, 0, 'сессия истекла')
  assert.equal(p.size(), 0)
})

// ── Раскладка совпадает с адаптерами ───────────────────────────────────────

type Hit = { url: string; type: string; raw: string; json: any }

async function fakeApi(handler: (hit: Hit, res: ServerResponse) => void) {
  const hits: Hit[] = []
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const buf = Buffer.concat(chunks)
      const type = req.headers['content-type'] ?? ''
      const hit = { url: req.url ?? '/', type, raw: buf.toString('utf8'), json: type.includes('json') ? JSON.parse(buf.toString('utf8')) : null }
      hits.push(hit)
      handler(hit, res)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits, close: () => new Promise<void>((r) => server.close(() => r())) }
}

const reply = (res: ServerResponse, body: unknown) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** Поле multipart-формы: подпись и клавиатура первой отправки картинки */
function formField(raw: string, name: string): string | undefined {
  const m = new RegExp(`name="${name}"\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`).exec(raw)
  // Переводы строк в полях формы приходят как \r\n — так их кодирует FormData
  return m?.[1].replace(/\r\n/g, '\n')
}

/** Сообщения сценария для сверки: картинка с подписью, длинный текст, ряды по 8 кнопок, ссылки, контакт и сообщение после него */
async function sampleMessages(): Promise<OutMessage[]> {
  const messages: OutMessage[] = []
  const engine = createEngine(memoryStorage(), { siteUrl: 'https://season.example.ru', random: () => 0.42 })
  const user = { channel: 'telegram' as const, id: '1' }
  for (const event of [
    { type: 'start', payload: 'fair-mgupp' },
    { type: 'action', action: 'm:game' },
    { type: 'action', action: 'g:go' },
    { type: 'action', action: 'm:vac' },
    { type: 'action', action: 'm:apply' },
  ] as const) {
    messages.push(...(await engine.handle(user, event)).messages)
  }
  const long = Array.from({ length: 50 }, (_, i) => `Абзац ${i + 1}. **Жирная мысль ${i + 1}** и обычный текст про смены и общежитие рядом с заводом.`).join('\n\n')
  const eight = Array.from({ length: 8 }, (_, i) => ({ kind: 'action' as const, text: `К${i + 1}`, action: `k:${i + 1}` }))
  const links = Array.from({ length: 4 }, (_, i) => ({ kind: 'link' as const, text: `Ссылка ${i + 1}`, url: `https://season.example.ru/${i + 1}` }))
  messages.push(
    { text: long, buttons: [[{ kind: 'action', text: 'Меню', action: 'm' }]] },
    { text: 'Ряды', buttons: [eight, links] },
    { text: 'Оставь телефон', input: 'phone', buttons: [[{ kind: 'contact', text: 'Отправить номер' }], [{ kind: 'action', text: 'Отмена', action: 'x' }, { kind: 'link', text: 'Политика', url: 'https://season.example.ru/privacy' }]] },
    { text: 'Где учишься?', buttons: [[{ kind: 'action', text: 'Уже не учусь', action: 'a:nostudy' }]] },
  )
  return messages
}

test('Telegram: тела запросов в ленте — те же, что отправляет адаптер (кнопки, части текста, картинки, reply-клавиатура)', async () => {
  const messages = await sampleMessages()
  let id = 0
  const api = await fakeApi((hit, res) => {
    const method = hit.url.split('/').pop()!
    reply(res, { ok: true, result: method === 'sendPhoto' ? { message_id: ++id, chat: { id: 1, type: 'private' }, photo: [{ file_id: 'F' }] } : { message_id: ++id, chat: { id: 1, type: 'private' } } })
  })
  try {
    const tg = createTelegramAdapter('T', { apiBase: api.base, log: { info() {}, warn() {}, error() {} } })
    await tg.sendTo('100200300', messages)
    const view = renderOutgoing('telegram', messages)
    const calls = view.flatMap((i) => (i.kind === 'bot' ? i.calls : []))
    assert.equal(calls.length, api.hits.length, `${calls.map((c) => c.method).join(',')} ↔ ${api.hits.map((h) => h.url.split('/').pop()).join(',')}`)
    calls.forEach((c, n) => {
      const hit = api.hits[n]
      assert.equal(hit.url.split('/').pop(), c.method)
      const body = c.body as Record<string, unknown>
      if (c.method === 'sendPhoto' && !hit.json) {
        // Первая отправка картинки — файлом: подпись и кнопки — поля формы
        assert.equal(formField(hit.raw, 'caption'), body.caption)
        assert.deepEqual(JSON.parse(formField(hit.raw, 'reply_markup') ?? 'null'), body.reply_markup ?? null)
        return
      }
      const { photo: _p, message_id: _m, ...sent } = hit.json
      const { photo: _vp, message_id: _vm, ...shown } = body
      assert.deepEqual(sent, shown, `${c.method} №${n}`)
    })
    assert.ok(calls.some((c) => c.method === 'editMessageReplyMarkup'), 'после reply-клавиатуры кнопки добавляются правкой')
    assert.ok(view.some((i) => i.kind === 'bot' && i.html === 'Ссылки:'), 'ссылки при reply-клавиатуре — отдельным сообщением')
  } finally {
    await api.close()
  }
})

test('MAX: тела запросов в ленте — те же, что отправляет адаптер (ряды не длиннее 7 и 3 для ссылок, картинка к первой части)', async () => {
  const messages = await sampleMessages()
  const api = await fakeApi((hit, res) => {
    const u = new URL(hit.url, 'http://x')
    if (u.pathname === '/uploads') return reply(res, { url: `${api.base}/slot` })
    if (u.pathname === '/slot') return reply(res, { token: 'IMG' })
    reply(res, { message: { body: { mid: 'm' } } })
  })
  try {
    const max = createMaxAdapter('M', { apiBase: api.base, chatInterval: 0, log: { info() {}, warn() {}, error() {} } })
    await max.sendTo('7', messages)
    const sent = api.hits.filter((h) => h.url.startsWith('/messages'))
    const view = renderOutgoing('max', messages)
    const calls = view.flatMap((i) => (i.kind === 'bot' ? i.calls : []))
    assert.equal(calls.length, sent.length)
    const tokenless = (b: any) => JSON.parse(JSON.stringify(b).replace(/"token":"[^"]*"/g, '"token":"*"'))
    calls.forEach((c, n) => assert.deepEqual(tokenless(sent[n].json), tokenless(c.body), `сообщение №${n}`))
    for (const h of sent) {
      for (const a of h.json.attachments) {
        if (a.type !== 'inline_keyboard') continue
        for (const row of a.payload.buttons) {
          assert.ok(row.length <= 7)
          if (row.some((b: { type: string }) => b.type !== 'callback')) assert.ok(row.length <= 3)
        }
      }
    }
    // Кнопки в ленте — те же ряды, что ушли в MAX
    const rows = view.filter((i) => i.kind === 'bot' && i.buttons.length).map((i) => (i as Extract<ViewItem, { kind: 'bot' }>).buttons.map((r) => r.map((b) => b.text)))
    const sentRows = sent.flatMap((h) => h.json.attachments.filter((a: { type: string }) => a.type === 'inline_keyboard').map((a: any) => a.payload.buttons.map((r: any[]) => r.map((b) => b.text))))
    assert.deepEqual(rows, sentRows)
  } finally {
    await api.close()
  }
})
