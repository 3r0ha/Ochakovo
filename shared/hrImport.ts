import { validateApplication, type Citizenship } from './applications'
import { ageOn, ageWords, birthDateProblem, parseBirthDate } from './birthDate'
import { vacancies } from './content/vacancies'
import { phoneNorm } from './hrFilter'
import { parsePhones } from './phone'

// Импорт кандидатов из таблицы: выгрузка откликов с hh.ru (Excel или CSV) или любой похожий список.
// Колонки узнаём по заголовкам, HR может поправить сопоставление. Одна логика в панели (предпросмотр)
// и на сервере (сохранение) — сервер всё проверяет заново.

export type ImportField =
  | 'fullName'
  | 'lastName'
  | 'firstName'
  | 'middleName'
  | 'phone'
  | 'email'
  | 'vacancy'
  | 'birthDate'
  | 'date'
  | 'citizenship'
  | 'age'
  | 'school'
  | 'resume'
  | 'months'
  | 'comment'

export const importFields: { id: ImportField; label: string }[] = [
  { id: 'fullName', label: 'ФИО целиком' },
  { id: 'lastName', label: 'Фамилия' },
  { id: 'firstName', label: 'Имя' },
  { id: 'middleName', label: 'Отчество' },
  { id: 'phone', label: 'Телефон' },
  { id: 'email', label: 'Почта' },
  { id: 'vacancy', label: 'Вакансия отклика' },
  // Дата рождения — раньше даты отклика: колонку «Дата рождения» иначе забрало бы правило «дата…»
  { id: 'birthDate', label: 'Дата рождения' },
  { id: 'date', label: 'Дата отклика' },
  { id: 'citizenship', label: 'Гражданство' },
  { id: 'age', label: 'Возраст' },
  { id: 'school', label: 'Вуз или колледж' },
  { id: 'resume', label: 'Ссылка на резюме' },
  { id: 'months', label: 'Месяцы работы' },
  { id: 'comment', label: 'Комментарий' },
]

export type ImportMapping = Partial<Record<ImportField, number>>

/**
 * Как обычно называются колонки в выгрузках hh.ru, SuperJob и самодельных таблицах.
 * Порядок важен: первое правило сильнее. «Вакансия» отклика важнее «Желаемой должности» из резюме.
 */
const synonyms: Record<ImportField, RegExp[]> = {
  fullName: [/^фио$/, /^ф\.?\s?и\.?\s?о\.?$/, /^соискатель/, /^кандидат$/, /^имя и фамилия/, /^фамилия,? имя/, /^full ?name/],
  lastName: [/^фамилия$/, /^last ?name/, /^surname/],
  firstName: [/^имя$/, /^first ?name/],
  middleName: [/^отчество$/, /^middle ?name/, /^patronymic/],
  phone: [/^мобильный телефон/, /телефон/, /^моб/, /phone/, /^тел\.?$/],
  email: [/^электронная почта/, /e-?mail/, /почта/, /^эл\.? ?адрес/],
  vacancy: [/^вакансия$/, /^вакансия отклика/, /^название вакансии/, /^vacancy/, /^ваканс/],
  birthDate: [/^дата рождения/, /рождени/, /^д\.?\s?р\.?$/, /^birth ?date/, /^date of birth/, /^birthday/],
  date: [/дата отклика/, /^дата/, /^отклик/, /^date/, /^создан/],
  citizenship: [/гражданств/, /^citizenship/],
  age: [/^возраст/, /^age$/],
  school: [/учебн\S* заведени/, /^вуз/, /^колледж/, /^место учёбы/, /^место учебы/, /^university/, /^school/],
  resume: [/ссылка на резюме/, /^резюме/, /resume/],
  months: [/^месяц/, /период работы/, /когда готов/, /^готов работать/, /^months?$/],
  comment: [/сопроводит/, /комментар/, /^письмо/, /^comment/],
}

/** Угадать колонки по заголовкам; каждая колонка — не больше одного поля */
export function guessMapping(headers: string[]): ImportMapping {
  const used = new Set<number>()
  const mapping: ImportMapping = {}
  const norm = headers.map((h) => h.trim().toLowerCase().replace(/\s+/g, ' '))
  for (const field of importFields.map((f) => f.id)) {
    for (const re of synonyms[field]) {
      const i = norm.findIndex((h, idx) => !used.has(idx) && re.test(h))
      if (i >= 0) {
        mapping[field] = i
        used.add(i)
        break
      }
    }
  }
  // «ФИО» не нужно, если есть фамилия и имя отдельно, и наоборот
  if (mapping.fullName !== undefined && mapping.firstName !== undefined) delete mapping.firstName
  return mapping
}

export type ImportRow = {
  /** Номер строки в файле — как в Excel */
  line: number
  lastName: string
  name: string
  middleName: string
  /** +XXXXXXXXXXX или пусто */
  phone: string
  email: string
  vacancyId: string
  /** Название вакансии из файла — для сопоставления с нашими */
  vacancyTitle: string
  /** Дата отклика в ISO; null — не распознана */
  appliedAt: string | null
  citizenship: Citizenship | ''
  /** Дата рождения YYYY-MM-DD; пустая строка — колонки нет или дату не прочитать */
  birthDate: string
  /** 18+ по дате рождения, а без неё — по возрасту из файла; null — ни того ни другого */
  adult: boolean | null
  /** Вуз или колледж из файла */
  school: string
  resumeUrl: string
  /** Месяцы работы из файла; пусто — колонки нет или не распознали, тогда месяцы по умолчанию из предпросмотра */
  months: number[]
  comment: string
  /** Почему строку нельзя импортировать */
  problems: string[]
  /** Что не так, но строку загрузим: почта не распознана, возраст меньше 18 */
  warnings: string[]
}

const clean = (v: string | undefined) => (v ?? '').replace(/\s+/g, ' ').trim()
const emailRe = /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/

/** Вакансия отклика «Оператор линии розлива (сезонная работа)» → наша, если название совпадает по смыслу */
export function matchVacancy(title: string) {
  const t = title.toLowerCase().replace(/[«»"()]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  const exact = vacancies.find((v) => v.title.toLowerCase() === t)
  if (exact) return exact.id
  const partial = vacancies.find((v) => t.includes(v.title.toLowerCase()) || v.title.toLowerCase().includes(t))
  return partial?.id ?? ''
}

/** Ключ для запомненного сопоставления «название в файле → наша вакансия» */
export const vacancyKey = (title: string) => title.trim().toLowerCase().replace(/\s+/g, ' ')

/** Дата из Excel числом (дни от начала отсчёта Excel) → ГГГГ-ММ-ДД; пустая строка — не похоже на дату */
function excelDay(v: string) {
  const n = Number(v)
  return n > 0 && n < 80000 ? new Date(Math.round((n - 25569) * 864e5)).toISOString().slice(0, 10) : ''
}

/** «ДД.ММ.ГГГГ», «ДД.ММ.ГГГГ ЧЧ:ММ», «ГГГГ-ММ-ДД», число дней Excel → ISO; время — московское */
export function parseDate(v: string): string | null {
  const s = v.trim()
  let m = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})(?:[ ,T]+(\d{1,2}):(\d{2}))?/.exec(s)
  if (m) {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])
    const d = new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[1]), Number(m[4] ?? 12) - 3, Number(m[5] ?? 0)))
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(s)
  if (m) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], Number(m[4] ?? 12) - 3, Number(m[5] ?? 0)))
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  // Дата из Excel числом: дни от начала отсчёта Excel
  if (/^\d{5}(\.\d+)?$/.test(s) && Number(s) > 30000 && Number(s) < 80000) {
    return new Date(Math.round((Number(s) - 25569) * 864e5) - 3 * 3600e3).toISOString()
  }
  return null
}

/** «Россия», «Беларусь», «Узбекистан» → категория анкеты */
export function parseCitizenship(v: string): Citizenship | '' {
  const s = v.trim().toLowerCase()
  if (!s) return ''
  if (/росси|^рф$/.test(s)) return 'ru'
  if (/беларус|белорус|казахстан|армени|киргиз|кыргыз/.test(s)) return 'eaeu'
  return 'other'
}

const monthRes = [/^янв/, /^фев/, /^мар/, /^апр/, /^ма[йяе]$/, /^июн/, /^июл/, /^авг/, /^сен/, /^окт/, /^ноя/, /^дек/]
const monthOf = (word: string) => {
  const i = monthRes.findIndex((re) => re.test(word))
  return i >= 0 ? i + 1 : null
}

/**
 * «июнь, июль», «с июня по август», «июнь — август», «6-8», «01.06–31.08», «лето», «весь сезон» → [6, 7, 8].
 * Пусто — не распознали
 */
export function parseMonths(text: string): number[] {
  const s = text
    .toLowerCase()
    .replace(/\b\d{1,2}\.(\d{1,2})(?:\.\d{2,4})?\b/g, (_, m: string) => ` ${Number(m)} `)
  if (!s.trim()) return []
  // \b в JS не работает с кириллицей — границы слова явно
  const word = (re: string) => new RegExp(`(^|[^а-яё])(${re})(?![а-яё])`).test(s)
  if (word('весь сезон|весь период|люб(ой|ое|ые|ая)')) return [3, 4, 5, 6, 7, 8, 9]
  const out = new Set<number>()
  if (word('лет[оа]|летом')) [6, 7, 8].forEach((m) => out.add(m))
  let prev: number | null = null
  let range = false
  for (const [t] of s.matchAll(/[а-яё]+|\d+|[—–-]/g)) {
    if (/^[—–-]$|^по$|^до$/.test(t)) {
      range = prev !== null
      continue
    }
    const m = /^\d+$/.test(t) ? (Number(t) >= 1 && Number(t) <= 12 ? Number(t) : null) : t.length >= 3 ? monthOf(t) : null
    if (m === null) continue
    if (range && prev !== null) {
      // «ноябрь — февраль» — через новый год
      for (let x: number = prev; x !== m; x = (x % 12) + 1) out.add(x)
    }
    out.add(m)
    prev = m
    range = false
  }
  return [...out].sort((a, b) => a - b)
}

/** Месяцы сезона вакансии по её сроку на сайте: «Июнь — август» → [6, 7, 8]; «Весь сезон» — март — сентябрь */
export function vacancyMonths(vacancyId: string): number[] {
  const v = vacancies.find((x) => x.id === vacancyId)
  return v ? parseMonths(v.period) : []
}

/** «hh.ru/resume/6b0d…?query» → https://hh.ru/resume/6b0d… */
export function parseResumeUrl(v: string) {
  const m = /(?:https?:\/\/)?(?:[\w-]+\.)?hh\.ru\/resume\/([\w-]+)/i.exec(v.trim())
  return m ? `https://hh.ru/resume/${m[1]}` : ''
}

export function mapRow(cells: string[], mapping: ImportMapping, line = 0, vacancyMap: Record<string, string> = {}): ImportRow {
  const get = (f: ImportField) => (mapping[f] === undefined ? '' : clean(cells[mapping[f]!]))
  let lastName = get('lastName')
  let name = get('firstName')
  let middleName = get('middleName')
  const full = get('fullName')
  if (full && (!lastName || !name)) {
    // В выгрузках hh.ru ФИО идёт «Фамилия Имя Отчество»; из двух слов — фамилия и имя, отчество не угадываем
    const words = full.split(' ')
    if (words.length >= 3) {
      lastName ||= words[0]
      name ||= words[1]
      middleName ||= words.slice(2).join(' ')
    } else if (words.length === 2) {
      lastName ||= words[0]
      name ||= words[1]
    } else name ||= words[0]
  }
  const problems: string[] = []
  const warnings: string[] = []

  const phoneCell = get('phone')
  const parsed = parsePhones(phoneCell)
  const phone = parsed && 'e164' in parsed ? parsed.e164 : ''
  if (parsed && 'error' in parsed) problems.push(parsed.error)

  const emailCell = get('email').split(/[,;\s]/)[0] ?? ''
  const email = emailRe.test(emailCell) ? emailCell : ''
  if (emailCell && !email) warnings.push(`почта не распознана: «${emailCell.slice(0, 40)}»`)

  const vacancyTitle = get('vacancy')
  const remembered = vacancyMap[vacancyKey(vacancyTitle)]
  const vacancyId = remembered === 'none' ? '' : remembered || matchVacancy(vacancyTitle)

  // Дата рождения: ДД.ММ.ГГГГ, ГГГГ-ММ-ДД или число дней Excel. С опечаткой — не храним, но строку загружаем
  const birthCell = get('birthDate')
  const birthText = /^\d{5}$/.test(birthCell) ? excelDay(birthCell) : birthCell.replace(/\s+\d{1,2}:\d{2}(:\d{2})?$/, '')
  const birthProblem = birthText ? birthDateProblem(birthText) : null
  const birthDate = birthText && birthProblem?.code !== 'bad_birth_date' ? (parseBirthDate(birthText) ?? '') : ''
  if (birthCell && !birthDate) warnings.push(`дата рождения не распознана: «${birthCell.slice(0, 20)}»`)

  const ageCell = get('age')
  const age = birthDate ? (ageOn(birthDate) ?? NaN) : Number(/\d+/.exec(ageCell)?.[0] ?? NaN)
  const adult = Number.isFinite(age) && age > 0 ? age >= 18 : null
  if (adult === false) warnings.push(`${birthDate ? ageWords(age) : `возраст ${age}`}: работа только с 18 лет`)

  const monthsCell = get('months')
  const months = parseMonths(monthsCell)
  if (monthsCell && !months.length) warnings.push(`месяцы не распознаны: «${monthsCell.slice(0, 30)}», поставим месяцы по умолчанию`)

  const comment = [get('comment'), vacancyTitle && !vacancyId ? `Вакансия в файле: ${vacancyTitle}` : ''].filter(Boolean).join('\n').slice(0, 2000)
  const row: ImportRow = {
    line,
    lastName: lastName.slice(0, 80),
    name: name.slice(0, 120),
    middleName: middleName.slice(0, 80),
    phone,
    email: email.slice(0, 120),
    vacancyId,
    vacancyTitle,
    appliedAt: parseDate(get('date')),
    citizenship: parseCitizenship(get('citizenship')),
    birthDate,
    adult,
    school: get('school').slice(0, 200),
    resumeUrl: parseResumeUrl(get('resume')),
    months,
    comment,
    problems,
    warnings,
  }
  if (get('date') && !row.appliedAt) warnings.push(`дата отклика не распознана: «${get('date').slice(0, 20)}», поставим сегодняшнюю`)
  const errors = validateApplication({ name: row.name, phone: row.phone, contact: row.email })
  if (errors.name) problems.push('нет имени')
  if (errors.phone && !problems.some((p) => p.startsWith('телефон'))) problems.push('нет телефона или почты')
  return row
}

/** Ключи для поиска дублей: телефон, почта, резюме hh.ru */
export const dedupeKeys = (r: { phone?: string; email?: string; contact?: string; resumeUrl?: string }) => {
  const keys: string[] = []
  if (r.phone && phoneNorm(r.phone).length >= 10) keys.push(`p:${phoneNorm(r.phone)}`)
  const email = (r.email ?? (r.contact && /@/.test(r.contact) ? r.contact : '') ?? '').trim().toLowerCase()
  if (email) keys.push(`e:${email}`)
  if (r.resumeUrl) keys.push(`r:${r.resumeUrl}`)
  return keys
}

/** Повторы внутри файла: строка → номер первой строки с тем же телефоном, почтой или резюме */
export function fileDuplicates(rows: ImportRow[]) {
  const first = new Map<string, number>()
  const repeats = new Map<number, number>()
  for (const r of rows) {
    if (r.problems.length) continue
    const keys = dedupeKeys(r)
    const seen = keys.map((k) => first.get(k)).find((v) => v !== undefined)
    if (seen !== undefined) repeats.set(r.line, seen)
    else for (const k of keys) first.set(k, r.line)
  }
  return repeats
}

/** Файл не больше 5 МБ и не больше 5000 строк */
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024
export const IMPORT_MAX_ROWS = 5000
