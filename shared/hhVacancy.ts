import { contacts, perks } from './content/content'
import { hasNightShifts, type Vacancy } from './content/vacancies'

// Вакансия «Очаково» → тело запроса POST https://api.hh.ru/vacancies (API работодателя hh.ru).
// Обязательные поля по спецификации api.hh.ru: name, description (HTML), area, professional_roles, type,
// billing_type, vacancy_properties. Значения справочников — из /dictionaries и /professional_roles
// (сверено с ответами https://api.hh.ru/dictionaries и https://api.hh.ru/professional_roles).
// Одна логика для предпросмотра в панели и для отправки с сервера.
//
// Что публикуем: оплачиваемую практику и работу с суммой из источника. Бесплатную практику на hh.ru не выставляем:
// суммы у неё нет, набор идёт через вузы и колледжи по договорённости («Описание практики»).

/** Профессиональные роли hh.ru (справочник /professional_roles) для наших вакансий */
export const hhRoles: Record<string, { id: string; name: string } | undefined> = {
  'bottling-operator': { id: '85', name: 'Оператор производственной линии' },
  'fermentation-assistant': { id: '85', name: 'Оператор производственной линии' },
  'lab-chemist': { id: '168', name: 'Лаборант' },
  'warehouse-operator': { id: '52', name: 'Кладовщик, приемщик товаров' },
  storekeeper: { id: '52', name: 'Кладовщик, приемщик товаров' },
  'automation-intern': { id: '177', name: 'Инженер КИПиА' },
  'microbiologist-intern': { id: '168', name: 'Лаборант' },
  'logistics-planner': { id: '52', name: 'Кладовщик, приемщик товаров' },
  'marketing-intern': { id: '68', name: 'Менеджер по маркетингу, интернет-маркетолог' },
  'store-worker': { id: '97', name: 'Продавец-консультант, продавец-кассир' },
  merchandiser: { id: '77', name: 'Мерчандайзер' },
}

export type HhOptions = {
  /** Регион публикации: 1 — Москва */
  areaId?: string
  /** Адрес из списка адресов работодателя на hh.ru (GET /employers/{id}/addresses) */
  addressId?: string
  /** Вариант публикации из GET /employers/{id}/services/available_publications, например HH_STANDARD */
  property?: string
}

export type HhVacancyPayload = Record<string, unknown> & { name: string; description: string; code: string }

export type HhPreview = {
  payload: HhVacancyPayload
  /** Что мешает публикации — поправить до отправки */
  problems: string[]
  /** На что обратить внимание, но публиковать можно */
  warnings: string[]
}

/** Почему бесплатную практику не публикуем — текст для панели HR */
export const HH_FREE_PRACTICE_PROBLEM = 'Бесплатную практику на hh.ru не публикуем: оплаты нет, набор идёт через вузы, колледжи и сайт'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const li = (s: string) => `<li>${esc(s)}</li>`
const dot = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`)

/** График «2/2 по 12 часов» → справочники work_schedule_by_days, working_hours и work_format */
function schedule(v: Vacancy) {
  const s = v.schedule.toLowerCase()
  const byDays = s.includes('2/2') ? 'TWO_ON_TWO_OFF' : s.includes('5/2') ? 'FIVE_ON_TWO_OFF' : 'OTHER'
  const hours = /12 час/.test(s) ? 'HOURS_12' : /8 час/.test(s) || byDays === 'FIVE_ON_TWO_OFF' ? 'HOURS_8' : s.includes('договорён') ? 'FLEXIBLE' : 'OTHER'
  const format = s.includes('гибрид') ? 'HYBRID' : s.includes('разъезд') ? 'FIELD_WORK' : 'ON_SITE'
  return { byDays, hours, format, night: hasNightShifts(v) }
}

export function toHhVacancy(v: Vacancy, opts: HhOptions = {}): HhPreview {
  const problems: string[] = []
  const warnings: string[] = []
  const role = hhRoles[v.id]
  if (!role) problems.push('Нет подходящей профессиональной роли hh.ru, выбери её в черновике на hh.ru')
  const sch = schedule(v)
  const paidPractice = v.format === 'Оплачиваемая практика'
  const freePractice = v.format === 'Бесплатная практика'
  // Стажировка на hh.ru — практика студентов; старый формат «Стажировка» остался только у сохранённых заявок
  const internship = paidPractice || freePractice || v.format === 'Стажировка'
  // Срочный трудовой договор: оплачиваемая практика («временный трудовой договор» по «Описанию практики») и старая сезонная работа
  const temporary = paidPractice || v.format === 'Сезонная работа'

  const conditions = [
    `График: ${v.schedule}${v.hours ? `. ${v.hours}` : ''}`,
    `Период: ${v.period}`,
    // Что даёт компания на практике — те же строки, что в «Условиях» на сайте (perks в shared/content/content.ts).
    // Строка о зарплате там уже говорит о ночных сменах; у работы — отдельной строкой.
    // Справочник студента: «Ночные смены оплачиваются по повышенному коэффициенту»
    ...(paidPractice ? perks.map((p) => `${p.title}. ${p.text}`) : sch.night ? ['Ночные смены оплачиваются по повышенному коэффициенту'] : []),
    `Адрес: ${contacts.address}`,
    // Маршрут первым называет корпоративный автобус от м. «Озёрная» (справочник студента) — отдельной строкой его не повторяем
    `Как добраться: ${contacts.route.charAt(0).toLowerCase()}${contacts.route.slice(1)}`,
  ]

  const description = [
    `<p>${esc(v.format)} в «Очаково», на московском заводе напитков.</p>`,
    '<p><strong>Чем заниматься:</strong></p>',
    `<ul>${v.tasks.map(li).join('')}</ul>`,
    `<p><strong>Кого ищем:</strong> ${esc(dot(v.requirements))}</p>`,
    '<p><strong>Условия:</strong></p>',
    `<ul>${conditions.map((c) => li(c.replace(/\.$/, ''))).join('')}</ul>`,
    `<p>Вопросы: ${esc(contacts.email)}, ${esc(contacts.phone)}, ${esc(contacts.phoneNote)}.</p>`,
  ].join('')
  if (description.replace(/<[^>]+>/g, '').length < 200) warnings.push('Описание короче 200 знаков, hh.ru может попросить дополнить')

  const payload: HhVacancyPayload = {
    name: v.title,
    code: v.id,
    description,
    area: { id: opts.areaId ?? '1' },
    professional_roles: role ? [{ id: role.id }] : [],
    type: { id: 'open' },
    // billing_type устарел, но обязателен по схеме; при переданных vacancy_properties hh.ru его игнорирует
    billing_type: { id: 'standard' },
    vacancy_properties: { properties: [{ property_type: opts.property ?? 'HH_STANDARD' }] },
    experience: { id: 'noExperience' },
    employment_form: { id: 'FULL' },
    work_format: [{ id: sch.format }],
    work_schedule_by_days: [{ id: sch.byDays }],
    working_hours: [{ id: sch.hours }],
    night_shifts: sch.night,
    internship,
    accept_temporary: temporary,
    accept_incomplete_resumes: true,
    allow_messages: true,
    response_letter_required: false,
  }
  if (opts.addressId) payload.address = { id: opts.addressId, show_metro_only: false }
  else warnings.push('Адрес не задан: укажи HH_ADDRESS_ID из списка адресов работодателя, иначе вакансия выйдет без карты')

  if (freePractice) problems.push(HH_FREE_PRACTICE_PROBLEM)
  else if (v.pay && !v.pay.estimate) {
    payload.salary_range = {
      from: v.pay.from,
      ...(v.pay.to ? { to: v.pay.to } : {}),
      currency: 'RUR',
      gross: true,
      mode: { id: 'MONTH' },
      // Справочник студента: зарплата два раза в месяц, 12-го и 27-го
      frequency: { id: 'TWICE_PER_MONTH' },
    }
  } else if (v.pay?.estimate) {
    problems.push('Зарплата указана как ориентир. Согласуй сумму с отделом персонала до публикации')
  } else warnings.push('Зарплата не указана, а на hh.ru такие вакансии получают меньше откликов')
  if (!freePractice && sch.byDays === 'OTHER') warnings.push(`График «${v.schedule}» не совпал со справочником hh.ru, проверь в черновике`)

  return { payload, problems, warnings }
}
