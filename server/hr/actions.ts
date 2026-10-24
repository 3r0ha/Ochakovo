import { isDeclineReason, type ApplicationStatus, type Attendance, type DeclineReason, type HrApplication } from '@shared/applications'
import { scheduleCheckins } from '../adaptation'
import type { HrUser } from '../db/hr'
import { NO_SHOW_NOTE, type OnboardingPatch, type SeasonPatch, type SlotInput } from '../db/workflow'
import { cancelQueued, queueMessage, scheduleReminder, scheduleShiftReminder, templateFor, type NotifyDeps, type NotifyPlan } from '../notify'

// Действия HR над заявками: смена статуса с уведомлением и напоминанием, перенос собеседования,
// сообщение кандидату, отмена, массовые действия. Одна логика для карточки, строки списка и выделения.

export type ActionResult = {
  application: HrApplication
  /** Строка истории — по ней действие можно отменить */
  historyId: number | null
  notify: NotifyPlan | null
}

/** Слот собеседования из тела запроса; строка — текст ошибки */
export function parseSlot(raw: unknown): SlotInput | string {
  if (!raw || typeof raw !== 'object') return 'Нужны дата и время собеседования'
  const r = raw as Record<string, unknown>
  const startsAt = typeof r.startsAt === 'string' ? new Date(r.startsAt) : null
  if (!startsAt || Number.isNaN(startsAt.getTime())) return 'Нужны дата и время собеседования'
  if (startsAt.getTime() < Date.now() - 3600e3) return 'Дата собеседования уже прошла'
  if (startsAt.getTime() > Date.now() + 180 * 864e5) return 'Собеседование можно назначить не дальше чем на полгода вперёд'
  const address = typeof r.address === 'string' ? r.address.trim() : ''
  if (address.length < 5) return 'Укажи адрес собеседования'
  const bring = typeof r.bring === 'string' ? r.bring.trim() : ''
  return { startsAt, address, bring }
}

export async function changeStatus(
  deps: NotifyDeps,
  id: string,
  to: ApplicationStatus,
  by: HrUser,
  /** attended — отметка явки на текущем собеседовании вместе со сменой статуса (неявка → отказ); silent — без сообщения кандидату */
  opts: { comment?: string; declineReason?: unknown; slot?: SlotInput; attended?: Exclude<Attendance, ''>; silent?: boolean } = {},
): Promise<ActionResult | null> {
  const before = await deps.workflow.get(id)
  if (!before) return null
  const declineReason: DeclineReason | '' = isDeclineReason(opts.declineReason) ? opts.declineReason : ''
  const changed = await deps.workflow.setStatus(id, to, by, { comment: opts.comment, declineReason, interview: opts.slot, attended: opts.attended })
  if (!changed) return null
  let app = changed.application

  // Сообщение — только при переходе в статус или при новом слоте собеседования
  const key = !opts.silent && (before.status !== to || opts.slot) ? templateFor(to, Boolean(app.interview)) : null
  const notify = key ? await queueMessage(deps, app, changed.historyId, { key }) : null
  if (to === 'interview' && opts.slot && app.interview) {
    await scheduleReminder(deps, app, app.interview, by)
    app = (await deps.workflow.get(id))!
  }
  // Первая смена: напоминание — только пока «К оформлению». Ушли со статуса — задача отменяется, вернулись — ставится снова
  if (before.status !== to && (to === 'hired' || before.status === 'hired')) {
    await scheduleShiftReminder(deps, app, by)
    app = (await deps.workflow.get(id))!
  }
  // «Как дела на смене»: вопросы новичку — у «К оформлению» с датой первой смены и у «На смене»
  if (before.status !== to && ['hired', 'started'].some((s) => s === to || s === before.status)) await scheduleCheckins(deps, app)
  return { application: app, historyId: changed.historyId, notify }
}

/**
 * Оформление и первая смена с напоминанием накануне: в бот, SMS или задачей HR «Напомнить о первой смене».
 * С датой первой смены встают и вопросы «Как дела на смене». Ошибка — строкой
 */
export async function setOnboarding(deps: NotifyDeps, id: string, patch: OnboardingPatch, by: HrUser) {
  const r = await deps.workflow.setOnboarding(id, patch, by)
  if (!r || 'error' in r) return r
  if (Object.hasOwn(patch, 'firstShiftAt')) {
    await scheduleShiftReminder(deps, r.application, by)
    await scheduleCheckins(deps, r.application)
  }
  return { application: (await deps.workflow.get(id))!, historyId: r.historyId }
}

/** Перенести собеседование: новое приглашение кандидату и новое напоминание */
export async function reschedule(deps: NotifyDeps, id: string, slot: SlotInput, by: HrUser, comment = ''): Promise<ActionResult | null> {
  const moved = await deps.workflow.reschedule(id, slot, by, comment)
  if (!moved) return null
  let app = moved.application
  const notify = app.status === 'interview' ? await queueMessage(deps, app, moved.historyId, { key: 'interview' }) : null
  if (app.status === 'interview' && app.interview) {
    await scheduleReminder(deps, app, app.interview, by)
    app = (await deps.workflow.get(id))!
  }
  return { application: app, historyId: moved.historyId, notify }
}

/**
 * Итог собеседования: явка — отметка без смены статуса; неявка — отказ с причиной «Неявка на собеседование»
 * и отметкой на собеседовании. notify: false — кандидату не пишем. Ошибка — строкой
 */
export async function markAttendance(deps: NotifyDeps, id: string, attended: Exclude<Attendance, ''>, by: HrUser, opts: { notify?: boolean; comment?: string } = {}) {
  const app = await deps.workflow.get(id)
  if (!app) return null
  if (app.status !== 'interview' || !app.interview) return { error: 'Явку отмечают у заявок в статусе «Собеседование» с назначенным временем' }
  if (attended === 'yes') {
    const r = await deps.workflow.setAttendance(id, by)
    if (!r) return null
    if ('error' in r) return { error: r.error }
    return { application: r.application, historyId: r.historyId, notify: null } satisfies ActionResult
  }
  if (new Date(app.interview.startsAt).getTime() - 3600e3 > Date.now()) return { error: 'Собеседование ещё не началось, неявку отмечают после него' }
  return changeStatus(deps, id, 'declined', by, {
    declineReason: 'no_show',
    attended: 'no',
    silent: opts.notify !== true,
    comment: opts.comment || NO_SHOW_NOTE,
  })
}

/** Произвольное сообщение кандидату: в бот или текст для звонка */
export async function sendMessage(deps: NotifyDeps, id: string, text: string, by: HrUser) {
  const app = await deps.workflow.get(id)
  if (!app) return null
  const historyId = await deps.workflow.comment(id, by, text, 'message')
  if (!historyId) return null
  return { application: app, historyId, notify: await queueMessage(deps, app, historyId, { text }) }
}

/** Отменить действия. Неотправленные сообщения отменяются, восстановленное собеседование снова получает напоминание */
export async function undo(deps: NotifyDeps, historyIds: number[], by: HrUser) {
  const results: { historyId: number; ok: boolean; error?: string; application?: HrApplication }[] = []
  for (const historyId of historyIds) {
    const r = await deps.workflow.undo(historyId, by)
    if ('error' in r) {
      results.push({ historyId, ok: false, error: r.error })
      continue
    }
    await cancelQueued(deps, historyId)
    await deps.jobs.cancelWhere('reminder', 'applicationId', r.applicationId)
    const app = (await deps.workflow.get(r.applicationId))!
    if (app.status === 'interview' && app.interview) await scheduleReminder(deps, app, app.interview, by)
    await scheduleShiftReminder(deps, app, by)
    results.push({ historyId, ok: true, application: (await deps.workflow.get(r.applicationId))! })
  }
  return results
}

export type BulkAction =
  /** slots — своё время каждой заявке («Разложить по норме»); иначе у всех slot. lastNames — фамилии, дописанные в окне приглашения */
  | { action: 'status'; status: ApplicationStatus; comment?: string; declineReason?: unknown; slot?: SlotInput; slots?: Record<string, SlotInput>; lastNames?: Record<string, string> }
  | { action: 'assign'; assigneeId: number | null }
  | { action: 'message'; text: string }
  /** Итог сезона и резерв — только у «На смене», остальные попадают в failed с причиной */
  | { action: 'season'; season: SeasonPatch }

export type BulkResult = {
  done: { id: string; historyId: number | null; notify: NotifyPlan | null }[]
  failed: { id: string; error: string }[]
  /** Кому нужно позвонить: заявки с сайта или без подключённого бота */
  calls: { id: string; name: string; phone: string; text: string }[]
  applications: HrApplication[]
}

export async function bulk(deps: NotifyDeps, ids: string[], a: BulkAction, by: HrUser): Promise<BulkResult> {
  const out: BulkResult = { done: [], failed: [], calls: [], applications: [] }
  for (const id of ids) {
    const current = await deps.workflow.get(id)
    if (current?.anonymizedAt) {
      out.failed.push({ id, error: 'Личные данные удалены' })
      continue
    }
    let r: { application: HrApplication; historyId: number | null; notify: NotifyPlan | null } | null = null
    if (a.action === 'status') {
      const lastName = a.lastNames?.[id]?.trim()
      if (lastName && current && !current.lastName) await deps.workflow.setProfile(id, { lastName }, by)
      r = await changeStatus(deps, id, a.status, by, { comment: a.comment, declineReason: a.declineReason, slot: a.slots?.[id] ?? a.slot })
    }
    else if (a.action === 'message') r = await sendMessage(deps, id, a.text, by)
    else if (a.action === 'season') {
      const set = await deps.workflow.setSeason(id, a.season, by)
      if (set && 'error' in set) {
        out.failed.push({ id, error: set.error })
        continue
      }
      r = set ? { application: set.application, historyId: set.historyId, notify: null } : null
    } else {
      const set = await deps.workflow.setAssignee(id, a.assigneeId, by)
      const app = set ? await deps.workflow.get(id) : null
      r = app && set ? { application: app, historyId: set.historyId, notify: null } : null
    }
    if (!r) {
      out.failed.push({ id, error: 'Заявка не найдена' })
      continue
    }
    out.done.push({ id, historyId: r.historyId, notify: r.notify })
    out.applications.push(r.application)
    // В списке звонков — полное имя: фамилия, имя, отчество, если кандидат их указал
    const fullName = [r.application.lastName, r.application.name, r.application.middleName].filter(Boolean).join(' ')
    if (r.notify?.notify === 'call') out.calls.push({ id, name: fullName, phone: r.application.phone, text: r.notify.text })
  }
  return out
}
