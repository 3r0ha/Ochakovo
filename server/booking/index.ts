import { tokenMatches } from '../candidate/status'
import type { Registry } from '../channels/registry'
import type { Sql } from '../db'
import type { Storage } from '../dialog/storage'
import type { DialogUser, HandleMeta } from '../dialog/types'
import { applicationForChat, book, bookingDeps, bookingState, cancelBooking, noneFits } from './service'
import type { BookingState, BookResult, BookVia, CancelResult, NoneResult } from './state'

// Самозапись на собеседование (пакет w2-booking). Контракт для других пакетов:
//   availableHours(sql, opts) — до 6 свободных часов; book(deps, id, startsAt, via) — записаться или перенести;
//   offerMessage(app, hours?) → OutMessage — сообщение с кнопками часов для бота;
//   offerBooking(deps, ids, by) — «Предложить выбрать время» из HR-панели.
// Маршруты — server/api/booking.ts, кнопки b:… в боте — server/dialog/flows/booking.ts.
// Бот работает через BookingBackend: на PostgreSQL — эти же функции, в проверках без базы — memoryBooking (./memory).

export {
  freeHours,
  HIRING_LEAD_HOURS,
  HIRING_MAX_HOURS,
  hiringDayHours,
  hiringDayProblem,
  hiringHourProblem,
  hourProblem,
  HORIZON_DAYS,
  isHiringLabel,
  LEAD_HOURS,
  MAX_HOURS,
  OFFER_DAYS,
  workHours,
  type HourLoad,
} from './hours'
export {
  availableHours,
  book,
  bookingDeps,
  bookingState,
  cancelBooking,
  CANDIDATE,
  closeHiringDay,
  createHiringDay,
  listHiringDays,
  NONE_NOTE,
  noneFits,
  offerBooking,
  offerInfo,
  offerProblem,
  openOffers,
  withdrawOffer,
  type BookingDeps,
  type HiringDayInfo,
  type HiringDayInput,
  type OfferBulkResult,
  type OfferInfo,
} from './service'
export { OPEN_STATUSES, offerStateOf, type BookingState, type BookResult, type BookVia, type CancelResult, type NoneResult, type OfferState } from './state'
export { bookedMessage, hourAction, hourButtonText, offerMessage, whenLong } from './text'

/** Что нужно сценарию бота: найти заявку человека, показать часы, записать, отменить, «ни одно не подходит» */
export interface BookingBackend {
  /** Заявка человека с открытым предложением, иначе его последняя заявка; null — заявки нет */
  applicationFor(user: DialogUser, meta: HandleMeta): Promise<string | null>
  state(applicationId: string): Promise<BookingState>
  book(applicationId: string, startsAt: Date, via: BookVia): Promise<BookResult>
  cancel(applicationId: string, via: BookVia): Promise<CancelResult>
  none(applicationId: string): Promise<NoneResult>
}

type Runtime = { bots: Registry; env: NodeJS.ProcessEnv }

/** Боты и окружение процесса для базы: их передаёт server/api/booking.ts при сборке API, бот берёт отсюда */
const runtimes = new WeakMap<Sql, Runtime>()
const pgBackends = new WeakMap<Sql, BookingBackend>()
const attached = new WeakMap<object, BookingBackend>()

const noBots: Registry = { get: () => undefined, active: () => [], failed: () => [], start: () => {} }

/**
 * Запомнить ботов и окружение для этой базы: сценарий бота ставит напоминание в тот же бот, что и HR-панель.
 * Без этого (бот без API) напоминание кандидату из бота станет задачей HR «напомнить звонком»
 */
export function registerBookingRuntime(sql: Sql, runtime: Runtime) {
  runtimes.set(sql, runtime)
  pgBackends.delete(sql)
}

/** Подключить свою реализацию к хранилищу бота — memoryBooking для симулятора и проверок без базы */
export function attachBookingBackend(storage: object, backend: BookingBackend) {
  attached.set(storage, backend)
}

function pgBackend(sql: Sql): BookingBackend {
  const known = pgBackends.get(sql)
  if (known) return known
  const rt = runtimes.get(sql)
  const deps = bookingDeps(sql, rt?.bots ?? noBots, rt?.env ?? process.env)
  const backend: BookingBackend = {
    async applicationFor(user, meta) {
      if (user.channel === 'web') {
        const a = meta.application
        return a && (await tokenMatches(sql, a.id, a.token)) ? a.id : null
      }
      return applicationForChat(sql, user.channel, user.id)
    },
    state: (id) => bookingState(deps, id),
    book: (id, startsAt, via) => book(deps, id, startsAt, via),
    cancel: (id, via) => cancelBooking(deps, id, via),
    none: (id) => noneFits(deps, id),
  }
  pgBackends.set(sql, backend)
  return backend
}

/** Самозапись для хранилища бота: PostgreSQL — по его подключению, иначе подключённая через attachBookingBackend; null — нет */
export function bookingBackend(storage: Storage): BookingBackend | null {
  const sql = (storage as { sql?: Sql }).sql
  if (typeof sql === 'function') return pgBackend(sql)
  return attached.get(storage) ?? null
}
