import {
  interviewDefaults,
  statusLabel,
  type ApplicationStatus,
  type HrApplication,
  type InterviewSlot,
  type NotifyState,
} from '@shared/applications'
import { hourKey, mskAt, mskParts, nextWorkTime, type WorkSettings } from '@shared/workdays'
import type { Registry } from '../channels/registry'
import type { Sql, Tx } from '../db'
import type { HrUser } from '../db/hr'
import { REMIND_NOTE } from '../db/workflow'
import { changeStatus } from '../hr/actions'
import { hrDeps } from '../jobs/scheduler'
import { botChat, notifyDelayMs, scheduleReminder, type NotifyDeps } from '../notify'
import { maskPhone, smsPhone } from '../sms'
import {
  freeHours,
  hiringDayHours,
  hiringDayProblem,
  hiringHourProblem,
  HORIZON_DAYS,
  hourProblem,
  isHiringLabel,
  loadOf,
  OFFER_DAYS,
  type HourLoad,
} from './hours'
import {
  OPEN_STATUSES,
  offerStateOf,
  type BookingState,
  type BookResult,
  type BookVia,
  type CancelResult,
  type NoneResult,
  type OfferState,
} from './state'
import { dayLong, offerMessage, offerSms } from './text'

// Самозапись на собеседование в PostgreSQL. HR предлагает выбрать время (offerBooking) — у заявки появляется открытое
// предложение. Кандидат видит свободные часы (availableHours) и записывается (book): запись ставит «Собеседование»,
// слот и напоминание теми же действиями, что и HR в панели (server/hr/actions.ts, server/notify), с пометкой
// interviews.self_booked. Два одновременных выбора последнего места разводит блокировка часа в PostgreSQL:
// второй получает «Это время уже заняли». Перенос и отмена освобождают место, «Ни одно не подходит» ставит HR
// задачу «перезвонить». Без предложения HR выбрать время нельзя.

export type BookingDeps = NotifyDeps & { sql: Sql; siteUrl: string }

export function bookingDeps(sql: Sql, bots: Registry, env: NodeJS.ProcessEnv = process.env): BookingDeps {
  return { ...hrDeps(sql, bots, env), sql, siteUrl: env.SITE_URL?.trim() || env.PUBLIC_URL?.trim() || 'http://localhost:5180' }
}

/** От чьего имени запись идёт в историю заявки: кандидат сам, без учётной записи HR */
export const CANDIDATE: HrUser = { id: 0, email: '', name: 'Кандидат', role: 'hr', disabled: false, createdAt: '', lastLoginAt: null }

const viaLabel: Record<BookVia, string> = { site: 'на сайте', web: 'в чате на сайте', telegram: 'в Telegram', max: 'в MAX' }

/** Задача HR после «Ни одно не подходит» */
export const NONE_NOTE = 'Кандидату не подошло ни одно время — договориться о собеседовании'

/** Сколько держим место в часе, пока создаётся собеседование: при сбое процесса место вернётся само */
const HOLD_SECONDS = 60
/** Повторное «Ни одно не подходит» в течение этого времени не ставит HR новую задачу */
const NONE_REPEAT_MS = 12 * 3600e3
/** Пространство блокировок самозаписи в pg_advisory_xact_lock — чтобы не пересечься с чужими блокировками */
const LOCK_SPACE = 1_017_017
const DAY = 864e5

type OfferRow = {
  id: string
  application_id: string
  created_at: Date
  created_by: string | null
  created_by_name: string
  expires_at: Date
  status_before: string
  used_at: Date | null
  interview_id: string | null
  none_at: Date | null
  closed_at: Date | null
  hiring_day_id: string | null
}

/** День найма из базы: день — строкой ГГГГ-ММ-ДД по Москве */
type HiringDayRow = {
  id: string
  day: string
  hours: number[]
  capacity: number
  address: string
  label: string
  note: string
  created_by: string | null
  created_by_name: string
  created_at: Date
  closed_at: Date | null
}

const iso = (d: Date) => d.toISOString()

/** Открытое предложение заявки */
async function openOffer(sql: Tx, applicationId: string): Promise<OfferRow | null> {
  const [row] = await sql<OfferRow[]>`select * from booking_offers where application_id = ${applicationId} and closed_at is null`
  return row ?? null
}

/**
 * Сколько кандидатов записано на каждый час: собеседования заявок в статусе «Собеседование» (как в «Графике»
 * и подсказке нормы в панели) и места, которые держат идущие сейчас записи. except — заявка, которая переносит
 * своё время: её прежний час не в счёт
 */
async function hourLoad(sql: Tx, from: Date, to: Date, except?: string): Promise<HourLoad> {
  const rows = await sql<{ starts_at: Date; application_id: string }[]>`
    select i.starts_at, i.application_id
    from interviews i join applications a on a.id = i.application_id
    where i.cancelled_at is null and a.status = 'interview' and a.duplicate_of is null and a.anonymized_at is null
      and i.starts_at >= ${from} and i.starts_at < ${to}
    union all
    select o.hold_at, o.application_id
    from booking_offers o
    where o.hold_until > now() and o.hold_at >= ${from} and o.hold_at < ${to}`
  return loadOf(rows.map((r) => ({ startsAt: r.starts_at, applicationId: r.application_id })), except)
}

/**
 * Свободные часы для самозаписи: до 6 ближайших, только рабочие дни и часы отдела, не выше нормы на час
 * с учётом назначенных, не раньше чем через LEAD_HOURS (server/booking/hours.ts)
 */
export async function availableHours(
  sql: Sql,
  opts: { now?: number; settings?: WorkSettings; exclude?: string[]; exceptApplicationId?: string; limit?: number } = {},
): Promise<Date[]> {
  const now = opts.now ?? Date.now()
  const settings = opts.settings ?? (await workSettingsOf(sql))
  const load = await hourLoad(sql, new Date(now), new Date(now + (HORIZON_DAYS + 1) * DAY), opts.exceptApplicationId)
  return freeHours({ load, settings, now, limit: opts.limit, exclude: opts.exclude })
}

async function workSettingsOf(sql: Sql) {
  const { HrRepo } = await import('../db/hr')
  return new HrRepo(sql).workSettings()
}

const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + DAY).toISOString().slice(0, 10)

async function hiringDayById(sql: Tx, id: string | number): Promise<HiringDayRow | null> {
  const [row] = await sql<HiringDayRow[]>`select *, to_char(day, 'YYYY-MM-DD') as day from hiring_days where id = ${id}`
  return row ?? null
}

/**
 * Заявка пришла по ссылке дня найма (метка источника — метка открытого дня): кандидату предлагается выбрать час
 * этого дня. Предложение создаётся один раз — если HR его отозвал, само не вернётся. День найма заводит HR,
 * так что выбор и здесь появляется только после действия HR
 */
async function ensureHiringDayOffer(deps: BookingDeps, applicationId: string, now: number) {
  const [a] = await deps.sql<{ source: string | null; status: string }[]>`
    select source, status from applications where id = ${applicationId} and anonymized_at is null and duplicate_of is null`
  if (!a || !isHiringLabel(a.source) || !['new', 'contacted', 'no_answer'].includes(a.status)) return
  const [day] = await deps.sql<HiringDayRow[]>`
    select *, to_char(day, 'YYYY-MM-DD') as day from hiring_days where label = ${a.source} and closed_at is null`
  if (!day || !day.hours.some((h) => mskAt(day.day, h).getTime() > now)) return
  if (offerProblem(await deps.workflow.get(applicationId))) return
  const inserted = await deps.sql`
    insert into booking_offers (application_id, created_by, created_by_name, expires_at, status_before, hiring_day_id)
    select ${applicationId}, ${day.created_by}, ${day.created_by_name}, ${mskAt(nextDay(day.day), 0)}, ${a.status}, ${day.id}
    where not exists (
      select 1 from booking_offers where application_id = ${applicationId} and (closed_at is null or hiring_day_id = ${day.id}))
    on conflict do nothing
    returning id`
  if (inserted.length) await deps.workflow.comment(applicationId, null, `День найма, ${dayLong(day.day)}: кандидат выбирает час на сайте или в боте`)
}

type View = { app: HrApplication | null; offer: OfferRow | null; state: OfferState; booked: InterviewSlot | null; day: HiringDayRow | null }

/** Заявка, её открытое предложение и что с ним сейчас */
async function view(deps: BookingDeps, applicationId: string, now: number): Promise<View> {
  const app = await deps.workflow.get(applicationId)
  const offer = app ? await openOffer(deps.sql, applicationId) : null
  if (!app || !offer) return { app, offer, state: 'none', booked: null, day: null }
  const day = offer.hiring_day_id ? await hiringDayById(deps.sql, offer.hiring_day_id) : null
  const [created] = app.interview ? await deps.sql<{ created_at: Date }[]>`select created_at from interviews where id = ${app.interview.id}` : []
  const state = offerStateOf(
    {
      status: app.status,
      erased: Boolean(app.anonymizedAt),
      duplicate: Boolean(app.duplicateOf),
      interview: app.interview ? { id: app.interview.id, startsAt: Date.parse(app.interview.startsAt), createdAt: created?.created_at.getTime() ?? 0 } : null,
      offer: { interviewId: offer.interview_id === null ? null : Number(offer.interview_id), createdAt: offer.created_at.getTime(), expiresAt: offer.expires_at.getTime() },
    },
    now,
  )
  // День найма отменили: выбрать час больше нельзя, сделанная запись остаётся
  if (day?.closed_at && state === 'open') return { app, offer, state: 'closed', booked: null, day }
  return { app, offer, state, booked: state === 'booked' || state === 'past' ? app.interview : null, day }
}

/** Ссылка дня найма и обычное предложение — общие правила: какие часы, сколько мест, куда приходить */
async function slotsOf(deps: BookingDeps, v: View, applicationId: string, now: number, settings: WorkSettings) {
  const exclude = v.booked ? [hourKey(new Date(v.booked.startsAt))] : []
  const day = v.day
  if (!day) {
    return {
      capacity: settings.slotCapacity,
      place: placeOf(v.app),
      problem: (at: Date) => hourProblem(at, { now, settings }),
      hours: () => availableHours(deps.sql, { now, settings, exclude, exceptApplicationId: applicationId }),
    }
  }
  const slots = { day: day.day, hours: day.hours, capacity: day.capacity }
  return {
    capacity: day.capacity,
    place: { address: day.address || interviewDefaults.address, bring: interviewDefaults.bring },
    problem: (at: Date) => hiringHourProblem(at, slots, now),
    hours: async () => {
      const load = await hourLoad(deps.sql, mskAt(day.day, 0), mskAt(nextDay(day.day), 0), applicationId)
      return hiringDayHours(slots, { load, now, exclude })
    },
  }
}

/** Где и с чем: адрес и «что взять» из собеседования, которое назначал HR, иначе — по умолчанию для панели */
const placeOf = (app: HrApplication | null) => ({
  address: app?.interview?.address || interviewDefaults.address,
  bring: app?.interview?.bring || interviewDefaults.bring,
})

/** Предложение и свободные часы глазами кандидата */
export async function bookingState(deps: BookingDeps, applicationId: string, now = Date.now()): Promise<BookingState> {
  await ensureHiringDayOffer(deps, applicationId, now)
  const v = await view(deps, applicationId, now)
  const place = v.day ? { address: v.day.address || interviewDefaults.address, bring: interviewDefaults.bring } : placeOf(v.app)
  const base: BookingState = {
    applicationId,
    vacancyId: v.app?.vacancyId ?? '',
    state: v.state,
    offered: false,
    hours: [],
    booked: null,
    ...place,
    expiresAt: null,
    noneAt: null,
    hiringDay: v.day ? { day: v.day.day, address: place.address } : null,
    full: false,
  }
  if (v.state !== 'open' && v.state !== 'booked') return base
  const slots = await slotsOf(deps, v, applicationId, now, await deps.repo.workSettings())
  const hours = (await slots.hours()).map(iso)
  const booked = v.booked?.startsAt ?? null
  return {
    ...base,
    // Записанный кандидат видит адрес своего собеседования
    ...(v.booked ? { address: v.booked.address || place.address, bring: v.booked.bring || place.bring } : {}),
    offered: true,
    hours,
    booked,
    expiresAt: booked ? null : iso(v.offer!.expires_at),
    noneAt: v.offer!.none_at ? iso(v.offer!.none_at) : null,
    full: !booked && hours.length === 0,
  }
}

/**
 * Записаться или перенести запись на час startsAt (ровно начало часа). Место держится в транзакции с блокировкой
 * часа: из двух одновременных выборов последнего места второй получает taken и свежий список часов.
 * Первая запись ставит «Собеседование» со слотом (changeStatus), перенос и запись при уже назначенном «Собеседовании»
 * без слота — перенос слота (reschedule) с новым напоминанием. Сообщение кандидату не уходит: время он выбрал сам и видит его.
 * На дне найма часы и места — из дня, а не из рабочего календаря
 */
export async function book(deps: BookingDeps, applicationId: string, startsAt: Date, via: BookVia = 'site', now = Date.now()): Promise<BookResult> {
  await ensureHiringDayOffer(deps, applicationId, now)
  const v = await view(deps, applicationId, now)
  if (v.state === 'expired') return { ok: false, error: 'expired' }
  if ((v.state !== 'open' && v.state !== 'booked') || !v.app || !v.offer) return { ok: false, error: 'no_offer' }
  const app = v.app
  const offer = v.offer
  const slots = await slotsOf(deps, v, applicationId, now, await deps.repo.workSettings())
  const fresh = async () => (await slots.hours()).map(iso)
  if (slots.problem(startsAt)) return { ok: false, error: 'invalid', hours: await fresh() }
  const place = slots.place
  // То же время, что уже выбрано, — ничего не меняем
  if (v.booked && hourKey(new Date(v.booked.startsAt)) === hourKey(startsAt)) return { ok: true, startsAt: v.booked.startsAt, ...place, moved: false, hiringDay: Boolean(v.day) }

  const key = hourKey(startsAt)
  const held = await deps.sql.begin(async (tx) => {
    // Блокировка часа до конца транзакции: второй выбор того же часа ждёт и видит место, которое занял первый
    await tx`select pg_advisory_xact_lock(${LOCK_SPACE}, hashtext(${key}))`
    const load = await hourLoad(tx, startsAt, new Date(startsAt.getTime() + 3600e3), applicationId)
    if ((load[key] ?? 0) >= slots.capacity) return false
    await tx`update booking_offers set hold_at = ${startsAt}, hold_until = now() + make_interval(secs => ${HOLD_SECONDS}) where id = ${offer.id}`
    return true
  })
  if (!held) return { ok: false, error: 'taken', hours: await fresh() }

  try {
    const moved = Boolean(v.booked)
    const where = v.day ? `${viaLabel[via]}, день найма` : viaLabel[via]
    const comment = moved ? `Самозапись: кандидат перенёс собеседование ${where}` : `Самозапись: кандидат выбрал время ${where}`
    const slot = { startsAt, ...place }
    let saved: HrApplication | null = null
    if (app.status === 'interview') {
      const r = await deps.workflow.reschedule(applicationId, slot, CANDIDATE, comment)
      if (r?.application.interview) await scheduleReminder(deps, r.application, r.application.interview, CANDIDATE)
      saved = r ? await deps.workflow.get(applicationId) : null
    } else {
      saved = (await changeStatus(deps, applicationId, 'interview', CANDIDATE, { slot, silent: true, comment }))?.application ?? null
    }
    if (!saved?.interview) return { ok: false, error: 'no_offer' }
    await deps.sql`update interviews set self_booked = true where id = ${saved.interview.id}`
    await deps.sql`
      update booking_offers set used_at = now(), interview_id = ${saved.interview.id},
        status_before = case when used_at is null then ${app.status} else status_before end
      where id = ${offer.id}`
    return { ok: true, startsAt: saved.interview.startsAt, ...place, moved, hiringDay: Boolean(v.day) }
  } finally {
    await deps.sql`update booking_offers set hold_at = null, hold_until = null where id = ${offer.id}`
  }
}

/** Куда вернуть заявку после отмены записи: статус до записи. «Не отвечает» — в «Связались»: кандидат же отозвался */
const backStatus = (before: string): ApplicationStatus =>
  before === 'new' || before === 'contacted' || before === 'interview' ? before : 'contacted'

/**
 * Отменить запись: собеседование отменяется, место в часе освобождается, напоминание снимается, заявка возвращается
 * в статус до записи. Предложение остаётся открытым — можно выбрать другое время
 */
export async function cancelBooking(deps: BookingDeps, applicationId: string, via: BookVia = 'site', now = Date.now()): Promise<CancelResult> {
  const v = await view(deps, applicationId, now)
  if (v.state === 'past') return { ok: false, error: 'started' }
  if (v.state !== 'booked' || !v.booked || !v.offer) return { ok: false, error: 'no_booking' }
  const comment = `Самозапись: кандидат отменил собеседование ${viaLabel[via]}, место освободилось`
  await deps.sql`update interviews set cancelled_at = now() where id = ${v.booked.id} and cancelled_at is null`
  const back = backStatus(v.offer.status_before)
  if (back !== 'interview') await changeStatus(deps, applicationId, back, CANDIDATE, { silent: true, comment })
  else await deps.workflow.comment(applicationId, CANDIDATE, comment)
  await deps.jobs.cancelWhere('reminder', 'applicationId', applicationId)
  await deps.sql`update applications set callback_at = null, callback_note = '' where id = ${applicationId} and callback_note = ${REMIND_NOTE}`
  // Срок выбора продлеваем: после отмены у кандидата есть время выбрать другое. День найма кончается вместе с днём
  await deps.sql`
    update booking_offers set used_at = null, interview_id = null,
      expires_at = case when hiring_day_id is null then greatest(expires_at, now() + interval '2 days') else expires_at end
    where id = ${v.offer.id}`
  return { ok: true }
}

/** «Ни одно время не подходит — позвоните»: HR получает задачу «перезвонить» на ближайшее рабочее время */
export async function noneFits(deps: BookingDeps, applicationId: string, now = Date.now()): Promise<NoneResult> {
  await ensureHiringDayOffer(deps, applicationId, now)
  const v = await view(deps, applicationId, now)
  if (v.state === 'expired') return { ok: false, error: 'expired' }
  if ((v.state !== 'open' && v.state !== 'booked') || !v.offer) return { ok: false, error: 'no_offer' }
  if (v.offer.none_at && now - v.offer.none_at.getTime() < NONE_REPEAT_MS) return { ok: true, repeated: true }
  const settings = await deps.repo.workSettings()
  await deps.workflow.setCallback(applicationId, nextWorkTime(now, settings), NONE_NOTE, CANDIDATE)
  await deps.sql`update booking_offers set none_at = now() where id = ${v.offer.id}`
  return { ok: true, repeated: false }
}

// ── Сторона HR ───────────────────────────────────────────────────────────

/** Почему этой заявке нельзя предложить выбрать время; null — можно */
export function offerProblem(app: HrApplication | null): string | null {
  if (!app) return 'Заявка не найдена'
  if (app.anonymizedAt) return 'Личные данные удалены'
  if (app.duplicateOf) return `Это дубль заявки ${app.duplicateOf}`
  if (app.status === 'declined') return 'Заявка закрыта отказом — сначала верни её в работу'
  if (!OPEN_STATUSES.includes(app.status)) return `Собеседование уже позади: заявка «${statusLabel(app.status)}»`
  if (app.adult === false) return 'Кандидату нет 18 лет, а на завод берут с 18'
  if (app.consentSource === 'none') return 'Нет согласия на обработку данных: получи его при звонке и договорись о времени'
  return null
}

type Reach = { kind: 'bot'; channel: 'telegram' | 'max'; userId: string } | { kind: 'sms' } | { kind: 'page' }

/** Как кандидат узнает о предложении: кнопки в боте, SMS со ссылкой или страница «Моя заявка» */
async function reachOf(deps: BookingDeps, app: HrApplication): Promise<Reach | null> {
  const chat = botChat(app)
  if (chat && deps.bots.get(chat.channel)?.adapter.sendTo) return { kind: 'bot', ...chat }
  if (deps.sms && smsPhone(app.phone)) return { kind: 'sms' }
  const [row] = await deps.sql<{ page: boolean }[]>`select status_token_hash is not null as page from applications where id = ${app.id}`
  return row?.page ? { kind: 'page' } : null
}

export type OfferOutcome = { id: string; notify: NotifyState; detail: string }
export type OfferBulkResult = { offered: OfferOutcome[]; failed: { id: string; error: string }[] }

/**
 * «Предложить выбрать время» для одной или нескольких заявок. Статус заявки не меняется и срок ответа HR тоже:
 * появляется предложение на OFFER_DAYS дней. Кандидату из бота сразу уходят кнопки с часами, с мобильным номером
 * при подключённых SMS — ссылка на «Мою заявку», остальные видят выбор на странице «Моя заявка».
 * Повторное предложение закрывает прежнее; запись, сделанная по прежнему, сохраняется
 */
export async function offerBooking(deps: BookingDeps, ids: string[], by: HrUser): Promise<OfferBulkResult> {
  const out: OfferBulkResult = { offered: [], failed: [] }
  const settings = await deps.repo.workSettings()
  for (const id of [...new Set(ids)]) {
    const app = await deps.workflow.get(id)
    const problem = offerProblem(app)
    if (problem || !app) {
      out.failed.push({ id, error: problem ?? 'Заявка не найдена' })
      continue
    }
    const reach = await reachOf(deps, app)
    if (!reach) {
      out.failed.push({ id, error: 'Кандидату некуда прислать выбор: нет бота, SMS и страницы заявки. Договорись о времени по телефону' })
      continue
    }
    const before = await view(deps, id, Date.now())
    const keep = before.state === 'booked' && before.offer ? before.offer : null
    await deps.sql.begin(async (tx) => {
      await tx`update booking_offers set closed_at = now() where application_id = ${id} and closed_at is null`
      await tx`
        insert into booking_offers (application_id, created_by, created_by_name, expires_at, status_before, used_at, interview_id)
        values (${id}, ${by.id > 0 ? by.id : null}, ${by.name}, now() + make_interval(days => ${OFFER_DAYS}),
                ${keep ? keep.status_before : app.status}, ${keep?.used_at ?? null}, ${keep?.interview_id ?? null})`
    })
    const historyId = (await deps.workflow.comment(id, by, 'Предложено выбрать время собеседования', 'message'))!
    const booked = keep && before.booked ? new Date(before.booked.startsAt) : null
    let notify: NotifyState
    let detail: string
    if (reach.kind === 'bot') {
      const hours = await availableHours(deps.sql, { settings, exclude: booked ? [hourKey(booked)] : [], exceptApplicationId: id })
      const title = reach.channel === 'max' ? 'MAX' : 'Telegram'
      try {
        await deps.bots.get(reach.channel)!.adapter.sendTo!(reach.userId, [offerMessage(app, hours, { booked })])
        notify = 'sent'
        detail = hours.length ? `кнопки с часами отправлены в ${title}` : `сообщение отправлено в ${title}, свободных часов сейчас нет`
      } catch (e) {
        console.error(`[booking] заявка ${id}: ${(e as Error).message}`)
        notify = 'failed'
        detail = 'бот не доставил сообщение — возможно, кандидат его заблокировал. Позвони'
      }
    } else if (reach.kind === 'sms') {
      const sendAt = new Date(Date.now() + notifyDelayMs())
      await deps.jobs.enqueue('notify', sendAt, { applicationId: id, historyId, text: offerSms(deps.siteUrl), via: 'sms' }, `notify:${historyId}`)
      notify = 'queued'
      detail = `уйдёт SMS со ссылкой на ${maskPhone(app.phone)}`
    } else {
      notify = 'skipped'
      detail = 'бота и SMS нет: выбор времени — на странице «Моя заявка», скажи об этом при звонке'
    }
    await deps.workflow.setNotify(historyId, notify, detail)
    out.offered.push({ id, notify, detail })
  }
  return out
}

/** Предложение глазами HR: для карточки кандидата */
export type OfferInfo = {
  state: OfferState
  createdAt: string | null
  createdBy: string
  expiresAt: string | null
  usedAt: string | null
  noneAt: string | null
  /** Какие часы кандидат увидит сейчас */
  hours: string[]
  booked: string | null
  /** Предложение дня найма: день и адрес */
  hiringDay: { day: string; address: string } | null
  /** Кандидат ещё не записан, а свободных часов нет */
  full: boolean
}

export async function offerInfo(deps: BookingDeps, applicationId: string, now = Date.now()): Promise<OfferInfo | null> {
  const app = await deps.workflow.get(applicationId)
  if (!app) return null
  const state = await bookingState(deps, applicationId, now)
  const v = await view(deps, applicationId, now)
  const o = v.offer
  return {
    state: state.state,
    createdAt: o ? iso(o.created_at) : null,
    createdBy: o?.created_by_name ?? '',
    expiresAt: o ? iso(o.expires_at) : null,
    usedAt: o?.used_at ? iso(o.used_at) : null,
    noneAt: o?.none_at ? iso(o.none_at) : null,
    hours: state.hours,
    booked: state.booked,
    hiringDay: state.hiringDay,
    full: state.full,
  }
}

/** Отозвать предложение: кандидат больше не видит часов. Уже назначенное собеседование остаётся */
export async function withdrawOffer(deps: BookingDeps, applicationId: string, by: HrUser): Promise<boolean> {
  const rows = await deps.sql`update booking_offers set closed_at = now() where application_id = ${applicationId} and closed_at is null returning id`
  if (!rows.length) return false
  await deps.workflow.comment(applicationId, by, 'Предложение выбрать время отозвано', 'comment')
  return true
}

/** Открытые предложения для списка HR одним запросом: кто ждёт выбора, кто записался, кому не подошло время */
export async function openOffers(deps: BookingDeps, now = Date.now()) {
  const rows = await deps.sql<
    {
      application_id: string
      status: ApplicationStatus
      offer_interview: string | null
      offer_created: Date
      expires_at: Date
      none_at: Date | null
      interview_id: string | null
      starts_at: Date | null
      interview_created: Date | null
    }[]
  >`
    select o.application_id, a.status, o.interview_id as offer_interview, o.created_at as offer_created, o.expires_at, o.none_at,
      i.id as interview_id, i.starts_at, i.created_at as interview_created
    from booking_offers o
    join applications a on a.id = o.application_id
    left join lateral (
      select id, starts_at, created_at from interviews where application_id = a.id and cancelled_at is null order by created_at desc limit 1
    ) i on true
    where o.closed_at is null and a.anonymized_at is null and a.duplicate_of is null
    order by o.created_at desc limit 5000`
  const out: { applicationId: string; state: OfferState; expiresAt: string; noneAt: string | null; booked: string | null }[] = []
  for (const r of rows) {
    const state = offerStateOf(
      {
        status: r.status,
        erased: false,
        duplicate: false,
        interview: r.interview_id && r.starts_at ? { id: Number(r.interview_id), startsAt: r.starts_at.getTime(), createdAt: r.interview_created?.getTime() ?? 0 } : null,
        offer: { interviewId: r.offer_interview === null ? null : Number(r.offer_interview), createdAt: r.offer_created.getTime(), expiresAt: r.expires_at.getTime() },
      },
      now,
    )
    if (state === 'closed') continue
    out.push({
      applicationId: r.application_id,
      state,
      expiresAt: iso(r.expires_at),
      noneAt: r.none_at ? iso(r.none_at) : null,
      booked: (state === 'booked' || state === 'past') && r.starts_at ? iso(r.starts_at) : null,
    })
  }
  return out
}

/** Заявка человека в боте с открытым предложением; без предложения — последняя заявка этого чата */
export async function applicationForChat(sql: Sql, channel: string, userId: string): Promise<string | null> {
  const [offered] = await sql<{ id: string }[]>`
    select a.id from booking_offers o join applications a on a.id = o.application_id
    where o.closed_at is null and a.anonymized_at is null
      and ((a.channel = ${channel} and a.channel_user_id = ${userId}) or (a.bot_channel = ${channel} and a.bot_user_id = ${userId}))
    order by o.created_at desc limit 1`
  if (offered) return offered.id
  const [latest] = await sql<{ id: string }[]>`
    select id from applications
    where ((channel = ${channel} and channel_user_id = ${userId}) or (bot_channel = ${channel} and bot_user_id = ${userId}))
      and anonymized_at is null
    order by created_at desc limit 1`
  return latest?.id ?? null
}

// ── День найма: сторона HR ───────────────────────────────────────────────

/** День найма для панели: часы, места, сколько записано в каждом часе и сколько пришло по ссылке */
export type HiringDayInfo = {
  id: number
  day: string
  hours: number[]
  capacity: number
  address: string
  label: string
  note: string
  createdBy: string
  createdAt: string
  closedAt: string | null
  /** Записано по часам: «10:00» → сколько человек */
  booked: Record<string, number>
  /** Сколько кандидатов пришло по ссылке дня и получили выбор часа */
  offers: number
}

const hh = (h: number) => `${String(h).padStart(2, '0')}:00`

async function hiringDayInfo(deps: BookingDeps, row: HiringDayRow): Promise<HiringDayInfo> {
  const load = await hourLoad(deps.sql, mskAt(row.day, 0), mskAt(nextDay(row.day), 0))
  const [{ n }] = await deps.sql<{ n: number }[]>`select count(*)::int as n from booking_offers where hiring_day_id = ${row.id}`
  const hours = [...row.hours].sort((a, b) => a - b)
  return {
    id: Number(row.id),
    day: row.day,
    hours,
    capacity: row.capacity,
    address: row.address || interviewDefaults.address,
    label: row.label,
    note: row.note,
    createdBy: row.created_by_name,
    createdAt: iso(row.created_at),
    closedAt: row.closed_at ? iso(row.closed_at) : null,
    booked: Object.fromEntries(hours.map((h) => [hh(h), load[hourKey(mskAt(row.day, h))] ?? 0])),
    offers: n,
  }
}

/** Дни найма: открытые и прошедшие за последний месяц, ближайшие первыми */
export async function listHiringDays(deps: BookingDeps, now = Date.now()): Promise<HiringDayInfo[]> {
  const since = new Date(Date.parse(`${mskParts(now).day}T00:00:00Z`) - 30 * DAY).toISOString().slice(0, 10)
  const rows = await deps.sql<HiringDayRow[]>`
    select *, to_char(day, 'YYYY-MM-DD') as day from hiring_days
    where closed_at is null or day >= ${since}::date
    order by hiring_days.closed_at is not null, hiring_days.day, hiring_days.id limit 100`
  return Promise.all(rows.map((r) => hiringDayInfo(deps, r)))
}

export type HiringDayInput = { day?: unknown; hours?: unknown; capacity?: unknown; address?: unknown; label?: unknown; note?: unknown }

/**
 * Новый день найма. Метка по умолчанию — hiringday; одна метка — один открытый день. Оформление в тот же день
 * не обещаем: в выбранный час — собеседование, дату оформления называет HR
 */
export async function createHiringDay(
  deps: BookingDeps,
  raw: HiringDayInput,
  by: HrUser,
  now = Date.now(),
): Promise<{ ok: true; day: HiringDayInfo } | { ok: false; message: string }> {
  const problem = hiringDayProblem(raw, now)
  if (problem) return { ok: false, message: problem }
  const label = raw.label === undefined || raw.label === null || raw.label === '' ? 'hiringday' : typeof raw.label === 'string' ? raw.label.trim().toLowerCase() : ''
  if (!isHiringLabel(label)) return { ok: false, message: 'Метка — hiringday или hiringday-<латиница и цифры>, до 40 символов, например hiringday-mgupp' }
  const [busy] = await deps.sql<{ day: string }[]>`select to_char(day, 'YYYY-MM-DD') as day from hiring_days where label = ${label} and closed_at is null`
  if (busy) return { ok: false, message: `Метка ${label} уже у дня найма — ${dayLong(busy.day)}. Возьми другую или отмени тот день` }
  const address = typeof raw.address === 'string' && raw.address.trim() ? raw.address.trim().slice(0, 300) : interviewDefaults.address
  const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, 300) : ''
  const hours = [...(raw.hours as number[])].sort((a, b) => a - b)
  const [row] = await deps.sql<HiringDayRow[]>`
    insert into hiring_days (day, hours, capacity, address, label, note, created_by, created_by_name)
    values (${raw.day as string}::date, ${deps.sql.array(hours)}::int[], ${raw.capacity as number}, ${address}, ${label}, ${note},
            ${by.id > 0 ? by.id : null}, ${by.name})
    returning *, to_char(day, 'YYYY-MM-DD') as day`
  return { ok: true, day: await hiringDayInfo(deps, row) }
}

/**
 * Отменить день найма: по ссылке больше не записываются, кто ещё не выбрал час — часов не видит.
 * Назначенные собеседования остаются: их HR переносит или отменяет сам
 */
export async function closeHiringDay(deps: BookingDeps, id: number): Promise<boolean> {
  const rows = await deps.sql`update hiring_days set closed_at = now() where id = ${id} and closed_at is null returning id`
  if (!rows.length) return false
  await deps.sql`update booking_offers set closed_at = now() where hiring_day_id = ${id} and closed_at is null and used_at is null`
  return true
}

