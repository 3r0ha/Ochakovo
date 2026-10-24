import type { HrApplication } from './applications'
import { contacts } from './content/content'
import { dorm, handbookText } from './content/handbook'
import { mskAt, mskParts } from './workdays'

// «Как дела на смене»: три коротких вопроса новичку — после первой смены, через неделю и через месяц.
// Кейс: 38% отсеиваются на испытательном сроке, основной отток — выпускники и начинающие специалисты.
// Ответ «Тяжело» сразу становится задачей HR поговорить, а человек в ответ получает факт из справочника студента по своей причине.
// Одна логика для бота, страницы «Моя заявка», HR-панели и «Воронки». Миграция — server/db/migrations/023_checkins.sql.

export type CheckinStep = 'shift1' | 'week1' | 'month1'
export type CheckinAnswer = 'ok' | 'question' | 'hard'
export type CheckinReason = 'schedule' | 'work' | 'team' | 'commute' | 'study' | 'money' | 'other'
/** Где ответили: в боте, на странице «Моя заявка» (site), в чате на сайте (web) или со слов кандидата при звонке (hr) */
export type CheckinVia = 'telegram' | 'max' | 'web' | 'site' | 'hr'

export type Checkin = {
  step: CheckinStep
  askedAt: string | null
  /** bot — вопрос ушёл в бот, call — бота нет, HR получил задачу спросить при звонке */
  askedVia: '' | 'bot' | 'call'
  answer: CheckinAnswer | ''
  reason: CheckinReason | ''
  answeredAt: string | null
  answeredVia: CheckinVia | ''
}

/** days — через сколько дней после дня первой смены спросить, в 18:00 по Москве */
export const checkinSteps: { id: CheckinStep; days: number; label: string; question: string }[] = [
  { id: 'shift1', days: 1, label: 'После первой смены', question: 'Как прошла первая смена?' },
  { id: 'week1', days: 7, label: 'Через неделю', question: 'Неделя на заводе позади. Как ты?' },
  { id: 'month1', days: 30, label: 'Через месяц', question: 'Месяц на заводе. Как работается?' },
]

/** Час вопроса по Москве: после дневной смены человек уже дома, после ночной — выспался */
export const CHECKIN_HOUR = 18
/** Сколько дней последний вопрос ждёт ответа на странице «Моя заявка» */
const LAST_WINDOW_DAYS = 14

export const checkinAnswers: { id: CheckinAnswer; label: string }[] = [
  { id: 'ok', label: 'Всё нормально' },
  { id: 'question', label: 'Есть вопрос' },
  { id: 'hard', label: 'Тяжело' },
]

const money = (n: number) => `${new Intl.NumberFormat('ru-RU').format(n).replace(/\s/g, ' ')} ₽`

/** Что тяжелее всего. fact — что можно сделать уже сейчас, по справочнику студента; пусто — только звонок HR */
export const checkinReasons: { id: CheckinReason; label: string; fact: string }[] = [
  { id: 'schedule', label: 'График и ночные смены', fact: handbookText('schedule') },
  {
    id: 'work',
    label: 'Сама работа',
    fact: 'С вопросами по работе обращайся к наставнику или в Учебный центр. На старте наставник помогает освоить процессы, оборудование и работу на нём.',
  },
  { id: 'team', label: 'Наставник или коллектив', fact: '' },
  { id: 'commute', label: 'Дорога', fact: `${contacts.shuttle} Адрес общежития: ${dorm.address}, койко-место для студентов стоит ${money(dorm.priceStudent)}.` },
  { id: 'study', label: 'Учёба', fact: handbookText('exams') },
  { id: 'money', label: 'Деньги', fact: handbookText('payday') },
  { id: 'other', label: 'Другое', fact: '' },
]

export const isCheckinStep = (v: unknown): v is CheckinStep => checkinSteps.some((s) => s.id === v)
export const isCheckinAnswer = (v: unknown): v is CheckinAnswer => checkinAnswers.some((a) => a.id === v)
export const isCheckinReason = (v: unknown): v is CheckinReason => checkinReasons.some((r) => r.id === v)

export const checkinStepLabel = (v: string) => checkinSteps.find((s) => s.id === v)?.label ?? ''
export const checkinAnswerLabel = (v: string) => checkinAnswers.find((a) => a.id === v)?.label ?? ''
export const checkinReasonLabel = (v: string) => checkinReasons.find((r) => r.id === v)?.label ?? ''

/** Под вопросом в боте и на странице «Моя заявка» */
export const CHECKIN_NOTE = 'Ответ увидит отдел персонала. Если что-то не так, лучше сказать сразу: в начале это проще поправить.'

/** Ответ после «Тяжело» с причиной: что делать сейчас и что дальше будет звонок */
export const CHECKIN_CALL_TEXT = 'Ответ уже у отдела персонала: тебе позвонят в рабочее время.'
export const checkinHardReply = (reason: CheckinReason) => {
  const fact = checkinReasons.find((r) => r.id === reason)?.fact ?? ''
  return fact ? `${fact}\n\n${CHECKIN_CALL_TEXT}` : CHECKIN_CALL_TEXT
}

/** Задача HR после «Тяжело» — в строке «Перезвонить» */
export const checkinHardNote = (step: CheckinStep, reason: CheckinReason | '') =>
  `${checkinStepLabel(step)} новичку тяжело${reason ? `: ${checkinReasonLabel(reason).toLowerCase()}` : ''}. Поговорить`
/** Задача HR по кнопке «Пусть HR позвонит» */
export const CHECKIN_CALL_NOTE = 'Новичок просит позвонить'
/** Задача HR, если бота у человека нет: спросить при звонке */
export const checkinAskNote = (step: CheckinStep) => `Спросить новичка, как дела: ${checkinStepLabel(step).toLowerCase()}`

const plusDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10)

/**
 * От чего считать вопросы: дата первой смены от HR; без неё у «На смене» — время, когда отметили «Первая смена отработана».
 * У остальных статусов вопросов нет
 */
export function checkinAnchor(app: Pick<HrApplication, 'status' | 'firstShiftAt' | 'statusUpdatedAt'>): string | null {
  if (app.status !== 'hired' && app.status !== 'started') return null
  if (app.firstShiftAt) return app.firstShiftAt
  return app.status === 'started' ? (app.statusUpdatedAt ?? null) : null
}

/** Когда задать вопрос: в 18:00 по Москве через days дней после дня первой смены */
export function checkinTime(anchor: string, step: CheckinStep): Date {
  const s = checkinSteps.find((x) => x.id === step)!
  return mskAt(plusDays(mskParts(new Date(anchor)).day, s.days), CHECKIN_HOUR)
}

/** До какого времени вопрос актуален: до следующего вопроса, последний — ещё две недели */
export function checkinDeadline(anchor: string, step: CheckinStep): Date {
  const i = checkinSteps.findIndex((x) => x.id === step)
  const next = checkinSteps[i + 1]
  return next ? checkinTime(anchor, next.id) : new Date(checkinTime(anchor, step).getTime() + LAST_WINDOW_DAYS * 864e5)
}

type CheckinApp = Pick<HrApplication, 'status' | 'firstShiftAt' | 'statusUpdatedAt' | 'seasonOutcome' | 'checkins'>

/** Какой вопрос сейчас ждёт ответа: время пришло, следующий ещё не наступил, ответа нет. null — ничего не ждёт */
export function dueCheckin(app: CheckinApp, now = Date.now()): CheckinStep | null {
  const anchor = checkinAnchor(app)
  if (!anchor || app.seasonOutcome === 'left') return null
  for (const s of checkinSteps) {
    if (checkinTime(anchor, s.id).getTime() > now || checkinDeadline(anchor, s.id).getTime() <= now) continue
    return app.checkins.some((c) => c.step === s.id && c.answer) ? null : s.id
  }
  return null
}

/** Последний ответ «Тяжело», после которого HR ещё не отметил итог сезона, — метка «тяжело на смене» в списке */
export function hardSignal(app: Pick<HrApplication, 'status' | 'seasonOutcome' | 'checkins'>): Checkin | null {
  if ((app.status !== 'hired' && app.status !== 'started') || app.seasonOutcome) return null
  const answered = app.checkins.filter((c) => c.answer && c.answeredAt).sort((a, b) => a.answeredAt!.localeCompare(b.answeredAt!))
  const last = answered.at(-1)
  return last?.answer === 'hard' ? last : null
}

export type AdaptationStats = {
  steps: { id: CheckinStep; label: string; asked: number; answered: number; ok: number; question: number; hard: number }[]
  reasons: { id: CheckinReason; label: string; count: number }[]
  /** Уход до конца сезона среди тех, у кого отмечен итог: отвечали «Тяжело» хотя бы раз и остальные ответившие */
  afterHard: { left: number; total: number }
  afterOk: { left: number; total: number }
}

/** «Воронка»: сколько спросили и ответили на каждом шаге, причины «Тяжело» и связь ответов с уходом до конца сезона */
export function adaptationStats(apps: Pick<HrApplication, 'duplicateOf' | 'seasonOutcome' | 'checkins'>[]): AdaptationStats {
  const list = apps.filter((a) => !a.duplicateOf)
  const steps = checkinSteps.map((s) => {
    const rows = list.flatMap((a) => a.checkins.filter((c) => c.step === s.id && (c.askedAt || c.answer)))
    const count = (answer: CheckinAnswer) => rows.filter((c) => c.answer === answer).length
    return { id: s.id, label: s.label, asked: rows.length, answered: rows.filter((c) => c.answer).length, ok: count('ok'), question: count('question'), hard: count('hard') }
  })
  const hardRows = list.flatMap((a) => a.checkins.filter((c) => c.answer === 'hard'))
  const reasons = checkinReasons
    .map((r) => ({ id: r.id, label: r.label, count: hardRows.filter((c) => c.reason === r.id).length }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count)
  const outcome = (filter: (a: (typeof list)[number]) => boolean) => {
    const done = list.filter((a) => a.seasonOutcome && filter(a))
    return { left: done.filter((a) => a.seasonOutcome === 'left').length, total: done.length }
  }
  const hadHard = (a: (typeof list)[number]) => a.checkins.some((c) => c.answer === 'hard')
  return {
    steps,
    reasons,
    afterHard: outcome(hadHard),
    afterOk: outcome((a) => !hadHard(a) && a.checkins.some((c) => c.answer)),
  }
}
