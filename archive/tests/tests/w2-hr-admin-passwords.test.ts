// Пароли сотрудников и вход (w2-ad-2) на настоящем сервере и своей базе: временный пароль от администратора
// при заведении и сбросе, обязательная смена при входе, POST /api/hr/me/password, задержка после неверных паролей
// на пару «почта + IP» — с другого адреса та же почта входит сразу.
// Запуск: pnpm test w2-hr-admin-passwords (нужен PostgreSQL, база создаётся и удаляется сама)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { createApp } from '../../server/app'
import { hrRoutes } from '../../server/api/hr'
import { hashPassword } from '../../server/auth/password'
import { createThrottle, loginGuard, THROTTLE_DEFAULTS } from '../../server/auth/throttle'
import type { Registry } from '../../server/channels/registry'
import { PostgresStorage, type Sql } from '../../server/db'
import { HrRepo } from '../../server/db/hr'
import type { RateRule } from '../../server/middleware/rate-limit'
import { serverSettled, withTestDb } from './_db'

process.env.TRUST_PROXY = '1'

const password = 'проверка-пароля-1'
const bots: Registry = { get: () => undefined, active: () => [], failed: () => [], start: () => {} }
const rules: RateRule[] = [{ name: 'api', burst: 100000, perMinute: 100000, match: (_m, p) => p.startsWith('/api/') }]

type Account = { id: number; email: string; name: string; mustChangePassword: boolean; inQueue: boolean }

async function setup(sql: Sql) {
  const storage = new PostgresStorage(sql)
  const repo = new HrRepo(sql)
  const admin = await repo.createUser({ email: 'admin@pw.test', name: 'Админ', role: 'admin', passwordHash: await hashPassword(password) })
  const app = await createApp({ storage, engine: null, bots, hrToken: '', env: { NODE_ENV: 'test', SITE_URL: 'https://season.example.ru' }, rateRules: rules })
  await serverSettled(sql)
  const login = async (email: string, pass: string, ip = '10.1.0.1') => {
    const res = await app.request('/api/hr/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ email, password: pass }) })
    return { res, cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] }
  }
  const call = (cookie: string, method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { cookie, 'content-type': 'application/json', 'x-hr-request': '1' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const adminCookie = (await login(admin.email, password)).cookie
  assert.ok(adminCookie, 'администратор вошёл')
  return { storage, repo, app, admin, login, call, adminCookie }
}

test('новый сотрудник с паролем от администратора обязан сменить его при входе', async () => {
  await withTestDb('hradm-pw-new', async (sql) => {
    const { app, login, call, adminCookie } = await setup(sql)
    const created = await call(adminCookie, 'POST', '/api/hr/accounts', { email: 'Anna@PW.test', name: 'Анна Смирнова', role: 'hr', password: 'временный-пароль-1' })
    assert.equal(created.status, 201)
    const anna = (await created.json()) as Account
    assert.equal(anna.email, 'anna@pw.test', 'почта в нижнем регистре')
    assert.equal(anna.mustChangePassword, true, 'пароль временный')

    const weak = await call(adminCookie, 'POST', '/api/hr/accounts', { email: 'x@pw.test', name: 'Икс', password: '123' })
    assert.equal(weak.status, 422, 'короткий пароль — 422')
    const dup = await call(adminCookie, 'POST', '/api/hr/accounts', { email: 'anna@pw.test', name: 'Анна', password: 'временный-пароль-1' })
    assert.equal(dup.status, 422, 'та же почта — 422')

    const first = await login('anna@pw.test', 'временный-пароль-1')
    assert.equal(first.res.status, 200, 'вход с временным паролем проходит')
    const blocked = await call(first.cookie, 'GET', '/api/hr/applications')
    assert.equal(blocked.status, 401, 'до смены пароля панель закрыта')
    assert.equal(((await blocked.json()) as { error: string }).error, 'password_change_required')
    assert.equal((await call(first.cookie, 'GET', '/api/hr/me')).status, 401, '«кто я» панели тоже ждёт смены пароля')

    const account = (await (await call(first.cookie, 'GET', '/api/hr/me/account')).json()) as { mustChangePassword: boolean; session: { expiresAt: string; latestAt: string } }
    assert.equal(account.mustChangePassword, true, 'страница входа узнаёт, что пароль нужно сменить')
    assert.ok(Date.parse(account.session.latestAt) - Date.now() <= 7 * 864e5 + 5000, 'сессия не дольше 7 дней')

    const wrong = await call(first.cookie, 'POST', '/api/hr/me/password', { currentPassword: 'не тот', newPassword: 'свой-пароль-анны' })
    assert.equal(wrong.status, 422)
    assert.ok(((await wrong.json()) as { errors: Record<string, string> }).errors.currentPassword, 'текущий пароль не подошёл')
    const same = await call(first.cookie, 'POST', '/api/hr/me/password', { currentPassword: 'временный-пароль-1', newPassword: 'временный-пароль-1' })
    assert.equal(same.status, 422, 'тот же пароль — 422')
    const short = await call(first.cookie, 'POST', '/api/hr/me/password', { currentPassword: 'временный-пароль-1', newPassword: 'коротко' })
    assert.equal(short.status, 422, 'короткий — 422')
    const noHeader = await app.request('/api/hr/me/password', {
      method: 'POST',
      headers: { cookie: first.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'временный-пароль-1', newPassword: 'свой-пароль-анны' }),
    })
    assert.equal(noHeader.status, 403, 'без x-hr-request сменить пароль нельзя')

    // Второй вход с тем же временным паролем: после смены он закроется, текущий останется
    const second = await login('anna@pw.test', 'временный-пароль-1', '10.1.0.2')
    const changed = await call(first.cookie, 'POST', '/api/hr/me/password', { currentPassword: 'временный-пароль-1', newPassword: 'свой-пароль-анны' })
    assert.equal(changed.status, 200)
    assert.equal(((await changed.json()) as { user: Account }).user.mustChangePassword, false)
    assert.equal((await call(first.cookie, 'GET', '/api/hr/applications')).status, 200, 'после смены панель открыта')
    const other = (await (await call(second.cookie, 'GET', '/api/hr/me/account')).json()) as { user: unknown }
    assert.equal(other.user, null, 'другие входы закрыты')
    assert.equal((await login('anna@pw.test', 'временный-пароль-1')).res.status, 401, 'старый пароль больше не подходит')
    assert.equal((await login('anna@pw.test', 'свой-пароль-анны')).res.status, 200, 'новый подходит')
  })
})

test('сброс пароля администратором: входы закрыты, при входе нужно сменить; старый маршрут тоже ставит смену', async () => {
  await withTestDb('hradm-pw-reset', async (sql) => {
    const { repo, login, call, adminCookie, admin } = await setup(sql)
    const boris = await repo.createUser({ email: 'boris@pw.test', name: 'Борис', role: 'hr', passwordHash: await hashPassword(password) })
    const before = await login(boris.email, password)
    assert.equal((await call(before.cookie, 'GET', '/api/hr/applications')).status, 200, 'до сброса работает')

    const reset = await call(adminCookie, 'POST', `/api/hr/accounts/${boris.id}/password`, { password: 'новый-временный-2' })
    assert.equal(reset.status, 200)
    assert.equal(((await reset.json()) as Account).mustChangePassword, true)
    assert.equal((await call(before.cookie, 'GET', '/api/hr/applications')).status, 401, 'старые входы закрыты')
    const after = await login(boris.email, 'новый-временный-2')
    assert.equal(after.res.status, 200)
    assert.equal((await call(after.cookie, 'GET', '/api/hr/applications')).status, 401, 'до смены пароля панель закрыта')
    assert.equal((await call(adminCookie, 'POST', `/api/hr/accounts/${admin.id}/password`, { password: 'новый-временный-3' })).status, 422, 'свой пароль — только через смену с текущим')
    assert.equal((await call(adminCookie, 'POST', '/api/hr/accounts/999999/password', { password: 'новый-временный-3' })).status, 404)

    // Старый маршрут панели PATCH /api/hr/users/:id {password}: триггер в базе тоже требует смены
    const vera = await repo.createUser({ email: 'vera@pw.test', name: 'Вера', role: 'hr', passwordHash: await hashPassword(password) })
    assert.equal((await call(adminCookie, 'PATCH', `/api/hr/users/${vera.id}`, { password: 'сброс-старым-путём' })).status, 200)
    const veraIn = await login(vera.email, 'сброс-старым-путём')
    assert.equal((await call(veraIn.cookie, 'GET', '/api/hr/applications')).status, 401, 'после сброса старым маршрутом тоже нужна смена')

    // Сотрудник, созданный напрямую (bootstrap, демо), менять пароль не обязан
    const [row] = await sql<{ must: boolean }[]>`select must_change_password as must from hr_users where id = ${admin.id}`
    assert.equal(row.must, false, 'администратор из bootstrap пароль менять не обязан')
  })
})

test('администратор: правка сотрудника, последний администратор, себя не выключить; роль hr — 403', async () => {
  await withTestDb('hradm-pw-admin', async (sql) => {
    const { repo, login, call, adminCookie, admin } = await setup(sql)
    const hr = await repo.createUser({ email: 'hr@pw.test', name: 'Галина', role: 'hr', passwordHash: await hashPassword(password) })
    const hrCookie = (await login(hr.email, password)).cookie
    assert.equal((await call(hrCookie, 'GET', '/api/hr/accounts')).status, 403, 'роль hr не видит учётные записи')
    assert.equal((await call(hrCookie, 'POST', '/api/hr/accounts', { email: 'z@pw.test', name: 'Зоя', password: 'временный-пароль-1' })).status, 403)

    const list = (await (await call(adminCookie, 'GET', '/api/hr/accounts')).json()) as { users: Account[]; queue: { enabled: boolean } }
    assert.equal(list.users.length, 2)
    assert.ok(list.users.every((u) => !('passwordHash' in u) && !('password_hash' in u)), 'хешей паролей в ответе нет')
    assert.equal(list.queue.enabled, false)

    assert.equal((await call(adminCookie, 'PATCH', `/api/hr/accounts/${admin.id}`, { disabled: true })).status, 422, 'себя не выключить')
    assert.equal((await call(adminCookie, 'PATCH', `/api/hr/accounts/${admin.id}`, { role: 'hr' })).status, 422, 'себя не понизить')
    assert.equal((await call(adminCookie, 'PATCH', `/api/hr/accounts/${hr.id}`, { name: 'Г' })).status, 422, 'имя из одной буквы — 422')
    const renamed = await call(adminCookie, 'PATCH', `/api/hr/accounts/${hr.id}`, { name: 'Галина Петрова', inQueue: false })
    assert.equal(renamed.status, 200)
    const g = (await renamed.json()) as Account
    assert.equal(g.name, 'Галина Петрова')
    assert.equal(g.inQueue, false)
    const off = await call(adminCookie, 'PATCH', `/api/hr/accounts/${hr.id}`, { disabled: true })
    assert.equal(off.status, 200)
    assert.equal((await call(hrCookie, 'GET', '/api/hr/applications')).status, 401, 'выключенный сотрудник сразу теряет вход')
  })
})

test('задержка после неверных паролей — на пару «почта + IP»: с другого адреса та же почта входит', async () => {
  await withTestDb('hradm-pw-throttle', async (sql) => {
    const storage = new PostgresStorage(sql)
    const repo = new HrRepo(sql)
    const anna = await repo.createUser({ email: 'anna@throttle.test', name: 'Анна', role: 'hr', passwordHash: await hashPassword(password) })
    let now = 1_000_000
    const throttle = createThrottle({ now: () => now })
    // Так вход подключён в сервере: обёртка перед обработчиком POST /api/hr/login
    const app = new Hono()
    app.use('/api/hr/login', loginGuard(throttle))
    app.route('/', hrRoutes({ storage, repo, bots, env: { NODE_ENV: 'test' } }))
    const login = (pass: string, ip: string, email = anna.email) =>
      app.request('/api/hr/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ email, password: pass }) })

    for (let i = 1; i <= THROTTLE_DEFAULTS.free - 1; i++) assert.equal((await login('мимо', '10.2.0.1')).status, 401, `промах ${i} — без задержки`)
    const third = await login('мимо', '10.2.0.1')
    assert.equal(third.status, 401)
    assert.equal(third.headers.get('retry-after'), '5', 'после третьего промаха — подожди 5 с')

    const locked = await login(password, '10.2.0.1')
    assert.equal(locked.status, 429, 'пока ждём — даже верный пароль не проверяется')
    assert.equal(((await locked.json()) as { retryAfter: number }).retryAfter, 5)
    assert.equal((await login(password, '10.2.0.1', 'ANNA@throttle.test ')).status, 429, 'та же почта в другом регистре — та же пара')

    assert.equal((await login(password, '10.2.0.99')).status, 200, 'с другого адреса почта не заблокирована')

    now += 5_000
    const fourth = await login('мимо', '10.2.0.1')
    assert.equal(fourth.status, 401)
    assert.equal(fourth.headers.get('retry-after'), '10', 'задержка растёт: 10 с')
    now += 9_000
    assert.equal((await login(password, '10.2.0.1')).status, 429, 'через 9 с ещё рано')
    now += 1_000
    assert.equal((await login(password, '10.2.0.1')).status, 200, 'через 10 с — вход')
    assert.equal(throttle.failures(`${anna.email}|10.2.0.1`), 0, 'удачный вход обнуляет счёт')

    // Потолок — 5 минут; через 15 минут без промахов пара забывается
    for (let i = 0; i < 12; i++) {
      await login('мимо', '10.2.0.5')
      now += 301_000
    }
    const capped = await login('мимо', '10.2.0.5')
    assert.equal(capped.headers.get('retry-after'), '300', 'не больше 5 минут')
    now += 16 * 60_000
    assert.equal(throttle.failures(`${anna.email}|10.2.0.5`), 0, 'через 15 минут без промахов — забыто')
    throttle.stop()
  })
})
