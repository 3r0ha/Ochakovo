import type { CheckinAnswer, CheckinReason, CheckinStep } from '@shared/adaptation'
import type { HrApplication, ManualConsent, SeasonLeaveReason, SeasonOutcome, ShiftKind } from '@shared/applications'
import { contacts } from '@shared/content/content'
import { ApiUnavailable, HrUnauthorized, request, type ApplicationPatch, type BulkResult } from '../api'
import { bulkChunked, type ChangeResult } from './desk'

// Вызовы API пакета hr-pipeline: поля кейса в анкете, оформление и первая смена, итог сезона и резерв, согласие,
// самозапись на собеседование (маршрут пакета booking).

/** Что HR правит в анкете: анкета под производство, поля кейса и оформление практиканта. Дата рождения — как ввели */
export type ProfileFields = Partial<
  Pick<
    HrApplication,
    | 'lastName'
    | 'middleName'
    | 'adult'
    | 'citizenship'
    | 'medBook'
    | 'shifts'
    | 'months'
    | 'birthDate'
    | 'startReady'
    | 'startMonth'
    | 'school'
    | 'notStudying'
    | 'mentorName'
    | 'practiceDocs'
  >
>

/** Оформление: дата оформления или медкомиссии, первая смена (ISO), день или ночь, заметка. null стирает дату */
export type OnboardingFields = { onboardingAt?: string | null; firstShiftAt?: string | null; shiftKind?: ShiftKind | ''; onboardingNote?: string }

/** Итог сезона и отметка «Звать в штат / резерв» — только у «На смене» */
export type SeasonFields = { seasonOutcome?: SeasonOutcome | ''; seasonLeaveReason?: SeasonLeaveReason | ''; reserve?: boolean }

export type PipelinePatch = Omit<ApplicationPatch, 'profile'> & {
  profile?: ProfileFields
  onboarding?: OnboardingFields
  season?: SeasonFields
  /** Согласие получено при звонке — отметка от имени сотрудника */
  consent?: Exclude<ManualConsent, 'none'>
  /** «Как дела на смене»: ответ со слов кандидата при звонке */
  checkin?: { step: CheckinStep; answer: CheckinAnswer; reason?: CheckinReason | '' }
  /** Согласия нет (рекомендация), а HR всё равно приглашает — подтвердил */
  allowNoConsent?: boolean
}

/** Изменить заявку: как updateApplication, но с полями кейса, оформлением, итогом сезона и согласием */
export function patchApplication(id: string, body: PipelinePatch) {
  return request<ChangeResult>(`/api/hr/applications/${encodeURIComponent(id)}`, { method: 'PATCH', hr: true, body: JSON.stringify(body) })
}

/** Итог сезона массово: у «На смене» ставится, остальные вернутся в failed с причиной */
export function bulkSeason(ids: string[], season: SeasonFields): Promise<BulkResult> {
  return bulkChunked(ids, { action: 'season', season })
}

/**
 * Готовый текст для вида «Резерв»: появились места. Без нового шаблона — его HR может поправить перед отправкой.
 * Контакты — отдела подбора из справочника студента
 */
export const reserveMessage = `В «Очаково» снова есть места на сезон. Если работа ещё интересна, позвони в отдел подбора: ${contacts.phone}, ${contacts.phoneNote}, или напиши на ${contacts.email}.`

export type BookingOffer = { offered?: { id: string }[]; failed?: { id: string; error: string }[] }

/** Самозаписи на сервере нет (маршрут не подключён) или предложение не приняли — текст для HR в message */
export class BookingError extends Error {}

/** «Предложить выбрать время»: кандидат сам выбирает час собеседования (POST /api/hr/booking/offer, пакет booking) */
export async function offerBooking(ids: string[]): Promise<BookingOffer> {
  const res = await fetch('/api/hr/booking/offer', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-hr-request': '1' },
    body: JSON.stringify({ ids }),
  }).catch(() => {
    throw new ApiUnavailable()
  })
  if (res.status === 401) throw new HrUnauthorized()
  // Маршрут принимает список заявок, ошибки по заявкам — в failed. 404 — маршрута на сервере нет
  if (res.status === 404) throw new BookingError('Самозапись на сервере не подключена. Договорись о времени по телефону')
  const data = (await res.json().catch(() => ({}))) as BookingOffer & { message?: string }
  if (!res.ok) throw new BookingError(data.message ?? 'Предложение не ушло. Попробуй ещё раз')
  return data
}
