import type { HrApplication } from '@shared/applications'
import { caseFieldText, sourceName as sharedSourceName } from '@shared/hr'
import { currentSourceNames } from './sourcesCache'

// Подписи, телефоны, «Смена N/4» — общие с сервером, живут в shared/hr.ts
export { channelName, deptName, formatPhone, isReferral, monthsRange, shiftOf, vacancyTitle } from '@shared/hr'

/** Подпись источника: название из реестра меток («Ярмарка МИСИС»), без реестра — встроенный словарь */
export const sourceName = (src: string | null) => sharedSourceName(src, currentSourceNames())

export const formatDate = (iso: string) =>
  new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

/** «2 ч назад», «3 дн назад» — сколько ждёт кандидат */
export function ago(iso: string, now = Date.now()) {
  const h = Math.floor((now - new Date(iso).getTime()) / 3600e3)
  if (h < 1) return 'меньше часа'
  if (h < 48) return `${h} ч`
  return `${Math.floor(h / 24)} дн`
}

/** «завтра, 11:00», «пн, 14 июл, 10:00» */
export function when(iso: string, now = Date.now()) {
  const d = new Date(iso)
  const day = (t: number) => new Date(t + 3 * 3600e3).toISOString().slice(0, 10)
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' })
  if (day(d.getTime()) === day(now)) return `сегодня, ${time}`
  if (day(d.getTime()) === day(now + 864e5)) return `завтра, ${time}`
  if (day(d.getTime()) === day(now - 864e5)) return `вчера, ${time}`
  return `${d.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/Moscow' })}, ${time}`
}

/** 1 заявка, 3 заявки, 5 заявок */
export function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10
  const m100 = n % 100
  const word = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many
  return `${n} ${word}`
}

/**
 * Поля кейса для строки под именем в списке и в шапке карточки: «19 лет», «выход: с июля», «МГУПП · 3–4 курс».
 * Пустая строка — кандидат не указал
 */
export function caseFacts(a: HrApplication, now = Date.now()) {
  const start = caseFieldText(a, 'startReady', now)
  return {
    age: caseFieldText(a, 'age', now),
    birth: caseFieldText(a, 'birthDate', now),
    start: start ? `выход: ${start[0].toLowerCase()}${start.slice(1)}` : '',
    // «Уже не учусь» — слова кандидата; в панели о нём в третьем лице
    study: [a.school?.trim() || (a.notStudying ? 'Уже не учится' : ''), a.course].filter(Boolean).join(' · '),
  }
}
