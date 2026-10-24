import { createHash } from 'node:crypto'
import { Hono, type Context, type Next } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { isCheckinAnswer, isCheckinReason, isCheckinStep } from '@shared/adaptation'
import {
  checkApplication,
  isManualConsent,
  isStatus,
  isTemplateKey,
  type ApplicationInput,
  type ApplicationStatus,
  type HrApplication,
  type TemplateKey,
} from '@shared/applications'
import { birthDateProblem, isAdultByBirthDate, normalizeBirthDate } from '@shared/birthDate'
import { applications1C, applicationsCsv, applicationsJson, manualSources, pickColumns } from '@shared/hr'
import { toHhVacancy } from '@shared/hhVacancy'
import { planProgress, seasonOf } from '@shared/hrPlan'
// План, сопоставление импорта, hh.ru и пропуска — по всем вакансиям, включая временно закрытые в панели
import { allVacancies, vacancies } from '@shared/content/vacancies'
import { dedupeKeys, guessMapping, IMPORT_MAX_BYTES, IMPORT_MAX_ROWS, parseResumeUrl, vacancyMonths } from '@shared/hrImport'
import { parsePhone } from '@shared/phone'
import { slotWarning, workSettingsProblem, type WorkSettings } from '@shared/workdays'
import { applyFilter, filterToParams, paramsToFilter, sortApps, sourceKey, stageCounts, type HrFilter } from '@shared/hrFilter'
import { adaptationDeps, answerCheckin } from '../adaptation'
import { hashPassword, passwordProblem, verifyPassword } from '../auth/password'
import { endSession, requireHr, startSession } from '../auth/session'
import type { Registry } from '../channels/registry'
import type { PostgresStorage } from '../db'
import { clearAll, seedDemo } from '../db/demo'
import { logAccess } from '../db/accessLog'
import { sourceNames } from '../db/sources'
import type { HrRepo, HrRole } from '../db/hr'
import type { OnboardingPatch, SeasonPatch, SlotInput } from '../db/workflow'
import { encodeCp1251 } from '../export/cp1251'
import { buildPassList, buildWorkbook, type FunnelSheet } from '../export/xlsx'
import { ImportError, parseTable } from '../import/table'
import { eraseOnRequest, erasePreview, retentionLog, retentionMonths, runRetention } from '../retention'
import { providerName } from '../sms'
import { bulk, changeStatus, markAttendance, parseSlot, reschedule, sendMessage, setOnboarding, undo, type BulkAction } from '../hr/actions'
import { diskClient, diskConfigured, diskStatus, DISK_KEY, syncNow, type DiskState } from '../integrations/sync'
import { hhFromEnv, HhClient, HhError } from '../integrations/hh'
import { DiskError } from '../integrations/yandexDisk'
import { hrDeps } from '../jobs/scheduler'
import { placeholders, renderTemplate } from '../notify'

// HR-панель: вход, заявки (статусы, собеседования, ответственные, задачи, дубли), массовые действия,
// выгрузки, воронка, тексты уведомлений, сотрудники и интеграции.
// Все маршруты, кроме входа, — только для сотрудников (сессия) или для служебного токена на чтение.

/** Хеш для сравнения, когда сотрудника с таким e-mail нет: время ответа не выдаёт, есть ли почта в базе */
let dummyHash: Promise<string> | null = null

const roles: HrRole[] = ['hr', 'admin']
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** «ГГГГ-ММ-ДД» → дата начала дня по Москве */
function day(value: string | undefined, fallback: Date) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return fallback
  const d = new Date(`${value}T00:00:00+03:00`)
  return Number.isNaN(d.getTime()) ? fallback : d
}

const formats = {
  xlsx: { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' },
  csv: { type: 'text/csv; charset=utf-8', ext: 'csv' },
  csv1c: { type: 'text/csv; charset=windows-1251', ext: 'csv' },
  json: { type: 'application/json; charset=utf-8', ext: 'json' },
} as const
type Format = keyof typeof formats

/** Имя файла по-русски: латинский запасной вариант и UTF-8 для современных браузеров */
const disposition = (name: string, ext: string) =>
  `attachment; filename="ochakovo-zayavki.${ext}"; filename*=UTF-8''${encodeURIComponent(`${name}.${ext}`)}`

export function hrRoutes({ storage, repo, bots, env = process.env }: { storage: PostgresStorage; repo: HrRepo; bots: Registry; env?: NodeJS.ProcessEnv }) {
  const app = new Hono()
  const hr = requireHr(repo)
  const admin = requireHr(repo, ['admin'])
  const json = bodyLimit({ maxSize: 16 * 1024 })
  const bigJson = bodyLimit({ maxSize: 256 * 1024 })
  const deps = hrDeps(storage.sql, bots)
  /** Название метки для истории: из реестра «Источники», без реестра — встроенный список ручных источников */
  const sourceLabel = async (code: string) =>
    (await sourceNames(storage.sql).catch(() => ({}) as Record<string, string>))[code] ?? manualSources.find((m) => m.id === code)?.label ?? code
  const { workflow } = deps
  // Демо-данные и «Очистить базу» — для показа и обучения. В рабочей версии их нет: выдуманные заявки
  // смешались бы с настоящими, а очистка стёрла бы всё в обход журнала удалений. Демо-стенду — HR_DEMO_TOOLS=1
  const demoTools = env.NODE_ENV !== 'production' || env.HR_DEMO_TOOLS === '1'
  const demoOnly = async (c: Context, next: Next) =>
    demoTools ? next() : c.json({ error: 'demo_disabled', message: 'В рабочей версии демо-данные и очистка базы отключены' }, 403)

  // ── Вход ──────────────────────────────────────────────────────────────

  app.post('/api/hr/login', json, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { email?: unknown; password?: unknown } | null
    const email = typeof body?.email === 'string' ? body.email.trim() : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    if (!email || !password) return c.json({ error: 'invalid_credentials' }, 401)

    const found = await repo.userByEmail(email)
    dummyHash ??= hashPassword('нет такого сотрудника')
    const ok = await verifyPassword(password, found?.passwordHash ?? (await dummyHash))
    if (!found || !ok || found.user.disabled) return c.json({ error: 'invalid_credentials' }, 401)

    await startSession(c, repo, found.user)
    await repo.touchLogin(found.user.id)
    return c.json({ user: found.user })
  })

  app.post('/api/hr/logout', async (c) => {
    await endSession(c, repo)
    return c.json({ ok: true })
  })

  // channels — какие боты сейчас подключены: панель честно говорит, дойдёт ли сообщение
  // channels — какие боты подключены, sms — провайдер SMS: панель заранее говорит, дойдёт ли сообщение
  app.get('/api/hr/me', hr, async (c) =>
    c.json({ user: c.get('hrUser'), channels: bots.active(), sms: deps.sms ? providerName(deps.sms.provider) : null, settings: await repo.workSettings(), demoTools }),
  )

  app.get('/api/hr/settings', hr, async (c) => c.json(await repo.workSettings()))

  app.put('/api/hr/settings', admin, json, async (c) => {
    const body = (await c.req.json().catch(() => null)) as Partial<WorkSettings> | null
    const next = { ...(await repo.workSettings()), ...(body ?? {}) }
    const problem = workSettingsProblem(next)
    if (problem) return c.json({ error: 'validation', message: problem }, 422)
    return c.json(await repo.saveWorkSettings(next))
  })

  app.get('/api/hr/staff', hr, async (c) => c.json(await repo.staff()))

  // ── Заявки ────────────────────────────────────────────────────────────

  /** Шаг к выходу на работу: приглашение, оформление, первая смена — если кандидат ещё не на этом пути */
  const forward: ApplicationStatus[] = ['interview', 'hired', 'started']
  const advancing = (to: ApplicationStatus, from: ApplicationStatus) => forward.includes(to) && !forward.includes(from)

  /** JSON с ETag по хешу тела: на If-None-Match с тем же хешем — 304 без тела. Так опрос без изменений весит заголовки */
  const versioned = (c: Context, data: unknown) => {
    const body = JSON.stringify(data)
    const tag = `"${createHash('sha1').update(body).digest('base64url')}"`
    const headers = { etag: tag, 'cache-control': 'private, no-cache', vary: 'Cookie, X-HR-Token' }
    const seen = (c.req.header('if-none-match') ?? '').split(',').map((t) => t.trim().replace(/^W\//, ''))
    if (seen.includes(tag)) return c.body(null, 304, headers)
    return c.body(body, 200, { ...headers, 'content-type': 'application/json; charset=utf-8' })
  }

  /** Заявки без обезличенных: их личных данных нет, менять их нельзя. Для скриптов со служебным токеном и интеграций */
  app.get('/api/hr/applications', hr, async (c) => versioned(c, await workflow.active()))

  /**
   * Список для панели: заявки без обезличенных и сжатые этапы обезличенных для плиток.
   * Панель опрашивает его раз в 30 секунд с If-None-Match: если ничего не менялось — 304 без тела
   */
  app.get('/api/hr/desk', hr, async (c) => versioned(c, await workflow.desk()))

  const details = async (id: string) => {
    const application = await workflow.get(id)
    if (!application) return null
    const [history, referrals, samePhone, merged] = await Promise.all([
      workflow.history(id),
      repo.referrals(application),
      workflow.samePhone(application),
      workflow.merged(application),
    ])
    return { application, history, ...referrals, samePhone, merged }
  }

  app.get('/api/hr/applications/:id', hr, async (c) => {
    const d = await details(c.req.param('id'))
    return d ? c.json(d) : c.json({ error: 'not_found' }, 404)
  })

  /**
   * PATCH {status?, comment?, declineReason?, slot?, notes?, assigneeId?, callbackAt?, callbackNote?, missedCall?, profile?}
   * Смена статуса пишет историю, ставит сообщение кандидату в очередь (его можно отменить) и напоминание накануне собеседования.
   */
  app.patch('/api/hr/applications/:id', hr, json, async (c) => {
    const id = c.req.param('id')
    const user = c.get('hrUser')
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return c.json({ error: 'invalid-json' }, 400)
    const current = await workflow.get(id)
    if (!current) return c.json({ error: 'not_found' }, 404)
    if (current.anonymizedAt) return c.json({ error: 'erased', message: 'Личные данные по этой заявке удалены — менять её нельзя' }, 409)

    const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 2000) : ''
    if (body.status !== undefined && !isStatus(body.status)) return c.json({ error: 'invalid_status' }, 400)
    const slot = body.slot === undefined || body.slot === null ? undefined : parseSlot(body.slot)
    if (typeof slot === 'string') return c.json({ error: 'validation', errors: { slot }, message: slot }, 422)
    // Выходной, праздник или вне рабочего дня — только с подтверждением
    const off = slot ? slotWarning(slot.startsAt, await repo.workSettings()) : null
    if (off && body.allowOffHours !== true) return c.json({ error: 'off_hours', errors: { slot: off }, message: `${off}. Подтверди, если так и задумано` }, 422)

    const profile = body.profile && typeof body.profile === 'object' ? (body.profile as Record<string, unknown>) : null
    // Дата рождения с опечаткой не сохраняется молча: 422 с кодом, как у формы на сайте. Моложе 18 — сохраняем, HR видит возраст
    const typedBirth = profile && typeof profile.birthDate === 'string' ? profile.birthDate.trim() : ''
    const birthProblem = typedBirth ? birthDateProblem(typedBirth) : null
    if (birthProblem?.code === 'bad_birth_date')
      return c.json({ error: 'validation', errors: { birthDate: birthProblem.message }, codes: { birthDate: 'bad_birth_date' }, message: birthProblem.message }, 422)
    if (profile && Object.hasOwn(profile, 'startReady') && profile.startReady === 'month' && !Number.isInteger(Number(profile.startMonth)))
      return c.json({ error: 'validation', errors: { startMonth: 'Выбери месяц' }, codes: { startMonth: 'required' }, message: 'Выбери месяц, с которого кандидат может выйти' }, 422)

    // Работа на заводе — с 18 лет: пригласить или взять кандидата без 18 можно только явно. Возраст — по новой дате рождения,
    // если её прислали; без даты — по отметке «есть 18»
    const birthNow = profile && Object.hasOwn(profile, 'birthDate') ? normalizeBirthDate(profile.birthDate) : (current.birthDate ?? '')
    const adultNow = isAdultByBirthDate(birthNow) ?? (profile && 'adult' in profile ? profile.adult : current.adult)
    if (adultNow === false && body.allowUnderage !== true && isStatus(body.status) && advancing(body.status, current.status))
      return c.json({ error: 'underage', message: 'Кандидату нет 18 лет, а на завод берут с 18. Если в дате рождения ошибка — поправь её или подтверди' }, 422)

    // Согласия нет (рекомендация): пригласить можно, но после подтверждения — при звонке нужно сказать, откуда номер
    if (current.consentSource === 'none' && body.consent !== 'hr_verbal' && body.allowNoConsent !== true && body.status === 'interview' && current.status !== 'interview')
      return c.json({ error: 'no_consent', message: 'У кандидата нет согласия на обработку данных. При звонке скажи, откуда номер, и получи согласие. Подтверди приглашение' }, 422)

    let historyId: number | null = null
    let notify = null

    if (body.consent === 'hr_verbal' || body.consent === 'job_board') {
      const r = await workflow.setConsent(id, body.consent, user)
      if (r && 'error' in r) return c.json({ error: 'validation', message: r.error }, 422)
      historyId = r?.historyId ?? historyId
    }
    if (profile) await workflow.setProfile(id, profile as Record<string, never>, user)
    if (body.onboarding && typeof body.onboarding === 'object') {
      const r = await setOnboarding(deps, id, body.onboarding as OnboardingPatch, user)
      if (r && 'error' in r) return c.json({ error: 'validation', message: r.error }, 422)
    }
    if (body.season && typeof body.season === 'object') {
      const r = await workflow.setSeason(id, body.season as SeasonPatch, user)
      if (r && 'error' in r) return c.json({ error: 'validation', message: r.error }, 422)
    }
    // «Как дела на смене»: ответ со слов кандидата при звонке
    if (body.checkin && typeof body.checkin === 'object') {
      const { step, answer, reason } = body.checkin as Record<string, unknown>
      if (!isCheckinStep(step) || !isCheckinAnswer(answer) || (answer === 'hard' && reason !== '' && reason !== undefined && !isCheckinReason(reason)))
        return c.json({ error: 'validation', message: 'Выбери ответ из списка' }, 422)
      const r = await answerCheckin(adaptationDeps(storage)!, id, step, answer, answer === 'hard' && isCheckinReason(reason) ? reason : '', 'hr', user)
      if (!r.ok) return c.json({ error: 'validation', message: 'Вопросы «Как дела на смене» — у «К оформлению» с датой первой смены и у «На смене»' }, 422)
    }
    if (typeof body.notes === 'string') await workflow.setNotes(id, body.notes)
    if (body.assigneeId !== undefined) {
      const assigneeId = body.assigneeId === null ? null : Number(body.assigneeId)
      if (assigneeId !== null && !Number.isInteger(assigneeId)) return c.json({ error: 'invalid_assignee' }, 400)
      const set = await workflow.setAssignee(id, assigneeId, user)
      if (!set) return c.json({ error: 'validation', message: 'Такого сотрудника нет' }, 422)
      historyId = set.historyId ?? historyId
    }
    if (body.callbackAt !== undefined) {
      const at = body.callbackAt === null ? null : new Date(String(body.callbackAt))
      if (at && Number.isNaN(at.getTime())) return c.json({ error: 'validation', message: 'Не получилось прочитать время звонка' }, 422)
      await workflow.setCallback(id, at, typeof body.callbackNote === 'string' ? body.callbackNote.trim() : '', user)
    }

    const to = isStatus(body.status) ? body.status : null
    if (body.attendance === 'yes' || body.attendance === 'no') {
      const r = await markAttendance(deps, id, body.attendance, user, { notify: body.notify === true, comment })
      if (!r) return c.json({ error: 'not_found' }, 404)
      if ('error' in r) return c.json({ error: 'validation', message: r.error }, 422)
      const d = await details(id)
      return c.json({ ...d, historyId: r.historyId, notify: r.notify })
    }
    if (body.missedCall === true) {
      const r = await changeStatus(deps, id, 'no_answer', user, { comment })
      historyId = r?.historyId ?? historyId
    } else if (to && to !== current.status) {
      if (to === 'interview' && !slot && body.withoutSlot !== true)
        return c.json({ error: 'validation', errors: { slot: 'Нужны дата и время' }, message: 'Укажи дату и время собеседования или отметь «время согласуем по телефону»' }, 422)
      const r = await changeStatus(deps, id, to, user, { comment, declineReason: body.declineReason, slot })
      historyId = r?.historyId ?? historyId
      notify = r?.notify ?? null
    } else if (slot) {
      const r = await reschedule(deps, id, slot, user, comment)
      historyId = r?.historyId ?? historyId
      notify = r?.notify ?? null
    } else if (comment) {
      await workflow.comment(id, user, comment)
    }

    const d = await details(id)
    return c.json({ ...d, historyId, notify })
  })

  app.post('/api/hr/applications/:id/message', hr, json, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null
    const text = typeof body?.text === 'string' ? body.text.trim() : ''
    if (text.length < 5 || text.length > 1000) return c.json({ error: 'validation', message: 'Сообщение — от 5 до 1000 символов' }, 422)
    if ((await workflow.get(c.req.param('id')))?.anonymizedAt) return c.json({ error: 'erased', message: 'Личные данные по этой заявке удалены' }, 409)
    const r = await sendMessage(deps, c.req.param('id'), text, c.get('hrUser'))
    return r ? c.json(r) : c.json({ error: 'not_found' }, 404)
  })

  // POST {name, phone, source, …, force?} — кандидат по звонку, визиту или с работного сайта.
  // Если такой телефон уже есть — 409 с найденной заявкой; force: true добавляет всё равно (будет дублем)
  app.post('/api/hr/applications', hr, json, async (c) => {
    const body = (await c.req.json().catch(() => null)) as (Partial<ApplicationInput> & { force?: boolean; createdAt?: string; consentBasis?: unknown }) | null
    if (!body) return c.json({ error: 'invalid-json' }, 400)
    const source = typeof body.source === 'string' ? body.source.trim().slice(0, 64) : ''
    // Поля кейса необязательны: дату рождения проверяем только на опечатку, возраст HR видит в карточке
    const { errors, codes } = checkApplication({ ...body, portfolio: typeof body.portfolio === 'string' ? body.portfolio : '' })
    if (!source) errors.source = 'Откуда кандидат: звонок, визит, hh.ru'
    // Основание панель спрашивает всегда. Без него (скрипты, старые клиенты) — «согласия нет»: так безопаснее, чем придумать согласие
    if (body.consentBasis !== undefined && !isManualConsent(body.consentBasis)) {
      errors.consentBasis = 'Выбери основание: согласие устно, отклик на работном сайте или рекомендация без согласия'
      codes.consentBasis = 'invalid'
    }
    if (Object.keys(errors).length) return c.json({ error: 'validation', errors, codes, message: Object.values(errors)[0] }, 422)
    const existing = body.phone ? await workflow.findByPhone(body.phone) : null
    if (existing && body.force !== true)
      return c.json({ error: 'duplicate', existing, message: `Этот телефон уже есть: ${existing.name}, заявка ${existing.id}` }, 409)
    const label = await sourceLabel(source)
    const app = await workflow.createManual({ ...body, source }, c.get('hrUser'), `Добавлено вручную: ${label}`)
    return c.json({ application: app }, 201)
  })

  // POST тело — файл (CSV или .xlsx), x-file-name — имя. Ответ: заголовки, строки и угаданные колонки
  app.post('/api/hr/import/parse', hr, bodyLimit({ maxSize: IMPORT_MAX_BYTES + 1024, onError: (c) => c.json({ error: 'validation', message: 'Файл больше 5 МБ. Раздели выгрузку на части' }, 413) }), async (c) => {
    const name = decodeURIComponent(c.req.header('x-file-name') ?? 'file')
    try {
      const table = parseTable(Buffer.from(await c.req.arrayBuffer()), name)
      return c.json({ ...table, mapping: guessMapping(table.headers) })
    } catch (e) {
      if (e instanceof ImportError) return c.json({ error: 'validation', message: e.message }, 422)
      throw e
    }
  })

  app.get('/api/hr/import/vacancy-map', hr, async (c) => c.json((await repo.integration<{ map?: Record<string, string> }>('import_vacancy_map')).map ?? {}))

  /**
   * POST {rows: ImportRow[], source, skipDuplicates, vacancyMap?, skipped?}
   * Сервер заново проверяет каждую строку и ищет дубли по телефону, почте и резюме hh.ru — в базе и в файле.
   * В отчёте номера строк — как в файле. Сопоставления «вакансия в файле → наша» запоминаются для следующих импортов.
   */
  app.post('/api/hr/import/commit', hr, bodyLimit({ maxSize: 8 * 1024 * 1024 }), async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | {
          rows?: unknown
          source?: unknown
          skipDuplicates?: unknown
          vacancyMap?: unknown
          skipped?: unknown
          defaultMonths?: unknown
          assign?: unknown
          assignees?: unknown
          consentBasis?: unknown
        }
      | null
    const rows = Array.isArray(body?.rows) ? (body.rows as Record<string, unknown>[]).slice(0, IMPORT_MAX_ROWS) : []
    const source = typeof body?.source === 'string' && body.source.trim() ? body.source.trim().slice(0, 64) : 'hh'
    if (!rows.length) return c.json({ error: 'validation', message: 'В файле нет строк для импорта' }, 422)
    const skipDuplicates = body?.skipDuplicates !== false
    const label = await sourceLabel(source)
    const user = c.get('hrUser')
    if (body?.vacancyMap && typeof body.vacancyMap === 'object') {
      const known = new Set(allVacancies.map((v) => v.id))
      const clean = Object.fromEntries(
        Object.entries(body.vacancyMap as Record<string, unknown>).filter(([k, v]) => k.length <= 200 && typeof v === 'string' && (v === 'none' || known.has(v))).slice(0, 500),
      )
      const saved = (await repo.integration<{ map?: Record<string, string> }>('import_vacancy_map')).map ?? {}
      await repo.patchIntegration('import_vacancy_map', { map: { ...saved, ...clean } })
    }
    const skipped = Array.isArray(body?.skipped) ? (body.skipped as { line: number; reason: string }[]).slice(0, 500) : []
    // Месяцы для строк без месяцев в файле: по сезону вакансии (по умолчанию) или те, что HR выбрал в предпросмотре
    const monthList = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((m): m is number => Number.isInteger(m) && m >= 1 && m <= 12))].sort((a, b) => a - b) : [])
    const fixedMonths = Array.isArray(body?.defaultMonths) ? monthList(body.defaultMonths) : null
    // Кто ведёт новые заявки: я (по умолчанию), никто или поровну между выбранными сотрудниками
    const active = new Set((await repo.staff()).map((s) => s.id))
    const assignees = Array.isArray(body?.assignees) ? [...new Set(body.assignees.map(Number))].filter((id) => active.has(id)) : []
    if (body?.assign === 'even' && !assignees.length) return c.json({ error: 'validation', message: 'Выбери, между кем раздать заявки' }, 422)
    // Основание для всех строк файла: отклик на работном сайте, устно или без согласия. Без него — «согласия нет»
    if (body?.consentBasis !== undefined && !isManualConsent(body.consentBasis))
      return c.json({ error: 'validation', message: 'Выбери основание: отклик на работном сайте, согласие устно или без согласия' }, 422)
    const consentBasis = isManualConsent(body?.consentBasis) ? body.consentBasis : 'none'
    // Поровну — по кругу в порядке строк файла, как evenSplit в панели: разница между сотрудниками не больше одной заявки
    let createdCount = 0
    const assigneeFor = (): number | null | undefined => (body?.assign === 'none' ? null : body?.assign === 'even' ? assignees[createdCount % assignees.length] : undefined)
    const report = await storage.sql.begin(async (tx) => {
      const out = {
        created: [] as { line: number; id: string; name: string }[],
        duplicates: [] as { line: number; name: string; existingId: string; by: string }[],
        invalid: [] as { line: number; problems: string[] }[],
        skipped,
        warnings: [] as { line: number; warnings: string[] }[],
      }
      const seen = new Map<string, string>()
      for (const [i, r] of rows.entries()) {
        const str = (k: string, max = 200) => (typeof r[k] === 'string' ? (r[k] as string).trim().slice(0, max) : '')
        const line = Number.isInteger(r.line) && (r.line as number) > 0 ? (r.line as number) : i + 2
        const problems = Array.isArray(r.problems) ? (r.problems as unknown[]).filter((p): p is string => typeof p === 'string').slice(0, 5) : []
        const phoneRaw = str('phone', 40)
        const parsed = phoneRaw ? parsePhone(phoneRaw) : null
        if (parsed && 'error' in parsed) problems.push(parsed.error)
        const email = /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(str('email', 120)) ? str('email', 120) : ''
        const input = {
          name: str('name', 120),
          lastName: str('lastName', 80),
          middleName: str('middleName', 80),
          phone: parsed && 'e164' in parsed ? parsed.e164 : '',
          contact: email,
          vacancyId: vacancies.some((v) => v.id === str('vacancyId', 60)) ? str('vacancyId', 60) : '',
          comment: str('comment', 2000),
          citizenship: (['ru', 'eaeu', 'other'].includes(str('citizenship')) ? str('citizenship') : '') as HrApplication['citizenship'],
          // Дата рождения из файла: с опечаткой не храним, моложе 18 — храним, HR увидит возраст. adult по ней выведет нормализация
          birthDate: normalizeBirthDate(str('birthDate', 20)),
          adult: typeof r.adult === 'boolean' ? r.adult : null,
          school: str('school', 200),
          resumeUrl: parseResumeUrl(str('resumeUrl', 300)),
          months: [] as number[],
        }
        const fromFile = monthList(r.months)
        input.months = fromFile.length ? fromFile : (fixedMonths ?? vacancyMonths(input.vacancyId))
        const { errors } = checkApplication(input)
        if (errors.name) problems.push('нет имени')
        if (errors.phone && !problems.some((p) => p.startsWith('телефон'))) problems.push('нет телефона или почты')
        if (problems.length) {
          out.invalid.push({ line, problems: [...new Set(problems)] })
          continue
        }
        const fullName = [input.lastName, input.name, input.middleName].filter(Boolean).join(' ')
        const keys = dedupeKeys(input)
        const inFile = keys.map((k) => seen.get(k)).find(Boolean)
        const existing = inFile ? { id: inFile, by: 'повтор в файле' } : await workflow.findExisting({ phone: input.phone, email, resumeUrl: input.resumeUrl }, tx)
        if (existing && skipDuplicates) {
          out.duplicates.push({ line, name: fullName, existingId: existing.id, by: existing.by })
          continue
        }
        const app = await workflow.createManual({ ...input, source, consentBasis, createdAt: str('appliedAt', 40) || null }, user, `Импорт из файла: ${label}`, tx, assigneeFor())
        createdCount++
        for (const k of keys) seen.set(k, app.id)
        out.created.push({ line, id: app.id, name: fullName })
        const warnings = Array.isArray(r.warnings) ? (r.warnings as unknown[]).filter((w): w is string => typeof w === 'string').slice(0, 5) : []
        if (warnings.length) out.warnings.push({ line, warnings })
      }
      return out
    })
    return c.json(report)
  })

  // Что сотрёт «Удалить по запросу»: заявки того же человека и данные бота — HR подтверждает список
  app.get('/api/hr/applications/:id/erase', hr, async (c) => {
    const preview = await erasePreview(storage.sql, c.req.param('id'))
    return preview ? c.json(preview) : c.json({ error: 'not_found' }, 404)
  })

  // POST {reason, ids?} — «Удалить по запросу кандидата»: обезличить сразу, причина обязательна.
  // ids — подтверждённые заявки из списка; без ids — весь список
  app.post('/api/hr/applications/:id/erase', hr, json, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { reason?: unknown; ids?: unknown } | null
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
    if (reason.length < 5) return c.json({ error: 'validation', message: 'Укажи причину: например, «письмо кандидата на rabota@ochakovo.ru»' }, 422)
    const ids = Array.isArray(body?.ids) ? body.ids.filter((x): x is string => typeof x === 'string').slice(0, 100) : undefined
    const result = await eraseOnRequest(storage.sql, c.req.param('id'), c.get('hrUser'), reason, ids)
    if (result === null) return c.json({ error: 'not_found' }, 404)
    return c.json({ erased: result.applications, ...result })
  })

  app.get('/api/hr/retention', admin, async (c) => {
    const state = await repo.integration<{ lastRunAt?: string }>('retention')
    return c.json({ months: retentionMonths(env), lastRunAt: state.lastRunAt ?? null, log: await retentionLog(storage.sql) })
  })

  app.post('/api/hr/retention/run', admin, async (c) => {
    const result = await runRetention({ sql: storage.sql, env, by: c.get('hrUser') })
    if (!('busy' in result)) await repo.patchIntegration('retention', { lastRunAt: new Date().toISOString(), last: result })
    return c.json(result, 'busy' in result ? 409 : 200)
  })

  // POST {historyIds: number[]} — отменить свои последние действия (сообщения, которые ещё не ушли, отменяются)
  app.post('/api/hr/undo', hr, json, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { historyIds?: unknown } | null
    const ids = Array.isArray(body?.historyIds) ? body.historyIds.map(Number).filter(Number.isInteger).slice(0, 500) : []
    if (!ids.length) return c.json({ error: 'invalid' }, 400)
    return c.json({ results: await undo(deps, ids, c.get('hrUser')) })
  })

  // POST {ids, action: status|assign|message и параметры} — массовые действия
  app.post('/api/hr/bulk', hr, bigJson, async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    const ids = Array.isArray(body?.ids) ? [...new Set(body.ids.filter((x): x is string => typeof x === 'string'))].slice(0, 500) : []
    if (!body || !ids.length) return c.json({ error: 'validation', message: 'Выбери хотя бы одну заявку' }, 422)
    // Фамилии из окна приглашения: охрана ищет кандидата в списке на проходную по фамилии
    const lastNames =
      body.lastNames && typeof body.lastNames === 'object'
        ? Object.fromEntries(
            Object.entries(body.lastNames as Record<string, unknown>)
              .filter(([id, v]) => ids.includes(id) && typeof v === 'string' && v.trim())
              .map(([id, v]) => [id, (v as string).trim().slice(0, 80)]),
          )
        : undefined
    let action: BulkAction
    const nameOf = (a: HrApplication) => [a.lastName, a.name].filter(Boolean).join(' ')
    if (body.action === 'status' && isStatus(body.status) && body.allowUnderage !== true) {
      const to = body.status
      // Фамилия, дописанная в окне приглашения, не меняет возраст: смотрим анкету как есть
      const minors = (await workflow.byIds(ids)).filter((a) => a.adult === false && advancing(to, a.status))
      if (minors.length)
        return c.json({ error: 'underage', message: `Нет 18 лет по анкете: ${minors.map(nameOf).join(', ')}. Сними их с выделения или подтверди`, ids: minors.map((a) => a.id) }, 422)
    }
    // Приглашение кандидатам без согласия (рекомендация) — только с подтверждением, как в карточке
    if (body.action === 'status' && body.status === 'interview' && body.allowNoConsent !== true) {
      const noConsent = (await workflow.byIds(ids)).filter((a) => a.consentSource === 'none' && a.status !== 'interview')
      if (noConsent.length)
        return c.json(
          {
            error: 'no_consent',
            message: `Нет согласия на обработку данных: ${noConsent.map(nameOf).join(', ')}. При звонке скажи, откуда номер, и получи согласие. Сними их с выделения или подтверди`,
            ids: noConsent.map((a) => a.id),
          },
          422,
        )
    }
    // «Разложить по норме»: у каждой заявки своё время, адрес и «что взять» — общие
    if (body.action === 'status' && body.status === 'interview' && body.spread && typeof body.spread === 'object') {
      const spread = body.spread as { address?: unknown; bring?: unknown; slots?: unknown }
      const list = Array.isArray(spread.slots) ? (spread.slots as { id?: unknown; startsAt?: unknown }[]) : []
      const slots: Record<string, SlotInput> = {}
      const settings = await repo.workSettings()
      for (const item of list) {
        if (typeof item?.id !== 'string' || !ids.includes(item.id)) continue
        const slot = parseSlot({ startsAt: item.startsAt, address: spread.address, bring: spread.bring })
        if (typeof slot === 'string') return c.json({ error: 'validation', message: slot }, 422)
        const off = slotWarning(slot.startsAt, settings)
        if (off && body.allowOffHours !== true) return c.json({ error: 'off_hours', message: `${off}. Подтверди, если так и задумано` }, 422)
        slots[item.id] = slot
      }
      const missing = ids.filter((id) => !slots[id])
      if (missing.length) return c.json({ error: 'validation', message: `Не хватило времени для ${missing.length} из ${ids.length}: расширь дни или часы`, ids: missing }, 422)
      return c.json(await bulk(deps, ids, { action: 'status', status: 'interview', comment: typeof body.comment === 'string' ? body.comment : '', slots, lastNames }, c.get('hrUser')))
    }
    if (body.action === 'status' && isStatus(body.status)) {
      const slot = body.slot ? parseSlot(body.slot) : undefined
      if (typeof slot === 'string') return c.json({ error: 'validation', message: slot }, 422)
      const off = slot ? slotWarning(slot.startsAt, await repo.workSettings()) : null
      if (off && body.allowOffHours !== true) return c.json({ error: 'off_hours', message: `${off}. Подтверди, если так и задумано` }, 422)
      if (body.status === 'interview' && !slot && body.withoutSlot !== true)
        return c.json({ error: 'validation', message: 'Укажи дату и время собеседования или отметь «время согласуем по телефону»' }, 422)
      action = { action: 'status', status: body.status, comment: typeof body.comment === 'string' ? body.comment : '', declineReason: body.declineReason, slot, lastNames }
    } else if (body.action === 'assign') {
      const assigneeId = body.assigneeId === null ? null : Number(body.assigneeId)
      if (assigneeId !== null && !Number.isInteger(assigneeId)) return c.json({ error: 'invalid_assignee' }, 400)
      action = { action: 'assign', assigneeId }
    } else if (body.action === 'message' && typeof body.text === 'string' && body.text.trim().length >= 5) {
      action = { action: 'message', text: body.text.trim().slice(0, 1000) }
    } else if (body.action === 'season' && body.season && typeof body.season === 'object') {
      action = { action: 'season', season: body.season as SeasonPatch }
    } else return c.json({ error: 'validation', message: 'Неизвестное действие с выбранными заявками' }, 422)
    return c.json(await bulk(deps, ids, action, c.get('hrUser')))
  })

  // ── Дубли ─────────────────────────────────────────────────────────────

  app.get('/api/hr/duplicates', hr, async (c) => c.json(await workflow.duplicateGroups()))

  app.post('/api/hr/applications/:id/merge', hr, json, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { into?: unknown } | null
    if (typeof body?.into !== 'string') return c.json({ error: 'invalid' }, 400)
    const r = await workflow.merge(body.into, c.req.param('id'), c.get('hrUser'))
    return 'error' in r ? c.json({ error: 'validation', message: r.error }, 422) : c.json(r)
  })

  app.post('/api/hr/applications/:id/unmerge', hr, async (c) =>
    (await workflow.unmerge(c.req.param('id'), c.get('hrUser'))) ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404),
  )

  // ── Сохранённые виды ─────────────────────────────────────────────────

  app.get('/api/hr/views', hr, async (c) => c.json(await repo.views(c.get('hrUser').id)))

  app.post('/api/hr/views', hr, json, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { name?: unknown; query?: unknown } | null
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    if (name.length < 2) return c.json({ error: 'validation', message: 'Назови вид' }, 422)
    const filter = paramsToFilter(new URLSearchParams(typeof body?.query === 'string' ? body.query : ''))
    delete filter.ids
    const view = await repo.createView(c.get('hrUser').id, name, filter)
    return view ? c.json(view, 201) : c.json({ error: 'validation', message: 'Выбери хотя бы один фильтр. Видов — не больше 20' }, 422)
  })

  app.delete('/api/hr/views/:id', hr, async (c) =>
    (await repo.deleteView(c.get('hrUser').id, Number(c.req.param('id')))) ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404),
  )

  // ── Выгрузки: текущий отфильтрованный список ─────────────────────────

  /**
   * Лист «Воронка» для выгрузки — по тому же отбору, что и заявки. Без фильтра или только с датами —
   * полная воронка за этот период (с посещениями сайта). С любым другим фильтром — воронка по выгруженным
   * заявкам: посещения к ним не привязать, поэтому только этапы от заявки до смены.
   */
  const funnelSheet = async (filter: HrFilter, all: HrApplication[], list: HrApplication[]): Promise<FunnelSheet> => {
    const { from: fromDay, to: toDay, sort: _sort, ...rest } = filter
    const periodOnly = !Object.keys(rest).length
    if (periodOnly) {
      const from = fromDay ? day(fromDay, new Date(0)) : new Date(0)
      const to = toDay ? new Date(day(toDay, new Date()).getTime() + 864e5) : new Date()
      const report = await repo.funnel(from, to, all)
      const ru = (d: string) => d.split('-').reverse().join('.')
      const title = fromDay || toDay ? `Воронка за период ${fromDay ? `с ${ru(fromDay)} ` : ''}по ${toDay ? ru(toDay) : 'сегодня'}` : 'Воронка за всё время'
      return { title, ...report, names: await sourceNames(storage.sql) }
    }
    const bySource = new Map<string, HrApplication[]>()
    for (const a of list) bySource.set(sourceKey(a), [...(bySource.get(sourceKey(a)) ?? []), a])
    const rows = [...bySource].map(([source, apps]) => ({ source, visitors: 0, tasks: 0, applyOpen: 0, ...stageCounts(apps) }))
    rows.sort((a, b) => b.applications - a.applications)
    return { title: `Воронка по выгруженным заявкам: ${list.length}`, rows, applicationsOnly: true, names: await sourceNames(storage.sql) }
  }

  const exportFile = async (c: Context, format: Format, filter: HrFilter, extra: string[]) => {
    const user = c.get('hrUser')
    const all = await workflow.list()
    const list = sortApps(applyFilter(all, filter, { meId: user.id }), filter.sort)
    const columns = pickColumns(extra)
    const f = formats[format]
    // Журнал выгрузок: кто, в каком формате, сколько строк и номера заявок. Поиск (q) не пишем — в нём бывают имя и телефон
    const params = filterToParams(filter)
    params.delete('q')
    const token = user.id === 0
    void logAccess(storage.sql, {
      user: token ? null : { id: user.id, name: user.name, role: user.role },
      who: token ? 'Служебный токен' : undefined,
      action: token ? 'token_read' : 'export',
      format,
      rows: list.length,
      filter: params.toString(),
      applicationIds: list.map((a) => a.id),
    }).catch((e) => console.error('[access-log] выгрузка не записана в журнал:', e))
    if (format === 'csv') return c.body(applicationsCsv(list, columns), 200, { 'content-type': f.type, 'content-disposition': disposition('Заявки', f.ext) })
    if (format === 'json') return c.body(JSON.stringify(applicationsJson(list, columns), null, 2), 200, { 'content-type': f.type, 'content-disposition': disposition('Заявки', f.ext) })
    if (format === 'csv1c') return c.body(new Uint8Array(encodeCp1251(applications1C(list))), 200, { 'content-type': f.type, 'content-disposition': disposition('Кандидаты для 1С', f.ext) })
    const season = seasonOf(Date.now())
    const plan = { season, cells: planProgress(await repo.plan(season), all, season) }
    const file = await buildWorkbook(list, columns, await funnelSheet(filter, all, list), plan)
    return c.body(new Uint8Array(file), 200, { 'content-type': f.type, 'content-disposition': disposition('Заявки', f.ext) })
  }

  const extraColumns = (v: unknown) => (typeof v === 'string' ? v.split(',') : Array.isArray(v) ? v.map(String) : []).filter((k) => ['quiz', 'game'].includes(k))

  // GET /api/hr/export.xlsx?status=new&months=7 — для скриптов со служебным токеном и прямых ссылок
  app.get('/api/hr/export/:file{applications\\.(xlsx|csv|json|1c\\.csv)}', hr, async (c) => {
    const file = c.req.param('file')
    const format = (file.endsWith('.1c.csv') ? 'csv1c' : file.split('.').pop()) as Format
    const params = new URL(c.req.url).searchParams
    return exportFile(c, format, paramsToFilter(params), extraColumns(params.get('extra')))
  })

  // POST {format, query, extra} — из панели: в query может быть длинный список выбранных заявок
  app.post('/api/hr/export', hr, bigJson, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { format?: unknown; query?: unknown; extra?: unknown } | null
    const format = (Object.keys(formats) as Format[]).find((f) => f === body?.format)
    if (!format) return c.json({ error: 'invalid_format' }, 400)
    return exportFile(c, format, paramsToFilter(new URLSearchParams(typeof body?.query === 'string' ? body.query : '')), extraColumns(body?.extra))
  })

  const sendCsv = async (c: Context) => exportFile(c, 'csv', {}, [])
  app.get('/api/hr/applications.csv', hr, sendCsv)

  // ── Воронка, аудитория ботов, вопросы без ответа ─────────────────────

  // GET /api/hr/funnel?from=YYYY-MM-DD&to=YYYY-MM-DD (обе даты включительно, по Москве). По умолчанию — 30 дней
  app.get('/api/hr/funnel', hr, async (c) => {
    const now = new Date()
    const to = day(c.req.query('to'), now)
    const toEnd = c.req.query('to') ? new Date(to.getTime() + 864e5) : now
    const from = day(c.req.query('from'), new Date(toEnd.getTime() - 30 * 864e5))
    const report = await repo.funnel(from, toEnd, await workflow.list())
    const codes = report.rows.filter((r) => r.source.startsWith('friend-')).map((r) => r.source.slice('friend-'.length))
    return c.json({ from: from.toISOString(), to: toEnd.toISOString(), ...report, referrers: await repo.referrerNames(codes) })
  })

  app.get('/api/hr/audience', hr, async (c) => c.json(await storage.botAudience()))

  app.get('/api/hr/kb-gaps', hr, async (c) => c.json(await storage.listGaps(Math.min(500, Number(c.req.query('limit')) || 200))))

  app.post('/api/hr/kb-gaps/:id/resolve', hr, async (c) => {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id) || !(await repo.resolveGap(id))) return c.json({ error: 'not_found' }, 404)
    return c.json({ ok: true })
  })

  // ── Тексты уведомлений ───────────────────────────────────────────────

  // Пример с подстановками — чтобы HR видел сообщение глазами кандидата
  const sample = {
    name: 'Аня Кузнецова',
    id: 'K7M2PQ9X',
    vacancyId: 'bottling-operator',
    interview: { startsAt: new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10) + 'T08:00:00.000Z', address: 'Москва, ул. Рябиновая, 44', bring: 'паспорт' },
  }
  const withPreview = <T extends { text: string }>(t: T) => ({ ...t, preview: renderTemplate(t.text, sample, sample.interview) })

  app.get('/api/hr/templates', hr, async (c) => c.json((await repo.templates()).map(withPreview)))

  app.put('/api/hr/templates/:key', admin, json, async (c) => {
    const key = c.req.param('key') as TemplateKey
    if (!isTemplateKey(key)) return c.json({ error: 'invalid_template' }, 400)
    const body = (await c.req.json().catch(() => null)) as { text?: unknown; enabled?: unknown } | null
    const text = typeof body?.text === 'string' ? body.text.trim() : undefined
    if (text !== undefined && (text.length < 20 || text.length > 1000)) return c.json({ error: 'invalid_text', message: 'Текст — от 20 до 1000 символов' }, 422)
    const unknown = text?.match(/\{([^}]*)\}/g)?.find((m) => !placeholders.includes(m.slice(1, -1) as (typeof placeholders)[number]))
    if (unknown) return c.json({ error: 'invalid_text', message: `Неизвестная подстановка ${unknown}. Можно ${placeholders.map((p) => `{${p}}`).join(', ')}` }, 422)
    const enabled = typeof body?.enabled === 'boolean' ? body.enabled : undefined
    if (!(await repo.updateTemplate(key, { text, enabled }))) return c.json({ error: 'not_found' }, 404)
    return c.json(withPreview((await repo.template(key))!))
  })

  // ── Администрирование: данные, интеграции ─────────────────────────────

  app.post('/api/hr/applications/seed', admin, demoOnly, json, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { count?: number }
    return c.json({ added: await seedDemo(storage.sql, Math.max(1, Math.min(200, Number(body.count) || 24))) })
  })

  app.delete('/api/hr/applications', admin, demoOnly, async (c) => c.json({ deleted: await clearAll(storage.sql) }))

  app.get('/api/hr/integrations', admin, async (c) =>
    c.json({
      yandexDisk: await diskStatus(repo, env),
      sms: deps.sms ? { configured: true, provider: providerName(deps.sms.provider), sender: deps.sms.sender ?? null } : { configured: false, provider: null, sender: null },
    }),
  )

  app.post('/api/hr/integrations/yandex-disk/sync', admin, async (c) => {
    const r = await syncNow({ sql: storage.sql, repo, workflow, env })
    return c.json({ result: r, status: await diskStatus(repo, env) }, r.ok ? 200 : 502)
  })

  app.post('/api/hr/integrations/yandex-disk/check', admin, async (c) => {
    if (!diskConfigured(env)) return c.json({ ok: false, error: 'Яндекс Диск не подключён: задай YANDEX_DISK_TOKEN' }, 422)
    try {
      const state = (await repo.integration<DiskState>(DISK_KEY)) as DiskState
      const info = await diskClient(env, state, repo).info()
      return c.json({ ok: true, ...info })
    } catch (e) {
      return c.json({ ok: false, error: e instanceof DiskError ? e.message : 'Диск не ответил' }, 502)
    }
  })

  app.put('/api/hr/integrations/yandex-disk', admin, json, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { snapshots?: unknown } | null
    if (typeof body?.snapshots === 'boolean') await repo.patchIntegration(DISK_KEY, { snapshots: body.snapshots })
    return c.json(await diskStatus(repo, env))
  })

  // ── hh.ru: публикация вакансий (только админ, только по кнопке) ───────

  const hhState = () => repo.integration<{ accessToken?: string; refreshToken?: string; published?: Record<string, { hhId: string; kind: 'draft' | 'vacancy'; at: string; archived?: boolean }> }>('hh')
  const hhClient = async () => {
    const state = await hhState()
    const cfg = hhFromEnv(env, state)
    return cfg ? new HhClient({ ...cfg, onTokens: (t) => repo.patchIntegration('hh', { accessToken: t.accessToken, refreshToken: t.refreshToken }) }) : null
  }
  const hhOptions = () => ({ areaId: env.HH_AREA_ID?.trim() || '1', addressId: env.HH_ADDRESS_ID?.trim() || undefined, property: env.HH_VACANCY_PROPERTY?.trim() || undefined })

  app.get('/api/hr/hh', admin, async (c) => {
    const state = await hhState()
    const cfg = hhFromEnv(env, state)
    return c.json({
      connected: Boolean(cfg),
      employerId: cfg?.employerId ?? null,
      userAgent: cfg?.userAgent ?? env.HH_USER_AGENT ?? null,
      addressId: hhOptions().addressId ?? null,
      published: state.published ?? {},
      vacancies: vacancies.map((v) => ({ id: v.id, title: v.title, ...toHhVacancy(v, hhOptions()) })),
    })
  })

  app.post('/api/hr/hh/check', admin, async (c) => {
    const client = await hhClient()
    if (!client) return c.json({ ok: false, error: 'hh.ru не подключён: задай HH_ACCESS_TOKEN и HH_REFRESH_TOKEN' }, 422)
    try {
      return c.json({ ok: true, ...(await client.me()) })
    } catch (e) {
      return c.json({ ok: false, error: e instanceof HhError ? e.message : 'hh.ru не ответил' }, 502)
    }
  })

  // POST {action: draft|publish|update|archive, dryRun = true}. Пробный режим ничего не отправляет, только показывает запрос
  app.post('/api/hr/hh/vacancies/:id', admin, json, async (c) => {
    const v = allVacancies.find((x) => x.id === c.req.param('id'))
    if (!v) return c.json({ error: 'not_found' }, 404)
    const body = (await c.req.json().catch(() => ({}))) as { action?: unknown; dryRun?: unknown }
    const action = ['draft', 'publish', 'update', 'archive'].includes(body.action as string) ? (body.action as 'draft' | 'publish' | 'update' | 'archive') : 'draft'
    const dryRun = body.dryRun !== false
    const preview = toHhVacancy(v, hhOptions())
    const state = await hhState()
    const current = state.published?.[v.id]
    if (dryRun) return c.json({ dryRun: true, action, ...preview })
    if ((action === 'publish' || action === 'update') && preview.problems.length)
      return c.json({ error: 'validation', message: `Сначала поправь: ${preview.problems.join('; ')}` }, 422)
    if ((action === 'update' || action === 'archive') && (!current || current.kind !== 'vacancy'))
      return c.json({ error: 'validation', message: 'Эта вакансия ещё не опубликована на hh.ru' }, 422)
    const client = await hhClient()
    if (!client) return c.json({ error: 'validation', message: 'hh.ru не подключён: задай HH_ACCESS_TOKEN и HH_REFRESH_TOKEN' }, 422)
    try {
      let entry = current
      if (action === 'draft') entry = { hhId: await client.createDraft(preview.payload), kind: 'draft', at: new Date().toISOString() }
      if (action === 'publish') entry = { hhId: await client.publish(preview.payload), kind: 'vacancy', at: new Date().toISOString() }
      if (action === 'update') await client.update(current!.hhId, preview.payload)
      if (action === 'archive') {
        await client.archive(current!.hhId)
        entry = { ...current!, archived: true, at: new Date().toISOString() }
      }
      await repo.patchIntegration('hh', { published: { ...(state.published ?? {}), [v.id]: entry } })
      return c.json({ ok: true, action, entry })
    } catch (e) {
      if (e instanceof HhError) return c.json({ error: 'hh', message: e.message, details: e.details }, 502)
      throw e
    }
  })

  // Отклики с hh.ru по опубликованной вакансии → строки для импорта (сохраняет HR через /api/hr/import/commit)
  app.post('/api/hr/hh/vacancies/:id/responses', admin, async (c) => {
    const state = await hhState()
    const current = state.published?.[c.req.param('id')]
    if (!current || current.kind !== 'vacancy') return c.json({ error: 'validation', message: 'Вакансия не опубликована на hh.ru' }, 422)
    const client = await hhClient()
    if (!client) return c.json({ error: 'validation', message: 'hh.ru не подключён' }, 422)
    try {
      return c.json({ rows: await client.responses(current.hhId) })
    } catch (e) {
      if (e instanceof HhError) return c.json({ error: 'hh', message: e.message }, 502)
      throw e
    }
  })

  // ── План найма ───────────────────────────────────────────────────────

  const seasonParam = (v: string | undefined) => (v && /^\d{4}$/.test(v) ? Number(v) : seasonOf(Date.now()))

  app.get('/api/hr/plan', hr, async (c) => {
    const season = seasonParam(c.req.query('season'))
    const plan = await repo.plan(season)
    return c.json({ season, cells: planProgress(plan, await workflow.list(), season) })
  })

  // PUT {season, entries: [{vacancyId, month, target}]}: 0 — убрать клетку
  app.put('/api/hr/plan', hr, json, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { season?: unknown; entries?: unknown } | null
    const season = seasonParam(String(body?.season ?? ''))
    const known = new Set(allVacancies.map((v) => v.id))
    const entries = (Array.isArray(body?.entries) ? (body.entries as Record<string, unknown>[]) : [])
      .map((e) => ({ vacancyId: String(e.vacancyId ?? ''), month: Number(e.month), target: Number(e.target) }))
      .filter((e) => known.has(e.vacancyId) && Number.isInteger(e.month) && e.month >= 1 && e.month <= 12)
    if (entries.some((e) => !Number.isInteger(e.target) || e.target < 0 || e.target > 10000)) return c.json({ error: 'validation', message: 'План — целое число от 0 до 10000' }, 422)
    const plan = await repo.savePlan(season, entries.slice(0, 500))
    return c.json({ season, cells: planProgress(plan, await workflow.list(), season) })
  })

  // ── Список на проходную ───────────────────────────────────────────────

  const passItems = async (day: string) => {
    const list = (await workflow.list()).filter((a) => a.interview && !a.duplicateOf && !a.anonymizedAt && a.status === 'interview')
    return list
      .filter((a) => new Date(new Date(a.interview!.startsAt).getTime() + 3 * 3600e3).toISOString().slice(0, 10) === day)
      .sort((a, b) => a.interview!.startsAt.localeCompare(b.interview!.startsAt))
      .map((a) => ({
        id: a.id,
        time: new Date(a.interview!.startsAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }),
        fullName: [a.lastName, a.name, a.middleName].filter(Boolean).join(' '),
        vacancy: a.vacancyId ? (allVacancies.find((v) => v.id === a.vacancyId)?.title ?? '') : '',
      }))
  }
  const passDay = (v: string | undefined) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10))

  app.get('/api/hr/pass', hr, async (c) => {
    const day = passDay(c.req.query('date'))
    return c.json({ date: day, items: await passItems(day) })
  })

  app.get('/api/hr/pass.xlsx', hr, async (c) => {
    const day = passDay(c.req.query('date'))
    const items = await passItems(day)
    const file = buildPassList(day, items)
    const user = c.get('hrUser')
    void logAccess(storage.sql, { user: user.id === 0 ? null : { id: user.id, name: user.name, role: user.role }, who: user.id === 0 ? 'Служебный токен' : undefined, action: user.id === 0 ? 'token_read' : 'export', format: 'xlsx', rows: items.length, filter: `pass=${day}`, applicationIds: items.map((i) => i.id) }).catch((e) =>
      console.error('[access-log] список на проходную не записан в журнал:', e),
    )
    return c.body(new Uint8Array(file), 200, { 'content-type': formats.xlsx.type, 'content-disposition': `attachment; filename="propusk-${day}.xlsx"; filename*=UTF-8''${encodeURIComponent(`Список на проходную ${day}.xlsx`)}` })
  })

  // ── Сотрудники (только админ) ────────────────────────────────────────

  app.get('/api/hr/users', admin, async (c) => c.json(await repo.listUsers()))

  app.post('/api/hr/users', admin, json, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { email?: unknown; name?: unknown; role?: unknown; password?: unknown } | null
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    const role = roles.includes(body?.role as HrRole) ? (body!.role as HrRole) : 'hr'
    const password = typeof body?.password === 'string' ? body.password : ''
    const errors: Record<string, string> = {}
    if (!emailRe.test(email)) errors.email = 'Нужна рабочая почта'
    if (name.length < 2) errors.name = 'Укажи имя'
    const problem = passwordProblem(password)
    if (problem) errors.password = problem
    if (Object.keys(errors).length) return c.json({ error: 'validation', errors }, 422)
    if (await repo.userByEmail(email)) return c.json({ error: 'validation', errors: { email: 'Сотрудник с такой почтой уже есть' } }, 422)
    return c.json(await repo.createUser({ email, name, role, passwordHash: await hashPassword(password) }), 201)
  })

  app.patch('/api/hr/users/:id', admin, json, async (c) => {
    const id = Number(c.req.param('id'))
    const me = c.get('hrUser')
    const body = (await c.req.json().catch(() => null)) as { name?: unknown; role?: unknown; disabled?: unknown; password?: unknown } | null
    if (!Number.isInteger(id) || !body) return c.json({ error: 'invalid' }, 400)
    const patch: { name?: string; role?: HrRole; disabled?: boolean; passwordHash?: string } = {}
    if (typeof body.name === 'string' && body.name.trim().length >= 2) patch.name = body.name.trim()
    if (roles.includes(body.role as HrRole)) patch.role = body.role as HrRole
    if (typeof body.disabled === 'boolean') patch.disabled = body.disabled
    if (typeof body.password === 'string') {
      const problem = passwordProblem(body.password)
      if (problem) return c.json({ error: 'validation', errors: { password: problem } }, 422)
      patch.passwordHash = await hashPassword(body.password)
    }
    // Нельзя остаться без администратора и нельзя выключить самого себя
    if (id === me.id && (patch.disabled || patch.role === 'hr')) return c.json({ error: 'self', message: 'Свою учётную запись выключить или понизить нельзя' }, 422)
    const target = (await repo.listUsers()).find((u) => u.id === id)
    if (!target) return c.json({ error: 'not_found' }, 404)
    if (target.role === 'admin' && !target.disabled && (patch.disabled || patch.role === 'hr') && (await repo.countActiveAdmins()) <= 1)
      return c.json({ error: 'last_admin', message: 'Должен остаться хотя бы один администратор' }, 422)
    return c.json(await repo.updateUser(id, patch))
  })

  // ── Старые адреса панели: работают, но тоже только для сотрудников ─────

  app.get('/api/applications', hr, async (c) => c.json(await workflow.list()))
  app.get('/api/applications.csv', hr, sendCsv)
  app.get('/api/kb-gaps', hr, async (c) => c.json(await storage.listGaps(200)))
  app.get('/api/bots/audience', hr, async (c) => c.json(await storage.botAudience()))
  app.post('/api/applications/seed', admin, demoOnly, json, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { count?: number }
    return c.json({ added: await seedDemo(storage.sql, Math.max(1, Math.min(200, Number(body.count) || 24))) })
  })
  app.delete('/api/applications', admin, demoOnly, async (c) => c.json({ deleted: await clearAll(storage.sql) }))

  return app
}
