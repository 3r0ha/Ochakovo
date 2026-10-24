import type postgres from 'postgres'
import {
  isAttendance,
  isDeclineReason,
  isManualConsent,
  normalizePracticeDocs,
  practiceDocsLabel,
  isSeasonLeaveReason,
  isSeasonOutcome,
  isShiftKind,
  isStatus,
  seasonLeaveReasonLabel,
  seasonOutcomes,
  UNDO_WINDOW_MS,
  type ApplicationStatus,
  type Attendance,
  type DeclineReason,
  type HistoryEntry,
  type ApplicationInput,
  type HistoryKind,
  type HrApplication,
  type ManualConsent,
  type NotifyState,
  type PracticeDoc,
  type SeasonLeaveReason,
  type SeasonOutcome,
  type ShiftKind,
} from '@shared/applications'
import { isCheckinAnswer, isCheckinReason, isCheckinStep, type Checkin } from '@shared/adaptation'
import { firstShiftOf } from '@shared/candidateStatus'
import type { HrUser } from './hr'
import { monthsRange } from '@shared/hr'
import { makeApplicationId } from '@shared/demo'
import { isAdultByBirthDate, normalizeBirthDate } from '@shared/birthDate'
import { birthDateOf, normalizeApplication, normalizeProfile, practiceDocsOf, toApplication, type ApplicationRow, type Sql } from './index'

// Работа HR с заявкой: статусы с историей и отменой, ответственный, недозвоны и «перезвонить»,
// собеседования, анкета, дубли по телефону и склейка.

type Tx = postgres.TransactionSql | Sql

/** Строка application_checkins в json_agg: время приходит строкой */
type CheckinJson = { step: string; asked_at: string | null; asked_via: string; answer: string; reason: string; answered_at: string | null; answered_via: string }

const iso = (v: string | null) => (v ? new Date(v).toISOString() : null)

/** «Как дела на смене» из базы — в порядке шагов */
export const checkinsOf = (rows: CheckinJson[] | null): Checkin[] =>
  (rows ?? [])
    .filter((r) => isCheckinStep(r.step))
    .map((r): Checkin => ({
      step: r.step as Checkin['step'],
      askedAt: iso(r.asked_at),
      askedVia: r.asked_via === 'bot' || r.asked_via === 'call' ? r.asked_via : '',
      answer: isCheckinAnswer(r.answer) ? r.answer : '',
      reason: isCheckinReason(r.reason) ? r.reason : '',
      answeredAt: iso(r.answered_at),
      answeredVia: (['telegram', 'max', 'web', 'site', 'hr'] as const).find((v) => v === r.answered_via) ?? '',
    }))
    .sort((a, b) => ['shift1', 'week1', 'month1'].indexOf(a.step) - ['shift1', 'week1', 'month1'].indexOf(b.step))

type HrRow = ApplicationRow & {
  checkins: CheckinJson[] | null
  phone_norm: string
  assignee_id: string | null
  assignee_name: string | null
  no_answer_count: number
  callback_at: Date | null
  callback_note: string
  decline_reason: string
  duplicate_of: string | null
  duplicates: number
  reached: string[] | null
  interview_id: string | null
  interview_starts_at: Date | null
  interview_address: string | null
  interview_bring: string | null
  interview_attended: string | null
  interview_attended_at: Date | null
  interview_self_booked: boolean | null
  anonymized_at: Date | null
  anonymized_reason: string
  // 013: кто из HR отметил согласие
  consent_by?: string
  /** Код приглашения из сессии бота — у заявок из бота и привязанных к нему */
  bot_ref: string | null
}

const toHr = (r: HrRow): HrApplication => ({
  ...toApplication(r),
  // Код «Позвать друга»: с сайта — из заявки, из бота — из сессии. По нему находятся пары «Идут вдвоём»
  refCode: r.ref_code ?? r.bot_ref ?? null,
  status: isStatus(r.status) ? r.status : 'new',
  assigneeId: r.assignee_id === null ? null : Number(r.assignee_id),
  assigneeName: r.assignee_name,
  noAnswerCount: r.no_answer_count,
  callbackAt: r.callback_at?.toISOString() ?? null,
  callbackNote: r.callback_note,
  declineReason: isDeclineReason(r.decline_reason) ? r.decline_reason : '',
  duplicateOf: r.duplicate_of,
  duplicates: r.duplicates,
  reached: (r.reached ?? []).filter(isStatus),
  interview:
    r.interview_id && r.interview_starts_at
      ? {
          id: Number(r.interview_id),
          startsAt: r.interview_starts_at.toISOString(),
          address: r.interview_address ?? '',
          bring: r.interview_bring ?? '',
          attended: isAttendance(r.interview_attended) ? r.interview_attended : '',
          attendedAt: r.interview_attended_at?.toISOString() ?? null,
          selfBooked: r.interview_self_booked ?? false,
        }
      : null,
  anonymizedAt: r.anonymized_at?.toISOString() ?? null,
  anonymizedReason: r.anonymized_reason === 'retention' || r.anonymized_reason === 'request' ? r.anonymized_reason : '',
  suspectedSpam: r.suspected_spam ?? false,
  onboardingAt: r.onboarding_at?.toISOString() ?? null,
  firstShiftAt: r.first_shift_at?.toISOString() ?? null,
  shiftKind: isShiftKind(r.shift_kind) ? r.shift_kind : '',
  onboardingNote: r.onboarding_note ?? '',
  seasonOutcome: isSeasonOutcome(r.season_outcome) ? r.season_outcome : '',
  seasonLeaveReason: isSeasonLeaveReason(r.season_leave_reason) ? r.season_leave_reason : '',
  reserve: r.reserve ?? false,
  botChannel: r.bot_channel === 'telegram' || r.bot_channel === 'max' ? r.bot_channel : null,
  botUserId: r.bot_user_id ?? null,
  mentorName: r.mentor_name ?? '',
  practiceDocs: practiceDocsOf(r),
  consentBy: r.consent_by ?? '',
  checkins: checkinsOf(r.checkins),
})

/** Прежние значения заявки — чтобы отменить действие */
type UndoData = {
  status: ApplicationStatus
  statusUpdatedAt: string
  declineReason: string
  noAnswerCount: number
  assigneeId: number | null
  /** Собеседование, созданное этим действием, — при отмене отменяется */
  createdInterviewId?: number
  /** Собеседование, отменённое этим действием, — при отмене восстанавливается */
  cancelledInterviewId?: number
  /** Явка до этого действия — при отмене возвращается как была */
  attendance?: { interviewId: number; attended: Attendance; attendedAt: string | null; attendedBy: number | null }
  /** Итог сезона до действия: уход со статуса «На смене» его очищает, отмена возвращает */
  seasonOutcome?: string
  seasonLeaveReason?: string
}

type HistoryRow = {
  id: string
  created_at: Date
  user_id: string | null
  user_name: string
  kind: string
  from_status: string | null
  to_status: string
  comment: string
  notify: string | null
  notify_detail: string
  undone_at: Date | null
}

const toHistory = (r: HistoryRow): HistoryEntry => ({
  id: Number(r.id),
  createdAt: r.created_at.toISOString(),
  userId: r.user_id === null ? null : Number(r.user_id),
  userName: r.user_name,
  kind: r.kind as HistoryKind,
  fromStatus: isStatus(r.from_status) ? r.from_status : null,
  toStatus: isStatus(r.to_status) ? r.to_status : 'new',
  comment: r.comment,
  notify: (r.notify as NotifyState) ?? null,
  notifyDetail: r.notify_detail,
  undoneAt: r.undone_at?.toISOString() ?? null,
})

/** Задача HR, которую ставит напоминание для кандидата с сайта */
export const REMIND_NOTE = 'Напомнить о собеседовании'

/** Задача HR накануне первой смены — для кандидата без бота и SMS */
export const REMIND_SHIFT_NOTE = 'Напомнить о первой смене'

/** Записи истории об отметке явки (вид interview: событие собеседования без смены статуса) */
export const ATTENDED_NOTE = 'Явка на собеседование'
export const NO_SHOW_NOTE = 'Неявка на собеседование'

/** Явку можно отметить за час до начала собеседования и позже */
export const ATTENDANCE_EARLY_MS = 3600e3

/** Сжатая строка обезличенной заявки для плиток списка: время заявки и дальний этап (0 — заявка, 1 — собеседование, 2 — к оформлению, 3 — на смене) */
export type ErasedStage = [createdAt: string, stage: 0 | 1 | 2 | 3]

export type SlotInput = { startsAt: Date; address: string; bring: string }

/** Оформление и первая смена (PATCH onboarding). Ключи, которых нет, не меняются; null стирает дату */
export type OnboardingPatch = { onboardingAt?: string | null; firstShiftAt?: string | null; shiftKind?: ShiftKind | ''; onboardingNote?: string }

/** Итог сезона и резерв (PATCH season, массово). Только для «На смене» */
export type SeasonPatch = { seasonOutcome?: SeasonOutcome | ''; seasonLeaveReason?: SeasonLeaveReason | ''; reserve?: boolean }

/** Строка истории о согласии, которое отметил сотрудник */
const consentText: Record<ManualConsent, string> = {
  hr_verbal: 'Согласие получено устно',
  job_board: 'Согласие дано при отклике на работном сайте',
  none: 'Согласия нет',
}

/** Дату оформления и первой смены ставят в пределах года назад и года вперёд: дальше — почти наверняка опечатка */
const ONBOARDING_RANGE_MS = 366 * 864e5

/** Строка истории об оформлении: что именно поменяли */
function onboardingNote(patch: OnboardingPatch, saved: Pick<HrApplication, 'status' | 'onboardingAt' | 'firstShiftAt' | 'shiftKind'>) {
  const keys = Object.keys(patch)
  const when = (iso: string) => new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' })
  if (keys.includes('firstShiftAt') || keys.includes('shiftKind'))
    return saved.firstShiftAt ? `Первая смена: ${firstShiftOf({ ...saved, status: 'hired' })!.text}` : 'Дата первой смены снята'
  if (keys.length === 1 && keys[0] === 'onboardingAt') return saved.onboardingAt ? `Оформление: ${when(saved.onboardingAt)}` : 'Дата оформления снята'
  if (keys.length === 1 && keys[0] === 'onboardingNote') return 'Заметка об оформлении'
  return 'Оформление обновлено'
}

/**
 * Что HR правит в анкете (PATCH profile): анкета под производство, месяцы, поля кейса и оформление практиканта.
 * Ключи, которых нет в патче, не меняются. Дата рождения — как ввели (ДД.ММ.ГГГГ или YYYY-MM-DD), пустая строка стирает её
 */
export type ProfilePatch = Partial<
  Pick<
    HrApplication,
    | 'lastName'
    | 'middleName'
    | 'adult'
    | 'citizenship'
    | 'medBook'
    | 'shifts'
    | 'months'
    | 'birthDate'
    | 'startReady'
    | 'startMonth'
    | 'school'
    | 'notStudying'
    | 'mentorName'
    | 'practiceDocs'
  >
>

/** Строка истории о правке анкеты: у одиночных правок — что именно поменяли */
function profileNote(patch: ProfilePatch, saved: { months: number[]; mentorName: string; practiceDocs: PracticeDoc[] }) {
  const keys = Object.keys(patch)
  if (keys.length === 1 && keys[0] === 'months') return `Месяцы работы: ${saved.months.length ? monthsRange(saved.months) : 'не указаны'}`
  if (keys.length === 1 && keys[0] === 'mentorName') return saved.mentorName ? `Наставник: ${saved.mentorName}` : 'Наставник не назначен'
  if (keys.length === 1 && keys[0] === 'practiceDocs') return `Документы по практике: ${practiceDocsLabel(saved.practiceDocs).toLowerCase() || 'ни одного'}`
  return 'Анкета дополнена'
}

export class WorkflowRepo {
  constructor(private sql: Sql) {}

  /** Заявки для панели — с ответственным, пройденными этапами, числом дублей и собеседованием */
  private select(tx: Tx, where: postgres.PendingQuery<postgres.Row[]>) {
    return tx<HrRow[]>`
      select a.*, u.name as assignee_name,
        (select array_agg(distinct h.to_status) from application_history h where h.application_id = a.id and h.undone_at is null) as reached,
        case when length(a.phone_norm) >= 10 then
          (select count(*)::int from applications d where d.phone_norm = a.phone_norm and d.id <> a.id and d.duplicate_of is null)
        else 0 end as duplicates,
        i.id as interview_id, i.starts_at as interview_starts_at, i.address as interview_address, i.bring as interview_bring,
        i.attended as interview_attended, i.attended_at as interview_attended_at, i.self_booked as interview_self_booked,
        coalesce(
          (select s.data -> 'data' ->> 'ref' from sessions s where s.channel = a.channel and s.user_id = a.channel_user_id),
          (select s.data -> 'data' ->> 'ref' from sessions s where s.channel = a.bot_channel and s.user_id = a.bot_user_id)
        ) as bot_ref,
        (select json_agg(json_build_object('step', c.step, 'asked_at', c.asked_at, 'asked_via', c.asked_via, 'answer', c.answer,
            'reason', c.reason, 'answered_at', c.answered_at, 'answered_via', c.answered_via))
          from application_checkins c where c.application_id = a.id) as checkins
      from applications a
      left join hr_users u on u.id = a.assignee_id
      left join lateral (
        select * from interviews where application_id = a.id and cancelled_at is null order by created_at desc limit 1
      ) i on true
      ${where}
      order by a.created_at desc
      limit 10000`
  }

  async list(): Promise<HrApplication[]> {
    return (await this.select(this.sql, this.sql``)).map(toHr)
  }

  /** Заявки с личными данными — без обезличенных по сроку или по запросу */
  async active(): Promise<HrApplication[]> {
    return (await this.select(this.sql, this.sql`where a.anonymized_at is null`)).map(toHr)
  }

  /**
   * Список для панели: заявки с личными данными. Обезличенные (по сроку или по запросу) в работе не нужны —
   * от них только время и дальний этап, чтобы плитки над списком считали воронку как раньше
   */
  async desk(): Promise<{ rows: HrApplication[]; erased: ErasedStage[] }> {
    const [rows, erased] = await Promise.all([
      this.active(),
      this.sql<{ created_at: Date; stage: number }[]>`
        select a.created_at,
          case
            when a.status = 'started' or exists (select 1 from application_history h where h.application_id = a.id and h.undone_at is null and h.to_status = 'started') then 3
            when a.status = 'hired' or exists (select 1 from application_history h where h.application_id = a.id and h.undone_at is null and h.to_status = 'hired') then 2
            when a.status = 'interview' or exists (select 1 from application_history h where h.application_id = a.id and h.undone_at is null and h.to_status = 'interview') then 1
            else 0 end as stage
        from applications a
        where a.anonymized_at is not null and a.duplicate_of is null
        order by a.created_at desc`,
    ])
    return { rows, erased: erased.map((r) => [r.created_at.toISOString(), Math.max(0, Math.min(3, r.stage)) as ErasedStage[1]]) }
  }

  /** Заявки по номерам — для проверок перед массовым действием */
  async byIds(ids: string[]): Promise<HrApplication[]> {
    if (!ids.length) return []
    return (await this.select(this.sql, this.sql`where a.id in ${this.sql(ids)}`)).map(toHr)
  }

  async get(id: string, tx: Tx = this.sql): Promise<HrApplication | null> {
    const [row] = await this.select(tx, tx`where a.id = ${id}`)
    return row ? toHr(row) : null
  }

  async history(applicationId: string): Promise<HistoryEntry[]> {
    const rows = await this.sql<HistoryRow[]>`select * from application_history where application_id = ${applicationId} order by created_at, id`
    return rows.map(toHistory)
  }

  /** Другие активные заявки с тем же телефоном */
  async samePhone(app: HrApplication): Promise<HrApplication[]> {
    const rows = await this.select(
      this.sql,
      this.sql`where a.id <> ${app.id} and a.duplicate_of is null and length(a.phone_norm) >= 10
        and a.phone_norm = (select phone_norm from applications where id = ${app.id})`,
    )
    return rows.map(toHr)
  }

  /** Склеенные с этой заявкой дубли */
  async merged(app: HrApplication): Promise<HrApplication[]> {
    return (await this.select(this.sql, this.sql`where a.duplicate_of = ${app.id}`)).map(toHr)
  }

  private async lock(tx: Tx, id: string) {
    const [row] = await tx<
      {
        status: string
        status_updated_at: Date
        decline_reason: string
        no_answer_count: number
        assignee_id: string | null
        season_outcome: string
        season_leave_reason: string
      }[]
    >`select status, status_updated_at, decline_reason, no_answer_count, assignee_id, season_outcome, season_leave_reason
      from applications where id = ${id} for update`
    if (!row) return null
    const undo: UndoData = {
      status: isStatus(row.status) ? row.status : 'new',
      statusUpdatedAt: row.status_updated_at.toISOString(),
      declineReason: row.decline_reason,
      noAnswerCount: row.no_answer_count,
      assigneeId: row.assignee_id === null ? null : Number(row.assignee_id),
      seasonOutcome: row.season_outcome ?? '',
      seasonLeaveReason: row.season_leave_reason ?? '',
    }
    return undo
  }

  private async log(
    tx: Tx,
    e: { applicationId: string; by: HrUser | null; kind: HistoryKind; from: ApplicationStatus | null; to: ApplicationStatus; comment?: string; undo?: UndoData },
  ) {
    const [row] = await tx<{ id: string }[]>`
      insert into application_history (application_id, user_id, user_name, kind, from_status, to_status, comment, undo_data)
      values (${e.applicationId}, ${e.by && e.by.id > 0 ? e.by.id : null}, ${e.by?.name ?? 'Система'}, ${e.kind}, ${e.from}, ${e.to},
              ${(e.comment ?? '').slice(0, 2000)}, ${e.undo ? tx.json(e.undo as unknown as postgres.JSONValue) : null})
      returning id`
    return Number(row.id)
  }

  /** Явка текущего собеседования заявки — чтобы вернуть её при отмене */
  private async currentAttendance(tx: Tx, applicationId: string) {
    const [i] = await tx<{ id: string; starts_at: Date; attended: string; attended_at: Date | null; attended_by: string | null }[]>`
      select id, starts_at, attended, attended_at, attended_by from interviews
      where application_id = ${applicationId} and cancelled_at is null order by created_at desc limit 1 for update`
    if (!i) return null
    return {
      startsAt: i.starts_at,
      undo: {
        interviewId: Number(i.id),
        attended: isAttendance(i.attended) ? i.attended : '',
        attendedAt: i.attended_at?.toISOString() ?? null,
        attendedBy: i.attended_by === null ? null : Number(i.attended_by),
      } satisfies NonNullable<UndoData['attendance']>,
    }
  }

  /** Новое собеседование: прежнее активное отменяется */
  private async replaceInterview(tx: Tx, applicationId: string, slot: SlotInput, by: HrUser) {
    const [prev] = await tx<{ id: string }[]>`
      update interviews set cancelled_at = now() where application_id = ${applicationId} and cancelled_at is null returning id`
    const [row] = await tx<{ id: string }[]>`
      insert into interviews (application_id, starts_at, address, bring, created_by)
      values (${applicationId}, ${slot.startsAt}, ${slot.address.slice(0, 300)}, ${slot.bring.slice(0, 300)}, ${by.id > 0 ? by.id : null})
      returning id`
    return { created: Number(row.id), cancelled: prev ? Number(prev.id) : undefined }
  }

  /**
   * Сменить статус. Пишет историю с данными для отмены, считает недозвоны,
   * назначает ответственным того, кто первым взял заявку в работу.
   */
  async setStatus(
    applicationId: string,
    to: ApplicationStatus,
    by: HrUser,
    opts: { comment?: string; declineReason?: DeclineReason | ''; interview?: SlotInput; attended?: Exclude<Attendance, ''> } = {},
  ) {
    return this.sql.begin(async (tx) => {
      const undo = await this.lock(tx, applicationId)
      if (!undo) return null
      // Неявка вместе с отказом: отметка на текущем собеседовании, при отмене возвращается прежняя
      if (opts.attended) {
        const current = await this.currentAttendance(tx, applicationId)
        if (current) {
          undo.attendance = current.undo
          await tx`update interviews set attended = ${opts.attended}, attended_at = now(), attended_by = ${by.id > 0 ? by.id : null} where id = ${current.undo.interviewId}`
        }
      }
      const assign = undo.assigneeId === null && by.id > 0 ? by.id : undo.assigneeId
      await tx`
        update applications set
          status = ${to},
          status_updated_at = case when status = ${to} then status_updated_at else now() end,
          decline_reason = ${to === 'declined' ? (opts.declineReason ?? '') : ''},
          no_answer_count = no_answer_count + ${to === 'no_answer' ? 1 : 0},
          assignee_id = ${assign},
          season_outcome = case when ${to} = 'started' then season_outcome else '' end,
          season_leave_reason = case when ${to} = 'started' then season_leave_reason else '' end
        where id = ${applicationId}`
      if (opts.interview) {
        const i = await this.replaceInterview(tx, applicationId, opts.interview, by)
        undo.createdInterviewId = i.created
        undo.cancelledInterviewId = i.cancelled
      }
      const kind: HistoryKind = to === 'no_answer' && undo.status === 'no_answer' ? 'missed' : 'status'
      const historyId = await this.log(tx, { applicationId, by, kind, from: undo.status, to, comment: opts.comment, undo })
      return { application: (await this.get(applicationId, tx))!, from: undo.status, historyId, interviewId: undo.createdInterviewId ?? null }
    })
  }

  /** Перенести собеседование, не меняя статус */
  async reschedule(applicationId: string, slot: SlotInput, by: HrUser, comment = '') {
    return this.sql.begin(async (tx) => {
      const undo = await this.lock(tx, applicationId)
      if (!undo) return null
      const i = await this.replaceInterview(tx, applicationId, slot, by)
      undo.createdInterviewId = i.created
      undo.cancelledInterviewId = i.cancelled
      const historyId = await this.log(tx, { applicationId, by, kind: 'interview', from: undo.status, to: undo.status, comment, undo })
      return { application: (await this.get(applicationId, tx))!, historyId, interviewId: i.created }
    })
  }

  /**
   * Явка на собеседование без смены статуса. Неявка — через setStatus(…, 'declined', { attended: 'no' }).
   * Ошибка — строкой: нет собеседования или оно ещё не началось
   */
  async setAttendance(applicationId: string, by: HrUser) {
    return this.sql.begin(async (tx) => {
      const undo = await this.lock(tx, applicationId)
      if (!undo) return null
      const current = await this.currentAttendance(tx, applicationId)
      if (!current) return { error: 'У заявки нет собеседования' }
      if (current.startsAt.getTime() - ATTENDANCE_EARLY_MS > Date.now()) return { error: 'Собеседование ещё не началось — явку отмечают после' }
      undo.attendance = current.undo
      await tx`update interviews set attended = 'yes', attended_at = now(), attended_by = ${by.id > 0 ? by.id : null} where id = ${current.undo.interviewId}`
      const historyId = await this.log(tx, { applicationId, by, kind: 'interview', from: undo.status, to: undo.status, comment: ATTENDED_NOTE, undo })
      return { application: (await this.get(applicationId, tx))!, historyId }
    })
  }

  async comment(applicationId: string, by: HrUser | null, comment: string, kind: HistoryKind = 'comment') {
    const [app] = await this.sql<{ status: string }[]>`select status from applications where id = ${applicationId}`
    if (!app) return null
    const s = isStatus(app.status) ? app.status : 'new'
    return this.log(this.sql, { applicationId, by, kind, from: s, to: s, comment })
  }

  async setAssignee(applicationId: string, assigneeId: number | null, by: HrUser) {
    return this.sql.begin(async (tx) => {
      const undo = await this.lock(tx, applicationId)
      if (!undo) return null
      if (undo.assigneeId === assigneeId) return { historyId: null }
      const [u] = assigneeId === null ? [] : await tx<{ name: string }[]>`select name from hr_users where id = ${assigneeId} and not disabled`
      if (assigneeId !== null && !u) return null
      await tx`update applications set assignee_id = ${assigneeId} where id = ${applicationId}`
      const historyId = await this.log(tx, {
        applicationId,
        by,
        kind: 'assign',
        from: undo.status,
        to: undo.status,
        comment: u ? `Ведёт: ${u.name}` : 'Без ответственного',
        undo,
      })
      return { historyId }
    })
  }

  async setCallback(applicationId: string, at: Date | null, note: string, by: HrUser) {
    const rows = await this.sql`
      update applications set callback_at = ${at}, callback_note = ${at ? note.slice(0, 300) : ''} where id = ${applicationId} returning id`
    if (!rows.length) return false
    const when = at ? at.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : ''
    await this.comment(applicationId, by, at ? `Перезвонить ${when}${note ? `: ${note}` : ''}` : 'Задача «перезвонить» снята', 'callback')
    return true
  }

  async setNotes(applicationId: string, notes: string) {
    const rows = await this.sql`update applications set notes = ${notes.slice(0, 5000)} where id = ${applicationId} returning id`
    return rows.length > 0
  }

  /**
   * Дополнить анкету. Дата рождения с опечаткой (нечитаемая, в будущем, старше 70) не стирает сохранённую;
   * моложе 18 записывается — HR видит возраст. Месяц выхода сбрасывается, если готовность — не «С определённого месяца»
   */
  async setProfile(applicationId: string, patch: ProfilePatch, by: HrUser) {
    const [row] = await this.sql<ApplicationRow[]>`select * from applications where id = ${applicationId}`
    if (!row) return false
    const current = toApplication(row)
    const has = (k: keyof ProfilePatch) => Object.hasOwn(patch, k)
    // Дата рождения: не в патче — остаётся как есть (без повторной проверки возраста), пустая — стирается, с опечаткой — не меняется
    const typed = typeof patch.birthDate === 'string' ? patch.birthDate.trim() : ''
    const birthDate = !has('birthDate') ? (current.birthDate ?? '') : typed ? normalizeBirthDate(typed) || (current.birthDate ?? '') : ''
    // Остальная анкета — через normalizeProfile; adult без даты — как прислали или как было, с датой — по ней
    const next = normalizeProfile({ ...current, ...patch, birthDate: '', adult: has('adult') ? patch.adult : row.adult })
    const adult = isAdultByBirthDate(birthDate) ?? next.adult
    // Месяцы работы: по ним заявка попадает в план найма
    const months = Array.isArray(patch.months)
      ? [...new Set(patch.months.filter((m) => Number.isInteger(m) && m >= 1 && m <= 12))].sort((a, b) => a - b)
      : current.months
    const school = has('school') && typeof patch.school === 'string' ? patch.school.trim().slice(0, 200) : current.school
    const notStudying = has('notStudying') ? patch.notStudying === true : (current.notStudying ?? false)
    const mentorName = has('mentorName') && typeof patch.mentorName === 'string' ? patch.mentorName.trim().slice(0, 120) : (row.mentor_name ?? '')
    const practiceDocs: PracticeDoc[] = has('practiceDocs') ? normalizePracticeDocs(patch.practiceDocs) : practiceDocsOf(row)
    await this.sql`
      update applications set last_name = ${next.lastName}, middle_name = ${next.middleName}, adult = ${adult}, citizenship = ${next.citizenship},
        med_book = ${next.medBook}, shifts = ${next.shifts}, months = ${this.sql.json(months)},
        birth_date = ${birthDate || null}, start_ready = ${next.startReady}, start_month = ${next.startMonth}, school = ${school},
        not_studying = ${notStudying}, mentor_name = ${mentorName}, practice_docs = ${this.sql.array(practiceDocs)}::text[]
      where id = ${applicationId}`
    await this.comment(applicationId, by, profileNote(patch, { months, mentorName, practiceDocs }), 'profile')
    return true
  }

  /**
   * Оформление и первая смена: дата оформления или медкомиссии, дата и время первой смены, день или ночь, заметка.
   * Ошибка — строкой. Напоминание о первой смене ставит вызывающий (scheduleShiftReminder)
   */
  async setOnboarding(applicationId: string, patch: OnboardingPatch, by: HrUser): Promise<{ application: HrApplication; historyId: number } | { error: string } | null> {
    const current = await this.get(applicationId)
    if (!current) return null
    const has = (k: keyof OnboardingPatch) => Object.hasOwn(patch, k)
    const date = (v: unknown, what: string): Date | null | string => {
      if (v === null || v === '') return null
      const d = typeof v === 'string' ? new Date(v) : null
      if (!d || Number.isNaN(d.getTime())) return `Не получилось прочитать ${what}`
      if (Math.abs(d.getTime() - Date.now()) > ONBOARDING_RANGE_MS) return `Проверь ${what}: она дальше чем на год от сегодня`
      return d
    }
    const onboardingAt = has('onboardingAt') ? date(patch.onboardingAt, 'дату оформления') : current.onboardingAt ? new Date(current.onboardingAt) : null
    if (typeof onboardingAt === 'string') return { error: onboardingAt }
    const firstShiftAt = has('firstShiftAt') ? date(patch.firstShiftAt, 'дату первой смены') : current.firstShiftAt ? new Date(current.firstShiftAt) : null
    if (typeof firstShiftAt === 'string') return { error: firstShiftAt }
    if (has('shiftKind') && patch.shiftKind !== '' && !isShiftKind(patch.shiftKind)) return { error: 'Смена — дневная или ночная' }
    const shiftKind = has('shiftKind') ? (patch.shiftKind ?? '') : current.shiftKind
    const note = has('onboardingNote') && typeof patch.onboardingNote === 'string' ? patch.onboardingNote.trim().slice(0, 500) : current.onboardingNote
    await this.sql`
      update applications set onboarding_at = ${onboardingAt}, first_shift_at = ${firstShiftAt}, shift_kind = ${shiftKind}, onboarding_note = ${note}
      where id = ${applicationId}`
    const saved = { status: current.status, onboardingAt: onboardingAt?.toISOString() ?? null, firstShiftAt: firstShiftAt?.toISOString() ?? null, shiftKind }
    const historyId = (await this.comment(applicationId, by, onboardingNote(patch, saved), 'onboarding'))!
    return { application: (await this.get(applicationId))!, historyId }
  }

  /**
   * Итог сезона и отметка «Звать в штат / резерв» — только у «На смене». Уход — с причиной; у «Сезон отработан» причины нет.
   * Отметка внутренняя: кандидат её не видит ни на сайте, ни в боте. Ошибка — строкой
   */
  async setSeason(applicationId: string, patch: SeasonPatch, by: HrUser, tx: Tx = this.sql): Promise<{ application: HrApplication; historyId: number } | { error: string } | null> {
    const current = await this.get(applicationId, tx)
    if (!current) return null
    if (current.status !== 'started') return { error: 'Итог сезона и резерв отмечают у тех, кто на смене' }
    const has = (k: keyof SeasonPatch) => Object.hasOwn(patch, k)
    if (has('seasonOutcome') && patch.seasonOutcome !== '' && !isSeasonOutcome(patch.seasonOutcome)) return { error: 'Неизвестный итог сезона' }
    if (has('seasonLeaveReason') && patch.seasonLeaveReason !== '' && !isSeasonLeaveReason(patch.seasonLeaveReason)) return { error: 'Неизвестная причина ухода' }
    const outcome = has('seasonOutcome') ? (patch.seasonOutcome ?? '') : current.seasonOutcome
    const reason = outcome !== 'left' ? '' : has('seasonLeaveReason') ? (patch.seasonLeaveReason ?? '') : current.seasonLeaveReason
    if (outcome === 'left' && !reason) return { error: 'Укажи, почему человек ушёл до конца сезона' }
    const reserve = has('reserve') ? patch.reserve === true : current.reserve
    await tx`update applications set season_outcome = ${outcome}, season_leave_reason = ${reason}, reserve = ${reserve} where id = ${applicationId}`
    const parts: string[] = []
    if (has('seasonOutcome') || has('seasonLeaveReason'))
      parts.push(outcome ? `${seasonOutcomes.find((o) => o.id === outcome)!.label}${reason ? `: ${seasonLeaveReasonLabel(reason).toLowerCase()}` : ''}` : 'Итог сезона снят')
    if (has('reserve') && reserve !== current.reserve) parts.push(reserve ? 'Звать в штат или в резерв' : 'Снята отметка «Звать в штат или в резерв»')
    const s = current.status
    const historyId = await this.log(tx, { applicationId, by, kind: 'season', from: s, to: s, comment: parts.join('. ') || 'Итог сезона без изменений' })
    return { application: (await this.get(applicationId, tx))!, historyId }
  }

  /**
   * Согласие, которое отметил сотрудник: устно (hr_verbal) или по отклику на работном сайте (job_board).
   * Только для заявок без согласия: согласие с сайта или из бота не переписываем
   */
  async setConsent(applicationId: string, source: Exclude<ManualConsent, 'none'>, by: HrUser): Promise<{ application: HrApplication; historyId: number } | { error: string } | null> {
    const current = await this.get(applicationId)
    if (!current) return null
    if (current.consentSource !== 'none') return { error: 'Согласие уже есть' }
    await this.sql`
      update applications set consent_source = ${source}, consent_at = now(), consent_version = '', consent_by = ${by.name}
      where id = ${applicationId}`
    const s = current.status
    const historyId = await this.log(this.sql, { applicationId, by, kind: 'consent', from: s, to: s, comment: consentText[source] })
    return { application: (await this.get(applicationId))!, historyId }
  }

  /** Отметка об уведомлении в строке истории */
  async setNotify(historyId: number, notify: NotifyState, detail: string) {
    await this.sql`update application_history set notify = ${notify}, notify_detail = ${detail.slice(0, 300)} where id = ${historyId}`
  }

  /**
   * Отменить действие: только своё (или любое — администратору), только последнее по заявке
   * и не позже UNDO_WINDOW_MS. Возвращает id заявки или причину отказа.
   */
  async undo(historyId: number, by: HrUser): Promise<{ applicationId: string } | { error: string }> {
    return this.sql.begin(async (tx) => {
      const [h] = await tx<(HistoryRow & { application_id: string; undo_data: UndoData | null })[]>`
        select * from application_history where id = ${historyId} for update`
      if (!h || !h.undo_data || h.undone_at) return { error: 'Это действие уже отменено или его нельзя отменить' }
      if (by.role !== 'admin' && Number(h.user_id) !== by.id) return { error: 'Отменить можно только своё действие' }
      if (Date.now() - h.created_at.getTime() > UNDO_WINDOW_MS) return { error: 'Прошло больше 10 минут — поменяй статус вручную' }
      const [later] = await tx`
        select 1 from application_history
        where application_id = ${h.application_id} and id > ${historyId} and undo_data is not null and undone_at is null limit 1`
      if (later) return { error: 'После этого заявку уже меняли — отменить можно только последнее действие' }

      const u = h.undo_data
      await tx`select 1 from applications where id = ${h.application_id} for update`
      await tx`
        update applications set status = ${u.status}, status_updated_at = ${new Date(u.statusUpdatedAt)},
          decline_reason = ${u.declineReason}, no_answer_count = ${u.noAnswerCount}, assignee_id = ${u.assigneeId},
          season_outcome = coalesce(${u.seasonOutcome ?? null}, season_outcome),
          season_leave_reason = coalesce(${u.seasonLeaveReason ?? null}, season_leave_reason)
        where id = ${h.application_id}`
      if (u.createdInterviewId) {
        await tx`update interviews set cancelled_at = now() where id = ${u.createdInterviewId}`
        // Задача «напомнить» для кандидата с сайта относилась к отменённому собеседованию
        await tx`update applications set callback_at = null, callback_note = '' where id = ${h.application_id} and callback_note = ${REMIND_NOTE}`
      }
      if (u.cancelledInterviewId) await tx`update interviews set cancelled_at = null where id = ${u.cancelledInterviewId}`
      if (u.attendance)
        await tx`
          update interviews set attended = ${u.attendance.attended}, attended_at = ${u.attendance.attendedAt ? new Date(u.attendance.attendedAt) : null},
            attended_by = ${u.attendance.attendedBy}
          where id = ${u.attendance.interviewId}`
      await tx`update application_history set undone_at = now() where id = ${historyId}`
      return { applicationId: h.application_id }
    })
  }

  // ── Дубли ───────────────────────────────────────────────────────────

  /** Группы активных заявок с одинаковым телефоном */
  async duplicateGroups(): Promise<{ phone: string; applications: HrApplication[] }[]> {
    const rows = await this.select(
      this.sql,
      this.sql`where a.duplicate_of is null and length(a.phone_norm) >= 10 and exists (
        select 1 from applications d where d.phone_norm = a.phone_norm and d.id <> a.id and d.duplicate_of is null)`,
    )
    const groups = new Map<string, HrApplication[]>()
    for (const r of rows) {
      const list = groups.get(r.phone_norm) ?? []
      list.push(toHr(r))
      groups.set(r.phone_norm, list)
    }
    return [...groups.entries()].map(([phone, applications]) => ({ phone, applications }))
  }

  /**
   * Склеить дубль с основной заявкой: пустые поля основной дополняются из дубля, отметки документов по практике
   * объединяются, заметки дописываются, бот переносится, если у основной его нет. Дубль скрывается из списка,
   * но остаётся в базе и в карточке основной.
   */
  async merge(primaryId: string, duplicateId: string, by: HrUser) {
    if (primaryId === duplicateId) return { error: 'Нельзя склеить заявку саму с собой' }
    return this.sql.begin(async (tx) => {
      const rows = await tx<(ApplicationRow & { duplicate_of: string | null; consent_by?: string })[]>`
        select * from applications where id in (${primaryId}, ${duplicateId}) order by id for update`
      const p = rows.find((r) => r.id === primaryId)
      const d = rows.find((r) => r.id === duplicateId)
      if (!p || !d) return { error: 'Заявка не найдена' }
      if (p.duplicate_of || d.duplicate_of) return { error: 'Одна из заявок уже склеена' }

      const pick = (a: string, b: string) => a || b
      const takeBot = !p.channel_user_id && d.channel_user_id
      // Привязка заявки с сайта к боту: сообщения HR должны и дальше доходить в мессенджер
      const takeLink = !p.bot_user_id && Boolean(d.bot_user_id)
      // Согласие: у основной его нет, у дубля есть — берём из дубля вместе с версией, временем и тем, кто отметил
      const takeConsent = p.consent_source === 'none' && d.consent_source !== 'none'
      const notes = [p.notes, d.notes && `Из заявки ${d.id}: ${d.notes}`].filter(Boolean).join('\n')
      await tx`
        update applications set
          contact = ${pick(p.contact, d.contact)}, school = ${pick(p.school, d.school)}, course = ${pick(p.course, d.course)},
          department = ${pick(p.department, d.department)}, vacancy_id = ${pick(p.vacancy_id, d.vacancy_id)}, format = ${pick(p.format, d.format)},
          months = ${tx.json(p.months.length ? p.months : d.months)}, friend = ${pick(p.friend, d.friend)},
          last_name = ${pick(p.last_name, d.last_name)}, adult = ${p.adult ?? d.adult}, citizenship = ${pick(p.citizenship, d.citizenship)},
          med_book = ${pick(p.med_book, d.med_book)}, shifts = ${pick(p.shifts, d.shifts)}, portfolio = ${pick(p.portfolio, d.portfolio)},
          middle_name = ${pick(p.middle_name, d.middle_name)}, resume_url = ${pick(p.resume_url, d.resume_url)},
          birth_date = ${birthDateOf(p.birth_date) || birthDateOf(d.birth_date) || null},
          start_ready = ${p.start_ready || d.start_ready}, start_month = ${p.start_ready ? p.start_month : d.start_month},
          not_studying = ${p.not_studying || d.not_studying}, mentor_name = ${pick(p.mentor_name, d.mentor_name)},
          practice_docs = ${tx.array(normalizePracticeDocs([...practiceDocsOf(p), ...practiceDocsOf(d)]))}::text[],
          notes = ${notes.slice(0, 5000)},
          channel = ${takeBot ? d.channel : p.channel}, channel_user_id = ${takeBot ? d.channel_user_id : p.channel_user_id},
          bot_channel = ${takeLink ? d.bot_channel : p.bot_channel}, bot_user_id = ${takeLink ? d.bot_user_id : p.bot_user_id},
          practice_school = ${p.practice_school || d.practice_school}, wants_to_stay = ${p.wants_to_stay || d.wants_to_stay},
          consent_source = ${takeConsent ? d.consent_source : p.consent_source}, consent_at = ${takeConsent ? d.consent_at : p.consent_at},
          consent_version = ${takeConsent ? d.consent_version : p.consent_version}, consent_by = ${takeConsent ? (d.consent_by ?? '') : (p.consent_by ?? '')}
        where id = ${primaryId}`
      await tx`update applications set duplicate_of = ${primaryId}, callback_at = null where id = ${duplicateId}`
      const ps = isStatus(p.status) ? p.status : 'new'
      const ds = isStatus(d.status) ? d.status : 'new'
      await this.log(tx, { applicationId: primaryId, by, kind: 'merge', from: ps, to: ps, comment: `Склеена с дублем ${duplicateId}` })
      await this.log(tx, { applicationId: duplicateId, by, kind: 'merge', from: ds, to: ds, comment: `Дубль заявки ${primaryId}` })
      return { application: (await this.get(primaryId, tx))! }
    })
  }

  // ── Кандидаты, добавленные сотрудником ──────────────────────────────

  /**
   * Добавить кандидата вручную: звонок, визит, работный сайт. Канал — hr, источник — откуда узнали,
   * ответственный — тот, кто добавил. Возвращает заявку и активные заявки с тем же телефоном.
   */
  async createManual(
    raw: Partial<ApplicationInput> & { createdAt?: string | null; consentBasis?: unknown },
    by: HrUser,
    note: string,
    tx: Tx = this.sql,
    /** Ответственный: по умолчанию тот, кто добавил; null — без ответственного */
    assigneeId: number | null | undefined = undefined,
  ) {
    const assignee = assigneeId === undefined ? (by.id > 0 ? by.id : null) : assigneeId
    const a = normalizeApplication({ ...raw, channel: 'web', consent: false })
    const created = raw.createdAt && !Number.isNaN(Date.parse(raw.createdAt)) && Date.parse(raw.createdAt) <= Date.now() ? new Date(raw.createdAt) : new Date()
    // Основание: устно и отклик на работном сайте — согласие есть с этой минуты (у отклика — со времени отклика), кто отметил — в consent_by
    const basis: ManualConsent = isManualConsent(raw.consentBasis) ? raw.consentBasis : 'none'
    const consentAt = basis === 'none' ? null : basis === 'job_board' ? created : new Date()
    const [row] = await tx<{ id: string }[]>`
      insert into applications (id, created_at, channel, name, phone, contact, school, course, department, vacancy_id, format, months, comment,
                                friend, game, source, status, status_updated_at, assignee_id, last_name, adult, citizenship, med_book, shifts, portfolio,
                                middle_name, resume_url, birth_date, start_ready, start_month, not_studying, practice_school, wants_to_stay,
                                consent_source, consent_at, consent_version, consent_by)
      values (${makeApplicationId()}, ${created}, 'hr', ${a.name}, ${a.phone}, ${a.contact}, ${a.school}, ${a.course}, ${a.department},
              ${a.vacancyId}, ${a.format}, ${tx.json(a.months)}, ${a.comment}, '', ${tx.json({ quizResult: null, conveyorBest: 0, activities: 0 })},
              ${a.source}, 'new', ${created}, ${assignee}, ${a.lastName ?? ''}, ${a.adult ?? null}, ${a.citizenship ?? ''},
              ${a.medBook ?? ''}, ${a.shifts ?? ''}, ${a.portfolio ?? ''}, ${a.middleName ?? ''}, ${a.resumeUrl ?? ''},
              ${a.birthDate || null}, ${a.startReady ?? ''}, ${a.startMonth ?? null}, ${a.notStudying ?? false},
              ${a.practiceSchool ?? false}, ${a.wantsToStay ?? false},
              ${basis}, ${consentAt}, '', ${basis === 'none' ? '' : by.name})
      returning id`
    await this.log(tx, { applicationId: row.id, by, kind: 'status', from: null, to: 'new', comment: `${note}. ${consentText[basis]}` })
    return (await this.get(row.id, tx))!
  }

  /** Активная заявка того же человека: по телефону, почте или резюме hh.ru. by — по какому признаку */
  async findExisting(q: { phone?: string; email?: string; resumeUrl?: string }, tx: Tx = this.sql) {
    const d = (q.phone ?? '').replace(/\D/g, '')
    const norm = d.length === 11 && d.startsWith('8') ? `7${d.slice(1)}` : d.length === 10 ? `7${d}` : d
    const email = (q.email ?? '').trim().toLowerCase()
    const resume = q.resumeUrl ?? ''
    if (norm.length < 10 && !email && !resume) return null
    const [row] = await tx<{ id: string; name: string; by: 'телефон' | 'почта' | 'резюме' }[]>`
      select id, name,
        case when ${norm.length >= 10} and phone_norm = ${norm} then 'телефон'
             when ${email !== ''} and lower(contact) = ${email} then 'почта'
             else 'резюме' end as by
      from applications
      where duplicate_of is null and anonymized_at is null and (
        (${norm.length >= 10} and phone_norm = ${norm}) or
        (${email !== ''} and lower(contact) = ${email}) or
        (${resume !== ''} and resume_url = ${resume}))
      order by created_at limit 1`
    return row ?? null
  }

  /** Есть ли активная заявка с таким телефоном: id или null */
  async findByPhone(phone: string, tx: Tx = this.sql) {
    const d = phone.replace(/\D/g, '')
    const norm = d.length === 11 && d.startsWith('8') ? `7${d.slice(1)}` : d.length === 10 ? `7${d}` : d
    if (norm.length < 10) return null
    const [row] = await tx<{ id: string; name: string }[]>`
      select id, name from applications where phone_norm = ${norm} and duplicate_of is null order by created_at limit 1`
    return row ?? null
  }

  async unmerge(duplicateId: string, by: HrUser) {
    const [row] = await this.sql<{ duplicate_of: string | null; status: string }[]>`select duplicate_of, status from applications where id = ${duplicateId}`
    if (!row?.duplicate_of) return false
    await this.sql`update applications set duplicate_of = null where id = ${duplicateId}`
    const s = isStatus(row.status) ? row.status : 'new'
    await this.log(this.sql, { applicationId: duplicateId, by, kind: 'merge', from: s, to: s, comment: `Отделена от заявки ${row.duplicate_of}` })
    return true
  }
}
