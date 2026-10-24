import type { CheckinAnswer, CheckinReason, CheckinStep } from '@shared/adaptation'
import {
  emptyHrFields,
  type Application,
  type ApplicationInput,
  type ApplicationStatus,
  type DeclineReason,
  type HistoryEntry,
  type HrApplication,
  type TemplateKey,
} from '@shared/applications'
import type { HrFilter } from '@shared/hrFilter'
import type { ImportMapping, ImportRow } from '@shared/hrImport'
import { defaultWorkSettings, type WorkSettings } from '@shared/workdays'
import { demoApplications, makeApplicationId } from '@shared/demo'
import { useProfile } from '../store/profile'
import { reachGoal } from './analytics'
import { toBookingOffer, type BookingOffer } from '../components/candidate/booking'

export type { Application, ApplicationInput, ApplicationStatus, GameSnapshot, HistoryEntry, HrApplication } from '@shared/applications'

// Сайт и HR-панель работают через API сервера. Хранить заявки в браузере можно только
// в явном демо-режиме (VITE_DEMO_LOCAL=1, например для показа без бэкенда): иначе кандидат
// думал бы, что заявка отправлена, а HR её никогда не увидел бы.

const KEY = 'ochakovo.applications'
const VISITOR_KEY = 'ochakovo.visitor'

/** Демо без сервера: заявки и панель HR живут в localStorage этого браузера */
export const demoLocal = import.meta.env.VITE_DEMO_LOCAL === '1'

/** Сервер не отвечает или ответил не JSON (например, заглушка статичного хостинга) */
export class ApiUnavailable extends Error {}

/** Заявку не удалось отправить: сервер недоступен. Страница показывает повтор и запасные контакты */
export class ApplicationOffline extends Error {
  constructor() {
    super('offline')
  }
}

/** Нужен вход в HR-панель */
export class HrUnauthorized extends Error {}

export class ApiValidationError extends Error {
  constructor(
    public errors: Record<string, string>,
    message = 'validation',
    /** Коды ошибок по полям: required, invalid, у даты рождения — underage (моложе 18) и bad_birth_date */
    public codes: Record<string, string> = {},
  ) {
    super(message)
  }
}

/** Сервер ответил не-2xx (кроме 401 и 422): message — поле message или error ответа, status и тело — как пришли */
export class ApiError extends Error {
  constructor(
    public status: number,
    public data: Record<string, unknown>,
    public retryAfter: number | null,
  ) {
    super(typeof data.message === 'string' ? data.message : typeof data.error === 'string' ? data.error : `HTTP ${status}`)
  }
}

/**
 * Заявку не приняли, и это не ошибка в полях:
 * already_applied — заявка с этим телефоном или ником только что принята (409, без номера и токена той заявки);
 * rate_limited — много заявок с одного адреса, phone_limit — с одного телефона (429). retryAfter — секунды
 */
export class ApplyRejected extends Error {
  constructor(
    public reason: 'already_applied' | 'rate_limited' | 'phone_limit',
    public retryAfter = 0,
  ) {
    super(reason)
  }
}

/**
 * Запрос к API сервера: JSON в обе стороны, cookie сессии. hr: true — изменяющий запрос HR получает заголовок x-hr-request.
 * Ошибки: сервер недоступен или ответил не JSON — ApiUnavailable, 401 — HrUnauthorized, 422 — ApiValidationError,
 * остальные не-2xx — Error с полем message или error из ответа. Новые вызовы HR — в src/lib/hr/<пакет>.ts через request
 */
export async function request<T>(path: string, init: RequestInit & { hr?: boolean } = {}): Promise<T> {
  return api<T>(path, init)
}

async function api<T>(path: string, init: RequestInit & { hr?: boolean } = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body) headers.set('content-type', 'application/json')
  // Изменяющие запросы HR помечаем заголовком: чужой сайт поставить его не сможет
  if (init.hr && init.method && init.method !== 'GET') headers.set('x-hr-request', '1')
  let res: Response
  try {
    res = await fetch(path, { ...init, headers, credentials: 'same-origin' })
  } catch {
    throw new ApiUnavailable()
  }
  const isJson = res.headers.get('content-type')?.includes('application/json')
  if (!isJson || res.status >= 502) throw new ApiUnavailable()
  const data = await res.json()
  if (res.status === 401) throw new HrUnauthorized()
  if (res.status === 422) throw new ApiValidationError(data.errors ?? {}, data.message, data.codes ?? {})
  if (!res.ok) {
    const retry = Number(data?.retryAfter ?? res.headers.get('retry-after'))
    throw new ApiError(res.status, data && typeof data === 'object' ? data : {}, Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : null)
  }
  return data as T
}

// ── Анонимная воронка ──────────────────────────────────────────────────────

/** Случайный id браузера — без имени и контактов, только чтобы считать уникальных посетителей */
export function visitorId() {
  try {
    let id = localStorage.getItem(VISITOR_KEY)
    if (!id) {
      id = crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
      localStorage.setItem(VISITOR_KEY, id)
    }
    return id
  } catch {
    return 'no-storage-visitor'
  }
}

/** game_start — нажали «Играть», share — поделились (kind: game, money, invite) */
export type FunnelEvent = 'visit' | 'task_done' | 'apply_open' | 'application' | 'game_start' | 'share'

/**
 * Событие воронки: заход на сайт, пройденное задание, открытие заявки, отправка, начало игры, «поделиться».
 * Отправляется «маяком» — не задерживает переходы и не теряется при закрытии вкладки.
 * Ничего личного: случайный id браузера, тип события, номер задания или вид и метка источника.
 * Те же события — целями в Яндекс Метрику и пиксель VK, если счётчики включены и разрешены (src/lib/analytics.ts)
 */
export function trackEvent(type: FunnelEvent, extra: { task?: string; kind?: 'game' | 'money' | 'invite' } = {}) {
  if (demoLocal) return
  const source = useProfile.getState().source ?? undefined
  try {
    reachGoal(type, { ...extra, src: source })
  } catch {
    // Счётчики не должны ломать сайт
  }
  try {
    const body = JSON.stringify({ visitor: visitorId(), type, source, ...extra })
    if (navigator.sendBeacon?.('/api/events', new Blob([body], { type: 'text/plain' }))) return
    void fetch('/api/events', { method: 'POST', body, keepalive: true, headers: { 'content-type': 'text/plain' } }).catch(() => {})
  } catch {
    // Аналитика никогда не должна ломать сайт
  }
}

// ── Демо-режим: localStorage ───────────────────────────────────────────────

function readLocal(): Application[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as Application[]
  } catch {
    return []
  }
}

function writeLocal(list: Application[]) {
  localStorage.setItem(KEY, JSON.stringify(list))
}

// ── Кандидат ───────────────────────────────────────────────────────────────

/**
 * Отправить заявку.
 * - Успех → заявка с номером (`id`).
 * - Ошибки в полях → ApiValidationError с `errors` по полям (consent — нет согласия или текст обновился).
 * - 409 и 429 → ApplyRejected с причиной и сроком повтора.
 * - Сервер недоступен → ApplicationOffline: показать честное сообщение, «Отправить ещё раз»
 *   и запасные контакты (WhatsApp, почта). В демо-режиме заявка сохраняется в браузере
 *   с пометкой `savedLocally: true`.
 */
export async function submitApplication(input: ApplicationInput): Promise<Application> {
  const body = { ...input, channel: 'web' as const }
  if (demoLocal) {
    const { consent: _consent, website: _website, ...rest } = body
    const app: Application = { ...rest, id: makeApplicationId(), createdAt: new Date().toISOString(), savedLocally: true }
    writeLocal([app, ...readLocal()])
    return app
  }
  try {
    const app = await api<Application>('/api/applications', { method: 'POST', body: JSON.stringify(body) })
    trackEvent('application')
    return app
  } catch (e) {
    if (e instanceof ApiUnavailable) throw new ApplicationOffline()
    if (e instanceof ApiError && e.status === 409) throw new ApplyRejected('already_applied')
    if (e instanceof ApiError && e.status === 429) throw new ApplyRejected(e.data.error === 'phone_limit' ? 'phone_limit' : 'rate_limited', e.retryAfter ?? 60)
    throw e
  }
}

// ── Кандидат: права на данные, бот, самозапись ─────────────────────────────
// Все запросы «Моей заявки» идут с ключом этого браузера в заголовке x-status-token (тот же, что у статуса).
// Неизвестный номер, чужой или старый ключ, удалённая заявка — 404: ничего не раскрываем.

const candidateHeaders = (token: string) => ({ 'x-status-token': token })

/** Заявки по этому ключу нет: удалена, обезличена или ключ чужой */
export class ApplicationGone extends Error {
  constructor() {
    super('not_found')
  }
}

/** Запрос «Моей заявки»: 404 — ApplicationGone, остальные ошибки — как у request */
async function candidateRequest<T>(id: string, token: string, path: string, init: RequestInit = {}): Promise<T> {
  try {
    return await api<T>(`/api/applications/${encodeURIComponent(id)}${path}`, { ...init, headers: { ...candidateHeaders(token), ...(init.headers ?? {}) } })
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) throw new ApplicationGone()
    throw e
  }
}

/**
 * Отозвать согласие и удалить заявку (POST /api/applications/:id/withdraw, w2-platform): заявка обезличивается
 * с причиной «по запросу кандидата», задачи HR снимаются. После этого статус по ключу — 404.
 * Заявки уже нет (404) — считаем, что удалено: копию в браузере всё равно стираем
 */
export async function withdrawApplication(id: string, token: string): Promise<'withdrawn' | 'gone'> {
  try {
    await candidateRequest<unknown>(id, token, '/withdraw', { method: 'POST', body: '{}' })
    return 'withdrawn'
  } catch (e) {
    if (e instanceof ApplicationGone) return 'gone'
    throw e
  }
}

/** Ссылки на ботов с одноразовым кодом привязки заявки: ответ HR придёт в этот чат. Бот не работает — ссылки нет */
export type BotLinks = { telegram?: string | null; max?: string | null }

/** POST /api/applications/:id/bot-link (w2-platform): ссылка открывает бота с кодом app_<токен>, код живёт сутки */
export const requestBotLink = (id: string, token: string) => candidateRequest<BotLinks>(id, token, '/bot-link', { method: 'POST', body: '{}' })

// Самозапись на собеседование (w2-booking): HR предложил выбрать время — кандидат видит до 6 свободных часов.

export type { BookingOffer } from '../components/candidate/booking'

/** Свободные часы и запись: GET /api/applications/:id/booking. Предложения нет — null */
export async function bookingOffer(id: string, token: string): Promise<BookingOffer | null> {
  try {
    return toBookingOffer(await candidateRequest<unknown>(id, token, '/booking'))
  } catch {
    return null
  }
}

/** Время уже заняли (409) — показываем «Это время уже заняли, выбери другое» и свежий список */
export class SlotTaken extends Error {
  constructor() {
    super('taken')
  }
}

/** Записаться или перенести: POST /api/applications/:id/booking {startsAt} */
export async function bookHour(id: string, token: string, startsAt: string): Promise<void> {
  try {
    await candidateRequest<unknown>(id, token, '/booking', { method: 'POST', body: JSON.stringify({ startsAt }) })
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) throw new SlotTaken()
    throw e
  }
}

/** Отменить запись: DELETE /api/applications/:id/booking — место освобождается */
export const cancelBooking = (id: string, token: string) => candidateRequest<unknown>(id, token, '/booking', { method: 'DELETE' })

/** «Ни одно время не подходит — позвоните»: POST /api/applications/:id/booking/none — у HR появляется задача позвонить */
export const noHourFits = (id: string, token: string) => candidateRequest<unknown>(id, token, '/booking/none', { method: 'POST', body: '{}' })

// «Как дела на смене» (shared/adaptation.ts): вопрос новичку после первой смены, через неделю и через месяц.

export type CheckinView = {
  step: CheckinStep | null
  question: string
  last: { step: CheckinStep; answer: CheckinAnswer; reason: CheckinReason | '' } | null
  call: boolean
}

/** Вопрос, который ждёт ответа, и последний ответ: GET /api/applications/:id/checkin. Сервер недоступен — null */
export async function checkinView(id: string, token: string): Promise<CheckinView | null> {
  try {
    return await candidateRequest<CheckinView>(id, token, '/checkin')
  } catch {
    return null
  }
}

/** Ответить: POST /api/applications/:id/checkin. reply — что сказать в ответ («Тяжело» — факт по причине и звонок HR) */
export const answerCheckin = (id: string, token: string, step: CheckinStep, answer: CheckinAnswer, reason?: CheckinReason) =>
  candidateRequest<{ reply: string; view: CheckinView }>(id, token, '/checkin', { method: 'POST', body: JSON.stringify({ step, answer, ...(reason ? { reason } : {}) }) })

/** «Пусть HR позвонит»: POST /api/applications/:id/checkin/call — у HR появляется задача позвонить */
export const askHrCall = (id: string, token: string) => candidateRequest<{ reply: string; repeated: boolean }>(id, token, '/checkin/call', { method: 'POST', body: '{}' })

// ── HR: вход ───────────────────────────────────────────────────────────────

export type HrUser = { id: number; email: string; name: string; role: 'hr' | 'admin'; disabled: boolean; createdAt: string; lastLoginAt: string | null }

/** Подключённые боты — чтобы заранее сказать, дойдёт ли сообщение кандидату */
export let hrChannels: string[] = []
/** Провайдер SMS, если подключён: «SMS.ru», «SMSC.ru» */
export let hrSms: string | null = null
/** Рабочее время отдела и вместимость собеседований */
export let hrWork: WorkSettings = defaultWorkSettings
/** Демо-данные и «Очистить базу» доступны: не рабочая версия или демо-стенд */
export let hrDemoTools = false

export async function hrMe(): Promise<HrUser> {
  const r = await api<{ user: HrUser; channels?: string[]; sms?: string | null; settings?: WorkSettings; demoTools?: boolean }>('/api/hr/me')
  hrChannels = r.channels ?? []
  hrDemoTools = r.demoTools === true
  hrSms = r.sms ?? null
  if (r.settings) hrWork = r.settings
  return r.user
}

export async function saveWorkSettings(s: WorkSettings) {
  const next = await api<WorkSettings>('/api/hr/settings', { method: 'PUT', hr: true, body: JSON.stringify(s) })
  hrWork = next
  return next
}

export async function hrLogin(email: string, password: string): Promise<HrUser> {
  return (await api<{ user: HrUser }>('/api/hr/login', { method: 'POST', body: JSON.stringify({ email, password }) })).user
}

export async function hrLogout() {
  await api('/api/hr/logout', { method: 'POST' }).catch(() => {})
}

// ── HR: заявки ─────────────────────────────────────────────────────────────

/** Заявка из демо-режима без сервера — с пустыми полями HR */
const localHr = (a: Application): HrApplication => ({
  ...a,
  ...emptyHrFields(),
  status: a.status ?? 'new',
  reached: [a.status ?? 'new'],
})

/** Список заявок для панели. В демо-режиме — из этого браузера */
export async function listApplications(): Promise<HrApplication[]> {
  if (demoLocal) return readLocal().map(localHr)
  return api<HrApplication[]>('/api/hr/applications', { hr: true })
}

/** Кто позвал кандидата по ссылке «Позвать друга»; channel = null — код не нашёлся */
export type Referrer = { code: string; channel: string | null; name: string | null; username: string | null; applicationId: string | null }

export type ApplicationDetails = {
  application: HrApplication
  history: HistoryEntry[]
  invitedBy: Referrer | null
  /** Кого позвал сам кандидат — по его коду приглашения в боте */
  invited: { id: string; name: string; status: ApplicationStatus }[]
  /** Другие активные заявки с тем же телефоном */
  samePhone: HrApplication[]
  /** Склеенные с этой заявкой дубли */
  merged: HrApplication[]
}

export async function getApplication(id: string) {
  return api<ApplicationDetails>(`/api/hr/applications/${encodeURIComponent(id)}`, { hr: true })
}

export type NotifyPlan =
  | { notify: 'queued'; detail: string; sendAt: string }
  | { notify: 'call'; detail: string; text: string }
  | { notify: 'skipped'; detail: string }

export type SlotBody = { startsAt: string; address: string; bring: string }

export type ApplicationPatch = {
  status?: ApplicationStatus
  comment?: string
  declineReason?: DeclineReason
  slot?: SlotBody
  /** Перевести в «Собеседование» без даты: время договорятся по телефону */
  withoutSlot?: boolean
  /** Время собеседования вне рабочего — HR подтвердил */
  allowOffHours?: boolean
  /** Кандидату нет 18 по анкете, а HR всё равно приглашает — подтвердил */
  allowUnderage?: boolean
  notes?: string
  assigneeId?: number | null
  callbackAt?: string | null
  callbackNote?: string
  missedCall?: true
  /** Анкета; months — месяцы работы, по ним заявка попадает в план найма */
  profile?: Partial<Pick<Application, 'lastName' | 'middleName' | 'adult' | 'citizenship' | 'medBook' | 'shifts' | 'months'>>
}

/** Изменить заявку. historyId — по нему действие можно отменить, notify — что будет с сообщением кандидату */
export async function updateApplication(id: string, patch: ApplicationPatch) {
  return api<ApplicationDetails & { historyId: number | null; notify: NotifyPlan | null }>(`/api/hr/applications/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    hr: true,
    body: JSON.stringify(patch),
  })
}

export async function messageCandidate(id: string, text: string) {
  return api<{ application: HrApplication; historyId: number; notify: NotifyPlan }>(`/api/hr/applications/${encodeURIComponent(id)}/message`, {
    method: 'POST',
    hr: true,
    body: JSON.stringify({ text }),
  })
}

export async function undoActions(historyIds: number[]) {
  return api<{ results: { historyId: number; ok: boolean; error?: string; application?: HrApplication }[] }>('/api/hr/undo', {
    method: 'POST',
    hr: true,
    body: JSON.stringify({ historyIds }),
  })
}

/** «Разложить по норме»: своё время каждой заявке, адрес и «что взять» общие */
export type SpreadBody = { address: string; bring: string; slots: { id: string; startsAt: string }[] }

export type BulkBody =
  | { action: 'status'; status: ApplicationStatus; comment?: string; declineReason?: DeclineReason; slot?: SlotBody; withoutSlot?: boolean; allowOffHours?: boolean; allowUnderage?: boolean; spread?: SpreadBody }
  | { action: 'assign'; assigneeId: number | null }
  | { action: 'message'; text: string }

export type BulkResult = {
  done: { id: string; historyId: number | null; notify: NotifyPlan | null }[]
  failed: { id: string; error: string }[]
  calls: { id: string; name: string; phone: string; text: string }[]
  applications: HrApplication[]
}

export async function bulkAction(ids: string[], body: BulkBody) {
  return api<BulkResult>('/api/hr/bulk', { method: 'POST', hr: true, body: JSON.stringify({ ids, ...body }) })
}

export async function getDuplicates() {
  return api<{ phone: string; applications: HrApplication[] }[]>('/api/hr/duplicates', { hr: true })
}

export async function mergeApplication(duplicateId: string, into: string) {
  return api<{ application: HrApplication }>(`/api/hr/applications/${encodeURIComponent(duplicateId)}/merge`, {
    method: 'POST',
    hr: true,
    body: JSON.stringify({ into }),
  })
}

export async function unmergeApplication(id: string) {
  return api<{ ok: true }>(`/api/hr/applications/${encodeURIComponent(id)}/unmerge`, { method: 'POST', hr: true })
}

export type Staff = { id: number; name: string }

export async function getStaff() {
  return api<Staff[]>('/api/hr/staff', { hr: true })
}

// ── HR: виды и выгрузки ────────────────────────────────────────────────────

export type SavedView = { id: number; name: string; filter: HrFilter }

export async function getViews() {
  return api<SavedView[]>('/api/hr/views', { hr: true })
}

export async function createView(name: string, query: string) {
  return api<SavedView>('/api/hr/views', { method: 'POST', hr: true, body: JSON.stringify({ name, query }) })
}

export async function deleteView(id: number) {
  return api<{ ok: true }>(`/api/hr/views/${id}`, { method: 'DELETE', hr: true })
}

/** csv1c — CSV для 1С в кодировке Windows-1251, шаблон описан в docs/hr.md */
export type ExportFormat = 'xlsx' | 'csv' | 'json' | 'csv1c'

/** Выгрузить отфильтрованный список. В демо-режиме — CSV из браузера */
export async function exportApplications(format: ExportFormat, query: string, extra: string[] = []): Promise<Blob> {
  if (demoLocal) {
    const { applicationsCsv } = await import('@shared/hr')
    return new Blob([applicationsCsv(readLocal())], { type: 'text/csv;charset=utf-8' })
  }
  let res: Response
  try {
    res = await fetch('/api/hr/export', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-hr-request': '1' },
      body: JSON.stringify({ format, query, extra }),
    })
  } catch {
    throw new ApiUnavailable()
  }
  if (res.status === 401) throw new HrUnauthorized()
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { message?: string } | null
    throw new Error(data?.message ?? `HTTP ${res.status}`)
  }
  return res.blob()
}

export async function clearApplications() {
  if (demoLocal) return localStorage.removeItem(KEY)
  await api('/api/hr/applications', { method: 'DELETE', hr: true })
}

export async function seedDemoApplications(count = 24) {
  if (demoLocal) return writeLocal([...demoApplications(count), ...readLocal()])
  await api('/api/hr/applications/seed', { method: 'POST', hr: true, body: JSON.stringify({ count }) })
}

// ── HR: воронка, вопросы без ответа, уведомления, сотрудники, интеграции ──

export type FunnelRow = {
  source: string
  visitors: number
  tasks: number
  applyOpen: number
  applications: number
  interview: number
  hired: number
  started: number
}

export type FunnelReport = {
  from: string
  to: string
  rows: FunnelRow[]
  /** Имена пригласивших по кодам friend-<код> */
  referrers: Record<string, string>
  declines: { reason: string; label: string; count: number }[]
  firstResponseHours: number | null
}

export async function getFunnel(from?: string, to?: string) {
  const q = new URLSearchParams()
  if (from) q.set('from', from)
  if (to) q.set('to', to)
  return api<FunnelReport>(`/api/hr/funnel?${q}`, { hr: true })
}

export type KbGaps = {
  items: { id: number; createdAt: string; channel: string; topic: string; question: string }[]
  topics: { topic: string; count: number }[]
}

export async function getKbGaps() {
  return api<KbGaps>('/api/hr/kb-gaps', { hr: true })
}

export async function resolveKbGap(id: number) {
  return api<{ ok: true }>(`/api/hr/kb-gaps/${id}/resolve`, { method: 'POST', hr: true })
}

export type NotifyTemplate = { key: TemplateKey; text: string; enabled: boolean; updatedAt: string; preview?: string }

export async function getTemplates() {
  return api<NotifyTemplate[]>('/api/hr/templates', { hr: true })
}

export async function saveTemplate(key: TemplateKey, patch: { text?: string; enabled?: boolean }) {
  return api<NotifyTemplate>(`/api/hr/templates/${key}`, { method: 'PUT', hr: true, body: JSON.stringify(patch) })
}

export async function getUsers() {
  return api<HrUser[]>('/api/hr/users', { hr: true })
}

export async function createUser(u: { email: string; name: string; role: 'hr' | 'admin'; password: string }) {
  return api<HrUser>('/api/hr/users', { method: 'POST', hr: true, body: JSON.stringify(u) })
}

export async function updateUser(id: number, patch: { name?: string; role?: 'hr' | 'admin'; disabled?: boolean; password?: string }) {
  return api<HrUser>(`/api/hr/users/${id}`, { method: 'PATCH', hr: true, body: JSON.stringify(patch) })
}

export type DiskStatus = {
  configured: boolean
  canRefresh: boolean
  root: string
  intervalMinutes: number
  snapshots: boolean
  lastAttemptAt: string | null
  lastOkAt: string | null
  lastError: string | null
  lastRows: number | null
  lastBytes: number | null
  lastPath: string | null
}

export type SmsStatus = { configured: boolean; provider: string | null; sender: string | null }

export async function getIntegrations() {
  return api<{ yandexDisk: DiskStatus; sms: SmsStatus }>('/api/hr/integrations', { hr: true })
}

/** Выгрузить на Диск сейчас. Ошибка Диска приходит в result, а не исключением */
export async function syncYandexDisk() {
  const res = await fetch('/api/hr/integrations/yandex-disk/sync', { method: 'POST', credentials: 'same-origin', headers: { 'x-hr-request': '1' } })
  if (res.status === 401) throw new HrUnauthorized()
  return (await res.json()) as { result: { ok: true; path: string; rows: number; bytes: number } | { ok: false; error: string }; status: DiskStatus }
}

export async function checkYandexDisk() {
  const res = await fetch('/api/hr/integrations/yandex-disk/check', { method: 'POST', credentials: 'same-origin', headers: { 'x-hr-request': '1' } })
  if (res.status === 401) throw new HrUnauthorized()
  return (await res.json()) as { ok: true; total: number; used: number; user: string } | { ok: false; error: string }
}

export async function setDiskSnapshots(snapshots: boolean) {
  return api<DiskStatus>('/api/hr/integrations/yandex-disk', { method: 'PUT', hr: true, body: JSON.stringify({ snapshots }) })
}

// ── HR: кандидаты вручную и импорт ─────────────────────────────────────────

export type ManualCandidate = Partial<ApplicationInput> & { name: string; phone: string; source: string; createdAt?: string; force?: boolean }

/** Ошибка «такой телефон уже есть»: можно открыть найденную заявку или добавить всё равно */
export class DuplicatePhone extends Error {
  constructor(
    public existing: { id: string; name: string },
    message: string,
  ) {
    super(message)
  }
}

export async function createCandidate(input: ManualCandidate) {
  const res = await fetch('/api/hr/applications', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-hr-request': '1' },
    body: JSON.stringify(input),
  }).catch(() => {
    throw new ApiUnavailable()
  })
  const data = (await res.json().catch(() => ({}))) as { application?: HrApplication; existing?: { id: string; name: string }; errors?: Record<string, string>; codes?: Record<string, string>; message?: string }
  if (res.status === 401) throw new HrUnauthorized()
  if (res.status === 409 && data.existing) throw new DuplicatePhone(data.existing, data.message ?? 'Такой телефон уже есть')
  if (res.status === 422) throw new ApiValidationError(data.errors ?? {}, data.message, data.codes ?? {})
  if (!res.ok || !data.application) throw new Error(data.message ?? `HTTP ${res.status}`)
  return data.application
}

export type ParsedTable = { headers: string[]; rows: string[][]; lines: number[]; skipped: { line: number; reason: string }[]; mapping: ImportMapping }

export async function parseImportFile(file: File): Promise<ParsedTable> {
  const res = await fetch('/api/hr/import/parse', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'x-hr-request': '1', 'x-file-name': encodeURIComponent(file.name), 'content-type': 'application/octet-stream' },
    body: file,
  }).catch(() => {
    throw new ApiUnavailable()
  })
  const data = (await res.json().catch(() => ({}))) as ParsedTable & { message?: string }
  if (res.status === 401) throw new HrUnauthorized()
  if (!res.ok) throw new Error(data.message ?? `HTTP ${res.status}`)
  return data
}

export type ImportReport = {
  created: { line: number; id: string; name: string }[]
  duplicates: { line: number; name: string; existingId: string; by: string }[]
  invalid: { line: number; problems: string[] }[]
  skipped: { line: number; reason: string }[]
  warnings: { line: number; warnings: string[] }[]
}

/** Все строки файла — и с ошибками: сервер перечислит их в отчёте с номерами строк файла */
export async function commitImport(
  rows: ImportRow[],
  source: string,
  skipDuplicates: boolean,
  extra: { vacancyMap?: Record<string, string>; skipped?: { line: number; reason: string }[]; defaultMonths?: number[] | 'vacancy' } = {},
) {
  return api<ImportReport>('/api/hr/import/commit', { method: 'POST', hr: true, body: JSON.stringify({ rows, source, skipDuplicates, ...extra }) })
}

export async function getVacancyMap() {
  return api<Record<string, string>>('/api/hr/import/vacancy-map', { hr: true })
}

// ── HR: срок хранения и удаление по запросу ───────────────────────────────

export type RetentionEntry = { id: number; createdAt: string; kind: 'auto' | 'request'; scope: string; count: number; userName: string; reason: string; applicationId: string | null }

export type ErasePreview = {
  applications: { id: string; name: string; status: ApplicationStatus; createdAt: string; why: string }[]
  botUsers: { channel: string; userId: string; label: string }[]
}

/** Что сотрёт «Удалить по запросу»: заявки того же человека и данные бота */
export async function getErasePreview(id: string) {
  return api<ErasePreview>(`/api/hr/applications/${encodeURIComponent(id)}/erase`, { hr: true })
}

export async function eraseApplication(id: string, reason: string, ids?: string[]) {
  return api<{ erased: number; applications: number; botUsers: number; sessions: number }>(`/api/hr/applications/${encodeURIComponent(id)}/erase`, {
    method: 'POST',
    hr: true,
    body: JSON.stringify({ reason, ...(ids ? { ids } : {}) }),
  })
}

export async function getRetention() {
  return api<{ months: number; lastRunAt: string | null; log: RetentionEntry[] }>('/api/hr/retention', { hr: true })
}

export async function runRetentionNow() {
  return api<{ applications: number; botUsers: number; sessions: number; kbGaps: number } | { busy: true }>('/api/hr/retention/run', { method: 'POST', hr: true })
}

// ── HR: hh.ru ──────────────────────────────────────────────────────────────

export type HhVacancyInfo = { id: string; title: string; payload: Record<string, unknown>; problems: string[]; warnings: string[] }
export type HhPublished = Record<string, { hhId: string; kind: 'draft' | 'vacancy'; at: string; archived?: boolean }>

export async function getHh() {
  return api<{ connected: boolean; employerId: string | null; userAgent: string | null; addressId: string | null; published: HhPublished; vacancies: HhVacancyInfo[] }>('/api/hr/hh', { hr: true })
}

export async function checkHh() {
  const res = await fetch('/api/hr/hh/check', { method: 'POST', credentials: 'same-origin', headers: { 'x-hr-request': '1' } })
  return (await res.json()) as { ok: true; name: string; employer: { id: string; name: string } | null } | { ok: false; error: string }
}

export type HhAction = 'draft' | 'publish' | 'update' | 'archive'

/** dryRun по умолчанию: ничего не отправляет на hh.ru, только показывает запрос и что поправить */
export async function hhVacancyAction(id: string, action: HhAction, dryRun = true) {
  const res = await fetch(`/api/hr/hh/vacancies/${encodeURIComponent(id)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-hr-request': '1' },
    body: JSON.stringify({ action, dryRun }),
  })
  const data = (await res.json().catch(() => ({}))) as { message?: string } & Record<string, unknown>
  if (res.status === 401) throw new HrUnauthorized()
  if (!res.ok) throw new Error(data.message ?? `HTTP ${res.status}`)
  return data
}

export async function hhResponses(id: string) {
  return api<{ rows: ImportRow[] }>(`/api/hr/hh/vacancies/${encodeURIComponent(id)}/responses`, { method: 'POST', hr: true })
}

// ── HR: план найма и список на проходную ───────────────────────────────────

export type PlanCellInfo = { vacancyId: string; month: number; target: number; hired: number; started: number }

export async function getPlan(season?: number) {
  return api<{ season: number; cells: PlanCellInfo[] }>(`/api/hr/plan${season ? `?season=${season}` : ''}`, { hr: true })
}

export async function savePlan(season: number, entries: { vacancyId: string; month: number; target: number }[]) {
  return api<{ season: number; cells: PlanCellInfo[] }>('/api/hr/plan', { method: 'PUT', hr: true, body: JSON.stringify({ season, entries }) })
}

export type PassItem = { id: string; time: string; fullName: string; vacancy: string }

export async function getPass(date: string) {
  return api<{ date: string; items: PassItem[] }>(`/api/hr/pass?date=${encodeURIComponent(date)}`, { hr: true })
}

