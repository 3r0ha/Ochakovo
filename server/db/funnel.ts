import { declineReasons, seasonLeaveReasons, type ApplicationStatus, type HrApplication } from '@shared/applications'
import { caseMetrics, FULL_SHIFT_TARGET, isAnyReferral, seasonCounts, taskIds, tasksHiring, type CaseMetrics, type TaskId, type TasksHiringRow } from '@shared/hr'
import { sourceKey, stageCounts } from '@shared/hrFilter'
import { planProgress, planTotals, seasonOf, type PlanEntry } from '@shared/hrPlan'
import type { Sql } from './index'

// «Воронка» HR-панели: от первого захода до конца сезона по источникам, «Задания и наём», отчёт по неделям,
// причины отказа и ухода, явка на собеседование, приглашения друзей, расходы по меткам и цифры кейса рядом
// с цифрами компании. HrRepo.funnel отдаёт этот отчёт как есть — в панель (GET /api/hr/funnel),
// на лист «Воронка» и «Недели» выгрузки и на Яндекс Диск.

/** game_start — нажали «Играть», share — поделились; вид (game, money, invite) — в колонке task (миграция 020) */
export type FunnelEventType = 'visit' | 'task_done' | 'apply_open' | 'application' | 'game_start' | 'share'

/**
 * Игра и «поделиться» на сайте: сколько посетителей нажали «Играть», сколько поделились (всего и по видам),
 * сколько пришли по ссылке друга и сколько из них оставили заявку. null — таких событий за период нет, блок скрыт
 */
export type GameShare = {
  started: number
  shared: number
  /** Поделились по видам: game — результатом игры, money — расчётом «Собери лето», invite — приглашением */
  sharedBy: Record<string, number>
  /** Посетители, пришедшие по ссылке друга (метка friend-<код>), и сколько из них отправили заявку */
  cameByLink: number
  applied: number
}

export type FunnelRow = {
  /** Ключ источника: метка ?src=, start-параметр бота или канал; '' — прямой заход на сайт */
  source: string
  visitors: number
  tasks: number
  applyOpen: number
  applications: number
  interview: number
  hired: number
  started: number
  /** Из вышедших на смену: «Сезон отработан» и «Звать в штат / резерв». В выгрузке по фильтру их считает лист */
  completed?: number
  stayed?: number
  /** Расход по метке за период, ₽: из реестра меток. В выгрузке по фильтру и без реестра — нет */
  cost?: number
}

/** Какое задание ведёт к заявке: посетители сайта, прошедшие задание, и сколько из них оставили заявку. none — без заданий */
export type TaskLeadRow = { task: TaskId | 'none'; visitors: number; applied: number }

export type FunnelTasks = {
  /** Заявки по числу пройденных заданий: 0, 1–3, 4 из 4, добавлены HR */
  rows: TasksHiringRow[]
  /** Доля «4 из 4» среди заявок кандидатов; null — заявок кандидатов нет */
  fullShare: number | null
  /** Цель по доле «4 из 4» */
  target: number
  /** Только сайт: связь заданий с заявкой, без доказательства причины */
  leads: TaskLeadRow[]
}

export type WeekRow = {
  /** Начало недели (понедельник по Москве) или периода, ISO */
  start: string
  /** Граница недели или периода, не включительно, ISO */
  end: string
  /** Заявки, пришедшие за неделю, и как далеко они дошли — как плитки над списком */
  applications: number
  interview: number
  hired: number
  started: number
  /** Медиана часов до первого действия HR по заявкам недели; null — ответов не было */
  firstResponseHours: number | null
  /** Доля заявок недели, на которые ответили в первые 24 часа; null — ни одна ещё не дождалась суток */
  answered24h: number | null
  declined: number
  /** Отказы по причинам: id причины → число, '' — причина не указана */
  declines: Record<string, number>
  /** План найма сезона: мест в плане; null — плана нет */
  planTarget: number | null
  /** Мест плана закрыто к концу недели — по заявкам, дошедшим до «К оформлению» к этому сроку */
  planDone: number | null
  /** Заявки недели, у которых отмечено «Сезон отработан» и «Звать в штат / резерв» */
  completed?: number
  stayed?: number
  /** Расход по всем меткам за неделю, ₽; null — реестра меток с расходами нет */
  cost?: number | null
}

/** Причина в списке «Почему отказ» и «Почему ушли»: id, подпись, сколько */
export type ReasonCount = { reason: string; label: string; count: number }

/** Явка на собеседование: прошедшие слоты заявок периода. came — «Явка», marked — с отметкой, unmarked — без неё */
export type Attendance = { came: number; marked: number; unmarked: number }

/** Приглашение друга: кто позвал, кого и дошёл ли приглашённый до смены */
export type InviteRow = {
  /** Заявка приглашённого */
  id: string
  /** Метка: friend-<код> или старая friend и share без кода */
  source: string
  /** Имя пригласившего; '' — его не найти: старая ссылка без кода или он сам заявку не оставлял */
  inviter: string
  invited: string
  status: ApplicationStatus
  started: boolean
}

export type FunnelReport = {
  rows: FunnelRow[]
  /** Причины отказа за период */
  declines: ReasonCount[]
  /** Почему ушли до конца сезона — рядом с причинами отказа */
  leaves: ReasonCount[]
  attendance: Attendance
  /** Приглашения друзей за период: дошедшие до смены — первыми */
  invites: InviteRow[]
  /** Расходы по меткам известны: есть реестр меток (w2-hr-sources). Иначе колонок расхода нет */
  costsKnown: boolean
  /** Цифры кейса по данным панели — рядом с цифрами компании (companyBaseline) */
  caseMetrics: CaseMetrics
  /** Игра и «поделиться»; null — событий нет */
  game: GameShare | null
  /** Медиана времени от заявки до первого действия HR, в часах; null — не было ответов. Добавленных HR не считаем */
  firstResponseHours: number | null
  /** Доля заявок, на которые HR ответил в первые 24 часа; null — ни одна ещё не дождалась суток */
  answered24h: number | null
  tasks: FunnelTasks
  weeks: WeekRow[]
}

const HOUR = 3600e3
const DAY = 24 * HOUR
const MSK = 3 * HOUR

/** Понедельник 00:00 по Москве для недели, в которую попадает момент t */
export function weekStart(t: Date): Date {
  const d = new Date(t.getTime() + MSK)
  const weekday = (d.getUTCDay() + 6) % 7
  d.setUTCHours(0, 0, 0, 0)
  return new Date(d.getTime() - weekday * DAY - MSK)
}

/** Недели периода: с понедельника по понедельник, крайние обрезаны границами периода */
export function weekBounds(from: Date, to: Date): { start: Date; end: Date }[] {
  const out: { start: Date; end: Date }[] = []
  for (let s = weekStart(from); s < to; s = new Date(s.getTime() + 7 * DAY)) {
    const e = new Date(s.getTime() + 7 * DAY)
    out.push({ start: s < from ? from : s, end: e > to ? to : e })
  }
  return out
}

/** Медиана как percentile_cont(0.5) в PostgreSQL: при чётном числе — среднее двух средних */
export function median(values: number[]): number | null {
  if (!values.length) return null
  const v = [...values].sort((a, b) => a - b)
  const mid = v.length >> 1
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

type FirstAction = { createdAt: number; firstAt: number | null }

/** Время первого ответа: медиана часов и доля ответов в первые сутки. Свежие заявки без ответа сутки ещё не прождали */
function responseStats(list: FirstAction[], now: number) {
  const hours = list.filter((r) => r.firstAt !== null).map((r) => (r.firstAt! - r.createdAt) / HOUR)
  const due = list.filter((r) => r.firstAt !== null || now - r.createdAt >= DAY)
  const fast = due.filter((r) => r.firstAt !== null && r.firstAt - r.createdAt <= DAY).length
  return { firstResponseHours: median(hours), answered24h: due.length ? fast / due.length : null }
}

/** Период «за всё время» начинаем с недели первой заявки: с начала отсчёта Unix получились бы тысячи пустых недель */
const LONG_PERIOD = 180 * DAY

/** Расходы по меткам за период, ₽ по коду метки — контракт sourceCosts из server/db/sources.ts */
export type SourceCosts = (sql: Sql, from: Date, to: Date) => Promise<Record<string, number>>

let costsModule: Promise<SourceCosts | null> | null = null

/**
 * sourceCosts из реестра меток (server/db/sources.ts, пакет w2-hr-sources) — если модуль есть. Без реестра расходов
 * нет и колонок расхода в «Воронке» тоже: «0 ₽» было бы неправдой. Модуль ищется один раз за запуск сервера
 */
function defaultCosts(): Promise<SourceCosts | null> {
  costsModule ??= (import('./sources' as string) as Promise<{ sourceCosts?: unknown }>)
    .then((m) => (typeof m.sourceCosts === 'function' ? (m.sourceCosts as SourceCosts) : null))
    .catch((e: { code?: string; message?: string }) => {
      if (e?.code !== 'ERR_MODULE_NOT_FOUND') console.warn(`[funnel] расходы по меткам не подключены: ${e?.message ?? e}`)
      return null
    })
  return costsModule
}

/** Расходы за период: сбой реестра не ломает «Воронку» — колонки расхода просто пропадают */
async function loadCosts(fn: SourceCosts | null, sql: Sql, from: Date, to: Date): Promise<Record<string, number> | null> {
  if (!fn) return null
  try {
    const raw = await fn(sql, from, to)
    return Object.fromEntries(Object.entries(raw ?? {}).filter(([, v]) => Number.isFinite(v) && v > 0))
  } catch (e) {
    console.warn(`[funnel] расходы по меткам не прочитались: ${(e as Error).message}`)
    return null
  }
}

export type FunnelOptions = {
  /** Откуда брать расходы: по умолчанию sourceCosts из реестра меток; null — без расходов. Для проверок */
  costs?: SourceCosts | null
}

/**
 * Воронка по источникам за период. «Пришли» и «Прошли задание»: сайт — по анонимным событиям,
 * боты — по аудитории и прогрессу в сессиях. Заявки и дальше — по заявкам за период, той же функцией
 * stageCounts, что и плитки над списком: этап засчитан, если заявка в нём побывала.
 * apps — все заявки (WorkflowRepo.list): из них берутся заявки периода и сезона для плана
 */
export async function funnelReport(sql: Sql, from: Date, to: Date, apps: HrApplication[], now = Date.now(), opts: FunnelOptions = {}): Promise<FunnelReport> {
  const costsFn = opts.costs === undefined ? await defaultCosts() : opts.costs
  const costs = await loadCosts(costsFn, sql, from, to)
  const web = await sql<{ source: string; visitors: number; tasks: number; apply_open: number }[]>`
    select coalesce(source, '') as source,
           count(distinct visitor) filter (where type = 'visit')::int as visitors,
           count(distinct visitor) filter (where type = 'task_done')::int as tasks,
           count(distinct visitor) filter (where type = 'apply_open')::int as apply_open
    from funnel_events
    where created_at >= ${from} and created_at < ${to}
    group by 1`

  // Ключ источника: у бота без метки — сам канал. Чат на сайте не считаем: его посетителей
  // уже посчитала страница событием visit, иначе каждый открывший чат попадал бы в «Пришли» дважды
  const bots = await sql<{ source: string; visitors: number; tasks: number }[]>`
    select coalesce(nullif(b.source, ''), b.channel) as source,
           count(*)::int as visitors,
           count(*) filter (where s.data -> 'progress' ?| array['game', 'money', 'quiz', 'myth'])::int as tasks
    from bot_users b
    left join sessions s on s.channel = b.channel and s.user_id = b.user_id
    where b.channel <> 'web' and b.created_at >= ${from} and b.created_at < ${to}
    group by 1`

  const rows = new Map<string, FunnelRow>()
  const row = (source: string) => {
    let r = rows.get(source)
    if (!r) {
      r = { source, visitors: 0, tasks: 0, applyOpen: 0, applications: 0, interview: 0, hired: 0, started: 0 }
      rows.set(source, r)
    }
    return r
  }
  for (const w of web) {
    const r = row(w.source)
    r.visitors += w.visitors
    r.tasks += w.tasks
    r.applyOpen += w.apply_open
  }
  for (const b of bots) {
    const r = row(b.source)
    r.visitors += b.visitors
    r.tasks += b.tasks
  }

  const inPeriod = apps.filter((a) => !a.duplicateOf && new Date(a.createdAt) >= from && new Date(a.createdAt) < to)
  const bySource = new Map<string, HrApplication[]>()
  for (const a of inPeriod) bySource.set(sourceKey(a), [...(bySource.get(sourceKey(a)) ?? []), a])
  for (const [source, list] of bySource) Object.assign(row(source), stageCounts(list))
  // Метка с расходом, но без единого захода и заявки, — тоже строка: иначе её расход выпал бы из «Итого»
  if (costs) for (const source of Object.keys(costs)) row(source)
  for (const r of rows.values()) {
    const { completed, stayed } = seasonCounts(bySource.get(r.source) ?? [])
    Object.assign(r, { completed, stayed }, costs ? { cost: costs[r.source] ?? 0 } : {})
  }

  const declines = declineReasons
    .map((r) => ({ reason: r.id as string, label: r.label, count: inPeriod.filter((a) => a.status === 'declined' && a.declineReason === r.id).length }))
    .concat([{ reason: '', label: 'Причина не указана', count: inPeriod.filter((a) => a.status === 'declined' && !a.declineReason).length }])
    .filter((d) => d.count > 0)
    .sort((a, b) => b.count - a.count)

  const leftList = inPeriod.filter((a) => a.status === 'started' && a.seasonOutcome === 'left')
  const leaves = seasonLeaveReasons
    .map((r) => ({ reason: r.id as string, label: r.label, count: leftList.filter((a) => a.seasonLeaveReason === r.id).length }))
    .concat([{ reason: '', label: 'Причина не указана', count: leftList.filter((a) => !a.seasonLeaveReason).length }])
    .filter((d) => d.count > 0)
    .sort((a, b) => b.count - a.count)

  // Явка: прошедшие собеседования заявок периода. Процент — только по слотам с отметкой
  const past = inPeriod.filter((a) => a.interview && new Date(a.interview.startsAt).getTime() <= now)
  const attendance: Attendance = {
    came: past.filter((a) => a.interview!.attended === 'yes').length,
    marked: past.filter((a) => a.interview!.attended !== '').length,
    unmarked: past.filter((a) => a.interview!.attended === '').length,
  }

  // Первое действие HR по заявке: любая запись истории от сотрудника. Добавленных HR не считаем:
  // первую запись у них делает сам сотрудник в момент добавления, ответа кандидат не ждал
  const firstRows = await sql<{ id: string; created_at: Date; first_at: Date | null }[]>`
    select a.id, a.created_at,
           (select min(h.created_at) from application_history h
            where h.application_id = a.id and h.user_id is not null and h.undone_at is null) as first_at
    from applications a
    where a.created_at >= ${from} and a.created_at < ${to} and a.duplicate_of is null and a.channel <> 'hr'`
  const firsts = firstRows.map((r) => ({ createdAt: r.created_at.getTime(), firstAt: r.first_at?.getTime() ?? null }))
  const response = responseStats(firsts, now)

  const sorted = [...rows.values()].sort((a, b) => b.applications - a.applications || b.visitors - a.visitors)
  return {
    rows: sorted,
    declines,
    leaves,
    attendance,
    invites: await invites(sql, inPeriod),
    game: await gameShare(sql, from, to),
    costsKnown: costs !== null,
    caseMetrics: caseMetrics(inPeriod, sorted.reduce((n, r) => n + r.visitors, 0), now),
    ...response,
    tasks: { ...tasksHiring(inPeriod), target: FULL_SHIFT_TARGET, leads: await taskLeads(sql, from, to) },
    weeks: await weeks(sql, from, to, apps, inPeriod, firsts, now, costs ? costsFn : null),
  }
}

/**
 * Игра и «поделиться» за период — только сайт: события game_start и share. «Пришли по ссылке» — посетители с меткой
 * друга (ссылки «поделиться» и «Позвать друга» ведут на ?src=ref_<код>, сайт пишет метку friend-<код>); заявки —
 * их события «заявка» до конца периода
 */
async function gameShare(sql: Sql, from: Date, to: Date): Promise<GameShare | null> {
  const [counts] = await sql<{ started: number; shared: number }[]>`
    select count(distinct visitor) filter (where type = 'game_start')::int as started,
           count(distinct visitor) filter (where type = 'share')::int as shared
    from funnel_events
    where channel = 'web' and type in ('game_start', 'share') and created_at >= ${from} and created_at < ${to}`
  if (!counts.started && !counts.shared) return null
  const kinds = await sql<{ kind: string; n: number }[]>`
    select coalesce(task, '') as kind, count(distinct visitor)::int as n from funnel_events
    where channel = 'web' and type = 'share' and created_at >= ${from} and created_at < ${to}
    group by 1`
  const [link] = await sql<{ came: number; applied: number }[]>`
    with came as (
      select distinct visitor from funnel_events
      where channel = 'web' and type = 'visit' and source like 'friend-%' and created_at >= ${from} and created_at < ${to}
    )
    select count(*)::int as came,
           count(*) filter (where exists (
             select 1 from funnel_events e where e.visitor = came.visitor and e.type = 'application' and e.created_at < ${to}
           ))::int as applied
    from came`
  return { ...counts, sharedBy: Object.fromEntries(kinds.map((k) => [k.kind, k.n])), cameByLink: link.came, applied: link.applied }
}

/**
 * Приглашения друзей за период: кто позвал, кого и вышел ли приглашённый на смену. Обезличенные и дубли не показываем.
 * Дошедшие до смены — первыми: по ним видно, чьё приглашение сработало
 */
async function invites(sql: Sql, inPeriod: HrApplication[]): Promise<InviteRow[]> {
  const invited = inPeriod.filter((a) => isAnyReferral(a.source) && !a.anonymizedAt)
  const codes = [...new Set(invited.filter((a) => a.source!.startsWith('friend-')).map((a) => a.source!.slice('friend-'.length)))]
  const names = await referrerNames(sql, codes)
  return invited
    .map((a) => ({
      id: a.id,
      source: a.source!,
      inviter: a.source!.startsWith('friend-') ? (names[a.source!.slice('friend-'.length)] ?? '') : '',
      invited: [a.name, a.lastName].filter(Boolean).join(' '),
      status: a.status,
      started: stageCounts([a]).started > 0,
      createdAt: a.createdAt,
    }))
    .sort((a, b) => Number(b.started) - Number(a.started) || b.createdAt.localeCompare(a.createdAt))
    .map(({ createdAt: _createdAt, ...r }) => r)
}

/**
 * Какое задание ведёт к заявке — только сайт: у ботов задания и заявка в одном диалоге и посчитаны иначе.
 * Берём посетителей, у которых было событие за период, и все их задания и заявки до конца периода:
 * задание, пройденное на прошлой неделе, тоже привело к заявке этой недели. Это связь, а не причина
 */
async function taskLeads(sql: Sql, from: Date, to: Date): Promise<TaskLeadRow[]> {
  const found = await sql<{ task: string; visitors: number; applied: number }[]>`
    with active as (
      select distinct visitor from funnel_events where channel = 'web' and created_at >= ${from} and created_at < ${to}
    ), v as (
      select e.visitor,
             coalesce(array_agg(distinct e.task) filter (where e.type = 'task_done' and e.task is not null), '{}') as tasks,
             bool_or(e.type = 'application') as applied
      from funnel_events e join active using (visitor)
      where e.channel = 'web' and e.created_at < ${to}
      group by e.visitor
    )
    select t.task, count(*)::int as visitors, count(*) filter (where v.applied)::int as applied
    from v cross join lateral unnest(case when cardinality(v.tasks) = 0 then array['']::text[] else v.tasks end) as t(task)
    group by t.task`
  const get = (task: string) => {
    const r = found.find((x) => x.task === task)
    return { visitors: r?.visitors ?? 0, applied: r?.applied ?? 0 }
  }
  return [...taskIds.map((task) => ({ task, ...get(task) })), { task: 'none' as const, ...get('') }]
}

/**
 * Отчёт по неделям. Заявки, этапы, первый ответ и отказы — по заявкам, пришедшим за неделю (как плитки над списком),
 * поэтому сумма недель равна итогу периода. План и факт — нарастающим итогом: сколько мест плана сезона закрыто
 * к концу недели заявками, дошедшими до «К оформлению» к этому сроку
 */
async function weeks(
  sql: Sql,
  from: Date,
  to: Date,
  apps: HrApplication[],
  inPeriod: HrApplication[],
  firsts: FirstAction[],
  now: number,
  costsFn: SourceCosts | null,
): Promise<WeekRow[]> {
  let start = from
  if (to.getTime() - from.getTime() > LONG_PERIOD) {
    const earliest = Math.min(...inPeriod.map((a) => new Date(a.createdAt).getTime()))
    if (!Number.isFinite(earliest)) return []
    start = new Date(Math.max(from.getTime(), weekStart(new Date(earliest)).getTime()))
  }
  const bounds = weekBounds(start, to)
  if (!bounds.length) return []

  // План по сезонам недель и момент, когда заявка впервые дошла до «К оформлению» или «На смене»
  const seasons = [...new Set(bounds.map((b) => seasonOf(new Date(b.end.getTime() - 1))))]
  const plans = new Map<number, PlanEntry[]>()
  for (const season of seasons) {
    const entries = await sql<{ vacancy_id: string; month: number; target: number }[]>`
      select vacancy_id, month, target from hiring_plan where season = ${season} and target > 0`
    plans.set(season, entries.map((e) => ({ vacancyId: e.vacancy_id, month: e.month, target: e.target })))
  }
  const hiredAt = new Map<string, number>()
  const ids = apps.filter((a) => !a.duplicateOf && stageCounts([a]).hired).map((a) => a.id)
  if (ids.length && [...plans.values()].some((p) => p.length)) {
    const hired = await sql<{ id: string; at: Date }[]>`
      select application_id as id, min(created_at) as at from application_history
      where to_status in ('hired', 'started') and undone_at is null and application_id = any(${ids})
      group by application_id`
    for (const h of hired) hiredAt.set(h.id, h.at.getTime())
  }

  // Расход недели — по всем меткам; null — расходов нет в реестре или самого реестра нет
  const weekCosts = costsFn
    ? await Promise.all(bounds.map(async (b) => Object.values((await loadCosts(costsFn, sql, b.start, b.end)) ?? {}).reduce((n, v) => n + v, 0)))
    : null

  return bounds.map(({ start, end }, i) => {
    const inWeek = (t: number) => t >= start.getTime() && t < end.getTime()
    const list = inPeriod.filter((a) => inWeek(new Date(a.createdAt).getTime()))
    const declined = list.filter((a) => a.status === 'declined')
    const reasons: Record<string, number> = {}
    for (const a of declined) reasons[a.declineReason] = (reasons[a.declineReason] ?? 0) + 1

    const season = seasonOf(new Date(end.getTime() - 1))
    const plan = plans.get(season) ?? []
    let planTarget: number | null = null
    let planDone: number | null = null
    if (plan.length) {
      const done = apps
        .filter((a) => !a.duplicateOf && (hiredAt.get(a.id) ?? Infinity) < end.getTime())
        .map((a) => ({ ...a, status: 'hired' as const, reached: ['hired' as const] }))
      const totals = planTotals(planProgress(plan, done, season))
      planTarget = totals.target
      planDone = totals.hired
    }

    return {
      start: start.toISOString(),
      end: end.toISOString(),
      ...stageCounts(list),
      ...responseStats(firsts.filter((f) => inWeek(f.createdAt)), now),
      declined: declined.length,
      declines: reasons,
      planTarget,
      planDone,
      ...(({ completed, stayed }) => ({ completed, stayed }))(seasonCounts(list)),
      cost: weekCosts ? weekCosts[i] : null,
    }
  })
}

/**
 * Имена пригласивших по кодам — для расшифровки строки «Приглашения друзей». Код бывает из бота
 * (сессия, data.ref) и с сайта (код браузера, закреплённый за заявкой пригласившего)
 */
export async function referrerNames(sql: Sql, codes: string[]): Promise<Record<string, string>> {
  if (!codes.length) return {}
  const fromBots = await sql<{ code: string; name: string | null }[]>`
    select s.data -> 'data' ->> 'ref' as code,
           coalesce(
             (select name from applications a where a.channel = s.channel and a.channel_user_id = s.user_id and a.anonymized_at is null
              order by created_at desc limit 1),
             b.first_name
           ) as name
    from sessions s
    left join bot_users b on b.channel = s.channel and b.user_id = s.user_id
    where s.data -> 'data' ->> 'ref' = any(${codes})`
  const fromSite = await sql<{ code: string; name: string }[]>`
    select ref_code as code, name from applications where ref_code = any(${codes}) and anonymized_at is null`
  return Object.fromEntries([...fromBots, ...fromSite].filter((r) => r.name).map((r) => [r.code, r.name!]))
}
