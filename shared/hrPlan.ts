import type { HrApplication } from './applications'
import { isPractice, vacancyById } from './content/vacancies'

// План найма: сколько людей нужно на вакансию в каждый месяц сезона и сколько уже нашли.
// Сезон N — с октября года N−1 по сентябрь года N (как «Заявки сезона» в панели).
// Прогресс месяца — кандидаты на эту вакансию, готовые работать в этот месяц и дошедшие до «К оформлению»
// (или уже вышедшие на смену). Кто готов в июне–августе, закрывает потребность каждого из трёх месяцев.
// Если HR назначил дату первой смены, человек закрывает только месяц этой смены: он выходит тогда, а не во все месяцы из заявки.

export type PlanEntry = { vacancyId: string; month: number; target: number }

export type PlanCell = { vacancyId: string; month: number; target: number; hired: number; started: number }

export const seasonOf = (at: Date | number) => {
  const d = new Date(new Date(at).getTime() + 3 * 3600e3)
  return d.getUTCMonth() >= 9 ? d.getUTCFullYear() + 1 : d.getUTCFullYear()
}

/** Границы сезона: октябрь предыдущего года — сентябрь года сезона включительно */
export const seasonRange = (season: number) => ({
  from: new Date(`${season - 1}-10-01T00:00:00+03:00`),
  to: new Date(`${season}-10-01T00:00:00+03:00`),
})

/** Месяцы, в которые обычно нанимают сезонников: март — сентябрь */
export const planMonths = [3, 4, 5, 6, 7, 8, 9]

const reached = (a: HrApplication, statuses: string[]) => statuses.includes(a.status) || a.reached.some((s) => statuses.includes(s))

/** Месяц по Москве для даты: 1–12 */
const mskMonth = (iso: string) => new Date(new Date(iso).getTime() + 3 * 3600e3).getUTCMonth() + 1

/** Какие месяцы плана закрывает человек: с датой первой смены — только её месяц, без даты — месяцы из заявки */
export const planMonthsOf = (a: Pick<HrApplication, 'months' | 'firstShiftAt'>) => (a.firstShiftAt ? [mskMonth(a.firstShiftAt)] : a.months)

export function planProgress(plan: PlanEntry[], apps: HrApplication[], season: number): PlanCell[] {
  const { from, to } = seasonRange(season)
  const inSeason = apps.filter((a) => !a.duplicateOf && new Date(a.createdAt) >= from && new Date(a.createdAt) < to)
  return plan.map((p) => {
    const matching = inSeason.filter((a) => a.vacancyId === p.vacancyId && planMonthsOf(a).includes(p.month))
    return {
      ...p,
      hired: matching.filter((a) => reached(a, ['hired', 'started'])).length,
      started: matching.filter((a) => reached(a, ['started'])).length,
    }
  })
}

/** Итог по плану: сколько нужно и сколько нашли (по месяцам — сумма, человек может закрывать несколько месяцев) */
export function planTotals(cells: PlanCell[]) {
  const target = cells.reduce((n, c) => n + c.target, 0)
  const hired = cells.reduce((n, c) => n + Math.min(c.hired, c.target), 0)
  const started = cells.reduce((n, c) => n + Math.min(c.started, c.target), 0)
  return { target, hired, started }
}

/** Сколько разных людей приняли и вывели на смену по вакансиям и месяцам плана — человек считается один раз */
export function planPeople(plan: PlanEntry[], apps: HrApplication[], season: number) {
  const { from, to } = seasonRange(season)
  const cells = new Set(plan.filter((p) => p.target > 0).map((p) => `${p.vacancyId}:${p.month}`))
  const inPlan = apps.filter(
    (a) => !a.duplicateOf && !a.anonymizedAt && new Date(a.createdAt) >= from && new Date(a.createdAt) < to && planMonthsOf(a).some((m) => cells.has(`${a.vacancyId}:${m}`)),
  )
  return { hired: inPlan.filter((a) => reached(a, ['hired', 'started'])).length, started: inPlan.filter((a) => reached(a, ['started'])).length }
}

// ── Практика от вуза: учебные заведения ──────────────────────────────────

/**
 * Сокращения вузов, которые встречаются в заявках: полное и короткое название — один вуз.
 * Список — по ярмаркам и демо-данным панели (shared/demo.ts); незнакомые названия сводятся по написанию
 */
const schoolAliases: [RegExp, string][] = [
  [/мгупп|университет пищевых производств/, 'МГУПП'],
  [/политех|политехнический университет/, 'Московский Политех'],
  [/рхту|менделеев/, 'РХТУ им. Менделеева'],
  [/мгту|бауман/, 'МГТУ им. Баумана'],
  [/рэу|плеханов/, 'РЭУ им. Плеханова'],
  [/мисис|институт стали/, 'НИТУ МИСИС'],
]

/** Название без различий в написании: регистр, «ё», кавычки, точки и лишние пробелы */
const plainSchool = (name: string) =>
  name
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"'„“”`.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Ключ учебного заведения для свода: «РХТУ», «рхту им. Д. И. Менделеева» и «Российский … Менделеева» — один ключ */
export function schoolKey(name: string): { key: string; title: string } {
  const plain = plainSchool(name)
  const alias = schoolAliases.find(([re]) => re.test(plain))
  return alias ? { key: alias[1].toLowerCase(), title: alias[1] } : { key: plain, title: name.trim().replace(/\s+/g, ' ') }
}

/** Кому нужна практика от вуза: отметка «Практика от вуза» или вакансия оплачиваемой или бесплатной практики */
export function needsPracticeContract(a: Pick<HrApplication, 'practiceSchool' | 'vacancyId' | 'format'>) {
  const v = vacancyById(a.vacancyId)
  return Boolean(a.practiceSchool) || (v ? isPractice(v) : false) || a.format === 'Оплачиваемая практика' || a.format === 'Бесплатная практика'
}

export type SchoolRow = {
  key: string
  /** Название для показа; null — учёба не указана */
  title: string | null
  /** Заявки этого заведения — по ним строка раскрывается */
  ids: string[]
  /** Месяцы всех заявок вместе, по возрастанию */
  months: number[]
}

/**
 * Свод для договоров о практике: учебное заведение → сколько человек → месяцы. Только заявки сезона с практикой
 * (needsPracticeContract), без отказов, дублей и обезличенных. «Учёба не указана» — отдельной строкой в конце
 */
export function schoolSummary(apps: HrApplication[], season: number): SchoolRow[] {
  const { from, to } = seasonRange(season)
  const rows = new Map<string, SchoolRow>()
  for (const a of apps) {
    if (a.duplicateOf || a.anonymizedAt || a.status === 'declined' || !needsPracticeContract(a)) continue
    const created = new Date(a.createdAt)
    if (created < from || created >= to) continue
    // Уже не учится — своя строка: договор с вузом ему не нужен, но HR должен это видеть
    const { key, title } = a.school?.trim() ? schoolKey(a.school) : a.notStudying ? { key: '~not-studying', title: 'Уже не учится' } : { key: '', title: '' }
    const row = rows.get(key) ?? { key, title: key ? title : null, ids: [], months: [] }
    row.ids.push(a.id)
    // Месяцы практики — из заявки; первая смена, назначенная HR, только если месяцев нет
    row.months = [...new Set([...row.months, ...(a.months.length ? a.months : planMonthsOf(a))])].sort((x, y) => x - y)
    rows.set(key, row)
  }
  return [...rows.values()].sort((x, y) => (x.key === '' ? 1 : y.key === '' ? -1 : y.ids.length - x.ids.length || x.title!.localeCompare(y.title!, 'ru')))
}
