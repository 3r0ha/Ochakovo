import { departments } from '@shared/content/departments'
import { dorm, PASS_FINE, PAY_DAYS } from '@shared/content/handbook'
import { stages } from '@shared/content/production'
import { netPay, shiftPay, vacancies } from '@shared/content/vacancies'
import { knowledgeText, knowledgeVersion } from './knowledge'

// Проверки вокруг модели:
//  redactPersonal — убирает из текста телефоны, почту, ники и имя перед отправкой в GigaChat
//  checkAnswer    — суммы, время, проценты, дни выплат и должности в ответе должны быть в наших данных;
//                   «бесплатно» и «за счёт компании» — только там, где это правда
//  tidyAnswer     — приводит ответ к голосу бренда: без markdown-заголовков, восклицаний и простыней

// ── Личные данные ────────────────────────────────────────────────────────

const PHONE = /(?:\+7|\b8|\b7)[\s\-()]*\d{3}[\s\-()]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}\b/g
const LONG_DIGITS = /\b\d{10,15}\b/g
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g
const HANDLE = /(^|[\s(])@[A-Za-z0-9_.]{3,}/g
const NAME = /(меня зовут|зовут меня|моё имя|мое имя)\s+[А-ЯЁA-Z][а-яёa-z-]+(?:\s+[А-ЯЁA-Z][а-яёa-z-]+)?/gi

/** keep — оставить совпадение как есть: например, общие телефоны и почту компании в ответе HR */
export function redactPersonal(text: string, keep: (match: string) => boolean = () => false): string {
  const unless = (label: string) => (m: string) => (keep(m) ? m : label)
  return text
    .replace(EMAIL, unless('[почта]'))
    .replace(PHONE, unless('[телефон]'))
    .replace(LONG_DIGITS, unless('[телефон]'))
    .replace(HANDLE, '$1[ник]')
    .replace(NAME, '$1 [имя]')
}

// ── Темы, которые не обсуждаем ──────────────────────────────────────────

// \b в JS не видит границ кириллических слов, поэтому границы — через lookbehind и lookahead
const ALCOHOL = /(?<![а-я])(пив[оаеу]?(?![а-я])|пивн|пивовар|алкогол|водк|вин[оа](?![а-я])|винн|сидр|джин(?![а-я])|спиртн|пьян|бухл|опохмел)/i

export const isAlcoholTopic = (text: string) => ALCOHOL.test(text.toLowerCase().replace(/ё/g, 'е'))

// ── Суммы ────────────────────────────────────────────────────────────────

const NUMBER = /\d{1,3}(?:[   ]\d{3})+|\d+(?:[.,]\d+)?/g
const CURRENCY = String.raw`(?:₽|руб|р\.|в месяц|на руки|до вычета)`
/** «102 000 ₽», «57 тыс. ₽», «45 тысяч в месяц» */
const AFTER_SINGLE = new RegExp(String.raw`^\s*(тыс\.?|тысяч[а-я]*)?\s*${CURRENCY}`)
/** первое число диапазона: «57–89 тыс. ₽», «57 000–89 000 ₽» */
const AFTER_RANGE = new RegExp(String.raw`^\s*[–—-]\s*\d[\d   ]*\s*(тыс\.?|тысяч[а-я]*)?\s*${CURRENCY}`)

/** Суммы в рублях из текста. Числа без денег рядом («70 000 бутылок», «12 часов») пропускаем */
export function moneyAmounts(text: string): number[] {
  const out: number[] = []
  for (const match of text.matchAll(NUMBER)) {
    const end = match.index! + match[0].length
    const after = text.slice(end, end + 40).toLowerCase()
    const money = AFTER_SINGLE.exec(after) ?? AFTER_RANGE.exec(after)
    if (!money) continue
    let value = Number(match[0].replace(/[   ]/g, '').replace(',', '.'))
    if (!Number.isFinite(value) || value === 0) continue
    if (money[1] && value < 1000) value *= 1000
    out.push(value)
  }
  return out
}

/** Время суток «8:00», «20:30» — как записано в тексте */
const TIME = /(?<![\d:])([01]?\d|2[0-3])[:.]([0-5]\d)(?![\d:])/g
const timesIn = (text: string) => [...text.matchAll(TIME)].map((m) => `${Number(m[1])}:${m[2]}`)
/** Проценты «13 %», «50%» */
const PERCENT = /(\d+(?:[.,]\d+)?)\s*%/g
const percentsIn = (text: string) => [...text.matchAll(PERCENT)].map((m) => Number(m[1].replace(',', '.')))

type Allowed = { amounts: number[]; times: Set<string>; percents: Set<number> }
let allowed: { key: string; value: Allowed } | null = null

/**
 * Что может прозвучать без расчёта — всё, что есть в базе знаний: зарплаты из вакансий, «на руки», за смену и в час
 * (shiftPay — как в «Собери лето»), общежитие и штраф за пропуск из справочника, суммы из одобренных ответов HR;
 * время из справочника и графиков; проценты базы (НДФЛ 13 %). Пересчитывается вместе с базой знаний.
 * Итоги за несколько месяцев допустимы, только если их посчитала calc_earnings в этом ответе
 */
function allowedNow(): Allowed {
  const key = knowledgeVersion()
  if (allowed?.key === key) return allowed.value
  const kb = knowledgeText()
  const amounts = new Set<number>([dorm.priceStudent, dorm.priceOther, PASS_FINE, ...moneyAmounts(kb)])
  for (const v of vacancies) {
    if (!v.pay) continue
    for (const base of [v.pay.from, v.pay.to].filter((n): n is number => typeof n === 'number')) {
      amounts.add(base)
      amounts.add(netPay(base))
    }
    const shift = shiftPay(v)
    if (shift) amounts.add(shift.perShift).add(shift.perHour)
  }
  // 50 % — доля, которую компания платит за общежитие студента («Описание практики»: «50% оплаты за общежитие»)
  const half = dorm.priceOther === dorm.priceStudent * 2 ? [50] : []
  const value: Allowed = { amounts: [...amounts], times: new Set(timesIn(kb)), percents: new Set([13, ...half, ...percentsIn(kb)]) }
  allowed = { key, value }
  return value
}

const isAllowedAmount = (n: number, extra: number[]) => [...allowedNow().amounts, ...extra].some((a) => Math.abs(a - n) <= a * 0.01)

// ── Должности ────────────────────────────────────────────────────────────

/** Слова, которые означают должность. Если такого слова нет ни в одной нашей вакансии, модель её выдумала.
 *  «Помощник» и «специалист» сюда не входят: «бот-помощник» и «опытный специалист» — не должности */
// Основы слов, чтобы ловить и «водитель», и «водители»
const JOB_WORDS = [
  'оператор', 'лаборант', 'механик', 'наладчик', 'аппаратчик', 'стажер', 'мерчандайзер', 'экскурсовод',
  'кладовщик', 'грузчик', 'водител', 'рабоч', 'аналитик', 'упаковщик', 'повар',
  'уборщ', 'дворник', 'литейщик', 'менеджер', 'продав', 'кассир', 'курьер', 'сварщик', 'охранник', 'бармен',
]
const knownJobs = () => [...vacancies.map((v) => v.title), ...Object.values(departments).map((d) => d.name)].join(' ').toLowerCase().replace(/ё/g, 'е')

const sentencesOf = (text: string) => text.toLowerCase().replace(/ё/g, 'е').split(/[.!?\n]+/)
const NEGATION = /(^|[^а-я])(не|нет|отсутств|без)([^а-я]|$)/

/** Должности не из наших вакансий. «Вакансии грузчика нет» — честный ответ, поэтому предложения с отрицанием пропускаем */
function unknownJobs(text: string): string[] {
  const known = knownJobs()
  const found = new Set<string>()
  for (const raw of sentencesOf(text)) {
    // «Учусь на механика», «под учёбу на технолога» — учёба человека, а не должность
    const sentence = raw.replace(/(уч[её]б[а-я]*|учусь|учится|учишься|специальност[а-я]*|направлени[а-я]*|выпускни[кц][а-я]*)\s+(на|по)\s+[а-я]+/g, ' ')
    if (/(^|[^а-я])(не|нет|отсутств)([^а-я]|$)/.test(sentence)) continue
    for (const w of JOB_WORDS) {
      if (new RegExp(`(^|[^а-я])${w}`).test(sentence) && !known.includes(w)) found.add(w)
    }
  }
  return [...found]
}

// ── Условия, которых нет в данных ────────────────────────────────────────

/** «Бесплатно», «за счёт компании», «оплачивает завод» — бывает правдой только про медосмотр и спецодежду */
const FREE = /бесплатн|за\s+сч[её]т\s+(компании|завода|предприятия|работодателя|«?очаково)|(компания|завод|работодатель|предприятие)\s+(полностью\s+)?(оплачива|платит|компенсир)|оплачива[а-я]*\s+(завод|компани|работодател|предприяти)/g
/** О чём «бесплатно» сказать нельзя: общежитие стоит денег, обед — за полцены, медкнижка и проезд — в данных не сказано */
const NOT_FREE = /общежит|общаг|жиль|прожива|медкниж|санкниж|медицинск[а-я]*\s+книж|автобус|развоз|проезд|обед|питани|столов|ужин|(?<![а-я])еда|еду(?![а-я])/
/** «Половину стоимости оплачивает компания» — правда */
const HALF = /половин|50\s*%|частич|част[ьи](?![а-я])/

function freeProblems(text: string): string[] {
  const out = new Set<string>()
  for (const raw of sentencesOf(text)) {
    // «Бесплатная практика» — формат практики, а не обещание бесплатного жилья
    const sentence = raw.replace(/бесплатн[а-я]*\s+практик[а-я]*/g, ' ')
    for (const m of sentence.matchAll(FREE)) {
      const near = sentence.slice(Math.max(0, m.index! - 50), m.index! + m[0].length + 50)
      if (NOT_FREE.test(near) && !HALF.test(near)) out.add(`«${m[0].trim()}» про то, за что платит человек`)
    }
  }
  return [...out]
}

/** «Каждые 15 минут», «раз в полчаса» — расписаний автобуса и перерывов в данных нет */
const INTERVAL = /кажд[а-я]*\s+(\d+\s*|пол)?(минут|час|получас)|раз\s+в\s+(\d+\s*)?(минут|полчаса|час)/

/** «С 8 до 20» без двоеточий — те же часы, что «с 8:00 до 20:00» */
const HOURS_RANGE = /(?<![\d:])с\s+(\d{1,2})\s+до\s+(\d{1,2})(?![\d:])(?!\s*(лет|год|₽|руб|тыс|%|человек|месяц|числ|-?го))/g

/** Дни выплат: «10-го и 25-го», «15 числа» — только рядом со словами о деньгах */
const DAY = /(?<![\d:.,])(\d{1,2})(?:\s*-?\s*(?:го|е)|\s+числ[а-я]*)(?![а-я\d])/g
const PAY_WORDS = /зарплат|выплат|аванс|получк|плат[яи]т|перечисл|начисл|деньги приход/

/** Обещание ДМС: в материалах «Очаково» его нет, поэтому про ДМС можно сказать только «не указан» */
const DMS = /(?<![а-я])дмс|медицинск[а-я]*\s+страхов|страховк/

const PROMISES = /гарантир|точно возьм|обязательно возьм|100\s*%|без собеседования/i

export type GuardResult = { ok: true } | { ok: false; problems: string[] }

/** extraAmounts — суммы, которые в этом ответе посчитала calc_earnings */
export function checkAnswer(text: string, extraAmounts: number[] = []): GuardResult {
  const problems: string[] = []
  const known = allowedNow()
  for (const n of moneyAmounts(text)) if (!isAllowedAmount(n, extraAmounts)) problems.push(`сумма ${n} не из данных`)
  for (const t of timesIn(text)) if (!known.times.has(t)) problems.push(`время ${t} не из данных`)
  for (const m of text.matchAll(HOURS_RANGE)) {
    for (const h of [m[1], m[2]]) if (!known.times.has(`${Number(h)}:00`)) problems.push(`время ${h}:00 не из данных`)
  }
  for (const p of percentsIn(text)) if (!known.percents.has(p)) problems.push(`процент ${p} не из данных`)
  const lower = text.toLowerCase().replace(/ё/g, 'е')
  if (INTERVAL.test(lower)) problems.push('интервал без источника')
  for (const sentence of sentencesOf(text)) {
    if (PAY_WORDS.test(sentence)) {
      for (const m of sentence.matchAll(DAY)) if (!PAY_DAYS.includes(Number(m[1]) as never)) problems.push(`день выплаты ${m[1]} не из данных`)
    }
    if (DMS.test(sentence) && !NEGATION.test(sentence)) problems.push('обещание ДМС')
  }
  problems.push(...freeProblems(text))
  for (const w of unknownJobs(text)) problems.push(`должность «${w}» не из данных`)
  if (PROMISES.test(text)) problems.push('обещание сверх данных')
  if (isAlcoholTopic(text)) problems.push('тема алкоголя')
  return problems.length ? { ok: false, problems } : { ok: true }
}

/** Вступления, которые не отвечают на вопрос: «Отличный вопрос.», «Всё просто:» */
const FILLER = /^(?:(?:отличный|хороший|интересный|классный|правильный)\s+вопрос|вс[её]\s+просто|конечно|итак|смотри|давай разбер[её]мся)\s*[.:,!—–-]+\s*/i

// Технические id в тексте человеку не нужны: «(id marketing-intern)» убираем, голый id вакансии меняем на название
const ID_IN_BRACKETS = new RegExp(String.raw`\s*\((?:id|ид)[:\s]*[a-z0-9-]+\)`, 'gi')
const stageIdNote = new RegExp(String.raw`\s*\((?:этап\s+)?(${stages.map((s) => s.id).join('|')})\)`, 'g')

export function stripIds(text: string): string {
  // Вакансии берём при каждом вызове: после правки в панели список мог поменяться
  const vacancyIdWord = new RegExp(String.raw`(?<![\w-])(${vacancies.map((v) => v.id).join('|')})(?![\w-])`, 'g')
  return text
    .replace(ID_IN_BRACKETS, '')
    .replace(stageIdNote, '')
    .replace(vacancyIdWord, (id) => vacancies.find((v) => v.id === id)?.title ?? id)
}

/** Голос бренда: первая фраза — ответ, без markdown-заголовков, восклицаний, тире и id, списки — «• », не длиннее ~900 знаков */
export function tidyAnswer(text: string): string {
  let t = stripIds(text.replace(/\r/g, '')).trim()
  while (FILLER.test(t)) t = t.replace(FILLER, '')
  t = t.charAt(0).toUpperCase() + t.slice(1)
  t = t
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[*•—–-]\s+/gm, '• ')
    .replace(/^\s*\d+[.)]\s+/gm, '• ')
    .replace(/!+/g, '.')
    .replace(/\.{2,}|…/g, '.')
    // Тире между словами модель ставит в определениях («смены — 12 часов»): двоеточие читается так же и без тире.
    // Диапазоны «56 000–70 000» без пробелов не трогаем
    .replace(/(\S)[ \u00a0]+[—–][ \u00a0]+/g, '$1: ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (t.length > 900) {
    const cut = t.slice(0, 900)
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'))
    t = (end > 400 ? cut.slice(0, end + 1) : cut).trim()
  }
  return t
}
