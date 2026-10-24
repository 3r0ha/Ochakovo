// Рабочее время отдела персонала: задачи HR («перезвонить», «напомнить о собеседовании»)
// ставятся только на рабочие дни и в рабочие часы. Всё — по Москве (UTC+3, без перехода на летнее время).
// Нерабочие праздники по ст. 112 ТК РФ учитываются всегда. Переносы выходных правительство утверждает
// каждый год отдельно — их администратор вносит сам: дополнительные выходные и рабочие субботы.

export type WorkSettings = {
  /** Рабочие дни недели: 1 — понедельник … 7 — воскресенье */
  days: number[]
  /** Начало и конец рабочего дня, часы по Москве */
  start: number
  end: number
  /** Сколько кандидатов принимаем на собеседование за час */
  slotCapacity: number
  /** Дополнительные выходные по переносам (YYYY-MM-DD) */
  extraOff: string[]
  /** Рабочие дни, которые обычно выходные, — например, перенесённая суббота (YYYY-MM-DD) */
  extraWork: string[]
}

export const defaultWorkSettings: WorkSettings = { days: [1, 2, 3, 4, 5], start: 9, end: 18, slotCapacity: 6, extraOff: [], extraWork: [] }

/** Нерабочие праздничные дни, ст. 112 ТК РФ: месяц-день → название */
export const holidays: Record<string, string> = {
  '01-01': 'Новогодние каникулы',
  '01-02': 'Новогодние каникулы',
  '01-03': 'Новогодние каникулы',
  '01-04': 'Новогодние каникулы',
  '01-05': 'Новогодние каникулы',
  '01-06': 'Новогодние каникулы',
  '01-07': 'Рождество Христово',
  '01-08': 'Новогодние каникулы',
  '02-23': 'День защитника Отечества',
  '03-08': 'Международный женский день',
  '05-01': 'Праздник Весны и Труда',
  '05-09': 'День Победы',
  '06-12': 'День России',
  '11-04': 'День народного единства',
}

export type DayKind = 'work' | 'weekend' | 'holiday' | 'off' | 'extra-work'

/** Что за день по календарю отдела: рабочий, выходной, праздник, перенос */
export function dayKind(day: string, s: WorkSettings = defaultWorkSettings): DayKind {
  if (s.extraWork?.includes(day)) return 'extra-work'
  if (s.extraOff?.includes(day)) return 'off'
  if (holidays[day.slice(5)]) return 'holiday'
  return s.days.includes(mskParts(mskAt(day, 12)).dow) ? 'work' : 'weekend'
}

export const isWorkDay = (day: string, s: WorkSettings = defaultWorkSettings) => {
  const k = dayKind(day, s)
  return k === 'work' || k === 'extra-work'
}

/** Подпись нерабочего дня: «День России», «перенос», «выходной» */
export function dayOffLabel(day: string, s: WorkSettings = defaultWorkSettings) {
  const k = dayKind(day, s)
  if (k === 'holiday') return holidays[day.slice(5)]
  if (k === 'off') return 'выходной по переносу'
  if (k === 'weekend') return 'выходной'
  if (k === 'extra-work') return 'рабочий по переносу'
  return null
}

const MSK = 3 * 3600e3
const DAY = 864e5

/** «Московские» часы и день недели (1–7) для момента времени */
export function mskParts(at: Date | number) {
  const wall = new Date(new Date(at).getTime() + MSK)
  const dow = wall.getUTCDay() || 7
  return { dow, hour: wall.getUTCHours(), minute: wall.getUTCMinutes(), day: wall.toISOString().slice(0, 10) }
}

/** Момент «день + часы по Москве» */
export function mskAt(day: string, hour: number, minute = 0) {
  return new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), hour, minute) - MSK)
}

export const isWorkday = (at: Date | number, s: WorkSettings = defaultWorkSettings) => isWorkDay(mskParts(at).day, s)

const shiftDay = (day: string, by: number) => new Date(Date.parse(`${day}T00:00:00Z`) + by * DAY).toISOString().slice(0, 10)

/** Ближайший рабочий день начиная с day (включительно), шагая вперёд или назад */
function workday(day: string, step: 1 | -1, s: WorkSettings) {
  let d = day
  // Самые длинные нерабочие периоды — новогодние: до двух недель с переносами
  for (let i = 0; i < 21 && !isWorkDay(d, s); i++) d = shiftDay(d, step)
  return d
}

/** Час задачи внутри рабочего дня: «в полдень», но не раньше начала и не позже чем за час до конца */
export const taskHour = (s: WorkSettings) => Math.min(Math.max(12, s.start), Math.max(s.start, s.end - 1))

/**
 * Когда напомнить HR о собеседовании: в предыдущий рабочий день в taskHour.
 * Если этот момент уже прошёл — ближайшее рабочее время до начала собеседования; иначе null.
 */
export function hrReminderTime(startsAt: Date, now = Date.now(), s: WorkSettings = defaultWorkSettings): Date | null {
  const prev = workday(shiftDay(mskParts(startsAt).day, -1), -1, s)
  const at = mskAt(prev, taskHour(s))
  if (at.getTime() > now) return at
  const soon = nextWorkTime(now, s)
  return soon.getTime() < startsAt.getTime() - 3600e3 ? soon : null
}

/** Ближайший момент рабочего времени: сейчас, если рабочее, иначе начало следующего рабочего дня */
export function nextWorkTime(now = Date.now(), s: WorkSettings = defaultWorkSettings): Date {
  const p = mskParts(now)
  const today = isWorkDay(p.day, s)
  if (today && p.hour >= s.start && p.hour < s.end) return new Date(now)
  const startDay = today && p.hour < s.start ? p.day : shiftDay(p.day, 1)
  return mskAt(workday(startDay, 1, s), s.start)
}

/** Следующий рабочий день после сегодняшнего (или через n рабочих дней) в указанный час */
export function workdayAfter(n: number, hour: number, now = Date.now(), s: WorkSettings = defaultWorkSettings): Date {
  let day = mskParts(now).day
  for (let i = 0; i < n; i++) day = workday(shiftDay(day, 1), 1, s)
  return mskAt(day, Math.min(Math.max(hour, s.start), s.end - 1))
}

/** Подпись дня для кнопок: «завтра», «в понедельник» */
export function dayLabel(at: Date, now = Date.now()) {
  const d = mskParts(at).day
  if (d === shiftDay(mskParts(now).day, 1)) return 'завтра'
  if (d === shiftDay(mskParts(now).day, 2)) return 'послезавтра'
  const names = ['', 'в понедельник', 'во вторник', 'в среду', 'в четверг', 'в пятницу', 'в субботу', 'в воскресенье']
  return names[mskParts(at).dow]
}

/** Проверка настроек от администратора; null — всё в порядке */
export function workSettingsProblem(s: Partial<WorkSettings>): string | null {
  if (!Array.isArray(s.days) || !s.days.length || s.days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) return 'Выбери хотя бы один рабочий день'
  if (!Number.isInteger(s.start) || !Number.isInteger(s.end) || s.start! < 0 || s.end! > 24 || s.end! - s.start! < 2) return 'Рабочий день длится не меньше 2 часов, с 0 до 24'
  if (!Number.isInteger(s.slotCapacity) || s.slotCapacity! < 1 || s.slotCapacity! > 100) return 'Кандидатов на час может быть от 1 до 100'
  const dates = (v: unknown) => Array.isArray(v) && v.length <= 60 && v.every((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)))
  if (s.extraOff !== undefined && !dates(s.extraOff)) return 'Дополнительные выходные: даты в виде ГГГГ-ММ-ДД, не больше 60'
  if (s.extraWork !== undefined && !dates(s.extraWork)) return 'Рабочие дни по переносу: даты в виде ГГГГ-ММ-ДД, не больше 60'
  if (s.extraOff?.some((d) => s.extraWork?.includes(d))) return 'Один и тот же день не может быть и выходным, и рабочим'
  return null
}

/**
 * Собеседование вне рабочего времени: выходной, праздник, перенос или час вне рабочего дня.
 * null — всё в порядке. Назначить можно, но только подтвердив
 */
export function slotWarning(startsAt: Date, s: WorkSettings = defaultWorkSettings): string | null {
  const p = mskParts(startsAt)
  const date = new Date(`${p.day}T12:00:00Z`).toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })
  const kind = dayKind(p.day, s)
  if (kind === 'holiday') return `${date}: нерабочий праздник, ${holidays[p.day.slice(5)]}`
  if (kind === 'off') return `${date}: выходной по переносу`
  if (kind === 'weekend') return `${date}: выходной`
  const minutes = p.hour * 60 + p.minute
  const hh = (h: number) => `${String(h).padStart(2, '0')}:00`
  if (minutes < s.start * 60 || minutes >= s.end * 60) return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}: вне рабочего дня (${hh(s.start)}–${hh(s.end)})`
  return null
}

/** Час собеседований — ключ «ГГГГ-ММ-ДДTЧЧ» по Москве: так считают загрузку и график */
export const hourKey = (at: Date | number) => {
  const p = mskParts(at)
  return `${p.day}T${String(p.hour).padStart(2, '0')}`
}

export type SpreadOptions = {
  /** С какого дня раскладывать (ГГГГ-ММ-ДД, по Москве) */
  from: string
  /** Часы собеседований: с from включительно до to не включая, по Москве */
  fromHour: number
  toHour: number
  /** Сколько человек на час — норма из настроек */
  capacity: number
  /** Уже занято по часам: hourKey → сколько назначено */
  booked: Record<string, number>
  settings?: WorkSettings
  /** Не раньше этого момента: прошедшие часы сегодняшнего дня пропускаем */
  now?: number
  /** Сколько календарных дней просматривать вперёд */
  horizonDays?: number
  /** Каждому своё время внутри часа: при норме 6 — шаг 10 минут, с учётом уже назначенных */
  stagger?: boolean
  /** Обеденный час (по Москве) — в него никого не ставим */
  lunchHour?: number | null
  /** Не больше стольких собеседований в день, вместе с уже назначенными */
  dayLimit?: number | null
}

export type SpreadSlot = { startsAt: string; hour: string }

/**
 * «Разложить по норме»: count кандидатов по часам собеседований — по порядку, заполняя каждый час до нормы
 * с учётом уже назначенных. Только рабочие дни календаря отдела (праздники и переносы учтены).
 * Вернёт меньше count, если за horizonDays места не хватило.
 */
export function spreadSlots(count: number, o: SpreadOptions): SpreadSlot[] {
  const s = o.settings ?? defaultWorkSettings
  const now = o.now ?? Date.now()
  const horizon = o.horizonDays ?? 30
  const out: SpreadSlot[] = []
  if (count <= 0 || o.capacity < 1 || o.toHour <= o.fromHour) return out
  let day = o.from
  for (let i = 0; i < horizon && out.length < count; i++, day = shiftDay(day, 1)) {
    if (!isWorkDay(day, s)) continue
    // Сколько уже назначено на этот день — для дневного лимита
    let dayUsed = Object.entries(o.booked).reduce((n, [k, v]) => (k.startsWith(day) ? n + v : n), 0)
    for (let h = o.fromHour; h < o.toHour && out.length < count; h++) {
      if (o.lunchHour !== undefined && o.lunchHour !== null && h === o.lunchHour) continue
      const at = mskAt(day, h)
      if (at.getTime() < now) continue
      const key = hourKey(at)
      const already = o.booked[key] ?? 0
      for (let j = already; j < o.capacity && out.length < count; j++) {
        if (o.dayLimit && dayUsed >= o.dayLimit) break
        const minute = o.stagger ? Math.floor((j * 60) / o.capacity) : 0
        out.push({ startsAt: mskAt(day, h, minute).toISOString(), hour: key })
        dayUsed++
      }
    }
  }
  return out
}
