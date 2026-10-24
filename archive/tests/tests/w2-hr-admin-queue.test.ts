// Раздача новых заявок по очереди (w2-ad-1) на настоящем сервере и своей базе: три рекрутера и 9 заявок — по 3;
// выключено — ответственного нет; заявки с сайта и из ботов попадают в очередь, добавленные в панели и импорт
// с явным выбором («мне», «никому», «поровну») — нет; спам, выключенные и исключённые из очереди сотрудники пропускаются;
// одновременные заявки не достаются одному человеку; запись в истории.
// Запуск: pnpm test w2-hr-admin-queue (нужен PostgreSQL, база создаётся и удаляется сама)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CONSENT_VERSION, type HrApplication } from '../../shared/applications'
import { createApp } from '../../server/app'
import { hashPassword } from '../../server/auth/password'
import type { Registry } from '../../server/channels/registry'
import { normalizeApplication, PostgresStorage, type Sql } from '../../server/db'
import { HrRepo } from '../../server/db/hr'
import { WorkflowRepo } from '../../server/db/workflow'
import type { RateRule } from '../../server/middleware/rate-limit'
import { serverSettled, withTestDb } from './_db'

const password = 'проверка-пароля-1'
const bots: Registry = { get: () => undefined, active: () => [], failed: () => [], start: () => {} }
const rules: RateRule[] = [{ name: 'api', burst: 100000, perMinute: 100000, match: (_m, p) => p.startsWith('/api/') }]

type Queue = { enabled: boolean; next: { id: number; name: string } | null; members: { id: number; name: string }[]; assigned: number; updatedBy: string }

async function setup(sql: Sql) {
  const storage = new PostgresStorage(sql)
  const repo = new HrRepo(sql)
  const hash = await hashPassword(password)
  const admin = await repo.createUser({ email: 'admin@queue.test', name: 'Админ', role: 'admin', passwordHash: hash })
  const staff = [
    await repo.createUser({ email: 'anna@queue.test', name: 'Анна', role: 'hr', passwordHash: hash }),
    await repo.createUser({ email: 'boris@queue.test', name: 'Борис', role: 'hr', passwordHash: hash }),
    await repo.createUser({ email: 'vera@queue.test', name: 'Вера', role: 'hr', passwordHash: hash }),
  ]
  const app = await createApp({ storage, engine: null, bots, hrToken: '', env: { NODE_ENV: 'test', SITE_URL: 'https://season.example.ru' }, rateRules: rules })
  await serverSettled(sql)
  const login = await app.request('/api/hr/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: admin.email, password }) })
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { cookie, 'content-type': 'application/json', 'x-hr-request': '1' }, body: body === undefined ? undefined : JSON.stringify(body) })
  let n = 0
  const candidate = (extra: Record<string, unknown> = {}) =>
    storage.saveApplication(
      normalizeApplication({ name: `Кандидат ${++n}`, phone: `+7902${String(1_000_000 + n).padStart(7, '0')}`, consent: true, consentVersion: CONSENT_VERSION, ...extra }),
    )
  const assignee = async (id: string) => (await sql<{ a: string | null }[]>`select assignee_id as a from applications where id = ${id}`)[0].a
  const setQueue = async (enabled: boolean) => {
    const res = await call('PUT', '/api/hr/accounts/queue', { enabled })
    assert.equal(res.status, 200)
    return (await res.json()) as Queue
  }
  return { storage, repo, app, call, candidate, assignee, setQueue, admin, staff }
}

test('три рекрутера, 9 заявок с сайта и из ботов — по 3, по кругу; в истории «Раздача по очереди»', async () => {
  await withTestDb('hradm-queue-even', async (sql) => {
    const { candidate, assignee, setQueue, staff, call } = await setup(sql)
    const on = await setQueue(true)
    assert.equal(on.enabled, true)
    assert.deepEqual(on.members.map((m) => m.name), ['Анна', 'Борис', 'Вера'], 'в очереди три рекрутера, администратор по умолчанию — нет')
    assert.equal(on.next?.name, 'Анна')
    assert.equal(on.updatedBy, 'Админ')

    const channels = ['web', 'telegram', 'max'] as const
    const ids: string[] = []
    for (let i = 0; i < 9; i++) {
      const ch = channels[i % 3]
      const app = await candidate(ch === 'web' ? {} : { channel: ch, channelUserId: `u${i}` })
      ids.push(app.id)
    }
    const got = await Promise.all(ids.map(assignee))
    const byUser = (id: number) => got.filter((a) => Number(a) === id).length
    assert.deepEqual(staff.map((s) => byUser(s.id)), [3, 3, 3], 'по 3 заявки каждому')
    assert.deepEqual(got.slice(0, 3).map(Number), staff.map((s) => s.id), 'по кругу: Анна, Борис, Вера')

    const state = (await (await call('GET', '/api/hr/accounts')).json()) as { queue: Queue }
    assert.equal(state.queue.assigned, 9, 'раздано 9')
    assert.equal(state.queue.next?.name, 'Анна', 'следующая — снова Анна')

    const details = (await (await call('GET', `/api/hr/applications/${ids[1]}`)).json()) as { application: HrApplication; history: { kind: string; comment: string; userName?: string }[] }
    assert.equal(details.application.assigneeId, staff[1].id)
    assert.ok(details.history.some((h) => h.kind === 'assign' && h.comment === 'Ведёт: Борис. Раздача по очереди'), 'в истории — кто и почему')
  })
})

test('выключено — ответственного нет; включение начинает счёт заново', async () => {
  await withTestDb('hradm-queue-off', async (sql) => {
    const { candidate, assignee, setQueue } = await setup(sql)
    const a = await candidate()
    assert.equal(await assignee(a.id), null, 'по умолчанию раздача выключена')
    await setQueue(true)
    const b = await candidate()
    assert.notEqual(await assignee(b.id), null)
    const off = await setQueue(false)
    assert.equal(off.enabled, false)
    const c = await candidate()
    assert.equal(await assignee(c.id), null, 'выключили — новая заявка без ответственного')
    const again = await setQueue(true)
    assert.equal(again.assigned, 0, 'после включения счёт заново')
  })
})

test('панель и импорт: явный выбор сохраняется, очередь не вмешивается', async () => {
  await withTestDb('hradm-queue-manual', async (sql) => {
    const { call, assignee, setQueue, admin, staff } = await setup(sql)
    await setQueue(true)

    const manual = await call('POST', '/api/hr/applications', { name: 'Ручной', phone: '+79030000001', source: 'call', consentBasis: 'hr_verbal' })
    assert.equal(manual.status, 201)
    const manualId = ((await manual.json()) as { application: HrApplication }).application.id
    assert.equal(Number(await assignee(manualId)), admin.id, 'добавленный вручную — тому, кто добавил')

    const rows = (from: number) => [0, 1, 2].map((i) => ({ name: `Импорт ${from + i}`, phone: `+7904000${String(from + i).padStart(4, '0')}` }))
    const commit = async (extra: Record<string, unknown>, from: number) => {
      const res = await call('POST', '/api/hr/import/commit', { rows: rows(from), source: 'hh', consentBasis: 'job_board', ...extra })
      assert.equal(res.status, 200)
      return ((await res.json()) as { created: { id: string }[] }).created.map((c) => c.id)
    }
    const none = await commit({ assign: 'none' }, 10)
    assert.deepEqual(await Promise.all(none.map(assignee)), [null, null, null], '«никому» — без ответственного, хотя очередь включена')
    const me = await commit({ assign: 'me' }, 20)
    assert.deepEqual((await Promise.all(me.map(assignee))).map(Number), [admin.id, admin.id, admin.id], '«мне» — тому, кто загрузил')
    const even = await commit({ assign: 'even', assignees: [staff[2].id] }, 30)
    assert.deepEqual((await Promise.all(even.map(assignee))).map(Number), [staff[2].id, staff[2].id, staff[2].id], '«поровну» между выбранными — как выбрали')
    const [q] = await sql<{ assigned: number }[]>`select assigned from hr_assign_queue`
    assert.equal(q.assigned, 0, 'очередь ничего не раздала')

    // Импорт «по очереди» (вариант для панели): сервер просит очередь в своей транзакции — строки без ответственного раздаются
    const workflow = new WorkflowRepo(sql)
    const byAdmin = { id: admin.id, email: admin.email, name: admin.name, role: admin.role, disabled: false, createdAt: '', lastLoginAt: null }
    const queued = await sql.begin(async (tx) => {
      await tx`select set_config('ochakovo.assign_queue', '1', true)`
      const out: string[] = []
      for (let i = 0; i < 3; i++) out.push((await workflow.createManual({ name: `Очередь ${i}`, phone: `+7906000000${i}`, source: 'hh' }, byAdmin, 'Импорт', tx, null)).id)
      return out
    })
    assert.deepEqual((await Promise.all(queued.map(assignee))).map(Number), staff.map((s) => s.id), 'по кругу: Анна, Борис, Вера')
    const after = await workflow.createManual({ name: 'После', phone: '+79060000009', source: 'hh' }, byAdmin, 'Импорт', sql, null)
    assert.equal(await assignee(after.id), null, 'вне той транзакции «никому» снова значит «никому»')
  })
})

test('спам, выключенные и исключённые из очереди не получают заявки; одновременные заявки — по кругу без повторов', async () => {
  await withTestDb('hradm-queue-skip', async (sql) => {
    const { candidate, assignee, setQueue, staff, call, admin } = await setup(sql)
    await setQueue(true)
    const spam = await candidate({ website: 'http://spam.example' })
    assert.equal(await assignee(spam.id), null, 'ловушка для ботов — без ответственного, очередь не сдвигается')

    assert.equal((await call('PATCH', `/api/hr/accounts/${staff[1].id}`, { disabled: true })).status, 200)
    assert.equal((await call('PATCH', `/api/hr/accounts/${staff[2].id}`, { inQueue: false })).status, 200)
    const solo = await Promise.all([candidate(), candidate()])
    assert.deepEqual((await Promise.all(solo.map((a) => assignee(a.id)))).map(Number), [staff[0].id, staff[0].id], 'остался один — обе ему')

    assert.equal((await call('PATCH', `/api/hr/accounts/${staff[1].id}`, { disabled: false })).status, 200)
    assert.equal((await call('PATCH', `/api/hr/accounts/${staff[2].id}`, { inQueue: true })).status, 200)
    // 12 заявок одновременно: блокировка строки очереди не даёт двум получить одного и того же
    const burst = await Promise.all(Array.from({ length: 12 }, () => candidate()))
    const got = (await Promise.all(burst.map((a) => assignee(a.id)))).map(Number)
    assert.deepEqual(staff.map((s) => got.filter((g) => g === s.id).length), [4, 4, 4], 'по 4 каждому')

    // Администратор может встать в очередь сам — по отметке
    assert.equal((await call('PATCH', `/api/hr/accounts/${admin.id}`, { inQueue: true })).status, 200)
    const withAdmin = (await (await call('GET', '/api/hr/accounts')).json()) as { queue: Queue }
    assert.ok(withAdmin.queue.members.some((m) => m.id === admin.id), 'администратор в очереди по отметке')
    assert.equal((await call('PATCH', `/api/hr/accounts/${admin.id}`, { inQueue: false })).status, 200)

    // Никого в очереди — заявка без ответственного, ошибки нет
    for (const s of staff) await call('PATCH', `/api/hr/accounts/${s.id}`, { inQueue: false })
    const nobody = await candidate()
    assert.equal(await assignee(nobody.id), null)
    const state = (await (await call('GET', '/api/hr/accounts')).json()) as { queue: Queue }
    assert.equal(state.queue.next, null, 'в строке очереди: следующего нет')
  })
})
