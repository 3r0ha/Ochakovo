import { createHash } from 'node:crypto'
import { dorm } from '@shared/content/handbook'
import { formatRub, maxEntryPay, minPracticePay } from '@shared/content/vacancies'
import { SOURCE_CODE_RE } from '@shared/sources'
import type { Sql } from './index'

// Онлайн-анкета фокус-группы (миграция 022). Вопросы и варианты дословно по протоколу docs/brand/focus-group.md,
// раздел 5: «Формулировки и варианты на странице совпадают с этим списком, иначе ответы онлайн и на встречах нельзя
// сравнить». Слоганы — в том же порядке, что в docs/brand/concept.md, раздел 4 «Для фокус-группы».
// Сверяет scripts/tests/focus-questionnaire.test.ts.
//
//   focusQuestions()                 — анкета для страницы /focus и подписи для HR (GET /api/focus, /api/hr/focus)
//   checkFocusAnswers(raw)           — разбор ответов: { value, errors }
//   cleanFreeText(text)              — свободный ответ без телефонов, почты, ников, имён и ссылок
//   saveFocusResponse(sql, …)        — запись; повтор с того же устройства — FocusAlreadyAnswered
//   focusResults(sql)                — счёт по вопросам и меткам, свободные ответы
//   focusRows(sql, tag?) + focusCsv  — выгрузка CSV для Excel
//   deleteFocusResponse, deleteFocusTag — убрать пробный ответ или ответы метки (только администратор)
//
// Маршруты — server/api/focus.ts.

/** Версия анкеты. Новые вопросы — новая версия и новая миграция с вариантами */
export const FOCUS_VERSION = 1

/** Предел свободного ответа, знаков */
export const FOCUS_TEXT_MAX = 300

export type FocusChoiceId = 'clear' | 'interest' | 'hook' | 'intent' | 'study'
export type FocusQuestionId = FocusChoiceId | 'missing'

export type FocusOption = { id: string; label: string }

export type FocusQuestion =
  | {
      id: FocusChoiceId
      kind: 'one'
      /** Вопрос дословно, как в протоколе */
      title: string
      /** Коротко — для таблиц HR */
      short: string
      /** slogan — варианты показываем крупно, как слоганы */
      look?: 'slogan'
      /** Подсказка под вопросом */
      hint?: string
      options: FocusOption[]
    }
  | { id: 'missing'; kind: 'text'; title: string; short: string; max: number; hint: string }

/**
 * Три слогана концепции в порядке docs/brand/concept.md, раздел 4 «Для фокус-группы»: главный — «Квас делают люди».
 * id остаются прежними (миграция 022 хранит их в ответах), меняется только порядок показа
 */
export const FOCUS_SLOGANS: FocusOption[] = [
  { id: 'people', label: '«Квас делают люди»' },
  { id: 'natural', label: '«Я делаю натуральные напитки»' },
  { id: 'teach', label: '«Сначала научим, потом доверим»' },
]

const sloganOptions: FocusOption[] = [...FOCUS_SLOGANS, { id: 'none', label: 'Ни один' }]

/** Число и сумма с обычными пробелами: неразрывные расставит типограф сайта, а в CSV они только мешают поиску */
const num = (n: number) => n.toLocaleString('ru-RU').replace(/\s/g, ' ')
const rub = (n: number) => formatRub(n).replace(/\s/g, ' ')

/**
 * Анкета целиком. Функция: суммы берутся из вакансий в момент запроса — после правок в панели
 * (w2-hr-admin) подпись «Сумма от N до M ₽» совпадает с сайтом. id вариантов не меняются, поэтому старые ответы не путаются
 */
export function focusQuestions(): FocusQuestion[] {
  return [
    { id: 'clear', kind: 'one', title: 'Какой слоган понятнее?', short: 'Понятнее', look: 'slogan', options: sloganOptions },
    {
      id: 'interest',
      kind: 'one',
      title: 'После какого слогана хочется узнать о практике?',
      short: 'Хочется узнать о практике',
      look: 'slogan',
      options: sloganOptions,
    },
    {
      id: 'hook',
      kind: 'one',
      title: 'Что зацепило больше всего?',
      short: 'Зацепило',
      hint: 'Один ответ — самое важное.',
      options: [
        // «Описание практики»: кладовщик — от 56 000 ₽, операторы цехов — от 70 000 ₽ (shared/content/vacancies.ts)
        { id: 'pay', label: `Сумма от ${num(minPracticePay)} до ${rub(maxEntryPay)}` },
        // «Справочник студента»: наставник у каждого новичка, без испытательного срока, общежитие 3 400 ₽ для студентов
        { id: 'mentor', label: 'Наставник у каждого новичка' },
        { id: 'no_probation', label: 'Без испытательного срока' },
        { id: 'dorm', label: `Общежитие студентам за ${rub(dorm.priceStudent)}` },
        { id: 'kvass', label: 'Квас «Очаковский»' },
        { id: 'history', label: 'История завода' },
        { id: 'nothing', label: 'Ничего' },
      ],
    },
    {
      id: 'intent',
      kind: 'one',
      title: 'Подать заявку на оплачиваемую практику в «Очаково»?',
      short: 'Заявка на практику',
      options: [
        { id: 'yes', label: 'Да' },
        { id: 'maybe', label: 'Может быть' },
        { id: 'no', label: 'Нет' },
      ],
    },
    {
      id: 'missing',
      kind: 'text',
      title: 'Чего не хватает, чтобы решиться?',
      short: 'Чего не хватает',
      max: FOCUS_TEXT_MAX,
      hint: 'Свободный ответ до 300 знаков. Можно пропустить. Без имени и телефона: анкета анонимная.',
    },
    {
      id: 'study',
      kind: 'one',
      title: 'Где ты сейчас учишься?',
      short: 'Учёба',
      options: [
        { id: 'college', label: 'Колледж' },
        { id: 'uni_junior', label: 'Вуз, 1–3 курс' },
        { id: 'uni_senior', label: 'Вуз, 4 курс и старше' },
        { id: 'graduated', label: 'Уже не учусь' },
      ],
    },
  ]
}

export const FOCUS_CHOICE_IDS: FocusChoiceId[] = ['clear', 'interest', 'hook', 'intent', 'study']

export type FocusAnswers = Record<FocusChoiceId, string> & { missing: string }

// ── Метка ──────────────────────────────────────────────────────────────────

/** Метка из ссылки: как метки источников (латиница, цифры, дефис, до 40 знаков). Непохожая — пустая, ответ не теряем */
export function normalizeFocusTag(raw: unknown): string {
  const tag = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return SOURCE_CODE_RE.test(tag) ? tag : ''
}

// ── Свободный ответ ────────────────────────────────────────────────────────

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g
const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b(?:t\.me|vk\.com|wa\.me|max\.ru)\/\S+/gi
const PHONE = /(?:\+7|\b8|\b7)[\s\-()]*\d{3}[\s\-()]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}\b/g
const LONG_DIGITS = /\b\d{10,15}\b/g
const HANDLE = /(^|[\s(])@[A-Za-z0-9_.]{3,}/g
const NAME = /(меня зовут|зовут меня|моё имя|мое имя)\s+[А-ЯЁA-Z][а-яёa-z-]+(?:\s+[А-ЯЁA-Z][а-яёa-z-]+)?/gi

/**
 * Свободный ответ без личных данных: анкета обещает анонимность, поэтому телефон, почту, ник, имя после «меня зовут»
 * и ссылки вырезаем до записи в базу. Пробелы и переводы строк — в один пробел, длина — не больше FOCUS_TEXT_MAX
 */
export function cleanFreeText(raw: string): string {
  const text = raw
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, ' ')
    .replace(EMAIL, '[почта скрыта]')
    .replace(URL_RE, '[ссылка скрыта]')
    .replace(PHONE, '[телефон скрыт]')
    .replace(LONG_DIGITS, '[телефон скрыт]')
    .replace(HANDLE, '$1[ник скрыт]')
    .replace(NAME, '$1 [имя скрыто]')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > FOCUS_TEXT_MAX ? text.slice(0, FOCUS_TEXT_MAX).trimEnd() : text
}

// ── Проверка ответов ───────────────────────────────────────────────────────

export type FocusCheck = { value: FocusAnswers; errors: Partial<Record<FocusQuestionId, string>> }

/** Ответы из запроса: все вопросы с вариантами обязательны, свободный ответ — нет */
export function checkFocusAnswers(raw: unknown): FocusCheck {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const errors: FocusCheck['errors'] = {}
  const value = { missing: '' } as FocusAnswers
  for (const q of focusQuestions()) {
    const given = src[q.id]
    if (q.kind === 'text') {
      if (given === undefined || given === null) continue
      if (typeof given !== 'string') {
        errors.missing = 'Ответ — текстом'
        continue
      }
      // Предел — по тексту человека: служебные пометки вроде «[телефон скрыт]» в него не засчитываются
      if (given.trim().length > q.max) errors.missing = `Не длиннее ${q.max} знаков`
      else value.missing = cleanFreeText(given)
      continue
    }
    if (typeof given !== 'string' || !q.options.some((o) => o.id === given)) {
      errors[q.id] = 'Выбери один вариант'
      continue
    }
    value[q.id] = given
  }
  return { value, errors }
}

// ── Устройство ─────────────────────────────────────────────────────────────

/** Значение cookie устройства: 24 случайных байта в base64url */
export const VOTER_TOKEN_RE = /^[A-Za-z0-9_-]{32}$/

/** В базе — только отпечаток cookie: по нему не восстановить саму cookie */
export const voterHash = (token: string) => createHash('sha256').update(`ochakovo-focus:${token}`).digest('hex')

// ── Запись ─────────────────────────────────────────────────────────────────

/** С этого устройства ответ уже есть */
export class FocusAlreadyAnswered extends Error {
  constructor() {
    super('already_answered')
  }
}

export async function saveFocusResponse(sql: Sql, input: { tag: string; voter: string | null; answers: FocusAnswers }): Promise<number> {
  const a = input.answers
  try {
    const [row] = await sql<{ id: string }[]>`
      insert into focus_responses (tag, voter, version, clear, interest, hook, intent, missing, study)
      values (${input.tag}, ${input.voter}, ${FOCUS_VERSION}, ${a.clear}, ${a.interest}, ${a.hook}, ${a.intent}, ${a.missing}, ${a.study})
      returning id`
    return Number(row.id)
  } catch (e) {
    if ((e as { code?: string; constraint_name?: string }).code === '23505') throw new FocusAlreadyAnswered()
    throw e
  }
}

export async function hasVoted(sql: Sql, voter: string): Promise<boolean> {
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from focus_responses where voter = ${voter}`
  return row.n > 0
}

// ── Результаты ─────────────────────────────────────────────────────────────

/** Счёт: метка → вопрос → вариант → число ответов. Пустая метка — ссылка без метки */
export type FocusCounts = Record<string, Partial<Record<FocusChoiceId, Record<string, number>>>>

export type FocusTagStat = { tag: string; count: number; last: string }
export type FocusText = { id: number; tag: string; text: string; at: string }

export type FocusResults = {
  version: number
  questions: FocusQuestion[]
  total: number
  /** Метки по числу ответов, больше — выше */
  tags: FocusTagStat[]
  counts: FocusCounts
  /** Ответы «Чего не хватает» — новые сверху, не больше FOCUS_TEXTS_LIMIT */
  texts: FocusText[]
}

export const FOCUS_TEXTS_LIMIT = 500

export async function focusResults(sql: Sql): Promise<FocusResults> {
  const tags = await sql<{ tag: string; n: number; last: Date }[]>`
    select tag, count(*)::int as n, max(created_at) as last from focus_responses group by tag order by n desc, tag`
  // Один проход по таблице на каждый вопрос с вариантами; ответов в анкете — сотни, не миллионы
  const grouped = await sql<{ tag: string; q: FocusChoiceId; a: string; n: number }[]>`
    select tag, 'clear' as q, clear as a, count(*)::int as n from focus_responses group by tag, clear
    union all select tag, 'interest', interest, count(*)::int from focus_responses group by tag, interest
    union all select tag, 'hook', hook, count(*)::int from focus_responses group by tag, hook
    union all select tag, 'intent', intent, count(*)::int from focus_responses group by tag, intent
    union all select tag, 'study', study, count(*)::int from focus_responses group by tag, study`
  const counts: FocusCounts = {}
  for (const r of grouped) {
    const byQuestion = (counts[r.tag] ??= {})
    const byOption = (byQuestion[r.q] ??= {})
    byOption[r.a] = r.n
  }
  const texts = await sql<{ id: string; tag: string; missing: string; created_at: Date }[]>`
    select id, tag, missing, created_at from focus_responses where missing <> ''
    order by created_at desc, id desc limit ${FOCUS_TEXTS_LIMIT}`
  return {
    version: FOCUS_VERSION,
    questions: focusQuestions(),
    total: tags.reduce((sum, t) => sum + t.n, 0),
    tags: tags.map((t) => ({ tag: t.tag, count: t.n, last: t.last.toISOString() })),
    counts,
    texts: texts.map((t) => ({ id: Number(t.id), tag: t.tag, text: t.missing, at: t.created_at.toISOString() })),
  }
}

// ── Выгрузка ───────────────────────────────────────────────────────────────

export type FocusRow = FocusAnswers & { id: number; tag: string; version: number; at: Date }

/** Ответы по одному, по порядку. tag: undefined — все метки, '' — только без метки */
export async function focusRows(sql: Sql, tag?: string): Promise<FocusRow[]> {
  const rows = await sql<
    { id: string; tag: string; version: number; clear: string; interest: string; hook: string; intent: string; missing: string; study: string; created_at: Date }[]
  >`
    select id, tag, version, clear, interest, hook, intent, missing, study, created_at from focus_responses
    where ${tag === undefined ? sql`true` : sql`tag = ${tag}`}
    order by created_at, id`
  return rows.map((r) => ({ ...r, id: Number(r.id), at: r.created_at }))
}

/** Защита от формул в Excel (OWASP «CSV injection»): такое значение начинается с апострофа */
const safeCell = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v)
const cell = (v: string | number) => `"${safeCell(String(v)).replace(/"/g, '""')}"`
const msk = (d: Date) =>
  d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(',', '')

/** Подпись варианта для людей: «Квас делают люди» вместо people. Неизвестный вариант — как есть */
export function optionLabel(questions: FocusQuestion[], q: FocusChoiceId, id: string): string {
  const question = questions.find((x) => x.id === q)
  return (question?.kind === 'one' && question.options.find((o) => o.id === id)?.label) || id
}

/** CSV для русского Excel: BOM, разделитель «;». Колонки — номер, метка, время по Москве и шесть вопросов дословно */
export function focusCsv(rows: FocusRow[], questions = focusQuestions()): string {
  const head = ['№', 'Метка', 'Время, МСК', ...questions.map((q, i) => `${i + 1}. ${q.title}`)]
  const lines = rows.map((r) =>
    [r.id, r.tag || 'без метки', msk(r.at), ...questions.map((q) => (q.kind === 'text' ? r.missing : optionLabel(questions, q.id, r[q.id])))].map(cell).join(';'),
  )
  return '\uFEFF' + [head.map(cell).join(';'), ...lines].join('\r\n')
}

// ── Удаление ───────────────────────────────────────────────────────────────

export async function deleteFocusResponse(sql: Sql, id: number): Promise<boolean> {
  const rows = await sql`delete from focus_responses where id = ${id} returning id`
  return rows.length > 0
}

/** Все ответы метки — например, пробные перед встречей. Возвращает, сколько удалено */
export async function deleteFocusTag(sql: Sql, tag: string): Promise<number> {
  const rows = await sql`delete from focus_responses where tag = ${tag} returning id`
  return rows.length
}
