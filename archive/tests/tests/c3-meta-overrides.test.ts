// Превью ссылок (title, description, og) берут суммы и число вакансий из текущих данных: HR правит вакансию в панели —
// превью меняется без перезапуска сервера. Кэш собранных страниц учитывает номер версии правок.
// Запуск: pnpm test c3-meta-overrides (без базы)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { allVacancies, applyVacancyOverrides, minMonthlyPay } from '../../shared/content/vacancies'
import { pageMetas, renderPage } from '../../server/app'

const template = '<!doctype html><html><head><title>x</title></head><body></body></html>'

test('превью главной и вакансий: сумма после правки из панели, после отмены — прежняя', () => {
  const before = pageMetas()
  const lowest = allVacancies.find((v) => v.pay?.from === minMonthlyPay)!
  assert.ok(lowest, 'есть вакансия с нижней суммой')
  applyVacancyOverrides([{ vacancyId: lowest.id, open: true, pay: { from: 50000 }, hot: false, period: lowest.period ?? 'Март — июль' }])
  try {
    const after = pageMetas()
    assert.notEqual(after['/'].title, before['/'].title)
    assert.match(after['/'].title.replace(/\s/g, ' '), /от 50 000 ₽/)
    assert.match(after['/vacancies'].description.replace(/\s/g, ' '), /от 50 000 до/)
    assert.match(renderPage(template, '/', 'https://season.example.ru/').replace(/\s/g, ' '), /<title>Работа на лето в «Очаково» — от 50 000 ₽ в месяц<\/title>/)
  } finally {
    applyVacancyOverrides([])
  }
  assert.equal(pageMetas()['/'].title, before['/'].title, 'правки сняты — превью как в данных компании')
})
