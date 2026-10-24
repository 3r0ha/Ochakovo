import { FREE_PRACTICE_SCHEDULE, hasNightShifts, isPractice, type Vacancy } from '@shared/content/vacancies'

// Список вакансий без React: общее для раздела (срок, кто подходит) и быстрые фильтры.
// Общее печатаем один раз во вступлении раздела, в строке роли — только то, что у неё своё.
// Проверки — scripts/tests/w2-pages-chat-vacancies.test.ts.

/** Фразы требований: «Студенты … без опыта: на старте учит наставник. Подходит будущим технологам» → две фразы */
export const sentencesOf = (text: string) =>
  text
    .split(/\.\s+/)
    .map((s) => s.trim().replace(/\.$/, ''))
    .filter(Boolean)

/** Значение, которое повторяется больше чем у половины ролей раздела (и хотя бы у двух), иначе null */
function majority(values: string[]): string | null {
  const counts = new Map<string, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  for (const [v, n] of counts) if (n >= 2 && n > values.length / 2) return v
  return null
}

export type SectionFacts = {
  /** Срок, общий для раздела: «Март или апрель — июль или середина августа», «Круглый год» */
  period: string | null
  /** Фразы требований, общие для раздела: «Студенты колледжей и вузов с 18 лет, без опыта: на старте учит наставник» */
  requirements: string[]
}

/** Общее у ролей раздела — по данным вакансий: правки в панели учитываются сами */
export function sectionFacts(list: Vacancy[]): SectionFacts {
  const period = majority(list.map((v) => v.period))
  const all = [...new Set(list.flatMap((v) => sentencesOf(v.requirements)))]
  const requirements = all.filter((s) => {
    const n = list.filter((v) => sentencesOf(v.requirements).includes(s)).length
    return n >= 2 && n > list.length / 2
  })
  return { period, requirements }
}

/** Своё у роли: срок, если он не общий для раздела */
export const ownPeriod = (v: Vacancy, facts: SectionFacts) => (v.period === facts.period ? null : v.period)

/** Своё у роли: требования без общих фраз раздела. Пусто — строку «Кого ждём» не печатаем */
export const ownRequirements = (v: Vacancy, facts: SectionFacts) =>
  sentencesOf(v.requirements)
    .filter((s) => !facts.requirements.includes(s))
    .join('. ')

/** Требование опыта работы: «Опыт работы от года». «Без опыта» и «на старте учит наставник» — не требование */
const needsExperience = (v: Vacancy) => /опыт\s+работы|опыт\s+от|от\s+года|лет\s+опыта/i.test(v.requirements) && !/без\s+опыта/i.test(v.requirements)

export type FilterId = 'day' | 'noexp' | 'school' | 'year'

/**
 * Быстрые фильтры над списком — каждый по полю данных вакансии:
 * «Только дневные» — график без ночей или с выбором «только дневные» (у бесплатной практики график по договорённости — не в счёт);
 * «Без опыта» — в требованиях нет опыта работы; «Практика от вуза» — оплачиваемая и бесплатная практика (документы одни и те же);
 * «Круглый год» — срок вакансии «Круглый год»
 */
export const vacancyFilters: { id: FilterId; label: string; test: (v: Vacancy) => boolean }[] = [
  { id: 'day', label: 'Только дневные', test: (v) => v.schedule !== FREE_PRACTICE_SCHEDULE && (!hasNightShifts(v) || /только дневн/i.test(v.schedule)) },
  { id: 'noexp', label: 'Без опыта', test: (v) => !needsExperience(v) },
  { id: 'school', label: 'Практика от вуза', test: isPractice },
  { id: 'year', label: 'Круглый год', test: (v) => /круглый год/i.test(v.period) },
]

/** Подходит ли вакансия под все включённые фильтры */
export const passesFilters = (v: Vacancy, on: FilterId[]) => on.every((id) => vacancyFilters.find((f) => f.id === id)?.test(v) ?? true)

/** Фильтры, которые что-то меняют в этом списке: не пустые и не «все вакансии» — с числом подходящих */
export const usefulFilters = (list: Vacancy[]) =>
  vacancyFilters.map((f) => ({ ...f, count: list.filter(f.test).length })).filter((f) => f.count > 0 && f.count < list.length)

/**
 * Цепочка слов через тире не рвётся переносом: «день — ночь — отсыпной — выходной» целиком на одной строке.
 * Остальные пробелы остаются обычными
 */
export const glueChains = (text: string) => text.replace(/[\p{L}\d]+(?: — [\p{L}\d]+){2,}/gu, (m) => m.replace(/ /g, '\u00A0'))
