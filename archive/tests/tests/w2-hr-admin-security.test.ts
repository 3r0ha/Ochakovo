// Безопасность входа в HR-панель и медиа (w2-ad-c1) на настоящем сервере и своей базе:
// лимит попыток входа с одного адреса, истечение сессии и предел 7 дней, служебный токен x-hr-token только на чтение,
// заголовок x-hr-request у изменяющих запросов, обход путей в /api/media.
// Запуск: pnpm test w2-hr-admin-security (нужен PostgreSQL, база создаётся и удаляется сама)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApp } from '../../server/app'
import { hashPassword } from '../../server/auth/password'
import { SESSION_MAX_AGE, SESSION_TTL } from '../../server/auth/session'
import type { Registry } from '../../server/channels/registry'
import { PostgresStorage, type Sql } from '../../server/db'
import { HrRepo } from '../../server/db/hr'
import type { RateRule } from '../../server/middleware/rate-limit'
import { serverSettled, withTestDb } from './_db'

// Адрес клиента — из X-Forwarded-For, как за прокси: так проверка ставит разные IP
process.env.TRUST_PROXY = '1'

const password = 'проверка-пароля-1'
const bots: Registry = { get: () => undefined, active: () => [], failed: () => [], start: () => {} }
const loose: RateRule[] = [{ name: 'api', burst: 100000, perMinute: 100000, match: (_m, p) => p.startsWith('/api/') }]

async function setup(sql: Sql, rateRules?: RateRule[]) {
  const storage = new PostgresStorage(sql)
  const repo = new HrRepo(sql)
  const hash = await hashPassword(password)
  const admin = await repo.createUser({ email: 'admin@sec.test', name: 'Админ', role: 'admin', passwordHash: hash })
  const hr = await repo.createUser({ email: 'hr@sec.test', name: 'Анна', role: 'hr', passwordHash: hash })
  const app = await createApp({ storage, engine: null, bots, hrToken: '', env: { NODE_ENV: 'test', SITE_URL: 'https://season.example.ru' }, rateRules })
  await serverSettled(sql)
  const login = (email: string, pass = password, ip = '10.0.0.1') =>
    app.request('/api/hr/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ email, password: pass }) })
  const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0]
  return { storage, repo, app, admin, hr, login, cookieOf }
}

test('лимит попыток входа: шестая с одного адреса — 429 с Retry-After, с другого адреса вход работает', async () => {
  await withTestDb('hradm-sec-limit', async (sql) => {
    const { admin, login } = await setup(sql)
    // Промахи на разные почты: задержка по паре «почта + IP» (loginGuard) не срабатывает, проверяется лимит по IP
    for (let i = 1; i <= 5; i++) assert.equal((await login(`nobody${i}@sec.test`, `неверный-${i}`, '10.0.0.7')).status, 401, `попытка ${i} — 401`)
    const sixth = await login(admin.email, password, '10.0.0.7')
    assert.equal(sixth.status, 429, 'шестая попытка с того же адреса — 429, даже с верным паролем')
    assert.ok(Number(sixth.headers.get('retry-after')) >= 1, 'есть Retry-After')
    assert.equal(((await sixth.json()) as { error: string }).error, 'rate_limited')
    assert.equal((await login(admin.email, password, '10.0.0.8')).status, 200, 'с другого адреса та же почта входит')
  })
})

test('сессия: просроченная — 401, старше 7 дней — 401, продление не уходит дальше 7 дней от входа', async () => {
  await withTestDb('hradm-sec-session', async (sql) => {
    const { app, hr, login, cookieOf } = await setup(sql, loose)
    const me = (cookie: string) => app.request('/api/hr/me', { headers: { cookie } })

    const first = await login(hr.email)
    const raw = first.headers.get('set-cookie') ?? ''
    assert.match(raw, new RegExp(`Max-Age=${SESSION_TTL / 1000}`), 'cookie живёт 12 часов')
    const a = cookieOf(first)
    assert.equal((await me(a)).status, 200)
    await sql`update hr_sessions set expires_at = now() - interval '1 minute'`
    assert.equal((await me(a)).status, 401, 'просроченная сессия — 401')

    const b = cookieOf(await login(hr.email))
    assert.equal((await me(b)).status, 200)
    await sql`update hr_sessions set created_at = now() - interval '8 days' where expires_at > now()`
    assert.equal((await me(b)).status, 401, 'сессия старше 7 дней — 401, даже если её продлевали')

    // Вход 6 дней 23 часа назад: работа в панели продлевает сессию, но не дальше 7 дней от входа
    const c = cookieOf(await login(hr.email))
    await sql`update hr_sessions set created_at = now() - interval '6 days 23 hours', expires_at = now() + interval '10 minutes' where expires_at > now()`
    assert.equal((await me(c)).status, 200)
    const [row] = await sql<{ ok: boolean; left: number }[]>`
      select expires_at <= created_at + interval '7 days' as ok, extract(epoch from expires_at - now())::int as left
      from hr_sessions where expires_at > now() order by created_at limit 1`
    assert.ok(row.ok, 'срок не дальше created_at + 7 дней')
    assert.ok(row.left <= 3600 + 5, `продлилась не на 12 часов, а до предела: осталось ${row.left} с`)
    assert.equal(SESSION_MAX_AGE, 7 * 24 * 3600 * 1000, 'предел в коде тот же, что в базе')

    // Новая сессия в базе сразу не длиннее предела, даже если её создают с большим сроком
    const repo = new HrRepo(sql)
    await repo.createSession('проверка-предела', hr.id, 30 * 24 * 3600 * 1000)
    const [capped] = await sql<{ ok: boolean }[]>`select expires_at <= created_at + interval '7 days' as ok from hr_sessions where id = 'проверка-предела'`
    assert.ok(capped.ok, 'триггер обрезает срок при создании')
  })
})

test('x-hr-token: только чтение, только при HR_TOKEN от 16 символов, не пускает в разделы администратора', async () => {
  await withTestDb('hradm-sec-token', async (sql) => {
    const { app } = await setup(sql, loose)
    const get = (path: string, token: string) => app.request(path, { headers: { 'x-hr-token': token } })
    const before = process.env.HR_TOKEN
    try {
      delete process.env.HR_TOKEN
      assert.equal((await get('/api/hr/applications', '')).status, 401, 'без настройки токена — 401')
      process.env.HR_TOKEN = 'short-token'
      assert.equal((await get('/api/hr/applications', 'short-token')).status, 401, 'короткий токен не работает вовсе')

      const token = 'service-token-for-nightly-csv-export'
      process.env.HR_TOKEN = token
      assert.equal((await get('/api/hr/applications', token)).status, 200, 'верный токен читает список')
      assert.equal((await get('/api/hr/applications', token.replace(/.$/, 'x'))).status, 401, 'чужой токен той же длины — 401')
      assert.equal((await get('/api/hr/applications', `${token}x`)).status, 401, 'длиннее на символ — 401')
      assert.equal((await get('/api/hr/users', token)).status, 401, 'сотрудники — только администратору, токен не пускает')
      assert.equal((await get('/api/hr/accounts', token)).status, 401, 'учётные записи — тоже')
      assert.equal((await get('/api/hr/admin/access-log', token)).status, 401, 'журнал выгрузок — тоже')
      const anon = await get('/api/hr/me/account', token)
      assert.equal(anon.status, 200, 'страница входа спрашивает без ошибки')
      assert.equal(((await anon.json()) as { user: unknown }).user, null, 'служебный токен учётной записью не считается')

      const write = await app.request('/api/hr/applications', {
        method: 'POST',
        headers: { 'x-hr-token': token, 'x-hr-request': '1', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Токен', phone: '+79010000000', source: 'call' }),
      })
      assert.equal(write.status, 401, 'запись по токену — 401')
      const password = await app.request('/api/hr/me/password', {
        method: 'POST',
        headers: { 'x-hr-token': token, 'x-hr-request': '1', 'content-type': 'application/json' },
        body: JSON.stringify({ currentPassword: 'x', newPassword: 'новый-пароль-123' }),
      })
      assert.equal(password.status, 401, 'сменить пароль по токену нельзя')
    } finally {
      if (before === undefined) delete process.env.HR_TOKEN
      else process.env.HR_TOKEN = before
    }
  })
})

test('изменяющие запросы без x-hr-request — 403, с ним — проходят', async () => {
  await withTestDb('hradm-sec-header', async (sql) => {
    const { app, admin, login, cookieOf } = await setup(sql, loose)
    const cookie = cookieOf(await login(admin.email))
    const body = JSON.stringify({ enabled: true })
    const without = await app.request('/api/hr/accounts/queue', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body })
    assert.equal(without.status, 403)
    assert.equal(((await without.json()) as { error: string }).error, 'missing_hr_header')
    const withHeader = await app.request('/api/hr/accounts/queue', { method: 'PUT', headers: { cookie, 'content-type': 'application/json', 'x-hr-request': '1' }, body })
    assert.equal(withHeader.status, 200)
  })
})

test('медиа: обход путей и чужие расширения — 404, картинка из public — 200', async () => {
  await withTestDb('hradm-sec-media', async (sql) => {
    const { app } = await setup(sql, loose)
    const get = (path: string) => app.request(path)
    const ok = await get('/api/media/pub/photos/archive-1978-480.webp')
    assert.equal(ok.status, 200, 'фото сайта отдаётся')
    assert.equal(ok.headers.get('content-type'), 'image/webp')

    const attacks = [
      '/api/media/pub/../package.json',
      '/api/media/pub/..%2Fpackage.json',
      '/api/media/pub/%2e%2e/%2e%2e/etc/passwd',
      '/api/media/pub/%2e%2e%2f%2e%2e%2fserver%2fapp.ts',
      '/api/media/pub/photos/..%2F..%2F..%2Fserver%2F.env.png',
      '/api/media/pub/%2Fetc%2Fpasswd',
      '/api/media/pub/%2F..%2F..%2Fapple-touch-icon.png',
      '/api/media/gen/..%2F..%2Fpublic%2Fapple-touch-icon.png',
      '/api/media/pub/robots.txt',
      '/api/media/pub/favicon.svg%00.png',
      '/api/media/pub/%E0%A4%A',
      '/api/media/etc/passwd.png',
      '/api/media/pub/photos',
    ]
    for (const path of attacks) {
      const res = await get(path)
      assert.equal(res.status, 404, `${path} — 404, а пришло ${res.status}`)
    }
    // Картинка, лежащая вне корня, но с верным расширением: путь за корень не выходит
    assert.equal((await get('/api/media/gen/..%2F..%2Fpublic%2Fphotos%2Farchive-1978-480.webp')).status, 404, 'из gen в public через .. — 404')
  })
})
