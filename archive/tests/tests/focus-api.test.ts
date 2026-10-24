// Анкета фокус-группы на настоящей базе (w2-fc-1): /api/focus без личных данных, повтор с того же устройства — 409,
// лимит по IP — 429, ловушка для ботов, вкладка HR с результатами по вопросам и меткам, выгрузка CSV,
// удаление пробных ответов — только администратор. Миграция 022 принимает каждый вариант анкеты и ничего лишнего.
// Запуск: pnpm test focus-api (нужен PostgreSQL, база создаётся и удаляется сама)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { routes } from '../../server/api/focus'
import { createApp } from '../../server/app'
import { hashPassword } from '../../server/auth/password'
import type { Registry } from '../../server/channels/registry'
import { PostgresStorage, type Sql } from '../../server/db'
import { focusQuestions, focusResults, FOCUS_CHOICE_IDS, type FocusResults } from '../../server/db/focus'
import { HrRepo } from '../../server/db/hr'
import type { RateRule } from '../../server/middleware/rate-limit'
import { serverSettled, withTestDb } from './_db'

const password = 'проверка-пароля-1'
const bots: Registry = { get: () => undefined, active: () => [], failed: () => [], start: () => {} }
const open: RateRule[] = [{ name: 'api', burst: 100000, perMinute: 100000, match: (_m, p) => p.startsWith('/api/') }]
const answers = { clear: 'teach', interest: 'people', hook: 'mentor', intent: 'yes', study: 'uni_senior' }

type Res<T> = { status: number; body: T; cookie: string; headers: Headers }

async function setup(sql: Sql, focusRules?: RateRule[]) {
  const storage = new PostgresStorage(sql)
  const repo = new HrRepo(sql)
  const hash = await hashPassword(password)
  await repo.createUser({ email: 'admin@focus.test', name: 'Админ', role: 'admin', passwordHash: hash })
  await repo.createUser({ email: 'anna@focus.test', name: 'Анна', role: 'hr', passwordHash: hash })
  const env = { NODE_ENV: 'test', SITE_URL: 'https://season.example.ru/' }
  const site = await createApp({ storage, engine: null, bots, hrToken: '', env, rateRules: open })
  await serverSettled(sql)
  // Как при подключении слота в server/api/index.ts: маршруты анкеты рядом с остальным API
  const app = new Hono()
  app.route('/', routes({ storage, repo, engine: null, bots, env }, { rules: focusRules }))
  app.route('/', site)

  const call = async <T = Record<string, unknown>>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> => {
    const r = await app.request(path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...headers },
    })
    const text = await r.text()
    let parsed: unknown = text
    try {
      parsed = JSON.parse(text)
    } catch {
      // CSV и прочее — текстом
    }
    return { status: r.status, body: parsed as T, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0], headers: r.headers }
  }
  const login = async (email: string) => {
    const r = await call('POST', '/api/hr/login', { email, password })
    assert.equal(r.status, 200, `вход ${email}`)
    return <T = Record<string, unknown>>(method: string, path: string, body?: unknown) => call<T>(method, path, body, { cookie: r.cookie, 'x-hr-request': '1' })
  }
  return { app, call, admin: await login('admin@focus.test'), hr: await login('anna@focus.test') }
}

test('миграция 022: каждый вариант анкеты записывается, чужие значения и длинный текст — нет', async () => {
  await withTestDb('focus-schema', async (sql) => {
    const base = { tag: '', clear: 'teach', interest: 'teach', hook: 'pay', intent: 'yes', study: 'college', missing: '' }
    for (const q of focusQuestions()) {
      if (q.kind !== 'one') continue
      for (const o of q.options) await sql`insert into focus_responses ${sql({ ...base, [q.id]: o.id })}`
    }
    const bad: Record<string, unknown>[] = [
      { clear: 'yes' },
      { hook: 'teach' },
      { intent: '' },
      { study: 'school' },
      { tag: 'FG A' },
      { tag: '-fg' },
      { missing: 'я'.repeat(301) },
      { voter: 'not-a-hash' },
    ]
    for (const patch of bad) await assert.rejects(sql`insert into focus_responses ${sql({ ...base, ...patch })}`, JSON.stringify(patch))
    const voter = 'a'.repeat(64)
    await sql`insert into focus_responses ${sql({ ...base, voter })}`
    await assert.rejects(sql`insert into focus_responses ${sql({ ...base, voter })}`, 'один ответ на устройство')
  })
})

test('анкета: ответ без личных данных, cookie устройства, повтор — 409, ошибки — 422, ловушка — без записи', async () => {
  await withTestDb('focus-public', async (sql) => {
    const { app, call } = await setup(sql)

    const first = await call<{ questions: { id: string }[]; answered: boolean; version: number }>('GET', '/api/focus')
    assert.equal(first.status, 200)
    assert.equal(first.headers.get('cache-control'), 'no-store')
    assert.equal(first.body.answered, false)
    assert.equal(first.body.version, 1)
    assert.deepEqual(first.body.questions.map((q) => q.id), ['clear', 'interest', 'hook', 'intent', 'missing', 'study'])

    // Ошибки по полям, ничего не записано
    const invalid = await call<{ error: string; errors: Record<string, string> }>('POST', '/api/focus', { s: 'fg-a', answers: { clear: 'teach' } })
    assert.equal(invalid.status, 422)
    assert.deepEqual(Object.keys(invalid.body.errors).sort(), ['hook', 'intent', 'interest', 'study'])
    assert.equal((await call('POST', '/api/focus', [1, 2])).status, 400)
    const broken = await app.request('/api/focus', { method: 'POST', body: 'not json', headers: { 'content-type': 'application/json' } })
    assert.equal(broken.status, 400)

    // Ответ принят: cookie только для /api/focus, httpOnly; в базе — отпечаток, не сама cookie
    const sent = await call('POST', '/api/focus', { s: 'FG-A', answers: { ...answers, missing: 'Не хватает графика. Мой номер +7 916 123-45-67' } })
    assert.equal(sent.status, 201)
    const header = sent.headers.get('set-cookie') ?? ''
    assert.match(header, /^focus_device=[A-Za-z0-9_-]{32};/)
    assert.match(header, /Path=\/api\/focus/)
    assert.match(header, /HttpOnly/)
    assert.match(header, /SameSite=Lax/)
    const token = sent.cookie.split('=')[1]
    const [row] = await sql<{ tag: string; voter: string; missing: string; clear: string }[]>`select tag, voter, missing, clear from focus_responses`
    assert.equal(row.tag, 'fg-a')
    assert.equal(row.clear, 'teach')
    assert.equal(row.missing, 'Не хватает графика. Мой номер [телефон скрыт]')
    assert.match(row.voter, /^[0-9a-f]{64}$/)
    assert.ok(!row.voter.includes(token))
    // В таблице нет колонок для имени, телефона, IP и даты рождения
    const columns = (await sql<{ column_name: string }[]>`select column_name from information_schema.columns where table_name = 'focus_responses'`).map((c) => c.column_name)
    for (const personal of ['name', 'phone', 'ip', 'birth_date', 'contact', 'email']) assert.ok(!columns.includes(personal), personal)

    // То же устройство: анкета знает, что ответ есть; второй ответ — 409, в базе по-прежнему один
    const again = await call<{ answered: boolean }>('GET', '/api/focus', undefined, { cookie: sent.cookie })
    assert.equal(again.body.answered, true)
    const twice = await call<{ error: string }>('POST', '/api/focus', { answers }, { cookie: sent.cookie })
    assert.equal(twice.status, 409)
    assert.equal(twice.body.error, 'already_answered')
    assert.equal((await sql`select id from focus_responses`).length, 1)

    // Другое устройство, метка непохожая — ответ всё равно принят, без метки
    const other = await call('POST', '/api/focus', { s: '<b>vk</b>', answers })
    assert.equal(other.status, 201)
    // Поддельная cookie чужого вида — новое устройство с новой cookie
    const forged = await call('POST', '/api/focus', { answers }, { cookie: 'focus_device=../../etc' })
    assert.equal(forged.status, 201)
    assert.match(forged.cookie, /^focus_device=[A-Za-z0-9_-]{32}$/)
    assert.deepEqual((await sql<{ tag: string }[]>`select tag from focus_responses order by id`).map((r) => r.tag), ['fg-a', '', ''])

    // Ловушка: поле, невидимое человеку, — ответ «принят», но не записан и без cookie
    const bot = await call('POST', '/api/focus', { website: 'http://spam', answers })
    assert.equal(bot.status, 201)
    assert.equal(bot.cookie, '')
    assert.equal((await sql`select id from focus_responses`).length, 3)
  })
})

test('лимит по IP: сверх ведра — 429 с Retry-After, повтор не записывается', async () => {
  await withTestDb('focus-limit', async (sql) => {
    const rules: RateRule[] = [
      { name: 'focus-hour', burst: 3, perMinute: 0.5, match: (m, p) => m === 'POST' && p === '/api/focus' },
      { name: 'focus-day', burst: 100, perMinute: 0.1, match: (m, p) => m === 'POST' && p === '/api/focus' },
    ]
    const { call } = await setup(sql, rules)
    for (let i = 0; i < 3; i++) assert.equal((await call('POST', '/api/focus', { s: 'fg-b', answers })).status, 201, `ответ ${i + 1}`)
    const limited = await call<{ error: string; retryAfter: number }>('POST', '/api/focus', { s: 'fg-b', answers })
    assert.equal(limited.status, 429)
    assert.equal(limited.body.error, 'rate_limited')
    assert.ok(Number(limited.headers.get('retry-after')) > 0)
    assert.equal((await sql`select id from focus_responses`).length, 3)
    // Чтение анкеты лимит не трогает
    assert.equal((await call('GET', '/api/focus')).status, 200)
  })
})

test('HR: результаты по вопросам и меткам, свободные ответы, CSV; удаляет только администратор', async () => {
  await withTestDb('focus-hr', async (sql) => {
    const { call, admin, hr } = await setup(sql)
    assert.equal((await call('GET', '/api/hr/focus')).status, 401, 'без входа')
    assert.equal((await call('GET', '/api/hr/focus/export')).status, 401)

    const empty = await hr<FocusResults & { site: string; canDelete: boolean }>('GET', '/api/hr/focus')
    assert.equal(empty.status, 200)
    assert.equal(empty.body.total, 0)
    assert.deepEqual(empty.body.tags, [])
    assert.equal(empty.body.site, 'https://season.example.ru')
    assert.equal(empty.body.canDelete, false)

    const send = (s: string, patch: Record<string, string> = {}) => call('POST', '/api/focus', { s, answers: { ...answers, ...patch } })
    await send('fg-a')
    await send('fg-a', { clear: 'natural', intent: 'maybe', missing: 'Про дорогу из Подольска' })
    await send('fg-a', { clear: 'natural', hook: 'dorm' })
    await send('fg-b', { clear: 'none', interest: 'none', intent: 'no', study: 'college', missing: 'Пишите @ivan_petrov' })
    await send('', { study: 'graduated' })
    await send('test')

    const res = await hr<FocusResults>('GET', '/api/hr/focus')
    assert.equal(res.body.total, 6)
    assert.deepEqual(res.body.tags.map((t) => [t.tag, t.count]), [['fg-a', 3], ['', 1], ['fg-b', 1], ['test', 1]])
    assert.deepEqual(res.body.counts['fg-a'].clear, { teach: 1, natural: 2 })
    assert.deepEqual(res.body.counts['fg-a'].intent, { yes: 2, maybe: 1 })
    assert.deepEqual(res.body.counts['fg-b'].clear, { none: 1 })
    assert.deepEqual(res.body.counts[''].study, { graduated: 1 })
    for (const tag of Object.keys(res.body.counts))
      for (const q of FOCUS_CHOICE_IDS)
        assert.equal(
          Object.values(res.body.counts[tag][q] ?? {}).reduce((a, b) => a + b, 0),
          res.body.tags.find((t) => t.tag === tag)!.count,
          `${tag}/${q}: по каждому вопросу столько же ответов, сколько у метки`,
        )
    assert.deepEqual(res.body.texts.map((t) => [t.tag, t.text]), [
      ['fg-b', 'Пишите [ник скрыт]'],
      ['fg-a', 'Про дорогу из Подольска'],
    ])
    const direct = await focusResults(sql)
    assert.deepEqual(res.body.counts, direct.counts, 'API отдаёт то же, что focusResults')
    assert.deepEqual(res.body.texts, direct.texts)

    // CSV: все ответы, ответы метки, ответы без метки
    const all = await hr<string>('GET', '/api/hr/focus/export')
    assert.equal(all.status, 200)
    assert.match(all.headers.get('content-type') ?? '', /^text\/csv; charset=utf-8/)
    assert.match(all.headers.get('content-disposition') ?? '', /filename\*=UTF-8''%D0%A4%D0%BE%D0%BA%D1%83%D1%81/)
    const lines = all.body.replace(/^\uFEFF/, '').split('\r\n')
    assert.equal(lines.length, 7)
    assert.match(lines[2], /"fg-a";.*"«Я делаю натуральные напитки»";"«Квас делают люди»";"Наставник у каждого новичка";"Может быть";"Про дорогу из Подольска";"Вуз, 4 курс и старше"$/)
    const fgB = (await hr<string>('GET', '/api/hr/focus/export?s=fg-b')).body.replace(/^\uFEFF/, '').split('\r\n')
    assert.equal(fgB.length, 2)
    assert.match(fgB[1], /"Ни один";"Ни один";.*"Нет";"Пишите \[ник скрыт\]";"Колледж"$/)
    const untagged = (await hr<string>('GET', '/api/hr/focus/export?s=')).body.split('\r\n')
    assert.equal(untagged.length, 2)
    assert.match(untagged[1], /"без метки"/)
    assert.equal((await hr<string>('GET', '/api/hr/focus/export?s=../../x')).body.split('\r\n').length, 1, 'непохожая метка — только шапка')

    // Удаление: роль hr — 403, администратор — пробные ответы метки и один ответ
    assert.equal((await hr('DELETE', '/api/hr/focus/responses?tag=test')).status, 403)
    const id = res.body.texts[0].id
    assert.equal((await hr('DELETE', `/api/hr/focus/responses/${id}`)).status, 403)
    assert.equal((await admin('DELETE', '/api/hr/focus/responses')).status, 422, 'без метки в запросе ничего не удаляем')
    assert.equal((await admin('DELETE', '/api/hr/focus/responses?tag=FG%20A')).status, 422)
    const removed = await admin<{ deleted: number }>('DELETE', '/api/hr/focus/responses?tag=test')
    assert.deepEqual(removed.body, { deleted: 1 })
    assert.equal((await admin('DELETE', `/api/hr/focus/responses/${id}`)).status, 200)
    assert.equal((await admin('DELETE', `/api/hr/focus/responses/${id}`)).status, 404)
    assert.equal((await admin('DELETE', '/api/hr/focus/responses/abc')).status, 404)
    const after = await admin<FocusResults & { canDelete: boolean }>('GET', '/api/hr/focus')
    assert.equal(after.body.total, 4)
    assert.equal(after.body.canDelete, true)
    assert.deepEqual(after.body.tags.map((t) => t.tag), ['fg-a', ''])
    // Изменения без x-hr-request не проходят даже у администратора: чужой сайт не подделает удаление
    const session = await call('POST', '/api/hr/login', { email: 'admin@focus.test', password })
    const noHeader = await call('DELETE', '/api/hr/focus/responses?tag=fg-a', undefined, { cookie: session.cookie })
    assert.equal(noHeader.status, 403)
    assert.equal((await sql`select id from focus_responses where tag = 'fg-a'`).length, 3)
  })
})
