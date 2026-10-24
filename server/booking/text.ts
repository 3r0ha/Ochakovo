import { interviewDefaults, type HrApplication } from '@shared/applications'
import { hrContactsLine } from '@shared/candidateStatus'
import { contacts } from '@shared/content/content'
import { vacancyById } from '@shared/content/vacancies'
import { mskParts } from '@shared/workdays'
import type { Button, OutMessage } from '../dialog/types'
import { btn, menuRow, msg } from '../dialog/ui'

// Тексты самозаписи для бота и ответов API: время по Москве, прямой ответ первым, обращение на «ты» без рода.
// Кнопки действий (до 64 байт): b:list — свободные часы, b:<ГГГГ-ММ-ДДTЧЧ> — записаться на час,
// b:none — «Ни одно не подходит», b:cancel — отменить запись.

const fmt = (at: Date, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', ...o }).format(at)
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** «11:00» */
export const timeOf = (at: Date) => fmt(at, { hour: '2-digit', minute: '2-digit' })

/** «вторник, 14 июля, 11:00» — для подтверждения записи */
export const whenLong = (at: Date) => `${fmt(at, { weekday: 'long', day: 'numeric', month: 'long' })}, ${timeOf(at)}`

/** «Вт 14 · 11:00» — короткая подпись кнопки: три кнопки в ряд читаются и в Telegram, и в MAX */
export const hourButtonText = (at: Date) => `${cap(fmt(at, { weekday: 'short' }))} ${fmt(at, { day: 'numeric' })} · ${timeOf(at)}`

/** Действие кнопки часа: b:ГГГГ-ММ-ДДTЧЧ по Москве */
export const hourAction = (at: Date) => {
  const p = mskParts(at)
  return `b:${p.day}T${String(p.hour).padStart(2, '0')}`
}

export const NONE_LABEL = 'Ни одно не подходит'

/** Часы по дням: «Вторник, 14 июля — 09:00, 12:00, 15:00» и ряд кнопок на каждый день */
function byDay(hours: Date[]) {
  const days = new Map<string, Date[]>()
  for (const h of hours) {
    const d = mskParts(h).day
    days.set(d, [...(days.get(d) ?? []), h])
  }
  const lines = [...days.values()].map((list) => `${cap(fmt(list[0], { weekday: 'long', day: 'numeric', month: 'long' }))} — ${list.map(timeOf).join(', ')}`)
  // Ряд кнопок на день, не больше трёх в ряду: на дне найма часов бывает больше
  const rows: Button[][] = [...days.values()].flatMap((list) => {
    const out: Button[][] = []
    for (let i = 0; i < list.length; i += 3) out.push(list.slice(i, i + 3).map((h) => btn(hourButtonText(h), hourAction(h))))
    return out
  })
  return { lines, rows }
}

/** Заявка одной строкой: «Заявка № K7M2QX · Оператор линии розлива» */
const appLine = (app: Pick<HrApplication, 'id' | 'vacancyId'>) => {
  const title = vacancyById(app.vacancyId ?? '')?.title
  return `Заявка № ${app.id}${title ? ` · ${title}` : ''}`
}

export const NO_HOURS_TEXT = `Свободного времени на ближайшие две недели нет. Нажми «${NONE_LABEL}» — HR позвонит и договорится о времени.`

/** «понедельник, 26 октября» для дня ГГГГ-ММ-ДД */
export const dayLong = (day: string) => fmt(new Date(`${day}T12:00:00+03:00`), { weekday: 'long', day: 'numeric', month: 'long' })

/** День найма: все часы заняты */
export const hiringFullText = (day: string) =>
  `Все часы дня найма — ${dayLong(day)} — заняты. Нажми «${NONE_LABEL}» — HR позвонит и предложит другое время.`

/** День найма: в выбранный час — собеседование, оформление в тот же день не обещаем */
export const HIRING_NOTE = 'В выбранный час — собеседование. Оформление — потом: дату назовёт HR.'

/** Предложение выбрать час на дне найма: день по Москве и адрес */
export type HiringDayText = { day: string; address: string }

/**
 * Сообщение с выбором времени: уведомление от HR («Предложить выбрать время») и ответ на b:list.
 * hours — свободные часы (availableHours); без них — кнопка «Выбрать время», часы придут по нажатию.
 * lead — первая строка вместо заголовка, например «Это время уже заняли, выбери другое.»
 */
export function offerMessage(
  app: Pick<HrApplication, 'id' | 'vacancyId'>,
  hours?: Date[],
  opts: { lead?: string; booked?: Date | null; address?: string; hiringDay?: HiringDayText | null } = {},
): OutMessage {
  const hd = opts.hiringDay ?? null
  const head =
    opts.lead ??
    (hd
      ? hours && !hours.length && !opts.booked
        ? '**День найма: мест нет**'
        : opts.booked
          ? '**День найма: другой час**'
          : '**День найма: выбери час собеседования**'
      : opts.booked
        ? '**Другое время собеседования**'
        : '**Выбери время собеседования**')
  const now = opts.booked ? `\nСейчас записано: ${whenLong(opts.booked)}.` : ''
  if (!hours) {
    return msg(`${head}\n\n${appLine(app)}. Отдел персонала предлагает выбрать время собеседования — кнопка ниже.${now}`, {
      buttons: [[btn('Выбрать время', 'b:list')], menuRow()],
    })
  }
  const { lines, rows } = byDay(hours)
  const address = hd?.address || opts.address || interviewDefaults.address
  const list = hours.length
    ? `${lines.join('\n')}\n\nВремя по Москве. Адрес: ${address}.${hd ? `\n${HIRING_NOTE}` : ''}`
    : hd
      ? hiringFullText(hd.day)
      : NO_HOURS_TEXT
  const extra: Button[][] = [[btn(NONE_LABEL, 'b:none')]]
  if (opts.booked) extra.push([btn('Отменить запись', 'b:cancel')])
  return msg(`${head}\n\n${appLine(app)}.${now}\n\n${list}`, { buttons: [...rows, ...extra, menuRow()] })
}

/** Подтверждение записи: когда, куда, что взять, как доехать */
export function bookedMessage(at: Date, place: { address: string; bring: string }, moved: boolean, hiringDay = false): OutMessage {
  const head = moved ? `**Собеседование перенесено: ${whenLong(at)}**` : `**Записано на собеседование: ${whenLong(at)}**`
  const bring = place.bring ? `\nВзять с собой: ${place.bring}.` : ''
  const hiring = hiringDay ? `\n${HIRING_NOTE}` : ''
  return msg(`${head}\n\nВремя по Москве. Адрес: ${place.address}.${bring}\n${contacts.shuttle}${hiring}\n\nНе получается прийти — перенеси или отмени запись: место освободится для другого кандидата.`, {
    buttons: [[btn('Другое время', 'b:list'), btn('Отменить запись', 'b:cancel')], [btn('Моя заявка', 'm:status')], menuRow()],
  })
}

export const TAKEN_TEXT = 'Это время уже заняли, выбери другое.'
export const INVALID_TEXT = 'На это время записаться нельзя, выбери из списка.'
export const NONE_TEXT = 'Передал отделу персонала: HR позвонит и договорится о времени собеседования.'
export const NONE_AGAIN_TEXT = 'Уже передал: HR позвонит и договорится о времени собеседования.'
export const CANCELLED_TEXT = 'Запись отменена, место освободилось.'
export const NO_OFFER_TEXT = `Выбор времени сейчас закрыт: время собеседования назначает отдел персонала. Связаться: ${hrContactsLine}.`
export const EXPIRED_TEXT = `Срок выбора времени закончился. Позвони или напиши в отдел персонала: ${hrContactsLine}. Назови номер заявки.`
export const STARTED_TEXT = `Собеседование уже началось или прошло — отменить запись нельзя. Вопросы — ${hrContactsLine}.`

/** Текст SMS с предложением выбрать время: ссылка на «Мою заявку» и телефон отдела подбора */
export const offerSms = (siteUrl: string) =>
  `Очаково: выбери время собеседования на странице заявки ${siteUrl.replace(/\/$/, '')}/apply или позвони ${contacts.phone}, ${contacts.phoneNote}`
