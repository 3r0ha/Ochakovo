// Правки вакансий без программиста (w2-ad-4) и типы практики в редакторе (w2-ad-c2) на настоящем сервере и своей базе:
// сумма оператора 110 000 без перезапуска — в /api/content, в ответах FAQ, у Квасыча и в боте; закрытая вакансия пропадает
// из списков и подбора, но остаётся у старых заявок; у бесплатной практики суммы нет, у оплачиваемой — обязательна;
// правка в истории с именем сотрудника; правки накладываются при старте; без API сайт показывает данные компании.
// Запуск: pnpm test w2-hr-admin-vacancies (нужен PostgreSQL, база создаётся и удаляется сама)

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { faqAnswer } from '../../shared/content/faq'
import { scoreQuiz } from '../../shared/content/quiz'
import {
  applyVacancyOverrides,
  freePractice,
  isVacancyOpen,
  loadVacancyOverrides,
  maxEntryPay,
  minPracticePay,
  paidPractice,
  vacancies,
  vacanciesByPay,
  vacancyById,
  vacancyOverrideProblem,
  type VacancyEditable,
} from '../../shared/content/vacancies'
import { createAssistant } from '../../server/assistant/assistant'
import { knowledgeText } from '../../server/assistant/knowledge'
import { functionDefinitions } from '../../server/assistant/tools'
import { createApp } from '../../server/app'
import { hashPassword } from '../../server/auth/password'
import type { Registry } from '../../server/channels/registry'
import { vacancyOverridesApplied } from '../../server/content/vacancies'
import { PostgresStorage, type Sql } from '../../server/db'
import { HrRepo } from '../../server/db/hr'
import { createEngine } from '../../server/dialog/engine'
import { memoryStorage } from '../../server/dialog/storage'
import { offlineProvider } from '../../server/llm/offline'
import type { RateRule } from '../../server/middleware/rate-limit'
import { serverSettled, withTestDb } from './_db'

const password = 'проверка-пароля-1'
const bots: Registry = { get: () => undefined, active: () => [], failed: () => [], start: () => {} }
const rules: RateRule[] = [{ name: 'api', burst: 100000, perMinute: 100000, match: (_m, p) => p.startsWith('/api/') }]
const plain = (t: string) => t.replace(/[  ]/g, ' ')

// Каждая проверка начинает с данных компании: правки в памяти общие на весь процесс
afterEach(() => {
  applyVacancyOverrides([])
})

type AdminList = {
  vacancies: { id: string; format: string; builtin: VacancyEditable; current: VacancyEditable; overridden: boolean; updatedBy: string | null; basis: { source: string; team?: string } | null }[]
  history: { vacancyId: string; userName: string; before: VacancyEditable; after: VacancyEditable }[]
}

async function setup(sql: Sql) {
  const storage = new PostgresStorage(sql)
  const repo = new HrRepo(sql)
  const hash = await hashPassword(password)
  const admin = await repo.createUser({ email: 'admin@vac.test', name: 'Ирина Админова', role: 'admin', passwordHash: hash })
  const hr = await repo.createUser({ email: 'hr@vac.test', name: 'Анна', role: 'hr', passwordHash: hash })
  const app = await createApp({ storage, engine: null, bots, hrToken: '', env: { NODE_ENV: 'test', SITE_URL: 'https://season.example.ru' }, rateRules: rules })
  await serverSettled(sql)
  await vacancyOverridesApplied()
  const cookieFor = async (email: string) =>
    ((await app.request('/api/hr/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })).headers.get('set-cookie') ?? '').split(';')[0]
  const adminCookie = await cookieFor(admin.email)
  const hrCookie = await cookieFor(hr.email)
  const call = (method: string, path: string, body?: unknown, cookie = adminCookie) =>
    app.request(path, { method, headers: { cookie, 'content-type': 'application/json', 'x-hr-request': '1' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const put = async (id: string, patch: Partial<VacancyEditable>) => {
    const v = vacancyById(id)!
    const current: VacancyEditable = { open: isVacancyOpen(id), pay: v.pay ? { ...v.pay } : null, hot: Boolean(v.hot), period: v.period }
    return call('PUT', `/api/hr/content/vacancies/${id}`, { ...current, ...patch })
  }
  return { storage, app, call, put, admin, hrCookie }
}

test('сумма оператора 110 000 без перезапуска: сайт, FAQ, Квасыч и бот; правка в истории с именем', async () => {
  await withTestDb('hradm-vac-pay', async (sql) => {
    const { app, call, put } = await setup(sql)
    assert.equal(maxEntryPay, 70000, 'до правки — 70 000')

    const res = await put('bottling-operator', { pay: { from: 110000 } })
    assert.equal(res.status, 200)
    assert.equal(((await res.json()) as { changed: boolean }).changed, true)

    const content = (await (await app.request('/api/content')).json()) as { vacancies: { id: string; pay?: { from: number } }[] }
    assert.equal(content.vacancies.find((v) => v.id === 'bottling-operator')?.pay?.from, 110000, '/api/content — новая сумма')
    assert.equal(maxEntryPay, 110000, 'вилка на первом экране пересчитана')
    assert.equal(minPracticePay, 56000)
    assert.ok(plain(faqAnswer('practice')).includes('до 110 000 ₽'), faqAnswer('practice'))
    assert.ok(plain(faqAnswer('pay')).includes('от 56 000 до 110 000 ₽'), faqAnswer('pay'))
    assert.equal(vacanciesByPay[0].id, 'bottling-operator', 'порядок по сумме пересчитан')

    assert.ok(plain(knowledgeText()).includes('110 000'), 'база знаний Квасыча пересобрана')
    const assistant = createAssistant({ provider: offlineProvider(), log: () => {} })
    const answer = plain((await assistant.answer({ question: 'сколько платят оператору линии розлива', history: [], sessionId: 'vac', channel: 'web' })).text)
    assert.ok(answer.includes('110 000'), `Квасыч называет новую сумму: ${answer}`)

    const engine = createEngine(memoryStorage(), { siteUrl: 'https://ochakovo.test', assistant })
    const list = await engine.handle({ channel: 'telegram', id: '1', firstName: 'Тест' }, { type: 'action', action: 'v:list:0' })
    const text = plain(list.messages.map((m) => m.text).join('\n'))
    assert.ok(text.includes('Оператор линии розлива · от 110 000 ₽'), `бот: ${text.slice(0, 400)}`)

    const admin = (await (await call('GET', '/api/hr/content/vacancies')).json()) as AdminList
    const row = admin.vacancies.find((v) => v.id === 'bottling-operator')!
    assert.equal(row.overridden, true)
    assert.equal(row.updatedBy, 'Ирина Админова')
    assert.equal(row.builtin.pay?.from, 70000, 'данные компании видны рядом с правкой')
    assert.equal(row.current.pay?.from, 110000)
    const h = admin.history[0]
    assert.equal(h.vacancyId, 'bottling-operator')
    assert.equal(h.userName, 'Ирина Админова', 'в истории — кто правил')
    assert.equal(h.before.pay?.from, 70000)
    assert.equal(h.after.pay?.from, 110000)

    const pub = (await (await app.request('/api/vacancy-overrides')).json()) as { overrides: Record<string, unknown>[] }
    assert.equal(pub.overrides.length, 1)
    assert.ok(!JSON.stringify(pub).includes('Ирина'), 'в открытых правках нет имён сотрудников')

    // Сохранить то же самое — история не растёт
    const again = await put('bottling-operator', { pay: { from: 110000 } })
    assert.equal(((await again.json()) as { changed: boolean }).changed, false)
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from vacancy_override_history`
    assert.equal(n, 1)

    // Вернуть как в данных компании — строка правки удалена, в истории запись
    const reset = await call('DELETE', '/api/hr/content/vacancies/bottling-operator')
    assert.equal(reset.status, 200)
    assert.equal(maxEntryPay, 70000)
    assert.equal((await sql`select 1 from vacancy_overrides`).length, 0)
    const [{ m }] = await sql<{ m: number }[]>`select count(*)::int as m from vacancy_override_history`
    assert.equal(m, 2)
  })
})

test('закрытая вакансия пропадает из списков, подбора, бота и Квасыча, но остаётся у старых заявок', async () => {
  await withTestDb('hradm-vac-close', async (sql) => {
    const { app, put } = await setup(sql)
    const total = vacancies.length
    const permanent = [{ text: 'Хочу работать постоянно', weights: { 'store-worker': 3, merchandiser: 4 } }]
    assert.equal(scoreQuiz(permanent), 'merchandiser', 'до закрытия подбор советует мерчандайзера')
    assert.equal((await put('merchandiser', { open: false })).status, 200)
    assert.equal(scoreQuiz(permanent), 'store-worker', 'после закрытия подбор его не предлагает')
    assert.equal(vacancies.length, total - 1)
    assert.ok(!isVacancyOpen('merchandiser'))
    assert.equal(vacancyById('merchandiser')?.title, 'Мерчандайзер', 'у старых заявок название остаётся')
    const content = (await (await app.request('/api/content')).json()) as { vacancies: { id: string }[] }
    assert.ok(!content.vacancies.some((v) => v.id === 'merchandiser'), 'сайт не показывает')
    assert.ok(!vacanciesByPay.some((v) => v.id === 'merchandiser'), 'бот не показывает')
    const getVacancy = functionDefinitions().find((f) => f.name === 'get_vacancy')!
    assert.ok(!getVacancy.parameters.properties!.vacancy_id.enum!.includes('merchandiser'), 'Квасыч не знает')
    assert.ok(!knowledgeText().includes('Мерчандайзер —'))

    // Закрыть последнюю практику в отделе: список отделов в ответе FAQ пересчитан
    assert.equal((await put('lab-chemist', { open: false })).status, 200)
    assert.ok(!paidPractice.some((v) => v.id === 'lab-chemist'))
    assert.ok(!faqAnswer('practice').includes('в лаборатории'), faqAnswer('practice'))

    assert.equal((await put('merchandiser', { open: true })).status, 200)
    assert.ok(isVacancyOpen('merchandiser'))
    assert.equal(vacancies.findIndex((v) => v.id === 'merchandiser'), vacancies.length - 1, 'вернулась на своё место в порядке сайта')
  })
})

test('редактор понимает типы: у бесплатной практики суммы нет, у оплачиваемой — обязательна, проверки суммы и периода', async () => {
  await withTestDb('hradm-vac-types', async (sql) => {
    const { put, call, hrCookie } = await setup(sql)
    const errorsOf = async (r: Response) => {
      assert.equal(r.status, 422)
      return ((await r.json()) as { errors: Record<string, string> }).errors
    }
    assert.ok((await errorsOf(await put('marketing-intern', { pay: { from: 30000 } }))).payFrom, 'бесплатная практика с суммой — 422')
    assert.ok((await errorsOf(await put('storekeeper', { pay: null }))).payFrom, 'оплачиваемая практика без суммы — 422')
    assert.ok((await errorsOf(await put('store-worker', { pay: null }))).payFrom, 'работа без суммы — 422')
    assert.ok((await errorsOf(await put('storekeeper', { pay: { from: 5000 } }))).payFrom, 'меньше 10 000 — опечатка')
    assert.ok((await errorsOf(await put('storekeeper', { pay: { from: 5_600_000 } }))).payFrom, 'лишний ноль — 422')
    assert.ok((await errorsOf(await put('store-worker', { pay: { from: 57000, to: 50000 } }))).payTo, '«до» меньше «от» — 422')
    assert.ok((await errorsOf(await put('storekeeper', { period: '  ' }))).period, 'пустой период — 422')
    assert.ok((await errorsOf(await put('storekeeper', { period: 'а'.repeat(200) }))).period, 'длинный период — 422')

    assert.equal((await put('marketing-intern', { hot: true, period: 'Июнь — август по договорённости с вузом' })).status, 200, 'у бесплатной практики можно срочный набор и период')
    assert.equal(vacancyById('marketing-intern')!.hot, true)
    assert.equal(vacancyById('marketing-intern')!.pay, undefined)
    assert.ok(freePractice.some((v) => v.id === 'marketing-intern'))
    assert.equal((await put('storekeeper', { pay: { from: 58000, estimate: true } })).status, 200, 'оплачиваемая практика: ориентир можно')
    assert.equal(vacancyById('storekeeper')!.pay?.estimate, true)
    assert.equal((await put('store-worker', { pay: { from: 60000, to: 90000 } })).status, 200, 'работа: вилка')
    assert.deepEqual(vacancyById('store-worker')!.pay, { from: 60000, to: 90000 })

    assert.equal((await call('PUT', '/api/hr/content/vacancies/tour-guide', { open: true, pay: null, hot: false, period: 'x' })).status, 404, 'неизвестная вакансия — 404')
    assert.equal((await call('GET', '/api/hr/content/vacancies', undefined, hrCookie)).status, 403, 'роль hr — 403')
    assert.equal((await call('PUT', '/api/hr/content/vacancies/storekeeper', { open: false, pay: { from: 56000 }, hot: false, period: 'x' }, hrCookie)).status, 403)

    // Та же проверка формата — в общих данных: сайт не наложит правку, которую сервер не принял бы
    const marketing = vacancyById('marketing-intern')!
    assert.ok(vacancyOverrideProblem(marketing, { open: true, pay: { from: 30000 }, hot: false, period: 'x' }))
    const skipped = applyVacancyOverrides([{ vacancyId: 'marketing-intern', open: true, pay: { from: 30000 }, hot: false, period: 'x' }])
    assert.deepEqual(skipped, ['marketing-intern'], 'неподходящая правка пропущена')
    assert.equal(vacancyById('marketing-intern')!.pay, undefined)
  })
})

test('правки накладываются при старте сервера; у источника — метка «предложение команды» только в панели', async () => {
  await withTestDb('hradm-vac-start', async (sql) => {
    const first = await setup(sql)
    assert.equal((await first.put('fermentation-assistant', { pay: { from: 75000 }, hot: true })).status, 200)
    // Как новый процесс: в памяти — данные компании
    applyVacancyOverrides([])
    assert.equal(vacancyById('fermentation-assistant')!.pay?.from, 70000)
    const storage = new PostgresStorage(sql)
    await createApp({ storage, engine: null, bots, hrToken: '', env: { NODE_ENV: 'test', SITE_URL: 'https://season.example.ru' }, rateRules: rules })
    await vacancyOverridesApplied()
    assert.equal(vacancyById('fermentation-assistant')!.pay?.from, 75000, 'после старта — правка из базы')
    assert.equal(vacancyById('fermentation-assistant')!.hot, true)

    const list = (await (await first.call('GET', '/api/hr/content/vacancies')).json()) as AdminList
    const lab = list.vacancies.find((v) => v.id === 'lab-chemist')!
    assert.ok(lab.basis?.team, 'у лаборанта задачи из ролика — помечены как предложение команды')
    assert.ok(list.vacancies.find((v) => v.id === 'bottling-operator')!.basis?.source.includes('Описание практики'))
    const content = JSON.stringify(await (await first.app.request('/api/content')).json())
    assert.ok(!content.includes('команды'), 'на сайте меток источника нет')
  })
})

test('сайт: правки при загрузке с таймаутом; без API — данные компании', async () => {
  const realFetch = globalThis.fetch
  try {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ overrides: [{ vacancyId: 'bottling-operator', open: true, pay: { from: 110000 }, hot: false, period: 'Март — июль' }] }), {
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch
    assert.equal(await loadVacancyOverrides(), true)
    assert.equal(vacancyById('bottling-operator')!.pay?.from, 110000)
    assert.equal(maxEntryPay, 110000)

    applyVacancyOverrides([])
    // API молчит: через таймаут — данные компании, страница не ждёт
    globalThis.fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as typeof fetch
    const started = Date.now()
    assert.equal(await loadVacancyOverrides('/api/vacancy-overrides', 200), false)
    assert.ok(Date.now() - started < 1500, 'не ждёт дольше таймаута')
    assert.equal(vacancyById('bottling-operator')!.pay?.from, 70000)

    // Статичный хостинг без API отвечает страницей вместо JSON
    globalThis.fetch = (async () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } })) as typeof fetch
    assert.equal(await loadVacancyOverrides(), false)
    assert.equal(maxEntryPay, 70000)
  } finally {
    globalThis.fetch = realFetch
  }
})
