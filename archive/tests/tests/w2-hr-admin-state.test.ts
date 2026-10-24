// «Состояние» и журнал выгрузок у администратора (w2-ad-5) на настоящем сервере и своей базе: задача с тремя неудачами
// видна со ссылкой на заявку, выгрузка на Диск и её ошибка, удаление по сроку, последнее сообщение в ботах;
// журнал выгрузок с отбором по формату и сотруднику; роль hr — 403.
// Запуск: pnpm test w2-hr-admin-state (нужен PostgreSQL, база создаётся и удаляется сама)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CONSENT_VERSION } from '../../shared/applications'
import { createApp } from '../../server/app'
import { hashPassword } from '../../server/auth/password'
import type { Registry } from '../../server/channels/registry'
import { normalizeApplication, PostgresStorage } from '../../server/db'
import { logAccess } from '../../server/db/accessLog'
import { HrRepo } from '../../server/db/hr'
import { JobsRepo, MAX_ATTEMPTS } from '../../server/db/jobs'
import type { RateRule } from '../../server/middleware/rate-limit'
import { serverSettled, withTestDb } from './_db'

const password = 'проверка-пароля-1'
const bots: Registry = { get: () => undefined, active: () => [], failed: () => [], start: () => {} }
const rules: RateRule[] = [{ name: 'api', burst: 100000, perMinute: 100000, match: (_m, p) => p.startsWith('/api/') }]

test('состояние: проваленная задача, Диск, срок хранения, боты; журнал выгрузок; роль hr — 403', async () => {
  await withTestDb('hradm-state', async (sql) => {
    const storage = new PostgresStorage(sql)
    const repo = new HrRepo(sql)
    const hash = await hashPassword(password)
    const admin = await repo.createUser({ email: 'admin@state.test', name: 'Ирина', role: 'admin', passwordHash: hash })
    const hr = await repo.createUser({ email: 'hr@state.test', name: 'Анна', role: 'hr', passwordHash: hash })
    const app = await createApp({ storage, engine: null, bots, hrToken: '', env: { NODE_ENV: 'test', SITE_URL: 'https://season.example.ru' }, rateRules: rules })
    await serverSettled(sql)
    const cookieOf = async (email: string) =>
      ((await app.request('/api/hr/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })).headers.get('set-cookie') ?? '').split(';')[0]
    const adminCookie = await cookieOf(admin.email)
    const hrCookie = await cookieOf(hr.email)
    const get = (path: string, cookie = adminCookie) => app.request(path, { headers: { cookie } })

    // Задача, которая трижды не прошла: сообщение кандидату
    const cand = await storage.saveApplication(normalizeApplication({ name: 'Кандидат', phone: '+79050000001', consent: true, consentVersion: CONSENT_VERSION }))
    const jobs = new JobsRepo(sql)
    const id = await jobs.enqueue('notify', new Date(Date.now() - 1000), { applicationId: cand.id })
    assert.ok(id)
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const [job] = await jobs.claim(1)
      assert.ok(job, `попытка ${i + 1}`)
      await jobs.fail(job, 'telegram: chat not found')
      await sql`update jobs set run_at = now() - interval '1 second' where status = 'pending'`
    }
    await repo.patchIntegration('yandex_disk', { lastOkAt: new Date(Date.now() - 3600e3).toISOString(), lastRows: 42, lastError: 'Диск переполнен' })
    await repo.patchIntegration('retention', { lastRunAt: new Date(Date.now() - 2 * 3600e3).toISOString() })

    const res = await get('/api/hr/admin/state')
    assert.equal(res.status, 200)
    const state = (await res.json()) as {
      jobs: { failed24h: number; list: { kind: string; attempts: number; error: string; applicationId: string | null }[] }
      disk: { lastRows: number; error: string | null; lastOkAt: string | null }
      retention: { lastRunAt: string | null }
      bots: Record<string, string | null>
    }
    assert.equal(state.jobs.failed24h, 1, 'задача с тремя неудачами видна')
    assert.equal(state.jobs.list[0].attempts, MAX_ATTEMPTS)
    assert.equal(state.jobs.list[0].kind, 'notify')
    assert.equal(state.jobs.list[0].applicationId, cand.id, 'ссылка на заявку')
    assert.match(state.jobs.list[0].error, /chat not found/)
    assert.equal(state.disk.lastRows, 42)
    assert.equal(state.disk.error, 'Диск переполнен')
    assert.ok(state.retention.lastRunAt)
    assert.deepEqual(state.bots, { telegram: null, max: null })

    // Выгрузка из панели пишет журнал (logAccess) — здесь так, как её запишет маршрут выгрузки
    await logAccess(sql, { user: { id: admin.id, name: admin.name, role: admin.role }, action: 'export', format: 'xlsx', rows: 17, filter: 'status=new' })
    await logAccess(sql, { user: { id: hr.id, name: hr.name, role: hr.role }, action: 'export', format: 'csv1c', rows: 3 })
    await logAccess(sql, { who: 'Выгрузка на Яндекс Диск', action: 'disk', format: 'xlsx', rows: 42 })
    const all = (await (await get('/api/hr/admin/access-log')).json()) as { userName: string; role: string; format: string; rows: number; action: string }[]
    assert.equal(all.length, 3)
    assert.deepEqual(all.map((r) => r.action), ['disk', 'export', 'export'], 'новые сверху')
    const excel = (await (await get('/api/hr/admin/access-log?action=export&format=xlsx')).json()) as { userName: string; format: string; rows: number }[]
    assert.deepEqual(excel.map((r) => `${r.userName} · ${r.format} · ${r.rows}`), ['Ирина · xlsx · 17'], 'строка «Ирина · Excel · 17 заявок»')
    const anna = (await (await get('/api/hr/admin/access-log?user=анн')).json()) as { userName: string }[]
    assert.deepEqual(anna.map((r) => r.userName), ['Анна'], 'отбор по сотруднику без учёта регистра')

    assert.equal((await get('/api/hr/admin/access-log', hrCookie)).status, 403, 'роль hr журнал не видит')
    assert.equal((await get('/api/hr/admin/state', hrCookie)).status, 403)
  })
})
