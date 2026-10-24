import type { ApplicationStatus } from '@shared/applications'

// Состояние самозаписи и ответы её действий — без базы: их используют и PostgreSQL (./service), и хранилище в памяти
// для симулятора бота (./memory).

/** Где кандидат выбрал время — для строки истории */
export type BookVia = 'site' | 'web' | 'telegram' | 'max'

/** Статусы, при которых кандидат может выбрать время */
export const OPEN_STATUSES: ApplicationStatus[] = ['new', 'contacted', 'no_answer', 'interview']

/**
 * Состояние предложения: none — HR не предлагал; open — можно выбрать время; booked — кандидат записался,
 * собеседование впереди; past — записанное собеседование уже началось; expired — срок выбора прошёл;
 * closed — заявка ушла дальше (отказ, оформление), HR сам назначил время после предложения или данные удалены
 */
export type OfferState = 'none' | 'open' | 'booked' | 'past' | 'expired' | 'closed'

/** Что видит кандидат: GET /api/applications/:id/booking и бот */
export type BookingState = {
  applicationId: string
  vacancyId: string
  state: OfferState
  /** Можно выбирать время: предложение открыто или запись сделана и её можно перенести */
  offered: boolean
  /** Свободные часы (ISO), ближайшие первыми; без уже выбранного */
  hours: string[]
  /** Время собеседования, которое кандидат выбрал сам (ISO); null — не записан */
  booked: string | null
  address: string
  bring: string
  /** До какого момента можно выбрать время; null — уже записан или предложения нет */
  expiresAt: string | null
  /** Когда нажали «Ни одно не подходит» */
  noneAt: string | null
  /** Предложение на день найма: день по Москве (ГГГГ-ММ-ДД) и адрес; null — обычное предложение HR */
  hiringDay: { day: string; address: string } | null
  /** Предложение открыто, кандидат не записан, а свободных часов нет: «мест нет» */
  full: boolean
}

export type BookResult =
  | { ok: true; startsAt: string; address: string; bring: string; moved: boolean; hiringDay: boolean }
  | { ok: false; error: 'taken' | 'invalid'; hours: string[] }
  | { ok: false; error: 'no_offer' | 'expired' }

export type CancelResult = { ok: true } | { ok: false; error: 'no_booking' | 'started' }

export type NoneResult = { ok: true; repeated: boolean } | { ok: false; error: 'no_offer' | 'expired' }

/** Что нужно знать о заявке и собеседовании, чтобы понять состояние предложения */
type StateInput = {
  status: ApplicationStatus
  erased: boolean
  duplicate: boolean
  /** Текущее собеседование заявки: id, начало и когда его создали; null — нет */
  interview: { id: number; startsAt: number; createdAt: number } | null
  offer: { interviewId: number | null; createdAt: number; expiresAt: number }
}

/**
 * Состояние открытого предложения. Запись своя, если текущее собеседование — то, что кандидат выбрал по предложению.
 * Чужое собеседование, созданное после предложения, значит, что время назначил HR: выбор закрыт
 */
export function offerStateOf(x: StateInput, now: number): OfferState {
  if (x.erased || x.duplicate || !OPEN_STATUSES.includes(x.status)) return 'closed'
  const own = x.status === 'interview' && x.interview !== null && x.offer.interviewId !== null && x.offer.interviewId === x.interview.id
  if (own) return x.interview!.startsAt <= now ? 'past' : 'booked'
  if (x.interview && x.interview.createdAt > x.offer.createdAt) return 'closed'
  return x.offer.expiresAt <= now ? 'expired' : 'open'
}
