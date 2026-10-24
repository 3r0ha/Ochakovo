import { request } from '../api'

// Самозапись на собеседование для HR-панели (пакет booking). Сервер — server/api/booking.ts.
// «Предложить выбрать время» — offerBookingTo (тот же маршрут, что offerBooking в src/lib/hr/pipeline.ts);
// здесь же — что с предложением у заявки, открытые предложения для списка, отзыв предложения и дни найма.

/**
 * Что с предложением: none — не предлагали; open — кандидат выбирает; booked — записался сам;
 * past — записанное собеседование уже началось; expired — срок выбора прошёл; closed — время назначил HR или заявка ушла дальше
 */
export type BookingOfferState = 'none' | 'open' | 'booked' | 'past' | 'expired' | 'closed'

/** Предложение по заявке — для карточки кандидата */
export type BookingOfferInfo = {
  state: BookingOfferState
  createdAt: string | null
  /** Кто предложил: имя сотрудника */
  createdBy: string
  /** До какого момента кандидат может выбрать время */
  expiresAt: string | null
  /** Когда кандидат записался */
  usedAt: string | null
  /** Когда кандидат нажал «Ни одно не подходит» — у заявки задача «перезвонить» */
  noneAt: string | null
  /** Часы, которые кандидат видит сейчас (ISO) */
  hours: string[]
  /** Время, которое кандидат выбрал сам (ISO) */
  booked: string | null
  /** Предложение дня найма: день (ГГГГ-ММ-ДД) и адрес; null — обычное */
  hiringDay: { day: string; address: string } | null
  /** Кандидат не записан, а свободных часов нет */
  full: boolean
}

/** Открытое предложение — для пометки в списке заявок */
export type OpenBookingOffer = { applicationId: string; state: Exclude<BookingOfferState, 'none' | 'closed'>; expiresAt: string; noneAt: string | null; booked: string | null }

export type BookingOfferResult = { offered: { id: string; notify: string; detail: string }[]; failed: { id: string; error: string }[] }

/** Подписи состояния для карточки и списка */
export const bookingStateLabel: Record<BookingOfferState, string> = {
  none: 'Время не предлагали',
  open: 'Предложено выбрать время',
  booked: 'Время выбрано кандидатом',
  past: 'Собеседование по самозаписи прошло',
  expired: 'Срок выбора времени вышел',
  closed: 'Выбор времени закрыт',
}

/** «Предложить выбрать время» одной или нескольким заявкам. Ошибки по заявкам — в failed */
export const offerBookingTo = (ids: string[]) => request<BookingOfferResult>('/api/hr/booking/offer', { method: 'POST', hr: true, body: JSON.stringify({ ids }) })

/** Предложение по заявке: состояние, кто и когда предложил, какие часы видит кандидат */
export const bookingInfo = (id: string) => request<BookingOfferInfo>(`/api/hr/booking/${encodeURIComponent(id)}`, { hr: true })

/** Открытые предложения: кто ждёт выбора, кто записался, кому не подошло время */
export const openBookingOffers = () => request<OpenBookingOffer[]>('/api/hr/booking', { hr: true })

/** Отозвать предложение: кандидат больше не видит часов, назначенное собеседование остаётся */
export const withdrawBookingOffer = (id: string) => request<{ withdrawn: boolean }>(`/api/hr/booking/${encodeURIComponent(id)}`, { method: 'DELETE', hr: true })

// ── День найма ──────────────────────────────────────────────────────────

/**
 * День найма: особая дата с часами и местами в каждом часе. Заявка по ссылке дня (метка label: /?src=hiringday,
 * в боте start=hiringday) сразу получает выбор часа. Оформление в тот же день не обещаем
 */
export type HiringDay = {
  id: number
  /** День по Москве, ГГГГ-ММ-ДД */
  day: string
  /** Часы начала собеседований по Москве */
  hours: number[]
  /** Мест в каждом часе */
  capacity: number
  address: string
  label: string
  note: string
  createdBy: string
  createdAt: string
  closedAt: string | null
  /** Записано по часам: «10:00» → сколько человек */
  booked: Record<string, number>
  /** Сколько кандидатов пришло по ссылке и получили выбор часа */
  offers: number
  /** Ссылки с меткой дня: сайт и подключённые боты */
  links: { site: string; telegram?: string; max?: string }
}

export type HiringDayDraft = { day: string; hours: number[]; capacity: number; address?: string; label?: string; note?: string }

/** Дни найма: открытые и прошедшие за месяц */
export const hiringDays = () => request<HiringDay[]>('/api/hr/booking/days', { hr: true })

/** Новый день найма; ошибка в полях — ApiValidationError с message (дата прошла, нет часов, метка занята) */
export const createHiringDay = (draft: HiringDayDraft) =>
  request<{ day: HiringDay }>('/api/hr/booking/days', { method: 'POST', hr: true, body: JSON.stringify(draft) })

/** Отменить день найма: по ссылке больше не записываются, назначенные собеседования остаются */
export const closeHiringDay = (id: number) => request<{ closed: boolean }>(`/api/hr/booking/days/${id}`, { method: 'DELETE', hr: true })
