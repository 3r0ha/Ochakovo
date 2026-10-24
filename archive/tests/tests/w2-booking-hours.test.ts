// Самозапись, w2-bk-1 без базы: какие часы видит кандидат (рабочие дни и часы отдела, норма часа, не раньше чем через
// LEAD_HOURS, по три в день), когда время недоступно, состояние предложения и тексты бота.
// Время — от текущего момента. Запуск: pnpm test w2-booking-hours

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultWorkSettings, hourKey, isWorkDay, mskAt, mskParts, type WorkSettings } from '../../shared/workdays'
import { freeHours, HORIZON_DAYS, hourProblem, LEAD_HOURS, loadOf, MAX_HOURS, workHours } from '../../server/booking/hours'
import { offerStateOf } from '../../server/booking/state'
import { bookedMessage, hourAction, hourButtonText, NO_HOURS_TEXT, offerMessage } from '../../server/booking/text'
import * as texts from '../../server/booking/text'

const DAY = 864e5
const now = Date.now()
const shift = (day: string, by: number) => new Date(Date.parse(`${day}T00:00:00Z`) + by * DAY).toISOString().slice(0, 10)
const settings: WorkSettings = { ...defaultWorkSettings }

test('часы: не больше шести, рабочие дни и часы, не раньше чем через LEAD_HOURS, по порядку', () => {
  const hours = freeHours({ load: {}, settings, now })
  assert.equal(hours.length, MAX_HOURS)
  for (let i = 0; i < hours.length; i++) {
    const at = hours[i]
    const p = mskParts(at)
    assert.ok(isWorkDay(p.day, settings), `${p.day} — рабочий день`)
    assert.ok(p.hour >= settings.start && p.hour < settings.end, `час ${p.hour} в рабочем дне`)
    assert.equal(p.minute, 0, 'ровно начало часа')
    assert.ok(at.getTime() >= now + LEAD_HOURS * 3600e3, 'не раньше чем через LEAD_HOURS')
    assert.ok(at.getTime() <= now + HORIZON_DAYS * DAY, 'не дальше горизонта')
    if (i) assert.ok(at > hours[i - 1], 'ближайшие первыми')
  }
})

test('часы: в одном дне не больше трёх — утром, днём и ближе к вечеру', () => {
  const hours = freeHours({ load: {}, settings, now, limit: 30 })
  const parts = [workHours(settings).slice(0, 3), workHours(settings).slice(3, 6), workHours(settings).slice(6)]
  const byDay = new Map<string, number[]>()
  for (const h of hours) byDay.set(mskParts(h).day, [...(byDay.get(mskParts(h).day) ?? []), mskParts(h).hour])
  for (const [day, list] of byDay) {
    assert.ok(list.length <= 3, `${day}: ${list}`)
    const seen = list.map((h) => parts.findIndex((p) => p.includes(h)))
    assert.equal(new Set(seen).size, list.length, `${day}: часы из разных частей дня`)
  }
  // Полный день без «сегодня»: ровно утро, день и вечер — первые часы каждой части
  const full = [...byDay.entries()].find(([day]) => mskAt(day, settings.start).getTime() >= now + LEAD_HOURS * 3600e3)!
  assert.deepEqual(full[1], parts.map((p) => p[0]))
})

test('часы: час с заполненной нормой не предлагается, вместо него — следующий в той же части дня', () => {
  // Утренний час полного дня: следующий за ним — в той же части дня
  const first = freeHours({ load: {}, settings, now, limit: 30 }).find((h) => mskParts(h).hour === settings.start)!
  const day = mskParts(first).day
  const key = hourKey(first)
  const inDay = (list: Date[]) => list.filter((h) => mskParts(h).day === day).map((h) => mskParts(h).hour)
  const full = freeHours({ load: { [key]: settings.slotCapacity }, settings, now, limit: 30 })
  assert.ok(!full.some((h) => hourKey(h) === key), 'занятый час пропал')
  assert.equal(inDay(full)[0], settings.start + 1, 'взамен — следующий час утра')
  const almost = freeHours({ load: { [key]: settings.slotCapacity - 1 }, settings, now, limit: 30 })
  assert.equal(inDay(almost)[0], settings.start, 'одно место ещё есть — час предлагается')
  // Норма из настроек: при норме 1 одного записанного достаточно, чтобы час закрылся
  const one = freeHours({ load: { [key]: 1 }, settings: { ...settings, slotCapacity: 1 }, now, limit: 30 })
  assert.ok(!one.some((h) => hourKey(h) === key))
  // Всё утро занято — утром этого дня ничего, день и вечер остаются
  const morning = Object.fromEntries([0, 1, 2].map((i) => [hourKey(new Date(first.getTime() + i * 3600e3)), settings.slotCapacity]))
  assert.deepEqual(inDay(freeHours({ load: morning, settings, now, limit: 30 })), [settings.start + 3, settings.start + 6])
})

test('часы: уже выбранный час не повторяется, праздники и переносы календаря учтены', () => {
  const hours = freeHours({ load: {}, settings, now })
  const day = mskParts(hours[0]).day
  assert.ok(!freeHours({ load: {}, settings, now, exclude: [hourKey(hours[0])] }).some((h) => hourKey(h) === hourKey(hours[0])))
  const off = freeHours({ load: {}, settings: { ...settings, extraOff: [day] }, now })
  assert.ok(!off.some((h) => mskParts(h).day === day), 'выходной по переносу — без часов')
  // Ближайшая суббота, объявленная рабочей, получает часы
  let sat = shift(mskParts(now + 2 * DAY).day, 0)
  while (mskParts(mskAt(sat, 12)).dow !== 6) sat = shift(sat, 1)
  const before = freeHours({ load: {}, settings, now, limit: 60 })
  const after = freeHours({ load: {}, settings: { ...settings, extraWork: [sat] }, now, limit: 60 })
  assert.ok(!before.some((h) => mskParts(h).day === sat), 'обычная суббота — без часов')
  assert.ok(after.some((h) => mskParts(h).day === sat), 'рабочая суббота — с часами')
  // Короткий рабочий день: последний час начала — за час до конца
  const short = freeHours({ load: {}, settings: { ...settings, start: 10, end: 12 }, now, limit: 60 })
  assert.ok(short.every((h) => [10, 11].includes(mskParts(h).hour)))
})

test('почему на время нельзя записаться', () => {
  const ok = freeHours({ load: {}, settings, now })[0]
  assert.equal(hourProblem(ok, { now, settings }), null)
  assert.equal(hourProblem(new Date(ok.getTime() + 30 * 60e3), { now, settings }), 'not_hour')
  assert.equal(hourProblem(mskAt(mskParts(ok).day, settings.start - 1), { now, settings }), 'off_hours')
  assert.equal(hourProblem(mskAt(mskParts(ok).day, settings.end), { now, settings }), 'off_hours')
  let weekend = mskParts(ok).day
  while (isWorkDay(weekend, settings)) weekend = shift(weekend, 1)
  assert.equal(hourProblem(mskAt(weekend, 11), { now, settings }), 'off_day')
  assert.equal(hourProblem(new Date(Math.ceil(now / 3600e3) * 3600e3 + 3600e3), { now, settings: { ...settings, days: [1, 2, 3, 4, 5, 6, 7], start: 0, end: 24 } }), 'too_soon')
  assert.equal(hourProblem(new Date(Math.ceil(now / 3600e3) * 3600e3 + 20 * DAY), { now, settings: { ...settings, days: [1, 2, 3, 4, 5, 6, 7], start: 0, end: 24 } }), 'too_far')
  assert.equal(hourProblem(new Date(Number.NaN), { now, settings }), 'not_hour')
})

test('занятость: кандидат в часе считается один раз, переносящий своё время не в счёт', () => {
  const at = freeHours({ load: {}, settings, now })[0]
  const rows = [
    { startsAt: at, applicationId: 'A' },
    { startsAt: at, applicationId: 'A' },
    { startsAt: new Date(at.getTime() + 10 * 60e3), applicationId: 'B' },
    { startsAt: new Date(at.getTime() + 3600e3), applicationId: 'C' },
  ]
  assert.deepEqual(loadOf(rows), { [hourKey(at)]: 2, [hourKey(new Date(at.getTime() + 3600e3))]: 1 })
  assert.deepEqual(loadOf(rows, 'A'), { [hourKey(at)]: 1, [hourKey(new Date(at.getTime() + 3600e3))]: 1 })
})

test('состояние предложения: открыто, записан, прошло, срок вышел, HR назначил сам, заявка ушла дальше', () => {
  const offer = { interviewId: null, createdAt: now - 3600e3, expiresAt: now + DAY }
  const base = { status: 'contacted' as const, erased: false, duplicate: false, interview: null, offer }
  assert.equal(offerStateOf(base, now), 'open')
  assert.equal(offerStateOf({ ...base, offer: { ...offer, expiresAt: now - 1 } }, now), 'expired')
  const own = { id: 7, startsAt: now + DAY, createdAt: now }
  assert.equal(offerStateOf({ ...base, status: 'interview', interview: own, offer: { ...offer, interviewId: 7 } }, now), 'booked')
  assert.equal(offerStateOf({ ...base, status: 'interview', interview: { ...own, startsAt: now - 1 }, offer: { ...offer, interviewId: 7 } }, now), 'past')
  // Записанный кандидат не теряет запись, когда истёк срок выбора
  assert.equal(offerStateOf({ ...base, status: 'interview', interview: own, offer: { ...offer, interviewId: 7, expiresAt: now - 1 } }, now), 'booked')
  assert.equal(offerStateOf({ ...base, status: 'interview', interview: { id: 8, startsAt: now + DAY, createdAt: now } }, now), 'closed', 'HR назначил время после предложения')
  assert.equal(offerStateOf({ ...base, status: 'interview', interview: { id: 6, startsAt: now + DAY, createdAt: now - 2 * 3600e3 } }, now), 'open', 'время HR до предложения — кандидат может выбрать другое')
  for (const status of ['hired', 'started', 'declined'] as const) assert.equal(offerStateOf({ ...base, status }, now), 'closed', status)
  assert.equal(offerStateOf({ ...base, erased: true }, now), 'closed')
  assert.equal(offerStateOf({ ...base, duplicate: true }, now), 'closed')
})

test('сообщение бота: часы по дням кнопками, действия короче 64 байт, «Ни одно не подходит», без «!»', () => {
  const hours = freeHours({ load: {}, settings, now })
  const m = offerMessage({ id: 'K7M2QX', vacancyId: 'bottling-operator' }, hours)
  assert.match(m.text, /^\*\*Выбери время собеседования\*\*/)
  assert.ok(m.text.includes('Заявка № K7M2QX · '), m.text)
  assert.ok(m.text.includes('Время по Москве. Адрес: Москва, ул. Рябиновая, 44.'), m.text)
  const actions = m.buttons!.flat().flatMap((b) => (b.kind === 'action' ? [b.action] : []))
  assert.deepEqual(actions.slice(0, hours.length), hours.map(hourAction))
  assert.ok(actions.includes('b:none') && actions.includes('m'))
  for (const row of m.buttons!) assert.ok(row.length <= 3, 'не больше трёх кнопок в ряду')
  for (const a of actions) assert.ok(Buffer.byteLength(a) <= 64)
  for (const h of hours) {
    assert.match(hourAction(h), /^b:\d{4}-\d{2}-\d{2}T\d{2}$/)
    assert.ok(hourButtonText(h).length <= 16, hourButtonText(h))
    assert.match(hourButtonText(h), /^[А-Я][а-я] \d{1,2} · \d{2}:00$/)
    assert.equal(mskAt(hourAction(h).slice(2, 12), Number(hourAction(h).slice(13))).getTime(), h.getTime(), 'действие обратно даёт тот же час')
  }
  const empty = offerMessage({ id: 'K7M2QX', vacancyId: '' }, [])
  assert.ok(empty.text.includes(NO_HOURS_TEXT) && !empty.text.includes('·'))
  const later = offerMessage({ id: 'K7M2QX', vacancyId: '' })
  assert.deepEqual(later.buttons![0], [{ kind: 'action', text: 'Выбрать время', action: 'b:list' }])
  const moved = offerMessage({ id: 'K7M2QX', vacancyId: '' }, hours, { booked: hours[0] })
  assert.ok(moved.text.includes('Сейчас записано:') && moved.buttons!.flat().some((b) => b.kind === 'action' && b.action === 'b:cancel'))
  const done = bookedMessage(hours[0], { address: 'Москва, ул. Рябиновая, 44', bring: 'паспорт' }, false)
  assert.match(done.text, /^\*\*Записано на собеседование: [а-я]+, \d{1,2} [а-я]+, \d{2}:00\*\*/)
  assert.ok(done.text.includes('Взять с собой: паспорт.') && done.text.includes('корпоративный автобус'))
  const all = [m.text, empty.text, later.text, moved.text, done.text, ...Object.values(texts).filter((v): v is string => typeof v === 'string')]
  for (const t of all) {
    assert.ok(!t.includes('!'), t)
    assert.ok(!/\.\.\.|…/.test(t), t)
    // Нейтральный род к собеседнику: ни «готов», ни «записался», ни «самому»
    assert.ok(!/(?<![а-яё])(готов|готова|согласен|записался|записалась|выбрал|выбрала|самому|самой|сам|сама)(?![а-яё])/i.test(t), `нейтральный род: ${t}`)
  }
})
