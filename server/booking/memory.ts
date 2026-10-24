import { interviewDefaults, type ApplicationStatus } from '@shared/applications'
import { defaultWorkSettings, hourKey, type WorkSettings } from '@shared/workdays'
import type { MemoryApplication, memoryStorage } from '../dialog/storage'
import { attachBookingBackend, type BookingBackend } from './index'
import { freeHours, hourProblem, loadOf, OFFER_DAYS } from './hours'
import { offerStateOf, type BookingState, type OfferState } from './state'

// Самозапись без базы — для симулятора бота (pnpm bot:sim) и проверок сценариев на memoryStorage.
// Правила те же, что в PostgreSQL (./service): только по предложению HR, часы — freeHours, норма часа, перенос и отмена
// освобождают место, «Ни одно не подходит» — задача HR. Предложение HR здесь делает вызов offer(id).

type MemoryOffer = {
  createdAt: number
  expiresAt: number
  statusBefore: ApplicationStatus | ''
  /** Собеседование, которое кандидат выбрал по предложению */
  interviewId: number | null
  noneAt: number | null
}

export type MemoryBooking = BookingBackend & {
  /** «Предложить выбрать время» — как кнопка HR. Повторное предложение заменяет прежнее, запись сохраняется */
  offer(applicationId: string): void
  /** Занять места в часе, как будто туда записались другие кандидаты */
  occupy(at: Date, count?: number): void
  /** Задачи HR «перезвонить» после «Ни одно не подходит»: номера заявок */
  calls: string[]
  offers: Map<string, MemoryOffer>
}

type Store = ReturnType<typeof memoryStorage>

const DAY = 864e5

/**
 * Самозапись для хранилища в памяти; подключается к нему, и кнопки b:… в боте начинают работать.
 * now — подменить «сейчас» в проверках
 */
export function memoryBooking(storage: Store, opts: { settings?: WorkSettings; now?: () => number } = {}): MemoryBooking {
  const settings = opts.settings ?? defaultWorkSettings
  const now = opts.now ?? Date.now
  const offers = new Map<string, MemoryOffer>()
  const created = new Map<number, number>()
  const occupied: { startsAt: Date; applicationId: string }[] = []
  const calls: string[] = []
  let seq = 0

  const appById = (id: string) => storage.applications.find((a) => a.id === id && !a.anonymizedAt)
  const statusOf = (a: MemoryApplication): ApplicationStatus => a.status ?? 'new'

  const view = (id: string): { app: MemoryApplication | undefined; offer: MemoryOffer | undefined; state: OfferState } => {
    const app = appById(id)
    const offer = offers.get(id)
    if (!app || !offer) return { app, offer, state: 'none' }
    const i = app.interview ?? null
    const state = offerStateOf(
      {
        status: statusOf(app),
        erased: false,
        duplicate: false,
        interview: i ? { id: i.id, startsAt: Date.parse(i.startsAt), createdAt: created.get(i.id) ?? 0 } : null,
        offer: { interviewId: offer.interviewId, createdAt: offer.createdAt, expiresAt: offer.expiresAt },
      },
      now(),
    )
    return { app, offer, state }
  }

  const load = (except: string) =>
    loadOf(
      [
        ...storage.applications
          .filter((a) => a.status === 'interview' && a.interview && !a.anonymizedAt)
          .map((a) => ({ startsAt: new Date(a.interview!.startsAt), applicationId: a.id })),
        ...occupied,
      ],
      except,
    )

  const hoursFor = (id: string, booked: string | null) =>
    freeHours({ load: load(id), settings, now: now(), exclude: booked ? [hourKey(new Date(booked))] : [] }).map((d) => d.toISOString())

  const state = async (id: string): Promise<BookingState> => {
    const v = view(id)
    const booked = v.state === 'booked' ? v.app!.interview!.startsAt : null
    const base: BookingState = {
      applicationId: id,
      vacancyId: v.app?.vacancyId ?? '',
      state: v.state,
      offered: false,
      hours: [],
      booked: null,
      address: v.app?.interview?.address || interviewDefaults.address,
      bring: v.app?.interview?.bring || interviewDefaults.bring,
      expiresAt: null,
      noneAt: null,
      hiringDay: null,
      full: false,
    }
    if (v.state !== 'open' && v.state !== 'booked') return base
    const hours = hoursFor(id, booked)
    return {
      ...base,
      offered: true,
      hours,
      booked,
      full: !booked && hours.length === 0,
      expiresAt: booked ? null : new Date(v.offer!.expiresAt).toISOString(),
      noneAt: v.offer!.noneAt ? new Date(v.offer!.noneAt).toISOString() : null,
    }
  }

  const mine = (a: MemoryApplication, channel: string, userId: string) =>
    (a.channel === channel && a.channelUserId === userId) || (a.botChannel === channel && a.botUserId === userId)

  const backend: MemoryBooking = {
    offers,
    calls,
    offer(id) {
      const app = appById(id)
      if (!app) throw new Error(`Нет заявки ${id}`)
      const before = view(id)
      const keep = before.state === 'booked' ? before.offer : undefined
      offers.set(id, {
        createdAt: now(),
        expiresAt: now() + OFFER_DAYS * DAY,
        statusBefore: keep?.statusBefore ?? statusOf(app),
        interviewId: keep?.interviewId ?? null,
        noneAt: null,
      })
    },
    occupy(at, count = 1) {
      for (let i = 0; i < count; i++) occupied.push({ startsAt: at, applicationId: `occupied-${occupied.length + 1}` })
    },
    async applicationFor(user, meta) {
      if (user.channel === 'web') {
        const a = meta.application
        return a && (await storage.statusForToken?.(a.id, a.token)) ? a.id : null
      }
      const own = storage.applications.filter((a) => !a.anonymizedAt && mine(a, user.channel, user.id))
      return (own.find((a) => offers.has(a.id)) ?? own[0])?.id ?? null
    },
    state,
    async book(id, startsAt) {
      const v = view(id)
      if (v.state === 'expired') return { ok: false, error: 'expired' }
      if ((v.state !== 'open' && v.state !== 'booked') || !v.app || !v.offer) return { ok: false, error: 'no_offer' }
      const app = v.app
      const booked = v.state === 'booked' ? app.interview!.startsAt : null
      if (hourProblem(startsAt, { now: now(), settings })) return { ok: false, error: 'invalid', hours: hoursFor(id, booked) }
      const place = { address: app.interview?.address || interviewDefaults.address, bring: app.interview?.bring || interviewDefaults.bring }
      if (booked && hourKey(new Date(booked)) === hourKey(startsAt)) return { ok: true, startsAt: booked, ...place, moved: false, hiringDay: false }
      if ((load(id)[hourKey(startsAt)] ?? 0) >= settings.slotCapacity) return { ok: false, error: 'taken', hours: hoursFor(id, booked) }
      if (!booked) v.offer.statusBefore = statusOf(app)
      const interviewId = ++seq
      created.set(interviewId, now())
      app.status = 'interview'
      app.reached = [...new Set([...(app.reached ?? ['new']), 'interview' as const])]
      app.interview = { id: interviewId, startsAt: startsAt.toISOString(), ...place, attended: '', attendedAt: null, selfBooked: true }
      v.offer.interviewId = interviewId
      return { ok: true, startsAt: app.interview.startsAt, ...place, moved: Boolean(booked), hiringDay: false }
    },
    async cancel(id) {
      const v = view(id)
      if (v.state === 'past') return { ok: false, error: 'started' }
      if (v.state !== 'booked' || !v.app || !v.offer) return { ok: false, error: 'no_booking' }
      const before = v.offer.statusBefore
      v.app.status = before === 'new' || before === 'contacted' || before === 'interview' ? before : 'contacted'
      v.app.interview = null
      v.offer.interviewId = null
      v.offer.expiresAt = Math.max(v.offer.expiresAt, now() + 2 * DAY)
      return { ok: true }
    },
    async none(id) {
      const v = view(id)
      if (v.state === 'expired') return { ok: false, error: 'expired' }
      if ((v.state !== 'open' && v.state !== 'booked') || !v.offer) return { ok: false, error: 'no_offer' }
      if (v.offer.noneAt && now() - v.offer.noneAt < 12 * 3600e3) return { ok: true, repeated: true }
      // В PostgreSQL здесь задача HR «перезвонить» на ближайшее рабочее время; в памяти — список
      v.offer.noneAt = now()
      calls.push(id)
      return { ok: true, repeated: false }
    },
  }
  attachBookingBackend(storage, backend)
  return backend
}
