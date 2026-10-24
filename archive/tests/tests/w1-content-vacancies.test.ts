// Данные вакансий и общие помощники: график с ночными сменами, деньги за смену, источники сумм, портфолио.
// Суммы и графики практики — по «Описанию практики» «Очаково», работа — по живым вакансиям на hh.ru. Ориентиров нет.
// Запуск: pnpm test w1-content-vacancies (без базы)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { faqAnswer } from '../../shared/content/faq'
import {
  asksPortfolio,
  estimateNote,
  hasNightShifts,
  maxEntryPay,
  minMonthlyPay,
  netPay,
  NIGHT_SHIFTS_NOTE,
  payLabel,
  scheduleLine,
  scheduleSummary,
  shiftPay,
  vacancies,
  vacanciesByPay,
  vacancyById,
  vacancyFormats,
} from '../../shared/content/vacancies'

const v = (id: string) => vacancyById(id)!

test('ориентиров и «Срочного набора» без источника нет; у каждой суммы — оплачиваемая практика или hh.ru', () => {
  for (const x of vacancies) {
    assert.ok(!x.pay?.estimate, `ориентир у ${x.id}`)
    assert.ok(!x.hot, `«Срочный набор» без источника у ${x.id}`)
    if (x.pay) assert.ok(x.format === 'Оплачиваемая практика' || x.format === 'Постоянная работа', `сумма у ${x.id} (${x.format})`)
    if (x.format === 'Бесплатная практика') assert.equal(x.pay, undefined, `у бесплатной практики суммы нет: ${x.id}`)
  }
  // Старых выдуманных вакансий нет
  for (const id of ['tour-guide', 'line-mechanic', 'hr-intern', 'data-analyst-intern']) assert.equal(vacancyById(id), undefined, id)
})

test('мерчандайзер — 70 000 ₽ и фирменный магазин — 57 000–89 000 ₽ по живым вакансиям на hh.ru', () => {
  assert.deepEqual(v('merchandiser').pay, { from: 70000 })
  assert.match(v('merchandiser').schedule, /5\/2/)
  assert.deepEqual(v('store-worker').pay, { from: 57000, to: 89000 })
  assert.equal(payLabel(v('store-worker')).replace(/\s/g, ' '), '57 000–89 000 ₽')
})

test('форматы: практика оплачиваемая, бесплатная, постоянная работа; порядок показа — практика первой', () => {
  assert.deepEqual(vacancyFormats, ['Оплачиваемая практика', 'Бесплатная практика', 'Постоянная работа'])
  for (const x of vacancies) assert.ok(vacancyFormats.includes(x.format), `${x.id}: ${x.format}`)
  const order = vacanciesByPay.map((x) => vacancyFormats.indexOf(x.format))
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'сначала оплачиваемая практика, потом бесплатная, потом работа')
  // На сайте тот же порядок групп
  const site = vacancies.map((x) => vacancyFormats.indexOf(x.format))
  assert.deepEqual(site, [...site].sort((a, b) => a - b))
  assert.equal(payLabel(v('automation-intern')), 'без оплаты')
})

test('scheduleLine помечает ночные смены, если ночь не названа в самом графике', () => {
  const night = vacancies.filter(hasNightShifts).map((x) => x.id).sort()
  assert.deepEqual(night, ['bottling-operator', 'fermentation-assistant', 'lab-chemist', 'storekeeper', 'warehouse-operator'])
  for (const x of vacancies) {
    assert.ok(scheduleLine(x).startsWith(x.schedule))
    assert.ok(!scheduleLine(x).endsWith('.'), 'строка встаёт внутрь фразы — без точки')
    if (hasNightShifts(x)) assert.match(scheduleLine(x), /ночн|ночь/, `ночь видна у ${x.id}`)
    else assert.ok(!scheduleLine(x).includes(NIGHT_SHIFTS_NOTE))
  }
  // Вакансия из редактора без поля nights — по строке графика
  assert.equal(hasNightShifts({ ...v('store-worker'), nights: undefined, schedule: '2/2, смены по 12 часов' }), true)
  assert.equal(hasNightShifts({ ...v('store-worker'), nights: undefined }), false)
})

test('scheduleSummary — смены по 12 часов, часы смен и графики отделов из «Описания практики»', () => {
  assert.equal(scheduleSummary.title, 'Смены по 12 часов')
  for (const part of ['с 8:00 до 20:00', 'с 20:00 до 8:00', 'день-ночь-отсыпной-выходной', 'в цехе розлива', 'График составляет руководитель'])
    assert.ok(scheduleSummary.text.includes(part), part)
  assert.doesNotMatch(scheduleSummary.text, /экскурс|5\/2|только на лето/)
})

test('shiftPay: только 2/2 по 12 часов с суммой из источника; кладовщик ≈ 3 200 ₽ на руки за смену', () => {
  const sk = shiftPay(v('storekeeper'))!
  assert.ok(sk, 'у кладовщика есть расчёт')
  assert.equal(sk.perShift, 3200)
  assert.equal(sk.perHour, 270)
  assert.equal(sk.shiftsPerMonth, 15.2)
  assert.ok(Math.abs(sk.perShift - netPay(56000) / 15.2) < 100)
  for (const x of vacancies) {
    const sp = shiftPay(x)
    const eligible = Boolean(x.pay && !x.pay.estimate && /2\/2/.test(x.schedule) && /12 час/.test(x.schedule))
    assert.equal(Boolean(sp), eligible, x.id)
    if (sp) {
      assert.equal(sp.perShift % 100, 0)
      assert.equal(sp.perHour % 10, 0)
      assert.ok(Math.abs(sp.perHour - sp.perShift / 12) <= 10)
    }
  }
  assert.equal(shiftPay(v('merchandiser')), null, '5/2 — без расчёта за смену')
  assert.equal(shiftPay(v('bottling-operator')), null, 'в цехе розлива график сменный без 2/2 — не считаем')
  assert.ok(shiftPay(v('store-worker')) && shiftPay(v('fermentation-assistant')) && shiftPay(v('lab-chemist')))
})

test('портфолио спрашивают только у практики в офисе', () => {
  assert.deepEqual(vacancies.filter(asksPortfolio).map((x) => x.id), ['marketing-intern'])
})

test('сноска о суммах верна для каждой строки, FAQ о зарплате с ней согласен', () => {
  assert.match(estimateNote, /до вычета налога/)
  assert.match(estimateNote, /hh\.ru/)
  assert.doesNotMatch(estimateNote, /[Оо]риентир/)
  assert.equal(minMonthlyPay, 56000)
  assert.equal(maxEntryPay, 70000)
  const pay = faqAnswer('pay')
  assert.ok(pay.startsWith('На оплачиваемой практике платят от 56 000 до 70 000 ₽ в месяц до вычета налога'), pay)
  assert.doesNotMatch(pay, /ориентир/)
})
