import type { Checkin } from './adaptation'
import { birthDateMessages, birthDateProblem, formatBirthDate, type BirthDateCode } from './birthDate'
import type { DepartmentId } from './content/departments'
import type { VacancyFormat } from './content/vacancies'

// Заявка кандидата — один формат для сайта, API и ботов

/** hr — кандидата добавил сотрудник: звонок, визит, импорт с hh.ru */
export type ApplicationChannel = 'web' | 'telegram' | 'max' | 'hr'

/** Путь заявки в отделе персонала */
export type ApplicationStatus = 'new' | 'contacted' | 'interview' | 'hired' | 'started' | 'declined' | 'no_answer'

export const applicationStatuses: { id: ApplicationStatus; label: string; hint: string }[] = [
  { id: 'new', label: 'Новая', hint: 'Заявка пришла, с кандидатом ещё не связывались' },
  { id: 'contacted', label: 'Связались', hint: 'Позвонили или написали, обсуждаем' },
  { id: 'interview', label: 'Собеседование', hint: 'Кандидата пригласили на собеседование' },
  { id: 'hired', label: 'К оформлению', hint: 'Решили взять: дальше медкомиссия, договор, инструктаж' },
  { id: 'started', label: 'На смене', hint: 'Оформление позади, первая смена отработана' },
  { id: 'declined', label: 'Отказ', hint: 'Не подошли друг другу' },
  { id: 'no_answer', label: 'Не отвечает', hint: 'Не удалось связаться' },
]

export const statusLabel = (s: ApplicationStatus | undefined) => applicationStatuses.find((x) => x.id === (s ?? 'new'))?.label ?? 'Новая'

export const isStatus = (v: unknown): v is ApplicationStatus => applicationStatuses.some((s) => s.id === v)

/** Статусы, о которых кандидату в боте приходит сообщение */
export const notifiedStatuses: ApplicationStatus[] = ['interview', 'hired', 'declined']

/** Тексты уведомлений: по статусам, собеседование без слота, напоминания накануне собеседования и первой смены */
export type TemplateKey =
  | 'interview'
  | 'interview_call'
  | 'reminder'
  | 'hired'
  | 'declined'
  | 'sms_interview'
  | 'sms_reminder'
  | 'shift_reminder'
  | 'sms_shift_reminder'
export const templateKeys: { id: TemplateKey; label: string; hint: string }[] = [
  { id: 'interview', label: 'Собеседование', hint: 'Статус «Собеседование», дата и место назначены' },
  { id: 'interview_call', label: 'Собеседование без времени', hint: 'Статус «Собеседование», время договорятся по телефону' },
  { id: 'reminder', label: 'Напоминание накануне', hint: 'Уходит за день до собеседования' },
  { id: 'hired', label: 'К оформлению', hint: 'Статус «К оформлению»: решили взять' },
  { id: 'declined', label: 'Отказ', hint: 'Статус «Отказ»' },
  { id: 'shift_reminder', label: 'Первая смена накануне', hint: 'Уходит в бот за день до первой смены, если статус «К оформлению» и дата не менялась' },
  { id: 'sms_interview', label: 'SMS: приглашение', hint: 'Кандидатам без бота, если подключены SMS. Чем короче, тем дешевле' },
  { id: 'sms_reminder', label: 'SMS: напоминание', hint: 'Накануне собеседования кандидатам без бота' },
  { id: 'sms_shift_reminder', label: 'SMS: первая смена', hint: 'Накануне первой смены кандидатам без бота' },
]
export const isTemplateKey = (v: unknown): v is TemplateKey => templateKeys.some((t) => t.id === v)

/** Причины отказа — для отчёта, почему кандидаты отваливаются */
export type DeclineReason = 'no_slots' | 'schedule' | 'age' | 'documents' | 'no_show' | 'no_show_shift' | 'candidate_refused' | 'other'
export const declineReasons: { id: DeclineReason; label: string }[] = [
  { id: 'no_slots', label: 'Нет подходящих мест' },
  { id: 'schedule', label: 'Не совпал график' },
  { id: 'age', label: 'Нет 18 лет' },
  { id: 'documents', label: 'Нет документов или медкнижки' },
  { id: 'no_show', label: 'Неявка на собеседование' },
  { id: 'no_show_shift', label: 'Неявка на первую смену' },
  { id: 'candidate_refused', label: 'Кандидат передумал' },
  { id: 'other', label: 'Другое' },
]
export const isDeclineReason = (v: unknown): v is DeclineReason => declineReasons.some((r) => r.id === v)
export const declineReasonLabel = (v: string | undefined) => declineReasons.find((r) => r.id === v)?.label ?? ''

// ── Согласие на обработку персональных данных ────────────────────────────

/**
 * Версия текста согласия на странице /consent. Меняется вместе с текстом.
 * Заявки до отдельного согласия хранят версию '0': тогда согласие было одной отметкой вместе с «мне есть 18».
 * '2' — в тексте появились отчество, дата рождения, вуз или колледж, «когда можешь выйти» и проверка возраста.
 */
export const CONSENT_VERSION = '2'

/** Где дано согласие. hr_verbal, job_board и none — кандидата добавил сотрудник */
export type ConsentSource = 'site_form' | 'site_chat' | 'telegram' | 'max' | 'hr_verbal' | 'job_board' | 'none'
export const consentSources: { id: ConsentSource; label: string }[] = [
  { id: 'site_form', label: 'Форма на сайте' },
  { id: 'site_chat', label: 'Чат на сайте' },
  { id: 'telegram', label: 'Бот в Telegram' },
  { id: 'max', label: 'Бот в MAX' },
  { id: 'hr_verbal', label: 'Устно, отметил сотрудник HR' },
  { id: 'job_board', label: 'Отклик на работном сайте' },
  { id: 'none', label: 'Согласия нет' },
]
export const isConsentSource = (v: unknown): v is ConsentSource => consentSources.some((s) => s.id === v)
export const consentSourceLabel = (v: string | undefined) => consentSources.find((s) => s.id === v)?.label ?? ''

/** Основание, когда кандидата добавляет сотрудник: «+ Кандидат» и импорт. Выбрать нужно явно, по умолчанию его нет */
export type ManualConsent = Extract<ConsentSource, 'hr_verbal' | 'job_board' | 'none'>
export const manualConsents: { id: ManualConsent; label: string; hint: string }[] = [
  { id: 'hr_verbal', label: 'Согласие получено устно', hint: 'Звонок или визит самого кандидата: согласие на обработку данных получено в разговоре. Отметку ставят от твоего имени' },
  { id: 'job_board', label: 'Отклик на работном сайте', hint: 'hh.ru, SuperJob, Авито Работа: согласие кандидат дал на сайте при отклике' },
  { id: 'none', label: 'Согласия нет: рекомендация', hint: 'Номер дали знакомые или сотрудник. При первом звонке скажи, откуда номер, и получи согласие' },
]
export const isManualConsent = (v: unknown): v is ManualConsent => manualConsents.some((c) => c.id === v)

// ── Оформление и итог сезона: поля HR, кандидат их не заполняет ─────────

/** Первая смена дневная или ночная */
export type ShiftKind = 'day' | 'night'
export const shiftKinds: { id: ShiftKind; label: string }[] = [
  { id: 'day', label: 'Дневная' },
  { id: 'night', label: 'Ночная' },
]
export const isShiftKind = (v: unknown): v is ShiftKind => shiftKinds.some((s) => s.id === v)

/** Итог сезона — только для заявок «На смене» */
export type SeasonOutcome = 'completed' | 'left'
export const seasonOutcomes: { id: SeasonOutcome; label: string }[] = [
  { id: 'completed', label: 'Сезон отработан' },
  { id: 'left', label: 'Уход до конца сезона' },
]
export const isSeasonOutcome = (v: unknown): v is SeasonOutcome => seasonOutcomes.some((s) => s.id === v)

/** Почему человек ушёл до конца сезона */
export type SeasonLeaveReason = 'study' | 'schedule' | 'commute' | 'money' | 'personal' | 'other'
export const seasonLeaveReasons: { id: SeasonLeaveReason; label: string }[] = [
  { id: 'study', label: 'Учёба' },
  { id: 'schedule', label: 'График 12 часов' },
  { id: 'commute', label: 'Дорога' },
  { id: 'money', label: 'Деньги' },
  { id: 'personal', label: 'Личные обстоятельства' },
  { id: 'other', label: 'Другое' },
]
export const isSeasonLeaveReason = (v: unknown): v is SeasonLeaveReason => seasonLeaveReasons.some((r) => r.id === v)
export const seasonLeaveReasonLabel = (v: string | undefined) => seasonLeaveReasons.find((r) => r.id === v)?.label ?? ''

/** Явка на собеседование: '' — не отмечена, yes — пришёл, no — неявка */
export type Attendance = '' | 'yes' | 'no'
export const isAttendance = (v: unknown): v is Attendance => v === '' || v === 'yes' || v === 'no'

/** Мессенджер, к которому привязана заявка с сайта */
export type BotChannel = 'telegram' | 'max'

// ── Анкета под производство: кандидат заполняет по желанию, HR дополняет ─────

export type Citizenship = 'ru' | 'eaeu' | 'other'
export const citizenshipOptions: { id: Citizenship; label: string }[] = [
  { id: 'ru', label: 'Россия' },
  { id: 'eaeu', label: 'Страна ЕАЭС' },
  { id: 'other', label: 'Другая страна' },
]

export type MedBook = 'yes' | 'no' | 'will_get'
export const medBookOptions: { id: MedBook; label: string }[] = [
  { id: 'yes', label: 'Есть' },
  { id: 'will_get', label: 'Оформлю до выхода' },
  { id: 'no', label: 'Нет' },
]

export type ShiftPreference = 'day' | 'night' | 'any'
export const shiftOptions: { id: ShiftPreference; label: string }[] = [
  { id: 'day', label: 'Только дневные' },
  { id: 'any', label: 'Дневные и ночные' },
  { id: 'night', label: 'Только ночные' },
]

const optionLabel = (list: { id: string; label: string }[], v: string | undefined) => list.find((o) => o.id === v)?.label ?? ''
export const citizenshipLabel = (v: string | undefined) => optionLabel(citizenshipOptions, v)
export const medBookLabel = (v: string | undefined) => optionLabel(medBookOptions, v)
export const shiftLabel = (v: string | undefined) => optionLabel(shiftOptions, v)
export const adultLabel = (v: boolean | null | undefined) => (v === true ? 'Да' : v === false ? 'Нет' : '')

// ── Поля кейса: дата рождения, когда может выйти, учёба (docs/case-delta.md, c2-fields) ──────
// Дата рождения — shared/birthDate.ts: разбор ввода, возраст по Москве, 18+.

/** Когда кандидат может выйти на работу. month — с месяца из startMonth */
export type StartReady = 'now' | 'two_weeks' | 'after_session' | 'month'
export const startReadyOptions: { id: StartReady; label: string }[] = [
  { id: 'now', label: 'Сразу' },
  { id: 'two_weeks', label: 'Через 1–2 недели' },
  { id: 'after_session', label: 'После сессии' },
  { id: 'month', label: 'С определённого месяца' },
]
export const isStartReady = (v: unknown): v is StartReady => startReadyOptions.some((o) => o.id === v)

const monthNames = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь']
const monthGenitive = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря']

/** Месяц 1–12 в родительном падеже: «июля» — для «не раньше июля», «с июля»; пустая строка — не месяц */
export const monthGenitiveName = (m: number) => (isStartMonth(m) ? monthGenitive[m - 1] : '')

/** Месяцы для выбора при «С определённого месяца»: id — номер месяца 1–12 */
export const startMonthOptions: { id: number; label: string }[] = monthNames.map((m, i) => ({ id: i + 1, label: m[0].toUpperCase() + m.slice(1) }))
export const isStartMonth = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 12

/** «Сразу», «Через 1–2 недели», «После сессии», «С июля»; пустая строка — кандидат не ответил */
export function startReadyLabel(v: string | null | undefined, month?: number | null) {
  if (v === 'month') return isStartMonth(month) ? `С ${monthGenitive[month - 1]}` : optionLabel(startReadyOptions, v)
  return optionLabel(startReadyOptions, v ?? undefined)
}

/** Что пишем вместо вуза, если кандидат уже не учится */
export const NOT_STUDYING_LABEL = 'Уже не учусь'

/** Учёба одной строкой: вуз или колледж, «Уже не учусь» или пустая строка */
export const studyLabel = (a: Pick<Application, 'school' | 'notStudying'>) => a.school.trim() || (a.notStudying ? NOT_STUDYING_LABEL : '')

/** Дата рождения в виде ДД.ММ.ГГГГ; пустая строка — даты нет */
export const birthDateLabel = (v: string | null | undefined) => formatBirthDate(v)

// ── Оформление практиканта: наставник и документы по практике (справочник студента) ──────

/** Документы по практике: договор с вузом до начала, приказ «Очаково», дневник или отчёт студента, характеристика после */
export type PracticeDoc = 'contract' | 'order' | 'diary' | 'reference'
export const practiceDocOptions: { id: PracticeDoc; label: string; short: string; hint: string }[] = [
  { id: 'contract', label: 'Договор с вузом или колледжем', short: 'договор', hint: 'Подписывают до начала практики' },
  { id: 'order', label: 'Приказ о практике', short: 'приказ', hint: 'Издаёт «Очаково»' },
  { id: 'diary', label: 'Дневник или отчёт по практике', short: 'дневник', hint: 'Заполняет студент во время практики' },
  { id: 'reference', label: 'Характеристика', short: 'характеристика', hint: 'Выдаёт компания после практики' },
]
export const isPracticeDoc = (v: unknown): v is PracticeDoc => practiceDocOptions.some((o) => o.id === v)

/** Отметки документов: только известные, без повторов, в порядке списка */
export const normalizePracticeDocs = (v: unknown): PracticeDoc[] =>
  Array.isArray(v) ? practiceDocOptions.map((o) => o.id).filter((id) => v.includes(id)) : []

/** «Договор, приказ» — какие документы по практике отмечены; пустая строка — ни одного */
export function practiceDocsLabel(docs: readonly string[] | null | undefined) {
  const s = normalizePracticeDocs(docs).map((id) => practiceDocOptions.find((o) => o.id === id)!.short).join(', ')
  return s ? s[0].toUpperCase() + s.slice(1) : ''
}

/** Чего не хватает в анкете для оформления на производство. 18+ выводится из даты рождения, поэтому вместо «18+» — она */
export function missingProfile(a: Pick<Application, 'lastName' | 'birthDate' | 'citizenship' | 'medBook' | 'shifts'>) {
  const missing: string[] = []
  if (!a.lastName) missing.push('фамилия')
  if (!a.birthDate) missing.push('дата рождения')
  if (!a.citizenship) missing.push('гражданство')
  if (!a.medBook) missing.push('медкнижка')
  if (!a.shifts) missing.push('смены')
  return missing
}

export type GameSnapshot = {
  /** Направление из подбора работы */
  quizResult: DepartmentId | null
  /** Лучший счёт в «Поймай брак», 0 — не играл */
  conveyorBest: number
  /** Сколько из четырёх заданий пройдено («Смена N/4») */
  activities?: number
  /** Лучший счёт контрольных вопросов о компании (/game?t=quiz); нет — не проходил */
  companyQuiz?: { score: number; total: number }
}

export type Application = {
  id: string
  createdAt: string
  /** Откуда пришла заявка: сайт или бот в мессенджере */
  channel?: ApplicationChannel
  /** id пользователя в мессенджере — чтобы бот мог сообщить о статусе заявки */
  channelUserId?: string
  name: string
  phone: string
  /** Telegram, MAX или e-mail */
  contact: string
  school: string
  course: string
  department: DepartmentId | ''
  vacancyId: string
  format: VacancyFormat | ''
  months: number[]
  comment: string
  /** «Устройтесь вдвоём»: имя и контакт друга, с которым хотят работать вместе */
  friend?: string
  game: GameSnapshot
  /** Метка источника: ?src=fair-mgupp, start-параметр бота и т. п. */
  source: string | null
  /** Анкета под производство — необязательные поля */
  lastName?: string
  /** Отчество — только если кандидат указал его отдельно; из двух слов имени не угадываем */
  middleName?: string
  /** Ссылка на резюме hh.ru — у импортированных откликов */
  resumeUrl?: string
  /** Подтверждение «мне есть 18 лет»; null — не ответил */
  adult?: boolean | null
  citizenship?: Citizenship | ''
  medBook?: MedBook | ''
  shifts?: ShiftPreference | ''
  /** Ссылка на портфолио — для вакансий в офисе и маркетинге */
  portfolio?: string
  /** Когда дано согласие на обработку данных; null — согласия нет (кандидата добавил HR без основания) */
  consentAt?: string | null
  /** Версия текста согласия: CONSENT_VERSION на момент заявки, '0' — заявка до отдельного согласия */
  consentVersion?: string
  consentSource?: ConsentSource
  /** Личный код приглашения кандидата (6 символов алфавита бота): по нему находят приглашённых им друзей */
  refCode?: string | null
  /** Нужна практика от вуза: договор с вузом и дневник */
  practiceSchool?: boolean
  /** Хочет остаться после сезона */
  wantsToStay?: boolean
  /** Дата рождения YYYY-MM-DD; пустая строка — не указана (старые заявки и добавленные HR). Из неё выводится adult */
  birthDate?: string
  /** Когда может выйти на работу; пустая строка — не ответил */
  startReady?: StartReady | ''
  /** Месяц выхода 1–12 — только при startReady = 'month' */
  startMonth?: number | null
  /** «Уже не учусь» — вместо вуза или колледжа в school */
  notStudying?: boolean
  /** Поля отдела персонала — кандидат их не заполняет */
  status?: ApplicationStatus
  statusUpdatedAt?: string
  /** Заметки HR о кандидате */
  notes?: string
  /** Только демо-режим без сервера (VITE_DEMO_LOCAL=1): заявка лежит в браузере и до HR не дошла */
  savedLocally?: true
  /** Токен для «Моей заявки» — приходит один раз, в ответе на создание заявки. В базе только его хеш */
  statusToken?: string
}

/** Собеседование: дата и время, адрес, что взять с собой, явка и как записан */
export type InterviewSlot = {
  id: number
  startsAt: string
  address: string
  bring: string
  /** Явка: '' — не отмечена */
  attended: Attendance
  /** Когда отметили явку; null — не отмечали */
  attendedAt: string | null
  /** Кандидат сам выбрал время по предложению HR */
  selfBooked: boolean
}

/** Заявка в HR-панели: с ответственным, задачами, дублями и пройденными этапами */
export type HrApplication = Application & {
  status: ApplicationStatus
  assigneeId: number | null
  assigneeName: string | null
  noAnswerCount: number
  /** Задача «перезвонить»: когда и зачем */
  callbackAt: string | null
  callbackNote: string
  declineReason: DeclineReason | ''
  /** Заявка склеена с другой — показывается только в карточке основной */
  duplicateOf: string | null
  /** Сколько ещё активных заявок с тем же телефоном */
  duplicates: number
  /** Статусы, в которых заявка побывала: по ним считается воронка */
  reached: ApplicationStatus[]
  interview: InterviewSlot | null
  /** Личные данные удалены: по сроку хранения или по запросу кандидата. Остались только поля для воронки */
  anonymizedAt: string | null
  anonymizedReason: 'retention' | 'request' | ''
  /** Сработала ловушка формы: заявка сохранена, но похожа на спам */
  suspectedSpam: boolean
  /** Оформление: дата оформления или медкомиссии */
  onboardingAt: string | null
  /** Дата и время первой смены */
  firstShiftAt: string | null
  shiftKind: ShiftKind | ''
  onboardingNote: string
  /** Итог сезона — только у «На смене» */
  seasonOutcome: SeasonOutcome | ''
  seasonLeaveReason: SeasonLeaveReason | ''
  /** Отметка «Звать в штат / резерв». Внутренняя, кандидат её не видит */
  reserve: boolean
  /** Бот, к которому кандидат привязал заявку с сайта: туда уходят сообщения о ней. У заявок из бота — null, там свой channelUserId */
  botChannel: BotChannel | null
  botUserId: string | null
  /** Наставник на время практики или первых смен: имя сотрудника, пустая строка — не назначен */
  mentorName: string
  /** Отмеченные документы по практике */
  practiceDocs: PracticeDoc[]
  /** Кто из HR отметил согласие (устно или по отклику на работном сайте); пустая строка — согласие дано на сайте или в боте */
  consentBy: string
  /** «Как дела на смене»: вопросы новичку после первой смены, через неделю и через месяц (shared/adaptation.ts) */
  checkins: Checkin[]
}

/** Пустые поля HR — для заявок без сервера (демо-режим, проверки сценариев в памяти) */
export const emptyHrFields = (): Omit<HrApplication, keyof Application | 'status'> => ({
  assigneeId: null,
  assigneeName: null,
  noAnswerCount: 0,
  callbackAt: null,
  callbackNote: '',
  declineReason: '',
  duplicateOf: null,
  duplicates: 0,
  reached: [],
  interview: null,
  anonymizedAt: null,
  anonymizedReason: '',
  suspectedSpam: false,
  onboardingAt: null,
  firstShiftAt: null,
  shiftKind: '',
  onboardingNote: '',
  seasonOutcome: '',
  seasonLeaveReason: '',
  reserve: false,
  botChannel: null,
  botUserId: null,
  mentorName: '',
  practiceDocs: [],
  consentBy: '',
  checkins: [],
})

/** Что показывать вместо удалённых личных данных */
export const erasedLabel = (a: { anonymizedAt?: string | null; anonymizedReason?: string }) =>
  !a.anonymizedAt ? null : a.anonymizedReason === 'request' ? 'удалено по запросу кандидата' : 'удалено по сроку хранения'

/**
 * Что присылает кандидат: без номера, даты и полей отдела персонала.
 * Время согласия ставит сервер; кандидат присылает только consent: true и версию текста
 */
export type ApplicationInput = Omit<Application, 'id' | 'createdAt' | 'status' | 'statusUpdatedAt' | 'notes' | 'savedLocally' | 'statusToken' | 'consentAt'> & {
  /** Отметка «Даю согласие на обработку персональных данных» */
  consent?: boolean
  /** Скрытое поле-ловушка формы: человек его не видит и не заполняет */
  website?: string
}

/** Ссылка на портфолио: http или https, не длиннее 300 символов */
export function isPortfolioUrl(v: string) {
  const s = v.trim()
  if (s.length > 300) return false
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`)
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.includes('.')
  } catch {
    return false
  }
}

/** Ссылка в едином виде: без протокола добавляем https:// */
export const normalizePortfolio = (v: unknown) => {
  if (typeof v !== 'string' || !v.trim() || !isPortfolioUrl(v)) return ''
  const s = v.trim()
  return /^https?:\/\//i.test(s) ? s : `https://${s}`
}

/** Код ошибки поля: required — не заполнено, invalid — не прочитать; у даты рождения — underage и bad_birth_date */
export type FieldCode = 'required' | 'invalid' | BirthDateCode

export type ApplicationCheck = { errors: Record<string, string>; codes: Record<string, FieldCode> }

export type CheckOptions = {
  /**
   * Заявка кандидата с сайта или из бота: обязательны фамилия, имя, дата рождения (с 18 лет), вуз или колледж
   * (или «Уже не учусь») и когда может выйти; отчество — если есть
   */
  candidate?: boolean
  /** Момент, от которого считается возраст, — для проверок */
  now?: Date | number
}

/** Тексты ошибок полей кейса. Дата рождения — birthDateMessages в shared/birthDate.ts */
export const caseFieldMessages = {
  lastName: 'Укажи фамилию',
  school: 'Укажи вуз или колледж или выбери «Уже не учусь»',
  /** Одна буква вместо названия: человек что-то написал, «укажи вуз» сбивало бы с толку */
  schoolShort: 'Укажи название целиком: например, МГУПП или колледж № 32',
  startReady: 'Выбери, когда сможешь выйти на работу',
  startMonth: 'Выбери месяц, с которого сможешь выйти',
} as const

/**
 * Проверка заявки — одинаковая на клиенте, на сервере и в ботах. Возвращает ошибки по полям и их коды.
 * Без candidate — ручное добавление в HR и импорт: поля кейса необязательны, а дату рождения, если она есть,
 * проверяем на опечатку, но не на 18 лет: HR видит возраст в карточке и решает сам.
 * Дату рождения передавай как ввели (до normalizeApplicationInput): нормализация молча отбрасывает нечитаемую
 */
export function checkApplication(input: Partial<ApplicationInput>, opts: CheckOptions = {}): ApplicationCheck {
  const errors: Record<string, string> = {}
  const codes: Record<string, FieldCode> = {}
  const fail = (field: string, code: FieldCode, message: string) => {
    errors[field] = message
    codes[field] = code
  }
  if (!input.name || input.name.trim().length < 2) fail('name', 'required', 'Укажи имя')
  const digits = (input.phone ?? '').replace(/\D/g, '')
  const hasContact = Boolean(input.contact && input.contact.trim().length >= 3)
  if (digits.length < 10 && !hasContact) fail('phone', 'required', 'Нужен телефон или ник в Telegram или MAX')
  if (input.portfolio?.trim() && !isPortfolioUrl(input.portfolio)) fail('portfolio', 'invalid', 'Нужна ссылка, например https://behance.net/твоё-имя')

  const birth = typeof input.birthDate === 'string' ? input.birthDate.trim() : ''
  if (birth) {
    const problem = birthDateProblem(birth, opts.now)
    if (problem && (problem.code !== 'underage' || opts.candidate)) fail('birthDate', problem.code, problem.message)
  } else if (opts.candidate) fail('birthDate', 'required', birthDateMessages.required)

  if (opts.candidate) {
    if (!/\p{L}/u.test(input.lastName ?? '')) fail('lastName', 'required', caseFieldMessages.lastName)
    const school = (input.school ?? '').trim()
    if (input.notStudying !== true && school.length < 2) fail('school', 'required', school ? caseFieldMessages.schoolShort : caseFieldMessages.school)
    if (!isStartReady(input.startReady)) fail('startReady', 'required', caseFieldMessages.startReady)
    else if (input.startReady === 'month' && !isStartMonth(input.startMonth)) fail('startMonth', 'required', caseFieldMessages.startMonth)
  }
  return { errors, codes }
}

/** Ошибки по полям — checkApplication без кодов */
export function validateApplication(input: Partial<ApplicationInput>, opts: CheckOptions = {}): Record<string, string> {
  return checkApplication(input, opts).errors
}


// ── История заявки ─────────────────────────────────────────────────────────

/**
 * onboarding — оформление и первая смена, season — итог сезона и резерв, consent — согласие отметил сотрудник,
 * checkin — «Как дела на смене»: вопрос новичку и его ответ
 */
export type HistoryKind =
  | 'status'
  | 'comment'
  | 'message'
  | 'missed'
  | 'assign'
  | 'interview'
  | 'merge'
  | 'profile'
  | 'callback'
  | 'onboarding'
  | 'season'
  | 'consent'
  | 'checkin'

/** queued — ждёт отправки (ещё можно отменить), call — кандидату из сайта нужно позвонить */
export type NotifyState = 'queued' | 'sent' | 'skipped' | 'failed' | 'cancelled' | 'call'

export type HistoryEntry = {
  id: number
  createdAt: string
  userId: number | null
  userName: string
  kind: HistoryKind
  fromStatus: ApplicationStatus | null
  toStatus: ApplicationStatus
  comment: string
  notify: NotifyState | null
  notifyDetail: string
  undoneAt: string | null
}

/** Отменить действие можно в течение этого времени */
export const UNDO_WINDOW_MS = 10 * 60 * 1000

/** Значения по умолчанию для приглашения на собеседование — HR правит под себя */
export const interviewDefaults = { address: 'Москва, ул. Рябиновая, 44', bring: 'паспорт' }
