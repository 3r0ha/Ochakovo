// Практика по «Описанию практики» «Очаково» (archive/case-materials/Описание практики.docx):
// оплачиваемая — 5 ролей в 4 отделах с точными суммами, графиками и обязанностями; бесплатная — по договорённости, без суммы.
// Запуск: pnpm test c2-facts-practice (без базы)

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { departments } from '../../shared/content/departments'
import { freePracticeInfo, freePracticeTasks, paidPracticeInfo } from '../../shared/content/practice'
import { stages } from '../../shared/content/production'
import { freePractice, paidPractice, PRACTICE_PERIOD, vacancies, vacancyById } from '../../shared/content/vacancies'

const root = join(import.meta.dirname, '..', '..')
const src = readFileSync(join(root, 'shared/content/vacancies.ts'), 'utf8')

test('оплачиваемая практика: 5 ролей в 4 отделах, суммы до вычета налога — как в «Описании практики»', () => {
  const roles = paidPractice.map((v) => ({ id: v.id, title: v.title, unit: v.unit, pay: v.pay?.from }))
  assert.deepEqual(roles, [
    { id: 'bottling-operator', title: 'Оператор линии розлива', unit: 'Цех розлива', pay: 70000 },
    { id: 'fermentation-assistant', title: 'Оператор технологического цеха', unit: 'Технологический цех', pay: 70000 },
    { id: 'lab-chemist', title: 'Лаборант', unit: 'Лаборатория', pay: 60000 },
    { id: 'warehouse-operator', title: 'Оператор склада', unit: 'Складской комплекс', pay: 60000 },
    { id: 'storekeeper', title: 'Кладовщик', unit: 'Складской комплекс', pay: 56000 },
  ])
  assert.equal(new Set(paidPractice.map((v) => v.unit)).size, 4)
  for (const v of paidPractice) {
    assert.equal(v.period, PRACTICE_PERIOD)
    assert.match(v.schedule, /12 часов/)
    assert.ok(v.nights, `${v.id}: в «Описании практики» у всех ролей есть ночные смены`)
    assert.ok(v.hours?.includes('8:00') && v.hours.includes('20:00'), v.id)
    assert.ok(v.tasks.length >= 2, v.id)
    assert.ok(!v.pay?.to && !v.pay?.estimate, v.id)
  }
  // «(с ночью больше)» — у лаборанта, оператора склада и кладовщика
  assert.deepEqual(paidPractice.filter((v) => v.payNote).map((v) => v.id), ['lab-chemist', 'warehouse-operator', 'storekeeper'])
  assert.match(PRACTICE_PERIOD, /^С марта или апреля до июля или середины августа$/)
  // Технологический цех — только «день — ночь — отсыпной — выходной», лаборатория и склад — ещё и только дневные
  assert.match(vacancyById('fermentation-assistant')!.schedule, /^2\/2 по 12 часов, день-ночь-отсыпной-выходной$/)
  for (const id of ['lab-chemist', 'warehouse-operator', 'storekeeper']) assert.match(vacancyById(id)!.schedule, /только дневные или день-ночь-отсыпной-выходной/)
  assert.equal(vacancyById('bottling-operator')!.schedule, 'Дневные и ночные смены по 12 часов')
})

test('обязанности ролей — словами «Описания практики»', () => {
  const tasks = (id: string) => vacancyById(id)!.tasks.join(' ').toLowerCase()
  assert.match(tasks('bottling-operator'), /линии розлива/)
  assert.match(tasks('bottling-operator'), /этикетировочная.*упаковочная.*выдувная.*паллетайзер/)
  assert.match(tasks('bottling-operator'), /замена комплектующих/)
  assert.match(tasks('fermentation-assistant'), /цехе варки/)
  assert.match(tasks('fermentation-assistant'), /сахар, сироп/)
  assert.match(tasks('warehouse-operator'), /программе/)
  assert.match(tasks('warehouse-operator'), /товарно-транспортные накладные/)
  assert.match(tasks('storekeeper'), /накладными/)
  assert.match(tasks('storekeeper'), /комплектовщиками/)
  assert.match(tasks('lab-chemist'), /органолептические анализы/)
})

test('у каждой суммы — цитата источника в комментарии', () => {
  const quotes: [string, RegExp][] = [
    ['bottling-operator', /«Оператор: работа на линии розлива.*от 70 000 р до вычета налога/s],
    ['fermentation-assistant', /«Оператор: работа в цехе варки.*от 70 000 р до вычета налога/s],
    ['lab-chemist', /«Лаборантов: от 60 000 р до вычета налога \(с ночью больше\)/],
    ['warehouse-operator', /«Оператор: работа с программой.*от 60 000 р до вычета налога/s],
    ['storekeeper', /«Кладовщики: работа с накладными, управление комплектовщиками от 56 000 р до вычета налога/],
    ['store-worker', /https:\/\/hh\.ru\/vacancy\/137288247.*«от 57 000 до 89 000 ₽ за месяц до вычета налогов»/s],
    ['merchandiser', /https:\/\/hh\.ru\/vacancy\/138508330.*«от 70 000 ₽ за месяц до вычета налогов»/s],
  ]
  for (const [id, re] of quotes) {
    const start = src.indexOf(`id: '${id}'`)
    assert.ok(start > 0, id)
    const end = src.indexOf('\n  },', start)
    assert.match(src.slice(start, end), re, `${id}: нет цитаты с суммой`)
  }
  assert.match(src, /Описание практики\.docx/)
})

test('бесплатная практика — без суммы, по договорённости, задачи дословно из «Описания практики»', () => {
  assert.ok(freePractice.length >= 1)
  for (const v of freePractice) {
    assert.equal(v.pay, undefined, v.id)
    assert.match(v.period, /по договорённости/i, v.id)
    assert.match(v.requirements, /Практика от вуза или колледжа/, v.id)
  }
  assert.deepEqual(freePracticeInfo.roles, freePractice.map((v) => v.id))
  assert.equal(freePracticeTasks.length, 11)
  // Каждая задача из документа есть у какой-то вакансии бесплатной практики, и выдуманных задач нет
  const fromVacancies = new Set(freePractice.flatMap((v) => v.tasks))
  assert.deepEqual([...fromVacancies].sort(), [...freePracticeTasks].sort())
  for (const t of ['Маскоты для странички студента', 'Оцифровка производственной линии', 'Взятие проб на контроль качества продукции', 'Разработка макета выкладки продукции'])
    assert.ok(freePracticeTasks.includes(t), t)
})

test('сводка практики: отделы, вилка 56 000–70 000 ₽ и что даёт компания', () => {
  assert.deepEqual(paidPracticeInfo.units, ['Цех розлива', 'Технологический цех', 'Лаборатория', 'Складской комплекс'])
  assert.equal(paidPracticeInfo.payFrom, 56000)
  assert.equal(paidPracticeInfo.payTo, 70000)
  assert.match(paidPracticeInfo.period, /С начала марта или апреля до конца июля или середины августа/)
  assert.match(paidPracticeInfo.contract, /после практики можно перевестись на постоянную работу/)
  const b = paidPracticeInfo.benefits.join(' | ')
  for (const part of ['Спецодежда и медосмотр за счёт компании', 'Половину стоимости обеда', '3 400 ₽', 'Скидка на продукцию', 'Наставник', 'Без испытательного срока'])
    assert.ok(b.includes(part), part)
  assert.doesNotMatch(b, /ДМС/)
})

test('отделы и «Путь кваса» ссылаются только на существующие вакансии; фото этапов по решению кейса', () => {
  const ids = new Set(vacancies.map((v) => v.id))
  for (const s of stages) for (const id of s.vacancies) assert.ok(ids.has(id), `${s.id}: нет вакансии ${id}`)
  const titles = new Set(vacancies.map((v) => v.title))
  for (const d of Object.values(departments)) for (const t of d.tasks) assert.ok(titles.has(t), `${d.id}: «${t}» не из вакансий`)
  assert.equal(departments.quality.name, 'Лаборатория')
  assert.equal(stages.find((s) => s.id === 'qc')!.photo, 'hero-line')
  assert.equal(stages.find((s) => s.id === 'warehouse')!.photo, 'driver')
  assert.ok(stages.every((s) => s.photo !== 'cans-line'), 'банки на этапах не показываем')
})
