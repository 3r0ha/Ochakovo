import { defaultWorkSettings, hourKey, isWorkDay, mskAt, mskParts, type WorkSettings } from '@shared/workdays'

// Какие часы предложить кандидату. Только рабочие дни и часы отдела из shared/workdays (праздники и переносы учтены),
// не выше нормы на час с учётом уже назначенных собеседований, не раньше чем через LEAD_HOURS.
// Без базы — проверяется в scripts/tests/w2-booking-hours.test.ts.

/** Не раньше чем через столько часов от «сейчас»: HR успевает подготовиться, кандидат — спланировать дорогу */
export const LEAD_HOURS = 18
/** Насколько вперёд показываем часы, календарных дней */
export const HORIZON_DAYS = 14
/** Сколько часов показываем кандидату за раз */
export const MAX_HOURS = 6
/** Сколько дней действует предложение HR, пока кандидат не выбрал время */
export const OFFER_DAYS = 7

/** Занятость по часам: hourKey (ГГГГ-ММ-ДДTЧЧ по Москве) → сколько кандидатов уже записано */
export type HourLoad = Record<string, number>

export type FreeHoursOptions = {
  load: HourLoad
  settings?: WorkSettings
  now?: number
  /** Сколько часов вернуть; по умолчанию MAX_HOURS */
  limit?: number
  /** Часы, которые не предлагаем, — например, уже выбранный кандидатом (hourKey) */
  exclude?: string[]
  /** Не раньше чем через столько часов; по умолчанию LEAD_HOURS */
  leadHours?: number
  horizonDays?: number
}

const DAY = 864e5
const shiftDay = (day: string, by: number) => new Date(Date.parse(`${day}T00:00:00Z`) + by * DAY).toISOString().slice(0, 10)

/** Часы начала собеседований в рабочем дне: с начала дня до часа до его конца */
export const workHours = (s: WorkSettings) => Array.from({ length: Math.max(0, s.end - s.start) }, (_, i) => s.start + i)

export type HourProblem = 'not_hour' | 'off_day' | 'off_hours' | 'too_soon' | 'too_far'

/**
 * Почему на это время нельзя записаться; null — можно. Время — ровно начало часа, рабочий день календаря отдела,
 * рабочий час, не раньше чем через leadHours и не дальше horizonDays. Норму часа проверяет вызывающий
 */
export function hourProblem(
  at: Date,
  o: { now?: number; settings?: WorkSettings; leadHours?: number; horizonDays?: number } = {},
): HourProblem | null {
  const s = o.settings ?? defaultWorkSettings
  const now = o.now ?? Date.now()
  const t = at.getTime()
  if (Number.isNaN(t) || t % 3600e3 !== 0) return 'not_hour'
  const p = mskParts(at)
  if (!isWorkDay(p.day, s)) return 'off_day'
  if (p.hour < s.start || p.hour >= s.end) return 'off_hours'
  if (t < now + (o.leadHours ?? LEAD_HOURS) * 3600e3) return 'too_soon'
  if (t > now + (o.horizonDays ?? HORIZON_DAYS) * DAY) return 'too_far'
  return null
}

/**
 * Свободные часы для кандидата, ближайшие первыми. В каждом дне — не больше трёх: самый ранний свободный час утром,
 * днём и ближе к вечеру (рабочий день делится на три части). Так у студента с парами есть выбор, а внутри каждой
 * части часы заполняются по порядку, как при «Разложить по норме». Час с заполненной нормой не предлагается
 */
export function freeHours(o: FreeHoursOptions): Date[] {
  const s = o.settings ?? defaultWorkSettings
  const now = o.now ?? Date.now()
  const limit = o.limit ?? MAX_HOURS
  const horizon = o.horizonDays ?? HORIZON_DAYS
  const exclude = new Set(o.exclude ?? [])
  const hours = workHours(s)
  const size = Math.ceil(hours.length / 3)
  const parts = [hours.slice(0, size), hours.slice(size, 2 * size), hours.slice(2 * size)].filter((p) => p.length)
  const out: Date[] = []
  if (limit <= 0 || s.slotCapacity < 1) return out
  let day = mskParts(now).day
  for (let i = 0; i <= horizon && out.length < limit; i++, day = shiftDay(day, 1)) {
    if (!isWorkDay(day, s)) continue
    for (const part of parts) {
      if (out.length >= limit) break
      for (const h of part) {
        const at = mskAt(day, h)
        if (hourProblem(at, { now, settings: s, leadHours: o.leadHours, horizonDays: horizon })) continue
        const key = hourKey(at)
        if (exclude.has(key) || (o.load[key] ?? 0) >= s.slotCapacity) continue
        out.push(at)
        break
      }
    }
  }
  return out
}

/** Занятость по часам из списка собеседований: один кандидат в часе считается один раз */
export function loadOf(rows: { startsAt: Date; applicationId: string }[], exceptApplicationId?: string): HourLoad {
  const seen = new Map<string, Set<string>>()
  for (const r of rows) {
    if (r.applicationId === exceptApplicationId) continue
    const key = hourKey(r.startsAt)
    const set = seen.get(key) ?? new Set<string>()
    set.add(r.applicationId)
    seen.set(key, set)
  }
  return Object.fromEntries([...seen].map(([k, v]) => [k, v.size]))
}

// ── День найма ──────────────────────────────────────────────────────────

/** На день найма записываются до часа до начала: день особый, кандидат может прийти в тот же день */
export const HIRING_LEAD_HOURS = 1
/** Часов в дне найма — не больше двенадцати */
export const HIRING_MAX_HOURS = 12

/** День найма для расчёта часов: день по Москве (ГГГГ-ММ-ДД), часы начала и места в каждом часе */
export type HiringDaySlots = { day: string; hours: number[]; capacity: number }

/**
 * Свободные часы дня найма: все часы дня, где ещё есть место и до начала больше HIRING_LEAD_HOURS.
 * Рабочий календарь отдела не нужен: день найма может быть и в субботу
 */
export function hiringDayHours(d: HiringDaySlots, o: { load: HourLoad; now?: number; exclude?: string[] }): Date[] {
  const now = o.now ?? Date.now()
  const exclude = new Set(o.exclude ?? [])
  return [...new Set(d.hours)]
    .sort((a, b) => a - b)
    .map((h) => mskAt(d.day, h))
    .filter((at) => at.getTime() >= now + HIRING_LEAD_HOURS * 3600e3 && !exclude.has(hourKey(at)) && (o.load[hourKey(at)] ?? 0) < d.capacity)
}

/** Можно ли записаться на этот час дня найма (без учёта мест); null — можно */
export function hiringHourProblem(at: Date, d: HiringDaySlots, now = Date.now()): HourProblem | null {
  const t = at.getTime()
  if (Number.isNaN(t) || t % 3600e3 !== 0) return 'not_hour'
  const p = mskParts(at)
  if (p.day !== d.day) return 'off_day'
  if (!d.hours.includes(p.hour)) return 'off_hours'
  if (t < now + HIRING_LEAD_HOURS * 3600e3) return 'too_soon'
  return null
}

/** Что не так с днём найма из панели; null — всё в порядке */
export function hiringDayProblem(d: { day?: unknown; hours?: unknown; capacity?: unknown }, now = Date.now()): string | null {
  const day = typeof d.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.day) && !Number.isNaN(Date.parse(`${d.day}T00:00:00Z`)) ? d.day : null
  if (!day || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) return 'Укажи дату дня найма'
  const today = mskParts(now).day
  if (day < today) return 'Дата дня найма уже прошла'
  if (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`) > 180 * DAY) return 'День найма можно назначить не дальше чем на полгода вперёд'
  const hours = Array.isArray(d.hours) ? d.hours : []
  if (!hours.length || hours.length > HIRING_MAX_HOURS || hours.some((h) => !Number.isInteger(h) || h < 0 || h > 23) || new Set(hours).size !== hours.length)
    return `Выбери часы собеседований: от одного до ${HIRING_MAX_HOURS}, без повторов`
  if (!Number.isInteger(d.capacity) || (d.capacity as number) < 1 || (d.capacity as number) > 100) return 'Мест в часе — от 1 до 100'
  if (!(hours as number[]).some((h) => mskAt(day, h).getTime() > now + HIRING_LEAD_HOURS * 3600e3)) return 'Все часы этого дня уже прошли'
  return null
}

/** Метка дня найма в ссылке: hiringday или hiringday-<латиница и цифры>, до 40 символов */
export const HIRING_LABEL_RE = /^hiringday(-[a-z0-9]+)*$/
export const isHiringLabel = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && HIRING_LABEL_RE.test(v)
