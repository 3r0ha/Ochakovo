import { checkinAnswerLabel, checkinReasonLabel, checkinSteps } from './adaptation'
import {
  adultLabel,
  birthDateLabel,
  citizenshipLabel,
  consentSourceLabel,
  declineReasonLabel,
  erasedLabel,
  medBookLabel,
  practiceDocsLabel,
  seasonLeaveReasonLabel,
  seasonOutcomes,
  shiftKinds,
  shiftLabel,
  startReadyLabel,
  statusLabel,
  studyLabel,
  type Application,
  type HrApplication,
} from './applications'
import { ageOn, ageWords, formatBirthDate } from './birthDate'
import { departments } from './content/departments'
import { vacancyById } from './content/vacancies'
import { stageCounts } from './hrFilter'
import { csvPhone, formatPhone as formatAnyPhone, parsePhone } from './phone'

// Подписи и выгрузки для HR — одна логика для сервера и панели

/** Встроенный словарь меток. Названия из реестра меток (вторая волна) важнее него */
const sourceNames: Record<string, string> = {
  'fair-mgupp': 'Ярмарка МГУПП',
  'fair-mospolytech': 'Ярмарка Мосполитеха',
  vk: 'ВКонтакте',
  telegram: 'Telegram',
  max: 'MAX',
  site: 'Чат на сайте',
  hr: 'Добавлено вручную',
  hiringday: 'День найма',
  // QR на финальном слайде презентации
  deck: 'Презентация',
}

/** Метки с приставкой площадки: fair-misis → «Ярмарка · misis», tg-studsovet → «Telegram · studsovet» */
const sourcePrefixes: [prefix: string, name: string][] = [
  ['fair-', 'Ярмарка'],
  ['vk-', 'ВКонтакте'],
  ['tg-', 'Telegram'],
  ['max-', 'MAX'],
  // Типы точек контакта из реестра «Источники» (shared/sources.ts) — пока метке не дали название
  ['tour-', 'Экскурсия'],
  ['museum-', 'Музей'],
  ['class-', 'Инженерный класс'],
  ['edu-', 'Вуз или колледж'],
  ['job-', 'Работный сайт'],
  ['amb-', 'Амбассадор'],
  ['hiringday-', 'День найма'],
]

/** Старые метки приглашений без кода: friend и share из первых версий бота. Пригласившего по ним не найти */
export const legacyReferralSources: readonly string[] = ['friend', 'share']

/** Откуда кандидат, если его добавил сотрудник: звонок, визит, работные сайты */
export const manualSources = [
  { id: 'phone', label: 'Звонок в отдел персонала' },
  { id: 'walk_in', label: 'Визит на завод' },
  { id: 'hh', label: 'hh.ru' },
  { id: 'superjob', label: 'SuperJob' },
  { id: 'avito', label: 'Авито Работа' },
  { id: 'employee', label: 'Рекомендация сотрудника' },
  { id: 'fair', label: 'Ярмарка вакансий' },
  { id: 'other', label: 'Другое' },
] as const
for (const m of manualSources) sourceNames[m.id] = m.label

const channelNames: Record<string, string> = { web: 'Сайт', telegram: 'Бот в Telegram', max: 'Бот в MAX', hr: 'Добавлено HR' }

const monthLabels: Record<number, string> = { 3: 'Мар', 4: 'Апр', 5: 'Май', 6: 'Июн', 7: 'Июл', 8: 'Авг', 9: 'Сен' }

/** Пришёл по ссылке «Позвать друга» из бота или с сайта: метка friend-<код> */
export const isReferral = (src: string | null | undefined) => Boolean(src?.startsWith('friend-'))

/** Любое приглашение друга: с кодом (friend-<код>) и старые метки без кода */
export const isAnyReferral = (src: string | null | undefined) => isReferral(src) || legacyReferralSources.includes(src ?? '')

/**
 * Как назван источник: direct — прямой заход, registry — из реестра меток, known — встроенный словарь,
 * prefix — разобран по приставке, friend — приглашение с кодом, friend_legacy — старое приглашение без кода,
 * unknown — метка, которую никто не назвал: в «Воронке» она подсвечена, чтобы HR дал ей название
 */
export type SourceKind = 'direct' | 'registry' | 'known' | 'prefix' | 'friend' | 'friend_legacy' | 'unknown'

export function describeSource(src: string | null | undefined, names?: Record<string, string>): { label: string; kind: SourceKind } {
  if (!src) return { label: 'Прямой заход', kind: 'direct' }
  if (names && Object.hasOwn(names, src)) return { label: names[src], kind: 'registry' }
  if (isReferral(src)) return { label: 'Приглашение друга', kind: 'friend' }
  if (legacyReferralSources.includes(src)) return { label: 'Приглашение друга, без кода', kind: 'friend_legacy' }
  if (Object.hasOwn(sourceNames, src)) return { label: sourceNames[src], kind: 'known' }
  for (const [prefix, name] of sourcePrefixes) {
    const rest = src.slice(prefix.length)
    if (src.startsWith(prefix) && rest) return { label: `${name} · ${rest}`, kind: 'prefix' }
  }
  return { label: src, kind: 'unknown' }
}

/** Название источника по метке. names — названия из реестра меток (вторая волна), они важнее встроенного словаря */
export const sourceName = (src: string | null, names?: Record<string, string>) => describeSource(src, names).label

export const channelName = (channel: string | undefined) => channelNames[channel ?? 'web'] ?? channel ?? 'Сайт'

export const deptName = (id: Application['department'] | null) => (id ? departments[id].name : '—')

export const vacancyTitle = (id: string) => (id ? vacancyById(id)?.title ?? '—' : 'Любая подходящая')

export function monthsRange(months: number[]) {
  if (!months.length) return '—'
  const sorted = [...months].sort((a, b) => a - b)
  const label = (m: number) => monthLabels[m] ?? String(m)
  const contiguous = sorted.every((m, i) => i === 0 || m === sorted[i - 1] + 1)
  if (contiguous && sorted.length > 1) return `${label(sorted[0])}–${label(sorted.at(-1)!)}`
  return sorted.map(label).join(', ')
}

/** +79161234567 → +7 916 123-45-67; нестандартные номера оставляем как есть */
export const formatPhone = formatAnyPhone

/** Сколько из четырёх заданий кандидат прошёл («Смена N/4») */
export const shiftOf = (a: Pick<Application, 'game'>) => Math.max(0, Math.min(4, a.game.activities ?? 0))

// ── «Задания и наём»: сколько заданий прошёл кандидат и чем кончилась заявка ──

/** Четыре задания смены — те же id, что в событиях воронки сайта и в прогрессе бота */
export const taskIds = ['game', 'money', 'quiz', 'myth'] as const
export type TaskId = (typeof taskIds)[number]
export const taskLabels: Record<TaskId, string> = { game: 'Поймай брак', money: 'Собери лето', quiz: 'Подбор работы', myth: 'Правда или миф' }

export type TaskBucket = 'none' | 'some' | 'all' | 'hr'
export const taskBuckets: { id: TaskBucket; label: string; hint: string }[] = [
  { id: 'none', label: '0', hint: 'Заявка без пройденных заданий' },
  { id: 'some', label: '1–3', hint: 'Прошли от одного до трёх заданий' },
  { id: 'all', label: '4 из 4', hint: 'Прошли все четыре задания: «Задания 4/4»' },
  { id: 'hr', label: 'Добавлены HR', hint: 'Кандидата добавил сотрудник: звонок, визит, импорт откликов с hh.ru' },
]

/** Цель — доля заявок со «Сменой 4/4» среди заявок кандидатов: docs/strategy.md, раздел «Метрики» */
export const FULL_SHIFT_TARGET = 0.3

/** Строка «Задания и наём»: кандидат добавлен HR или сколько заданий прошёл */
export const taskBucketOf = (a: Pick<Application, 'channel' | 'game'>): TaskBucket => {
  if (a.channel === 'hr') return 'hr'
  const n = shiftOf(a)
  return n === 0 ? 'none' : n >= 4 ? 'all' : 'some'
}

export type TasksHiringRow = { bucket: TaskBucket; applications: number; interview: number; noShow: number; hired: number; started: number }

export type TasksHiringInput = Pick<HrApplication, 'channel' | 'game' | 'status' | 'reached' | 'duplicateOf' | 'declineReason' | 'interview'>

/** Не пришёл на собеседование: отметка «Неявка» в слоте или отказ с этой причиной */
export const isNoShow = (a: Pick<HrApplication, 'declineReason' | 'interview'>) => a.declineReason === 'no_show' || a.interview?.attended === 'no'

/**
 * «Задания и наём»: заявки по числу пройденных заданий и чем они кончились. Этапы — той же stageCounts,
 * что плитки над списком и «Воронка», поэтому сумма строк равна плитке «Заявка».
 * fullShare — доля «4 из 4» среди заявок кандидатов: добавленные HR задания пройти не могли
 */
export function tasksHiring(apps: TasksHiringInput[]): { rows: TasksHiringRow[]; fullShare: number | null } {
  const live = apps.filter((a) => !a.duplicateOf)
  const rows = taskBuckets.map(({ id }) => {
    const list = live.filter((a) => taskBucketOf(a) === id)
    return { bucket: id, ...stageCounts(list), noShow: list.filter(isNoShow).length }
  })
  const own = live.length - rows.find((r) => r.bucket === 'hr')!.applications
  const full = rows.find((r) => r.bucket === 'all')!.applications
  return { rows, fullShare: own ? full / own : null }
}

// ── Итог сезона и цифры кейса ────────────────────────────────────────────

type SeasonInput = Pick<HrApplication, 'duplicateOf' | 'status' | 'seasonOutcome' | 'reserve'>

/**
 * Итог сезона у тех, кто «На смене»: completed — «Сезон отработан», left — ушли до конца сезона,
 * stayed — отметка «Звать в штат / резерв». Итог бывает только у «На смене»: при уходе со статуса он очищается
 */
export function seasonCounts(list: SeasonInput[]) {
  const live = list.filter((a) => !a.duplicateOf && a.status === 'started')
  return {
    completed: live.filter((a) => a.seasonOutcome === 'completed').length,
    left: live.filter((a) => a.seasonOutcome === 'left').length,
    stayed: live.filter((a) => a.reserve).length,
  }
}

/**
 * Цифры компании из кейса — слайд «Диагностика проблемы» (archive/case-materials/case-pages/p05.png):
 * «средний возраст сотрудников всего за год вырос с 47 до 52 лет», «значительный отсев на этапе испытательного срока (38%)
 * и критически низкая конверсия в найм (0,02%)». Как компания считала конверсию, в кейсе не сказано
 */
export const companyBaseline = { hireRate: 0.0002, probationDropout: 0.38, averageAge: 52, averageAgeYearAgo: 47 } as const

export type CaseMetrics = {
  /** Пришли на сайт и в боты; null — посещений нет в отчёте (выгрузка по фильтру) */
  visitors: number | null
  /** Дошли до «К оформлению» */
  hired: number
  /** hired ÷ visitors; null — не из чего считать */
  hireRate: number | null
  /** Итог сезона отмечен: доработали до конца и ушли раньше */
  completed: number
  left: number
  /** Доля ушедших до конца сезона среди тех, у кого итог отмечен; null — итогов нет */
  dropout: number | null
  /** Принятые с датой рождения и их средний возраст на сегодня, лет с одним знаком; null — дат нет */
  withAge: number
  averageAge: number | null
}

/** Цифры кейса по данным панели: конверсия в найм, отсев до конца сезона, средний возраст принятых */
export function caseMetrics(
  list: (SeasonInput & Pick<HrApplication, 'reached' | 'birthDate'>)[],
  visitors: number | null,
  now: Date | number = Date.now(),
): CaseMetrics {
  const { hired } = stageCounts(list)
  const { completed, left } = seasonCounts(list)
  const ages = list
    .filter((a) => !a.duplicateOf && (['hired', 'started'].includes(a.status) || a.reached.some((r) => r === 'hired' || r === 'started')))
    .map((a) => ageOf(a, now))
    .filter((v): v is number => v !== null)
  return {
    visitors,
    hired,
    hireRate: visitors ? hired / visitors : null,
    completed,
    left,
    dropout: completed + left ? left / (completed + left) : null,
    withAge: ages.length,
    averageAge: ages.length ? Math.round((ages.reduce((s, v) => s + v, 0) / ages.length) * 10) / 10 : null,
  }
}

// ── Отчёт по неделям ─────────────────────────────────────────────────────

const mskDayMonth = (d: Date) =>
  d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: 'Europe/Moscow' }).replace('.', '')

/** Подпись недели: «13–19 окт», на стыке месяцев «29 сен – 5 окт». end — граница недели, не включительно */
export function weekLabel(startIso: string, endIso: string) {
  const start = new Date(startIso)
  const last = new Date(new Date(endIso).getTime() - 1)
  const [d1, m1] = mskDayMonth(start).split(' ')
  const [d2, m2] = mskDayMonth(last).split(' ')
  if (d1 === d2 && m1 === m2) return `${d1} ${m1}`
  return m1 === m2 ? `${d1}–${d2} ${m2}` : `${d1} ${m1} – ${d2} ${m2}`
}

// ── Поля кейса: подписи для списка, карточки, фильтров и выгрузок ─────────────

/** Названия полей кейса — одинаковые в списке, карточке, фильтрах и выгрузках (Excel, CSV, 1С) */
export const caseFieldLabels = {
  birthDate: 'Дата рождения',
  age: 'Возраст',
  startReady: 'Когда может выйти',
  school: 'Вуз или колледж',
  mentorName: 'Наставник',
  practiceDocs: 'Документы по практике',
} as const
export type CaseField = keyof typeof caseFieldLabels

type CaseFieldSource = Pick<Application, 'birthDate' | 'startReady' | 'startMonth' | 'school' | 'notStudying'> &
  Partial<Pick<HrApplication, 'mentorName' | 'practiceDocs'>>

/**
 * Значение поля кейса строкой: «ДД.ММ.ГГГГ», «19 лет», «С июля», вуз или «Уже не учусь», «Договор, приказ».
 * Пустая строка — не заполнено. Возраст — на сегодня по Москве. Обезличивание — забота выгрузки (erasedLabel)
 */
export function caseFieldText(a: CaseFieldSource, field: CaseField, now: Date | number = Date.now()): string {
  switch (field) {
    case 'birthDate':
      return birthDateLabel(a.birthDate)
    case 'age': {
      const age = a.birthDate ? ageOn(a.birthDate, now) : null
      return age === null ? '' : ageWords(age)
    }
    case 'startReady':
      return startReadyLabel(a.startReady, a.startMonth)
    case 'school':
      return studyLabel({ school: a.school ?? '', notStudying: a.notStudying })
    case 'mentorName':
      return a.mentorName ?? ''
    case 'practiceDocs':
      return practiceDocsLabel(a.practiceDocs)
  }
}

/** Учёба в выгрузках и панели — о кандидате в третьем лице: вуз или колледж, «Уже не учится» или пустая строка */
export const studyText = (a: Pick<Application, 'school' | 'notStudying'>) => (a.school ?? '').trim() || (a.notStudying ? 'Уже не учится' : '')

/** Полных лет по дате рождения на сегодня по Москве; null — даты нет */
export const ageOf = (a: Pick<Application, 'birthDate'>, now: Date | number = Date.now()) => (a.birthDate ? ageOn(a.birthDate, now) : null)

// ── Выгрузки: одни колонки для Excel, CSV и JSON ───────────────────────────

export type ExportValue = string | number | Date | null

export type ExportColumn = {
  key: string
  label: string
  /** Ширина в Excel, в символах */
  width: number
  /** date — календарный день без времени и часового пояса (дата рождения): Date в полночь UTC */
  kind?: 'datetime' | 'date' | 'number' | 'status'
  /** Не входит в выгрузку по умолчанию */
  optional?: boolean
  value: (a: ExportApplication) => ExportValue
}

/** В демо без сервера у заявки нет полей HR — колонки это переживают */
export type ExportApplication = Application & Partial<Omit<HrApplication, keyof Application>>

const date = (iso: string | null | undefined) => (iso ? new Date(iso) : null)

/** День YYYY-MM-DD как Date в полночь UTC: Excel и CSV покажут его без сдвига часового пояса */
const calendarDay = (ymd: string | null | undefined) => (ymd && /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? new Date(`${ymd}T00:00:00Z`) : null)

/** Личное поле: у обезличенной заявки вместо пустоты — «удалено по сроку хранения» */
const personal =
  <T extends ExportValue>(get: (a: ExportApplication) => T) =>
  (a: ExportApplication): T | string =>
    erasedLabel(a) ?? get(a)

const yes = (v: boolean | undefined) => (v ? 'Да' : '')
const optionText = (list: { id: string; label: string }[], v: string | undefined) => list.find((o) => o.id === v)?.label ?? ''

export const exportColumns: ExportColumn[] = [
  { key: 'id', label: 'Номер заявки', width: 13, value: (a) => a.id },
  { key: 'createdAt', label: 'Дата заявки', width: 17, kind: 'datetime', value: (a) => date(a.createdAt) },
  { key: 'status', label: 'Статус', width: 16, kind: 'status', value: (a) => statusLabel(a.status) },
  { key: 'statusUpdatedAt', label: 'Статус изменён', width: 17, kind: 'datetime', value: (a) => date(a.statusUpdatedAt) },
  { key: 'assignee', label: 'Ведёт', width: 18, value: (a) => a.assigneeName ?? '' },
  { key: 'lastName', label: 'Фамилия', width: 16, value: personal((a) => a.lastName ?? '') },
  { key: 'name', label: 'Имя', width: 18, value: personal((a) => a.name) },
  { key: 'middleName', label: 'Отчество', width: 16, value: personal((a) => a.middleName ?? '') },
  { key: 'phone', label: 'Телефон', width: 18, value: personal((a) => formatPhone(a.phone)) },
  { key: 'contact', label: 'Telegram / MAX / e-mail', width: 22, value: personal((a) => a.contact) },
  { key: 'adult', label: '18+', width: 6, value: (a) => adultLabel(a.adult) },
  { key: 'citizenship', label: 'Гражданство', width: 16, value: (a) => citizenshipLabel(a.citizenship) },
  { key: 'medBook', label: 'Медкнижка', width: 18, value: (a) => medBookLabel(a.medBook) },
  { key: 'shifts', label: 'Смены', width: 18, value: (a) => shiftLabel(a.shifts) },
  { key: 'school', label: caseFieldLabels.school, width: 26, value: personal(studyText) },
  { key: 'course', label: 'Курс', width: 18, value: (a) => a.course },
  { key: 'department', label: 'Направление', width: 20, value: (a) => (a.department ? deptName(a.department) : '') },
  { key: 'vacancy', label: 'Вакансия', width: 30, value: (a) => vacancyTitle(a.vacancyId) },
  { key: 'format', label: 'Формат', width: 16, value: (a) => a.format },
  { key: 'months', label: 'Месяцы', width: 12, value: (a) => (a.months.length ? monthsRange(a.months) : '') },
  { key: 'interview', label: 'Собеседование', width: 17, kind: 'datetime', value: (a) => date(a.interview?.startsAt) },
  { key: 'interviewAddress', label: 'Адрес собеседования', width: 28, value: (a) => a.interview?.address ?? '' },
  { key: 'noAnswer', label: 'Недозвонов', width: 11, kind: 'number', value: (a) => a.noAnswerCount ?? 0 },
  { key: 'callback', label: 'Перезвонить', width: 17, kind: 'datetime', value: (a) => date(a.callbackAt) },
  { key: 'declineReason', label: 'Причина отказа', width: 26, value: (a) => declineReasonLabel(a.declineReason) },
  { key: 'source', label: 'Источник', width: 20, value: (a) => sourceName(a.source) },
  { key: 'channel', label: 'Канал', width: 16, value: (a) => channelName(a.channel) },
  { key: 'tasks', label: 'Задания (из 4)', width: 12, kind: 'number', value: (a) => shiftOf(a) },
  { key: 'friend', label: 'Идёт с другом', width: 22, value: personal((a) => a.friend ?? '') },
  { key: 'portfolio', label: 'Портфолио', width: 30, value: personal((a) => a.portfolio ?? '') },
  { key: 'resume', label: 'Резюме hh.ru', width: 30, value: personal((a) => a.resumeUrl ?? '') },
  { key: 'comment', label: 'Комментарий кандидата', width: 30, value: personal((a) => a.comment) },
  { key: 'notes', label: 'Заметки HR', width: 36, value: personal((a) => a.notes ?? '') },
  // Поля кейса, согласие, оформление и итог сезона — в конце: прежние колонки остаются на своих местах
  { key: 'birthDate', label: caseFieldLabels.birthDate, width: 13, kind: 'date', value: personal((a) => calendarDay(a.birthDate)) },
  { key: 'age', label: caseFieldLabels.age, width: 9, kind: 'number', value: (a) => (a.anonymizedAt ? null : ageOf(a)) },
  { key: 'startReady', label: caseFieldLabels.startReady, width: 20, value: (a) => caseFieldText(a, 'startReady') },
  { key: 'practiceSchool', label: 'Практика от вуза', width: 11, value: (a) => yes(a.practiceSchool) },
  { key: 'wantsToStay', label: 'Хочет остаться', width: 11, value: (a) => yes(a.wantsToStay) },
  { key: 'consentSource', label: 'Согласие: где', width: 24, value: (a) => consentSourceLabel(a.consentSource) },
  { key: 'consentVersion', label: 'Согласие: версия', width: 10, value: (a) => a.consentVersion ?? '' },
  { key: 'consentAt', label: 'Согласие: когда', width: 17, kind: 'datetime', value: (a) => date(a.consentAt) },
  { key: 'consentBy', label: 'Согласие отметил', width: 18, value: (a) => a.consentBy ?? '' },
  { key: 'onboardingAt', label: 'Оформление', width: 17, kind: 'datetime', value: (a) => date(a.onboardingAt) },
  { key: 'firstShiftAt', label: 'Первая смена', width: 17, kind: 'datetime', value: (a) => date(a.firstShiftAt) },
  { key: 'shiftKind', label: 'Дневная или ночная', width: 11, value: (a) => optionText(shiftKinds, a.shiftKind) },
  { key: 'mentorName', label: caseFieldLabels.mentorName, width: 22, value: (a) => caseFieldText(a, 'mentorName') },
  { key: 'practiceDocs', label: caseFieldLabels.practiceDocs, width: 26, value: (a) => caseFieldText(a, 'practiceDocs') },
  { key: 'seasonOutcome', label: 'Итог сезона', width: 20, value: (a) => optionText(seasonOutcomes, a.seasonOutcome) },
  { key: 'seasonLeaveReason', label: 'Причина ухода', width: 20, value: (a) => seasonLeaveReasonLabel(a.seasonLeaveReason) },
  { key: 'reserve', label: 'Звать в штат / резерв', width: 12, value: (a) => yes(a.reserve) },
  // «Как дела на смене»: ответ новичка на каждый из трёх вопросов — «тяжело: учёба»; пусто — не спрашивали или нет ответа
  ...checkinSteps.map(
    (st): ExportColumn => ({
      key: `checkin_${st.id}`,
      label: `Как дела: ${st.label.toLowerCase()}`,
      width: 20,
      value: (a) => {
        const c = a.checkins?.find((x) => x.step === st.id && x.answer)
        return c ? `${checkinAnswerLabel(c.answer).toLowerCase()}${c.reason ? `: ${checkinReasonLabel(c.reason).toLowerCase()}` : ''}` : ''
      },
    }),
  ),
  { key: 'quiz', label: 'Направление по тесту', width: 20, optional: true, value: (a) => (a.game.quizResult ? deptName(a.game.quizResult) : '') },
  { key: 'game', label: 'Счёт в «Поймай брак»', width: 12, kind: 'number', optional: true, value: (a) => a.game.conveyorBest || null },
]

/** Колонки выгрузки: по умолчанию все основные, дополнительные — по ключам */
export function pickColumns(extra: string[] = []) {
  return exportColumns.filter((c) => !c.optional || extra.includes(c.key))
}

const mskDateTime = (d: Date) =>
  d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })

/** Календарный день (kind: 'date') — ДД.ММ.ГГГГ без времени; остальные даты — по Москве с временем */
const plain = (v: ExportValue, kind?: ExportColumn['kind']) =>
  v instanceof Date ? (kind === 'date' ? formatBirthDate(v.toISOString().slice(0, 10)) : mskDateTime(v)) : (v ?? '')

/**
 * Защита от «CSV-инъекций» (OWASP): значение, которое начинается с «=», «+», «-», «@», табуляции или возврата
 * каретки, Excel может выполнить как формулу. Такому значению ставим в начало апостроф — Excel покажет его
 * текстом. Телефоны в CSV пишем без «+» (7 916 123-45-67), чтобы они оставались похожи на телефоны.
 */
export const safeCell = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v)

/** CSV для русского Excel: BOM, разделитель «;», значения в кавычках */
export function applicationsCsv(list: ExportApplication[], columns = pickColumns()) {
  const cell = (v: unknown) => `"${safeCell(String(v ?? '')).replace(/"/g, '""')}"`
  const value = (c: ExportColumn, a: ExportApplication) => (c.key === 'phone' && !a.anonymizedAt ? csvPhone(a.phone) : plain(c.value(a), c.kind))
  const lines = [columns.map((c) => cell(c.label)).join(';'), ...list.map((a) => columns.map((c) => cell(value(c, a))).join(';'))]
  return '\uFEFF' + lines.join('\r\n')
}

/** JSON для интеграций: ключи колонок, даты в ISO; календарный день (дата рождения) — YYYY-MM-DD */
export function applicationsJson(list: ExportApplication[], columns = pickColumns()) {
  return list.map((a) => Object.fromEntries(columns.map((c) => {
    const v = c.value(a)
    return [c.key, v instanceof Date ? (c.kind === 'date' ? v.toISOString().slice(0, 10) : v.toISOString()) : v]
  })))
}

// ── Выгрузка «Для 1С» ──────────────────────────────────────────────────────
// Единого формата загрузки кандидатов в типовую 1С:ЗУП нет: данные загружают обработкой
// «Загрузка данных из табличного документа» или через интегратора. Этот шаблон описан в docs/hr.md.

const dmy = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric' }) : ''

/** 1С: телефон цифрами с кодом страны, без «+» — ячейка не начинается со знака формулы */
const phone1c = (raw: string) => {
  const r = parsePhone(raw)
  return r && 'e164' in r ? r.e164.slice(1) : raw
}

const emailRe = /^[a-z0-9][\w.+-]*@[\w-]+(\.[\w-]+)+$/i

/**
 * Ник или ссылка на мессенджер из поля «Связь» — для 1С без «@» в начале. Telegram — ссылкой «t.me/ник»;
 * ник из бота MAX — «MAX: ник»: ссылка t.me вела бы не туда
 */
export function messengerOf(contact: string, channel?: string) {
  const c = contact.trim()
  if (!c || emailRe.test(c)) return ''
  const nick = /^@?([\w.]{3,32})$/.exec(c)
  if (channel === 'max' && nick) return `MAX: ${nick[1]}`
  const tg = /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([\w]{3,32})/i.exec(c) ?? /^@([\w]{3,32})$/.exec(c)
  if (tg) return `t.me/${tg[1]}`
  return c.replace(/^https?:\/\//i, '')
}

/**
 * Защита от формул для 1С. Апостроф, как в CSV для Excel, здесь не годится: обработка загрузки 1С
 * перенесёт его в карточку как есть. Поэтому начало значения переписываем по смыслу:
 * «-ночью» → «— ночью», «+7 916…» → «7 916…», «@nick» → «t.me/nick», «=…» → «— …».
 * Пробел в начале не помогает: загрузка 1С обрезает пробелы по краям, а Excel начальный пробел не всегда спасает.
 */
export function oneCText(v: string) {
  const s = v.replace(/^[\s]+/, '')
  const m = /^([=+\-−–@]+)\s*/.exec(s)
  if (!m) return s
  const rest = s.slice(m[0].length)
  if (m[1] === '@' && /^[A-Za-z]\w{2,31}/.test(rest)) return `t.me/${rest}`
  if (m[1] === '+' && /^\d/.test(rest)) return rest
  return rest ? `— ${rest}` : '—'
}

export const oneCColumns: { label: string; value: (a: ExportApplication) => string }[] = [
  { label: 'Фамилия', value: personal((a) => a.lastName ?? '') },
  // Имя и отчество — как кандидат их указал: отчество из двух слов имени не угадываем
  { label: 'Имя', value: personal((a) => a.name.trim()) },
  { label: 'Отчество', value: (a) => (a.anonymizedAt ? '' : (a.middleName ?? '')) },
  { label: 'Телефон', value: (a) => (a.anonymizedAt ? '' : phone1c(a.phone)) },
  { label: 'Электронная почта', value: (a) => (!a.anonymizedAt && emailRe.test(a.contact.trim()) ? a.contact.trim() : '') },
  // Telegram и другие мессенджеры — отдельно от почты: «@nick» в 1С не загрузится как адрес
  { label: 'Мессенджер', value: (a) => (a.anonymizedAt ? '' : messengerOf(a.contact, a.channel)) },
  { label: 'Должность', value: (a) => (a.vacancyId ? vacancyTitle(a.vacancyId) : '') },
  // Подразделение — по вакансии; если вакансия не выбрана, по направлению из подбора работы
  { label: 'Подразделение', value: (a) => {
    const dept = (a.vacancyId && vacancyById(a.vacancyId)?.department) || a.department
    return dept ? deptName(dept) : ''
  } },
  { label: 'Источник', value: (a) => sourceName(a.source) },
  { label: 'Дата отклика', value: (a) => dmy(a.createdAt) },
  { label: 'Состояние', value: (a) => statusLabel(a.status) },
  { label: 'Дата собеседования', value: (a) => dmy(a.interview?.startsAt) },
  { label: 'Гражданство', value: (a) => citizenshipLabel(a.citizenship) },
  { label: 'Медицинская книжка', value: (a) => medBookLabel(a.medBook) },
  { label: 'Учебное заведение', value: (a) => (a.anonymizedAt ? '' : studyText(a)) },
  { label: 'Комментарий', value: (a) => erasedLabel(a) ?? [a.comment, a.notes].filter(Boolean).join(' / ').replace(/\s+/g, ' ') },
  { label: 'Номер заявки', value: (a) => a.id },
  // Новые колонки — в конце: шаблоны загрузки, настроенные на прежние, продолжают работать.
  // Даты — ДД.ММ.ГГГГ; у обезличенной заявки дата рождения пустая: текст в поле даты 1С не загрузит
  { label: 'Дата рождения', value: (a) => (a.anonymizedAt ? '' : formatBirthDate(a.birthDate)) },
  { label: 'Когда может выйти', value: (a) => caseFieldText(a, 'startReady') },
  { label: 'Практика от вуза', value: (a) => yes(a.practiceSchool) },
  { label: 'Хочет остаться', value: (a) => yes(a.wantsToStay) },
  { label: 'Согласие на обработку данных', value: (a) => consentSourceLabel(a.consentSource) },
  { label: 'Версия согласия', value: (a) => a.consentVersion ?? '' },
  { label: 'Дата согласия', value: (a) => dmy(a.consentAt) },
  { label: 'Дата оформления', value: (a) => dmy(a.onboardingAt) },
  { label: 'Дата приёма', value: (a) => dmy(a.firstShiftAt) },
  { label: 'Смена', value: (a) => optionText(shiftKinds, a.shiftKind) },
  { label: 'Наставник', value: (a) => caseFieldText(a, 'mentorName') },
  { label: 'Документы по практике', value: (a) => caseFieldText(a, 'practiceDocs') },
  { label: 'Итог сезона', value: (a) => optionText(seasonOutcomes, a.seasonOutcome) },
  { label: 'Причина ухода', value: (a) => seasonLeaveReasonLabel(a.seasonLeaveReason) },
  { label: 'Резерв', value: (a) => yes(a.reserve) },
]

/** CSV для 1С: разделитель «;», без BOM; кодировку Windows-1251 ставит сервер */
export function applications1C(list: ExportApplication[]) {
  const cell = (raw: string) => {
    const v = oneCText(raw)
    return /[;"\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
  }
  return [oneCColumns.map((c) => c.label).join(';'), ...list.map((a) => oneCColumns.map((c) => cell(c.value(a))).join(';'))].join('\r\n') + '\r\n'
}
