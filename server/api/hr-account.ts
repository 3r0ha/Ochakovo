import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { getCookie } from 'hono/cookie'
import { AccountRepo } from '../auth/accounts'
import { hashPassword, passwordProblem, sessionId, verifyPassword } from '../auth/password'
import { bindAccounts, COOKIE, requireHr, SESSION_TTL } from '../auth/session'
import { createThrottle } from '../auth/throttle'
import { accessLog, type AccessAction } from '../db/accessLog'
import type { HrRole } from '../db/hr'
import type { ApiDeps } from './index'

// Учётные записи сотрудников, свой пароль, раздача заявок по очереди и «Состояние» для администратора.
//
// Сотрудник (в том числе с временным паролем — до смены ему доступно только это):
//   GET   /api/hr/me/account          — {user, mustChangePassword, session: {expiresAt, latestAt}}; без входа — {user: null}
//   POST  /api/hr/me/password         — {currentPassword, newPassword}: свой пароль; остальные входы закрываются
// Администратор:
//   GET   /api/hr/accounts            — {users: HrAccount[], queue: AssignQueue}
//   POST  /api/hr/accounts            — {email, name, role, password} → 201; пароль временный: при входе сменить
//   PATCH /api/hr/accounts/:id        — {name?, role?, disabled?, inQueue?}
//   POST  /api/hr/accounts/:id/password — {password}: сброс, входы закрыты, при входе сменить
//   PUT   /api/hr/accounts/queue      — {enabled}: раздавать новые заявки по очереди
//   GET   /api/hr/admin/state         — проваленные задачи, Диск, срок хранения, боты, последняя выгрузка
//   GET   /api/hr/admin/access-log    — журнал выгрузок: ?action=&format=&user=&limit=
// 422 — {error:'validation', errors, message}. Доступ — requireHr на каждом маршруте.

const roles: HrRole[] = ['hr', 'admin']
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Ошибка в полях: errors по полям и первая ошибка в message — для всплывающего сообщения */
const invalid = (c: Context, errors: Record<string, string>) => c.json({ error: 'validation', errors, message: Object.values(errors)[0] }, 422)

export function routes({ storage, repo }: ApiDeps): Hono {
  const app = new Hono()
  const sql = storage.sql
  const accounts = new AccountRepo(sql)
  // Все маршруты панели с этим repo теперь проверяют «пароль нужно сменить»
  bindAccounts(repo, accounts)

  const admin = requireHr(repo, ['admin'])
  const self = requireHr(repo, ['hr', 'admin'], { passwordChange: true })
  const json = bodyLimit({ maxSize: 16 * 1024 })
  // Подбор текущего пароля из открытой сессии: после пяти промахов — растущая задержка
  const ownPassword = createThrottle({ free: 5 })

  // ── Свой пароль ───────────────────────────────────────────────────────

  // Страница входа спрашивает это при открытии: без входа — 200 и user: null, а не 401 — в консоли браузера нет ошибки.
  // Служебный токен сюда не пускает: у него нет учётной записи
  app.get('/api/hr/me/account', async (c) => {
    const token = getCookie(c, COOKIE)
    const sid = token ? sessionId(token) : null
    const user = sid ? await repo.sessionUser(sid, SESSION_TTL) : null
    if (!user) return c.json({ user: null, mustChangePassword: false, session: null }, 200, { 'cache-control': 'no-store' })
    return c.json(
      { user, mustChangePassword: await accounts.mustChange(user.id), session: await accounts.sessionEnds(sid!) },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  app.post('/api/hr/me/password', self, json, async (c) => {
    const user = c.get('hrUser')
    if (user.id === 0) return c.json({ error: 'forbidden' }, 403)
    const body = (await c.req.json().catch(() => null)) as { currentPassword?: unknown; newPassword?: unknown } | null
    const current = typeof body?.currentPassword === 'string' ? body.currentPassword : ''
    const next = typeof body?.newPassword === 'string' ? body.newPassword : ''
    const key = `pw|${user.id}`
    const wait = ownPassword.wait(key)
    if (wait > 0) {
      c.header('Retry-After', String(wait))
      return c.json({ error: 'rate_limited', retryAfter: wait }, 429)
    }
    const stored = await accounts.passwordHash(user.id)
    if (!stored) return c.json({ error: 'unauthorized' }, 401)
    if (!current || !(await verifyPassword(current, stored))) {
      ownPassword.fail(key)
      return invalid(c, { currentPassword: 'Текущий пароль не подходит' })
    }
    ownPassword.ok(key)
    const problem = passwordProblem(next) ?? (next === current ? 'Новый пароль совпадает с прежним, придумай другой' : null)
    if (problem) return invalid(c, { newPassword: problem })
    if (next.trim().toLowerCase() === user.email.toLowerCase()) return invalid(c, { newPassword: 'Пароль не должен совпадать с почтой' })
    await accounts.changeOwnPassword(user.id, await hashPassword(next), c.get('hrSession'))
    return c.json({ ok: true, user: await accounts.get(user.id) })
  })

  // ── Сотрудники (только админ) ────────────────────────────────────────

  app.get('/api/hr/accounts', admin, async (c) => c.json({ users: await accounts.list(), queue: await accounts.queue() }))

  app.post('/api/hr/accounts', admin, json, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { email?: unknown; name?: unknown; role?: unknown; password?: unknown } | null
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
    const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : ''
    const role = roles.includes(body?.role as HrRole) ? (body!.role as HrRole) : 'hr'
    const password = typeof body?.password === 'string' ? body.password : ''
    const errors: Record<string, string> = {}
    if (!emailRe.test(email) || email.length > 254) errors.email = 'Нужна рабочая почта'
    if (name.length < 2) errors.name = 'Укажи имя'
    const problem = passwordProblem(password)
    if (problem) errors.password = problem
    if (Object.keys(errors).length) return invalid(c, errors)
    if (await accounts.byEmail(email)) return invalid(c, { email: 'Сотрудник с такой почтой уже есть' })
    return c.json(await accounts.create({ email, name, role, passwordHash: await hashPassword(password) }), 201)
  })

  // Раньше, чем /:id: иначе «queue» разберётся как номер сотрудника
  app.put('/api/hr/accounts/queue', admin, json, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { enabled?: unknown } | null
    if (typeof body?.enabled !== 'boolean') return c.json({ error: 'invalid' }, 400)
    return c.json(await accounts.setQueue(body.enabled, c.get('hrUser').name))
  })

  app.patch('/api/hr/accounts/:id', admin, json, async (c) => {
    const id = Number(c.req.param('id'))
    const me = c.get('hrUser')
    const body = (await c.req.json().catch(() => null)) as { name?: unknown; role?: unknown; disabled?: unknown; inQueue?: unknown } | null
    if (!Number.isInteger(id) || !body) return c.json({ error: 'invalid' }, 400)
    const patch: { name?: string; role?: HrRole; disabled?: boolean; inQueue?: boolean } = {}
    if (typeof body.name === 'string') {
      if (body.name.trim().length < 2) return invalid(c, { name: 'Укажи имя' })
      patch.name = body.name.trim().slice(0, 80)
    }
    if (roles.includes(body.role as HrRole)) patch.role = body.role as HrRole
    if (typeof body.disabled === 'boolean') patch.disabled = body.disabled
    if (typeof body.inQueue === 'boolean') patch.inQueue = body.inQueue
    // Нельзя остаться без администратора и нельзя выключить самого себя
    if (id === me.id && (patch.disabled || patch.role === 'hr')) return c.json({ error: 'self', message: 'Свою учётную запись выключить или понизить нельзя' }, 422)
    const target = await accounts.get(id)
    if (!target) return c.json({ error: 'not_found' }, 404)
    if (target.role === 'admin' && !target.disabled && (patch.disabled || patch.role === 'hr') && (await accounts.countActiveAdmins()) <= 1)
      return c.json({ error: 'last_admin', message: 'Должен остаться хотя бы один администратор' }, 422)
    return c.json(await accounts.update(id, patch))
  })

  app.post('/api/hr/accounts/:id/password', admin, json, async (c) => {
    const id = Number(c.req.param('id'))
    const body = (await c.req.json().catch(() => null)) as { password?: unknown } | null
    if (!Number.isInteger(id)) return c.json({ error: 'invalid' }, 400)
    const password = typeof body?.password === 'string' ? body.password : ''
    const problem = passwordProblem(password)
    if (problem) return invalid(c, { password: problem })
    // Свой пароль администратор меняет как все — через «Сменить пароль» с текущим паролем
    if (id === c.get('hrUser').id) return c.json({ error: 'self', message: 'Свой пароль меняй через «Сменить пароль»' }, 422)
    const updated = await accounts.resetPassword(id, await hashPassword(password))
    return updated ? c.json(updated) : c.json({ error: 'not_found' }, 404)
  })

  // ── Состояние и журнал выгрузок (только админ) ───────────────────────

  app.get('/api/hr/admin/state', admin, async (c) => {
    const failed = await sql<{ id: string; kind: string; attempts: number; last_error: string; done_at: Date | null; application_id: string | null }[]>`
      select id, kind, attempts, last_error, done_at, payload ->> 'applicationId' as application_id
      from jobs where status = 'failed' order by done_at desc nulls last, id desc limit 20`
    const [counts] = await sql<{ failed24h: number; failed: number; stuck: number }[]>`
      select count(*) filter (where status = 'failed' and done_at > now() - interval '24 hours')::int as failed24h,
             count(*) filter (where status = 'failed')::int as failed,
             count(*) filter (where status = 'pending' and run_at < now() - interval '10 minutes')::int as stuck
      from jobs where status in ('failed', 'pending')`
    const states = await sql<{ key: string; data: Record<string, unknown> }[]>`
      select key, data from integration_state where key in ('yandex_disk', 'retention')`
    const state = (key: string) => states.find((s) => s.key === key)?.data ?? {}
    const iso = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null)
    const disk = state('yandex_disk')
    const retention = state('retention')
    const bots = await sql<{ channel: string; at: Date | null }[]>`
      select channel, max(last_seen_at) as at from bot_users where channel in ('telegram', 'max') group by channel`
    const [lastExport] = await accessLog(sql, { limit: 1 })
    return c.json({
      jobs: {
        failed24h: counts?.failed24h ?? 0,
        failed: counts?.failed ?? 0,
        stuck: counts?.stuck ?? 0,
        list: failed.map((j) => ({
          id: Number(j.id),
          kind: j.kind,
          attempts: j.attempts,
          error: j.last_error.slice(0, 300),
          at: j.done_at?.toISOString() ?? null,
          applicationId: j.application_id && /^[A-Za-z0-9-]{4,32}$/.test(j.application_id) ? j.application_id : null,
        })),
      },
      disk: {
        lastOkAt: iso(disk.lastOkAt),
        lastAttemptAt: iso(disk.lastAttemptAt),
        lastRows: typeof disk.lastRows === 'number' ? disk.lastRows : null,
        error: typeof disk.lastError === 'string' && disk.lastError ? disk.lastError.slice(0, 300) : null,
      },
      retention: { lastRunAt: iso(retention.lastRunAt) },
      bots: Object.fromEntries(['telegram', 'max'].map((ch) => [ch, bots.find((b) => b.channel === ch)?.at?.toISOString() ?? null])),
      lastExport: lastExport ?? null,
    })
  })

  app.get('/api/hr/admin/access-log', admin, async (c) => {
    const action = c.req.query('action') as AccessAction | undefined
    const format = c.req.query('format') ?? ''
    const user = (c.req.query('user') ?? '').trim().toLowerCase()
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 200, 1), 500)
    const rows = (await accessLog(sql, { limit: 500 }))
      .filter((r) => (!action || r.action === action) && (!format || r.format === format) && (!user || r.userName.toLowerCase().includes(user)))
      .slice(0, limit)
    return c.json(rows)
  })

  return app
}
