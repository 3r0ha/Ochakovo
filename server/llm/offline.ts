import { responsePromise } from '@shared/candidateStatus'
import { contacts, phonebook, phoneLine, steps } from '@shared/content/content'
import { faqAnswer, type FaqId } from '@shared/content/faq'
import { canteen, dorm, handbookText, PASS_FINE, PAY_DAYS, practiceDocs, SEASON, TRAINING_CENTER_ROOM, workPrinciples } from '@shared/content/handbook'
import { paidPracticeInfo } from '@shared/content/practice'
import { PLANT_BOTTLES_PER_HOUR } from '@shared/content/production'
import {
  asksPortfolio,
  hasNightShifts,
  maxEntryPay,
  minMonthlyPay,
  needsMedBook,
  netPay,
  scheduleSummary,
  shiftPay,
  vacancies,
  vacanciesByPay,
  vacancyById,
  type Vacancy,
} from '@shared/content/vacancies'
import { matchHrAnswer } from '../assistant/hrAnswers'
import { confident, search, tokens } from '../assistant/knowledge'
import { flexibleTerm, monthsText, periodMonths, schedulePhrase, scheduleText, shortPay, vacancyBrief } from '../assistant/tools'
import { gapTopic, NO_ANSWER_TOPICS, TOPIC } from '../assistant/topics'
import type { DepartmentId } from '@shared/content/departments'
import type { ChatRequest, ChatResult, LlmFunctionCall, LlmMessage, LlmProvider } from './provider'
import { normalize, splitParts, stripLead, type Lead } from './speech'

// Офлайн-режим: работает без ключа GigaChat. Ведёт себя как модель — по правилам выбирает функции
// и собирает ответ из их результатов. Поэтому цикл помощника, функции и проверки те же, что с GigaChat.
// Правила ответа: первая фраза — прямой ответ, в первом абзаце не больше двух предложений,
// в списке вакансий не больше трёх строк и «ещё N», «Да» — только на вопрос «да или нет».

type FnResult = { name: string; result: Record<string, unknown>; summary: string }
type Plan = { calls: LlmFunctionCall[]; compose: (results: FnResult[]) => string } | { text: string }
/**
 * group — тема ответа: по ней склеиваем ответы на вопрос из нескольких частей и не повторяем одну тему дважды.
 * «семья:вариант» — уточнение темы: «night:pay» включает ответ «night», поэтому «night» рядом с ним не нужен
 */
type Grouped = Plan & { group: string }

const contactLine = `${contacts.email}, ${contacts.phone} (${contacts.phoneNote})`
const whatsappText = contacts.whatsapp.replace(/^7(\d{3})(\d{3})(\d{2})(\d{2})$/, '+7 $1 $2-$3-$4')
/** «ул. Рябиновая, 44» — для фразы «завод в Москве на …» */
const street = contacts.address.replace(/^Москва,\s*/, '')
const call = (name: string, args: Record<string, unknown> = {}): LlmFunctionCall => ({ name, arguments: args })
/** «HR позвонит» остаётся с заглавными: аббревиатуру в начале фразы не трогаем */
const lowerFirst = (s: string) => (/^[A-ZА-ЯЁ]{2}/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1))
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const summaryOf = (results: FnResult[], name: string) => results.find((r) => r.name === name)?.summary ?? ''
const rub = (n: number) => `${n.toLocaleString('ru-RU')} ₽`
const plural = (n: number, one: string, few: string, many: string) =>
  n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many

/** «Да. …» и «Да, …» в начале ответа из FAQ — только если спросили «да или нет» */
const dropYes = (text: string) => capitalize(text.replace(/^Да[.,]\s*/, ''))
const faqText = (id: FaqId, yesNo: boolean) => {
  const a = faqAnswer(id)
  return yesNo ? a : dropYes(a)
}

/** О каком месте спрашивают: подпись для первой фразы, отдел для поиска и какие вакансии считать по теме */
type Place = { lead: string; department?: DepartmentId; title: RegExp }
const PLACES: [RegExp, Place][] = [
  [/оператор/, { lead: 'Операторам', title: /оператор/i }],
  [/склад|отгруз|кладовщ/, { lead: 'На складе', department: 'logistics', title: /склад|кладовщик/i }],
  [/логист|поставк/, { lead: 'В логистике', department: 'logistics', title: /склад|кладовщик/i }],
  [/лаборат|лаборант|анализ|микробиолог/, { lead: 'В лаборатории', department: 'quality', title: /лаборант|лаборатори/i }],
  [/магаз/, { lead: 'В фирменном магазине', title: /магазин/i }],
  [/лини|розлив|производств|цех/, { lead: 'На производстве', department: 'production', title: /розлива|технологического/i }],
  [/механ|наладч|кипиа|автомат|инженер/, { lead: 'В инженерной службе', department: 'engineering', title: /инженер/i }],
  [/офис|маркетинг|(?<![a-z])hr(?![a-z])|аналит|данн/, { lead: 'В офисе', department: 'office', title: /офис/i }],
]
const placeOf = (t: string) => PLACES.find(([re]) => re.test(t))?.[1] ?? null

type VacancyData = {
  id: string
  title: string
  schedule: string
  pay: { from: number; to: number | null; net_from: number; estimate: boolean } | null
}
const vacanciesOf = (r: FnResult[]) => (r.find((x) => x.name === 'search_vacancies')?.result.vacancies ?? []) as VacancyData[]

/** «56 000–70 000 ₽» по суммам из источников; если их нет — ориентиры с пометкой */
function payRange(list: VacancyData[]): string | null {
  const real = list.filter((v) => v.pay && !v.pay.estimate)
  const pool = real.length ? real : list.filter((v) => v.pay)
  if (!pool.length) return null
  const lo = Math.min(...pool.map((v) => v.pay!.from))
  const hi = Math.max(...pool.map((v) => v.pay!.to ?? v.pay!.from))
  const note = real.length ? '' : ' (ориентир)'
  return lo === hi ? `от ${rub(lo)}${note}` : `${lo.toLocaleString('ru-RU')}–${rub(hi)}${note}`
}

/** Где именно платят — для ответа «сколько платят без опыта» */
const placeOfVacancy: Record<string, string> = {
  'store-worker': 'в фирменном магазине',
  'bottling-operator': 'в цехе розлива',
  'fermentation-assistant': 'в технологическом цехе',
  'lab-chemist': 'в лаборатории',
  'warehouse-operator': 'оператором склада',
  storekeeper: 'кладовщиком',
  merchandiser: 'мерчандайзером',
}

/** Какую вакансию назвали: «у кладовщика», «в магазине». Просто «оператор» не считается — их три */
const NAMED: [RegExp, string][] = [
  [/магаз|продав/, 'store-worker'],
  [/кладовщик/, 'storekeeper'],
  // «На складе» — две роли практики, это место; вакансия — только «оператор склада»
  [/оператор[а-я]*\s+склад|склад[а-я]*\s+оператор/, 'warehouse-operator'],
  [/конвейер|оператор[а-я]* лини|на лини[июя](?![а-я])|розлив/, 'bottling-operator'],
  [/лаборант|химическ/, 'lab-chemist'],
  [/микробиолог|проб[ыу]? на контрол/, 'microbiologist-intern'],
  [/аппаратчик|брожени|технологическ[а-я]* цех|цех[а-я]* варк|варочн/, 'fermentation-assistant'],
  [/автоматизац|оцифровк|с инженер|инженерн[а-я]*\s+практик|практик[а-я]*\s+(с|у)\s+инженер/, 'automation-intern'],
  [/мерчандайзер|мерчендайзер|мерч(?![а-я])/, 'merchandiser'],
  [/маркетинг|маркетолог|smm|маскот|электронн[а-я]* курс/, 'marketing-intern'],
  [/планировани[ея] поставок|логист|комплектовани/, 'logistics-planner'],
]
const namedVacancy = (t: string) => NAMED.find(([re]) => re.test(t))?.[1]

/** Места, вакансии и форматы — чтобы понять, есть ли в вопросе что-то кроме них: «а на складе?» — только место */
const PLACE_WORDS =
  /практик[а-я]*|стажировк[а-я]*|оператор[а-я]*|склад[а-я]*|кладовщик[а-я]*|отгруз[а-я]*|логист[а-я]*|поставк[а-я]*|лаборат[а-я]*|лаборант[а-я]*|микробиолог[а-я]*|магазин[а-я]*|лини[а-я]*|розлив[а-я]*|производств[а-я]*|цех[а-я]*|механик[а-я]*|наладчик[а-я]*|кипиа|инженер[а-я]*|офис[а-я]*|маркетинг[а-я]*|экскурсовод[а-я]*|продав[а-я]*|аппаратчик[а-я]*|брожени[а-я]*|мерч[а-я]*|конвейер[а-я]*|аналитик[а-я]*/g

/** Где работает: «кладовщиком», «в цехе розлива» — для фразы «за лето кладовщиком выйдет» */
const asRole = (id: string) => placeOfVacancy[id] ?? `на позиции «${vacancyById(id)?.title ?? id}»`

/** Срок для расчёта: «за лето» — июнь — август, «за 2 месяца», «за сезон» — весь срок вакансии */
function totalSpan(t: string, v: Vacancy): { months: number; label: string } | null {
  const n = /за\s+(\d|один|одн[уа]|два|две|три|четыре|пять|шесть|семь)\s+месяц/.exec(t)?.[1]
  if (n) {
    const count = Number(n) || ({ один: 1, одну: 1, одна: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7 } as Record<string, number>)[n]
    return { months: count, label: `За ${countPhrase(String(count))}` }
  }
  // Оплачиваемая практика — с начала марта или апреля до конца июля или середины августа («Описание практики»):
  // весь срок — самое большее с марта до конца июля, 5 месяцев; летом в неё точно входят июнь и июль
  const practice = v.format === 'Оплачиваемая практика'
  if (/за (весь |всю )?(сезон|практику|срок)/.test(t)) {
    if (practice) return { months: 5, label: 'За всю практику с начала марта до конца июля (5 месяцев)' }
    const span = periodMonths(v.period)
    return { months: span.length, label: `За весь сезон (${monthsText(span)}, ${countPhrase(String(span.length))})` }
  }
  if (/за лето|за летние|за каникулы/.test(t)) {
    if (practice) return { months: 2, label: 'За июнь и июль (практика идёт до конца июля или середины августа)' }
    const summer = [6, 7, 8].filter((m) => periodMonths(v.period).includes(m))
    if (!summer.length) return null
    return { months: summer.length, label: summer.length === 3 ? 'За лето (с июня по август, 3 месяца)' : `За ${monthsText(summer)}` }
  }
  return null
}

/** «3 дня в неделю», «по выходным», «неполный день» — графика под такие запросы в вакансиях нет */
const PART_TIME =
  /((\d|один|два|три|четыре|пару|несколько)\s*(дн[яейь]|раз[а]?|смен[аыу]?)\s*в\s*неделю|неполн[а-я]*\s*(день|занятост|ставк|график)|частичн[а-я]*\s*занятост|по выходным|только\s*(в\s*)?выходные|на выходных|в выходные|по субботам|по воскресеньям|по вечерам|полставки|свободн[а-я]*\s*график|гибк[а-я]*\s*график)/

/** Что на самом деле в графике: «2/2, дневные смены по 12 часов — это около 15 смен в месяц» */
function scheduleTruth(v: Vacancy) {
  const s = schedulePhrase(v.schedule)
  if (/2\/2/.test(v.schedule)) return `${s}, это около 15 смен в месяц`
  if (/5\/2/.test(v.schedule)) return `${s}, пять дней в неделю`
  return s
}

function partTimeAnswer(t: string, vacancyId: string | undefined): string {
  const asked = PART_TIME.exec(t)?.[0].replace(/\s+/g, ' ') ?? 'неполный'
  const weekend = /выходн|суббот|воскрес/.test(asked)
  const graph = /график/.test(asked) ? asked : `«${asked}»`
  const v = vacancyId ? vacancyById(vacancyId) : undefined
  const hr = `Можно ли так работать, решает отдел персонала: ${contactLine}.`
  if (v) return `${v.title}: график ${scheduleTruth(v)}. ${weekend ? 'Работы только по выходным' : `Графика ${graph}`} в вакансии нет.\n\n${hr}`
  return `${weekend ? 'Работы только по выходным' : `Графика ${graph}`} в вакансиях нет. ${hr}\n\n${scheduleSummary.text}`
}

const titles = (list: Vacancy[]) => listOr(list.map((v) => `«${v.title}»`), 'и')
const listOr = (items: string[], word: 'и' | 'или') => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} ${word} ${items.at(-1)}`)

/** Ночные смены — по графикам вакансий: где бывают, где можно только дневные. place — «на складе»: только его вакансии */
function nightAnswer(place: Place | null = null, yesNo = false): string {
  const here = place ? vacancies.filter((v) => place.title.test(v.title) && v.format !== 'Бесплатная практика') : []
  if (here.length) {
    const night = here.filter(hasNightShifts)
    if (!night.length) return `${place!.lead} ночных смен нет: у позиций ${titles(here)} только дневные смены.`
    const choice = night.filter((v) => /только дневн/i.test(v.schedule))
    const dayOnly = !choice.length ? '' : choice.length === night.length ? ' Есть и график только с дневными сменами.' : ` Только дневные смены бывают у позиций ${titles(choice)}.`
    return (
      `${yesNo ? `Да, ${lowerFirst(place!.lead)}` : place!.lead} ночные смены бывают у позиций ${titles(night)}: ночная смена идёт с 20:00 до 8:00 и оплачивается по повышенному коэффициенту.${dayOnly}\n\n` +
      'График составляет руководитель. В заявке на сайте можно отметить, какие смены подходят: только дневные, только ночные или любые.'
    )
  }
  const night = vacancies.filter(hasNightShifts)
  const dayOnly = vacancies.filter((v) => v.pay && !hasNightShifts(v))
  const choice = night.filter((v) => /только дневн/i.test(v.schedule))
  return (
    `Ночные смены бывают у позиций ${titles(night)}: ночная смена идёт с 20:00 до 8:00 и оплачивается по повышенному коэффициенту. ` +
    `${choice.length ? `График только с дневными сменами бывает у позиций ${titles(choice)}. ` : ''}Только днём работают на позициях ${titles(dayOnly)}.\n\n` +
    'График составляет руководитель. В заявке на сайте можно отметить, какие смены подходят: только дневные, только ночные или любые.'
  )
}

/** Медкнижка — по тому же правилу, что в форме заявки на сайте. Общий ответ — текст из «Вопросов» на сайте */
function medBookAnswer(vacancyId: string | undefined): string {
  const v = vacancyId ? vacancyById(vacancyId) : undefined
  const later = 'Если медкнижки нет, откликнуться всё равно можно: в заявке на сайте есть вариант «Оформлю до выхода», а где её сделать, подскажет HR.'
  if (v && !needsMedBook(v)) return `Для позиции «${v.title}» медкнижку в заявке не спрашивают, точно скажут на собеседовании.`
  if (v) return `Для позиции «${v.title}» нужна личная медицинская книжка: это пищевое производство. ${later}`
  const general =
    faqAnswer('medbook') ||
    `Нужна, если работа рядом с продуктом: это пищевое производство. Для позиций ${titles(vacancies.filter((x) => !needsMedBook(x)))} её в заявке не спрашивают.`
  return `${general}\n\nВ заявке на сайте для этого есть вариант «Оформлю до выхода».`
}

/** Портфолио: одной фразой, где оставить ссылку и нужно ли оно. Офисные вакансии — кнопками под ответом */
function portfolioAnswer(t: string): string {
  if (/нужн|надо|обязательн/.test(t) && !/куда|где|как/.test(t)) {
    return 'Не обязательно. Ссылку на работы (GitHub, Behance или папку на диске) можно оставить в заявке на практику в офисе, а можно пропустить.'
  }
  return 'Ссылку на портфолио (GitHub, Behance или папку на диске) оставь в заявке на практику в офисе: на сайте в поле «Ссылка на портфолио», в чате на шаге после выбора вакансии.'
}

/** «Кладовщику», «В фирменном магазине» — начало фразы про одну вакансию */
const leadFor: Record<string, string> = {
  'store-worker': 'В фирменном магазине',
  'bottling-operator': 'Оператору линии розлива',
  'fermentation-assistant': 'Оператору технологического цеха',
  'lab-chemist': 'Лаборанту',
  'warehouse-operator': 'Оператору склада',
  storekeeper: 'Кладовщику',
  merchandiser: 'Мерчандайзеру',
}

/** Вакансии по теме вопроса: «на складе» — только склад, и в первой фразе, и в списке. Если по теме ничего — все найденные */
function onTopic(r: FnResult[], place: Place | null): { focus: VacancyData[]; list: string } {
  const all = vacanciesOf(r)
  const summary = summaryOf(r, 'search_vacancies')
  const focus = place ? all.filter((v) => place.title.test(v.title)) : []
  if (!focus.length) return { focus: all, list: summary }
  // Пункты по теме — те же, что в сводке поиска (vacancyBrief), только для вакансий в фокусе
  const items = focus.flatMap((v) => {
    const vacancy = vacancyById(v.id)
    return vacancy ? [vacancyBrief(vacancy)] : []
  })
  return { focus, list: items.length ? items.join('\n') : summary }
}

/**
 * Месяцы из текста: «летом» — июнь–август, «с марта по сентябрь» — весь сезон, названия месяцев.
 * «После лета», «до лета» — не лето: «можно остаться после лета?» спрашивает об осени
 */
function monthsFrom(text: string): number[] {
  const t = text.replace(/(после|до|кроме|не)\s+(лета|летом|летних|каникул)/g, ' ')
  if (/весь сезон|с марта по сентябр|март[а-я]* по сентябр/.test(t)) return [3, 4, 5, 6, 7, 8, 9]
  const names: [RegExp, number][] = [
    [/март/, 3], [/апрел/, 4], [/(?<![а-я])ма[йя](?![а-я])/, 5], [/июн/, 6], [/июл/, 7], [/август/, 8], [/сентябр/, 9],
  ]
  const named = names.filter(([re]) => re.test(t)).map(([, m]) => m)
  if (named.length >= 2) {
    const out: number[] = []
    for (let m = Math.min(...named); m <= Math.max(...named); m++) out.push(m)
    return out
  }
  if (named.length === 1) return named
  if (/лет[оа]м?(?![а-я])|летн|на каникул/.test(t)) return [6, 7, 8]
  return []
}

/** Месяцы, когда человек занят: «в июне практика», «июнь — сессия» */
const BUSY = /(практик|сесси|занят|экзамен|диплом|учеб|уезжа|не могу|нет времени)/
const busyNoun: [RegExp, string][] = [[/практик/, 'практикой'], [/сесси/, 'сессией'], [/экзамен/, 'экзаменами'], [/диплом/, 'дипломом'], [/учеб/, 'учёбой']]
const prepositional: Record<number, string> = { 3: 'марте', 4: 'апреле', 5: 'мае', 6: 'июне', 7: 'июле', 8: 'августе', 9: 'сентябре' }

/** Какие месяцы человек хочет работать и какие у него заняты: «только июль и август, в июне практика» → [7, 8] и [6] */
function monthsWanted(t: string): { wanted: number[]; busy: number[]; busyWhat: string | null } {
  const wanted = new Set<number>()
  const busy = new Set<number>()
  let busyWhat: string | null = null
  for (const clause of t.split(/[,.;?]|\s(?:но|а)\s/)) {
    const months = monthsFrom(clause)
    if (!months.length) continue
    if (BUSY.test(clause) && !/(можно|могу|свобод|только|хочу)/.test(clause)) {
      months.forEach((m) => busy.add(m))
      busyWhat ??= busyNoun.find(([re]) => re.test(clause))?.[1] ?? null
    } else months.forEach((m) => wanted.add(m))
  }
  return { wanted: [...wanted].filter((m) => !busy.has(m)).sort((a, b) => a - b), busy: [...busy].sort((a, b) => a - b), busyWhat }
}

/** «учусь на технолога» → «на технолога» (для фразы) и «технолог» (для подбора) */
function studyFrom(t: string): string | undefined {
  // «Студент» без направления — не учёба: «работа для студентов есть?» не про специальность «есть»
  const m = /(?:учусь|обучаюсь|специальност[ья]|по специальности|выпускни[кц][а-я]*)\s+((?:на|в|по)\s+)?([а-яёa-z-]+(?:\s+[а-яёa-z-]+)?)/i.exec(t)
  if (m) return `${m[1] ?? ''}${m[2]}`.trim()
  // «я на маркетинге», «я маркетолог, хочу стажировку»
  const field = /(?:^|\s)я\s+(?:на\s+)?(маркетинг[а-я]*|маркетолог|smm|пиар[а-я]*|журналист[а-я]*|дизайн[а-я]*|психолог[а-я]*|истори[а-я]*|технолог[а-я]*|хими[а-я]*|биолог[а-я]*|механик[а-я]*|инженер[а-я]*|электрик[а-я]*|логист[а-я]*|экономи[а-я]*|программист[а-я]*|аналитик[а-я]*|айтишник)/.exec(t)
  return field ? (/^(маркетинг|пиар|дизайн|журналист)/.test(field[1]) && /(?:^|\s)я\s+на\s/.test(t) ? `на ${field[1]}` : field[1]) : undefined
}

// Граница начала слова: «бесплатно» — не вопрос про зарплату
const MONEY = /(?<![а-я])(плат|зарплат|зарабат|заработ|деньг|оплат|получа|ставк|оклад)|на руки|чистыми/
/** Спрашивают, сколько останется после налога — эту сумму называем первой */
const NET = /на руки|чистыми|после налог|без налог/

const genitive: Record<number, string> = { 3: 'марта', 4: 'апреля', 5: 'мая', 6: 'июня', 7: 'июля', 8: 'августа', 9: 'сентября' }

/** «2», «два», «пару» → «2 месяца» */
function countPhrase(raw: string) {
  const n = /^\d+$/.test(raw) ? Number(raw) : ({ один: 1, одну: 1, одна: 1, два: 2, две: 2, три: 3, пару: 2, пара: 2 } as Record<string, number>)[raw] ?? 2
  return `${n} ${n === 1 ? 'месяц' : n < 5 ? 'месяца' : 'месяцев'}`
}

/** [6,7,8] → «на лето», [7,8] → «на июль и август», [5,6,7] → «с мая по июль» */
function whenPhrase(months: number[]) {
  if (months.join() === '6,7,8') return 'на лето'
  if (months.length >= 3) return `с ${genitive[months[0]]} по ${monthsText([months.at(-1)!])}`
  return `на ${monthsText(months)}`
}

/** Месяцы начала срока: «С марта или апреля до июля или середины августа» и «Март или апрель — июль» → [3, 4] */
const monthsOfStart = (period: string) => {
  const head = period.split(/\s+[—–-]\s+|\s+до\s+/)[0]
  const found = (head.match(/[а-яё]+/gi) ?? []).map((w) => periodMonths(w)).filter((m) => m.length === 1).map((m) => m[0])
  return found.length ? found : periodMonths(period).slice(0, 1)
}

/**
 * Ответ про срок к тексту из «Вопросов» (summer-only): какие вакансии укладываются в названные месяцы и пересекается ли
 * практика с занятостью человека. Сроки оплачиваемой практики — «Описание практики», бесплатной — по договорённости.
 * Срок оплачиваемой практики под месяцы человека не подгоняем: его обсуждают на собеседовании, об этом говорит текст из «Вопросов».
 * named — месяцы названы словами; иначе назван только срок («на 2 месяца»)
 */
function periodAnswer(months: number[], when: string, busy: number[], busyWhat: string | null, named: boolean): string {
  const span = (v: Vacancy) => periodMonths(v.period)
  // Срок «по договорённости» и «круглый год» — без месяцев: такие вакансии не «ровно в срок», о них уже сказал текст из «Вопросов»
  const dated = (v: Vacancy) => /март|апрел|ма[йя]|июн|июл|август|сентябр/i.test(v.period)
  const inside = vacancies.filter((v) => dated(v) && !flexibleTerm(v) && span(v).every((m) => months.includes(m)) && !span(v).some((m) => busy.includes(m)))
  const parts: string[] = []
  if (inside.length) {
    parts.push(
      named
        ? `Ровно ${when} подходят:\n${inside.map((v) => vacancyBrief(v, false)).join('\n')}`
        : `Подходят по сроку:\n${inside.map((v) => vacancyBrief(v)).join('\n')}`,
    )
  } else if (busy.length && busyWhat) {
    // «В июне сессия» — оплачиваемая практика её захватывает: говорим, что сессию можно сдать без пропуска смен
    const later = vacancies.filter((v) => dated(v) && v.format === 'Оплачиваемая практика' && busy.some((m) => span(v).includes(m)))
    // «Март или апрель — …»: начало — оба месяца из названия срока
    const starts = [...new Set(later.flatMap((v) => monthsOfStart(v.period)))].sort((a, b) => a - b).map((m) => prepositional[m])
    if (starts.length) {
      const startsText = starts.length > 1 ? `${starts.slice(0, -1).join(', ')} или ${starts.at(-1)}` : starts[0]
      parts.push(
        `Оплачиваемая практика начинается в ${startsText}, поэтому пересекается с ${busyWhat} в ${busy.map((m) => prepositional[m]).join(' и ')}. ` +
          'О зачётах и экзаменах предупреждают руководителя заранее, и смены на это время не ставят.',
      )
    }
  }
  return parts.join('\n\n')
}

/** Сравнение с другой работой: только факты завода, о чужих зарплатах не судим */
function comparison(t: string): string {
  const other = /кофейн|бариста/.test(t) ? 'в кофейне' : /курьер/.test(t) ? 'курьером' : /официант|кафе|ресторан/.test(t) ? 'в кафе' : 'там'
  return (
    `На заводе официальный договор по ТК РФ и зарплата без опыта от ${rub(minMonthlyPay)} в месяц, оператором линии розлива от ${rub(maxEntryPay)}.\n` +
    '• Зарплата приходит два раза в месяц, 12-го и 27-го, ночные смены оплачивают по повышенному коэффициенту.\n' +
    `• Половину стоимости обеда оплачивает компания, койко-место в общежитии для студентов стоит ${rub(dorm.priceStudent)}.\n` +
    '• На практику берут без опыта и резюме, к каждому новичку прикрепляют наставника.\n\n' +
    `Что учесть: смены по 12 часов, бывают ночные. Сколько платят ${other}, у меня данных нет, сравни с конкретной вакансией.`
  )
}

/** Слова, по которым понятно, что вопрос про работу: такой вопрос без ответа — в отдел персонала, остальное — мимо темы */
const WORK =
  /(работ|смен|ваканс|зарплат|оплат|завод|цех|лини[яиюей]|склад|магазин|общаг|общежит|форм[аеуы](?![а-я])|одежд|обув|обед|столов|питани|медкомисс|медкнижк|справк|документ|паспорт|снилс|договор|трудов|оформ|отпуск|больнич|налог|практик|стажир|учеб|сесси|диплом|(?<![a-z])hr(?![a-z])|кадр|персонал|собеседов|начальник|наставник|обучени|инструктаж|график|выходн|перерыв|переработ|сверхуроч|преми|аванс|пропуск|раздевал|душ(?![а-я])|парковк|производств|экскурс|увольн|уволи|уйти раньше|испытательн|возраст|студент|опыт|резюме|заявк|отклик|бригад|мастер|офис|отгул|дресс|скидк|сотрудник|коллег|корпоратив|льгот|бонус|тату|пирсинг|внешн|прописк|регистрац|опозд|квас|тяжел|нагрузк|телефон|сидеть|развод|отзыв|развоз|возьм|берут|штат|карьер|перспектив|удален|дневник|вуз|колледж)/

/** Слово узнают правила офлайн-режима — опечатку в нём не ищем */
const knownWord = (w: string) => WORK.test(w) || MONEY.test(w) || PLACES.some(([re]) => re.test(w)) || NAMED.some(([re]) => re.test(w))
const norm = (text: string) => normalize(text, knownWord)

/** Что значат графики: 2/2 и «день-ночь-отсыпной-выходной» */
const SCHEDULE_TERMS =
  'График 2/2 значит два дня работы и два дня отдыха. «День-ночь-отсыпной-выходной» значит дневная смена, ночная, день на сон и выходной. Смены по 12 часов.'

const OFF_TOPIC_TEXT = 'Тут не подскажу. Я рассказываю про практику и работу на заводе: вакансии, зарплаты, смены, общежитие. Показать вакансии?'
const CALC = /(сколько|скольк).*(заработа|выйдет|получ)/

/** Вопросительные слова: если их нет, а знак вопроса есть — вопрос «да или нет» */
const INTERROGATIVE =
  /(?<![а-я])(сколько|где|как|когда|какой|какая|какое|какие|каким|какую|каких|что|чем|чего|кто|кого|почему|зачем|куда|откуда|чей|чья|насколько)(?![а-я])/

/** «Можно…», «есть…», «больничный есть?», «зп белая?» — вопрос «да или нет»: ответ может начаться с «Да» */
function isYesNo(t: string): boolean {
  return (
    /^(а\s+|и\s+)?(можно|могу|получится|реально|есть|бывает|нужен|нужна|нужно|нужны|берут|возьмут|правда|будет|дают|платят|разрешают|обязательно)(?![а-я])/.test(t) ||
    (/\s(есть|дают|выдают|бывает|платят|берут|возьмут|можно|будет|оплачивают|оплачивается|оплачиваются|разрешают)\s*\??$/.test(t) && !INTERROGATIVE.test(t)) ||
    (t.includes('?') && !INTERROGATIVE.test(t))
  )
}

/** Возраст назван и подходит: «мне 18» — добавляем короткое подтверждение */
const ADULT = /(?<![а-я0-9])мне\s*(1[89]|[2-9]\d)(?!\d)/
/** Возраст числом: «мне 17», «17 лет, возьмут?» */
function ageOf(t: string): number | null {
  const m = /(?<![а-я0-9])(?:мне|исполнилось|исполнится|будет|возраст)\s*:?\s*(\d{1,2})(?!\d)/.exec(t) ?? /^(\d{1,2})\s*(?:лет|год)(?![а-я])/.exec(t)
  return m ? Number(m[1]) : null
}

// ── Вопрос кейса: практика от вуза, работа после сезона, первая смена ───────

/** Бумаги практики: дневник, договор с вузом, преддипломная — ответ из «Вопросов» на сайте и запись темы для HR */
const PRACTICE_PAPERS =
  /дневник|характеристик|приказ[а-я]*\s+(о|на|по)\s+практик|(документ|бумаг)[а-я]*\s+(для|по|на|о)\s+практик|практик[а-я]*\s+(документ|бумаг)|договор[а-я]*\s+(с\s+)?(вуз|колледж|институт|техникум|учебн)|преддиплом|(учебн|производствен|преддипломн|ознакомительн|технологическ)[а-я]*\s+практик|практик[а-я]*\s+(от|для|из|по линии)\s+(вуз|колледж|институт|техникум|учеб)|(пройти|проходить|прохожу|оформить|оформляете|принимаете на|берете на|возьмете на)\s+(у вас\s+)?практик|направлени[ея]\s+на\s+практик|отч[её]т[а-я]*\s+по\s+практик|практик[^?]*(засчита|зачт)|(засчита|зачт)[^?]*практик/

/** Работа после сезона: штат, постоянная работа, карьера. «Остаться в общаге» — не сюда */
const AFTER_SEASON =
  /(?<![а-я])штат(?![а-я])|в штат|штатн|постоянн[а-я]*\s+(работ|основ|договор|мест|сотрудник)|на постоянн|карьер|(?<![а-я])рост(?![а-я])|роста(?![а-я])|перспектив|(остать?ся|останусь|оставят)(?!\s+(в|на)\s+(общ|ноч))|после (сезона|окончания сезона)|продолжить работ|работать дальше|круглый год|на зиму|осенью работать|работать осенью/

const FIRST_SHIFT =
  /перв(ая|ую|ой|ый|ые|ого)\s+(смен|рабоч|день|дни|недел)|в первый день|как проходит (смена|рабочий день|день)|как (выглядит|устроен[а]?) (смена|рабочий день)|что (будет|делать|ждет) (на|в) (смене|первый)/
const START_WHEN =
  /когда (можно |нужно |надо )?(выйти|выходить|начать|приступить|начинать)|с какого (числа|месяца)|как скоро (можно )?(выйти|начать)|когда (выход|начало работы)/

/** Уйти раньше срока — правила ТК из «Вопросов» на сайте */
const QUIT =
  /уволи|увольн|уйти\s+(раньше|досрочно|пораньше|до конца|не доработав)|уйти\s+в\s+(март|апрел|ма[йе]|июн|июл|август|сентябр)|раньше (срока|конца)|(бросить|кинуть) работу|если (не понравится|надоест)/
/** «Обязательно весь сезон?» — срок практики и «напиши в заявке» */
const WHOLE_SEASON = /(обязательно|нужно|надо)\s+(работать\s+)?(весь|до конца)\s+сезон|только (на )?весь сезон|не весь сезон|целый сезон обязательно/

const REMOTE = /удаленн|удаленно|из дома|дистанц|онлайн|гибрид/
const SHIFT_LEN =
  /(сколько|скольк)\s+(длится|идет|по времени)\s+(смен|рабоч|день)|сколько\s+часов|длин[аыу]\s+смен|смен[аы]?\s+(сколько|по сколько)|по сколько часов|часов в (день|смену|сутки)|(во сколько|когда)\s+(начин|заканчив|конча)|какой рабочий день|рабочий день сколько/
const SHIFT_PAY = /(в|за)\s+час(?![а-я])|почасов|за\s+(одну\s+)?смен[уы](?![а-я])|за\s+(один\s+)?(рабочий\s+)?день(?![а-я])/
const OFFICIAL =
  /(зарплат[а-я]*)\s+(бел|сер|черн|официальн)|(бел|сер|черн)[а-я]*\s+зарплат|официальн|в конверте|по трудов|трудов(ой|ым|ого)\s+договор|запис[ьи]\s+в\s+трудов|по тк(?![а-я])/
const DMS = /(?<![а-я])дмс|медстрах|медицинск[а-я]*\s+страхов|страховк|(?<![а-я])полис/
const LOAD = /тяжел|нагрузк|физическ|устаешь|устают|выматыва|на ногах|сложн[ао]\s+(ли\s+)?работ|легк(ая|ой)\s+работ|таскать|поднимать/
const SCAM = /развод(?![а-я]*\s+(мост|пив))|развели|мошенн|обман|кидал|лохотрон|фейк|(?<![а-я])скам/
const SCALE = /(сколько|скольк)[^?]*(бутыл|продукци|литр)|бутыл[а-я]*\s+в\s+час|мощност|масштаб|объем производств/

/** Должности, которых нет в вакансиях: «мастер смены», «водитель погрузчика». near — ближайшие вакансии */
const UNLISTED: { re: RegExp; label: string; near: string[] }[] = [
  { re: /мастер[а-я]*\s+смен|начальник[а-я]*\s+смен|бригадир/, label: 'мастер смены', near: ['bottling-operator', 'fermentation-assistant'] },
  { re: /водител[а-я]*\s+погрузчик|погрузчик|карщик|штабелер/, label: 'водитель погрузчика', near: ['warehouse-operator', 'storekeeper'] },
  { re: /комплектовщик/, label: 'комплектовщик', near: ['storekeeper', 'logistics-planner'] },
  { re: /грузчик|разнорабоч/, label: 'грузчик', near: ['store-worker', 'logistics-planner'] },
  { re: /упаковщик|фасовщик/, label: 'упаковщик', near: ['bottling-operator'] },
  { re: /наладчик/, label: 'наладчик', near: ['automation-intern', 'bottling-operator'] },
  { re: /механик|кипиа/, label: 'механик', near: ['automation-intern', 'bottling-operator'] },
  { re: /программист|разработчик|айтишник|тестировщик|девелопер|фронтенд|бэкенд|frontend|backend/, label: 'программист', near: ['automation-intern'] },
  { re: /дизайнер/, label: 'дизайнер', near: ['marketing-intern'] },
  { re: /копирайтер|таргетолог/, label: 'копирайтер', near: ['marketing-intern'] },
  { re: /технолог(?![а-я])|технолог[аоу](?![а-я])|технологом/, label: 'технолог', near: ['fermentation-assistant', 'lab-chemist'] },
  { re: /электрик|электромонтер|энергетик/, label: 'электрик', near: ['automation-intern'] },
  { re: /слесар/, label: 'слесарь', near: ['bottling-operator', 'automation-intern'] },
  { re: /сварщик/, label: 'сварщик', near: [] },
  { re: /кассир/, label: 'кассир', near: ['store-worker'] },
  { re: /менеджер[а-я]*\s+по\s+продаж|торгов[а-я]*\s+представител/, label: 'менеджер по продажам', near: ['merchandiser'] },
  { re: /экскурсовод|гид(?![а-я])/, label: 'экскурсовод', near: [] },
  { re: /бухгалтер/, label: 'бухгалтер', near: [] },
  { re: /юрист/, label: 'юрист', near: [] },
  { re: /повар/, label: 'повар', near: [] },
  { re: /охранник/, label: 'охранник', near: [] },
  { re: /уборщи|клинер/, label: 'уборщик', near: [] },
  { re: /(?<![а-я])водител[ьяюе]?(?![а-я])|шофер/, label: 'водитель', near: [] },
]

// ── Перенос темы: «а на складе?» после «сколько платят операторам» ────────

/** Тема, которую можно перенести на неполный вопрос. Фраза — то, что подставим в начало */
const CARRY: [RegExp, string][] = [
  [/за (лето|сезон|\d+\s*месяц)|выйдет|заработа/, 'сколько выйдет за лето'],
  [MONEY, 'сколько платят'],
  [/график|смен[аыу]?\s+по|выходн|сколько часов|длится смена/, 'какой график'],
  [/ночн/, 'ночные смены есть'],
  [/медкниж|санкниж/, 'нужна медкнижка'],
  [/общаг|общежит|жиль/, 'общежитие'],
  [/(?<![а-я])дмс|страховк|полис/, 'дмс'],
  [/добрат|доехат|автобус|метро|развоз/, 'как добраться'],
  [/обязанност|задач|что (нужно |надо )?делать|что делает|что делают|чем занима/, 'что делает'],
  [/опыт/, 'нужен опыт'],
]
const carryTopic = (t: string) => CARRY.find(([re]) => re.test(t))?.[1] ?? null
/** В вопросе есть тема, кроме места: «а на складе?» — нет, «а график на складе?» — есть */
const hasTopic = (t: string) => Boolean(carryTopic(t)) || WORK.test(t.replace(PLACE_WORDS, ' ')) || MONEY.test(t)
/** О ком или о чём был вопрос: вакансия или место — для «а график там какой?» */
function subjectOf(t: string): string | null {
  const id = namedVacancy(t)
  if (id) return vacancyById(id)!.title.toLowerCase()
  return t.match(PLACE_WORDS)?.[0] ?? null
}
const ANAPHORA = /(?<![а-я])(там|туда|тут|здесь|у них|у него|у нее|на ней|на нем|эт(ой|ом|а|у)\s+(работ|позици|ваканси|должност))(?![а-я])/

/**
 * Неполный вопрос берёт недостающее из соседей: из других частей того же вопроса и из прошлых вопросов человека.
 * «а на складе?» после вопроса о зарплате → «сколько платят а на складе?»; «а график там какой?» → «… склад»
 */
function withContext(t: string, neighbours: string[]): string {
  if (!neighbours.length) return t
  const words = t.split(/\s+/).length
  const continuation = /^(а|и)\s/.test(t)
  let out = t
  if (!hasTopic(t) && words <= 5 && (subjectOf(t) || continuation)) {
    const topic = neighbours.map(carryTopic).find(Boolean)
    if (topic) out = `${topic} ${out}`
  }
  if (!subjectOf(out) && (ANAPHORA.test(out) || continuation) && words <= 7) {
    const subject = neighbours.map(subjectOf).find(Boolean)
    if (subject) out = `${out} ${subject}`
  }
  // «Сколько стоит общага и во сколько закрывается» — режим, кухня и комната относятся к общежитию из соседней части
  if (!/общаг|общежит/.test(out) && /закрыва|(?<![а-я])вход|кухн|комнат|сосед|заселен|заезд|(?<![а-я])фен(?![а-я])/.test(out) && neighbours.some((n) => /общаг|общежит/.test(n))) {
    out = `общежитие ${out}`
  }
  return out
}

// ── Сборка ответа ─────────────────────────────────────────────────────────

const family = (group: string) => group.split(':')[0]

/** Ответы на несколько частей вопроса — в одном сообщении, в порядке вопроса */
function combine(plans: Grouped[]): Grouped {
  // Цикл помощника делает не больше трёх вызовов: части, которым вызовов не хватает, отбрасываем, кнопки — в последнюю очередь
  const MAX = 3
  const needed = (p: Grouped) => ('calls' in p ? p.calls.filter((c) => c.name !== 'suggest_action').length : 0)
  const kept: Grouped[] = []
  let used = 0
  for (const p of plans) {
    if (used + needed(p) > MAX) continue
    kept.push(p)
    used += needed(p)
  }
  let room = MAX - used
  const callsOf = kept.map((p) => ('calls' in p ? p.calls.filter((c) => c.name !== 'suggest_action' || room-- > 0) : []))
  return {
    group: kept.map((p) => p.group).join('+'),
    calls: callsOf.flat(),
    compose: (results) => {
      let at = 0
      const texts = kept.map((p, i) => {
        if ('text' in p) return p.text
        const mine = results.slice(at, at + callsOf[i].length)
        at += callsOf[i].length
        return p.compose(mine)
      })
      // Ответ, который целиком входит в другой, не повторяем
      return texts.filter((x, i) => x && !texts.some((y, j) => j !== i && y.length > x.length && y.includes(x))).join('\n\n')
    },
  }
}

/** Одна тема — один ответ: из «night» и «night:pay» остаётся уточнённый, повтор темы отбрасываем */
function distinctGroups(plans: Grouped[]): Grouped[] {
  return plans.filter((p, i) => {
    if (plans.findIndex((q) => q.group === p.group) !== i) return false
    return !plans.some((q) => q !== p && !p.group.includes(':') && q.group.startsWith(`${p.group}:`))
  })
}

/** Первая строка пункта вакансии: «**Кладовщик** · от 56 000 ₽» (server/assistant/tools.ts, vacancyBrief) */
const ITEM_HEAD = /^\*\*[^*\n]+\*\* [·—] /
/** Начало списка: «• …», «— …», «1. …» или пункт вакансии */
const LIST_LINE = /^(• |— |\d+[.)]\s|\*\*[^*\n]+\*\* [·—] )/

/** Сокращения с точкой внутри фразы: «м. «Озёрная»», «ул. Рябиновая», «ст. 80», «доб. 1155» */
const SENTENCE_END = /(?<!(?:^|[\s(«])(?:м|ул|ст|доб|г|д|т|им|пр|руб|тыс|см|ок))([.?])\s+(?=[А-ЯЁA-Z«])/g

function sentences(text: string): string[] {
  return text.replace(SENTENCE_END, '$1\u0000').split('\u0000')
}

/**
 * Правила формы для любого ответа офлайн-режима:
 *  — «Да» в начале только на вопрос «да или нет»;
 *  — в первом абзаце до двух предложений, дальше — новый абзац;
 *  — в списке вакансий до трёх строк, остальное — «Ещё N вакансии в общем списке»;
 *  — одинаковые абзацы не повторяются
 */
function finalize(text: string, yesNo: boolean): string {
  const [first, ...rest] = (yesNo ? text : dropYes(text)).split('\n\n')
  // Первый абзац: фразы до списка. Если их больше двух, третья и дальше уходят во второй абзац вместе со списком
  const lines = first.split('\n')
  const listAt = lines.findIndex((l) => LIST_LINE.test(l))
  const head = (listAt < 0 ? lines : lines.slice(0, listAt)).join(' ')
  const list = listAt < 0 ? '' : lines.slice(listAt).join('\n')
  const s = sentences(head)
  const paragraphs = s.length > 2 ? [s.slice(0, 2).join(' '), [s.slice(2).join(' '), list].filter(Boolean).join('\n'), ...rest] : [first, ...rest]
  const seen = new Set<string>()
  return capLists(paragraphs.join('\n\n'))
    .split('\n\n')
    .filter((p) => {
      const key = p.trim()
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .join('\n\n')
}

/**
 * Пункты вакансий подряд: строки «— …» и пункты «**Вакансия** — от … ₽» со строками графика и срока под ними (vacancyBrief).
 * Больше трёх пунктов с суммой — оставляем три и «ещё N»
 */
function capLists(text: string): string {
  const out: string[] = []
  let run: string[][] = []
  const flush = () => {
    if (run.length > 3 && run.every((item) => /₽|ориентир/.test(item[0]))) {
      const more = run.length - 3
      out.push(...run.slice(0, 3).flat(), `Ещё ${more} ${plural(more, 'вакансия', 'вакансии', 'вакансий')} в общем списке.`)
    } else out.push(...run.flat())
    run = []
  }
  for (const line of text.split('\n')) {
    const last = run.at(-1)
    if (LIST_LINE.test(line)) run.push([line])
    // Строка подробностей пункта: сразу под ним, не пустая и без точки или двоеточия в конце — фразы после списка с ними
    else if (last && ITEM_HEAD.test(last[0]) && line.trim() && !/[.:]$/.test(line.trim())) last.push(line)
    else {
      flush()
      out.push(line)
    }
  }
  flush()
  return out.join('\n')
}

const HELLO_TEXT = 'Привет. Спроси про работу на заводе, и я отвечу по данным «Очаково»: сколько платят, какой график, где жить или что подойдёт под учёбу.'
const THANKS_TEXT = 'Пожалуйста. Если появятся вопросы про работу на заводе, пиши.'
const SHORT_TEXT = 'Спроси своими словами: сколько платят, какой график, где жить или какая работа подойдёт под учёбу.'

function leadReply(lead: Lead | null): Grouped {
  if (lead === 'hello') return { group: 'hello', text: HELLO_TEXT }
  if (lead === 'thanks') return { group: 'thanks', text: THANKS_TEXT }
  return { group: 'short', text: SHORT_TEXT }
}

/**
 * План ответа: вежливое начало отрезаем, неполный вопрос дополняем из прошлых, составной делим на части.
 * previous — прошлые вопросы человека, последний первым
 */
function plan(raw: string, previous: string[] = []): Plan {
  // Подстановки после очистки личных данных («[телефон]») не должны влиять на смысл вопроса
  const question = raw.replace(/\[(телефон|почта|ник|имя)\]/g, ' ').replace(/\s+/g, ' ').trim()
  const { rest, lead } = stripLead(question)
  if (!rest || !/[a-zа-яё0-9]/i.test(rest)) return leadReply(lead)
  const before = previous.map((p) => norm(stripLead(p).rest))
  const whole = norm(rest)
  const yesNo = isYesNo(whole)
  let result = planCore(withContext(whole, before))
  const parts = joinPronouns(splitParts(rest).map(norm))
  if (parts.length > 1) {
    // Вакансия, названная в одной части, — тема и для остальных: «у кладовщика за лето и можно ли 3 дня в неделю»
    const vacancy = namedVacancy(whole)
    const each = parts.map((part, i) => planCore(withContext(part, [parts[i - 1], parts[i + 1], ...before].filter(Boolean)), vacancy, true))
    // Мимо темы и «не знаю» в составе вопроса не нужны, если на другие части есть ответ
    const useful = distinctGroups(each).filter((p) => !['offtopic', 'unknown', 'short'].includes(family(p.group)))
    if (useful.length > 1) result = combine(useful.slice(0, 3))
  }
  if (ADULT.test(whole) && !result.group.split('+').some((g) => family(g) === 'age')) {
    result = combine([result, { group: 'age', text: 'Возраст подходит: на завод берут с 18 лет.' }])
  }
  return 'text' in result ? { text: finalize(result.text, yesNo) } : { calls: result.calls, compose: (r) => finalize(result.compose(r), yesNo) }
}

const as = (group: string, p: Plan): Grouped => ({ ...p, group })

/** Часть со ссылкой на прошлую («кто за неё платит», «а это сколько стоит») — продолжение прошлой части, не отдельный вопрос */
const PRONOUN = /(?<![а-я])(нее|ее|него|ней|нем|ним|них|это|этого|этом|эту|этим)(?![а-я])/
function joinPronouns(parts: string[]): string[] {
  const out: string[] = []
  for (const p of parts) {
    if (out.length && PRONOUN.test(p) && !subjectOf(p) && p.split(/\s+/).length <= 5) out[out.length - 1] = `${out.at(-1)} и ${p}`
    else out.push(p)
  }
  return out
}

/** Список вакансий пунктами: «**Название** — от … ₽», под ним график и срок своими строками */
const briefList = (list: Vacancy[]) => list.map((v) => vacancyBrief(v)).join('\n')

/** Спрашивают про бумаги практики: договор, приказ, дневник, характеристику */
const docsAsked = (t: string) => /документ|дневник|договор|характеристик|отч[её]т|приказ|бумаг|оформ/.test(t)

/** Практика от вуза: текст из «Вопросов» на сайте, кнопки практик и «Откликнуться». Про документы — справочник студента */
function practicePlan(t: string, papers: boolean): Grouped {
  const practices = vacancies.filter((v) => v.format === 'Оплачиваемая практика')
  if (MONEY.test(t)) {
    const paid = vacancies.filter((v) => v.format === 'Оплачиваемая практика' && v.pay)
    const lo = Math.min(...paid.map((v) => v.pay!.from))
    const hi = Math.max(...paid.map((v) => v.pay!.to ?? v.pay!.from))
    const estimate = paid.every((v) => v.pay!.estimate)
    return as('practice:pay', {
      calls: [call('search_vacancies', { format: 'Оплачиваемая практика' }), call('suggest_action', { action: 'start_application' })],
      compose: () =>
        `На оплачиваемой практике платят ${lo === hi ? `от ${rub(lo)}` : `от ${lo.toLocaleString('ru-RU')} до ${rub(hi)}`} в месяц до вычета налога, за ночные смены больше` +
        `${estimate ? ', это ориентир: точную сумму назовут на собеседовании' : ''}.\n\n${briefList(practices)}`,
    })
  }
  // «Что за бесплатная практика» — задачи из «Описания практики», кнопки направлений бесплатной практики
  if (/бесплатн/.test(t) && !docsAsked(t)) {
    const free = vacancies.filter((v) => v.format === 'Бесплатная практика')
    return as('practice:free', {
      calls: [...free.slice(0, 2).map((v) => call('suggest_action', { action: 'open_vacancy', vacancy_id: v.id })), call('suggest_action', { action: 'start_application' })],
      compose: () => faqAnswer('free-practice'),
    })
  }
  // Документы по практике — ответ из справочника студента; «можно практику от вуза?» — про саму практику
  const docs = docsAsked(t)
  const text =
    (docs ? faqAnswer('practice-docs') : faqAnswer('practice')) ||
    `Есть оплачиваемая практика: ${titles(practices)}. Документы по практике принимает Учебный центр, а вуз и сроки практики укажи в заявке.`
  return as('practice', {
    calls: [call('search_vacancies', { format: 'Оплачиваемая практика' }), call('suggest_action', { action: 'start_application' })],
    compose: () => (papers ? `${practiceDocLead(t, isYesNo(t))}${practiceDocLead(t, isYesNo(t)) ? '\n\n' : ''}${text}` : text),
  })
}

// ── Справочник студента: быт, правила, документы, телефоны ────────────────

const entry = (id: string) => phonebook.find((p) => p.id === id)!
/** «Да, к каждому новичку…» — ответ на вопрос «да или нет» из утвердительного текста */
const yesLead = (text: string) => `Да, ${lowerFirst(text)}`
const noLead = (text: string) => `Нет, ${lowerFirst(text)}`
const dormStreet = dorm.address.replace(/^Москва,\s*/, '')
const recruitingLine = `${contactLine}, WhatsApp ${whatsappText}`

/** Отдел из справочника по словам вопроса: «телефон учебного центра», «где отдел кадров» */
const DEPARTMENTS: [RegExp, string][] = [
  [/учебн[а-я]*\s+центр|кабинет[а-я]*\s+525|(?<!\d)525(?!\d)/, 'training'],
  [/отдел[а-я]*\s+кадр|кадровик|кадров[а-я]*\s+служб/, 'personnel'],
  [/здравпункт|медпункт|медсанчаст/, 'medical'],
  [/охран(?![а-я]*\s+труд)/, 'security'],
  [/комендант|общежит[а-я]*\s+(телефон|номер)|(телефон|номер)[а-я]*\s+(в\s+)?общежит|общаг[а-я]*\s+(телефон|номер)|(телефон|номер)[а-я]*\s+общаг/, 'dorm'],
  [/отдел[а-я]*\s+подбор|рекрутер/, 'recruiting'],
]
const CONTACT_WORDS = /телефон|номер|позвонить|звонить|набрать|связат|добавочн|(?<![а-я])доб(?![а-я])|контакт|где\s+(наход|найти|он|она|сидит)|куда\s+(идти|обратит|звонить|приносить|нести)|кабинет|как\s+(найти|попасть)/

function phonebookAnswer(id: string): string {
  const e = entry(id)
  switch (id) {
    case 'training':
      return `${phoneLine(e)}. Документы по практике приносят в Учебный центр, кабинет ${TRAINING_CENTER_ROOM}.`
    case 'medical':
      return `${phoneLine(e)}, работает круглосуточно. Если плохо себя чувствуешь на смене, сначала сообщи руководителю.`
    case 'dorm':
      return `Телефон коменданта общежития: ${e.phone}. Адрес общежития: ${dormStreet}, ключи при заселении выдаёт комендант.`
    case 'personnel':
      return `${phoneLine(e)}: там выдают пропуск и оформляют документы.`
    case 'recruiting':
      return `${phoneLine(e)}. Перед приездом позвони сюда; почта ${contacts.email}, WhatsApp ${whatsappText}.`
    default:
      return `${phoneLine(e)}.`
  }
}

/** Все телефоны справочника строками */
const phonebookList = () => phonebook.map((e) => `• ${phoneLine(e)}${e.note ? `, ${e.note}` : ''}`).join('\n')

/** Первая фраза о документе практики, который назвали в вопросе: «характеристику дадите?» */
function practiceDocLead(t: string, yesNo: boolean): string {
  const doc = (id: (typeof practiceDocs)[number]['id']) => practiceDocs.find((d) => d.id === id)!
  if (/характеристик/.test(t)) return `${yesNo ? 'Да, х' : 'Х'}арактеристику ${doc('reference').who} ${doc('reference').when}.`
  // Справочник, стр. 12: «Сотрудники Учебного центра подписывают в момент увольнения» — у практики это её конец
  if (/дневник|отч[её]т/.test(t)) return `${yesNo ? 'Да: д' : 'Д'}невник или отчёт по практике заполняет студент во время практики, а подписывают его сотрудники Учебного центра, когда практика заканчивается.`
  if (/приказ/.test(t)) return `Приказ о практике оформляет «Очаково».`
  if (/договор/.test(t)) return `Договор о практике с вузом или колледжем подписывают ${doc('contract').when.replace(/^подписывают /, '')}.`
  return ''
}

/**
 * Ответы по «Справочнику студента» и «Описанию практики»: общежитие, столовая, зарплата, учёба и отпуск, спецодежда
 * и прачечная, пропуск, здравпункт, документы по практике, наставник, испытательный срок, договор, график, телефоны.
 * null — вопрос не про справочник
 */
function handbookPlan(t: string, yesNo: boolean): Grouped | null {
  // Телефон отдела: «телефон учебного центра», «где отдел кадров», «номер коменданта»
  const dept = DEPARTMENTS.find(([re]) => re.test(t))?.[1]
  if (dept && (CONTACT_WORDS.test(t) || t.split(/\s+/).length <= 3)) {
    // «Есть медпункт?» — да или нет, дальше телефон
    return as(`phone:${dept}`, { text: `${yesNo && /есть|бывает/.test(t) ? 'Да. ' : ''}${phonebookAnswer(dept)}` })
  }
  if (/(все|какие)\s+телефон|телефоны\s+(отдел|завода|служб)|добавочн/.test(t)) {
    return as('phonebook', { text: `Телефоны из справочника студента:\n${phonebookList()}` })
  }

  if (/испытательн/.test(t)) {
    const other = /не студент|выпускни|не учусь|окончил|закончил/.test(t) ? '\n\nКакие условия у тех, кто уже не учится, скажет HR на собеседовании.' : ''
    return as('probation', { text: `${handbookText('probation')}${other}` })
  }

  if (/трудов[а-я]*\s+книжк|трудовую оформля|трудовая будет/.test(t)) {
    const text = 'трудовая книжка электронная. Со студентом заключают срочный трудовой договор по ТК РФ, а с вузом или колледжем договор о практике.'
    return as('labor-book', { text: /бумажн/.test(t) ? `Нет, ${text}` : yesNo ? `Да, ${text}` : capitalize(text) })
  }
  if (/какой\s+(будет\s+)?(трудовой\s+)?договор|по какому договору|срочн[а-я]*\s+(трудов[а-я]*\s+)?договор|договор[а-я]*\s+(срочн|какой|на срок)/.test(t)) {
    return as('contract', { text: handbookText('contract') })
  }

  // Наставник и обучение — до «первой смены»: «кто будет учить на первой смене» — про наставника
  if (
    /наставник|кто\s+(меня\s+)?(будет\s+)?(учить|обучать|учит|обучает|научит|покажет)|(научат|обучат|учат|обучают)(?![а-я])|будут\s+ли\s+учить|обучени[ея](?![а-я]*\s+в\s+(вуз|колледж))/.test(t) &&
    !/совмещ|сесси|экзамен|за свой сч[её]т|платн/.test(t)
  ) {
    const mentor = handbookText('mentor')
    // Справочник, стр. 6: «Освоение процессов. Освоение оборудования. Работа на оборудовании»
    const start = 'На старте три шага: освоить процессы, освоить оборудование, работать на нём.'
    return as('mentor', { text: `${yesNo ? yesLead(mentor) : mentor}\n\n${start}` })
  }

  if (/пропуск(?![а-я]*\s+(смен|работ|заняти|пар|по болезн))|проходн|контрольн[а-я]*\s+пункт/.test(t) && !/пропуст/.test(t)) {
    const personnel = entry('personnel')
    if (/потерял|потеряла|потерять|потеря|утерял|утеря|украл|сломал|забыл/.test(t)) {
      return as('pass:lost', {
        text: `Иди в отдел кадров за новым пропуском (${personnel.phone}, ${personnel.ext}). За потерянный пропуск берут штраф ${rub(PASS_FINE)}.`,
      })
    }
    return as('pass', { text: handbookText('pass') })
  }

  // Военкомат — справочник, стр. 8
  if (/военкомат|повестк|приписн/.test(t)) {
    return as('military', {
      text: 'Для медкомиссии в военкомате напиши заявление в отдел кадров и согласуй его с руководителем. С собой возьми оригинал повестки.',
    })
  }

  if (/здравпункт|медпункт|медсестр|(?<![а-я])врач(?!еб)|аптечк|плохо себя|плохо стало|стало плохо|заболе|травм|поранил|ушиб|скорая/.test(t) && !/больничн[а-я]*\s+(оплач|плат)/.test(t)) {
    const med = entry('medical')
    if (yesNo && !/заболе|плохо|травм|поранил|ушиб/.test(t)) {
      return as('health', { text: `Да, здравпункт работает круглосуточно: ${med.phone}, ${med.ext}. Если плохо себя чувствуешь, сообщи руководителю и иди туда.` })
    }
    return as('health', { text: handbookText('health') })
  }

  // Общежитие: цена, режим, заселение, что есть, комната, спорт, кто живёт
  if (/общаг|общежит|где жить|жиль[ея]|проживан|иногородн|не из москвы|из другого города|комендант|заселен|заселит|заселят|в комнате|соседи по комнате|кухн/.test(t)) {
    const cost = /платн|стоит|стоимост|цен[аыу]|поч[её]м|сколько.*(платить|стоит)|за деньги|денег|(?<![а-я])плат/.test(t)
    if (cost) {
      const price = `для студентов койко-место стоит ${rub(dorm.priceStudent)}, половину стоимости оплачивает компания; для остальных ${rub(dorm.priceOther)}.`
      const lead = /бесплатн/.test(t) ? `Нет, платное: ${price}` : yesNo ? `Да, платное: ${price}` : capitalize(price)
      return as('dorm:cost', { text: `${lead} Адрес общежития: ${dormStreet}, рядом с заводом.` })
    }
    if (/во сколько|до скольки|закрыва|комендантск|режим|вход|вернуться|ночью прийти|после 23/.test(t)) {
      return as('dorm:curfew', { text: `В общежитии ${dorm.curfew}. ${capitalize(dorm.checkIn)}.` })
    }
    if (/заселен|заселит|заселят|заезд|заехать|въезд|ключ|когда\s+(приезжать|приехать|ехать)|день\s+заезда/.test(t)) {
      const commandant = entry('dorm')
      return as('dorm:check-in', {
        text: `${capitalize(dorm.checkIn)}. До приезда позвони в отдел подбора: ${recruitingLine}. Телефон коменданта: ${commandant.phone}.`,
      })
    }
    if (/что\s+(взять|брать|привезти|везти|с собой)|фен|утюг|постельн|бель[её]|полотенц|подушк|одеял|техник|холодильник|кухн|плит[аыу]|микроволн|чайник|готовить|приготовить/.test(t)) {
      return as('dorm:kitchen', {
        text: `${yesNo ? 'Да, н' : 'Н'}а каждом этаже есть ${dorm.kitchen.replace(/^общие кухни на каждом этаже/, 'общие кухни')}. В общежитии ${dorm.bring}.`,
      })
    }
    if (/сколько\s+(человек|людей|челов)|сосед|в комнате|комнат[аыу]|душ|туалет|санузел|ванн/.test(t)) {
      return as('dorm:room', { text: `В комнате ${dorm.room.replace(/\s+в комнате$/, '')}. ${capitalize(dorm.bath)}, на этажах общие кухни.` })
    }
    if (/спорт|площадк|турник|качалк/.test(t)) {
      return as('dorm:sport', { text: `${yesNo ? 'Да, о' : 'О'}коло общежития есть спортивная площадка. Адрес общежития: ${dormStreet}.` })
    }
    if (/кто\s+(там\s+)?(живет|живут|жив[её]т)|с кем жить/.test(t)) {
      return as('dorm:who', { text: `В общежитии живут сотрудники «Очаково», ${dorm.room}. Общие зоны убирает персонал общежития, а кухни и комнаты убирают сами жильцы.` })
    }
    // «Где общежитие?» — про место, «где жить?» — про вариант, «есть общага?» — да или нет
    const lead = /где (общаг|общежит)|общаг[аи]? где|общежити[ея] где|адрес/.test(t)
      ? `Адрес общежития компании: ${dormStreet}. Завод стоит на ${street}.`
      : /где|куда/.test(t)
        ? `В общежитии компании: ${dormStreet}, рядом с заводом.`
        : `${yesNo ? 'Да, у' : 'У'} компании есть общежитие: ${dormStreet}, рядом с заводом.`
    return as('dorm', {
      text: `${lead} Койко-место для студентов стоит ${rub(dorm.priceStudent)}, половину оплачивает компания. ${capitalize(dorm.room)}, ${dorm.curfew}. Перед заездом позвони в отдел подбора: ${contactLine}.`,
    })
  }

  // Столовая: обед, ужин, деньги
  if (/(^|[^а-яё])(обед|ужин|поесть|столов|корм|питани|еда(?![а-я])|еду(?![а-я]))/.test(t) && !/обеденн[а-я]*\s+перерыв\s+сколько\s+плат/.test(t)) {
    const hours = `Обед ${canteen.lunch}, вечернее питание ${canteen.dinner}.`
    if (/ужин|вечер[а-я]*\s+(питан|еда|поесть|корм)|ночью\s+(поесть|еда)|вечером\s+(поесть|кормят)|ночн[а-я]*\s+смен[а-я]*\s+(поесть|еда|корм)/.test(t)) {
      return as('canteen:dinner', {
        text: `${yesNo ? 'Да, в' : 'В'}ечернее питание ${canteen.dinner}, обед ${canteen.lunch}. Половину стоимости компенсирует компания.`,
      })
    }
    if (/деньг|налич|карт[ау]|платить|стоит|цен[аы]|поч[её]м|стоимост|дорого|сколько\s+(стоит|плат)/.test(t)) {
      const lead = /деньг|налич|карт/.test(t)
        ? `${yesNo ? 'Нет, д' : 'Д'}еньги с собой не нужны: половину стоимости компенсирует компания, остальное вычитают из зарплаты в конце месяца.`
        : `Точной цены обеда в моих данных нет: половину стоимости компенсирует компания, остальное вычитают из зарплаты в конце месяца.`
      return as('canteen:money', { text: `${lead}\n\n${hours}` })
    }
    const pause = /перерыв|сколько\s+длится|сколько\s+времени/.test(t) ? '\n\nСколько длится перерыв, зависит от графика смены, это скажут на собеседовании.' : ''
    return as('lunch', { text: `${faqAnswer('canteen')}${pause}` })
  }

  // Зарплата: расчётный лист, переработки, премия, почему разная, дни выплат
  if (/расч[её]тн[а-я]*\s+лист|расч[её]тк/.test(t)) {
    return as('payday:slip', {
      text: `Расчётный лист приходит на электронную почту, которую указывают в трудовом договоре. Зарплату платят два раза в месяц, ${PAY_DAYS[0]}-го и ${PAY_DAYS[1]}-го.`,
    })
  }
  if (/переработ|сверхуроч|сверх\s+нормы|работа[а-я]*\s+в\s+выходн|выходить\s+в\s+выходн/.test(t)) {
    const pay = 'часы сверх нормы оплачиваются отдельно, а ночные смены по повышенному коэффициенту.'
    const consent = 'Сверхурочная работа и работа в выходные бывают только по производственной необходимости и с согласия сотрудника.'
    return as('overtime', {
      text: /оплач|плат|деньг|сколько/.test(t) ? `${yesNo ? `Да, ${pay}` : capitalize(pay)} ${consent}` : `${consent} ${capitalize(pay)}`,
    })
  }
  if (/преми/.test(t)) {
    return as('bonus', {
      text: 'В зарплате есть премиальная часть: она зависит от линии и её нагрузки, а за нарушения её уменьшают. Размер премии в моих данных не указан, его скажет HR на собеседовании.',
    })
  }
  if (/разн[а-я]*\s+(зарплат|оплат)|(зарплат|оплат)[а-я]*\s+разн|почему[^?]*(меньше|больше)[^?]*(зарплат|плат|получ)/.test(t)) {
    return as('pay:differs', {
      text: 'Зарплата на одной должности бывает разной: от отработанных часов, премиальной части, линии и её нагрузки, отгулов и больничных. Ночные смены оплачиваются по повышенному коэффициенту.',
    })
  }
  if (/(когда|во сколько|какого числа|как часто|сколько раз|в какие дни|какие числа)[^?]*(зарплат|выплат|получк|деньг|платят)|перв(ая|ую|ой) зарплат|аванс|дни выплат|дат[аы] выплат/.test(t)) {
    return as('payday', { text: handbookText('payday') })
  }

  // Скидка на продукцию — «Описание практики»
  if (/скидк|бесплатн[а-я]*\s+(квас|напит|продукц|лимонад)|(квас|напит|продукц|лимонад)[а-я]*\s+(бесплатн|для сотрудник)/.test(t)) {
    const free = /бесплатн/.test(t) ? 'Бесплатного кваса для сотрудников в моих данных нет, а с' : `${yesNo ? 'Да, с' : 'С'}`
    return as('discount', { text: `${free}отрудники покупают продукцию «Очаково» со скидкой. Размер скидки скажут при оформлении.` })
  }

  // Учёба: экзамены и сессия. «Сессия в июне, можно на июль?» — вопрос о сроках, его разбирает ответ про сроки
  const { wanted, busy } = monthsWanted(t)
  const asksPeriod = /(только|можно|могу|получится|выйти|работать|подработ|на каникул)/.test(t)
  if (/экзамен|сесси|зач[её]т(?![а-я]*\s+практик)|защит[а-я]*\s+диплом|диплом[а-я]*\s+защит/.test(t) && !/совмещ|совмест|параллельн/.test(t) && !wanted.length && !(busy.length && asksPeriod)) {
    return as('exams', { text: handbookText('exams') })
  }
  if (/отпуск|отгул|уехать\s+(надолго|домой|на)|отсутств|отпрос/.test(t)) {
    return as('vacation', {
      text: `В сезон, ${SEASON.text}, отпуска ограничены, потому что работы много. Для поездок надолго используют выходные, а долгое отсутствие согласуют с руководителем за две недели.`,
    })
  }

  // Спецодежда и прачечная
  if (/прачечн|постират|стирать|стирк|почистить форм/.test(t)) {
    return as('laundry', {
      text: `${yesNo ? 'Да, п' : 'П'}рачечная работает по будням с 8:30 до 16:30, чистые вещи готовы через 1–2 дня. Спецодежду можно стирать и самостоятельно.`,
    })
  }

  // График: выбрать нельзя, поменяться сменой — по согласованию
  if (/помен[яи]ться|обмен[яи]ться|поменять\s+смен|махнуться|подмен/.test(t) && /смен|график|коллег/.test(t)) {
    const text = 'Поменяться сменой с коллегой можно в исключительных случаях и по согласованию с руководителем. График составляет руководитель, свой выбрать не получится.'
    return as('schedule:swap', { text: yesNo ? `Да, в исключительных случаях и по согласованию с руководителем. График составляет руководитель, свой выбрать не получится.` : text })
  }
  if (/(выбрать|выбирать|выбор|сам[аи]?\s+(ставить|решать|составлять)|подстро|индивидуальн|кто\s+составляет)[^?]*(график|смен)|(график|смен)[^?]*(выбрать|выбирать|выбор|индивидуальн)/.test(t) && !/дневн|ночн/.test(t)) {
    const text = handbookText('schedule')
    return as('schedule:choice', { text: yesNo ? noLead(text) : text })
  }

  // Сезон: когда и что это значит
  if (/(когда|какие месяцы|какой|во сколько)\s+(у вас\s+|на заводе\s+)?(высокий\s+)?сезон|сезон\s+(когда|это когда|какой|длится)|высок[а-я]*\s+сезон|что\s+такое\s+сезон/.test(t)) {
    return as('season', {
      text: `Сезон длится ${SEASON.text}. Работы в это время много, поэтому отпуска ограничены. Оплачиваемая практика идёт ${paidPracticeInfo.period.toLowerCase()}.`,
    })
  }

  // Охрана труда: инструктаж, обувь, средства защиты
  if (/инструктаж|охран[а-я]*\s+труда|техник[а-я]*\s+безопасн|какая\s+обувь|в\s+ч[её]м\s+ходить|пожар|беруши|перчатк|защитн[а-я]*\s+очк/.test(t)) {
    return as('safety', { text: handbookText('safety') })
  }

  // Как себя вести — справочник, стр. 13
  if (/принцип|как\s+(надо\s+|нужно\s+)?вести\s+себя|правила\s+поведения|дисциплин/.test(t)) {
    return as('principles', {
      text: `Принципы работы в «Очаково»: ${workPrinciples.join(', ')}. Важнее всего выполнять задачи руководителя и соблюдать правила безопасности и внутреннего распорядка.`,
    })
  }
  return null
}

/** context — вакансия, названная в другой части того же вопроса; part — это часть составного вопроса */
function planCore(t: string, context?: string, part = false): Grouped {
  const named = namedVacancy(t) ?? context
  const namedV = named ? vacancyById(named) : undefined
  const yesNo = isYesNo(t)

  if (/(?<![а-я])(пив|алкогол|водк|вин[оа](?![а-я])|сидр|спиртн)/.test(t)) {
    return as('alcohol', {
      text: 'Я рассказываю только про работу на заводе: вакансии, зарплаты, условия и как устроено производство. Могу показать вакансии или подобрать работу под учёбу.',
    })
  }

  // Ответ отдела персонала на этот вопрос — раньше правил и основной базы: HR ответил на то, чего в данных не было
  const hr = matchHrAnswer(t)
  if (hr) return as(`hr:${hr.id}`, { text: hr.answer })

  // Творческие просьбы — коротко по-человечески и обратно к работе, без передачи в отдел персонала
  const creative = /(напиши|сочини|придумай|спой|расскажи|сгенерируй)\s+(мне\s+|нам\s+)?(стих|стишок|песн|рэп|шутк|анекдот|сказк|поэм|частушк|рассказ|эссе|сочинени|реферат|курсов)/.exec(t)
  if (creative) {
    const what = creative[3]
    const lead = /шутк|анекдот/.test(what)
      ? 'Шутки не по моей части'
      : /эссе|сочинени|реферат|курсов/.test(what)
        ? 'С учёбой не помогу'
        : /сказк|рассказ/.test(what)
          ? 'Сказки не по моей части'
          : 'Стихи не по моей части'
    return as('offtopic', {
      calls: [call('suggest_action', { action: 'open_vacancies' }), call('suggest_action', { action: 'start_quiz' })],
      compose: () => `${lead}, я рассказываю про смены и вакансии. Показать практику и вакансии?`,
    })
  }

  if (
    /^(а\s+)?(ты|вы)\s+(кто|бот|робот|человек|живой|живая|нейросеть|ии|мастер|настоящ)(?![а-я])|кто ты|ты бот|кто так(ой|ая) квасыч|квасыч,?\s+(это\s+)?кто|с кем я (говорю|общаюсь|переписываюсь)/.test(t)
  ) {
    return as('identity', {
      text: `Я Квасыч, бот «Очаково» и собирательный образ заводского наставника. Подскажу про практику, зарплату, смены и быт по данным компании. На заводе учит настоящий наставник, а если нужен человек сейчас, напиши или позвони в отдел подбора: ${contactLine}.`,
    })
  }

  // Младше 18 — сразу и прямо: «мне 17, можно?»
  const age = ageOf(t)
  if ((age !== null && age >= 10 && age < 18) || /несовершеннолет|школьник|школьниц/.test(t)) {
    return as('age:minor', {
      calls: [call('suggest_action', { action: 'start_game' })],
      compose: () => 'Нет, берут с 18 лет. Когда исполнится 18, заявку можно оставить здесь же, а пока можно пройти задания.',
    })
  }

  // Темы, ответа на которые в данных нет, — сразу к HR, даже если в вопросе есть «общежитие», «склад» или «перерыв»:
  // «нужна регистрация, если живу в общежитии?» не про общежитие, «девушку возьмут на склад?» не про склад
  const hardGap = hardGapTopic(t)
  if (hardGap) return unknownPlan(t, hardGap)

  const handbookReply = handbookPlan(t, yesNo)
  if (handbookReply) return handbookReply

  if (SCAM.test(t)) {
    return as('scam', {
      calls: [call('suggest_action', { action: 'open_vacancies' })],
      compose: () =>
        `Работодатель: АО МПБК «Очаково», завод в Москве на ${street}. Оформляют официально по ТК РФ, зарплата приходит два раза в месяц, 12-го и 27-го.\n\n` +
        `Проверить вакансию можно в отделе персонала: ${contactLine}.`,
    })
  }

  // «Чем лучше кофейни» — честное сравнение по фактам завода
  if (
    /(чем|почему|в ч[её]м).*(лучше|хуже|выгодн|круче|плюс)|почему (стоит|мне|надо|именно).*(вам|завод|очаково)|зачем (идти|мне).*(вам|завод)/.test(t) ||
    /(кофейн|бариста|курьер|официант|макдональдс|вкусно и точка|пят[её]рочк|вайлдберриз|wildberries|озон)/.test(t)
  ) {
    return as('compare', {
      calls: [call('suggest_action', { action: 'open_vacancies' })],
      compose: () => comparison(t),
    })
  }

  // Должности нет в списке: «сколько получает мастер смены» — честно «нет» и ближайшие вакансии
  const unlisted = !namedV && !studyFrom(t) ? UNLISTED.find((u) => u.re.test(t)) : undefined
  if (unlisted) {
    const near = unlisted.near.map((id) => vacancyById(id)).filter((v): v is Vacancy => Boolean(v))
    return as('unlisted', {
      calls: [...near.slice(0, 2).map((v) => call('suggest_action', { action: 'open_vacancy', vacancy_id: v.id })), call('suggest_action', { action: 'open_vacancies' })],
      compose: () =>
        near.length
          ? `Вакансии «${unlisted.label}» нет. Ближе всего:\n${briefList(near)}`
          : `Вакансии «${unlisted.label}» нет. Сейчас есть оплачиваемая практика в цехах, лаборатории и на складе, бесплатная практика по договорённости и работа в фирменном магазине. Список откроется по кнопке ниже.`,
    })
  }

  if (SCALE.test(t)) {
    return as('scale', {
      calls: [call('suggest_action', { action: 'start_tour' }), call('suggest_action', { action: 'open_vacancy', vacancy_id: 'bottling-operator' })],
      compose: () =>
        `Завод разливает до ${PLANT_BOTTLES_PER_HOUR.toLocaleString('ru-RU')} бутылок в час: большинство процессов автоматизированы, а операторы следят, чтобы линия не вставала.\n\n` +
        'Весь путь от зерна до полки показан в разделе «Путь кваса».',
    })
  }

  // Сколько выйдет за лето или за N месяцев на названной вакансии — считаем именно её. Названо место («на складе») —
  // считаем его вакансии с зарплатой, не больше двух. Без названия — по линии розлива
  const span = namedV ? totalSpan(t, namedV) : null
  const calcAsked = (span && (MONEY.test(t) || /сколько/.test(t))) || (CALC.test(t) && /(лет|месяц|сезон|недел)/.test(t))
  const calcPlace = !namedV && calcAsked ? placeOf(t) : null
  const placeVacancies = calcPlace ? vacancies.filter((v) => calcPlace.title.test(v.title) && v.pay && !v.pay.estimate).sort((a, b) => a.pay!.from - b.pay!.from).slice(0, 2) : []
  if (calcAsked && placeVacancies.length > 1) {
    const spanOf = totalSpan(t, placeVacancies[0])
    const months = spanOf?.months ?? (Number(/(\d)\s*месяц/.exec(t)?.[1]) || 3)
    const label = spanOf?.label ?? `За ${countPhrase(String(months))}`
    return as(`calc:${calcPlace!.lead}`, {
      calls: [...placeVacancies.map((v) => call('calc_earnings', { vacancy_id: v.id, months })), call('suggest_action', { action: 'open_vacancies' })],
      compose: (r) => {
        const data = r.filter((x) => x.name === 'calc_earnings').map((x) => x.result as { gross_from?: number; net_from?: number })
        if (data.some((d) => !d.gross_from)) return 'Зарплату по этим позициям называют на собеседовании.'
        const parts = placeVacancies.map((v, i) => `от ${rub(NET.test(t) ? data[i].net_from! : data[i].gross_from!)} ${asRole(v.id)}`)
        const body = NET.test(t)
          ? `${calcPlace!.lead.toLowerCase()} на руки выйдет ${listOr(parts, 'и')}`
          : `${calcPlace!.lead.toLowerCase()} выйдет ${listOr(parts, 'и')} до вычета налога, на руки от ${rub(Math.min(...data.map((d) => d.net_from!)))}`
        return `${label} ${body}. Ночные смены оплачиваются по повышенному коэффициенту, зарплата приходит два раза в месяц.`
      },
    })
  }
  if (calcAsked) {
    const v = namedV ?? (placeVacancies[0] as Vacancy | undefined) ?? vacancyById('bottling-operator')!
    const n = /(\d)\s*месяц/.exec(t)?.[1]
    const total = span ?? (n ? { months: Number(n), label: '' } : /весь сезон|с марта|сезон/.test(t) ? { months: 7, label: '' } : { months: 3, label: '' })
    return as(`calc:${v.id}`, {
      calls: [call('calc_earnings', { vacancy_id: v.id, months: total.months }), call('suggest_action', { action: 'open_vacancies' })],
      compose: (r) => {
        const d = r.find((x) => x.name === 'calc_earnings')?.result as
          | { gross_from: number; gross_to: number | null; net_from: number; net_to: number | null; estimate: boolean }
          | undefined
        if (!d?.gross_from || !total.label) return `${summaryOf(r, 'calc_earnings') || 'Зарплату по этой вакансии называют на собеседовании.'} Зарплата приходит на карту два раза в месяц.`
        const gross = d.gross_to ? `${d.gross_from.toLocaleString('ru-RU')}–${rub(d.gross_to)}` : `от ${rub(d.gross_from)}`
        const net = d.net_to ? `${d.net_from.toLocaleString('ru-RU')}–${rub(d.net_to)}` : `от ${rub(d.net_from)}`
        const note = d.estimate ? ' Это ориентир: точную сумму назовут на собеседовании.' : ''
        const body = NET.test(t) ? `на руки выйдет ${net}, до вычета налога ${gross}` : `выйдет ${gross} до вычета налога, на руки ${net}`
        return `${total.label} ${asRole(v.id)} ${body}.${note} Зарплата приходит на карту два раза в месяц.`
      },
    })
  }

  // Длина смены: «сколько длится смена», «сколько часов в день на практике»
  if (SHIFT_LEN.test(t) && !MONEY.test(t)) {
    const practiceFirst = /практик|стажир/.test(t)
    const shift = 'Смена длится 12 часов: дневная с 8:00 до 20:00, ночная с 20:00 до 8:00.'
    const office = 'Бесплатную практику проходят по договорённости, часы скажут при оформлении.'
    return as('shift-length', {
      calls: namedV ? [call('suggest_action', { action: 'open_vacancy', vacancy_id: namedV.id })] : [],
      compose: () =>
        namedV
          ? `${namedV.title}: ${scheduleTruth(namedV)}. Во сколько начинается смена, скажут на собеседовании.`
          : practiceFirst
            ? `${office} ${shift}`
            : `${shift} ${office}`,
    })
  }

  // За смену и в час — те же суммы, что в «Собери лето» на сайте (shiftPay)
  if (SHIFT_PAY.test(t) && (MONEY.test(t) || /сколько|₽|руб/.test(t)) && !/бутыл|литр|банок|продукци|разлив/.test(t)) {
    const pool = (namedV ? [namedV] : vacancies).flatMap((v) => {
      const p = shiftPay(v)
      return p ? [{ v, p }] : []
    })
    return as('shift-pay', {
      calls: pool.slice(0, 2).map(({ v }) => call('suggest_action', { action: 'open_vacancy', vacancy_id: v.id })),
      compose: () => {
        if (namedV && !pool.length) {
          // Сколько смен в месяц на этом графике, в данных нет. Если та же сумма есть на графике 2/2 — покажем её
          const twin = namedV.pay ? vacancies.find((v) => v.id !== namedV.id && v.pay?.from === namedV.pay!.from && shiftPay(v)) : undefined
          const twinLine = twin ? `\n\nСтолько же в месяц выходит ${asRole(twin.id)} на графике 2/2: на руки от ${rub(shiftPay(twin)!.perShift)} за смену, от ${rub(shiftPay(twin)!.perHour)} в час.` : ''
          return (
            `${leadFor[namedV.id] ?? `На позиции «${namedV.title}»`} платят ${shortPay(namedV)} в месяц до вычета налога, график ${schedulePhrase(namedV.schedule)}. ` +
            `Сколько смен в месяц, зависит от графика, поэтому сумму за смену и в час не считаю.${twinLine}`
          )
        }
        if (!pool.length) return `В вакансиях указана зарплата за месяц.\n\n${scheduleSummary.text}`
        const shifts = Math.round(pool[0].p.shiftsPerMonth)
        const tail = `Считаю от зарплаты на руки за месяц: около ${shifts} смен по 12 часов на графике 2/2.`
        if (pool.length === 1) {
          const { v, p } = pool[0]
          return `${leadFor[v.id] ?? `На позиции «${v.title}»`} на руки выходит от ${rub(p.perShift)} за смену, от ${rub(p.perHour)} в час.\n\n${tail}`
        }
        const sorted = [...pool].sort((a, b) => b.p.perShift - a.p.perShift)
        const low = sorted.at(-1)!.p
        const lines = sorted.map(({ v, p }) => `**${v.title}** · от ${rub(p.perShift)} за смену, от ${rub(p.perHour)} в час`)
        return `За смену на руки выходит от ${rub(low.perShift)}, в час от ${rub(low.perHour)}.\n${lines.join('\n')}\n\n${tail}`
      },
    })
  }

  // «Можно 3 дня в неделю?», «есть подработка на выходных?» — настоящий график и честное «решает отдел персонала»
  if (PART_TIME.test(t)) {
    return as('parttime', {
      calls: [call('escalate_to_hr', { topic: TOPIC.partTime })],
      compose: () => partTimeAnswer(t, named),
    })
  }

  if (WHOLE_SEASON.test(t)) {
    const summer = dropYes(faqAnswer('summer-only'))
    return as('season-length', {
      text: summer
        ? summer
        : 'Оплачиваемая практика идёт с марта или апреля до конца июля или середины августа. Если можешь не весь срок, напиши об этом в заявке.',
    })
  }

  if (QUIT.test(t)) {
    return as('quit', {
      text:
        faqText('quit', yesNo) ||
        'Уйти раньше можно: о своём уходе предупреждают письменно за две недели, а при договоре на срок до двух месяцев за три дня. Срок договора скажет HR.',
    })
  }

  // Практика от вуза — до сроков: «нужна практика, подпишете дневник?» не про месяцы.
  // «В июне практика» — занятость, это вопрос о сроках
  const busyWithPractice = monthsWanted(t).busyWhat === 'практикой'
  if (PRACTICE_PAPERS.test(t) && !busyWithPractice) return practicePlan(t, true)

  if (AFTER_SEASON.test(t)) {
    const seasonal = vacancies.filter((v) => v.format === 'Оплачиваемая практика')
    return as('after-season', {
      calls: [call('suggest_action', { action: 'start_application' }), call('suggest_action', { action: 'open_vacancies' })],
      compose: () => {
        const answer = faqText('after-season', yesNo) || 'После практики можно перевестись на постоянную работу.'
        const stay = /остат|остан|оставят|после (лета|сезона)|осен|зим|постоянн|круглый год/.test(t)
        const till = seasonal.length && stay ? '\n\nОплачиваемая практика длится до конца июля или середины августа, а постоянная работа в фирменном магазине и мерчандайзером идёт без срока.' : ''
        return `${answer}${till}`
      },
    })
  }

  if (FIRST_SHIFT.test(t)) {
    return as('first-shift', {
      calls: [call('suggest_action', { action: 'start_application' })],
      compose: () =>
        faqText('first-shift', yesNo) || 'Перед первой сменой проходят медосмотр за счёт компании, подписывают договор и слушают инструктаж по охране труда. Дату и время первой смены HR называет при оформлении.',
    })
  }

  if (START_WHEN.test(t)) {
    const interview = steps[2]
    return as('start-when', {
      calls: [call('suggest_action', { action: 'start_application' })],
      compose: () =>
        'Оплачиваемая практика начинается в марте или апреле, бесплатная по договорённости. Дату первой смены называют при оформлении.\n\n' +
        `После заявки ${lowerFirst(responsePromise('call'))}, собеседование и оформление занимают ${interview?.time ?? 'около недели'}.`,
    })
  }

  // Конкретные вопросы, которые раньше уходили не туда: перерыв, что взять, учёба, гражданство. Обед и зарплата — в справочнике выше
  if (/перерыв/.test(t)) {
    return as('lunch', {
      text: `${faqAnswer('canteen')} Сколько длится перерыв, зависит от графика смены, это скажут на собеседовании.`,
    })
  }

  // «Где собеседование?» — адрес и время HR пишет в приглашении
  if (/(где|куда|адрес|во сколько)[^?]*собесед|собесед[^?]*(где|куда|адрес|во сколько)/.test(t)) {
    return as('interview-where', {
      calls: [call('suggest_action', { action: 'start_application' })],
      compose: () => 'Где и когда собеседование, HR пишет в приглашении вместе с датой, временем и адресом. С собой нужен паспорт.',
    })
  }

  if (/(что|чего)\s+(взять|брать|принести|нужно взять|с собой)|(взять|брать|принести) на собесед/.test(t) && /собесед|с собой/.test(t)) {
    return as('bring', {
      text: faqText('interview-bring', yesNo) || 'Паспорт. Что ещё взять, HR пишет в приглашении на собеседование вместе с датой, временем и адресом.',
    })
  }

  if (/(совмещ|совмест|параллельн).*(уч[её]б|учит|учус|сесси|пар[аыу])|(уч[её]б|учус|учит|сесси).*(совмещ|совмест|параллельн)/.test(t)) {
    return as('study', {
      calls: [call('search_vacancies', {})],
      compose: () =>
        faqText('study', yesNo) ||
        'О зачёте или экзамене предупреди руководителя заранее, и смены на это время не поставят. В сезон экзамены можно сдать прямо на территории предприятия.',
    })
  }

  if (/иностран|гражданств|гражданин|казахстан|киргиз|кыргыз|беларус|белорус|армени|узбек|таджик|азербайдж|молдав|туркмен|снг|еаэс|патент|мигрант/.test(t)) {
    // Страна вне ЕАЭС названа — с неё и начинаем: «я из узбекистана» ждёт ответа про Узбекистан
    const outside = ([[/узбек/, 'Узбекистана'], [/таджик/, 'Таджикистана'], [/азербайдж/, 'Азербайджана'], [/молдав/, 'Молдовы'], [/туркмен/, 'Туркменистана']] as const).find(
      ([re]) => re.test(t),
    )?.[1]
    const eaeu = 'Гражданам стран ЕАЭС (Армении, Беларуси, Казахстана и Киргизии) разрешение на работу в России по закону не нужно.'
    return as('citizenship', {
      calls: [call('suggest_action', { action: 'start_application' })],
      compose: () =>
        (outside
          ? `Гражданам ${outside} для работы в России нужны разрешительные документы. ${eaeu}`
          : `${eaeu} Гражданам других стран нужны разрешительные документы.`) + '\n\nВ заявке отметь гражданство, и HR скажет, какие документы понадобятся.',
    })
  }

  if (/ночн|ночью|ночь|ночам/.test(t) && /плат|оплат|доплат|сколько|деньг/.test(t)) {
    return as('night:pay', {
      calls: [call('search_vacancies', {})],
      compose: () => `Ночные смены оплачиваются по повышенному коэффициенту, точную доплату скажет HR.\n\n${nightAnswer(placeOf(t))}`,
    })
  }

  if (/ночн|ночью|ночь|ночам/.test(t)) {
    const place = placeOf(t)
    return as('night', {
      calls: [call('search_vacancies', place?.department ? { department: place.department } : {})],
      compose: () => nightAnswer(place, yesNo),
    })
  }

  if (REMOTE.test(t)) {
    const hybrid = vacancies.filter((v) => /гибрид/i.test(v.schedule))
    return as('remote', {
      calls: hybrid.slice(0, 3).map((v) => call('suggest_action', { action: 'open_vacancy', vacancy_id: v.id })),
      compose: () =>
        'Удалённой работы в вакансиях нет: в цехах, лаборатории, на складе и в магазине работают на месте.' +
        (hybrid.length ? ` Гибридный график есть в вакансиях ${titles(hybrid)}.` : '') +
        (/практик|стажир/.test(t) ? ' Бесплатную практику согласуют с компанией и вузом или колледжем, формат обсуждают при договорённости.' : ''),
    })
  }

  if (OFFICIAL.test(t)) {
    // «Зп белая?» — да; «в конверте?», «серая?» — нет: ответ на сам вопрос, а не на «официально ли»
    const grey = /конверт|сер(ая|ую|ой)|черн/.test(t)
    return as('official', {
      text: `${grey ? 'Нет, всё официально' : 'Да, официально'}: трудовой договор по ТК РФ (на практике срочный), трудовая книжка электронная. Зарплата приходит два раза в месяц, ${PAY_DAYS[0]}-го и ${PAY_DAYS[1]}-го.`,
    })
  }

  if (DMS.test(t)) {
    // В материалах «Очаково» о практике ДМС нет — не обещаем, называем то, что есть, и вопрос — к HR
    return as('dms', {
      calls: [call('escalate_to_hr', { topic: TOPIC.dms })],
      compose: () =>
        `В условиях практики ДМС не указан, спроси о нём в отделе подбора: ${contactLine}.\n\n` +
        `Что точно есть: медосмотр и спецодежда за счёт компании, половина стоимости обеда, общежитие для студентов по ${rub(dorm.priceStudent)} за койко-место.`,
    })
  }

  if (LOAD.test(t)) {
    const lifting = vacancies.filter((v) => v.tasks.some((x) => /погрузк|разгрузк/i.test(x)))
    return as('load', {
      text:
        `Зависит от позиции: в цехах, лаборатории, на складе и в магазине смены по 12 часов${lifting.length ? `, а у позиции ${titles(lifting)} в задачах разгрузка продукции` : ''}.\n\n` +
        'Бесплатную практику проходят по договорённости. Какая нагрузка на конкретной позиции, расскажут на собеседовании.',
    })
  }

  if (/портфол|behance|беханс|github|гитхаб/.test(t)) {
    // Кнопки — вакансии, где в заявке спрашивают портфолио
    const office = vacancies.filter(asksPortfolio).slice(0, 3)
    return as('portfolio', {
      calls: office.map((v) => call('suggest_action', { action: 'open_vacancy', vacancy_id: v.id })),
      compose: () => portfolioAnswer(t),
    })
  }

  if (/мед\.?\s*книж|медкниж|медицинск[а-я]*\s*книж|сан\.?\s*книж|санкниж|санитарн[а-я]*\s*книж/.test(t)) {
    // Кто платит и сколько стоит — в наших данных этого нет: честно и к HR, вопрос записываем для базы
    if (/(кто|сколько).*(плат|оплач|стоит|компенс)|за\s+(свой|сво[иё]|ч[её]й|сч[её]т)\s*(сч[её]т|компани|завод)?|плат(ит|ят|н)|оплач|бесплатн|стоимост|компенс|возмест|за деньги/.test(t)) {
      const cost = `Кто оплачивает медкнижку, в моих данных нет. Это скажет HR на звонке после заявки или в отделе персонала: ${contactLine}.`
      // «Нужна ли медкнижка и кто платит» — сначала где нужна, потом про оплату
      const needs = /нужн|надо|обязательн/.test(t)
      return as('medbook:cost', {
        calls: [call('escalate_to_hr', { topic: TOPIC.medbookCost })],
        compose: () => (needs ? `${medBookAnswer(named)}\n\n${cost}` : `${cost} Откликнуться можно и без неё: в заявке есть вариант «Оформлю до выхода».`),
      })
    }
    return as('medbook', {
      calls: [call('suggest_action', { action: 'start_application', ...(named ? { vacancy_id: named } : {}) })],
      compose: () => medBookAnswer(named),
    })
  }

  // «Какие вакансии есть» — сколько всего, три с лучшей зарплатой и ссылка на список
  if (/(как(ие|ая)|что)\s+(есть\s+)?(ваканси|работ[ауы]?\s+есть|работ[ау]?\s+(у вас|предлагаете))|список ваканси|все ваканси|покажи ваканси|ваканси[ия]?\s+(есть|какие)|есть ли ваканси|есть ваканси/.test(t) && !namedV) {
    const top = vacancies.filter((v) => v.pay && !v.pay.estimate).sort((a, b) => b.pay!.from - a.pay!.from).slice(0, 3)
    const more = vacancies.length - top.length
    return as('vacancies', {
      calls: [call('suggest_action', { action: 'open_vacancies' }), call('suggest_action', { action: 'start_quiz' })],
      compose: () =>
        `Сейчас есть ${vacancies.length} ${plural(vacancies.length, 'вакансия', 'вакансии', 'вакансий')}: оплачиваемая практика в цехах, лаборатории и на складе, бесплатная практика по договорённости и работа в фирменном магазине и мерчандайзером.\n` +
        `${briefList(top)}\nЕщё ${more} в общем списке.\n\nПодобрать вакансию под учёбу и свободные месяцы поможет «Подбор работы» из четырёх вопросов.`,
    })
  }

  // «Работа для студентов есть?», «я студент, хочу подработку»
  if (/для студент|студент[а-я]*\s+(берете|берут|возьмете|подойдет|можно)|(?<![а-я])я студент|подработк/.test(t) && !namedV && !monthsFrom(t).length) {
    return as('students', {
      calls: [call('suggest_action', { action: 'start_quiz' }), call('suggest_action', { action: 'open_vacancies' })],
      compose: () =>
        `${yesNo ? 'Да, ' : ''}${yesNo ? 'берут' : 'Берут'} студентов колледжей и вузов и выпускников с 18 лет: оплачиваемая практика от ${rub(minMonthlyPay)} в месяц, бесплатная практика по договорённости и работа в фирменном магазине. ` +
        'К каждому новичку прикрепляют наставника.\n\nПодобрать вакансию под учёбу и свободные месяцы поможет «Подбор работы» из четырёх вопросов.',
    })
  }

  // «Без опыта на склад?» — сначала требование названной вакансии
  if (namedV && /опыт/.test(t) && !MONEY.test(t)) {
    const open = vacancies.filter((v) => /без опыта/i.test(v.requirements))
    return as('experience', {
      calls: [call('suggest_action', { action: 'open_vacancy', vacancy_id: namedV.id }), ...open.slice(0, 2).map((v) => call('suggest_action', { action: 'open_vacancy', vacancy_id: v.id }))],
      compose: () =>
        `${namedV.title}: ${lowerFirst(namedV.requirements)}.` +
        (open.some((v) => v.id === namedV.id) ? '' : `\n\nБез опыта берут на позиции ${titles(open)} и учат на месте.`),
    })
  }

  // «Есть практика?», «какие стажировки есть» — ответ про практику. Бумаги практики — выше
  if (/практик/.test(t) && !namedV && !busyWithPractice && !studyFrom(t)) return practicePlan(t, false)
  // Отдельных стажировок нет: у «Очаково» оплачиваемая и бесплатная практика — ответ про практику
  if (/стажировк/.test(t) && !namedV && !studyFrom(t) && !monthsFrom(t).length) return practicePlan(t, false)

  const study = studyFrom(t)
  if (study || /свобод[еа]н|могу работать|есть время/.test(t)) {
    const { wanted: months } = monthsWanted(t)
    const noExperience = /без опыта|нет опыта|опыта нет/.test(t)
    return as('profile', {
      calls: [
        call('save_profile', {
          ...(study ? { study_field: study.replace(/^(на|в|по)\s+/, '') } : {}),
          ...(months.length ? { months } : {}),
          ...(noExperience ? { no_experience: true } : {}),
        }),
      ],
      compose: (r) => {
        const list = summaryOf(r, 'save_profile')
        const data = r.find((x) => x.name === 'save_profile')?.result as { any_exact?: boolean; by_study?: boolean } | undefined
        if (!list) return 'Под эти условия вакансий сейчас нет. Пройди подбор работы из четырёх вопросов или посмотри все вакансии.'
        // Учёба названа, а профильных вакансий нет — честно и вакансии, куда берут с любой учёбой
        if (study && !data?.by_study) {
          const where = months.length ? ` ${whenPhrase(months)}` : ''
          return `Профильной вакансии под учёбу ${/^(на|в|по)\s/.test(study) ? study : `«${study}»`} нет. Берут с любой учёбой${where}:\n${list}\n\nМожно откликнуться сразу или пройти подбор работы из четырёх вопросов.`
        }
        const forStudy = study ? ` под учёбу ${study}` : ''
        if (months.length && !data?.any_exact) {
          return `Ровно ${whenPhrase(months)} вакансий нет. Ближе всего${forStudy}:\n${list}\n\nТочный срок работы обсуждают на собеседовании.`
        }
        const when = months.length ? ` ${whenPhrase(months)}` : ''
        const lead = study ? (/^(на|в|по)\s/.test(study) ? `Под учёбу ${study}` : 'Под твоё направление') : 'Под твой запрос'
        return `${lead}${when} подходят:\n${list}\n\nМожно откликнуться сразу или пройти подбор работы из четырёх вопросов.`
      },
    })
  }

  // «Сколько платят без опыта», «скока на руки без опыта» — сначала цифры, «на руки» — первой
  if (MONEY.test(t) && /без опыта|нет опыта|опыта нет/.test(t)) {
    return as('money', {
      calls: [call('search_vacancies', { no_experience: true })],
      compose: (r) => {
        const list = vacanciesOf(r)
          .filter((v) => v.pay && !v.pay.estimate)
          .sort((a, b) => a.pay!.from - b.pay!.from)
        if (!list.length) return `Зарплату без опыта называют на собеседовании.\n\n${summaryOf(r, 'search_vacancies')}`
        const where = (v: VacancyData) => placeOfVacancy[v.id] ?? `на позиции «${v.title}»`
        const tail = `\n\n${summaryOf(r, 'search_vacancies')}\n\nНа старте учит наставник, зарплата приходит два раза в месяц.`
        if (NET.test(t)) {
          // «от 48 700 ₽ в месяц кладовщиком и от 60 900 ₽ в цехе розлива»
          const net = list.map((v, i) => `от ${rub(v.pay!.net_from)}${i === 0 ? ' в месяц' : ''} ${where(v)}`)
          const gross = list.map((v) => `от ${rub(v.pay!.from)}`)
          return `Без опыта на руки выходит ${listOr(net, 'и')}. До вычета налога это ${listOr(gross, 'и')}.${tail}`
        }
        const parts = list.map((v, i) => `от ${rub(v.pay!.from)}${i === 0 ? ' в месяц' : ''} ${where(v)}`)
        const net = rub(Math.min(...list.map((v) => v.pay!.net_from)))
        return `Без опыта платят ${listOr(parts, 'и')}, до вычета налога. На руки от ${net}.${tail}`
      },
    })
  }

  if (/опыт|ничего не умею|первая работа|без навык/.test(t)) {
    return as('experience', {
      calls: [call('search_vacancies', { no_experience: true })],
      compose: (r) =>
        `Опыт не нужен: на практику берут студентов без опыта, к каждому новичку прикрепляют наставника, резюме не обязательно.\n${summaryOf(r, 'search_vacancies')}\n\n` +
        'Опыт от года нужен только мерчандайзеру.',
    })
  }

  // Сроки: «можно только июль и август, в июне практика?», «можно на 2 месяца?», «только летом» —
  // сезонная работа на часть сезона и практики, которые укладываются в названные месяцы
  const { wanted, busy, busyWhat } = monthsWanted(t)
  const asksPeriod = /(только|можно|могу|получится|выйти|работать|подработ|на каникул)/.test(t)
  const countMatch = /(\d+\s*[–—-]\s*\d+|\d+|один|одн[уа]|два|две|три|пар[ау])\s*(месяц|мес(?![а-я]))/.exec(t)
  const periodQuestion = Boolean(countMatch) || /только на лето|только летом|на лето|на каникулы|сколько длится(?!\s+(смен|рабоч|день))|на какой срок/.test(t)
  if (((wanted.length || busy.length) && asksPeriod && !MONEY.test(t)) || periodQuestion) {
    // Без названных месяцев считаем, что речь о лете. «1–2 месяца летом» — срок важнее слова «летом»
    const months = wanted.length ? wanted : [6, 7, 8].filter((m) => !busy.includes(m))
    const count = countMatch?.[1]
    const monthNamed = /март|апрел|(?<![а-я])ма[йя](?![а-я])|июн|июл|август|сентябр/.test(t)
    const byCount = Boolean(count) && !monthNamed
    const when = byCount
      ? /\d\s*[–—-]\s*\d/.test(count!)
        ? `на ${count!.replace(/\s*[–—-]\s*/, '–')} месяца`
        : `на ${countPhrase(count!)}`
      : months.length > 2
        ? monthsText(months)
        : `на ${monthsText(months)}`
    return as('period', {
      calls: [call('search_vacancies', { months, format: 'Оплачиваемая практика' }), call('search_vacancies', { months, max_months: 4 })],
      compose: () => {
        const text = periodAnswer(months, when, busy, busyWhat, !byCount)
        const term = faqAnswer('summer-only') || `Срок работы обсуждают на собеседовании. Спроси в отделе подбора: ${contactLine}.`
        return text ? `${term}\n\n${text}` : term
      },
    })
  }

  if (/сколько лет|со скольки|возраст/.test(t)) {
    return as('age', { text: faqAnswer('age') || 'С 18 лет: студенты колледжей и вузов, выпускники.' })
  }

  if (/больничн|болезн/.test(t)) {
    return as('sick-leave', {
      text: `${yesNo ? 'Да, больничный' : 'Больничный'} оплачивается по закону: работа официальная, по трудовому договору. ${handbookText('health')}`,
    })
  }

  if (/спецодеж|спецовк|униформ|халат|рабоч\S* одежд|(^|[^а-яё])форм[аыуе]?([^а-яё]|$)/.test(t)) {
    // «Нужна своя спецодежда?» — текст из «Вопросов» на сайте; «форму дают?» — что выдаёт работодатель
    const own = /сво[яюе]|свою|купить|покупать|брать|нужн/.test(t) ? faqText('clothes', yesNo) : ''
    return as('uniform', {
      text:
        own ||
        faqText('clothes', true).replace(/^Нет[:,]\s*/, '').replace(/^./, (c) => c.toUpperCase()),
    })
  }

  // Дорога: «есть развозка?», «как добраться от метро», «автобус до завода» — один ответ с маршрутами
  if (/добрат|доехат|доеду|ехать|метро|автобус|развоз|служебн|транспорт|маршрут|остановк|электричк/.test(t)) {
    return as('route', {
      calls: [call('get_contacts')],
      compose: () => routeAnswer(),
    })
  }

  if (/адрес|где завод|где наход|где вы(?![а-я])|в каком районе/.test(t)) {
    return as('address', {
      calls: [call('get_contacts')],
      compose: () => `Адрес завода: ${contacts.address}.\n\n${routeAnswer()}`,
    })
  }

  if (/контакт|(ваш|какой)\s+(телефон|номер)|номер\s+(телефона\s+)?(hr|отдел|кадр)|телефон\s+(hr|отдел|кадр|для связи)|куда (звонить|писать)|позвонить вам|почт[ауы]|e-?mail|связат|whatsapp|вотсап|ватсап/.test(t)) {
    return as('contacts', {
      calls: [call('get_contacts')],
      compose: () => `Отдел персонала: ${contactLine}, WhatsApp ${whatsappText}.\n\nАдрес завода: ${contacts.address}.`,
    })
  }

  // «Устройтесь вдвоём»: ответ из «Вопросов» и сразу кнопка заявки, где есть отметка «Иду с другом»
  if (/(вместе|вдвоем|с друг|с подруг)/.test(t) && /(устро|работ|смен|друг|подруг)/.test(t)) {
    return as('friend', {
      calls: [call('suggest_action', { action: 'start_application' })],
      compose: () => faqText('friend', yesNo),
    })
  }

  if (/(когда|через сколько|как быстро|сколько ждать|долго ждать).*(ответ|позвон|свяж|напиш|перезвон|собеседован)|когда ответят|когда позвонят|собеседовани[ея]\s+когда/.test(t)) {
    const [, call2, interview] = steps
    return as('process', {
      calls: [call('suggest_action', { action: 'start_application' })],
      compose: () =>
        `${responsePromise('call')} после заявки. ${call2.text}\n\n` + `Потом ${lowerFirst(interview.title)}, ${interview.time}: ${lowerFirst(interview.text)}`,
    })
  }

  if (/(?<![а-я])паспорт/.test(t) && !/иностран|гражданств/.test(t)) {
    return as('documents', {
      text: `${yesNo ? 'Да, паспорт нужен' : 'Паспорт нужен'}: его берут на собеседование. Какие ещё документы понадобятся для оформления, HR скажет в приглашении.`,
    })
  }

  if (/документ|справк|снилс/.test(t)) {
    return as('documents', {
      text: 'На собеседование берут паспорт. Какие документы нужны для оформления, HR назовёт в приглашении вместе с датой и адресом.',
    })
  }

  if (/как устро|как попасть|откликнут|заявк|собеседован|оформлен|медкомисс|резюме|устрои|устройств/.test(t)) {
    return as('process', {
      calls: [call('suggest_action', { action: 'start_application' })],
      compose: () => `Начни с заявки, это пара минут, резюме не нужно. Дальше:\n${steps.slice(1).map((s) => `• ${s.title} (${s.time}). ${s.text}`).join('\n')}`,
    })
  }

  // «Сколько платят кладовщику» — только про названную вакансию, без списка остальных
  if (namedV && (MONEY.test(t) || /сколько.*(руб|₽|тыс)/.test(t))) {
    const v = namedV
    return as(`money:${v.id}`, {
      calls: [call('get_vacancy', { vacancy_id: v.id }), call('suggest_action', { action: 'open_vacancies' })],
      compose: () => {
        const who = leadFor[v.id] ?? `На позиции «${v.title}»`
        if (!v.pay) return v.format === 'Бесплатная практика' ? `${v.title}: без оплаты, по договорённости.` : `${who}: зарплату называют на собеседовании. График ${scheduleText(v)}, ${v.period.toLowerCase()}.`
        const gross = shortPay(v)
        const net = v.pay.to ? `${netPay(v.pay.from).toLocaleString('ru-RU')}–${rub(netPay(v.pay.to))}` : `от ${rub(netPay(v.pay.from))}`
        const pay = NET.test(t) ? `платят на руки ${net} в месяц, до вычета налога ${gross}` : `платят ${gross} в месяц до вычета налога, на руки ${net}`
        return `${who} ${pay}${v.payNote ? `, ${v.payNote}` : ''}.\n\nГрафик ${scheduleText(v)}, ${v.period.toLowerCase()}. Зарплата приходит два раза в месяц, 12-го и 27-го.`
      },
    })
  }

  if (MONEY.test(t) || /сколько.*(руб|₽|тыс)/.test(t)) {
    const place = placeOf(t)
    return as(place ? `money:${place.lead}` : 'money', {
      calls: [
        call('search_vacancies', { query: t, ...(place?.department ? { department: place.department } : {}) }),
        ...(place ? [] : [call('suggest_action', { action: 'open_vacancies' })]),
      ],
      compose: (r) => {
        const { focus, list } = onTopic(r, place)
        if (!place) {
          // Без места — как в «Вопросах» на сайте: от минимальной зарплаты до зарплаты на линии
          const lo = vacancies.find((v) => v.pay && !v.pay.estimate && v.pay.from === minMonthlyPay)
          const hi = vacancies.find((v) => v.pay && !v.pay.estimate && (v.pay.to ?? v.pay.from) === maxEntryPay)
          const at = (v: Vacancy | undefined) => (v ? ` ${placeOfVacancy[v.id] ?? `на позиции «${v.title}»`}` : '')
          const lead = NET.test(t)
            ? `На руки выходит от ${rub(netPay(minMonthlyPay))} в месяц${at(lo)} и от ${rub(netPay(maxEntryPay))}${at(hi)}. До вычета налога это от ${rub(minMonthlyPay)} и от ${rub(maxEntryPay)}.`
            : `От ${rub(minMonthlyPay)} в месяц${at(lo)} и от ${rub(maxEntryPay)}${at(hi)}, до вычета налога. На руки от ${rub(netPay(minMonthlyPay))}.`
          const paydays = `Зарплата приходит два раза в месяц, ${PAY_DAYS[0]}-го и ${PAY_DAYS[1]}-го.`
          // Часть составного вопроса — без списка: ответы на остальные части не должны уйти за предел длины
          if (part) return `${lead}\n\n${paydays}`
          // Сначала оплачиваемая практика — от большей суммы к меньшей, как в списке вакансий на сайте
          const top = vacanciesByPay.filter((v) => v.pay && !v.pay.estimate).slice(0, 3)
          const more = vacancies.length - top.length
          const rest = more > 0 ? `\nЕщё ${more} ${plural(more, 'вакансия', 'вакансии', 'вакансий')} в общем списке, среди них бесплатная практика.` : ''
          return `${lead}\n${briefList(top)}${rest}\n\n${paydays}`
        }
        const range = payRange(focus)
        let lead = range ? `${place.lead} платят ${range} в месяц до вычета налога.` : 'Зарплату по этим позициям называют на собеседовании.'
        if (range && NET.test(t)) {
          const real = focus.filter((v) => v.pay && !v.pay.estimate)
          const pool = real.length ? real : focus.filter((v) => v.pay)
          lead = `${place.lead} на руки выходит от ${rub(Math.min(...pool.map((v) => v.pay!.net_from)))} в месяц, до вычета налога ${range}.`
        }
        return `${lead}\n${list}\n\nЗарплата приходит два раза в месяц.`
      },
    })
  }

  if (/график|выходн|во сколько|сколько часов|пятидневк|сменн|какие смены|смены по|длин[аы] смены/.test(t)) {
    const place = placeOf(t)
    // Общий вопрос «какой график» — тот же текст, что в «Условиях» на сайте
    if (!place && !namedV) return as('schedule', { text: scheduleSummary.text })
    if (namedV) {
      return as(`schedule:${namedV.id}`, {
        calls: [call('suggest_action', { action: 'open_vacancy', vacancy_id: namedV.id })],
        compose: () =>
          `${namedV.title}: ${scheduleText(namedV)}, ${namedV.period.toLowerCase()}.\n\n${SCHEDULE_TERMS}`,
      })
    }
    return as(`schedule:${place?.lead ?? ''}`, {
      calls: [call('search_vacancies', { query: t, ...(place?.department ? { department: place.department } : {}) })],
      compose: (r) => {
        const { focus, list } = onTopic(r, place)
        const [first] = focus
        const lead = first ? `${first.title}: ${lowerFirst(first.schedule)}.` : 'Графики зависят от позиции.'
        return `${lead}\n${list}\n\n${SCHEDULE_TERMS}`
      },
    })
  }

  // «Какие задачи у оператора склада», «что делает кладовщик» — задачи названной вакансии
  if (namedV && /задани|задач|обязанност|что (нужно |надо )?делать|что делает|чем занима/.test(t)) {
    return as('duties', {
      calls: [call('get_vacancy', { vacancy_id: namedV.id })],
      compose: () =>
        `${namedV.title}: ${namedV.tasks.map((x) => lowerFirst(x)).join(', ')}. Кого берут: ${lowerFirst(namedV.requirements)}.\n\n` +
        `Зарплата ${shortPay(namedV)} в месяц, график ${scheduleText(namedV)}, ${namedV.period.toLowerCase()}.`,
    })
  }

  const stage = /лаборат|лаборант|анализ/.test(t)
    ? 'lab'
    : /как (делают|варят|готовят)|вар(ят|ка|ить)|сусл/.test(t)
      ? 'brew'
      : /брож|заквас/.test(t)
        ? 'ferment'
        : /розлив|бутылк/.test(t)
          ? 'bottling'
          : /солод|зерн|ячмен|рож(ь|и)/.test(t)
            ? 'malt'
            : /брак|контрол[ья] качеств|отк(?![а-я])/.test(t)
              ? 'qc'
              : /склад|отгруз/.test(t)
                ? 'warehouse'
                : /полк|мерч/.test(t)
                  ? 'shelf'
                  : null
  if (stage) {
    return as('stage', {
      calls: [call('get_stage', { stage })],
      compose: (r) => {
        const data = r[0]?.result as { text: string; next: { text: string } | null } | undefined
        const tour = 'Весь путь от зерна до полки показан в разделе «Путь кваса».'
        if (stage === 'brew' && data?.next) return `${data.text} Потом ${lowerFirst(data.next.text)}\n\n${tour}`
        return `${summaryOf(r, 'get_stage')}\n\n${tour}`
      },
    })
  }

  if (/какую работу|что выбрать|куда пойти|не знаю,? куда|подбер|посоветуй/.test(t)) {
    return as('quiz', {
      calls: [call('suggest_action', { action: 'start_quiz' })],
      compose: () => 'Пройди подбор работы из четырёх вопросов, и я покажу подходящую вакансию с зарплатой. Или напиши, на кого учишься и когда есть время.',
    })
  }

  // Возраст назван и подходит, других тем нет: «мне 27, возьмут?»
  if (age !== null && age >= 18) {
    return as('age', { text: `${yesNo ? 'Да, возраст' : 'Возраст'} подходит: на завод берут с 18 лет.` })
  }

  // База знаний — только при уверенном совпадении. Слабое совпадение не ответ: случайный FAQ хуже честного «не знаю».
  // Часть составного вопроса ищем в базе, только если в ней от трёх значимых слов: «и сколько стоит» — не вопрос к базе.
  // Темы, которых в базе нет совсем (тату, парковка, прописка), в поиск не идут: «тату на линии» — не про розлив
  const gap = gapTopic(t)
  const top = (!part || tokens(t).length >= 3) && !(gap && NO_ANSWER_TOPICS.has(gap)) ? search(t, 1) : []
  if (confident(top[0])) {
    const hit = top[0]
    return as(`kb:${hit.chunk.id}`, {
      calls: [call('search_knowledge', { query: t })],
      compose: (r) => summaryOf(r, 'search_knowledge') || hit.chunk.answer,
    })
  }

  // Реплика без вопроса («ну ок») — приглашаем спросить, а не пишем в пробелы базы
  if (t.split(/\s+/).filter(Boolean).length < 3 && !t.includes('?') && !WORK.test(t)) {
    return as('short', { text: SHORT_TEXT })
  }

  // Не про работу — коротко и обратно к теме. В отдел персонала уходят только вопросы о работе без ответа в базе
  if (!WORK.test(t)) {
    return as('offtopic', {
      calls: [call('suggest_action', { action: 'open_vacancies' }), call('suggest_action', { action: 'start_quiz' })],
      compose: () => OFF_TOPIC_TEXT,
    })
  }

  return unknownPlan(t, gapTopic(t) ?? TOPIC.other)
}

/** Вопрос записывается для HR в «Вопросы к Квасычу» с темой из словаря, но человеку оттуда никто не ответит — говорим, что делать сейчас */
function unknownPlan(_t: string, topic: string): Grouped {
  return as('unknown', {
    calls: [call('escalate_to_hr', { topic }), call('suggest_action', { action: 'start_application' })],
    compose: () => `Точного ответа в моих данных нет. Спроси в отделе персонала: ${contactLine}. Или оставь заявку, и HR позвонит и ответит на вопросы.`,
  })
}

/**
 * Тема без ответа в данных, которую не перебивают слова других тем. Прописка, внешний вид, парковка, отзывы — всегда;
 * «кого берут» — только когда спрашивают, возьмут ли («девушку возьмут на склад?»), а не «я девушка, сколько платят»;
 * правила на смене — телефон, наушники, перекур, но не «телефон учебного центра»
 */
function hardGapTopic(t: string): string | null {
  const topic = gapTopic(t)
  if (topic && ['прописка и регистрация', 'внешний вид', 'парковка', 'отзывы о работе'].includes(topic)) return topic
  if (topic === 'кого берут' && /возьм|берут|бер[её]те|принима|можно|подойд/.test(t)) return topic
  if (/(сидеть|залипать|пользоваться|играть)\s+(в\s+)?(телефон|смартфон)|в\s+(телефоне|смартфоне)|наушник|(?<![а-я])кур(ить|ят|ение)|перекур|вейп|электронк/.test(t)) return 'правила на смене'
  return null
}

/** Как добраться: корпоративный автобус первым (справочник студента), городские маршруты строками */
function routeAnswer(): string {
  const lines = sentences(contacts.route).map((s) => `• ${s.replace(/\.$/, '')}`)
  const ways = /электричк/i.test(contacts.route) ? 'корпоративный автобус, городские автобусы от метро и электричка' : 'корпоративный автобус и городские автобусы от метро'
  const hr = `${contactLine}, WhatsApp ${whatsappText}`
  const tail = `Расписания корпоративного автобуса у меня нет, его подскажут в отделе подбора: ${hr}.`
  return `До завода на ${street} ходят ${ways}:\n${lines.join('\n')}\n\n${tail}`
}

/** Вопрос человека, прошлые вопросы (последний первым) и результаты функций после последнего вопроса */
function readMessages(messages: LlmMessage[]): { question: string; previous: string[]; results: FnResult[] } {
  let question = ''
  const asked: string[] = []
  const results: FnResult[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      if (question) asked.push(question)
      question = m.content
      results.length = 0
    } else if (m.role === 'function') {
      let parsed: { result?: Record<string, unknown>; summary?: string } = {}
      try {
        parsed = JSON.parse(m.content) as typeof parsed
      } catch {
        // результат не JSON — оставим пустым
      }
      results.push({ name: m.name, result: parsed.result ?? {}, summary: parsed.summary ?? '' })
    }
  }
  return { question, previous: asked.reverse(), results }
}

export function offlineProvider(): LlmProvider {
  return {
    name: 'offline',
    async chat(request: ChatRequest): Promise<ChatResult> {
      const { question, previous, results } = readMessages(request.messages)
      const p = plan(question, previous)
      if ('text' in p) return { kind: 'text', content: p.text }
      const next = p.calls[results.length]
      if (next && request.functions?.some((f) => f.name === next.name)) {
        return { kind: 'function_call', call: next, functionsStateId: 'offline', content: '' }
      }
      return { kind: 'text', content: p.compose(results) }
    },
  }
}
