import { mskAt } from '@shared/workdays'
import { bookingBackend, type BookingBackend } from '../../booking'
import type { BookVia } from '../../booking/state'
import {
  bookedMessage,
  CANCELLED_TEXT,
  EXPIRED_TEXT,
  INVALID_TEXT,
  NO_OFFER_TEXT,
  NONE_AGAIN_TEXT,
  NONE_LABEL,
  NONE_TEXT,
  offerMessage,
  STARTED_TEXT,
  TAKEN_TEXT,
} from '../../booking/text'
import { reply, type Ctx } from '../context'
import type { Button, DialogReply } from '../types'
import { btn, menuRow, msg } from '../ui'

// Самозапись на собеседование в боте (Telegram, MAX и чат на сайте — один движок).
// HR нажимает «Предложить выбрать время» — кандидату приходит сообщение с кнопками часов (offerMessage).
// Кнопки:
//   b:list               свободные часы (и «Другое время» после записи)
//   b:<ГГГГ-ММ-ДДTЧЧ>     записаться на этот час по Москве или перенести запись
//   b:none               «Ни одно не подходит» — HR получает задачу позвонить
//   b:cancel             отменить запись, место освобождается
// Занятый за секунду до нажатия час — «Это время уже заняли, выбери другое» и свежий список.

const HOUR_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2})$/

const statusRow = (): Button[] => [btn('Моя заявка', 'm:status')]

const via = (ctx: Ctx): BookVia => (ctx.user.channel === 'web' ? 'web' : ctx.user.channel)

/** Свободные часы; lead — первая строка вместо заголовка: «Это время уже заняли, выбери другое.» */
async function list(backend: BookingBackend, id: string, lead?: string): Promise<DialogReply> {
  const st = await backend.state(id)
  if (st.state === 'expired') return reply(msg(EXPIRED_TEXT, { buttons: [statusRow(), menuRow()] }))
  if (!st.offered) return reply(msg(lead ? `${lead}\n\n${NO_OFFER_TEXT}` : NO_OFFER_TEXT, { buttons: [statusRow(), menuRow()] }))
  return reply(
    offerMessage(
      { id, vacancyId: st.vacancyId },
      st.hours.map((h) => new Date(h)),
      { lead, booked: st.booked ? new Date(st.booked) : null, address: st.address, hiringDay: st.hiringDay },
    ),
  )
}

export async function route(ctx: Ctx, parts: string[]): Promise<DialogReply> {
  const backend = bookingBackend(ctx.storage)
  if (!backend) return reply(msg(NO_OFFER_TEXT, { buttons: [statusRow(), menuRow()] }))
  const id = await backend.applicationFor(ctx.user, ctx.meta)
  if (!id) {
    const where = ctx.user.channel === 'web' ? 'из этого браузера' : 'из этого чата'
    return reply(
      msg(`Заявки ${where} я не вижу. Время собеседования можно выбрать после заявки, когда отдел персонала предложит.`, {
        buttons: [[btn('Откликнуться', 'm:apply')], menuRow()],
      }),
    )
  }
  const arg = parts[1] ?? 'list'

  const hour = HOUR_RE.exec(arg)
  if (hour) {
    const r = await backend.book(id, mskAt(hour[1], Number(hour[2])), via(ctx))
    if (r.ok) return reply(bookedMessage(new Date(r.startsAt), r, r.moved, r.hiringDay), r.moved ? 'Собеседование перенесено' : 'Записано')
    if (r.error === 'taken') return { ...(await list(backend, id, TAKEN_TEXT)), notice: 'Время уже заняли' }
    if (r.error === 'invalid') return list(backend, id, INVALID_TEXT)
    if (r.error === 'expired') return reply(msg(EXPIRED_TEXT, { buttons: [statusRow(), menuRow()] }))
    return reply(msg(NO_OFFER_TEXT, { buttons: [statusRow(), menuRow()] }))
  }

  if (arg === 'none') {
    const r = await backend.none(id)
    if (r.ok) return reply(msg(r.repeated ? NONE_AGAIN_TEXT : NONE_TEXT, { buttons: [statusRow(), menuRow()] }), r.repeated ? undefined : 'Передано HR')
    if (r.error === 'expired') return reply(msg(EXPIRED_TEXT, { buttons: [statusRow(), menuRow()] }))
    return reply(msg(NO_OFFER_TEXT, { buttons: [statusRow(), menuRow()] }))
  }

  if (arg === 'cancel') {
    const r = await backend.cancel(id, via(ctx))
    if (r.ok) return { ...(await list(backend, id, `${CANCELLED_TEXT} Выбери другое время или нажми «${NONE_LABEL}».`)), notice: 'Запись отменена' }
    if (r.error === 'started') return reply(msg(STARTED_TEXT, { buttons: [statusRow(), menuRow()] }))
    return list(backend, id, 'Записи на собеседование нет.')
  }

  return list(backend, id)
}

/**
 * Кнопки самозаписи для «Моей заявки» в боте: «Выбрать время собеседования», если HR предложил;
 * «Другое время» и «Отменить запись», если кандидат уже записался. Нет предложения — пусто
 */
export async function bookingRows(ctx: Ctx): Promise<Button[][]> {
  const backend = bookingBackend(ctx.storage)
  if (!backend) return []
  const id = await backend.applicationFor(ctx.user, ctx.meta).catch(() => null)
  const st = id ? await backend.state(id).catch(() => null) : null
  if (!st?.offered) return []
  return st.booked ? [[btn('Другое время', 'b:list'), btn('Отменить запись', 'b:cancel')]] : [[btn('Выбрать время собеседования', 'b:list')]]
}
