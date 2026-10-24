// Плакат A3 и листовка A5 (w2-src-3, w2-src-c2): цифры на печати — из shared, как на сайте. Вилка — от меньшей до большей
// суммы оплачиваемой практики, роли — все пять из «Описания практики», общежитие, зарплата, телефон и адрес — из
// справочника студента. В макетах нет дат, восклицательных знаков и сумм, набранных руками.
// Запуск: pnpm test w2-hr-sources-print

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { contacts } from '../../shared/content/content'
import { dorm, PAY_DAYS } from '../../shared/content/handbook'
import { maxEntryPay, minMonthlyPay, paidPractice } from '../../shared/content/vacancies'
import { practicePrint } from '../../shared/sources'

const plain = (s: string) => s.replace(/[  ]/g, ' ')
const rub = (n: number) => `${n.toLocaleString('ru-RU').replace(/\s/g, ' ')} ₽`

test('вилка, роли и условия — из shared', () => {
  const p = practicePrint()
  const pays = paidPractice.map((v) => v.pay!.from)
  assert.equal(p.min, Math.min(...pays))
  assert.equal(p.max, Math.max(...pays))
  assert.equal(p.max, maxEntryPay)
  assert.equal(p.min, minMonthlyPay, 'нижняя граница совпадает с суммой на первом экране сайта')
  assert.equal(plain(p.range), `от ${p.min.toLocaleString('ru-RU').replace(/\s/g, ' ')} до ${rub(p.max)}`)
  assert.equal(p.per, 'в месяц до вычета налога', 'ориентиров среди сумм практики нет — пометки нет')
  assert.deepEqual(new Set(p.roles.map((r) => r.id)), new Set(paidPractice.map((v) => v.id)))
  for (const r of p.roles) {
    const v = paidPractice.find((x) => x.id === r.id)!
    assert.equal(plain(r.pay), `от ${rub(v.pay!.from)}`, r.id)
    assert.equal(r.unit, v.unit)
    assert.equal(r.note.includes('с ночными больше'), Boolean(v.payNote), r.id)
  }
  assert.deepEqual(
    p.roles.map((r) => r.unit),
    ['Лаборатория', 'Цех розлива', 'Технологический цех', 'Складской комплекс', 'Складской комплекс'],
    'порядок отделов как на листовке',
  )
  assert.equal(p.units, 'Лаборатория, цех розлива, технологический цех, склад')
  assert.ok(p.gives.some((g) => plain(g).includes(rub(dorm.priceStudent))), 'общежитие — сумма из справочника')
  assert.ok(p.gives.some((g) => g.includes(`${PAY_DAYS[0]}-го и ${PAY_DAYS[1]}-го`)))
  assert.ok(!p.gives.some((g) => /ДМС/.test(g)), 'ДМС не обещаем')
  assert.ok(p.phone.includes(contacts.phone) && p.phone.includes('доб. 1155'))
  assert.equal(p.route, contacts.route)
  assert.match(p.shuttle, /корпоративный автобус/)
})

test('ориентир у суммы получает пометку «ориентир»', () => {
  const v = paidPractice[0]
  const saved = v.pay
  v.pay = { from: 65000, estimate: true }
  try {
    const p = practicePrint()
    assert.match(p.per, /ориентир/)
    assert.match(p.roles.find((r) => r.id === v.id)!.note, /ориентир/)
  } finally {
    v.pay = saved
  }
})

test('в макетах нет дат, «!» и сумм, набранных руками', () => {
  const files = ['src/pages/HrPoster.tsx', 'src/pages/HrFlyer.tsx', 'src/components/hr/SourcesView.tsx', 'shared/sources.ts']
  for (const f of files) {
    const text = readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8')
    assert.doesNotMatch(text, /\b\d{1,2}\.\d{1,2}\.(19|20)\d{2}\b|\b(19|20)\d{2}-\d{2}-\d{2}\b/, `дата в ${f}`)
    assert.doesNotMatch(text, /[а-яё»]!/i, `восклицательный знак в тексте: ${f}`)
    if (f.startsWith('src/pages/')) assert.doesNotMatch(text, /\d{2}[\s ]000/, `сумма руками в ${f}: цифры — из shared`)
  }
})
