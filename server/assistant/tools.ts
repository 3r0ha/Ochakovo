import { contacts } from '@shared/content/content'
import { departments, type DepartmentId } from '@shared/content/departments'
import { stages } from '@shared/content/production'
import { formatRub, netPay, scheduleLine, shiftPay, vacancies, vacancyById, vacancyFormats, type Vacancy } from '@shared/content/vacancies'
import type { LlmFunction } from '../llm/provider'
import { confident, knowledgeVersion, payPhrase, search, tokens } from './knowledge'
import type { AssistantAction, AssistantProfile } from './types'

// Функции, которые модель вызывает вместо того, чтобы придумывать факты.
// Каждая возвращает data — JSON для модели — и summary — готовый человеческий текст для офлайн-режима.

export type ToolResult = { data: unknown; summary: string; actions?: AssistantAction[] }

export type ToolContext = {
  profile: AssistantProfile
  actions: AssistantAction[]
  /** Заполняется, если вопрос передан в отдел персонала */
  escalation: { topic: string } | null
  /** Суммы, которые посчитала calc_earnings, — их разрешено называть в ответе */
  amounts: number[]
}

export const newToolContext = (profile: AssistantProfile = {}): ToolContext => ({
  profile: { ...profile },
  actions: [],
  escalation: null,
  amounts: [],
})

// ── Сроки вакансий ────────────────────────────────────────────────────────

const monthIndex: Record<string, number> = { март: 3, апрел: 4, май: 5, мая: 5, июн: 6, июл: 7, август: 8, сентябр: 9 }

function monthFromWord(word: string): number | undefined {
  const w = word.toLowerCase()
  for (const [stem, m] of Object.entries(monthIndex)) if (w.startsWith(stem)) return m
  return undefined
}

/** «С июня по август» → [6, 7, 8]; «Весь сезон» → март–сентябрь */
export function periodMonths(period: string): number[] {
  if (/весь сезон/i.test(period)) return [3, 4, 5, 6, 7, 8, 9]
  const found = (period.match(/[а-яё]+/gi) ?? []).map(monthFromWord).filter((m): m is number => m !== undefined)
  if (!found.length) return [3, 4, 5, 6, 7, 8, 9]
  const from = found[0]
  const to = found.at(-1)!
  const out: number[] = []
  for (let m = from; m <= to; m++) out.push(m)
  return out
}

const monthNames: Record<number, string> = { 3: 'март', 4: 'апрель', 5: 'май', 6: 'июнь', 7: 'июль', 8: 'август', 9: 'сентябрь' }
const monthFrom: Record<number, string> = { 3: 'марта', 4: 'апреля', 5: 'мая', 6: 'июня', 7: 'июля', 8: 'августа', 9: 'сентября' }
/** [6, 7, 8] → «с июня по август», [6, 7] → «июнь и июль» */
export const monthsText = (months: number[]) =>
  months.length > 2 ? `с ${monthFrom[months[0]]} по ${monthNames[months.at(-1)!]}` : months.map((m) => monthNames[m]).join(' и ')

// ── Краткие описания ─────────────────────────────────────────────────────

const noExperience = (v: Vacancy) => /без опыта/i.test(v.requirements)
const isFree = (v: Vacancy) => v.format === 'Бесплатная практика'

/**
 * Срок можно обсудить: оплачиваемая практика идёт с марта или апреля до июля или середины августа, но если человек может
 * только часть срока, его обсуждают на собеседовании («Вопросы» на сайте, summer-only)
 */
export const flexibleTerm = (v: Vacancy) => v.format === 'Оплачиваемая практика'

/** Срок для списка: свой у каждой вакансии; у бесплатной практики — по договорённости. Срок не придумываем под месяцы человека */
export function periodFor(v: Vacancy, _months?: number[]) {
  return v.period.toLowerCase()
}

export const shortPay = (v: Vacancy) => {
  if (!v.pay) return isFree(v) ? 'без оплаты' : 'зарплата по итогам собеседования'
  const range = v.pay.to ? `${v.pay.from.toLocaleString('ru-RU')}–${formatRub(v.pay.to)}` : `от ${formatRub(v.pay.from)}`
  return v.pay.estimate ? `${range} (ориентир)` : range
}

export const schedulePhrase = (s: string) => {
  const t = s.replace(/^Сменный график /, '').replace(/, смены по 12 часов/, ' по 12 часов')
  return t.charAt(0).toLowerCase() + t.slice(1)
}

/** График одной строкой, как на сайте (scheduleLine): ночные смены не прячутся — «2/2 по 12 часов, бывают ночные смены» */
export const scheduleText = (v: Vacancy) => schedulePhrase(scheduleLine(v)).replace(/\s*·\s*/g, ', ')

const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * Пункт списка вакансий — короткими строками, каждая про своё:
 * «**Кладовщик** · от 56 000 ₽», ниже график, ещё ниже срок. У бесплатной практики — «без оплаты», график и срок по договорённости.
 * ** — жирный и на сайте (src/components/chat/Message.tsx), и в Telegram и MAX (server/channels/render.ts).
 * Строки подробностей без точки в конце — по ним офлайн-режим узнаёт, где кончается пункт (capLists).
 * period — свой текст срока или false, если срок уже назван в заголовке
 */
export const vacancyBrief = (v: Vacancy, period: string | false = v.period.toLowerCase()) =>
  isFree(v)
    ? `**${v.title}** · без оплаты\nГрафик и срок по договорённости`
    : `**${v.title}** · ${shortPay(v)}\n${upperFirst(scheduleText(v))}${period ? `\n${upperFirst(period)}` : ''}`

const vacancyData = (v: Vacancy) => ({
  id: v.id,
  title: v.title,
  department: departments[v.department].name,
  format: v.format,
  schedule: scheduleLine(v),
  period: v.period,
  pay: v.pay ? { from: v.pay.from, to: v.pay.to ?? null, net_from: netPay(v.pay.from), estimate: Boolean(v.pay.estimate) } : null,
  pay_text: payPhrase(v),
  /** На руки за смену и в час — только у графика 2/2 по 12 часов, те же числа, что в «Собери лето» */
  shift_pay: shiftPay(v),
  requirements: v.requirements,
  no_experience: noExperience(v),
  /** Срок практики обсуждают на собеседовании, если человек может только часть срока */
  flexible_term: flexibleTerm(v),
})

// ── Поиск вакансий ────────────────────────────────────────────────────────

type VacancyQuery = {
  query?: string
  department?: DepartmentId
  no_experience?: boolean
  months?: number[]
  format?: string
  /** Только вакансии, рассчитанные не больше чем на столько месяцев */
  max_months?: number
}

export function rankVacancies(q: VacancyQuery): Vacancy[] {
  const words = q.query ? tokens(q.query) : []
  const scored = vacancies
    .filter((v) => (q.department ? v.department === q.department : true))
    .filter((v) => (q.format ? v.format === q.format : true))
    .filter((v) => (q.no_experience ? noExperience(v) : true))
    .filter((v) => (q.max_months ? periodMonths(v.period).length <= q.max_months : true))
    .map((v) => {
      let score = 0
      if (words.length) {
        const title = new Set(tokens(v.title))
        const dept = new Set(tokens(`${departments[v.department].name} ${departments[v.department].lead}`))
        const body = new Set(tokens(`${v.tasks.join(' ')} ${v.requirements}`))
        for (const w of words) score += title.has(w) ? 3 : dept.has(w) ? 2 : body.has(w) ? 1 : 0
      }
      if (q.months?.length) {
        const span = periodMonths(v.period)
        score += q.months.every((m) => span.includes(m)) ? 1.5 : q.months.some((m) => span.includes(m)) ? 0.5 : -2
        // Кто называет конкретные месяцы, обычно ищет работу на короткий срок
        if (span.length <= 4) score += 1
      }
      if (v.pay && !v.pay.estimate) score += 0.2
      return { v, score }
    })
  const anyMatch = words.length > 0 && scored.some((s) => s.score >= 1)
  return scored
    .filter((s) => (anyMatch ? s.score >= 1 : true))
    .sort((a, b) => b.score - a.score)
    .map((s) => s.v)
}

// ── Подбор по профилю: модель только извлекает профиль, ранжирует наш код ──

const studyMap: [RegExp, Record<string, number>][] = [
  [/технолог|пищев/, { 'fermentation-assistant': 3, 'lab-chemist': 2, 'bottling-operator': 1 }],
  [/хими|биотех|биолог|микробиолог/, { 'lab-chemist': 3, 'microbiologist-intern': 3, 'fermentation-assistant': 1 }],
  // Инженеры, механики, автоматизация и IT — бесплатная практика с инженерами («Описание практики»: оцифровка линии, работа в паре с инженером)
  [/механ|машиностро|мехатрон|инженер|автомат|электр|кипиа|прибор|энергет/, { 'automation-intern': 3, 'bottling-operator': 1 }],
  [/(?<![a-zа-я])it(?![a-zа-я])|айти|программ|информат|данн|sql|python|разработ/, { 'automation-intern': 3 }],
  [/логист|экономи|менеджм|менеджер|управлени|снабжен/, { 'logistics-planner': 3, 'warehouse-operator': 2, storekeeper: 2 }],
  [/маркетинг|маркетолог|реклам|(?<![a-z])pr(?![a-z])|пиар|журналист|smm|дизайн|медиа/, { 'marketing-intern': 3, merchandiser: 1 }],
  // HR, история, психология, педагогика — практика в офисе: электронный курс, архив, ролики о профессиях
  [/(?<![a-z])hr(?![a-z])|персонал|психолог|кадр|истор|архив|педагог|гуманит|культур|лингв|туризм/, { 'marketing-intern': 3 }],
  [/торгов|продаж|коммерц/, { merchandiser: 2, 'store-worker': 1 }],
]

/** Берут с любой учёбой: без опыта, «любое направление», «колледжи любого профиля» */
const openToAnyField = (v: Vacancy) => /без опыта|любое направление|любого профиля/i.test(v.requirements)

/** exact — срок вакансии целиком внутри названных месяцев */
export type ProfileMatch = { vacancy: Vacancy; score: number; reasons: string[]; exact: boolean }

export function matchProfile(p: AssistantProfile): ProfileMatch[] {
  const field = (p.studyField ?? '').toLowerCase()
  const interests = (p.interests ?? []).join(' ').toLowerCase()
  const weights: Record<string, number> = {}
  for (const [re, w] of studyMap) if (re.test(field)) for (const [id, n] of Object.entries(w)) weights[id] = (weights[id] ?? 0) + n
  const interestWords = tokens(interests)

  return vacancies
    .map((v) => {
      const reasons: string[] = []
      let score = 0
      if (weights[v.id]) {
        score += weights[v.id]
        reasons.push('подходит по учёбе')
      } else if (field && !openToAnyField(v)) {
        // Учёба названа и не подходит — или незнакома: практика микробиолога историку и юристу не нужна, даже если совпали месяцы
        score -= 3
      }
      if (interestWords.length) {
        const body = new Set(tokens(`${v.title} ${v.tasks.join(' ')} ${departments[v.department].name}`))
        const hit = interestWords.filter((w) => body.has(w)).length
        if (hit) {
          score += hit
          reasons.push('совпадает с интересами')
        }
      }
      let exact = false
      if (p.months?.length) {
        const span = periodMonths(v.period)
        const covers = p.months.every((m) => span.includes(m))
        const overlaps = p.months.some((m) => span.includes(m))
        // Вакансии без пересечения с названными месяцами не предлагаем вовсе
        if (!overlaps) return { vacancy: v, score: -Infinity, reasons, exact }
        // Ровно в названные месяцы: срок целиком внутри них. Срок оплачиваемой практики обсуждают — подходит и на часть
        const inside = span.every((m) => p.months!.includes(m))
        exact = covers && (inside || flexibleTerm(v))
        const extra = span.length - p.months.length
        if (covers && inside) score += 3
        else if (covers && flexibleTerm(v)) score += 2
        else if (covers) score += 2 - 0.5 * extra
        if (covers && (inside || flexibleTerm(v) || extra <= 1)) reasons.push(`по срокам: ${periodFor(v, p.months)}`)
      }
      if (p.noExperience) {
        if (noExperience(v)) {
          score += 1.5
          reasons.push('без опыта')
        } else if (/опыт/i.test(v.requirements)) score -= 2
      }
      if (v.pay && !v.pay.estimate) score += 0.1
      return { vacancy: v, score, reasons, exact }
    })
    .filter((m) => m.score > 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
}

// ── Определения функций для модели ───────────────────────────────────────

/**
 * Определения функций для модели. Списки вакансий и этапов — из текущих данных: после правки вакансий в панели
 * (rebuildKnowledge) пересобираются вместе с базой знаний
 */
function buildFunctionDefs(): LlmFunction[] {
  const vacancyIds = vacancies.map((v) => v.id)
  const stageIds = stages.map((s) => s.id)
  return [
    {
      name: 'search_vacancies',
      description:
        'Найти вакансии «Очаково» с зарплатами, графиком и сроками. Вызывай, когда спрашивают про работу, зарплату, график или конкретное направление.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Что ищет человек: «склад», «лаборатория», «линия розлива», «маркетинг»' },
          department: { type: 'string', enum: Object.keys(departments), description: 'Направление, если оно понятно' },
          no_experience: { type: 'boolean', description: 'Только вакансии без опыта' },
          months: { type: 'array', items: { type: 'integer' }, description: 'Месяцы 3–9, когда человек может работать' },
          format: { type: 'string', enum: vacancyFormats, description: 'Формат работы' },
          max_months: { type: 'integer', description: 'Только вакансии на короткий срок: не больше стольких месяцев' },
        },
      },
      few_shot_examples: [
        { request: 'Сколько платят на складе?', params: { query: 'склад' } },
        { request: 'Есть работа без опыта?', params: { no_experience: true } },
        { request: 'Можно поработать только два месяца летом?', params: { max_months: 4 } },
      ],
    },
    {
      name: 'get_vacancy',
      description: 'Подробности одной вакансии: задачи, требования, зарплата до вычета и на руки.',
      parameters: { type: 'object', properties: { vacancy_id: { type: 'string', enum: vacancyIds } }, required: ['vacancy_id'] },
    },
    {
      name: 'calc_earnings',
      description: 'Посчитать заработок за несколько месяцев на вакансии: до вычета налога и на руки. Не считай сам, вызывай эту функцию.',
      parameters: {
        type: 'object',
        properties: {
          vacancy_id: { type: 'string', enum: vacancyIds },
          months: { type: 'integer', description: 'Сколько месяцев работы, от 1 до 7' },
        },
        required: ['vacancy_id', 'months'],
      },
      few_shot_examples: [{ request: 'Сколько заработаю за лето оператором линии?', params: { vacancy_id: 'bottling-operator', months: 3 } }],
    },
    {
      name: 'get_stage',
      description: 'Как устроен этап производства кваса и кто на нём работает.',
      parameters: { type: 'object', properties: { stage: { type: 'string', enum: stageIds } }, required: ['stage'] },
      few_shot_examples: [{ request: 'Что делают в лаборатории?', params: { stage: 'lab' } }],
    },
    {
      name: 'get_contacts',
      description: 'Адрес завода, как добраться и контакты отдела персонала.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'save_profile',
      description:
        'Запомнить, что человек рассказал о себе, и подобрать подходящие вакансии. Вызывай, когда человек описывает учёбу, сроки или интересы. Имя и телефон не передавай.',
      parameters: {
        type: 'object',
        properties: {
          study_field: { type: 'string', description: 'На кого учится: «технолог», «химик», «маркетинг»' },
          months: { type: 'array', items: { type: 'integer' }, description: 'Месяцы 3–9; «летом» значит 6, 7, 8' },
          interests: { type: 'array', items: { type: 'string' }, description: 'Что интересно: «техника», «работа с людьми»' },
          district: { type: 'string', description: 'Район или город, если человек его назвал' },
          no_experience: { type: 'boolean', description: 'Нет опыта работы' },
        },
      },
      few_shot_examples: [{ request: 'Учусь на технолога, свободен летом', params: { study_field: 'технолог', months: [6, 7, 8] } }],
    },
    {
      name: 'search_knowledge',
      description: 'Найти ответ в базе знаний: условия, общежитие, возраст, как устроиться, история завода.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
    {
      name: 'suggest_action',
      description: 'Показать кнопку с действием под ответом.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['open_vacancy', 'calc_earnings', 'start_application', 'start_quiz', 'open_vacancies', 'start_tour', 'start_game'],
          },
          vacancy_id: { type: 'string', enum: vacancyIds },
        },
        required: ['action'],
      },
    },
    {
      name: 'escalate_to_hr',
      description:
        'Записать вопрос о работе на заводе, на который нет ответа в базе знаний: HR увидит его в списке «Вопросы к Квасычу» и дополнит базу. Человеку оттуда никто не ответит, поэтому не пиши «передал вопрос»: дай контакт отдела персонала и предложи оставить заявку, на звонке HR ответит на вопросы. Не вызывай для посторонних тем: стихов, шуток, погоды, учёбы.',
      parameters: { type: 'object', properties: { topic: { type: 'string', description: 'Тема вопроса в двух-трёх словах' } }, required: ['topic'] },
    },
  ]
}

let defs: { key: string; list: LlmFunction[] } | null = null

/** Функции для запроса к модели — одинаковые байты, пока не поменялась база знаний */
export function functionDefinitions(): LlmFunction[] {
  const key = knowledgeVersion()
  if (defs?.key !== key) defs = { key, list: buildFunctionDefs() }
  return defs.list
}

/** Определения на момент загрузки — для проверок; цикл помощника берёт functionDefinitions() */
export const functionDefs: LlmFunction[] = functionDefinitions()

// ── Выполнение функций ───────────────────────────────────────────────────

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const intList = (v: unknown) =>
  Array.isArray(v) ? [...new Set(v.map(Number).filter((m) => Number.isInteger(m) && m >= 3 && m <= 9))].sort((a, b) => a - b) : []

const contactText = `Отдел персонала: ${contacts.email}, ${contacts.phone} (${contacts.phoneNote}).`

/** 79031537740 → +7 903 153-77-40 */
const whatsappText = contacts.whatsapp.replace(/^7(\d{3})(\d{3})(\d{2})(\d{2})$/, '+7 $1 $2-$3-$4')

function addActions(ctx: ToolContext, actions: AssistantAction[]) {
  for (const a of actions) {
    const key = JSON.stringify(a)
    if (!ctx.actions.some((x) => JSON.stringify(x) === key)) ctx.actions.push(a)
  }
}

const tools: Record<string, (args: Record<string, unknown>, ctx: ToolContext) => ToolResult> = {
  search_vacancies(args) {
    const department = str(args.department) as DepartmentId
    const found = rankVacancies({
      query: str(args.query) || undefined,
      department: department in departments ? department : undefined,
      no_experience: args.no_experience === true,
      months: intList(args.months),
      format: vacancyFormats.includes(str(args.format) as never) ? str(args.format) : undefined,
      max_months: Number.isInteger(args.max_months) && (args.max_months as number) > 0 ? (args.max_months as number) : undefined,
    }).slice(0, 4)
    return {
      data: {
        vacancies: found.map(vacancyData),
        note:
          'Суммы до вычета НДФЛ, сумма на руки в net_from, выплаты два раза в месяц, 12-го и 27-го. У бесплатной практики оплаты нет. Если человек может только часть срока практики (flexible_term), срок обсуждают на собеседовании, не обещай «можно на июнь, июль и август».',
      },
      summary: found.map((v) => vacancyBrief(v)).join('\n'),
      actions: found.slice(0, 3).map((v) => ({ type: 'open_vacancy', vacancyId: v.id })),
    }
  },

  get_vacancy(args) {
    const v = vacancyById(str(args.vacancy_id))
    if (!v) return { data: { error: 'Нет такой вакансии' }, summary: '' }
    const when = isFree(v) ? 'График и срок по договорённости' : `График ${scheduleText(v)}, ${v.period.toLowerCase()}`
    return {
      data: { ...vacancyData(v), tasks: v.tasks },
      summary: `${v.title}: ${payPhrase(v)}. ${when}. ${v.requirements}.`,
      actions: [{ type: 'open_vacancy', vacancyId: v.id }, { type: 'start_application', vacancyId: v.id }],
    }
  },

  calc_earnings(args, ctx) {
    const v = vacancyById(str(args.vacancy_id))
    const months = Math.min(7, Math.max(1, Math.round(Number(args.months) || 3)))
    if (!v?.pay) return { data: { error: v && isFree(v) ? 'Бесплатная практика не оплачивается' : 'Для этой вакансии зарплата не указана' }, summary: '' }
    const from = v.pay.from * months
    const to = v.pay.to ? v.pay.to * months : null
    const range = to ? `${from.toLocaleString('ru-RU')}–${formatRub(to)}` : `от ${formatRub(from)}`
    ctx.amounts.push(from, netPay(from), ...(to ? [to, netPay(to)] : []))
    const note = v.pay.estimate ? ' Это ориентир: точную сумму назовут на собеседовании.' : ''
    return {
      data: { vacancy: v.title, months, gross_from: from, gross_to: to, net_from: netPay(from), net_to: to ? netPay(to) : null, estimate: Boolean(v.pay.estimate) },
      summary: `За ${months} ${months === 1 ? 'месяц' : months < 5 ? 'месяца' : 'месяцев'} на позиции «${v.title}» выйдет ${range} до вычета налога, на руки от ${formatRub(netPay(from))}.${note}`,
      actions: [{ type: 'calc_earnings', vacancyId: v.id }, { type: 'start_application', vacancyId: v.id }],
    }
  },

  get_stage(args) {
    const i = Math.max(0, stages.findIndex((s) => s.id === str(args.stage)))
    const s = stages[i]
    const next = stages[i + 1]
    const people = s.vacancies.map((id) => vacancyById(id)).filter((v): v is Vacancy => Boolean(v))
    return {
      data: {
        stage: s.title,
        text: s.text,
        next: next ? { stage: next.title, text: next.text } : null,
        vacancies: people.map(vacancyData),
      },
      summary: `${s.text}\n\nЗдесь работают:\n${people.map((v) => `• ${v.title}: ${shortPay(v)}, ${v.period.toLowerCase()}`).join('\n')}`,
      actions: [...people.slice(0, 2).map((v) => ({ type: 'open_vacancy' as const, vacancyId: v.id })), { type: 'start_tour', stage: i }],
    }
  },

  get_contacts() {
    // Маршруты — дословно с ochakovo.ru/kontakty (contacts.route); расписания в данных нет
    return {
      data: { ...contacts, transport: contacts.route },
      summary: `Адрес завода: ${contacts.address}. ${contacts.route}\n\n${contactText} WhatsApp: ${whatsappText}.`,
    }
  },

  save_profile(args, ctx) {
    const update: AssistantProfile = {}
    if (str(args.study_field)) update.studyField = str(args.study_field).slice(0, 80)
    const months = intList(args.months)
    if (months.length) update.months = months
    if (Array.isArray(args.interests)) update.interests = args.interests.map(str).filter(Boolean).slice(0, 5)
    if (str(args.district)) update.district = str(args.district).slice(0, 60)
    if (typeof args.no_experience === 'boolean') update.noExperience = args.no_experience
    ctx.profile = { ...ctx.profile, ...update }
    const matches = matchProfile(ctx.profile)
    return {
      data: {
        profile: ctx.profile,
        matches: matches.map((m) => ({ ...vacancyData(m.vacancy), reasons: m.reasons, fits_months_exactly: m.exact })),
        any_exact: matches.some((m) => m.exact),
        /** Есть ли среди подобранных вакансии по учёбе — или только те, куда берут с любой учёбой */
        by_study: matches.some((m) => m.reasons.includes('подходит по учёбе')),
        note: 'Список составлен по данным вакансий. Если any_exact = false, прямо скажи, что ровно на названные месяцы вакансий нет, и предложи ближайшие.',
      },
      summary: matches.map((m) => `${vacancyBrief(m.vacancy, periodFor(m.vacancy, ctx.profile.months))}\n${m.vacancy.requirements}`).join('\n'),
      actions: [
        ...matches.slice(0, 2).map((m) => ({ type: 'open_vacancy' as const, vacancyId: m.vacancy.id })),
        { type: 'start_quiz' },
      ],
    }
  },

  search_knowledge(args) {
    // Слабое совпадение — не ответ: модель должна передать вопрос в отдел персонала
    const hits = search(str(args.query), 2).filter(confident)
    return {
      data: { found: hits.map((h) => ({ title: h.chunk.title, text: h.chunk.text })) },
      // Человеку — один лучший фрагмент и только ответ, без повторения вопроса
      summary: hits[0]?.chunk.answer ?? '',
    }
  },

  suggest_action(args, ctx) {
    const type = str(args.action) as AssistantAction['type']
    const id = vacancyById(str(args.vacancy_id))?.id
    const action: AssistantAction | null =
      type === 'open_vacancy' && id
        ? { type, vacancyId: id }
        : type === 'calc_earnings' || type === 'start_application'
          ? { type, ...(id ? { vacancyId: id } : {}) }
          : type === 'start_quiz' || type === 'open_vacancies' || type === 'start_game'
            ? { type }
            : type === 'start_tour'
              ? { type }
              : null
    if (action) addActions(ctx, [action])
    return { data: { ok: Boolean(action) }, summary: '' }
  },

  escalate_to_hr(args, ctx) {
    ctx.escalation = { topic: str(args.topic).slice(0, 80) || 'вопрос' }
    return {
      data: { logged_for_hr: true, person_gets_reply: false, contacts: contactText, next_step: 'Связаться с отделом персонала или оставить заявку: HR позвонит и ответит на вопросы' },
      summary: `Точного ответа в моих данных нет. ${contactText} Ещё можно оставить заявку: HR позвонит и ответит на вопросы.`,
    }
  },
}

export function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const tool = tools[name]
  if (!tool) return { data: { error: `Нет функции ${name}` }, summary: '' }
  const result = tool(args, ctx)
  if (result.actions) addActions(ctx, result.actions)
  return result
}
