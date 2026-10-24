// Ответы HR на «Вопросы к Квасычу» (w2-as-1) на настоящем сервере и своей базе: вопрос без ответа попадает в пробелы,
// HR отвечает, и тот же вопрос через /api/dialog получает текст HR без нового пробела; перефразированный — тоже;
// выключенный ответ снова ведёт к «спроси в отделе персонала»; guard пропускает суммы из ответов HR и режет чужие.
// Проверка текста: без «!», без дат, личные телефоны и почта вычищаются, род — подсказкой.
// Запуск: pnpm test w2-assistant-hr (нужен PostgreSQL, база создаётся и удаляется сама)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAssistant } from '../../server/assistant/assistant'
import { checkAnswer } from '../../server/assistant/guard'
import { knowledgeText } from '../../server/assistant/knowledge'
import type { KbGapInput } from '../../server/assistant/types'
import { createApp } from '../../server/app'
import { hashPassword } from '../../server/auth/password'
import type { Registry } from '../../server/channels/registry'
import { PostgresStorage, type Sql } from '../../server/db'
import { HrRepo } from '../../server/db/hr'
import { createEngine } from '../../server/dialog/engine'
import type { RateRule } from '../../server/middleware/rate-limit'
import { offlineProvider } from '../../server/llm/offline'
import { serverSettled, withTestDb } from './_db'

const password = 'проверка-пароля-1'
const bots: Registry = { get: () => undefined, active: () => [], failed: () => [], start: () => {} }
const rules: RateRule[] = [{ name: 'api', burst: 100000, perMinute: 100000, match: (_m, p) => p.startsWith('/api/') }]
const plain = (t: string) => t.replace(/[  ]/g, ' ')

const PARKING = 'есть ли парковка для сотрудников'
const HR_TEXT = 'Отдельной парковки для сотрудников нет: удобнее доехать на корпоративном автобусе от м. «Озёрная».'

async function setup(sql: Sql) {
  const storage = new PostgresStorage(sql)
  const repo = new HrRepo(sql)
  await repo.createUser({ email: 'anna@kb.test', name: 'Анна', role: 'hr', passwordHash: await hashPassword(password) })
  const engine = createEngine(storage, { siteUrl: 'https://season.example.ru' })
  const app = await createApp({ storage, engine, bots, hrToken: '', env: { NODE_ENV: 'test', SITE_URL: 'https://season.example.ru' }, rateRules: rules })
  await serverSettled(sql)
  const login = await app.request('/api/hr/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'anna@kb.test', password }) })
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
  assert.ok(cookie, 'вход HR')
  const call = async <T>(method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { cookie, 'content-type': 'application/json', 'x-hr-request': '1' } })
    return { status: res.status, body: (await res.json()) as T }
  }
  let chat = 0
  /** Вопрос в чат на сайте — тем же путём, что у посетителя: POST /api/dialog */
  const ask = async (text: string) => {
    const res = await app.request('/api/dialog', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: { channel: 'web', id: `kb-${++chat}` }, event: { type: 'text', text } }),
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { messages: { text: string }[] }
    return plain(body.messages.map((m) => m.text).join('\n\n'))
  }
  const gapCount = async () => (await sql<{ n: number }[]>`select count(*)::int as n from kb_gaps`)[0].n
  return { app, call, ask, gapCount }
}

type Answer = { id: number; question: string; answer: string; variants: string[]; enabled: boolean; gapId: number | null; authorName: string }
type Check = { errors: Record<string, string>; hints: string[]; cleaned: { question: string; answer: string; variants: string[] } }

test('вопрос без ответа → ответ HR → тот же вопрос и его формулировки получают текст HR, нового пробела нет', async () => {
  await withTestDb('w2-assistant-hr', async (sql) => {
    const { app, call, ask, gapCount } = await setup(sql)

    // 1. Вопроса нет в данных — честное «спроси в отделе персонала» и строка в «Вопросах к Квасычу»
    const before = await ask(PARKING)
    assert.match(before, /Точного ответа в моих данных нет/)
    assert.equal(await gapCount(), 1)
    const gaps = await call<{ items: { id: number; question: string }[] }>('GET', '/api/hr/kb-gaps')
    const gap = gaps.body.items[0]
    assert.equal(gap.question, PARKING)

    // 2. HR отвечает: вопрос из пробела и одна своя формулировка
    const saved = await call<{ answer: Answer; resolved: number }>('POST', '/api/hr/kb-answers', {
      gapId: gap.id,
      question: gap.question,
      answer: HR_TEXT,
      variants: ['можно приехать на своей машине?'],
    })
    assert.equal(saved.status, 201, JSON.stringify(saved.body))
    assert.equal(saved.body.answer.authorName, 'Анна')
    assert.equal(saved.body.answer.gapId, gap.id)
    assert.equal((await call<{ items: unknown[] }>('GET', '/api/hr/kb-gaps')).body.items.length, 0, 'вопрос помечен «Разобрано»')
    const [row] = await sql<{ resolved: boolean; answer_id: string }[]>`select resolved, answer_id from kb_gaps where id = ${gap.id}`
    assert.ok(row.resolved && Number(row.answer_id) === saved.body.answer.id)

    // 3. Тот же вопрос и перефразированные — текст HR, новых пробелов нет
    for (const q of [PARKING, 'парковка для сотрудников есть?', 'А парковка у завода есть?', 'можно приехать на своей машине?']) {
      const text = await ask(q)
      assert.equal(text.split('\n\n')[0], HR_TEXT, `«${q}» → ${text}`)
    }
    assert.equal(await gapCount(), 1, 'новых вопросов в «Вопросах к Квасычу» нет')
    // Не про то — ответ HR не подменяет основной: «сколько платят сотрудникам» остаётся про зарплату
    assert.match(await ask('сколько платят сотрудникам'), /56 000/)

    // 4. Помощник: escalated = false, тот же текст и в составном вопросе
    const logged: KbGapInput[] = []
    const assistant = createAssistant({ provider: offlineProvider(), logGap: async (g) => void logged.push(g), log: () => {} })
    const direct = await assistant.answer({ question: PARKING, history: [], sessionId: 'kb', channel: 'telegram' })
    assert.equal(direct.text, HR_TEXT)
    assert.equal(direct.escalated, false)
    const both = await assistant.answer({ question: 'сколько стоит общежитие и есть ли парковка для сотрудников', history: [], sessionId: 'kb2', channel: 'web' })
    assert.ok(plain(both.text).includes('3 400 ₽') && both.text.includes(HR_TEXT), both.text)
    assert.equal(logged.length, 0)
    // GigaChat видит ответы HR в базе знаний
    assert.ok(knowledgeText().includes('## Ответы отдела персонала') && knowledgeText().includes(HR_TEXT))

    // 5. Выключенный ответ — снова к HR и снова в «Вопросы к Квасычу»
    const off = await call<{ answer: Answer }>('PATCH', `/api/hr/kb-answers/${saved.body.answer.id}`, { enabled: false })
    assert.equal(off.status, 200)
    assert.equal(off.body.answer.enabled, false)
    assert.match(await ask(PARKING), /Точного ответа в моих данных нет/)
    assert.equal(await gapCount(), 2)

    // 6. Включили и поправили — Квасыч сразу отвечает новым текстом, без перезапуска
    const fixed = 'Отдельной парковки у завода нет. До завода ходит корпоративный автобус от м. «Озёрная».'
    const on = await call<{ answer: Answer; resolved: number }>('PATCH', `/api/hr/kb-answers/${saved.body.answer.id}`, { enabled: true, answer: fixed })
    assert.equal(on.status, 200, JSON.stringify(on.body))
    assert.equal(on.body.resolved, 1, 'открытый вопрос про парковку закрылся этим ответом')
    assert.equal((await ask(PARKING)).split('\n\n')[0], fixed)

    const list = await call<Answer[]>('GET', '/api/hr/kb-answers')
    assert.equal(list.body.length, 1)
    assert.equal(list.body[0].answer, fixed)
    assert.equal((await call('PATCH', '/api/hr/kb-answers/99999', { enabled: false })).status, 404)

    // Без входа — 401
    const anon = await app.request('/api/hr/kb-answers')
    assert.equal(anon.status, 401)
  })
})

test('guard: суммы из одобренных ответов HR разрешены, суммы ниоткуда — нет', async () => {
  await withTestDb('w2-assistant-hr-guard', async (sql) => {
    const { call } = await setup(sql)
    assert.ok(!checkAnswer('Пропуск на машину стоит 1 250 ₽ в месяц.').ok, 'до ответа HR суммы 1 250 ₽ нет в данных')
    const saved = await call<{ answer: Answer }>('POST', '/api/hr/kb-answers', {
      question: 'можно ли заехать на территорию на машине',
      answer: 'Пропуск на машину стоит 1 250 ₽ в месяц, оформляет отдел кадров.',
      variants: [],
    })
    assert.equal(saved.status, 201, JSON.stringify(saved.body))
    assert.ok(checkAnswer('Пропуск на машину стоит 1 250 ₽ в месяц.').ok, 'сумма из ответа HR проходит')
    assert.ok(!checkAnswer('Пропуск на машину стоит 1 900 ₽ в месяц.').ok, 'сумма, которой нет ни в данных, ни в ответах HR, режется')
    await call('PATCH', `/api/hr/kb-answers/${saved.body.answer.id}`, { enabled: false })
    assert.ok(!checkAnswer('Пропуск на машину стоит 1 250 ₽ в месяц.').ok, 'выключенный ответ сумму больше не разрешает')
  })
})

test('проверка текста ответа: «!», даты, личные данные и род', async () => {
  await withTestDb('w2-assistant-hr-check', async (sql) => {
    const { call } = await setup(sql)
    const check = async (answer: string, extra: Record<string, unknown> = {}) =>
      (await call<Check>('POST', '/api/hr/kb-answers/check', { question: 'есть ли парковка', answer, variants: [], ...extra })).body

    assert.match((await check('Парковка есть!')).errors.answer, /Без «!»/)
    for (const dated of ['Парковку откроют 15.06, приходи.', 'Парковку откроют 15 июня.', 'Парковка будет в 2027 году.', 'С 2027-06-15 парковка платная.'])
      assert.match((await check(dated)).errors.answer ?? '', /Без дат/, dated)
    // Время и суммы — не даты
    for (const fine of ['Парковка открыта с 8:00 до 20:00.', 'Пропуск на машину стоит 2000 ₽.', 'Завод разливает до 70 000 бутылок в час.'])
      assert.equal((await check(fine)).errors.answer, undefined, fine)

    const personal = await check('Звони Ивану: +7 999 123-45-67 или ivan.petrov@mail.ru.')
    assert.match(personal.errors.answer ?? '', /Убрали личные данные/)
    assert.ok(personal.cleaned.answer.includes('[телефон]') && personal.cleaned.answer.includes('[почта]') && !personal.cleaned.answer.includes('999'), personal.cleaned.answer)
    // Общие контакты компании остаются: отдел подбора, почта для соискателей
    const official = await check('Спроси в отделе подбора: 8 800 100-77-77, доб. 1155, или rabota@ochakovo.ru.')
    assert.equal(official.errors.answer, undefined, JSON.stringify(official))
    assert.ok(official.cleaned.answer.includes('8 800 100-77-77') && official.cleaned.answer.includes('rabota@ochakovo.ru'))

    const gendered = await check('Если готов приехать на машине, парковка рядом с проходной.')
    assert.equal(gendered.errors.answer, undefined)
    assert.match(gendered.hints.join(' '), /Проверь род: «готов»/)

    assert.match((await check('Пиво не продаём.')).errors.answer ?? '', /алкоголь/)
    assert.match((await check('Да.')).errors.answer ?? '', /хотя бы одно предложение/)
    assert.match((await check('Парковка рядом с проходной.', { question: '' })).errors.question ?? '', /вопрос/)

    // Сохранить с ошибкой нельзя: 422 и тот же разбор
    const bad = await call<{ error: string; errors: Record<string, string> }>('POST', '/api/hr/kb-answers', { question: 'есть ли парковка', answer: 'Есть!', variants: [] })
    assert.equal(bad.status, 422)
    assert.equal(bad.body.error, 'validation')
    assert.ok(bad.body.errors.answer)
  })
})
