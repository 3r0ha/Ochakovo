import { brandPlatform, brandsLine, companySummary, timeline } from '@shared/content/company'
import { contacts, myths, perks, phonebook, phoneLine, steps } from '@shared/content/content'
import { departments } from '@shared/content/departments'
import { faq } from '@shared/content/faq'
import { canteen, dorm, handbook, SEASON } from '@shared/content/handbook'
import { freePracticeInfo, paidPracticeInfo } from '@shared/content/practice'
import { PLANT_BOTTLES_PER_HOUR, stages } from '@shared/content/production'
import { asksPortfolio, formatRub, hasNightShifts, needsMedBook, netPay, payLabel, scheduleLine, vacancies, type Vacancy } from '@shared/content/vacancies'
import { hrAnswerList, hrAnswersVersion, setTermWeight } from './hrAnswers'
import { stem, tokens } from './text'

// База знаний помощника. Собирается из shared/ — тех же данных, что на сайте и в боте:
// вакансии и практика («Описание практики»), условия и быт («Справочник студента»), история и бренды (каталог продукции).
// knowledgeText() — неизменный текст для системного промпта: одинаковые байты в каждом запросе,
// поэтому GigaChat кэширует его и не берёт за него деньги повторно. Текст меняется, только когда HR одобрил новый ответ
// или вакансии поправили в панели (rebuildKnowledge) — тогда сбрасываются кэш текста и системного промпта.
// search() — поиск фрагментов для офлайн-режима и функции search_knowledge.

export { stem, tokens }

export type Chunk = {
  id: string
  title: string
  /** Полный текст для поиска и для модели */
  text: string
  /** Готовый ответ человеку — без повторения вопроса */
  answer: string
}

/** Зарплата словами: «от 70 000 ₽ в месяц до вычета налога, на руки от 60 900 ₽»; у бесплатной практики — «без оплаты» */
export function payPhrase(v: Vacancy) {
  if (!v.pay) return v.format === 'Бесплатная практика' ? 'без оплаты, по договорённости' : 'зарплата по итогам собеседования'
  const net = `на руки от ${formatRub(netPay(v.pay.from))}`
  const night = v.payNote ? `, ${v.payNote}` : ''
  const note = v.pay.estimate ? ', это ориентир, точную сумму назовут на собеседовании' : ''
  return `${payLabel(v)} в месяц до вычета налога, ${net}${night}${note}`
}

// Без технических id: модель повторяет их в ответе. id вакансий она видит в описании функций
const vacancyLine = (v: Vacancy) =>
  `${v.title}: ${v.unit ?? departments[v.department].name}, ${v.format.toLowerCase()}. ` +
  `${v.pay || v.format !== 'Бесплатная практика' ? `Зарплата ${payPhrase(v)}` : 'Без оплаты'}. График: ${scheduleLine(v)}${v.hours ? `, ${v.hours.toLowerCase()}` : ''}. Срок: ${v.period.toLowerCase()}. ` +
  `Задачи: ${v.tasks.join('; ').toLowerCase()}. Кого берут: ${v.requirements}.`

/** Ответ человеку про одну вакансию: зарплата, график и срок, кого берут */
const vacancyAnswer = (v: Vacancy) => {
  const pay = payPhrase(v)
  return (
    `${v.title}: ${pay.charAt(0).toLowerCase() + pay.slice(1)}. ` +
    `График ${v.schedule.charAt(0).toLowerCase() + v.schedule.slice(1)}, ${v.period.toLowerCase()}. Кого берут: ${v.requirements.charAt(0).toLowerCase() + v.requirements.slice(1)}.`
  )
}

const names = (list: Vacancy[]) => list.map((v) => `«${v.title}»`).join(', ')
const rub = (n: number) => `${n.toLocaleString('ru-RU')} ₽`

/**
 * Ответы из «Справочника студента», которых нет в shared/content/handbook.ts: без цифр, дословно по смыслу.
 * Источник — archive/case-materials/handbook-text.txt, цитата у каждого
 */
const handbookNotes = [
  // стр. 6: «В чём состоят должностные обязанности? Освоение процессов. Освоение оборудования. Работа на оборудовании»
  'Обязанности новичка на старте: освоить процессы и оборудование и работать на нём вместе с наставником.',
  // стр. 13: «В связи с производственной необходимостью и с согласия сотрудника возможна сверхурочная работа или работа в выходные дни»
  'Сверхурочная работа и работа в выходные бывают только по производственной необходимости и с согласия сотрудника; часы сверх нормы оплачиваются отдельно.',
  // стр. 4: «В общежитии живут сотрудники Очаково»; «Общие зоны убирает уборщица, а кухни и комнаты - сами проживающие»
  'В общежитии живут сотрудники «Очаково». Общие зоны убирает персонал общежития, а кухни и комнаты убирают сами жильцы.',
  // стр. 3: «Около общежития есть спортивная площадка, где можно заниматься спортом»
  'Около общежития есть спортивная площадка.',
  // стр. 8: «Для прохождения медкомиссии в военкомате студенту нужно обратиться в отдел кадров и написать заявление, согласовав его
  // с непосредственным руководителем. При себе нужно иметь оригинал повестки»
  'Медкомиссия в военкомате: заявление в отдел кадров, согласованное с руководителем, и оригинал повестки.',
  // стр. 11: «Из-за чего у сотрудников, работающих на одинаковых должностях, разный размер оплаты? — разное количество
  // отработанных часов; … премиальной части; … разную интенсивность и сложность труда …; отгулы и больничные»
  'Зарплата на одной должности бывает разной: от отработанных часов, премиальной части, линии и её нагрузки, отгулов и больничных.',
  // стр. 5: «Прекращение работы может быть: по окончанию действия договора, по заявлению сотрудника, увольнение по инициативе работодателя»
  'Работа студента заканчивается по окончании договора, по заявлению сотрудника или по инициативе работодателя.',
]

function buildFacts(): string[] {
  return [
    companySummary,
    `Оплачиваемая практика есть в отделах: ${paidPracticeInfo.units.map((u) => u.toLowerCase()).join(', ')}. Платят от ${rub(paidPracticeInfo.payFrom)} до ${rub(paidPracticeInfo.payTo)} в месяц до вычета налога. ` +
      `Срок: ${paidPracticeInfo.period.toLowerCase()}. ${paidPracticeInfo.contract}. Компания даёт: ${paidPracticeInfo.benefits.map((b) => b.toLowerCase()).join('; ')}.`,
    `${freePracticeInfo.title}: ${freePracticeInfo.text} Задачи: ${freePracticeInfo.tasks.map((t) => t.toLowerCase()).join('; ')}.`,
    `Медкнижка: личная медицинская книжка обязательна на пищевом производстве, её спрашивают для позиций ${names(vacancies.filter(needsMedBook))}. ` +
      'Если её нет, откликнуться можно: её оформляют до выхода на работу, в заявке есть вариант «Оформлю до выхода». Где и как её оформить и кто её оплачивает, скажет HR на звонке, в базе этого нет.',
    `Ночные смены бывают у позиций ${names(vacancies.filter(hasNightShifts))}: дневная смена с 8:00 до 20:00, ночная с 20:00 до 8:00, ночные оплачиваются по повышенному коэффициенту. ` +
      'В заявке на сайте можно отметить, какие смены подходят: только дневные, только ночные или любые.',
    `Портфолио необязательно. Ссылку на него (GitHub, Behance, учебный проект, папка на диске) можно оставить в заявке на практику в офисе: ${names(vacancies.filter(asksPortfolio))}. Файлы не прикрепляются, только ссылка.`,
    `Завод строили к Олимпиаде-80. Все линии московского завода вместе разливают до ${PLANT_BOTTLES_PER_HOUR.toLocaleString('ru-RU')} бутылок в час, большинство процессов автоматизированы.`,
    ...timeline.map((t) => `${t.when === 'Сегодня' ? 'Сегодня' : `${t.when} год`}. ${t.title}: ${t.text}`),
    `Ключевые безалкогольные бренды «Очаково»: ${brandsLine}.`,
    `Платформа бренда: «${brandPlatform.calling}», «${brandPlatform.essence}», миссия «${brandPlatform.mission}» Ценности: ${brandPlatform.values.map((v) => v.value.toLowerCase()).join(', ')}.`,
    'Берут с 18 лет на работу, стажировку и практику: студентов колледжей и вузов и выпускников. Можно без резюме.',
    'Больничный оплачивается по закону: работа официальная, по трудовому договору.',
    // Маршруты — справочник студента и ochakovo.ru/kontakty; корпоративный автобус — справочник студента
    `Как добраться до завода (${contacts.address}): ${contacts.route} Расписания корпоративного автобуса в базе нет, его подскажет отдел подбора.`,
    `Сезон длится ${SEASON.text}, работы в это время много.`,
    // Общежитие и столовая подробно — поля справочника студента в shared/content/handbook.ts
    `Общежитие (${dorm.address}): ${dorm.room}; ${dorm.checkIn}; ${dorm.curfew}; ${dorm.kitchen}; ${dorm.bath}; ${dorm.bring}; ${dorm.sport}. ` +
      `Телефон коменданта: ${phonebook.find((p) => p.id === 'dorm')?.phone ?? ''}.`,
    `Столовая: обед ${canteen.lunch}, вечернее питание ${canteen.dinner}; ${canteen.share}; ${canteen.payment}.`,
    'Квасыч: бот «Очаково» и собирательный образ заводского наставника. Он подсказывает на сайте и в боте, а на заводе учит настоящий наставник.',
    ...handbookNotes,
  ]
}

const contactLine = `Отдел подбора: телефон ${contacts.phone} (${contacts.phoneNote}) или ${contacts.mobile}, почта ${contacts.email}, WhatsApp +${contacts.whatsapp}.`

function buildChunks(facts: string[]): Chunk[] {
  const out: Chunk[] = []
  const add = (id: string, title: string, text: string, answer = text) => out.push({ id, title, text, answer })
  facts.forEach((text, i) => add(`fact-${i}`, 'О заводе', text))
  // История и бренды отдельными фрагментами: «расскажи историю завода», «какие бренды у Очаково»
  add('company', 'Об «Очаково»: история компании', companySummary)
  add('company-brands', 'Бренды «Очаково»: квас и безалкогольные напитки', `Ключевые бренды: ${brandsLine}.`, `Ключевые бренды «Очаково»: ${brandsLine}. Самый известный из них квас «Очаковский».`)
  perks.forEach((p, i) => add(`perk-${i}`, p.title, `${p.title}. ${p.text}`))
  handbook.forEach((h) => add(`handbook-${h.id}`, h.title, `${h.title}. ${h.text}`, h.text))
  add('steps', 'Как устроиться', steps.map((s, i) => `${i + 1}. ${s.title} (${s.time}): ${s.text}`).join('\n'))
  // Вопрос без ответа (пустой a) в базу не попадает: пустой фрагмент мог бы стать «ответом»
  faq.filter((f) => f.a).forEach((f) => add(`faq-${f.id}`, f.q, `${f.q}? ${f.a}`, f.a))
  vacancies.forEach((v) => add(`vacancy-${v.id}`, v.title, vacancyLine(v), vacancyAnswer(v)))
  stages.forEach((s) => {
    const who = s.vacancies.map((id) => vacancies.find((v) => v.id === id)?.title).filter(Boolean)
    add(`stage-${s.id}`, s.title, `${s.title}. ${s.text} Здесь работают: ${who.join(', ')}.`, `${s.text} Здесь работают: ${who.join(', ')}.`)
  })
  // Карточки «Правда или миф» — утвердительным фактом: «В десять раз больше» без вопроса непонятно
  myths.forEach((m) => add(`myth-${m.id}`, m.topic === 'work' ? 'О работе' : 'История', m.fact))
  add('contacts', 'Контакты', `${contactLine} ${phonebook.filter((p) => p.id !== 'recruiting').map(phoneLine).join('; ')}.`)
  // Телефоны отделов из справочника студента — по фрагменту на отдел: «где учебный центр», «телефон здравпункта»
  phonebook
    .filter((p) => p.id !== 'recruiting')
    .forEach((p) => add(`phone-${p.id}`, p.who, `${phoneLine(p)}${p.note ? `, ${p.note}` : ''}.`))
  return out
}

// ── Сборка и пересборка ─────────────────────────────────────────────────

type Indexed = { chunk: Chunk; terms: Map<string, number>; length: number }

let facts: string[] = []
/** Фрагменты базы. Живая привязка: после rebuildKnowledge() импортёры видят новый список */
export let chunks: Chunk[] = []
let index: Indexed[] = []
let avgLength = 1
let docFreq = new Map<string, number>()
let version = 0

/** Вес слова для поиска — обратная частота по фрагментам базы. Слово, которого в базе нет, весит как самое редкое */
const idf = (term: string) => {
  const df = docFreq.get(term) ?? 0
  return Math.log(1 + (index.length - df + 0.5) / (df + 0.5))
}

function build() {
  facts = buildFacts()
  chunks = buildChunks(facts)
  index = chunks.map((chunk) => {
    const terms = new Map<string, number>()
    const words = tokens(`${chunk.title} ${chunk.title} ${chunk.text}`)
    for (const t of words) terms.set(t, (terms.get(t) ?? 0) + 1)
    return { chunk, terms, length: words.length }
  })
  avgLength = index.reduce((s, d) => s + d.length, 0) / Math.max(1, index.length)
  docFreq = new Map()
  for (const d of index) for (const t of d.terms.keys()) docFreq.set(t, (docFreq.get(t) ?? 0) + 1)
  version++
}

build()
setTermWeight(idf)

/**
 * Пересобрать базу из текущих данных shared/: после правки вакансий в панели (суммы, закрытие) Квасыч сразу называет
 * новое — без перезапуска. Сбрасывает кэш текста для промпта; функции и офлайн-режим читают вакансии напрямую
 */
export function rebuildKnowledge() {
  build()
}

/** Меняется при пересборке базы и при новых ответах HR: по нему сбрасывается кэш системного промпта */
export const knowledgeVersion = () => `${version}:${hrAnswersVersion()}`

let cached: { key: string; text: string } | null = null

/** Компактная база знаний для системного промпта — порядок и формулировки не меняются между запросами */
export function knowledgeText(): string {
  const key = knowledgeVersion()
  if (cached?.key === key) return cached.text
  const section = (title: string, lines: string[]) => `## ${title}\n${lines.map((l) => `- ${l}`).join('\n')}`
  const hr = hrAnswerList()
  const text = [
    section('Завод и сезон', facts),
    section(
      'Условия работы',
      perks.map((p) => `${p.title}. ${p.text}`),
    ),
    section(
      'Справочник студента: быт и правила',
      handbook.map((h) => `${h.title}. ${h.text}`),
    ),
    section(
      'Как устроиться',
      steps.map((s) => `${s.title} (${s.time}). ${s.text}`),
    ),
    section('Практика и вакансии (суммы до вычета НДФЛ 13 %)', vacancies.map(vacancyLine)),
    section(
      'Путь кваса: этапы производства',
      stages.map((s) => `${s.title}. ${s.text}`),
    ),
    section(
      'Правда или миф: факты',
      myths.map((m) => m.fact),
    ),
    section(
      'Вопросы и ответы',
      faq.filter((f) => f.a).map((f) => `${f.q}? ${f.a}`),
    ),
    section('Контакты', [contactLine, ...phonebook.filter((p) => p.id !== 'recruiting').map(phoneLine)]),
    // Ответы отдела персонала — последними: раздел меняется, а начало промпта остаётся тем же и кэшируется
    ...(hr.length ? [section('Ответы отдела персонала', hr.map((a) => `${[a.question, ...a.variants].join(' / ')}: ${a.answer}`))] : []),
  ].join('\n\n')
  cached = { key, text }
  return text
}

// ── Поиск для офлайн-режима ──────────────────────────────────────────────

/** matched — сколько разных слов запроса нашлось во фрагменте, queryTerms — сколько их в запросе */
/** unknown — содержательные слова вопроса, которых нет нигде в базе: «парковка», «наставник» */
export type SearchHit = { chunk: Chunk; score: number; matched: number; queryTerms: number; unknown: number }

/** BM25 по фрагментам базы. Уверенное совпадение — confident() ниже */
export function search(query: string, limit = 3): SearchHit[] {
  const q = [...new Set(tokens(query))]
  if (!q.length) return []
  const k1 = 1.4
  const b = 0.7
  const unknown = q.filter((t) => t.length >= 5 && !docFreq.get(t)).length
  const hits = index.map((d) => {
    let score = 0
    let matched = 0
    for (const t of q) {
      const f = d.terms.get(t)
      if (!f) continue
      matched++
      score += idf(t) * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avgLength)))
    }
    return { chunk: d.chunk, score, matched, queryTerms: q.length, unknown }
  })
  return hits
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

/**
 * Совпадение достаточно сильное, чтобы отвечать фрагментом: высокий score, совпала хотя бы половина значимых слов
 * и в вопросе нет темы, о которой в базе нет ни слова: «парковка для сотрудников» не ответ про сотрудников, собиравших рецепты
 */
export const confident = (hit: SearchHit | undefined): hit is SearchHit =>
  Boolean(hit && hit.score >= 1.5 && hit.matched >= Math.max(1, Math.ceil(hit.queryTerms / 2)) && hit.unknown === 0)
