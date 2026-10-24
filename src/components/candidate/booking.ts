// Ответ сервера о выборе времени собеседования (w2-booking) — к виду для «Моей заявки». Без браузера: проверяется
// в scripts/tests/w2-pages-chat-status.test.ts. Принимаем и список ISO-строк, и список объектов {startsAt}

/**
 * Предложение выбрать время: часы — ISO-время начала; booked — выбранное время, если уже записался.
 * offered — HR предложил выбрать (даже если свободных часов нет), full — все часы заняты, hiringDay — запись на день найма
 */
export type BookingOffer = {
  hours: string[]
  booked: string | null
  address?: string
  bring?: string
  offered?: true
  full?: true
  hiringDay?: { day: string; address: string }
}

/** Что пришло от сервера — к BookingOffer; без предложения HR или непонятный ответ — null */
export function toBookingOffer(raw: unknown): BookingOffer | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const iso = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null)
  const pick = (v: unknown) => iso(v) ?? (v && typeof v === 'object' ? iso((v as Record<string, unknown>).startsAt) : null)
  const list = Array.isArray(r.hours) ? r.hours : Array.isArray(r.slots) ? r.slots : null
  const booked = pick(r.booked) ?? pick(r.interview)
  if (!list && !booked) return null
  // Сервер отвечает offered: false, когда предложения нет: блок не показываем
  if (r.offered === false && !booked) return null
  const hours = (list ?? []).map(pick).filter((h): h is string => Boolean(h)).slice(0, 6)
  const day = r.hiringDay && typeof r.hiringDay === 'object' ? (r.hiringDay as Record<string, unknown>) : null
  return {
    hours,
    booked,
    ...(typeof r.address === 'string' ? { address: r.address } : {}),
    ...(typeof r.bring === 'string' ? { bring: r.bring } : {}),
    ...(r.offered === true ? { offered: true as const } : {}),
    ...(r.full === true ? { full: true as const } : {}),
    ...(day && typeof day.day === 'string' ? { hiringDay: { day: day.day, address: typeof day.address === 'string' ? day.address : '' } } : {}),
  }
}

