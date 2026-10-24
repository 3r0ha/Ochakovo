// Права кандидата на сервере (w2-pl-2, w2-pl-3): отзыв согласия по ключу заявки, ссылка на бота только при работающем
// адаптере, удаление строк аудитории ботов с обезличенным счётчиком, архив на Яндекс Диске без ФИО и телефонов.
// Время — от текущего момента. Запуск: pnpm test w2-platform-rights (нужен PostgreSQL, база создаётся и удаляется сама)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CONSENT_VERSION } from '../../shared/applications'
import { createApp } from '../../server/app'
import type { Registry } from '../../server/channels/registry'
import { PostgresStorage, type Sql } from '../../server/db'
import { HrRepo } from '../../server/db/hr'
import { WorkflowRepo } from '../../server/db/workflow'
import { unzip } from '../../server/export/xlsxWriter'
import { archiveColumns, ARCHIVE_SKIP, syncNow } from '../../server/integrations/sync'
import { eraseBotUser, eraseOnRequest, runRetention } from '../../server/retention'
import { withTestDb } from './_db'

const birth = (years: number) => new Date(Date.now() - years * 365.25 * 864e5).toISOString().slice(0, 10)
const monthsAgo = (m: number) => new Date(Date.now() - m * 30.5 * 864e5)
const registry = (active: string[]): Registry => ({ get: () => undefined, active: () => active, failed: () => [], start: () => {} })
let ip = 0

async function appWith(sql: Sql, active: string[] = [], env: NodeJS.ProcessEnv = {}) {
  return createApp({ storage: new PostgresStorage(sql), engine: null, bots: registry(active), hrToken: '', env: { NODE_ENV: 'test', ...env } })
}

type Created = { id: string; statusToken: string }
async function apply(app: Awaited<ReturnType<typeof appWith>>, name: string, phone: string): Promise<Created> {
  const res = await app.request('/api/applications', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.20.0.${++ip}` },
    body: JSON.stringify({ name, lastName: 'Отзывова', phone, birthDate: birth(20), school: 'МГУПП', startReady: 'now', consent: true, consentVersion: CONSENT_VERSION }),
  })
  assert.equal(res.status, 201, await res.clone().text())
  return (await res.json()) as Created
}

const post = (app: Awaited<ReturnType<typeof appWith>>, path: string, token: string) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-status-token': token, 'x-forwarded-for': `10.21.0.${++ip}` }, body: '{}' })

test('отзыв согласия: чужой ключ — 404, свой — данные стёрты, задачи сняты, статус 404, в журнале «кандидат»', async () => {
  await withTestDb('w2-platform-withdraw', async (sql) => {
    await new HrRepo(sql).createUser({ email: 'rights@ochakovo.test', name: 'Проверка', role: 'admin', passwordHash: 'x' })
    const app = await appWith(sql)
    const a = await apply(app, 'Варвара', '+7 916 700-00-01')
    const other = await apply(app, 'Глеб', '+7 916 700-00-02')
    // Заявка привязана к боту, в очереди — сообщение кандидату, в истории — комментарий HR с телефоном
    await sql`update applications set bot_channel = 'telegram', bot_user_id = '7001', bot_link_hash = 'h', bot_link_expires_at = now() + interval '1 day' where id = ${a.id}`
    await sql`insert into jobs (kind, run_at, payload) values ('notify', now() + interval '1 hour', ${sql.json({ applicationId: a.id, text: 'Варвара, приходи' })})`
    await sql`insert into application_history (application_id, user_name, kind, from_status, to_status, comment) values (${a.id}, 'HR', 'comment', 'new', 'new', 'перезвонить +7 916 700-00-01')`

    assert.equal((await post(app, `/api/applications/${a.id}/withdraw`, 'x'.repeat(32))).status, 404, 'чужой ключ')
    assert.equal((await post(app, `/api/applications/${a.id}/withdraw`, other.statusToken)).status, 404, 'ключ другой заявки')
    assert.equal((await post(app, `/api/applications/NOPE0000/withdraw`, a.statusToken)).status, 404, 'неизвестный номер')
    assert.equal((await post(app, `/api/applications/${a.id}/withdraw`, '')).status, 404, 'без ключа')
    const [still] = await sql<{ name: string }[]>`select name from applications where id = ${a.id}`
    assert.equal(still.name, 'Варвара', 'после чужих попыток заявка на месте')

    const res = await post(app, `/api/applications/${a.id}/withdraw`, a.statusToken)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { status: 'withdrawn' })
    assert.equal(res.headers.get('cache-control'), 'no-store')

    const [row] = await sql<Record<string, unknown>[]>`
      select name, last_name, phone, contact, school, birth_date, status_token_hash, bot_channel, bot_user_id, bot_link_hash,
             anonymized_at, anonymized_reason, vacancy_id, source
      from applications where id = ${a.id}`
    assert.deepEqual(
      { ...row, anonymized_at: Boolean(row.anonymized_at) },
      { name: '', last_name: '', phone: '', contact: '', school: '', birth_date: null, status_token_hash: null, bot_channel: null, bot_user_id: null, bot_link_hash: null, anonymized_at: true, anonymized_reason: 'request', vacancy_id: row.vacancy_id, source: row.source },
    )
    assert.equal((await sql`select 1 from jobs where payload ->> 'applicationId' = ${a.id}`).length, 0, 'задачи очереди сняты')
    const [hist] = await sql<{ comment: string }[]>`select comment from application_history where application_id = ${a.id} and kind = 'comment'`
    assert.equal(hist.comment, '', 'комментарий с телефоном стёрт')
    const [log] = await sql<{ kind: string; scope: string; count: number; user_name: string; reason: string; user_id: string | null }[]>`
      select kind, scope, count, user_name, reason, user_id from retention_log where application_id = ${a.id}`
    assert.deepEqual({ ...log, reason: /отозвал согласие/.test(log.reason) }, { kind: 'candidate', scope: 'applications', count: 1, user_name: 'Кандидат', reason: true, user_id: null })

    const status = await app.request(`/api/applications/${a.id}/status`, { headers: { 'x-status-token': a.statusToken } })
    assert.equal(status.status, 404, 'статус по старому ключу — 404')
    assert.equal((await post(app, `/api/applications/${a.id}/withdraw`, a.statusToken)).status, 404, 'повторный отзыв — 404')
    const [kept] = await sql<{ name: string }[]>`select name from applications where id = ${other.id}`
    assert.equal(kept.name, 'Глеб', 'чужая заявка не тронута')
    await new Promise((r) => setTimeout(r, 50))
  })
})

test('ссылка на бота: без бота — 404, чужой ключ — 404, ответ — только диплинки', async () => {
  await withTestDb('w2-platform-botlink', async (sql) => {
    await new HrRepo(sql).createUser({ email: 'botlink@ochakovo.test', name: 'Проверка', role: 'admin', passwordHash: 'x' })
    const names = { TELEGRAM_BOT_USERNAME: 'ochakovo_kvasych_bot', MAX_BOT_NICK: 'id7712345678_bot', TELEGRAM_BOT_TOKEN: '123:secret-token' }
    const none = await appWith(sql, [], names)
    const a = await apply(none, 'Дарья', '+7 916 700-00-11')
    const b = await apply(none, 'Егор', '+7 916 700-00-12')
    assert.equal((await post(none, `/api/applications/${a.id}/bot-link`, a.statusToken)).status, 404, 'адаптеры не поднялись — ссылки нет')
    const noName = await appWith(sql, ['telegram'], {})
    assert.equal((await post(noName, `/api/applications/${a.id}/bot-link`, a.statusToken)).status, 404, 'бот работает, имя не задано')

    const tg = await appWith(sql, ['telegram'], names)
    assert.equal((await post(tg, `/api/applications/${a.id}/bot-link`, b.statusToken)).status, 404, 'чужой ключ')
    assert.equal((await post(tg, `/api/applications/${a.id}/bot-link`, 'z'.repeat(32))).status, 404)
    const res = await post(tg, `/api/applications/${a.id}/bot-link`, a.statusToken)
    assert.equal(res.status, 200)
    const text = await res.clone().text()
    const links = (await res.json()) as Record<string, string>
    assert.deepEqual(Object.keys(links), ['telegram'], 'MAX не поднялся — его ссылки нет')
    assert.match(links.telegram, /^https:\/\/t\.me\/ochakovo_kvasych_bot\?start=app_[\w-]{20,}$/)
    assert.doesNotMatch(text, /secret|token|Дарья|916/, 'в ответе нет секретов и данных заявки')
    const [row] = await sql<{ bot_link_hash: string | null }[]>`select bot_link_hash from applications where id = ${a.id}`
    assert.ok(row.bot_link_hash && !text.includes(row.bot_link_hash), 'в базе — хеш, наружу — только ссылка')

    const both = await appWith(sql, ['telegram', 'max'], names)
    const two = (await (await post(both, `/api/applications/${a.id}/bot-link`, a.statusToken)).json()) as Record<string, string>
    assert.deepEqual(Object.keys(two).sort(), ['max', 'telegram'])
    assert.match(two.max, /^https:\/\/max\.ru\/id7712345678_bot\?start=app_/)

    // Отозванная заявка ссылку не получает
    await post(tg, `/api/applications/${a.id}/withdraw`, a.statusToken)
    assert.equal((await post(tg, `/api/applications/${a.id}/bot-link`, a.statusToken)).status, 404)
    await new Promise((r) => setTimeout(r, 50))
  })
})

test('аудитория ботов: строка человека удаляется по запросу и по сроку, отчёты не меняются', async () => {
  await withTestDb('w2-platform-botusers', async (sql) => {
    const storage = new PostgresStorage(sql)
    const repo = new HrRepo(sql)
    const funnelBots = async () => {
      const report = await repo.funnel(new Date(Date.now() - 400 * 864e5), new Date(Date.now() + 864e5), [])
      return report.rows.map((r) => ({ source: r.source, visitors: r.visitors })).sort((x, y) => x.source.localeCompare(y.source))
    }
    await sql`insert into bot_users (channel, user_id, first_name, username, source, created_at, last_seen_at, remind_at, remind_dept)
              values ('telegram', '9001', 'Ира', 'ira', 'fair-mgupp', now() - interval '3 days', now(), now(), 'any'),
                     ('telegram', '9002', 'Олег', 'oleg', null, now() - interval '2 days', now(), null, null),
                     ('max', '9003', 'Лена', 'lena', 'vk-spring', ${monthsAgo(14)}, ${monthsAgo(13)}, null, null)`
    await sql`insert into sessions (channel, user_id, data) values ('telegram', '9001', ${sql.json({ step: 'menu' })})`
    const audience = await storage.botAudience()
    const funnel = await funnelBots()

    // «Удалить мои данные» в боте
    const r = await eraseBotUser(sql, 'telegram', '9001')
    assert.deepEqual(r, { botUsers: 1, sessions: 1 })
    assert.equal((await sql`select 1 from bot_users where channel = 'telegram' and user_id = '9001'`).length, 0, 'строки человека нет')
    assert.equal((await sql`select 1 from sessions where channel = 'telegram' and user_id = '9001'`).length, 0, 'диалога нет')
    const [ghost] = await sql<{ user_id: string; first_name: string | null; username: string | null; remind_at: Date | null; source: string; erased: boolean }[]>`
      select user_id, first_name, username, remind_at, source, erased from bot_users where erased and source = 'fair-mgupp'`
    assert.match(ghost.user_id, /^erased:[0-9a-f-]{36}$/, 'на месте строки — счётчик со случайным id')
    assert.deepEqual({ ...ghost, user_id: '' }, { user_id: '', first_name: null, username: null, remind_at: null, source: 'fair-mgupp', erased: true })
    assert.deepEqual(await storage.botAudience(), audience, 'аудитория по каналам и меткам прежняя')
    assert.deepEqual(await funnelBots(), funnel, '«Пришли» в воронке прежние')
    const [log] = await sql<{ kind: string; scope: string; user_name: string }[]>`select kind, scope, user_name from retention_log where scope = 'bot_users'`
    assert.deepEqual(log, { kind: 'candidate', scope: 'bot_users', user_name: 'Кандидат' })
    assert.deepEqual(await eraseBotUser(sql, 'telegram', '9001'), { botUsers: 0, sessions: 0 }, 'повтор ничего не делает')

    // По сроку: кто не заходил дольше 12 месяцев
    const result = await runRetention({ sql, env: { RETENTION_MONTHS: '12' } })
    assert.ok(!('busy' in result) && result.botUsers === 1, JSON.stringify(result))
    assert.equal((await sql`select 1 from bot_users where user_id = '9003'`).length, 0)
    assert.equal((await sql`select 1 from bot_users where user_id = '9002'`).length, 1, 'кто заходил недавно — на месте')
    assert.deepEqual(await storage.botAudience(), audience, 'после срока хранения аудитория прежняя')
    const [old] = await sql<{ created_at: Date; last_seen_at: Date }[]>`select created_at, last_seen_at from bot_users where erased and channel = 'max'`
    assert.equal(old.created_at.getUTCMinutes() + old.created_at.getUTCSeconds() + old.created_at.getUTCMilliseconds(), 0, 'время прихода — до часа')
  })
})

test('удаление по запросу в HR: заявка с сайта, привязанная к боту, уносит строку аудитории этого чата', async () => {
  await withTestDb('w2-platform-hrerase', async (sql) => {
    const hr = await new HrRepo(sql).createUser({ email: 'erase@ochakovo.test', name: 'Ольга', role: 'admin', passwordHash: 'x' })
    const app = await appWith(sql)
    const a = await apply(app, 'Мирон', '+7 916 700-00-21')
    await sql`update applications set bot_channel = 'telegram', bot_user_id = '9101' where id = ${a.id}`
    await sql`insert into bot_users (channel, user_id, first_name, username, source) values ('telegram', '9101', 'Мирон', 'miron', 'tg-ads')`
    const done = await eraseOnRequest(sql, a.id, hr, 'кандидат позвонил и попросил удалить', [])
    assert.ok(done && done.applications === 1 && done.botUsers === 1, JSON.stringify(done))
    assert.equal((await sql`select 1 from bot_users where user_id = '9101'`).length, 0)
    const kinds = await sql<{ kind: string; scope: string; user_name: string }[]>`select kind, scope, user_name from retention_log order by id`
    assert.deepEqual([...kinds], [
      { kind: 'request', scope: 'applications', user_name: 'Ольга' },
      { kind: 'request', scope: 'bot_users', user_name: 'Ольга' },
    ])
    await new Promise((r) => setTimeout(r, 50))
  })
})

test('Яндекс Диск: «Заявки.xlsx» — рабочий файл, копия в «Архив» — без ФИО, телефонов и даты рождения', async () => {
  await withTestDb('w2-platform-disk', async (sql) => {
    const repo = new HrRepo(sql)
    await repo.createUser({ email: 'disk@ochakovo.test', name: 'Ольга Архипова', role: 'admin', passwordHash: 'x' })
    const app = await appWith(sql)
    const a = await apply(app, 'Ксенофонт', '+7 916 733-44-55')
    await sql`update applications set middle_name = 'Аристархович', contact = '@ksenofont_tg', comment = 'звоните после 18:00 на 8 916 733 44 55', notes = 'мама Ксенофонта' where id = ${a.id}`
    await repo.patchIntegration('yandex_disk', { snapshots: true })
    const uploads = new Map<string, Buffer>()
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/resources/upload')) return Response.json({ href: `https://disk.test/put?path=${encodeURIComponent(url.searchParams.get('path')!)}`, method: 'PUT' })
      if (url.pathname === '/put') {
        uploads.set(url.searchParams.get('path')!, Buffer.from(init!.body as Uint8Array))
        return new Response(null, { status: 201 })
      }
      if (url.pathname.endsWith('/resources') && (init?.method ?? 'GET') === 'GET') return new Response(null, { status: 404 })
      return new Response(null, { status: 201 })
    }) as typeof fetch
    const r = await syncNow({ sql, repo, workflow: new WorkflowRepo(sql), env: { YANDEX_DISK_TOKEN: 'x' }, disk: { apiBase: 'https://disk.test/v1/disk', fetch: fakeFetch } })
    assert.ok(r.ok, JSON.stringify(r))
    const text = (file: Buffer) => [...unzip(file).entries()].filter(([k]) => k.startsWith('xl/')).map(([, v]) => v.toString('utf8')).join('')
    const main = [...uploads.entries()].find(([p]) => p.endsWith('/Заявки.xlsx'))
    const archive = [...uploads.entries()].find(([p]) => p.includes('/Архив/'))
    assert.ok(main && archive, [...uploads.keys()].join(', '))
    assert.match(text(main[1]), /Ксенофонт/, 'в рабочем файле отдела — имя')
    const arch = text(archive[1])
    for (const bit of ['Ксенофонт', 'Отзывова', 'Аристархович', '9167334455', '916 733', '733-44-55', 'ksenofont', 'МГУПП', 'Ольга Архипова', 'мама'])
      assert.ok(!arch.includes(bit), `в архиве нет «${bit}»`)
    assert.ok(arch.includes(a.id), 'номер заявки в архиве есть — по нему сверяются отчёты')
    for (const key of ['lastName', 'name', 'middleName', 'phone', 'contact', 'birthDate', 'school', 'comment', 'notes']) assert.ok(ARCHIVE_SKIP.has(key), key)
    assert.ok(archiveColumns().some((c) => c.key === 'vacancy') && archiveColumns().some((c) => c.key === 'status'), 'вакансия и статус в архиве остаются')
    await new Promise((r) => setTimeout(r, 50))
  })
})
