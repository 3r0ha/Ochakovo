import {
  CHECKIN_CALL_NOTE,
  CHECKIN_NOTE,
  checkinAnchor,
  checkinAnswerLabel,
  checkinAnswers,
  checkinAskNote,
  checkinDeadline,
  checkinHardNote,
  checkinReasonLabel,
  checkinStepLabel,
  checkinSteps,
  checkinTime,
  dueCheckin,
  type CheckinAnswer,
  type CheckinReason,
  type CheckinStep,
  type CheckinVia,
} from '@shared/adaptation'
import type { HrApplication } from '@shared/applications'
import { mskParts, nextWorkTime } from '@shared/workdays'
import { tokenMatches } from '../candidate/status'
import type { Sql } from '../db'
import { HrRepo, type HrUser } from '../db/hr'
import type { Job, JobsRepo } from '../db/jobs'
import { WorkflowRepo } from '../db/workflow'
import type { Button, DialogUser, HandleMeta, OutMessage } from '../dialog/types'
import { botChat, type NotifyDeps } from '../notify'

// «Как дела на смене» (shared/adaptation.ts): вопросы новичку после первой смены, через неделю и через месяц.
//   scheduleCheckins — поставить вопросы в очередь, когда HR назначил первую смену или отметил «Первая смена отработана»;
//   deliverCheckin   — задача «checkin»: вопрос с кнопками в бот, без бота — задача HR спросить при звонке;
//   answerCheckin    — ответ из бота, со страницы «Моя заявка» или со слов кандидата в HR-панели;
//   requestCall      — «Пусть HR позвонит».
// «Тяжело» от самого кандидата ставит HR задачу «перезвонить» в ближайшее рабочее время.

export type AdaptDeps = { sql: Sql; workflow: WorkflowRepo; repo: HrRepo }

/** От чьего имени пишем в историю: ответ кандидата и вопрос, заданный по расписанию */
const CANDIDATE: HrUser = { id: 0, email: '', name: 'Кандидат', role: 'hr', disabled: false, createdAt: '', lastLoginAt: null }
const SYSTEM: HrUser = { ...CANDIDATE, name: 'Система' }

const dayOf = (iso: string) => mskParts(new Date(iso)).day
const viaTitle: Record<string, string> = { telegram: 'Telegram', max: 'MAX', web: 'чат на сайте', site: '«Моя заявка»' }

/** Сообщение в бот: вопрос и три кнопки ответа */
export function checkinMessage(step: CheckinStep): OutMessage {
  const s = checkinSteps.find((x) => x.id === step)!
  const b = (id: CheckinAnswer): Button => ({ kind: 'action', text: checkinAnswers.find((a) => a.id === id)!.label, action: `ci:${step}:${id}` })
  return { text: `**${s.question}**\n${CHECKIN_NOTE}`, buttons: [[b('ok')], [b('question'), b('hard')]] }
}

/**
 * Поставить вопросы в очередь. Прежние задачи заявки отменяются: новая дата первой смены — новые вопросы.
 * Уже заданные и отвеченные шаги не повторяются, устаревшие (наступил следующий шаг) пропускаются
 */
export async function scheduleCheckins(deps: { jobs: JobsRepo }, app: HrApplication, now = Date.now()) {
  await deps.jobs.cancelWhere('checkin', 'applicationId', app.id)
  const anchor = checkinAnchor(app)
  if (!anchor || app.anonymizedAt || app.duplicateOf || app.seasonOutcome === 'left') return []
  const planned: { step: CheckinStep; at: Date }[] = []
  for (const s of checkinSteps) {
    if (app.checkins.some((c) => c.step === s.id && (c.answer || c.askedAt))) continue
    if (checkinDeadline(anchor, s.id).getTime() <= now) continue
    const at = new Date(Math.max(checkinTime(anchor, s.id).getTime(), now))
    const key = `checkin:${app.id}:${s.id}:${dayOf(anchor)}`
    if (!(await deps.jobs.enqueue('checkin', at, { applicationId: app.id, step: s.id, anchor }, key))) await deps.jobs.revive(key, at)
    planned.push({ step: s.id, at })
  }
  return planned
}

async function markAsked(sql: Sql, applicationId: string, step: CheckinStep, via: 'bot' | 'call') {
  await sql`
    insert into application_checkins (application_id, step, asked_at, asked_via) values (${applicationId}, ${step}, now(), ${via})
    on conflict (application_id, step) do update set asked_at = coalesce(application_checkins.asked_at, now()), asked_via = ${via}`
}

/** Бота нет или он не доставил: HR спросит при звонке. Своя задача «перезвонить» не затирает чужую */
async function askByCall(deps: AdaptDeps, app: HrApplication, step: CheckinStep, why = '') {
  await markAsked(deps.sql, app.id, step, 'call')
  const note = checkinAskNote(step)
  if (!app.callbackAt) await deps.workflow.setCallback(app.id, nextWorkTime(Date.now(), await deps.repo.workSettings()), note, SYSTEM)
  else await deps.workflow.comment(app.id, null, `${note} — при ближайшем звонке${why ? `. ${why}` : ''}`, 'checkin')
}

/** Выполнить задачу «checkin»: только если заявка та же, первая смена не перенесена и ответа ещё нет */
export async function deliverCheckin(deps: NotifyDeps & { sql: Sql }, job: Job) {
  const { applicationId, step, anchor } = job.payload as { applicationId: string; step: string; anchor: string }
  if (!checkinSteps.some((s) => s.id === step)) return 'skipped' as const
  const s = step as CheckinStep
  const app = await deps.workflow.get(applicationId)
  if (!app || app.duplicateOf || app.anonymizedAt || app.seasonOutcome === 'left') return 'cancelled' as const
  const current = checkinAnchor(app)
  if (!current || dayOf(current) !== dayOf(anchor)) return 'cancelled' as const
  if (app.checkins.some((c) => c.step === s && (c.answer || c.askedAt))) return 'skipped' as const
  // Время вопроса ещё не пришло (задачу взяли раньше срока) или уже прошло — не спрашиваем
  if (checkinTime(current, s).getTime() > Date.now() + 60e3 || checkinDeadline(current, s).getTime() <= Date.now()) return 'skipped' as const

  const adapt: AdaptDeps = { sql: deps.sql, workflow: deps.workflow, repo: deps.repo }
  const chat = botChat(app)
  const adapter = chat ? deps.bots.get(chat.channel)?.adapter : undefined
  if (chat && adapter?.sendTo) {
    const question = checkinSteps.find((x) => x.id === s)!.question
    try {
      await adapter.sendTo(chat.userId, [checkinMessage(s)])
    } catch (e) {
      console.error(`[checkin] заявка ${app.id}: ${(e as Error).message}`)
      await askByCall(adapt, app, s, 'Бот не доставил вопрос — возможно, кандидат его заблокировал')
      return 'done' as const
    }
    await markAsked(deps.sql, app.id, s, 'bot')
    const historyId = await deps.workflow.comment(app.id, null, `Вопрос в ${chat.channel === 'max' ? 'MAX' : 'Telegram'}: «${question}»`, 'checkin')
    if (historyId) await deps.workflow.setNotify(historyId, 'sent', `отправлено в ${chat.channel === 'max' ? 'MAX' : 'Telegram'}`)
    return 'done' as const
  }
  await askByCall(adapt, app, s)
  return 'done' as const
}

export type AnswerResult = { ok: true; repeated: boolean } | { ok: false; error: 'not_found' | 'closed' }

/** Заявка открыта для вопросов: «К оформлению» или «На смене» с датой первой смены, не ушёл до конца сезона */
const closedFor = (app: HrApplication | null) => !app || app.anonymizedAt || app.duplicateOf || !checkinAnchor(app) || app.seasonOutcome === 'left'

/**
 * Записать ответ. Переответить можно — запись меняется. «Тяжело» от кандидата — задача HR поговорить;
 * ответ на вопрос, который HR должен был задать при звонке, снимает эту задачу
 */
export async function answerCheckin(
  deps: AdaptDeps,
  applicationId: string,
  step: CheckinStep,
  answer: CheckinAnswer,
  reason: CheckinReason | '',
  via: CheckinVia,
  by: HrUser = CANDIDATE,
): Promise<AnswerResult> {
  const app = await deps.workflow.get(applicationId)
  if (!app || closedFor(app)) return { ok: false, error: app ? 'closed' : 'not_found' }
  const before = app.checkins.find((c) => c.step === step)
  const r = answer === 'hard' ? reason : ''
  const repeated = before?.answer === answer && before.reason === r
  await deps.sql`
    insert into application_checkins (application_id, step, answer, reason, answered_at, answered_via)
    values (${app.id}, ${step}, ${answer}, ${r}, now(), ${via})
    on conflict (application_id, step) do update set answer = ${answer}, reason = ${r}, answered_at = now(), answered_via = ${via}`
  if (repeated) return { ok: true, repeated: true }

  const where = via === 'hr' ? 'со слов кандидата' : `в ${viaTitle[via] ?? via}`
  await deps.workflow.comment(app.id, by, `${checkinStepLabel(step)}: ${checkinAnswerLabel(answer).toLowerCase()}${r ? ` — ${checkinReasonLabel(r).toLowerCase()}` : ''} (${where})`, 'checkin')

  const askNote = checkinAskNote(step)
  const hardNote = checkinHardNote(step, r)
  if (answer === 'hard' && via !== 'hr') {
    // Причину выбирают вторым нажатием: задача уже стоит — меняем только её текст, без новой строки истории
    const pending = app.callbackAt && (app.callbackNote === checkinHardNote(step, '') || app.callbackNote === askNote)
    if (pending && before?.answer === 'hard') await deps.sql`update applications set callback_note = ${hardNote} where id = ${app.id}`
    else await deps.workflow.setCallback(app.id, nextWorkTime(Date.now(), await deps.repo.workSettings()), hardNote, by)
  } else if (app.callbackAt && app.callbackNote === askNote) {
    await deps.workflow.setCallback(app.id, null, '', by)
  }
  return { ok: true, repeated: false }
}

/** «Пусть HR позвонит» — новичку, у которого есть вопросы. Пока задача стоит, повтор её не дублирует */
export async function requestCall(deps: AdaptDeps, applicationId: string): Promise<AnswerResult> {
  const app = await deps.workflow.get(applicationId)
  if (!app || closedFor(app)) return { ok: false, error: app ? 'closed' : 'not_found' }
  if (app.callbackAt && app.callbackNote === CHECKIN_CALL_NOTE) return { ok: true, repeated: true }
  // Звонок уже назначен по другой причине — не затираем его текст, просьбу пишем в историю
  if (app.callbackAt) {
    await deps.workflow.comment(app.id, CANDIDATE, `${CHECKIN_CALL_NOTE}. Задача «перезвонить» уже стоит`, 'checkin')
    return { ok: true, repeated: false }
  }
  await deps.workflow.setCallback(app.id, nextWorkTime(Date.now(), await deps.repo.workSettings()), CHECKIN_CALL_NOTE, CANDIDATE)
  return { ok: true, repeated: false }
}

/** Что показать кандидату: вопрос, который ждёт ответа, и можно ли попросить звонок */
export type CheckinView = {
  /** Вопрос ждёт ответа; null — сейчас ничего не спрашиваем */
  step: CheckinStep | null
  question: string
  /** Последний ответ кандидата — чтобы страница показала «Ответ уже у отдела персонала» */
  last: { step: CheckinStep; answer: CheckinAnswer; reason: CheckinReason | '' } | null
  /** «Пусть HR позвонит» — у новичков с датой первой смены */
  call: boolean
}

export function checkinView(app: HrApplication, now = Date.now()): CheckinView {
  const open = !closedFor(app)
  const step = open ? dueCheckin(app, now) : null
  const answered = app.checkins.filter((c) => c.answer && c.answeredAt).sort((a, b) => a.answeredAt!.localeCompare(b.answeredAt!)).at(-1)
  return {
    step,
    question: step ? checkinSteps.find((s) => s.id === step)!.question : '',
    last: answered && answered.answer ? { step: answered.step, answer: answered.answer, reason: answered.reason } : null,
    call: open && Boolean(checkinAnchor(app)) && new Date(checkinAnchor(app)!).getTime() <= now,
  }
}

// ── Для бота ─────────────────────────────────────────────────────────────

const pgDeps = new WeakMap<Sql, AdaptDeps>()

/** Сервис для хранилища бота: только на PostgreSQL. В памяти (симулятор) — null, бот отправляет к HR */
export function adaptationDeps(storage: object): AdaptDeps | null {
  const sql = (storage as { sql?: Sql }).sql
  if (typeof sql !== 'function') return null
  let deps = pgDeps.get(sql)
  if (!deps) pgDeps.set(sql, (deps = { sql, workflow: new WorkflowRepo(sql), repo: new HrRepo(sql) }))
  return deps
}

/** Заявка человека для вопросов: в мессенджере — по чату (сначала «К оформлению» и «На смене»), в чате на сайте — по ключу браузера */
export async function applicationForUser(deps: AdaptDeps, user: DialogUser, meta: HandleMeta): Promise<string | null> {
  if (user.channel === 'web') {
    const a = meta.application
    return a && (await tokenMatches(deps.sql, a.id, a.token)) ? a.id : null
  }
  const [row] = await deps.sql<{ id: string }[]>`
    select id from applications
    where ((channel = ${user.channel} and channel_user_id = ${user.id}) or (bot_channel = ${user.channel} and bot_user_id = ${user.id}))
      and anonymized_at is null and duplicate_of is null
    order by (status in ('hired', 'started')) desc, created_at desc limit 1`
  return row?.id ?? null
}
