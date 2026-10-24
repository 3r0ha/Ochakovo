import { mskParts } from './workdays'

// Дата рождения кандидата: разбор ввода с формы и из ботов, возраст по Москве, проверка 18+.
// Хранится строкой YYYY-MM-DD (в базе — date). Возраст считается от текущего момента по московскому времени:
// на работу, стажировку и практику «Очаково» берёт только с 18 лет (docs/case.md).

/** С какого возраста берут на работу, стажировку и практику */
export const MIN_AGE = 18
/** Старше — почти наверняка опечатка в годе */
export const MAX_AGE = 70

/** underage — моложе 18 лет; bad_birth_date — дату не прочитать, такой даты нет, она в будущем или возраст больше 70 */
export type BirthDateCode = 'underage' | 'bad_birth_date'
export type BirthDateProblem = { code: BirthDateCode; message: string }

export const birthDateMessages = {
  required: 'Укажи дату рождения: день, месяц и год',
  format: 'Не получилось прочитать дату. Напиши день, месяц и год цифрами: ДД.ММ.ГГГГ',
  impossible: 'Такой даты нет в календаре, проверь день и месяц',
  future: 'Эта дата ещё не наступила, проверь год',
  tooOld: 'Проверь год рождения: похоже на опечатку',
  underage: 'Берём с 18 лет на работу, стажировку и практику. Заявку можно отправить, когда исполнится 18',
} as const

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
const daysInMonth = (y: number, m: number) => (m === 2 ? (isLeap(y) ? 29 : 28) : [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1])
const pad = (n: number, len = 2) => String(n).padStart(len, '0')
const toIso = (y: number, m: number, d: number) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`

type Ymd = { y: number; m: number; d: number }
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const splitIso = (iso: string): Ymd | null => {
  const r = ISO_RE.exec(iso)
  return r ? { y: +r[1], m: +r[2], d: +r[3] } : null
}

/** Разбор ввода: ГГГГ-ММ-ДД или ДД.ММ.ГГГГ (день и месяц — одной или двумя цифрами, вместо точки — «/», «-» или пробел) */
function read(input: unknown): { iso: string } | { error: 'format' | 'impossible' } {
  if (typeof input !== 'string') return { error: 'format' }
  // «ДД.ММ.ГГГГ г.» — так тоже пишут
  const s = input.trim().replace(/\s*г(?:од)?\.?$/i, '')
  let ymd: Ymd
  const iso = ISO_RE.exec(s)
  const dmy = /^(\d{1,2})(?:\s*[./-]\s*|\s+)(\d{1,2})(?:\s*[./-]\s*|\s+)(\d{4})$/.exec(s)
  if (iso) ymd = { y: +iso[1], m: +iso[2], d: +iso[3] }
  else if (dmy) ymd = { y: +dmy[3], m: +dmy[2], d: +dmy[1] }
  else return { error: 'format' }
  if (ymd.m < 1 || ymd.m > 12 || ymd.d < 1 || ymd.d > daysInMonth(ymd.y, ymd.m)) return { error: 'impossible' }
  return { iso: toIso(ymd.y, ymd.m, ymd.d) }
}

/** Дата рождения из ввода в виде YYYY-MM-DD; null — не прочитать или такой даты нет. Возраст не проверяет */
export function parseBirthDate(input: unknown): string | null {
  const r = read(input)
  return 'iso' in r ? r.iso : null
}

/** Сегодняшний день по Москве: YYYY-MM-DD */
export const mskToday = (now: Date | number = Date.now()) => mskParts(now).day

/**
 * Полных лет на сегодня по Москве. Родившиеся 29 февраля в невисокосный год становятся на год старше 28 февраля:
 * срок, который кончается в месяце без такого числа, истекает в последний день месяца (ст. 192 ГК РФ).
 * null — дата не в виде YYYY-MM-DD
 */
export function ageOn(birthDate: string, now: Date | number = Date.now()): number | null {
  const b = splitIso(birthDate)
  if (!b) return null
  const t = splitIso(mskToday(now))!
  const birthday = Math.min(b.d, daysInMonth(t.y, b.m))
  return t.y - b.y - (t.m < b.m || (t.m === b.m && t.d < birthday) ? 1 : 0)
}

/** Есть ли 18 лет по дате рождения; null — даты нет */
export function isAdultByBirthDate(birthDate: string | null | undefined, now: Date | number = Date.now()): boolean | null {
  const age = birthDate ? ageOn(birthDate, now) : null
  return age === null ? null : age >= MIN_AGE
}

/** С какого дня исполнится 18: YYYY-MM-DD; null — даты нет */
export function adultSince(birthDate: string): string | null {
  const b = splitIso(birthDate)
  if (!b) return null
  const y = b.y + MIN_AGE
  return toIso(y, b.m, Math.min(b.d, daysInMonth(y, b.m)))
}

/**
 * Что не так с датой рождения из ввода; null — всё в порядке.
 * underage — моложе 18; bad_birth_date — дату не прочитать, такой даты нет, она ещё не наступила или возраст больше 70.
 * Пустой ввод — тоже bad_birth_date: обязательность поля проверяет validateApplication
 */
export function birthDateProblem(input: unknown, now: Date | number = Date.now()): BirthDateProblem | null {
  if (typeof input !== 'string' || !input.trim()) return { code: 'bad_birth_date', message: birthDateMessages.required }
  const r = read(input)
  if ('error' in r) return { code: 'bad_birth_date', message: birthDateMessages[r.error] }
  if (r.iso > mskToday(now)) return { code: 'bad_birth_date', message: birthDateMessages.future }
  const age = ageOn(r.iso, now)!
  if (age > MAX_AGE) return { code: 'bad_birth_date', message: birthDateMessages.tooOld }
  if (age < MIN_AGE) return { code: 'underage', message: birthDateMessages.underage }
  return null
}

/**
 * Для хранения: YYYY-MM-DD или пустая строка. Дату, которой нет, дату в будущем и возраст больше 70 не храним —
 * это опечатка. Моложе 18 храним: HR видит возраст, а заявку кандидата отсекает проверка
 */
export function normalizeBirthDate(input: unknown, now: Date | number = Date.now()) {
  const iso = parseBirthDate(input)
  if (!iso) return ''
  const problem = birthDateProblem(iso, now)
  return !problem || problem.code === 'underage' ? iso : ''
}

/** YYYY-MM-DD → ДД.ММ.ГГГГ; пустая строка — даты нет */
export function formatBirthDate(birthDate: string | null | undefined) {
  const b = birthDate ? splitIso(birthDate) : null
  return b ? `${pad(b.d)}.${pad(b.m)}.${pad(b.y, 4)}` : ''
}

/** «19 лет», «21 год», «23 года» */
export function ageWords(age: number) {
  const n = Math.abs(age) % 100
  const last = n % 10
  const word = n >= 11 && n <= 14 ? 'лет' : last === 1 ? 'год' : last >= 2 && last <= 4 ? 'года' : 'лет'
  return `${age} ${word}`
}

/**
 * Маска поля «Дата рождения» на телефоне: цифры раскладываются в ДД.ММ.ГГГГ по мере ввода, точки ставятся сами.
 * Точку, набранную вручную, маска уважает: «5.3.» остаётся «5.3.», а не превращается в «53».
 * Точку в конце сама не добавляет — иначе Backspace не смог бы её стереть
 */
export function maskBirthDate(typed: string) {
  // Вставили дату целиком в виде ГГГГ-ММ-ДД (автозаполнение, буфер обмена) — переводим в ДД.ММ.ГГГГ
  if (ISO_RE.test(typed.trim())) return formatBirthDate(parseBirthDate(typed.trim())) || typed.trim()
  const groups = typed
    .replace(/[^\d./\-\s]/g, '')
    .replace(/^[./\-\s]+/, '')
    .split(/[./\-\s]+/)
  const trailing = groups.length > 1 && groups.at(-1) === ''
  if (trailing) groups.pop()
  const limits = [2, 2, 4]
  const out: string[] = []
  let carry = ''
  for (let i = 0; i < limits.length; i++) {
    const g = carry + (groups[i] ?? '')
    if (!g) break
    // Лишние цифры группы переходят в следующую: «0503» → «05» и «03»
    out.push(g.slice(0, limits[i]))
    carry = g.slice(limits[i])
    if (!carry && i + 1 >= groups.length) break
  }
  return out.join('.') + (trailing && out.length < 3 ? '.' : '')
}
