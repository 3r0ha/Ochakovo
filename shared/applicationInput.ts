import {
  CONSENT_VERSION,
  citizenshipOptions,
  isConsentSource,
  isStartMonth,
  isStartReady,
  medBookOptions,
  normalizePortfolio,
  shiftOptions,
  type Application,
  type ApplicationInput,
  type ConsentSource,
  type FieldCode,
  type GameSnapshot,
  type StartReady,
} from './applications'
import { birthDateMessages, isAdultByBirthDate, normalizeBirthDate } from './birthDate'
import type { DepartmentId } from './content/departments'
import type { VacancyFormat } from './content/vacancies'
import { normalizePhone } from './phone'

// Сборка заявки из сырого ввода — одна для формы на сайте, ботов, PostgreSQL и хранилища в памяти.
// server/db реэкспортирует normalizeApplicationInput под старым именем normalizeApplication.

/** Код приглашения в теле заявки и /api/dialog: 6 строчных латинских букв и цифр 2–9 — так выглядит код из алфавита бота */
export const REF_CODE_RE = /^[a-z2-9]{6}$/

/** Где кандидат даёт согласие сам. hr_verbal, job_board и none ставит сотрудник HR при ручном добавлении */
export const candidateConsentSources: ConsentSource[] = ['site_form', 'site_chat', 'telegram', 'max']

/** Версии текста согласия, которые принимает сервер. Старый текст после правки /consent не принимается */
export const acceptedConsentVersions: string[] = [CONSENT_VERSION]

/** Источник согласия по каналу, если отправитель его не назвал: форма на сайте, Telegram или MAX */
const consentSourceByChannel = { web: 'site_form', telegram: 'telegram', max: 'max' } as const

/** Счёт контрольных вопросов: целые числа, 0 ≤ счёт ≤ всего ≤ 12; иначе поля нет */
function companyQuizInput(raw: unknown): { companyQuiz?: { score: number; total: number } } {
  const q = raw as { score?: unknown; total?: unknown } | null | undefined
  const score = q?.score
  const total = q?.total
  if (!Number.isInteger(score) || !Number.isInteger(total)) return {}
  const [s, t] = [score as number, total as number]
  return t > 0 && t <= 12 && s >= 0 && s <= t ? { companyQuiz: { score: s, total: t } } : {}
}

/**
 * Приводит произвольное тело запроса к ApplicationInput: обрезает строки, подставляет пустые значения.
 * Результат зависит только от ввода и от now (18+ по дате рождения) — форма, бот и хранилище в памяти
 * получают одну и ту же заявку
 */
export function normalizeApplicationInput(raw: Partial<ApplicationInput>, now: Date | number = Date.now()): ApplicationInput {
  const text = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
  const game = (raw.game ?? {}) as Partial<GameSnapshot>
  const channel = raw.channel === 'telegram' || raw.channel === 'max' ? raw.channel : 'web'
  const consent = raw.consent === true
  const refCode = text(raw.refCode, 16).toLowerCase()
  return {
    channel,
    name: text(raw.name, 120),
    phone: normalizePhone(text(raw.phone, 40)),
    contact: text(raw.contact, 120),
    school: text(raw.school),
    course: text(raw.course, 60),
    department: text(raw.department, 40) as DepartmentId | '',
    vacancyId: text(raw.vacancyId, 60),
    format: text(raw.format, 60) as VacancyFormat | '',
    months: Array.isArray(raw.months) ? raw.months.filter((m) => Number.isInteger(m) && m >= 1 && m <= 12).slice(0, 12) : [],
    comment: text(raw.comment, 2000),
    friend: text(raw.friend, 160),
    channelUserId: channel === 'web' ? undefined : text(raw.channelUserId, 64) || undefined,
    game: {
      quizResult: typeof game.quizResult === 'string' ? (game.quizResult as DepartmentId) : null,
      conveyorBest: Number.isFinite(game.conveyorBest) ? Math.max(0, Math.round(game.conveyorBest!)) : 0,
      activities: Number.isFinite(game.activities) ? Math.max(0, Math.min(4, Math.round(game.activities!))) : 0,
      ...companyQuizInput(game.companyQuiz),
    },
    source: text(raw.source, 64) || null,
    portfolio: normalizePortfolio(raw.portfolio),
    resumeUrl: /^https:\/\/([\w-]+\.)?hh\.ru\/resume\/[\w-]+/.test(text(raw.resumeUrl, 300)) ? text(raw.resumeUrl, 300) : '',
    ...normalizeProfile(raw, now),
    notStudying: raw.notStudying === true,
    // Согласие: время ставит сервер при записи. Без отметки источник — none, версия пустая
    consent,
    consentVersion: consent ? text(raw.consentVersion, 16) : '',
    consentSource: !consent ? 'none' : isConsentSource(raw.consentSource) ? raw.consentSource : consentSourceByChannel[channel],
    refCode: REF_CODE_RE.test(refCode) ? refCode : null,
    practiceSchool: raw.practiceSchool === true,
    wantsToStay: raw.wantsToStay === true,
    // Ловушка: человек поле не видит. Заполненное — заявка сохраняется с пометкой «похоже на спам»
    website: text(raw.website, 200),
  }
}

export type ProfileFields = 'lastName' | 'middleName' | 'adult' | 'citizenship' | 'medBook' | 'shifts' | 'birthDate' | 'startReady' | 'startMonth'

/**
 * Анкета: неизвестные значения отбрасываем, пустое — «не ответил».
 * Дата рождения — YYYY-MM-DD из любого привычного ввода (ДД.ММ.ГГГГ, Д.М.ГГГГ); нечитаемая или с опечаткой
 * (в будущем, старше 70) — пустая строка, поэтому проверяй ввод checkApplication до нормализации.
 * adult выводится из даты рождения, если она есть; без даты — как прислали (старые заявки и отметка «мне есть 18»).
 * Месяц выхода — только при «С определённого месяца»
 */
export function normalizeProfile(raw: Partial<Pick<ApplicationInput, ProfileFields>>, now: Date | number = Date.now()) {
  const pick = <T extends string>(v: unknown, list: { id: T }[]): T | '' => (list.some((o) => o.id === v) ? (v as T) : '')
  const birthDate = normalizeBirthDate(raw.birthDate, now)
  const startReady: StartReady | '' = isStartReady(raw.startReady) ? raw.startReady : ''
  // Месяц из формы может прийти строкой «7»
  const month = typeof raw.startMonth === 'string' ? Number(raw.startMonth) : raw.startMonth
  return {
    lastName: typeof raw.lastName === 'string' ? raw.lastName.trim().slice(0, 80) : '',
    middleName: typeof raw.middleName === 'string' ? raw.middleName.trim().slice(0, 80) : '',
    adult: isAdultByBirthDate(birthDate, now) ?? (typeof raw.adult === 'boolean' ? raw.adult : null),
    citizenship: pick(raw.citizenship, citizenshipOptions),
    medBook: pick(raw.medBook, medBookOptions),
    shifts: pick(raw.shifts, shiftOptions),
    birthDate,
    startReady,
    startMonth: startReady === 'month' && isStartMonth(month) ? month : null,
  }
}

// ── Согласие на обработку персональных данных ────────────────────────────

/**
 * Что не так с согласием в заявке кандидата (форма, чат на сайте, боты); null — всё в порядке.
 * Нужны отметка consent: true, версия текста из acceptedConsentVersions и источник, где кандидат дал согласие сам
 */
export function consentError(input: Pick<ApplicationInput, 'consent' | 'consentVersion' | 'consentSource'>): string | null {
  if (input.consent !== true || !input.consentSource || !candidateConsentSources.includes(input.consentSource)) return 'Нужно согласие на обработку персональных данных'
  if (!acceptedConsentVersions.includes(input.consentVersion ?? '')) return 'Текст согласия обновился. Обнови страницу и отметь согласие ещё раз'
  return null
}

/** Заявку кандидата без согласия не сохраняем: так отвечают saveApplication в PostgreSQL и в памяти */
export class ConsentRequiredError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'ConsentRequiredError'
  }
}

/**
 * Заявку кандидата моложе 18 лет по дате рождения не сохраняем: на работу, стажировку и практику берут с 18.
 * Форма и бот проверяют это раньше (checkApplication с candidate: true); ошибка — страховка в saveApplication
 */
export class UnderageError extends Error {
  constructor() {
    super(birthDateMessages.underage)
    this.name = 'UnderageError'
  }
}

// ── Ответы POST /api/applications ────────────────────────────────────────
// 201 — сохранённая заявка без полей HR (PublicApplication); refCode в ней есть, только если код записан.
// Каждый 429 приходит и с заголовком Retry-After в секундах.

export type PublicApplication = Omit<Application, 'status' | 'statusUpdatedAt' | 'notes' | 'channelUserId'>

/** Заявка для ответа кандидату: без полей отдела персонала и без пустого кода приглашения */
export function publicApplication(app: Application): PublicApplication {
  const { status: _status, statusUpdatedAt: _updated, notes: _notes, channelUserId: _uid, ...rest } = app
  if (rest.refCode == null) delete rest.refCode
  return rest
}

export type ApplyError =
  /**
   * Ошибки по полям; consent — нет согласия или версия текста неизвестна. codes — коды тех же полей:
   * required, invalid, а у даты рождения underage (моложе 18) и bad_birth_date (опечатка, такой даты нет)
   */
  | { error: 'validation'; errors: Partial<Record<keyof ApplicationInput, string>>; codes?: Partial<Record<keyof ApplicationInput, FieldCode>> }
  /** Заявка с этим телефоном или ником только что принята. Номера и токена чужой заявки в ответе нет */
  | { error: 'already_applied' }
  /** rate_limited — много заявок с одного адреса, phone_limit — с одного телефона. retryAfter — секунды */
  | { error: 'rate_limited' | 'phone_limit'; retryAfter: number }
