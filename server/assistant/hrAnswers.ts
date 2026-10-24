import { tokens } from './text'

// Ответы отдела персонала на «Вопросы к Квасычу» — маленький отдельный индекс.
// Квасыч проверяет его раньше основной базы знаний: ответ HR на вопрос, которого не было в данных, важнее догадки.
// Общий индекс базы знаний не трогаем: ответы HR живут в базе (таблица kb_answers) и меняются без перезапуска.
// Источник задаёт server/api/hr-kb.ts при создании — setHrAnswerSource(fn); без него индекс пуст.

export type HrAnswer = {
  id: number
  /** Вопрос, на который ответил HR, — обычно текст из «Вопросов к Квасычу» */
  question: string
  /** Другие формулировки того же вопроса — по ним тоже находим ответ */
  variants: string[]
  answer: string
}

type Source = () => Promise<HrAnswer[]>

/** Как часто перечитываем ответы, если их не обновили явно: несколько процессов сервера видят правки HR не позже этого срока */
const MAX_AGE_MS = 60_000

let source: Source | null = null
let list: HrAnswer[] = []
let loadedAt = 0
let loading: Promise<void> | null = null
let version = 0

type Entry = { answer: HrAnswer; phrasings: Set<string>[] }
let index: Entry[] = []

/** Вес слова: редкое в основной базе слово («парковка») важнее частого («работа»). Задаёт knowledge.ts */
let weight: (term: string) => number = () => 1

export function setTermWeight(fn: (term: string) => number) {
  weight = fn
}

function rebuild(next: HrAnswer[]) {
  list = next
  index = next.map((answer) => ({
    answer,
    phrasings: [answer.question, ...answer.variants].map((p) => new Set(tokens(p))).filter((s) => s.size > 0),
  }))
  version++
}

/** Откуда брать одобренные ответы. null — ответов HR нет (проверки без базы) */
export function setHrAnswerSource(fn: Source | null) {
  source = fn
  loadedAt = 0
  if (!fn) rebuild([])
}

/** Одна загрузка из источника. Загрузки идут по очереди: новая начинается после той, что уже читает базу */
function load(): Promise<void> {
  const from = source
  if (!from) return Promise.resolve()
  const before = loading
  const run: Promise<void> = (async () => {
    if (before) await before.catch(() => {})
    const next = await from()
    rebuild(next.filter((a) => a.answer.trim()))
    loadedAt = Date.now()
  })()
  loading = run
  void run
    .finally(() => {
      if (loading === run) loading = null
    })
    .catch(() => {})
  return run
}

/**
 * Перечитать ответы сейчас: после того как HR сохранил, выключил или поправил ответ. Всегда новое чтение — даже если
 * другое уже идёт: то могло начаться до сохранения
 */
export async function refreshHrAnswers(): Promise<void> {
  if (!source) return
  return load()
}

/** Перед ответом: если ответы давно не читали — перечитать. Ошибка базы не мешает ответить по основной базе знаний */
export async function ensureHrAnswers(maxAgeMs = MAX_AGE_MS): Promise<void> {
  if (!source || Date.now() - loadedAt < maxAgeMs) return
  await (loading ?? load()).catch(() => {
    // база недоступна — отвечаем по тому, что уже загружено
    loadedAt = Date.now()
  })
}

/** Для проверок без базы: подставить ответы напрямую */
export function setHrAnswers(next: HrAnswer[]) {
  source = null
  rebuild(next)
}

export const hrAnswerList = (): readonly HrAnswer[] => list

/** Меняется при каждой загрузке ответов: по нему сбрасываются кэш базы знаний и системного промпта */
export const hrAnswersVersion = () => version

const sum = (terms: Iterable<string>) => {
  let s = 0
  for (const t of terms) s += weight(t)
  return s
}

/**
 * Ответ HR на этот вопрос или null. Совпадение — по словам с весами: общие слова вопроса и формулировки HR должны
 * покрывать не меньше 60 % веса и того, и другого. «Парковка для сотрудников есть?» находит ответ на «есть ли парковка
 * для сотрудников», а «сколько платят сотрудникам» — нет
 */
export function matchHrAnswer(question: string): HrAnswer | null {
  if (!index.length) return null
  const asked = new Set(tokens(question))
  if (!asked.size) return null
  const askedWeight = sum(asked)
  let best: { answer: HrAnswer; score: number } | null = null
  for (const entry of index) {
    for (const p of entry.phrasings) {
      const common = [...asked].filter((t) => p.has(t))
      if (!common.length) continue
      const shared = sum(common)
      const cover = Math.min(shared / askedWeight, shared / sum(p))
      if (cover >= 0.6 && (!best || cover > best.score)) best = { answer: entry.answer, score: cover }
    }
  }
  return best?.answer ?? null
}
