// HR-панель, пакет hr-desk, на настоящем сервере и своей базе: список с ETag и 304 без обезличенных строк,
// явка и неявка на собеседование с историей и отменой, фамилия в окне приглашения, раздача поровну,
// ответственный при импорте, фильтр «Задания» в выгрузке, список на 5000 заявок.
// Запуск: pnpm test w1-hr-desk-api (нужен PostgreSQL, база создаётся и удаляется сама)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CONSENT_VERSION, type HrApplication } from '../../shared/applications'
import { attendancePending, evenSplit } from '../../shared/hrFilter'
import { workdayAfter, defaultWorkSettings } from '../../shared/workdays'
import { createApp } from '../../server/app'
import { hashPassword } from '../../server/auth/password'
import type { Adapter, Registry } from '../../server/channels/registry'
import { normalizeApplication, PostgresStorage, type Sql } from '../../server/db'
import { HrRepo } from '../../server/db/hr'
import { ATTENDED_NOTE, NO_SHOW_NOTE } from '../../server/db/workflow'
import type { RateRule } from '../../server/middleware/rate-limit'
import { serverSettled, withTestDb } from './_db'

// Сообщения кандидатам — сразу в очередь без 20 секунд на отмену; доставку здесь не запускаем
process.env.HR_NOTIFY_DELAY_SECONDS = '0'

const password = 'проверка-пароля-1'
const fakeTelegram = { startPolling: async () => {}, handleWebhook: async () => {}, sendTo: async () => {} } as unknown as Adapter
const bots: Registry = {
  get: (channel) => (channel === 'telegram' ? { adapter: fakeTelegram, secret: undefined } : undefined),
  active: () => ['telegram'],
  failed: () => [],
  start: () => {},
}
const rules: RateRule[] = [{ name: 'api', burst: 100000, perMinute: 100000, match: (_m, p) => p.startsWith('/api/') }]

type Details = { application: HrApplication; history: { id: number; kind: string; comment: string; toStatus: string }[]; historyId: number | null; notify: { notify: string } | null }

async function setup(sql: Sql) {
  const storage = new PostgresStorage(sql)
  const repo = new HrRepo(sql)
  const hash = await hashPassword(password)
  const admin = await repo.createUser({ email: 'admin@desk.test', name: 'Админ', role: 'admin', passwordHash: hash })
  const staff = [
    await repo.createUser({ email: 'anna@desk.test', name: 'Анна', role: 'hr', passwordHash: hash }),
    await repo.createUser({ email: 'boris@desk.test', name: 'Борис', role: 'hr', passwordHash: hash }),
    await repo.createUser({ email: 'vera@desk.test', name: 'Вера', role: 'hr', passwordHash: hash }),
  ]
  const app = await createApp({ storage, engine: null, bots, hrToken: '', env: { NODE_ENV: 'test', SITE_URL: 'https://season.example.ru' }, rateRules: rules })
  await serverSettled(sql)
  const login = await app.request('/api/hr/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: admin.email, password }) })
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
  assert.ok(cookie, 'вход администратора')
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { cookie, 'content-type': 'application/json', 'x-hr-request': '1', ...headers } })
  const patch = async (id: string, body: unknown) => {
    const res = await call('PATCH', `/api/hr/applications/${id}`, body)
    return { status: res.status, body: (await res.json()) as Details & { message?: string } }
  }
  let n = 0
  const candidate = (extra: Record<string, unknown> = {}) =>
    storage.saveApplication(
      normalizeApplication({ name: `Кандидат ${++n}`, phone: `+7901${String(1_000_000 + n).padStart(7, '0')}`, consent: true, consentVersion: CONSENT_VERSION, ...extra }),
    )
  /** Собеседование, которое уже прошло: назначаем на рабочий день и сдвигаем время в прошлое */
  const pastInterview = async (id: string, hoursAgo = 2) => {
    const startsAt = workdayAfter(2, 11, Date.now(), defaultWorkSettings).toISOString()
    const r = await patch(id, { status: 'interview', slot: { startsAt, address: 'Москва, ул. Рябиновая, 44', bring: 'паспорт' } })
    assert.equal(r.status, 200, 'собеседование назначено')
    await sql`update interviews set starts_at = now() - make_interval(hours => ${hoursAgo}) where application_id = ${id} and cancelled_at is null`
  }
  return { storage, repo, app, call, patch, candidate, pastInterview, admin, staff }
}

test('список для панели: ETag и 304, обезличенных строк нет, их этапы — в плитках', async () => {
  await withTestDb('hr-desk-list', async (sql) => {
    const { call, patch, candidate } = await setup(sql)
    const a = await candidate()
    const b = await candidate()
    const erased = await candidate()
    await patch(erased.id, { status: 'contacted' })
    await patch(erased.id, { status: 'interview', withoutSlot: true })
    await sql`update applications set anonymized_at = now(), anonymized_reason = 'retention', name = '', phone = '' where id = ${erased.id}`

    const first = await call('GET', '/api/hr/desk')
    assert.equal(first.status, 200)
    const tag = first.headers.get('etag')
    assert.match(tag ?? '', /^"[\w-]+"$/, 'есть ETag')
    assert.match(first.headers.get('cache-control') ?? '', /no-cache/)
    const list = (await first.json()) as { rows: HrApplication[]; erased: [string, number][] }
    assert.deepEqual(list.rows.map((r) => r.id).sort(), [a.id, b.id].sort(), 'обезличенная заявка в список не попала')
    assert.equal(list.erased.length, 1)
    assert.equal(list.erased[0][1], 1, 'обезличенная дошла до собеседования')

    const again = await call('GET', '/api/hr/desk', undefined, { 'if-none-match': tag! })
    assert.equal(again.status, 304)
    const body = await again.text()
    assert.equal(body, '', '304 без тела')
    const size = [...again.headers.entries()].reduce((s, [k, v]) => s + k.length + v.length + 4, 0) + body.length
    assert.ok(size < 5 * 1024, `пустой опрос меньше 5 КБ: ${size} байт`)

    await patch(a.id, { status: 'contacted' })
    const changed = await call('GET', '/api/hr/desk', undefined, { 'if-none-match': tag! })
    assert.equal(changed.status, 200, 'после изменения — снова 200')
    assert.notEqual(changed.headers.get('etag'), tag)

    // Полный список для скриптов и интеграций — так же: без обезличенных, с ETag и 304
    const full = await call('GET', '/api/hr/applications')
    assert.equal(full.status, 200)
    const rows = (await full.json()) as HrApplication[]
    assert.deepEqual(rows.map((r) => r.id).sort(), [a.id, b.id].sort(), 'обезличенной заявки нет и в /api/hr/applications')
    const fullTag = full.headers.get('etag')
    assert.match(fullTag ?? '', /^"[\w-]+"$/)
    const same = await call('GET', '/api/hr/applications', undefined, { 'if-none-match': `W/${fullTag}` })
    assert.equal(same.status, 304, 'слабый ETag тоже узнаётся')
    assert.equal(await same.text(), '')
  })
})

test('явка и неявка: только у прошедших, история, отмена, сообщение — по выбору', async () => {
  await withTestDb('hr-desk-attendance', async (sql) => {
    const { call, patch, candidate, pastInterview } = await setup(sql)
    const web = await candidate()
    await pastInterview(web.id)

    const yes = await patch(web.id, { attendance: 'yes' })
    assert.equal(yes.status, 200)
    assert.equal(yes.body.application.status, 'interview', 'явка не меняет статус')
    assert.equal(yes.body.application.interview?.attended, 'yes')
    assert.ok(yes.body.application.interview?.attendedAt)
    assert.equal(yes.body.history.at(-1)?.comment, ATTENDED_NOTE)
    assert.ok(yes.body.historyId)
    const [who] = await sql<{ attended_by: string | null }[]>`select attended_by from interviews where application_id = ${web.id} and cancelled_at is null`
    assert.ok(who.attended_by, 'кто отметил — в базе')

    const undo = (await (await call('POST', '/api/hr/undo', { historyIds: [yes.body.historyId] })).json()) as { results: { ok: boolean; application: HrApplication }[] }
    assert.equal(undo.results[0].ok, true)
    assert.equal(undo.results[0].application.interview?.attended, '', '«Отменить» снимает отметку')

    const no = await patch(web.id, { attendance: 'no' })
    assert.equal(no.status, 200)
    assert.equal(no.body.application.status, 'declined')
    assert.equal(no.body.application.declineReason, 'no_show')
    assert.equal(no.body.application.interview?.attended, 'no')
    assert.equal(no.body.notify, null, 'без отметки «написать» кандидату ничего не уходит')
    assert.equal(no.body.history.at(-1)?.comment, NO_SHOW_NOTE)
    const jobs = await sql`select 1 from jobs where kind = 'notify' and payload->>'applicationId' = ${web.id} and status = 'pending'`
    assert.equal(jobs.length, 0, 'в очереди нет сообщения')

    const back = (await (await call('POST', '/api/hr/undo', { historyIds: [no.body.historyId] })).json()) as { results: { ok: boolean; application: HrApplication }[] }
    assert.equal(back.results[0].ok, true)
    const restored = back.results[0].application
    assert.equal(restored.status, 'interview')
    assert.equal(restored.declineReason, '')
    assert.equal(restored.interview?.attended, '', 'неявка отменена вместе с отказом')

    const bot = await candidate({ channel: 'telegram', channelUserId: '777' })
    await pastInterview(bot.id)
    const told = await patch(bot.id, { attendance: 'no', notify: true })
    assert.equal(told.status, 200)
    assert.equal(told.body.notify?.notify, 'queued', 'с отметкой — сообщение об отказе в очереди')

    const later = await candidate()
    const startsAt = workdayAfter(3, 11, Date.now(), defaultWorkSettings).toISOString()
    await patch(later.id, { status: 'interview', slot: { startsAt, address: 'Москва, ул. Рябиновая, 44', bring: '' } })
    const early = await patch(later.id, { attendance: 'yes' })
    assert.equal(early.status, 422, 'до собеседования явку не отметить')
    const fresh = await candidate()
    assert.equal((await patch(fresh.id, { attendance: 'no' })).status, 422, 'без собеседования — 422')
  })
})

test('плитка «Итог не отмечен» совпадает с прошедшими слотами без отметки', async () => {
  await withTestDb('hr-desk-unmarked', async (sql) => {
    const { call, patch, candidate, pastInterview } = await setup(sql)
    const apps = await Promise.all([1, 2, 3, 4, 5].map(() => candidate()))
    for (const a of apps.slice(0, 4)) await pastInterview(a.id)
    await patch(apps[0].id, { attendance: 'yes' })
    await patch(apps[1].id, { attendance: 'no' })
    const startsAt = workdayAfter(2, 12, Date.now(), defaultWorkSettings).toISOString()
    await patch(apps[4].id, { status: 'interview', slot: { startsAt, address: 'Москва, ул. Рябиновая, 44', bring: '' } })
    const list = ((await (await call('GET', '/api/hr/desk')).json()) as { rows: HrApplication[] }).rows
    const tile = list.filter((a) => !a.duplicateOf && attendancePending(a)).length
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from interviews i join applications a on a.id = i.application_id
      where i.cancelled_at is null and i.starts_at <= now() and i.attended = '' and a.status = 'interview'`
    assert.equal(tile, 2)
    assert.equal(tile, n)
  })
})

test('фамилия в окне приглашения: в карточке и массово, приглашение без неё не блокируется', async () => {
  await withTestDb('hr-desk-lastname', async (sql) => {
    const { call, patch, candidate } = await setup(sql)
    const one = await candidate()
    const r = await patch(one.id, { status: 'interview', withoutSlot: true, profile: { lastName: 'Сидорова' } })
    assert.equal(r.status, 200)
    assert.equal(r.body.application.lastName, 'Сидорова')
    assert.equal(r.body.application.status, 'interview')

    const [x, y, z] = await Promise.all([candidate(), candidate({ lastName: 'Уже-есть' }), candidate()])
    const res = await call('POST', '/api/hr/bulk', { ids: [x.id, y.id, z.id], action: 'status', status: 'interview', withoutSlot: true, lastNames: { [x.id]: ' Петрова ', [y.id]: 'Чужая' } })
    assert.equal(res.status, 200)
    const out = (await res.json()) as { applications: HrApplication[] }
    const by = (id: string) => out.applications.find((a) => a.id === id)!
    assert.equal(by(x.id).lastName, 'Петрова')
    assert.equal(by(y.id).lastName, 'Уже-есть', 'вписанную фамилию не затираем')
    assert.equal(by(z.id).lastName, '', 'без фамилии — тоже приглашён')
    assert.ok(out.applications.every((a) => a.status === 'interview'))
  })
})

test('раздача: 300 заявок на троих — по 100; импорт: я, никто или поровну', async () => {
  await withTestDb('hr-desk-assign', async (sql) => {
    const { call, staff, admin } = await setup(sql)
    await sql`
      insert into applications (id, name, phone, channel, game, months, status, consent_version, consent_source)
      select 'D' || lpad(g::text, 7, '0'), 'Раздача ' || g, '+7902' || lpad(g::text, 7, '0'), 'web', '{"quizResult":null,"conveyorBest":0,"activities":0}', '[]', 'new', '1', 'site_form'
      from generate_series(1, 300) g`
    const ids = (await sql<{ id: string }[]>`select id from applications where name like 'Раздача %' order by id`).map((r) => r.id)
    // Так раздаёт панель: evenSplit и «назначить» по группам
    for (const [assigneeId, part] of evenSplit(ids, staff.map((s) => s.id))) {
      const res = await call('POST', '/api/hr/bulk', { ids: part, action: 'assign', assigneeId })
      assert.equal(res.status, 200)
    }
    const counts = await sql<{ assignee_id: string; n: number }[]>`
      select assignee_id, count(*)::int as n from applications where name like 'Раздача %' group by assignee_id order by assignee_id`
    assert.deepEqual(counts.map((c) => c.n), [100, 100, 100])

    const row = (i: number) => ({ line: i + 2, lastName: 'Импортова', name: `Файл ${i}`, middleName: '', phone: `+7903${String(1_000_000 + i).padStart(7, '0')}`, email: '', vacancyId: '', vacancyTitle: '', appliedAt: null, citizenship: '', adult: null, resumeUrl: '', months: [7], comment: '', problems: [], warnings: [] })
    const commit = async (rows: unknown[], extra: Record<string, unknown>) => {
      const res = await call('POST', '/api/hr/import/commit', { rows, source: 'hh', skipDuplicates: true, ...extra })
      return { status: res.status, body: (await res.json()) as { created: { id: string }[] } }
    }
    const assignees = async (created: { id: string }[]) =>
      (await sql<{ assignee_id: string | null }[]>`select assignee_id from applications where id in ${sql(created.map((c) => c.id))} order by id`).map((r) => (r.assignee_id === null ? null : Number(r.assignee_id)))

    const mine = await commit([row(1), row(2)], {})
    assert.deepEqual(await assignees(mine.body.created), [admin.id, admin.id], 'по умолчанию — тот, кто загрузил')
    const none = await commit([row(3), row(4)], { assign: 'none' })
    assert.deepEqual(await assignees(none.body.created), [null, null])
    const even = await commit([row(5), row(6), row(7), row(8)], { assign: 'even', assignees: [staff[0].id, staff[1].id] })
    const split = await assignees(even.body.created)
    assert.equal(split.filter((id) => id === staff[0].id).length, 2)
    assert.equal(split.filter((id) => id === staff[1].id).length, 2)
    assert.equal((await commit([row(9)], { assign: 'even', assignees: [] })).status, 422, 'поровну без сотрудников — 422')
  })
})

test('фильтр «Задания» уходит в выгрузку', async () => {
  await withTestDb('hr-desk-export', async (sql) => {
    const { call, candidate } = await setup(sql)
    const all = await candidate({ game: { quizResult: null, conveyorBest: 0, activities: 4 } })
    await candidate({ game: { quizResult: null, conveyorBest: 0, activities: 2 } })
    await candidate()
    const res = await call('POST', '/api/hr/export', { format: 'json', query: 'tasks=all' })
    assert.equal(res.status, 200)
    const rows = (await res.json()) as Record<string, unknown>[]
    assert.equal(rows.length, 1)
    assert.ok(JSON.stringify(rows[0]).includes(all.id))
    // По прямой ссылке со старым значением — та же выгрузка
    const link = await call('GET', '/api/hr/export/applications.json?tasks=4')
    assert.equal(((await link.json()) as unknown[]).length, 1)
    // «Задания: 0» — заявки кандидатов без заданий; добавленный HR сюда не входит, как в «Воронке»
    await call('POST', '/api/hr/applications', { name: 'Звонок', phone: '+79035550101', source: 'phone' })
    const none = await call('POST', '/api/hr/export', { format: 'json', query: 'tasks=none' })
    assert.equal(((await none.json()) as unknown[]).length, 1)
  })
})

test('5000 заявок: список отдаётся целиком, повторный опрос — 304', async () => {
  await withTestDb('hr-desk-5000', async (sql) => {
    const { call } = await setup(sql)
    await sql`
      insert into applications (id, created_at, name, last_name, phone, channel, source, vacancy_id, game, months, status, consent_version, consent_source)
      select 'P' || lpad(g::text, 7, '0'), now() - make_interval(mins => g), 'Синтетика ' || g, 'Проверочная', '+7904' || lpad(g::text, 7, '0'), 'web',
        (array['fair-mgupp', 'vk', null])[1 + g % 3], 'bottling-operator',
        jsonb_build_object('quizResult', null, 'conveyorBest', 0, 'activities', g % 5), '[6,7]',
        (array['new', 'contacted', 'interview', 'declined'])[1 + g % 4], '1', 'site_form'
      from generate_series(1, 5000) g`
    const started = Date.now()
    const res = await call('GET', '/api/hr/desk')
    const text = await res.text()
    const ms = Date.now() - started
    assert.equal(res.status, 200)
    const list = JSON.parse(text) as { rows: HrApplication[] }
    assert.equal(list.rows.length, 5000)
    console.log(`  5000 заявок: ${ms} мс, ${(text.length / 1024 / 1024).toFixed(1)} МБ`)
    assert.ok(ms < 5000, `ответ сервера быстрее 5 с: ${ms} мс`)
    const again = await call('GET', '/api/hr/desk', undefined, { 'if-none-match': res.headers.get('etag')! })
    assert.equal(again.status, 304)
  })
})
