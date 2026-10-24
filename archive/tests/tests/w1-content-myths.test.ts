// «Правда или миф»: общий набор карточек и колода на одну игру (buildDeck) для сайта и бота.
// Запуск: pnpm test w1-content-myths (без базы)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildDeck, contacts, DECK_SIZE, myths, perks, steps } from '../../shared/content/content'
import { faq } from '../../shared/content/faq'
import { canteen, handbook } from '../../shared/content/handbook'
import { PLANT_BOTTLES_PER_HOUR } from '../../shared/content/production'
import { scheduleSummary, vacancies } from '../../shared/content/vacancies'

/** Повторяемый генератор случайных чисел (mulberry32) */
function seeded(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const work = myths.filter((m) => m.topic === 'work')
const history = myths.filter((m) => m.topic === 'history')

function checkDeck(deck: typeof myths) {
  assert.equal(deck.length, DECK_SIZE)
  assert.equal(new Set(deck.map((m) => m.id)).size, DECK_SIZE, 'карточки в колоде не повторяются')
  assert.equal(deck.filter((m) => m.topic === 'work').length, 3, 'три карточки про работу')
  assert.equal(deck.filter((m) => m.topic === 'history').length, 2, 'две карточки про историю')
  assert.ok(deck.filter((m) => m.truth).length >= 2, 'не меньше двух правд')
  assert.ok(deck.filter((m) => !m.truth).length >= 2, 'не меньше двух мифов')
}

test('набор: пять карточек об истории и восемь о работе, у каждой fact и takeaway', () => {
  assert.equal(history.length, 5)
  assert.equal(work.length, 8)
  assert.equal(new Set(myths.map((m) => m.id)).size, myths.length, 'id не повторяются')
  for (const m of myths) {
    assert.match(m.id, /^[a-z0-9-]+$/, 'id годится для кнопок бота my:<id>:t|f')
    assert.ok(m.fact.trim().endsWith('.'), `fact — законченная фраза: ${m.id}`)
    assert.ok(m.takeaway && m.takeaway[0] === m.takeaway[0].toLowerCase() && !m.takeaway.endsWith('.'), `takeaway со строчной и без точки: ${m.id}`)
    assert.ok(m.claim && m.explain, m.id)
    const all = [m.claim, m.explain, m.fact, m.takeaway, m.figure ?? ''].join(' ')
    assert.ok(!all.includes('!'), `«!» в ${m.id}`)
    assert.ok(!/16 лет|медкниж|медицинск/i.test(all), `без «с 16 лет» и выдумок про медкнижку: ${m.id}`)
    assert.ok(!/в десять раз/i.test(all), m.id)
  }
  for (const m of work) assert.ok(m.figure, `у карточки про работу крупное число или слово: ${m.id}`)
  for (const m of history) assert.ok(m.photo, `у карточки об истории фото: ${m.id}`)
  // На archive-1997 — банки джин-тоника: про алкоголь сайт не говорит
  assert.ok(!myths.some((m) => (m.photo as string | undefined) === 'archive-1997'))
  // Правды и мифы вперемешку: в каждой теме есть и то и другое
  for (const list of [work, history]) assert.ok(list.some((m) => m.truth) && list.some((m) => !m.truth))
})

test('карточки про работу — по справочнику студента: опыт и наставник, 12-го и 27-го, 12 часов, испытательный срок, экзамены, обед, резюме, автобус', () => {
  const byId = Object.fromEntries(work.map((m) => [m.id, m]))
  assert.deepEqual(Object.keys(byId).sort(), ['canteen', 'commute', 'exams', 'experience', 'no-resume', 'payday', 'probation', 'shift-12h'])
  assert.equal(byId.experience.truth, false)
  assert.match(byId.experience.explain, /наставник/)
  assert.equal(byId.payday.truth, false)
  assert.match(byId.payday.explain, /12-го и 27-го/)
  assert.equal(byId['shift-12h'].truth, true)
  assert.match(byId['shift-12h'].explain, /2\/2/)
  assert.match(byId['shift-12h'].explain, /с 20:00 до 8:00/)
  assert.equal(byId.probation.truth, false)
  assert.match(byId.probation.explain, /производственная практика/)
  assert.equal(byId.exams.truth, true)
  assert.match(byId.exams.explain, /на территории предприятия/)
  assert.equal(byId.canteen.truth, true)
  assert.ok(byId.canteen.explain.includes(canteen.lunch))
  assert.equal(byId['no-resume'].truth, false)
  assert.equal(byId.commute.truth, false)
  assert.match(byId.commute.explain, /корпоративный автобус/)
  // «Только весь сезон» и «можно только на лето» в источниках нет — такой карточки нет
  assert.ok(!myths.some((m) => m.id === 'whole-season'))
})

test('цифры в карточках сверены с вакансиями, FAQ, маршрутом и константами', () => {
  const corpus = [
    contacts.route,
    scheduleSummary.text,
    ...vacancies.map((v) => v.schedule),
    ...faq.map((f) => f.a),
    ...handbook.map((h) => h.text),
    ...perks.map((p) => `${p.title} ${p.text}`),
    ...steps.map((s) => s.time),
    PLANT_BOTTLES_PER_HOUR.toLocaleString('ru-RU').replace(/\s/g, ' '),
  ].join(' ')
  for (const m of work) {
    const text = [m.claim, m.explain, m.fact, m.figure ?? ''].join(' ')
    for (const n of text.match(/\d[\d\s]*\d|\d/g) ?? []) assert.ok(corpus.includes(n.trim()), `число ${n} из «${m.id}» не найдено в shared`)
  }
  // Смысловые сверки
  assert.ok(vacancies.filter((v) => v.format === 'Оплачиваемая практика').every((v) => v.schedule.includes('12 часов')))
  assert.ok(scheduleSummary.text.includes('с 8:00 до 20:00') && scheduleSummary.text.includes('с 20:00 до 8:00'))
  assert.ok(faq.find((f) => f.id === 'pay')!.a.includes('два раза в месяц, 12-го и 27-го'))
  assert.ok(faq.find((f) => f.id === 'experience')!.a.includes('без опыта'))
  assert.ok(steps[0].text.includes('Резюме не нужно'))
  assert.equal(steps[0].time, '2 минуты')
  const bottles = myths.find((m) => m.id === 'bottles-per-hour')!
  assert.ok(bottles.fact.includes('70 000 бутылок напитков в час'))
  assert.ok(bottles.explain.includes('Все линии завода вместе'))
})

test('buildDeck: 3 про работу, 2 про историю, не меньше 2 правд и 2 мифов; разные rng — разные колоды', () => {
  const decks = Array.from({ length: 10 }, (_, i) => buildDeck(seeded(i + 1)))
  for (const d of decks) checkDeck(d)
  const keys = decks.map((d) => d.map((m) => m.id).join())
  assert.equal(new Set(keys).size, 10, 'десять прогонов дают десять разных колод')
  assert.equal(buildDeck(seeded(7)).map((m) => m.id).join(), buildDeck(seeded(7)).map((m) => m.id).join(), 'один rng — одна колода')
  checkDeck(buildDeck())
  // Крайние значения rng не ломают колоду
  checkDeck(buildDeck(() => 0))
  checkDeck(buildDeck(() => 0.9999999))
})

test('за много игр в колоду попадает каждая карточка, и составы меняются', () => {
  const rng = seeded(42)
  const seen = new Set<string>()
  const hands = new Set<string>()
  for (let i = 0; i < 2000; i++) {
    const d = buildDeck(rng)
    checkDeck(d)
    d.forEach((m) => seen.add(m.id))
    hands.add(d.map((m) => m.id).sort().join())
  }
  assert.equal(seen.size, myths.length)
  assert.ok(hands.size > 30, `составов всего ${hands.size}`)
})
