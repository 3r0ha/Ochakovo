// GigaChat готов к живому ключу (w2-as-2): общий срок ответа вместе с очередью, прерывание запроса и паузы перед повтором,
// переполненная очередь — сразу офлайн; guard отклоняет выдуманные время, интервалы, проценты, «бесплатно», дни выплат и ДМС.
// Сеть не нужна: fetch подменён. Запуск: pnpm test w2-assistant-gigachat

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAssistant, DEADLINE_MS } from '../../server/assistant/assistant'
import { checkAnswer } from '../../server/assistant/guard'
import type { AssistantInput } from '../../server/assistant/types'
import { createGigaChat, createLimiter } from '../../server/llm/gigachat'
import type { ChatRequest, ChatResult, LlmProvider } from '../../server/llm/provider'

const input = (question: string, channel = 'web'): AssistantInput => ({ question, history: [], sessionId: `deadline-${question}`, channel })
const quiet = () => {}

type FakeOptions = { delayMs: number; status?: number; retryAfter?: string; honorAbort?: boolean }

/** Подменённый fetch: токен сразу, чат — через delayMs. Запоминает, сколько было запросов и сколько из них прервали */
function fakeFetch({ delayMs, status = 200, retryAfter, honorAbort = true }: FakeOptions) {
  const n = { chat: 0, aborted: 0 }
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('/oauth')) {
      return new Response(JSON.stringify({ access_token: 't', expires_at: Date.now() + 30 * 60_000 }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    n.chat++
    const signal = init?.signal ?? undefined
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs)
      timer.unref()
      if (honorAbort && signal) {
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            n.aborted++
            reject(signal.reason ?? new Error('aborted'))
          },
          { once: true },
        )
      }
    })
    const body = status === 200 ? { choices: [{ message: { role: 'assistant', content: 'Оператор склада — от 60 000 ₽ в месяц.' }, finish_reason: 'stop' }] } : { message: 'busy' }
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...(retryAfter ? { 'retry-after': retryAfter } : {}) } })
  }) as typeof fetch
  return { impl, n }
}

test('срок по умолчанию: 25 с в ботах, 20 с на сайте', () => {
  assert.equal(DEADLINE_MS.bot, 25_000)
  assert.equal(DEADLINE_MS.web, 20_000)
})

test('GigaChat отвечает через 30 с — человек получает офлайн-ответ раньше срока, запрос прерван', async () => {
  const fake = fakeFetch({ delayMs: 30_000 })
  const logs: string[] = []
  const provider = createGigaChat({ authKey: 'k', fetchImpl: fake.impl, retryBaseMs: 1, log: quiet })
  const assistant = createAssistant({ provider, log: (m) => logs.push(m), deadlineMs: { web: 300, bot: 400 } })
  for (const channel of ['web', 'telegram']) {
    const started = Date.now()
    const r = await assistant.answer(input('Сколько платят на складе?', channel))
    const took = Date.now() - started
    assert.ok(took < (channel === 'web' ? 300 : 400) + 200, `${channel}: ответ за ${took} мс`)
    assert.equal(r.source, 'fallback')
    assert.match(r.text.replace(/[  ]/g, ' '), /На складе платят 56 000–60 000 ₽/)
  }
  assert.ok(fake.n.aborted >= 1, 'запрос к модели прерван, а не брошен висеть')
  assert.ok(logs.some((l) => l.startsWith('таймаут')), logs.join('\n'))
})

test('провайдер, который не слушает срок, всё равно не задерживает ответ', async () => {
  const fake = fakeFetch({ delayMs: 30_000, honorAbort: false })
  const provider = createGigaChat({ authKey: 'k', fetchImpl: fake.impl, retryBaseMs: 1, log: quiet })
  const assistant = createAssistant({ provider, log: quiet, deadlineMs: { web: 250 } })
  const started = Date.now()
  const r = await assistant.answer(input('Есть общежитие?'))
  assert.ok(Date.now() - started < 500, `ответ за ${Date.now() - started} мс`)
  assert.equal(r.source, 'fallback')
  assert.match(r.text, /общежити/)
})

test('пять вопросов одновременно при одном запросе к модели: каждый укладывается в срок', async () => {
  const fake = fakeFetch({ delayMs: 120 })
  const provider = createGigaChat({ authKey: 'k', fetchImpl: fake.impl, retryBaseMs: 1, log: quiet, concurrency: 1 })
  const assistant = createAssistant({ provider, log: quiet, deadlineMs: { web: 600 } })
  const questions = ['Сколько платят на складе?', 'Есть общежитие?', 'Какой график?', 'Кто будет учить?', 'Когда зарплата?']
  const started = Date.now()
  const replies = await Promise.all(
    questions.map(async (q) => {
      const r = await assistant.answer(input(q))
      return { r, took: Date.now() - started }
    }),
  )
  for (const { r, took } of replies) {
    assert.ok(took < 600 + 250, `ответ за ${took} мс`)
    assert.ok(r.text.length > 20, r.text)
  }
  // Кто-то успел получить ответ модели, остальным ответил офлайн-режим — и никто не ждал дольше срока
  assert.ok(replies.some(({ r }) => r.source === 'fallback'), replies.map(({ r }) => r.source).join())
})

test('очередь длиннее разрешённого — сразу офлайн, в журнале «таймаут»', async () => {
  const fake = fakeFetch({ delayMs: 400 })
  const logs: string[] = []
  const provider = createGigaChat({ authKey: 'k', fetchImpl: fake.impl, retryBaseMs: 1, log: quiet, concurrency: 1, maxQueue: 1 })
  const assistant = createAssistant({ provider, log: (m) => logs.push(m), deadlineMs: { web: 2_000 } })
  // Двое уже в работе и в очереди — третьему ждать нечего
  const busy = [assistant.answer(input('Сколько платят на складе?')), assistant.answer(input('Есть общежитие?'))]
  await new Promise((r) => setTimeout(r, 30))
  const started = Date.now()
  const r = await assistant.answer(input('Когда зарплата?'))
  assert.ok(Date.now() - started < 150, `ответ за ${Date.now() - started} мс`)
  assert.equal(r.source, 'fallback')
  assert.match(r.text, /12-го и 27-го/)
  assert.ok(logs.some((l) => /таймаут: очередь/.test(l)), logs.join('\n'))
  await Promise.all(busy)
})

test('пауза перед повтором прерывается сроком, повтор внутри срока — один', async () => {
  const fake = fakeFetch({ delayMs: 5, status: 503, retryAfter: '5' })
  const provider = createGigaChat({ authKey: 'k', fetchImpl: fake.impl, retryBaseMs: 1, log: quiet })
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 200).unref()
  const started = Date.now()
  const r = await provider.chat({ model: 'answer', messages: [{ role: 'user', content: 'x' }], signal: controller.signal })
  assert.ok(Date.now() - started < 400, `ответ за ${Date.now() - started} мс — пауза в 5 с не прервана`)
  assert.deepEqual(r, { kind: 'error', reason: 'timeout' })

  const fast = fakeFetch({ delayMs: 1, status: 503 })
  const p2 = createGigaChat({ authKey: 'k', fetchImpl: fast.impl, retryBaseMs: 1, log: quiet })
  const r2 = await p2.chat({ model: 'answer', messages: [{ role: 'user', content: 'x' }], signal: new AbortController().signal })
  assert.equal(r2.kind, 'error')
  assert.equal(fast.n.chat, 2, 'со сроком — один повтор')
  const r3 = await p2.chat({ model: 'answer', messages: [{ role: 'user', content: 'x' }] })
  assert.equal(r3.kind, 'error')
  assert.equal(fast.n.chat, 2 + 4, 'без срока — прежние три повтора')
})

test('срок снимает запрос из очереди: место освобождается', async () => {
  const limit = createLimiter(1, 5)
  let release!: () => void
  const first = limit(() => new Promise<void>((r) => (release = r)))
  const controller = new AbortController()
  const queued = limit(async () => 'не должен начаться', controller.signal)
  assert.deepEqual(limit.stats(), { active: 1, waiting: 1 })
  controller.abort()
  await assert.rejects(queued, /timeout/)
  assert.deepEqual(limit.stats(), { active: 1, waiting: 0 })
  release()
  await first
  assert.deepEqual(limit.stats(), { active: 0, waiting: 0 })
})

test('guard отклоняет выдуманное время, интервалы, проценты, «бесплатно», дни выплат и ДМС', () => {
  for (const bad of [
    'Автобус ходит каждые 15 минут.',
    'Смена с 7:00 до 19:00.',
    'Смена с 9 до 21.',
    'Медкнижку оплачивает завод.',
    'Медкнижка за счёт компании.',
    'Доплата за ночь 20 %.',
    'Общежитие бесплатное.',
    'Обед бесплатный.',
    'Проезд на корпоративном автобусе за счёт компании.',
    'Выплаты 10-го и 25-го.',
    'Зарплату перечисляют 15 числа.',
    'У сотрудников есть ДМС.',
  ]) {
    const r = checkAnswer(bad)
    assert.ok(!r.ok, `пропущено: «${bad}»`)
  }
})

test('guard пропускает факты из данных', () => {
  for (const good of [
    'График 2/2, смены по 12 часов.',
    'Мерчандайзер — 5/2 по 8 часов.',
    'Берут с 18 лет.',
    'HR позвонит в течение до 2 рабочих дней.',
    'Завод разливает до 70 000 бутылок в час.',
    'Суммы до вычета НДФЛ 13 %.',
    'Смена с 8:00 до 20:00 или с 20:00 до 8:00.',
    'Дневная смена — с 8 до 20.',
    'Медосмотр и спецодежда за счёт компании.',
    'Половину стоимости обеда оплачивает компания.',
    '50 % стоимости общежития для студентов оплачивает компания.',
    'Бесплатная практика — в разных отделах по договорённости, общежитие для студентов — 3 400 ₽.',
    'В условиях практики ДМС не указан.',
    'Зарплату платят два раза в месяц — 12-го и 27-го.',
    'Прачечная работает по будням с 8:30 до 16:30, чистые вещи готовы через 1–2 дня.',
    'Электричкой до платформы Мещерская, оттуда 15 минут пешком.',
    'Я Квасыч, бот-помощник «Очаково».',
  ]) {
    const r = checkAnswer(good)
    assert.ok(r.ok, `«${good}» → ${r.ok ? '' : r.problems.join('; ')}`)
  }
})

test('модель пишет «Общежитие бесплатное» — ответ отклонён, человек получает офлайн-ответ (source = guard)', async () => {
  const replies: ChatResult[] = [
    { kind: 'text', content: 'черновик' },
    { kind: 'text', content: 'Общежитие бесплатное, автобус ходит каждые 15 минут.' },
  ]
  const requests: ChatRequest[] = []
  const provider: LlmProvider = {
    name: 'scripted',
    async chat(request) {
      requests.push(request)
      return replies[requests.length - 1] ?? { kind: 'error', reason: 'script-exhausted' }
    },
  }
  const r = await createAssistant({ provider, log: quiet }).answer(input('Общага бесплатная?'))
  assert.equal(r.source, 'guard')
  assert.match(r.text, /^Нет, платное/)
  assert.ok(requests.every((q) => q.signal instanceof AbortSignal), 'срок уходит в каждый запрос к модели')
})
