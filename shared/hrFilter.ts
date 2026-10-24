import { hardSignal } from './adaptation'
import {
  applicationStatuses,
  citizenshipOptions,
  isDeclineReason,
  isStatus,
  medBookOptions,
  shiftOptions,
  startReadyOptions,
  type ApplicationStatus,
  type Citizenship,
  type DeclineReason,
  type HrApplication,
  type MedBook,
  type ShiftPreference,
  type StartReady,
} from './applications'
import { vacancyById, vacancyFormats, type VacancyFormat } from './content/vacancies'
import { departments, type DepartmentId } from './content/departments'

// Фильтр списка заявок — один и тот же в панели, в выгрузках и на сервере.
// Плитки над списком и воронка считают этапы одной функцией stageCounts.

export type HrFilter = {
  /** Имя, фамилия, телефон, ник, учёба или номер заявки */
  q?: string
  statuses?: ApplicationStatus[]
  vacancy?: string
  department?: DepartmentId
  /** Хоть один из выбранных месяцев в заявке */
  months?: number[]
  /** Метка источника; 'friends' — все приглашения друзей, 'direct' — без метки */
  source?: string
  /** Новая заявка без ответа дольше N часов */
  waitingHours?: number
  /** 'me' — мои, 'none' — без ответственного, число — конкретный сотрудник */
  assignee?: 'me' | 'none' | number
  /** Задача «перезвонить» на сегодня или просрочена */
  callbackDue?: boolean
  /** Есть другие заявки с тем же телефоном */
  duplicates?: boolean
  /** Заявки за период, YYYY-MM-DD по Москве, включительно */
  from?: string
  to?: string
  /** Анкета: гражданство, медкнижка, смены; 'none' — не указано */
  citizenship?: Citizenship | 'none'
  medBook?: MedBook | 'none'
  shifts?: ShiftPreference | 'none'
  /** 18+: true — подтверждено, false — не подтверждено или не ответил */
  adult?: boolean
  /** Задания на сайте и в боте: ни одного, от одного до трёх или все четыре («Смена N/4»). Добавленных HR не считает */
  tasks?: TaskFilter
  /** Собеседование прошло, а явку не отметили */
  unmarked?: boolean
  /** Когда может выйти: «Сразу», «Через 1–2 недели», «После сессии», «С определённого месяца»; 'none' — не ответил */
  startReady?: StartReady | 'none'
  /** Причина отказа — любая из выбранных */
  declineReasons?: DeclineReason[]
  /** Нужна практика от вуза: договор и дневник */
  practice?: boolean
  /** Хочет остаться после сезона */
  stay?: boolean
  /** Формат: оплачиваемая или бесплатная практика, постоянная работа — по заявке, а без него — по вакансии */
  format?: VacancyFormat
  /** «Идут вдвоём»: кандидат пришёл по приглашению другого кандидата или сам позвал того, кто подал заявку */
  pair?: boolean
  /** Вид «Резерв»: отказы «Нет мест» и «Не совпал график», отметки «Звать в штат / резерв», «хочет остаться» */
  reserve?: boolean
  /** «Тяжело на смене»: последний ответ новичка на «Как дела на смене» — «Тяжело», итог сезона ещё не отмечен */
  hardShift?: boolean
  /** Сортировка списка: поле и направление */
  sort?: SortSpec
  /** Выбранные строки — для массовой выгрузки */
  ids?: string[]
}

/**
 * Сколько заданий пройдено: ни одного, от одного до трёх, все четыре. Те же строки, что в блоке «Задания и наём»
 * «Воронки» (taskBucketOf в shared/hr.ts): кандидаты, которых добавили HR, — отдельной строкой, в эти три не входят
 */
export type TaskFilter = 'none' | 'some' | 'all'
export const taskFilters: { id: TaskFilter; label: string }[] = [
  { id: 'none', label: 'Задания: 0' },
  { id: 'some', label: 'Задания: 1–3' },
  { id: 'all', label: 'Задания: 4 из 4' },
]

/** Прежние значения в адресе и сохранённых видах: tasks=0, 1-3, 4 */
const legacyTasks = new Map<string, TaskFilter>([
  ['0', 'none'],
  ['1-3', 'some'],
  ['4', 'all'],
])

/** Задания из четырёх у заявки — как «Смена N/4» на сайте */
export const tasksDone = (a: Pick<HrApplication, 'game'>) => Math.max(0, Math.min(4, a.game?.activities ?? 0))

/** Строка фильтра «Задания» для заявки; null — кандидата добавил HR (звонок, визит, импорт), заданий у него не было */
export const taskFilterOf = (a: Pick<HrApplication, 'game' | 'channel'>): TaskFilter | null => {
  if (a.channel === 'hr') return null
  const n = tasksDone(a)
  return n === 0 ? 'none' : n === 4 ? 'all' : 'some'
}

/** Причины отказа, после которых человека стоит позвать снова: мест не было или не совпал график */
export const reserveDeclineReasons: DeclineReason[] = ['no_slots', 'schedule']

/** В резерве: отказ «Нет мест» или «Не совпал график», отметка «Звать в штат / резерв», «хочет остаться». Без обезличенных и дублей */
export function inReserve(a: Pick<HrApplication, 'status' | 'declineReason' | 'reserve' | 'wantsToStay' | 'anonymizedAt' | 'duplicateOf'>) {
  if (a.anonymizedAt || a.duplicateOf) return false
  return (a.status === 'declined' && reserveDeclineReasons.includes(a.declineReason as DeclineReason)) || a.reserve || Boolean(a.wantsToStay)
}

/** Формат заявки: что выбрал кандидат, а если пусто — формат вакансии */
export const formatOf = (a: Pick<HrApplication, 'format' | 'vacancyId'>): VacancyFormat | '' => a.format || vacancyById(a.vacancyId)?.format || ''

/**
 * «Идут вдвоём»: заявки, где один кандидат пришёл по ссылке «Позвать друга» другого кандидата (источник friend-<код>,
 * код — refCode другой заявки). В набор попадают обе. Своя ссылка не засчитывается
 */
export function pairIds(list: Pick<HrApplication, 'id' | 'source' | 'refCode' | 'duplicateOf' | 'anonymizedAt'>[]): Set<string> {
  const byCode = new Map<string, string>()
  for (const a of list) if (a.refCode && !a.duplicateOf && !a.anonymizedAt) byCode.set(a.refCode, a.id)
  const out = new Set<string>()
  for (const a of list) {
    if (a.duplicateOf || a.anonymizedAt || !a.source?.startsWith('friend-')) continue
    const inviter = byCode.get(a.source.slice('friend-'.length))
    if (!inviter || inviter === a.id) continue
    out.add(a.id)
    out.add(inviter)
  }
  return out
}

/** Собеседование уже прошло, а итог — явка или неявка — не отмечен. Только у заявок в статусе «Собеседование» */
export function attendancePending(a: Pick<HrApplication, 'status' | 'interview'>, now = Date.now()) {
  return a.status === 'interview' && Boolean(a.interview) && a.interview!.attended === '' && new Date(a.interview!.startsAt).getTime() <= now
}

/**
 * «Поровну между…»: заявки по очереди раздаются сотрудникам, у каждого — одинаково, разница не больше одной.
 * offset — с какого сотрудника начинать (продолжить раздачу, начатую раньше). Ответ: id сотрудника → заявки
 */
export function evenSplit<T>(items: T[], assignees: number[], offset = 0): Map<number, T[]> {
  const out = new Map<number, T[]>(assignees.map((id) => [id, []]))
  if (!assignees.length) return out
  items.forEach((item, i) => out.get(assignees[(offset + i) % assignees.length])!.push(item))
  return out
}

// ── Обзвон ─────────────────────────────────────────────────────────────────

/** Чем закончился звонок в обзвоне */
export type CallOutcome = 'reached' | 'missed'

/**
 * Обзвон: список заявок запоминается при старте и дальше не меняется, даже если статусы ушли из фильтра.
 * pos — открытая сейчас заявка, outcomes — итог по каждой, где звонок был.
 * marks — отпечаток заявки при старте (callMark): заявку, которую с тех пор изменили, обзвон пропускает — skipped
 */
export type CallRun = { ids: string[]; pos: number; outcomes: Record<string, CallOutcome>; marks?: Record<string, string>; skipped?: string[] }

/**
 * Отпечаток заявки для обзвона: статус и число недозвонов. Их меняет тот, кто звонил: «Связались», «Не отвечает»,
 * приглашение, отказ. Задачу «перезвонить» ставит и сама панель (напоминание о собеседовании) — она не в счёт
 */
export const callMark = (a: Pick<HrApplication, 'status' | 'noAnswerCount'>) => `${a.status}:${a.noAnswerCount}`

export function startCall(ids: string[], apps: Pick<HrApplication, 'id' | 'status' | 'noAnswerCount'>[] = []): CallRun {
  const list = [...new Set(ids)]
  const wanted = new Set(list)
  const marks = Object.fromEntries(apps.filter((a) => wanted.has(a.id)).map((a) => [a.id, callMark(a)]))
  return { ids: list, pos: 0, outcomes: {}, marks, skipped: [] }
}

/** Итог звонка: последний ответ по заявке заменяет прежний — повторное «Дозвонились» не считается дважды */
export const recordCall = (run: CallRun, id: string, outcome: CallOutcome): CallRun => ({ ...run, outcomes: { ...run.outcomes, [id]: outcome } })

/** Итог звонка отменили («Отменить» во всплывающем сообщении) — заявка снова без итога */
export function forgetCall(run: CallRun, id: string): CallRun {
  if (!(id in run.outcomes)) return run
  const outcomes = { ...run.outcomes }
  delete outcomes[id]
  return { ...run, outcomes }
}

/**
 * Заявку изменили после старта обзвона — звонить не нужно: её уже ведут. Пропала из списка (обезличена,
 * склеена) — тоже пропускаем. Без отпечатка (старый обзвон из этой вкладки) — не пропускаем
 */
export function callChanged(run: CallRun, id: string, current: Pick<HrApplication, 'status' | 'noAnswerCount' | 'anonymizedAt' | 'duplicateOf'> | undefined) {
  const was = run.marks?.[id]
  if (was === undefined) return false
  return !current || Boolean(current.anonymizedAt) || Boolean(current.duplicateOf) || callMark(current) !== was
}

/** Следующая заявка; заявки, для которых changed(id) — правда, пропускаются и попадают в skipped. null — список кончился */
export function nextCall(run: CallRun, changed: (id: string) => boolean = () => false): CallRun | null {
  const skipped = [...(run.skipped ?? [])]
  for (let pos = run.pos + 1; pos < run.ids.length; pos++) {
    const id = run.ids[pos]
    if (changed(id)) {
      if (!skipped.includes(id)) skipped.push(id)
      continue
    }
    return { ...run, pos, skipped }
  }
  return null
}

/** Пропустить текущую заявку (её изменили, пока обзвон шёл) и перейти дальше */
export function skipCall(run: CallRun, changed: (id: string) => boolean = () => false): { run: CallRun; done: boolean } {
  const id = run.ids[run.pos]
  const marked = { ...run, skipped: [...new Set([...(run.skipped ?? []), id])] }
  const next = nextCall(marked, changed)
  return next ? { run: next, done: false } : { run: { ...marked, pos: run.ids.length - 1 }, done: true }
}

/** «Дозвонились N, недозвон M», пропущенные и где мы: «12 из 47» */
export function callStats(run: CallRun) {
  const values = Object.values(run.outcomes)
  return {
    position: Math.min(run.pos + 1, run.ids.length),
    total: run.ids.length,
    reached: values.filter((v) => v === 'reached').length,
    missed: values.filter((v) => v === 'missed').length,
    skipped: (run.skipped ?? []).filter((id) => !(id in run.outcomes)).length,
  }
}

export type SortKey = 'date' | 'status' | 'vacancy' | 'waiting' | 'interview' | 'name'
export type SortSpec = { key: SortKey; dir: 'asc' | 'desc' }
export const sortKeys: SortKey[] = ['date', 'status', 'vacancy', 'waiting', 'interview', 'name']

/** Срок первого ответа: новая заявка дольше суток подсвечивается */
export const SLA_HOURS = 24

const MSK = 3 * 3600e3
/** Начало дня по Москве для YYYY-MM-DD */
export const mskDayStart = (day: string) => new Date(`${day}T00:00:00+03:00`)
/** Конец сегодняшнего дня по Москве */
export const endOfMskDay = (now = Date.now()) => {
  const d = new Date(now + MSK)
  d.setUTCHours(23, 59, 59, 999)
  return new Date(d.getTime() - MSK)
}

export const isFriendSource = (s: string | null | undefined) => Boolean(s?.startsWith('friend-'))

/** Ключ источника для воронки и фильтра: метка, у бота без метки — канал, у сайта без метки — '' (прямой заход) */
export const sourceKey = (a: Pick<HrApplication, 'source' | 'channel'>) => a.source || (a.channel && a.channel !== 'web' ? a.channel : '')

export function slaBreached(a: Pick<HrApplication, 'status' | 'createdAt'>, now = Date.now(), hours = SLA_HOURS) {
  return a.status === 'new' && now - new Date(a.createdAt).getTime() > hours * 3600e3
}

export function callbackDue(a: Pick<HrApplication, 'callbackAt' | 'status'>, now = Date.now()) {
  return Boolean(a.callbackAt) && new Date(a.callbackAt!).getTime() <= endOfMskDay(now).getTime() && !['declined', 'started'].includes(a.status)
}

export function applyFilter<T extends HrApplication>(list: T[], f: HrFilter, ctx: { meId?: number; now?: number } = {}): T[] {
  const now = ctx.now ?? Date.now()
  const q = f.q?.trim().toLowerCase() ?? ''
  const digits = q.replace(/\D/g, '')
  const ids = f.ids?.length ? new Set(f.ids) : null
  const from = f.from ? mskDayStart(f.from).getTime() : null
  const to = f.to ? mskDayStart(f.to).getTime() + 864e5 : null
  const pairs = f.pair ? pairIds(list) : null
  return list.filter((a) => {
    if (ids) return ids.has(a.id)
    if (a.duplicateOf) return false
    if (f.statuses?.length && !f.statuses.includes(a.status)) return false
    if (f.vacancy && a.vacancyId !== f.vacancy) return false
    if (f.department && a.department !== f.department) return false
    if (f.months?.length && !a.months.some((m) => f.months!.includes(m))) return false
    if (f.source !== undefined && f.source !== '') {
      const key = sourceKey(a)
      if (f.source === 'friends' ? !isFriendSource(key) : f.source === 'direct' ? key !== '' : key !== f.source) return false
    }
    if (f.waitingHours !== undefined && !slaBreached(a, now, f.waitingHours)) return false
    if (f.assignee === 'me' && (ctx.meId === undefined || a.assigneeId !== ctx.meId)) return false
    if (f.assignee === 'none' && a.assigneeId !== null) return false
    if (typeof f.assignee === 'number' && a.assigneeId !== f.assignee) return false
    if (f.callbackDue && !callbackDue(a, now)) return false
    if (f.duplicates && !a.duplicates) return false
    const created = new Date(a.createdAt).getTime()
    if (from !== null && created < from) return false
    if (to !== null && created >= to) return false
    if (f.citizenship && (a.citizenship || 'none') !== f.citizenship) return false
    if (f.medBook && (a.medBook || 'none') !== f.medBook) return false
    if (f.shifts && (a.shifts || 'none') !== f.shifts) return false
    if (f.adult !== undefined && (a.adult === true) !== f.adult) return false
    if (f.tasks && taskFilterOf(a) !== f.tasks) return false
    if (f.unmarked && !attendancePending(a, now)) return false
    if (f.startReady && (a.startReady || 'none') !== f.startReady) return false
    if (f.declineReasons?.length && !(a.status === 'declined' && f.declineReasons.includes(a.declineReason as DeclineReason))) return false
    if (f.practice && !a.practiceSchool) return false
    if (f.stay && !a.wantsToStay) return false
    if (f.format && formatOf(a) !== f.format) return false
    if (pairs && !pairs.has(a.id)) return false
    if (f.reserve && !inReserve(a)) return false
    if (f.hardShift && !hardSignal(a)) return false
    if (q) {
      // Слова в любом порядке: «Ульянов Святослав» и «Святослав Ульянов» находят одного человека
      const hay = [a.name, a.lastName ?? '', a.middleName ?? '', a.id, a.contact, a.school, a.mentorName ?? ''].join(' ').toLowerCase().replace(/ё/g, 'е')
      const words = q.replace(/ё/g, 'е').split(/\s+/).filter(Boolean)
      if (!words.every((w) => hay.includes(w)) && !phoneMatches(a.phone, digits)) return false
    }
    return true
  })
}

/** Этапы воронки по заявкам: этап засчитан, если заявка в нём побывала */
export function stageCounts(list: Pick<HrApplication, 'reached' | 'status' | 'duplicateOf'>[]) {
  const live = list.filter((a) => !a.duplicateOf)
  const reached = (a: (typeof live)[number], s: ApplicationStatus[]) => s.includes(a.status) || a.reached.some((r) => s.includes(r))
  return {
    applications: live.length,
    interview: live.filter((a) => reached(a, ['interview', 'hired', 'started'])).length,
    hired: live.filter((a) => reached(a, ['hired', 'started'])).length,
    started: live.filter((a) => reached(a, ['started'])).length,
  }
}

// ── Фильтр в адресной строке и в запросах выгрузки ─────────────────────────

export function filterToParams(f: HrFilter): URLSearchParams {
  const p = new URLSearchParams()
  if (f.q?.trim()) p.set('q', f.q.trim())
  if (f.statuses?.length) p.set('status', f.statuses.join(','))
  if (f.vacancy) p.set('vacancy', f.vacancy)
  if (f.department) p.set('dept', f.department)
  if (f.months?.length) p.set('months', f.months.join(','))
  if (f.source !== undefined && f.source !== '') p.set('source', f.source)
  if (f.waitingHours !== undefined) p.set('waiting', String(f.waitingHours))
  if (f.assignee !== undefined) p.set('assignee', String(f.assignee))
  if (f.callbackDue) p.set('callback', '1')
  if (f.duplicates) p.set('dups', '1')
  if (f.citizenship) p.set('citizenship', f.citizenship)
  if (f.medBook) p.set('medbook', f.medBook)
  if (f.shifts) p.set('shifts', f.shifts)
  if (f.adult !== undefined) p.set('adult', f.adult ? '1' : '0')
  if (f.tasks) p.set('tasks', f.tasks)
  if (f.unmarked) p.set('unmarked', '1')
  if (f.startReady) p.set('start', f.startReady)
  if (f.declineReasons?.length) p.set('reasons', f.declineReasons.join(','))
  if (f.practice) p.set('practice', '1')
  if (f.stay) p.set('stay', '1')
  if (f.format) p.set('format', f.format)
  if (f.pair) p.set('pair', '1')
  if (f.reserve) p.set('reserve', '1')
  if (f.hardShift) p.set('hard', '1')
  if (f.sort && !(f.sort.key === 'date' && f.sort.dir === 'desc')) p.set('sort', `${f.sort.key}:${f.sort.dir}`)
  if (f.from) p.set('from', f.from)
  if (f.to) p.set('to', f.to)
  if (f.ids?.length) p.set('ids', f.ids.join(','))
  return p
}

const pickOption = <T extends string>(v: string | null, list: { id: T }[]) => (v === 'none' || list.some((o) => o.id === v) ? (v as T | 'none') : undefined)

const day = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined)

export function paramsToFilter(p: URLSearchParams): HrFilter {
  const f: HrFilter = {}
  const q = p.get('q')?.slice(0, 100)
  if (q) f.q = q
  const statuses = p.get('status')?.split(',').filter(isStatus)
  if (statuses?.length) f.statuses = statuses
  const vacancy = p.get('vacancy')
  if (vacancy && /^[\w-]{1,60}$/.test(vacancy)) f.vacancy = vacancy
  const dept = p.get('dept')
  if (dept && dept in departments) f.department = dept as DepartmentId
  const months = p
    .get('months')
    ?.split(',')
    .map(Number)
    .filter((m) => Number.isInteger(m) && m >= 1 && m <= 12)
  if (months?.length) f.months = months
  const source = p.get('source')
  if (source && /^[\p{L}\p{N}_.:-]{1,64}$/u.test(source)) f.source = source
  const waiting = Number(p.get('waiting'))
  if (p.has('waiting') && Number.isFinite(waiting) && waiting >= 0) f.waitingHours = Math.min(24 * 60, waiting)
  const assignee = p.get('assignee')
  if (assignee === 'me' || assignee === 'none') f.assignee = assignee
  else if (assignee && /^\d+$/.test(assignee)) f.assignee = Number(assignee)
  if (p.get('callback') === '1') f.callbackDue = true
  if (p.get('dups') === '1') f.duplicates = true
  const citizenship = pickOption<Citizenship>(p.get('citizenship'), citizenshipOptions)
  if (citizenship) f.citizenship = citizenship
  const medBook = pickOption<MedBook>(p.get('medbook'), medBookOptions)
  if (medBook) f.medBook = medBook
  const shifts = pickOption<ShiftPreference>(p.get('shifts'), shiftOptions)
  if (shifts) f.shifts = shifts
  if (p.get('adult') === '1') f.adult = true
  else if (p.get('adult') === '0') f.adult = false
  const tasks = p.get('tasks') ?? ''
  const task = legacyTasks.get(tasks) ?? taskFilters.find((t) => t.id === tasks)?.id
  if (task) f.tasks = task
  if (p.get('unmarked') === '1') f.unmarked = true
  const start = pickOption<StartReady>(p.get('start'), startReadyOptions)
  if (start) f.startReady = start
  const reasons = [...new Set(p.get('reasons')?.split(',').filter(isDeclineReason))]
  if (reasons.length) f.declineReasons = reasons
  if (p.get('practice') === '1') f.practice = true
  if (p.get('stay') === '1') f.stay = true
  const format = p.get('format')
  if (format && vacancyFormats.includes(format as VacancyFormat)) f.format = format as VacancyFormat
  if (p.get('pair') === '1') f.pair = true
  if (p.get('reserve') === '1') f.reserve = true
  if (p.get('hard') === '1') f.hardShift = true
  const [sortKey, sortDir] = (p.get('sort') ?? '').split(':')
  if (sortKeys.includes(sortKey as SortKey) && (sortDir === 'asc' || sortDir === 'desc')) f.sort = { key: sortKey as SortKey, dir: sortDir }
  f.from = day(p.get('from'))
  f.to = day(p.get('to'))
  if (!f.from) delete f.from
  if (!f.to) delete f.to
  const ids = p.get('ids')?.split(',').filter((id) => /^[A-Z0-9]{4,16}$/.test(id)).slice(0, 10000)
  if (ids?.length) f.ids = ids
  return f
}

export const isEmptyFilter = (f: HrFilter) => [...filterToParams(f).keys()].length === 0

/** Статусы, с которыми HR ещё работает: до решения «берём» или «отказ» */
export const workStatuses: ApplicationStatus[] = ['new', 'contacted', 'no_answer', 'interview']

/**
 * Готовые виды — очередь работы на сегодня. Над списком у каждого вида — число заявок в нём.
 * alert — вид появляется, только когда в нём кто-то есть, и подсвечен: это просрочка или сигнал.
 * Список открывается видом «В работе»: дольше всех ждущие ответа — сверху
 */
export const builtInViews: { id: string; name: string; filter: HrFilter; alert?: boolean }[] = [
  { id: 'work', name: 'В работе', filter: { statuses: workStatuses, sort: { key: 'waiting', dir: 'desc' } } },
  { id: 'new', name: 'Ждут ответа', filter: { statuses: ['new'], sort: { key: 'waiting', dir: 'desc' } } },
  { id: 'waiting', name: `Дольше ${SLA_HOURS} ч`, filter: { statuses: ['new'], waitingHours: SLA_HOURS }, alert: true },
  { id: 'callback', name: 'Перезвонить сегодня', filter: { callbackDue: true } },
  { id: 'interview', name: 'Собеседования', filter: { statuses: ['interview'], sort: { key: 'interview', dir: 'asc' } } },
  { id: 'unmarked', name: 'Итог не отмечен', filter: { unmarked: true }, alert: true },
  { id: 'hard', name: 'Тяжело на смене', filter: { hardShift: true }, alert: true },
  { id: 'mine', name: 'Мои', filter: { assignee: 'me' } },
  { id: 'reserve', name: 'Резерв', filter: { reserve: true } },
  { id: 'all', name: 'Все', filter: {} },
]

/** Вид, которым открывается список заявок */
export const defaultView = builtInViews[0]

/**
 * Кому звонить в обзвоне: новые, «Связались» и «Не отвечает» — и все, кому пора перезвонить по задаче.
 * Отказы и тех, кто уже на смене, не обзваниваем. Без телефона позвонить нельзя
 */
export function callable(a: Pick<HrApplication, 'phone' | 'status' | 'callbackAt' | 'anonymizedAt' | 'duplicateOf'>, now = Date.now()) {
  if (!a.phone || a.anonymizedAt || a.duplicateOf) return false
  return ['new', 'contacted', 'no_answer'].includes(a.status) || callbackDue(a, now)
}

/** Телефон для поиска дублей — так же, как колонка phone_norm в базе */
export function phoneNorm(phone: string) {
  const d = phone.replace(/\D/g, '')
  if (d.length === 11 && d.startsWith('8')) return `7${d.slice(1)}`
  if (d.length === 10) return `7${d}`
  return d
}

/** Сколько групп дублей в списке */
export function duplicateGroupCount(list: Pick<HrApplication, 'phone' | 'duplicates' | 'duplicateOf'>[]) {
  return new Set(list.filter((a) => a.duplicates > 0 && !a.duplicateOf).map((a) => phoneNorm(a.phone))).size
}

/**
 * Совпадает ли телефон с цифрами из поиска. Номер приводится к виду 7XXXXXXXXXX и в базе, и в запросе:
 * «89674812654», «+7 967 481-26-54» и «9674812654» находят одну и ту же заявку. Короткий запрос ищется как часть номера.
 */
export function phoneMatches(phone: string, queryDigits: string) {
  if (queryDigits.length < 3) return false
  const raw = phone.replace(/\D/g, '')
  const norm = phoneNorm(phone)
  if (raw.includes(queryDigits) || norm.includes(queryDigits)) return true
  if (queryDigits.length >= 10) return norm === phoneNorm(queryDigits) || norm.endsWith(phoneNorm(queryDigits).slice(1))
  // «8967…» в начале запроса — это «7967…»
  return /^8\d/.test(queryDigits) && norm.startsWith(`7${queryDigits.slice(1)}`)
}

const statusRank = Object.fromEntries(applicationStatuses.map((s, i) => [s.id, i])) as Record<ApplicationStatus, number>

/**
 * Сортировка списка. «Ждёт» — сколько заявка ждёт ответа: сначала самые давние новые, остальные — после.
 * «Собеседование» — по времени собеседования, заявки без времени — в конце.
 */
export function sortApps<T extends HrApplication>(list: T[], sort: SortSpec = { key: 'date', dir: 'desc' }, now = Date.now()): T[] {
  const sign = sort.dir === 'asc' ? 1 : -1
  const value = (a: T): number | string | null => {
    switch (sort.key) {
      case 'date':
        return a.createdAt
      case 'status':
        return statusRank[a.status]
      case 'vacancy':
        return (a.vacancyId ? (vacancyById(a.vacancyId)?.title ?? a.vacancyId) : '').toLowerCase() || null
      case 'waiting':
        return a.status === 'new' ? now - new Date(a.createdAt).getTime() : null
      case 'interview':
        return a.interview ? a.interview.startsAt : null
      case 'name':
        return `${a.lastName ?? ''} ${a.name}`.trim().toLowerCase()
    }
  }
  return [...list].sort((a, b) => {
    const va = value(a)
    const vb = value(b)
    // Пустые значения всегда внизу, в какую сторону ни сортируй
    if (va === null || vb === null) return va === vb ? b.createdAt.localeCompare(a.createdAt) : va === null ? 1 : -1
    const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'ru')
    return cmp * sign || b.createdAt.localeCompare(a.createdAt)
  })
}
