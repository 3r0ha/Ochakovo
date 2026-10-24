// «Моя заявка» второй волны (w2-pc-c3, w2-pc-1…5): куда ехать и что взять, документы по практике, ответ сервера
// о выборе времени, привязка бота, отзыв согласия, счётчики только при ID. Поведение в браузере — scripts/e2e/pages-chat.ts.
// Запуск: pnpm test w2-pages-chat

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { contacts, routeStations } from '../../shared/content/content'
import { dorm, TRAINING_CENTER_ROOM } from '../../shared/content/handbook'
import { analyticsIds } from '../../src/lib/analytics'
import { toBookingOffer } from '../../src/components/candidate/booking'
import { visitBlocks, visitTitle } from '../../src/components/candidate/visit'

const src = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8')

test('куда ехать: адрес, звонок в отдел подбора до приезда, маршруты по станциям с корпоративным автобусом первым — всем заявкам', () => {
  for (const practice of [true, false]) {
    const [route] = visitBlocks(practice)
    assert.equal(route.id, 'route')
    assert.ok(route.lines[0].startsWith(contacts.address), 'первая строка — адрес')
    assert.match(route.lines[0], /Перед приездом позвони в отдел подбора: 8 800 100-77-77, доб\. 1155, 3105, 2107, или 8 903 591-00-13\./)
    // Маршрут списком по станциям, а не абзацем с девятью номерами автобусов
    assert.deepEqual(route.list, routeStations.map((r) => ({ term: r.from, text: r.how })))
    assert.equal(route.list![0].term, 'м. «Озёрная»')
    assert.match(route.list![0].text, /^корпоративный автобус/)
    assert.equal(route.call?.tel, '88001007777')
  }
  // Список по станциям — те же маршруты, что в contacts.route (бот, FAQ, hh.ru): ни одна станция и ни один номер не потерялись
  const all = routeStations.map((r) => `${r.from} ${r.how}`).join(' ')
  for (const part of ['Озёрная', 'Кунцевская', 'Говорово', 'Рабочий посёлок', 'Киевск', 'Мещерская', '610', '807', '275', '259', '221', 'Рябиновая, 65', 'Пищекомбинат', '15 минут'])
    assert.ok(contacts.route.includes(part) && all.includes(part), part)
})

test('заголовок «Куда ехать и что взять» — только с документами по практике, иначе «Дорога и общежитие»', () => {
  assert.equal(visitTitle(visitBlocks(true)), 'Куда ехать и что взять')
  assert.equal(visitTitle(visitBlocks(false)), 'Дорога и общежитие')
  // Документы по практике — и заявкам на практику без отметки «Практика от вуза»
  const apply = src('pages/Apply.tsx')
  assert.match(apply, /const practice = Boolean\(app\.practice\) \|\| Boolean\(appVacancy && isPractice\(appVacancy\)\)/)
  assert.match(apply, /<VisitInfo practice=\{practice\} \/>/)
})

test('«Моя заявка»: на телефоне статус, потом шаги, потом действия; отзыв согласия — внизу страницы', () => {
  const apply = src('pages/Apply.tsx')
  const success = apply.slice(apply.indexOf('function Success('))
  const at = (part: string) => success.indexOf(part)
  assert.ok(at('<StatusBlock') < at('<StatusSteps') && at('<StatusSteps') < at('Позвать друга'), 'порядок: статус → шаги → действия')
  assert.ok(at('<VisitInfo') < at('<Withdraw'), 'отзыв согласия не внизу')
  // Пройденные шаги приглушены, текущий — красный с меткой «сейчас» на красном
  const status = src('components/candidate/ApplicationStatus.tsx')
  assert.match(status, /now \? 'text-brand-bright' : step\.done \? 'text-white\/35'/)
  assert.match(status, /bg-brand px-1\.5 py-1 [^"]*text-white uppercase">сейчас/)
})

test('документы по практике и Учебный центр, кабинет 525 — только заявкам на практику', () => {
  const practice = visitBlocks(true).find((b) => b.id === 'practice')
  assert.ok(practice, 'у практики нет блока документов')
  const text = practice.lines.join(' ')
  assert.ok(text.includes(`кабинет ${TRAINING_CENTER_ROOM}`))
  for (const part of ['договор о практике', 'приказ', 'дневник или отчёт', 'характеристика', 'доб. 1244 или 3105']) assert.ok(text.includes(part), part)
  assert.equal(visitBlocks(false).some((b) => b.id === 'practice'), false)
})

test('общежитие: адрес, цены из справочника, фен с собой, комендант', () => {
  const text = visitBlocks(false).find((b) => b.id === 'dorm')!.lines.join(' ')
  assert.ok(text.includes(dorm.address))
  assert.ok(text.includes('3 400 ₽') && text.includes('6 800 ₽'))
  assert.match(text, /кроме фена, его стоит взять с собой/)
  assert.match(text, /комендант: 8 495 446-42-55/)
})

test('тексты блоков: без «!», дат и рода', () => {
  for (const b of visitBlocks(true))
    for (const line of [b.title, ...b.lines]) {
      assert.doesNotMatch(line, /!/)
      assert.doesNotMatch(line, /\b(19|20)\d{2}\b/)
      assert.doesNotMatch(line, /\(а\)|готов\b|сможешь ли/)
    }
})

test('выбор времени: ответ сервера к списку часов — до 6, только даты, запись отдельно; без предложения — null', () => {
  const now = Date.now()
  const hours = Array.from({ length: 8 }, (_, i) => new Date(now + (i + 30) * 3600e3).toISOString())
  assert.deepEqual(toBookingOffer({ hours, booked: null }), { hours: hours.slice(0, 6), booked: null })
  assert.deepEqual(toBookingOffer({ slots: hours.slice(0, 2).map((startsAt) => ({ startsAt })) }), { hours: hours.slice(0, 2), booked: null })
  assert.deepEqual(toBookingOffer({ hours: [], booked: { startsAt: hours[3] } }), { hours: [], booked: hours[3] })
  assert.deepEqual(toBookingOffer({ hours: ['завтра', hours[0]] }), { hours: [hours[0]], booked: null })
  assert.equal(toBookingOffer({}), null)
  assert.equal(toBookingOffer(null), null)
})

test('запросы «Моей заявки» — с ключом x-status-token; 404 — заявки нет; 409 — время заняли', () => {
  const api = src('lib/api.ts')
  assert.match(api, /'x-status-token': token/)
  assert.match(api, /'\/withdraw', \{ method: 'POST'/)
  assert.match(api, /'\/bot-link', \{ method: 'POST'/)
  assert.match(api, /if \(e instanceof ApiError && e\.status === 409\) throw new SlotTaken\(\)/)
  const status = src('components/candidate/ApplicationStatus.tsx')
  assert.match(status, /Это время уже заняли, выбери другое\./)
  assert.match(status, /Ни одно время не подходит, позвоните мне/)
  assert.match(src('components/candidate/booking.ts'), /\.slice\(0, 6\)/)
})

test('бот: кнопки только при имени бота из /api/config, строка про /stop, окно открывается по нажатию', () => {
  const status = src('components/candidate/ApplicationStatus.tsx')
  assert.match(status, /const bots = \(\['telegram', 'max'\] as const\)\.filter\(\(b\) => config\?\.bots\[b\]\)/)
  assert.match(status, /if \(!app\.token \|\| !bots\.length\) return null/)
  assert.match(status, /Получать ответ HR в \$\{botName\[bot\]\}/)
  assert.match(status, /Чтобы отвязать его, отправь\\u00A0\/stop/)
  assert.match(status, /const tab = window\.open\('', '_blank'\)/)
})

test('отзыв согласия: подтверждение, после — копия в браузере стёрта', () => {
  const status = src('components/candidate/ApplicationStatus.tsx')
  assert.match(status, /Отозвать согласие и удалить заявку/)
  assert.match(status, /Отменить это нельзя\./)
  const apply = src('pages/Apply.tsx')
  assert.match(apply, /onWithdrawn=\{\(result, number\) => \{\s+forgetSent\(\)/)
  assert.match(apply, /согласие отозвано/)
})

test('подготовка и первая смена — из статуса сервера, пустое не показываем', () => {
  const status = src('components/candidate/ApplicationStatus.tsx')
  assert.match(status, /status\.prepare && status\.prepare\.items\.length > 0/)
  assert.match(status, /status\.firstShift\?\.at && \(status\.stage === 'offer' \|\| status\.stage === 'started'\)/)
  assert.match(status, /step\.id === 'started' && !step\.done && status\.firstShift/)
})

test('счётчики: ID только из метатега и только цифры; без метатега — null', () => {
  const doc = (content: string | null) => ({ querySelector: () => (content === null ? null : { getAttribute: () => content }) }) as unknown as Document
  assert.equal(analyticsIds(doc(null)), null)
  assert.equal(analyticsIds(doc('не json')), null)
  assert.equal(analyticsIds(doc('{}')), null)
  assert.deepEqual(analyticsIds(doc('{"metrika":12345678}')), { metrika: '12345678', vk: null })
  assert.deepEqual(analyticsIds(doc('{"metrika":"1234\\"<script>","vk":"3456789"}')), { metrika: null, vk: '3456789' })
})

test('счётчики: загрузка только после согласия, Вебвизор выключен, цели — тип, задание, вид и метка', () => {
  const a = src('lib/analytics.ts')
  assert.match(a, /if \(!ids \|\| currentChoice\(\) !== 'yes'\) return/)
  assert.match(a, /webvisor: false/)
  assert.match(a, /https:\/\/mc\.yandex\.ru\/metrika\/tag\.js/)
  assert.match(a, /https:\/\/top-fragment\.mail\.ru\/js\/code\.js/)
  // Чтение и запись выбора — в try/catch: закрытое хранилище не ломает сайт
  assert.match(a, /try \{\s+const v = localStorage\.getItem\(KEY\)/)
  assert.match(a, /try \{\s+localStorage\.setItem\(KEY, choice\)/)
  const api = src('lib/api.ts')
  assert.match(api, /export type FunnelEvent = 'visit' \| 'task_done' \| 'apply_open' \| 'application' \| 'game_start' \| 'share'/)
  assert.match(api, /reachGoal\(type, \{ \.\.\.extra, src: source \}\)/)
  // В демо без сервера целей нет: trackEvent выходит до них
  const track = api.slice(api.indexOf('export function trackEvent'))
  assert.ok(track.indexOf('if (demoLocal) return') < track.indexOf('reachGoal('))
  const layout = src('components/Layout.tsx')
  assert.match(layout, /if \(!ids \|\| choice\) return null/)
  assert.match(layout, /Разрешить/)
  assert.match(layout, /Не надо/)
  const privacy = src('pages/Privacy.tsx')
  assert.match(privacy, /if \(!ids\) return \[\]/)
})
