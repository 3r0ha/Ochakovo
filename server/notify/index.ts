import type { HrApplication, InterviewSlot, NotifyState, TemplateKey } from '@shared/applications'
import { contacts } from '@shared/content/content'
import { placeholders, renderTemplate } from '@shared/notifyText'
import { hrReminderTime, mskParts } from '@shared/workdays'
import type { Registry } from '../channels/registry'
import type { HrRepo, HrUser } from '../db/hr'
import type { Job, JobsRepo } from '../db/jobs'
import { REMIND_NOTE, REMIND_SHIFT_NOTE, type WorkflowRepo } from '../db/workflow'
import type { OutMessage } from '../dialog/types'
import { maskPhone, providerName, sendSms, smsPhone, SmsError, type SmsConfig } from '../sms'

// Сообщения кандидатам: о смене статуса, приглашение на собеседование, напоминание накануне,
// произвольное сообщение из массовых действий. Отправка идёт через очередь с задержкой —
// пока сообщение не ушло, HR может отменить действие.
// Куда: в бот, если кандидат пришёл из бота и бот подключён. Иначе приглашение и напоминание
// можно отправить SMS (если подключён провайдер), а в остальных случаях HR получает текст для звонка.

export type NotifyDeps = { repo: HrRepo; workflow: WorkflowRepo; jobs: JobsRepo; bots: Registry; sms: SmsConfig | null }

/** Сколько ждать перед отправкой, чтобы успеть нажать «Отменить» */
export const notifyDelayMs = () => {
  const v = Number(process.env.HR_NOTIFY_DELAY_SECONDS)
  return (Number.isFinite(v) && v >= 0 ? v : 20) * 1000
}

export { placeholders, renderTemplate }

/** Какой текст положен при переходе в статус */
export function templateFor(status: HrApplication['status'], hasSlot: boolean): TemplateKey | null {
  if (status === 'interview') return hasSlot ? 'interview' : 'interview_call'
  if (status === 'hired' || status === 'declined') return status
  return null
}

/** Для каких сообщений есть короткий SMS-вариант */
const smsVariant: Partial<Record<TemplateKey, TemplateKey>> = { interview: 'sms_interview', reminder: 'sms_reminder', shift_reminder: 'sms_shift_reminder' }

export type NotifyPlan =
  | { notify: 'queued'; detail: string; sendAt: string }
  | { notify: 'call'; detail: string; text: string }
  | { notify: 'skipped'; detail: string }

const botChannels = ['telegram', 'max']
const channelTitle = (c: string | null | undefined) => (c === 'max' ? 'MAX' : 'Telegram')

/**
 * Чат кандидата с ботом: заявка из бота — его чат; заявка с сайта, которую кандидат привязал к боту, — привязанный чат.
 * null — чата с ботом у кандидата нет
 */
export function botChat(app: Pick<HrApplication, 'channel' | 'channelUserId' | 'botChannel' | 'botUserId'>): { channel: 'telegram' | 'max'; userId: string } | null {
  if (app.channel && botChannels.includes(app.channel) && app.channelUserId) return { channel: app.channel as 'telegram' | 'max', userId: app.channelUserId }
  if (app.botChannel && app.botUserId) return { channel: app.botChannel, userId: app.botUserId }
  return null
}

/** Бот, через который можно написать кандидату; null — у кандидата нет чата с ботом или бот выключен */
function botFor(deps: NotifyDeps, app: HrApplication) {
  const chat = botChat(app)
  if (!chat) return null
  const adapter = deps.bots.get(chat.channel)?.adapter
  return adapter?.sendTo ? { adapter, ...chat } : null
}

const noBotReason = (app: HrApplication) => {
  const chat = botChat(app)
  if (chat) return `бот ${channelTitle(chat.channel)} сейчас не подключён`
  return app.channel === 'hr' ? 'кандидат добавлен вручную, бота у него нет' : 'заявка с сайта, бота у кандидата нет'
}

/** Текст SMS по шаблону, если SMS подключены, номер мобильный и шаблон включён */
async function smsText(deps: NotifyDeps, app: HrApplication, key: TemplateKey | undefined) {
  if (!deps.sms || !key || !smsPhone(app.phone)) return null
  const t = await deps.repo.template(key)
  return t?.enabled ? renderTemplate(t.text, app, app.interview) : null
}

/**
 * Поставить сообщение в очередь: в бот или SMS. Если ни того ни другого — вернуть текст, чтобы HR позвонил сам.
 */
export async function queueMessage(
  deps: NotifyDeps,
  app: HrApplication,
  historyId: number,
  what: { key: TemplateKey } | { text: string },
): Promise<NotifyPlan> {
  let text: string
  if ('key' in what) {
    const template = await deps.repo.template(what.key)
    if (!template?.enabled) {
      const plan = { notify: 'skipped', detail: 'уведомление для этого статуса выключено' } as const
      await deps.workflow.setNotify(historyId, plan.notify, plan.detail)
      return plan
    }
    text = renderTemplate(template.text, app, app.interview)
  } else text = what.text

  const sendAt = new Date(Date.now() + notifyDelayMs())
  const bot = botFor(deps, app)
  if (bot) {
    await deps.jobs.enqueue('notify', sendAt, { applicationId: app.id, historyId, text }, `notify:${historyId}`)
    const detail = `уйдёт в ${channelTitle(bot.channel)}`
    await deps.workflow.setNotify(historyId, 'queued', detail)
    return { notify: 'queued', detail, sendAt: sendAt.toISOString() }
  }

  const sms = 'key' in what ? await smsText(deps, app, smsVariant[what.key]) : null
  if (sms) {
    await deps.jobs.enqueue('notify', sendAt, { applicationId: app.id, historyId, text: sms, via: 'sms' }, `notify:${historyId}`)
    const detail = `уйдёт SMS на ${maskPhone(app.phone)}`
    await deps.workflow.setNotify(historyId, 'queued', detail)
    return { notify: 'queued', detail, sendAt: sendAt.toISOString() }
  }

  const detail = noBotReason(app)
  await deps.workflow.setNotify(historyId, 'call', detail)
  return { notify: 'call', detail, text }
}

/** Отменить ещё не отправленное сообщение — при отмене действия */
export async function cancelQueued(deps: NotifyDeps, historyId: number) {
  if (await deps.jobs.cancel(`notify:${historyId}`)) await deps.workflow.setNotify(historyId, 'cancelled', 'отменено до отправки')
}

type Delivery = { state: NotifyState; detail: string }

async function sendBot(deps: NotifyDeps, app: HrApplication, text: string): Promise<Delivery> {
  const bot = botFor(deps, app)
  if (!bot) return { state: 'call', detail: `${noBotReason(app)}, позвони кандидату` }
  const message: OutMessage = { text, buttons: [[{ kind: 'action', text: 'Меню', action: 'm' }]] }
  try {
    await bot.adapter.sendTo!(bot.userId, [message])
    return { state: 'sent', detail: `отправлено в ${channelTitle(bot.channel)}` }
  } catch (e) {
    console.error(`[notify] заявка ${app.id}: ${(e as Error).message}`)
    return { state: 'failed', detail: 'бот не смог доставить сообщение — возможно, кандидат его заблокировал. Позвони' }
  }
}

/** SMS: постоянная ошибка — «не доставлено», временная — исключение, очередь повторит */
async function sendViaSms(deps: NotifyDeps, app: HrApplication, text: string): Promise<Delivery> {
  if (!deps.sms) return { state: 'call', detail: 'SMS отключены, позвони кандидату' }
  try {
    const r = await sendSms(deps.sms, app.phone, text)
    return { state: 'sent', detail: `SMS через ${providerName(deps.sms.provider)}${r.parts > 1 ? `, ${r.parts} части` : ''}` }
  } catch (e) {
    if (e instanceof SmsError && e.permanent) {
      console.error(`[sms] заявка ${app.id}: ${e.message}`)
      return { state: 'failed', detail: `${e.message}. Позвони кандидату` }
    }
    throw e
  }
}

/** Выполнить задачу «notify» из очереди */
export async function deliverNotification(deps: NotifyDeps, job: Job) {
  const { applicationId, historyId, text, via } = job.payload as { applicationId: string; historyId: number; text: string; via?: 'sms' }
  const app = await deps.workflow.get(applicationId)
  if (!app) return 'skipped' as const
  const result = via === 'sms' ? await sendViaSms(deps, app, text) : await sendBot(deps, app, text)
  await deps.workflow.setNotify(historyId, result.state, result.detail)
  return result.state === 'sent' ? ('done' as const) : ('skipped' as const)
}

/** Задача окончательно не выполнилась: отметить в истории, чтобы HR позвонил */
export async function notificationFailed(deps: NotifyDeps, job: Job, error: string) {
  const historyId = Number(job.payload.historyId)
  if (job.kind === 'notify' && historyId) await deps.workflow.setNotify(historyId, 'failed', `${error}. Позвони кандидату`)
}

// ── Напоминание накануне собеседования ────────────────────────────────────

/** Кандидату: накануне в 12:00 по Москве. Если поздно — сразу, но не позже чем за 6 часов до встречи */
export function reminderTime(startsAt: Date, now = Date.now()): Date | null {
  // Сдвигаем в «московское» время, ставим 12:00 предыдущего дня и возвращаем обратно
  const wall = new Date(startsAt.getTime() + 3 * 3600e3 - 864e5)
  wall.setUTCHours(12, 0, 0, 0)
  const day = new Date(wall.getTime() - 3 * 3600e3)
  if (day.getTime() > now) return day
  return startsAt.getTime() - now > 6 * 3600e3 ? new Date(now) : null
}

/**
 * Запланировать напоминание: кандидату из бота — сообщением, без бота — SMS (если подключены),
 * иначе HR получает задачу «перезвонить» в предыдущий рабочий день, в рабочее время.
 * Повторный вызов для того же собеседования ничего не дублирует.
 */
export async function scheduleReminder(deps: NotifyDeps, app: HrApplication, interview: InterviewSlot, by: HrUser) {
  await deps.jobs.cancelWhere('reminder', 'applicationId', app.id)
  const bot = Boolean(botFor(deps, app))
  const sms = !bot && Boolean(await smsText(deps, app, 'sms_reminder'))
  if (!bot && !sms) {
    const at = hrReminderTime(new Date(interview.startsAt), Date.now(), await deps.repo.workSettings())
    if (!at) return null
    await deps.workflow.setCallback(app.id, at, REMIND_NOTE, by)
    return { kind: 'callback' as const, at }
  }
  const at = reminderTime(new Date(interview.startsAt))
  if (!at) return null
  const key = `reminder:${interview.id}`
  const payload = { applicationId: app.id, interviewId: interview.id, ...(sms ? { via: 'sms' } : {}) }
  if (!(await deps.jobs.enqueue('reminder', at, payload, key))) await deps.jobs.revive(key, at)
  return { kind: sms ? ('sms' as const) : ('message' as const), at }
}

/** Выполнить задачу «reminder»: только если собеседование то же и статус всё ещё «Собеседование» */
export async function deliverReminder(deps: NotifyDeps, job: Job) {
  const { applicationId, interviewId, via } = job.payload as { applicationId: string; interviewId: number; via?: 'sms' }
  const app = await deps.workflow.get(applicationId)
  if (!app || app.duplicateOf || app.status !== 'interview' || app.interview?.id !== interviewId) return 'cancelled' as const
  const template = await deps.repo.template(via === 'sms' ? 'sms_reminder' : 'reminder')
  if (!template?.enabled) return 'skipped' as const
  const text = renderTemplate(template.text, app, app.interview)
  const result = via === 'sms' ? await sendViaSms(deps, app, text) : await sendBot(deps, app, text)
  const historyId = await deps.workflow.comment(applicationId, null, 'Напоминание о собеседовании', 'message')
  if (historyId) await deps.workflow.setNotify(historyId, result.state, result.detail)
  return result.state === 'sent' ? ('done' as const) : ('skipped' as const)
}

// ── Напоминание накануне первой смены ─────────────────────────────────────

/** Адрес и «что взять» для текста о первой смене: подстановки {address} и {bring} те же, что у собеседования */
const shiftPlace = (firstShiftAt: string) => ({ startsAt: firstShiftAt, address: contacts.address, bring: 'паспорт' })

/** Ключ задачи: заявка и день первой смены. Другая дата — другая задача, старая отменяется */
export const shiftReminderKey = (applicationId: string, firstShiftAt: string) => `shift:${applicationId}:${mskParts(new Date(firstShiftAt)).day}`

/**
 * Запланировать напоминание о первой смене: только у «К оформлению» с датой первой смены. Кандидату с ботом — сообщением
 * накануне в 12:00, без бота — SMS (если подключены), иначе HR получает задачу «Напомнить о первой смене» в предыдущий рабочий день.
 * Прежнее напоминание этой заявки отменяется: при смене даты старое не уходит
 */
export async function scheduleShiftReminder(deps: NotifyDeps, app: HrApplication, by: HrUser) {
  await deps.jobs.cancelWhere('shift_reminder', 'applicationId', app.id)
  if (app.status !== 'hired' || !app.firstShiftAt) return null
  const startsAt = new Date(app.firstShiftAt)
  const bot = Boolean(botFor(deps, app))
  const sms = !bot && Boolean(await smsText(deps, app, 'sms_shift_reminder'))
  if (!bot && !sms) {
    const at = hrReminderTime(startsAt, Date.now(), await deps.repo.workSettings())
    if (!at) return null
    await deps.workflow.setCallback(app.id, at, REMIND_SHIFT_NOTE, by)
    return { kind: 'callback' as const, at }
  }
  const at = reminderTime(startsAt)
  if (!at) return null
  const key = shiftReminderKey(app.id, app.firstShiftAt)
  const payload = { applicationId: app.id, firstShiftAt: startsAt.toISOString(), ...(sms ? { via: 'sms' } : {}) }
  if (!(await deps.jobs.enqueue('shift_reminder', at, payload, key))) await deps.jobs.revive(key, at)
  return { kind: sms ? ('sms' as const) : ('message' as const), at }
}

/** Выполнить задачу «shift_reminder»: только если заявка всё ещё «К оформлению» и дата первой смены та же */
export async function deliverShiftReminder(deps: NotifyDeps, job: Job) {
  const { applicationId, firstShiftAt, via } = job.payload as { applicationId: string; firstShiftAt: string; via?: 'sms' }
  const app = await deps.workflow.get(applicationId)
  if (!app || app.duplicateOf || app.anonymizedAt || app.status !== 'hired' || !app.firstShiftAt) return 'cancelled' as const
  if (new Date(app.firstShiftAt).getTime() !== new Date(firstShiftAt).getTime()) return 'cancelled' as const
  const template = await deps.repo.template(via === 'sms' ? 'sms_shift_reminder' : 'shift_reminder')
  if (!template?.enabled) return 'skipped' as const
  const text = renderTemplate(template.text, app, shiftPlace(app.firstShiftAt))
  const result = via === 'sms' ? await sendViaSms(deps, app, text) : await sendBot(deps, app, text)
  const historyId = await deps.workflow.comment(applicationId, null, 'Напоминание о первой смене', 'message')
  if (historyId) await deps.workflow.setNotify(historyId, result.state, result.detail)
  return result.state === 'sent' ? ('done' as const) : ('skipped' as const)
}
