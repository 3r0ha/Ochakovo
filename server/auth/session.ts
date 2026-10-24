import { timingSafeEqual } from 'node:crypto'
import type { Context, MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { HrRepo, HrRole, HrUser } from '../db/hr'
import type { AccountRepo } from './accounts'
import { newSessionToken, sessionId } from './password'

// Вход в HR-панель: сессия в cookie (только для /api, недоступна скриптам страницы),
// в базе — отпечаток токена. Изменяющие запросы дополнительно требуют заголовок x-hr-request:
// чужой сайт не может его поставить без CORS, так что подделать запрос от имени HR нельзя.

export const COOKIE = 'hr_session'
/** Сессия живёт 12 часов и продлевается при работе в панели */
export const SESSION_TTL = 12 * 60 * 60 * 1000
/**
 * Но не дольше 7 дней от входа, даже если в панели работают каждый день: потом — вход заново.
 * Предел держит база (триггер hr_sessions_cap, миграция 015): продление не уходит дальше created_at + 7 дней
 */
export const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000

declare module 'hono' {
  interface ContextVariableMap {
    hrUser: HrUser
    /** Отпечаток токена текущей сессии; для служебного токена — null */
    hrSession: string | null
  }
}

const secure = (c: Context) => process.env.NODE_ENV === 'production' || new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https'

export async function startSession(c: Context, repo: HrRepo, user: HrUser) {
  const { token, id } = newSessionToken()
  await repo.createSession(id, user.id, SESSION_TTL)
  setCookie(c, COOKIE, token, {
    path: '/api',
    httpOnly: true,
    sameSite: 'Lax',
    secure: secure(c),
    maxAge: Math.floor(SESSION_TTL / 1000),
  })
}

export async function endSession(c: Context, repo: HrRepo) {
  const token = getCookie(c, COOKIE)
  if (token) await repo.deleteSession(sessionId(token))
  deleteCookie(c, COOKIE, { path: '/api', secure: secure(c) })
}

/**
 * Служебный токен для скриптов (например, ночная выгрузка CSV): заголовок x-hr-token.
 * Работает, только если HR_TOKEN задан явно и не короче 16 символов. Права — только чтение.
 */
function serviceToken(c: Context): boolean {
  const configured = process.env.HR_TOKEN ?? ''
  if (configured.length < 16) return false
  const given = Buffer.from(c.req.header('x-hr-token') ?? '')
  const expected = Buffer.from(configured)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

const serviceUser: HrUser = { id: 0, email: 'service', name: 'Служебный токен', role: 'hr', disabled: false, createdAt: '', lastLoginAt: null }

/**
 * Учётные записи для проверки «пароль нужно сменить». Подключает server/api/hr-account.ts при старте API
 * для того же HrRepo, что получают все маршруты панели. Без привязки (маршруты собраны вручную, без createApi)
 * обязательная смена пароля не проверяется — как до неё
 */
const accountsByRepo = new WeakMap<HrRepo, AccountRepo>()

export function bindAccounts(repo: HrRepo, accounts: AccountRepo) {
  accountsByRepo.set(repo, accounts)
}

type RequireOptions = {
  /** Пускать сотрудника, которому нужно сменить пароль: только «кто я» и сама смена пароля */
  passwordChange?: boolean
}

/**
 * Пускает сотрудника HR (или админа, если roles = ['admin']); служебный токен — только на чтение.
 * Сотрудник с временным паролем от администратора получает 401 password_change_required на всё, кроме смены пароля:
 * панель отправляет его на страницу входа, а там — к форме нового пароля
 */
export function requireHr(repo: HrRepo, roles: HrRole[] = ['hr', 'admin'], opts: RequireOptions = {}): MiddlewareHandler {
  return async (c, next) => {
    const token = getCookie(c, COOKIE)
    const sid = token ? sessionId(token) : null
    const user = sid ? await repo.sessionUser(sid, SESSION_TTL) : null
    const readOnly = c.req.method === 'GET' || c.req.method === 'HEAD'

    if (!user) {
      if (readOnly && roles.includes('hr') && !opts.passwordChange && serviceToken(c)) {
        c.set('hrUser', serviceUser)
        c.set('hrSession', null)
        return next()
      }
      return c.json({ error: 'unauthorized' }, 401)
    }
    if (!opts.passwordChange && (await accountsByRepo.get(repo)?.mustChange(user.id))) return c.json({ error: 'password_change_required' }, 401)
    if (!roles.includes(user.role)) return c.json({ error: 'forbidden' }, 403)
    if (!readOnly && c.req.header('x-hr-request') !== '1') return c.json({ error: 'missing_hr_header' }, 403)
    c.set('hrUser', user)
    c.set('hrSession', sid)
    await next()
  }
}
