import { contacts, phonebook } from '@shared/content/content'
import type { Sql } from '../db'
import { isAlcoholTopic, redactPersonal } from './guard'
import { matchHrAnswer, type HrAnswer } from './hrAnswers'

// Ответы отдела персонала на «Вопросы к Квасычу»: проверка текста и хранение (таблица kb_answers, миграция 016).
// Проверка: без «!», без дат, телефоны, почта и имена вычищаются тем же фильтром, что вопросы (общие контакты
// компании остаются), про алкоголь Квасыч не говорит. Род — подсказкой: HR сам решает, как написать.

export type KbAnswerInput = { question: string; answer: string; variants: string[] }

export type KbAnswer = KbAnswerInput & {
  id: number
  createdAt: string
  updatedAt: string
  enabled: boolean
  gapId: number | null
  authorName: string
}

export type KbAnswerField = 'question' | 'answer' | 'variants'

export type KbAnswerCheck = {
  /** Что мешает сохранить: текст по полю */
  errors: Partial<Record<KbAnswerField, string>>
  /** Подсказки, которые сохранить не мешают: род, длина */
  hints: string[]
  /** Текст после очистки личных данных — именно его сохраним */
  cleaned: KbAnswerInput
}

export const KB_LIMITS = { question: 300, answer: 700, variant: 200, variants: 8, answerMin: 10 } as const

const digits = (s: string) => s.replace(/\D/g, '')
/** Общие телефоны и почта компании из справочника студента и ochakovo.ru/rabota — их в ответе оставляем */
const officialPhones = new Set(
  [contacts.phone, contacts.mobile, contacts.whatsapp, ...phonebook.flatMap((p) => [p.phone, p.mobile ?? ''])]
    .map(digits)
    .filter(Boolean)
    .map((d) => d.replace(/^7/, '8')),
)
const isOfficial = (m: string) => m.toLowerCase().replace(/[.,;:]+$/, '') === contacts.email || officialPhones.has(digits(m).replace(/^7/, '8'))

const MONTHS = /^(январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)/

/** Дата в тексте — «15.06», «2025-06-15», «15 июня», «в 2025 году»: такие ответы быстро устаревают */
export function findDate(text: string): string | null {
  const t = text.toLowerCase().replace(/ё/g, 'е')
  for (const m of t.matchAll(/(?<![\d:.])(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?![\d:])/g)) {
    const day = Number(m[1])
    const month = Number(m[2])
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) return m[0]
  }
  const iso = /(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/.exec(t)
  if (iso) return iso[0]
  for (const m of t.matchAll(/(?<![\d])(\d{1,2})\s+([а-я]+)/g)) if (MONTHS.test(m[2])) return m[0]
  // Год: четыре цифры подряд, не сумма («2000 ₽») и не часть числа с пробелами («12 000»)
  for (const m of t.matchAll(/(?<![\d.,])(?<!\d[\s\u00A0])((?:19|20)\d{2})(?![\d])(?!\s*(₽|руб|р\.|тыс|бутыл|час|человек|шт))/g)) return m[1]
  return null
}

/** Род в обращении к человеку: «готов», «согласна», «(а)» — подсказываем нейтральную форму */
const GENDERED = /\((а|ла|на|ая|ый)\)|(?<![а-я])(готов|готова|согласен|согласна|должен|должна|рад|рада|уверен|уверена|смог|смогла|пришел|пришла|понял|поняла|сделал|сделала|заинтересован|заинтересована|свободен|свободна)(?![а-я])/gi

export function checkKbAnswer(raw: { question?: unknown; answer?: unknown; variants?: unknown }): KbAnswerCheck {
  const str = (v: unknown) => (typeof v === 'string' ? v.replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim() : '')
  const input: KbAnswerInput = {
    question: str(raw.question),
    answer: str(raw.answer).replace(/\n{3,}/g, '\n\n'),
    variants: [...new Set((Array.isArray(raw.variants) ? raw.variants : typeof raw.variants === 'string' ? raw.variants.split('\n') : []).map(str).filter(Boolean))],
  }
  const cleaned: KbAnswerInput = {
    question: redactPersonal(input.question),
    answer: redactPersonal(input.answer, isOfficial),
    variants: input.variants.map((v) => redactPersonal(v)),
  }
  const errors: KbAnswerCheck['errors'] = {}
  const hints: string[] = []

  if (cleaned.question.length < 3) errors.question = 'Напиши вопрос, на который отвечаешь'
  else if (cleaned.question.length > KB_LIMITS.question) errors.question = `Вопрос не длиннее ${KB_LIMITS.question} знаков`

  const a = cleaned.answer
  if (a.length < KB_LIMITS.answerMin) errors.answer = 'Напиши ответ, хотя бы одно предложение'
  else if (a.length > KB_LIMITS.answer) errors.answer = `Ответ длиннее ${KB_LIMITS.answer} знаков: Квасыч отвечает коротко`
  else if (a.includes('!')) errors.answer = 'Без «!»: Квасыч отвечает спокойно'
  else if (findDate(a)) errors.answer = `Без дат («${findDate(a)}»): пиши «в сезон», «за две недели», «по будням», даты устаревают`
  else if (isAlcoholTopic(a)) errors.answer = 'Про пиво и алкоголь Квасыч не говорит'
  else if (a !== input.answer) errors.answer = 'Убрали личные данные: телефон, почту или имя. Проверь текст и сохрани ещё раз. Общие контакты компании можно оставить'

  if (input.variants.length > KB_LIMITS.variants) errors.variants = `Не больше ${KB_LIMITS.variants} формулировок`
  else if (input.variants.some((v) => v.length > KB_LIMITS.variant)) errors.variants = `Формулировка не длиннее ${KB_LIMITS.variant} знаков`
  else if (cleaned.variants.some((v, i) => v !== input.variants[i]) || cleaned.question !== input.question) {
    const field: KbAnswerField = cleaned.question !== input.question ? 'question' : 'variants'
    errors[field] = 'Убрали личные данные, проверь и сохрани ещё раз'
  }

  const gendered = [...new Set([...a.matchAll(GENDERED)].map((m) => m[0].toLowerCase()))]
  if (gendered.length) hints.push(`Проверь род: «${gendered.join('», «')}». Нейтрально звучит «можно выйти», «если подойдёт», «тебе есть 18 лет».`)
  if (a.length > 400) hints.push('Длинный ответ. Пусть первая фраза сразу отвечает, остальное можно убрать.')
  if (/^(отличный|хороший)\s+вопрос|^конечно/i.test(a)) hints.push('Начни сразу с ответа, без вступления.')
  return { errors, hints, cleaned }
}

// ── Хранение ────────────────────────────────────────────────────────────

type Row = {
  id: string
  created_at: Date
  updated_at: Date
  question: string
  variants: string[]
  answer: string
  enabled: boolean
  gap_id: string | null
  author_name: string
}

const toAnswer = (r: Row): KbAnswer => ({
  id: Number(r.id),
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
  question: r.question,
  variants: r.variants ?? [],
  answer: r.answer,
  enabled: r.enabled,
  gapId: r.gap_id === null ? null : Number(r.gap_id),
  authorName: r.author_name,
})

export async function listKbAnswers(sql: Sql): Promise<KbAnswer[]> {
  const rows = await sql<Row[]>`select * from kb_answers order by enabled desc, updated_at desc limit 500`
  return rows.map(toAnswer)
}

/** Включённые ответы — источник маленького индекса Квасыча (setHrAnswerSource) */
export async function enabledKbAnswers(sql: Sql): Promise<HrAnswer[]> {
  const rows = await sql<Row[]>`select * from kb_answers where enabled order by id`
  return rows.map((r) => ({ id: Number(r.id), question: r.question, variants: r.variants ?? [], answer: r.answer }))
}

export async function getKbAnswer(sql: Sql, id: number): Promise<KbAnswer | null> {
  const [row] = await sql<Row[]>`select * from kb_answers where id = ${id}`
  return row ? toAnswer(row) : null
}

type Author = { id: number; name: string }

export async function createKbAnswer(sql: Sql, input: KbAnswerInput, opts: { gapId?: number | null; author: Author }): Promise<KbAnswer> {
  return sql.begin(async (tx) => {
    const gapId = opts.gapId && (await tx`select 1 from kb_gaps where id = ${opts.gapId}`).length ? opts.gapId : null
    const [row] = await tx<Row[]>`
      insert into kb_answers (question, variants, answer, gap_id, author_id, author_name)
      values (${input.question}, ${input.variants}, ${input.answer}, ${gapId}, ${opts.author.id || null}, ${opts.author.name})
      returning *`
    if (gapId) await tx`update kb_gaps set resolved = true, answer_id = ${row.id} where id = ${gapId}`
    return toAnswer(row)
  })
}

export async function updateKbAnswer(sql: Sql, id: number, patch: Partial<KbAnswerInput> & { enabled?: boolean }): Promise<KbAnswer | null> {
  const [row] = await sql<Row[]>`
    update kb_answers set
      question = coalesce(${patch.question ?? null}, question),
      answer = coalesce(${patch.answer ?? null}, answer),
      variants = coalesce(${patch.variants ?? null}::text[], variants),
      enabled = coalesce(${patch.enabled ?? null}::boolean, enabled),
      updated_at = now()
    where id = ${id}
    returning *`
  return row ? toAnswer(row) : null
}

/**
 * Закрыть другие нерешённые «Вопросы к Квасычу», на которые теперь отвечает этот ответ HR: одинаковые вопросы
 * разными словами не висят в списке. Сравнение — тем же индексом, которым отвечает Квасыч (перед вызовом его обновляют)
 */
export async function resolveAnsweredGaps(sql: Sql, answerId: number): Promise<number> {
  const open = await sql<{ id: string; question: string }[]>`select id, question from kb_gaps where not resolved order by id desc limit 1000`
  const ids = open.filter((g) => matchHrAnswer(g.question)?.id === answerId).map((g) => Number(g.id))
  if (!ids.length) return 0
  await sql`update kb_gaps set resolved = true, answer_id = ${answerId} where id = any(${ids})`
  return ids.length
}
