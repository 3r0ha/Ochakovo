import type { VacancyEditable, VacancyFormat } from '@shared/content/vacancies'
import { ApiError, ApiUnavailable, request, type HrUser } from '../api'

// Вызовы API администратора и своего пароля (пакет hr-admin): вход с задержкой, смена пароля, сотрудники,
// раздача заявок по очереди, правки вакансий, состояние сервера и журнал выгрузок.
// Сервер — server/api/hr-account.ts и server/api/hr-content.ts

// ── Вход и свой пароль ─────────────────────────────────────────────────

/** Итог входа: вошли; почта или пароль не подходят (retryAfter — сколько ждать перед следующей попыткой); слишком часто */
export type LoginResult =
  | { ok: true; user: HrUser }
  | { ok: false; reason: 'invalid'; retryAfter: number }
  | { ok: false; reason: 'rate_limited'; retryAfter: number }

/** Вход в панель. Сервер недоступен — ApiUnavailable */
export async function login(email: string, password: string): Promise<LoginResult> {
  let res: Response
  try {
    res = await fetch('/api/hr/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }), credentials: 'same-origin' })
  } catch {
    throw new ApiUnavailable()
  }
  if (!res.headers.get('content-type')?.includes('application/json') || res.status >= 502) throw new ApiUnavailable()
  const data = (await res.json().catch(() => ({}))) as { user?: HrUser; retryAfter?: number }
  const retry = Number(data.retryAfter ?? res.headers.get('retry-after'))
  const retryAfter = Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : 0
  if (res.ok && data.user) return { ok: true, user: data.user }
  if (res.status === 429) return { ok: false, reason: 'rate_limited', retryAfter: retryAfter || 60 }
  if (res.status === 401) return { ok: false, reason: 'invalid', retryAfter }
  throw new ApiError(res.status, data as Record<string, unknown>, retryAfter || null)
}

export type MyAccount = {
  /** null — не вошли */
  user: HrUser | null
  /** Пароль задал администратор: прежде чем работать, нужно задать свой */
  mustChangePassword: boolean
  /** Когда закончится вход: продлевается при работе, но не позже latestAt (7 дней от входа) */
  session: { expiresAt: string; latestAt: string } | null
}

/** Кто вошёл и нужно ли сменить пароль. Не вошли — user: null (без ответа 401: страница входа спрашивает это при открытии) */
export const myAccount = () => request<MyAccount>('/api/hr/me/account')

/** Свой пароль: текущий и новый. Ошибки в полях — ApiValidationError с errors.currentPassword или errors.newPassword */
export const changeMyPassword = (currentPassword: string, newPassword: string) =>
  request<{ ok: true; user: HrAccount }>('/api/hr/me/password', { method: 'POST', hr: true, body: JSON.stringify({ currentPassword, newPassword }) })

// ── Сотрудники и очередь ───────────────────────────────────────────────

export type HrAccount = HrUser & { mustChangePassword: boolean; inQueue: boolean; passwordChangedAt: string | null }

export type AssignQueue = {
  enabled: boolean
  next: { id: number; name: string } | null
  members: { id: number; name: string }[]
  assigned: number
  updatedAt: string
  updatedBy: string
}

export const listAccounts = () => request<{ users: HrAccount[]; queue: AssignQueue }>('/api/hr/accounts')

export const createAccount = (u: { email: string; name: string; role: 'hr' | 'admin'; password: string }) =>
  request<HrAccount>('/api/hr/accounts', { method: 'POST', hr: true, body: JSON.stringify(u) })

export const updateAccount = (id: number, patch: { name?: string; role?: 'hr' | 'admin'; disabled?: boolean; inQueue?: boolean }) =>
  request<HrAccount>(`/api/hr/accounts/${id}`, { method: 'PATCH', hr: true, body: JSON.stringify(patch) })

export const resetAccountPassword = (id: number, password: string) =>
  request<HrAccount>(`/api/hr/accounts/${id}/password`, { method: 'POST', hr: true, body: JSON.stringify({ password }) })

export const setAssignQueue = (enabled: boolean) => request<AssignQueue>('/api/hr/accounts/queue', { method: 'PUT', hr: true, body: JSON.stringify({ enabled }) })

/** Буквы и цифры без похожих друг на друга (0 и О, 1 и l): пароль диктуют голосом или переписывают с листка */
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'

/** Временный пароль: три группы по четыре знака через дефис, 60 бит случайности */
export function temporaryPassword(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length])
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12)].map((g) => g.join('')).join('-')
}

/** Пароль — не короче 10 символов: то же правило, что на сервере (passwordProblem) */
export const passwordHint = (p: string) => (p.length < 10 ? 'Пароль должен быть не короче 10 символов' : p.length > 200 ? 'Слишком длинный пароль' : null)

// ── Состояние и журнал выгрузок ────────────────────────────────────────

export type AdminState = {
  jobs: {
    failed24h: number
    failed: number
    stuck: number
    list: { id: number; kind: string; attempts: number; error: string; at: string | null; applicationId: string | null }[]
  }
  disk: { lastOkAt: string | null; lastAttemptAt: string | null; lastRows: number | null; error: string | null }
  retention: { lastRunAt: string | null }
  bots: Record<'telegram' | 'max', string | null>
  lastExport: AccessRow | null
}

export type AccessRow = {
  id: number
  createdAt: string
  userName: string
  role: string
  action: 'export' | 'disk' | 'token_read'
  format: string
  rows: number
  filter: string
  applications: number
}

export const adminState = () => request<AdminState>('/api/hr/admin/state')

export function accessLog(filter: { action?: string; format?: string; user?: string } = {}) {
  const q = new URLSearchParams(Object.entries(filter).filter(([, v]) => v) as [string, string][]).toString()
  return request<AccessRow[]>(`/api/hr/admin/access-log${q ? `?${q}` : ''}`)
}

// ── Вакансии: правки без программиста ──────────────────────────────────

export type { VacancyEditable }

export type AdminVacancy = {
  id: string
  title: string
  format: VacancyFormat
  unit: string | null
  department: string
  schedule: string
  payNote: string | null
  /** Как в данных компании */
  builtin: VacancyEditable
  /** Как сейчас на сайте, в боте и у Квасыча */
  current: VacancyEditable
  overridden: boolean
  updatedAt: string | null
  updatedBy: string | null
  /** Откуда данные; team — что предложила команда проекта: стоит проверить */
  basis: { source: string; team?: string } | null
}

export type VacancyHistoryEntry = {
  id: number
  vacancyId: string
  vacancyTitle: string
  createdAt: string
  userName: string
  before: VacancyEditable
  after: VacancyEditable
}

export const adminVacancies = () => request<{ vacancies: AdminVacancy[]; history: VacancyHistoryEntry[] }>('/api/hr/content/vacancies')

export const saveVacancy = (id: string, next: VacancyEditable) =>
  request<{ changed: boolean; current: VacancyEditable; history: VacancyHistoryEntry[] }>(`/api/hr/content/vacancies/${encodeURIComponent(id)}`, {
    method: 'PUT',
    hr: true,
    body: JSON.stringify(next),
  })

export const resetVacancy = (id: string) =>
  request<{ current: VacancyEditable; history: VacancyHistoryEntry[] }>(`/api/hr/content/vacancies/${encodeURIComponent(id)}`, { method: 'DELETE', hr: true })
