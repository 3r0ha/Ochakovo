// Вакансии для hh.ru по официальным фактам: роли только для живых вакансий, оплачиваемая практика — срочный договор
// со строками «Условий», бесплатная практика не публикуется, корпоративный автобус назван один раз.
// Запуск: pnpm test w2-content-hh (без базы)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { contacts, perks } from '../../shared/content/content'
import { freePractice, paidPractice, vacancies, vacancyById, type Vacancy } from '../../shared/content/vacancies'
import { HH_FREE_PRACTICE_PROBLEM, hhRoles, toHhVacancy } from '../../shared/hhVacancy'

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&')
const count = (s: string, part: string) => s.split(part).length - 1

// Роли сверены со справочником https://api.hh.ru/professional_roles
const KNOWN_ROLES: Record<string, string> = {
  '52': 'Кладовщик, приемщик товаров',
  '68': 'Менеджер по маркетингу, интернет-маркетолог',
  '77': 'Мерчандайзер',
  '85': 'Оператор производственной линии',
  '97': 'Продавец-консультант, продавец-кассир',
  '168': 'Лаборант',
  '177': 'Инженер КИПиА',
}

test('роль hh.ru есть у каждой вакансии, удалённых вакансий в словаре нет', () => {
  const ids = new Set(vacancies.map((v) => v.id))
  assert.deepEqual(Object.keys(hhRoles).filter((id) => !ids.has(id)), [], 'роли для вакансий, которых больше нет')
  for (const v of vacancies) {
    const role = hhRoles[v.id]
    assert.ok(role, `нет роли у ${v.id}`)
    assert.equal(KNOWN_ROLES[role.id], role.name, `${v.id}: роль ${role.id} не из справочника`)
  }
  assert.deepEqual(hhRoles.storekeeper, { id: '52', name: 'Кладовщик, приемщик товаров' })
  for (const old of ['tour-guide', 'line-mechanic', 'hr-intern', 'data-analyst-intern']) assert.ok(!(old in hhRoles), old)
})

test('оплачиваемая практика: срочный договор, стажировка, сумма до вычета и условия с сайта', () => {
  assert.equal(paidPractice.length, 5)
  for (const v of paidPractice) {
    const { payload, problems } = toHhVacancy(v, { addressId: '777' })
    const p = payload as Record<string, any>
    assert.deepEqual(problems, [], v.id)
    assert.equal(p.accept_temporary, true, v.id)
    assert.equal(p.internship, true, v.id)
    assert.equal(p.salary_range.from, v.pay!.from)
    assert.equal(p.salary_range.gross, true)
    assert.equal(p.salary_range.frequency.id, 'TWICE_PER_MONTH')
    assert.equal(p.night_shifts, true, `${v.id}: ночные смены`)
    const d = text(p.description)
    for (const perk of perks) assert.ok(d.includes(perk.title), `${v.id}: нет «${perk.title}»`)
    assert.ok(d.includes('3 400') || d.includes('3 400'), `${v.id}: общежитие для студентов`)
    assert.ok(d.includes('Ночные смены оплачивают по повышенному коэффициенту'), v.id)
    assert.equal(count(d, v.period), 1, `${v.id}: период назван один раз`)
    assert.ok(d.includes('Оплачиваемая практика в «Очаково»'), v.id)
    if (v.hours) assert.ok(d.includes(v.hours), `${v.id}: часы смен`)
    assert.ok(!/ДМС/.test(d), `${v.id}: ДМС не обещаем`)
  }
})

test('бесплатную практику на hh.ru не публикуем', () => {
  assert.ok(freePractice.length >= 1)
  for (const v of freePractice) {
    const { payload, problems, warnings } = toHhVacancy(v)
    assert.ok(problems.includes(HH_FREE_PRACTICE_PROBLEM), v.id)
    assert.equal((payload as Record<string, unknown>).salary_range, undefined, v.id)
    assert.equal((payload as Record<string, unknown>).accept_temporary, false, v.id)
    assert.ok(!warnings.some((w) => w.includes('Зарплата не указана')), `${v.id}: противоречивое предупреждение`)
  }
})

test('работа с hh.ru: без срочного договора и без условий практики', () => {
  for (const id of ['store-worker', 'merchandiser']) {
    const v = vacancyById(id)!
    const p = toHhVacancy(v, { addressId: '777' }).payload as Record<string, any>
    assert.equal(p.accept_temporary, false, id)
    assert.equal(p.internship, false, id)
    assert.equal(p.night_shifts, false, id)
    assert.equal(p.salary_range.from, v.pay!.from)
    const d = text(p.description)
    assert.ok(!d.includes('Общежитие') && !d.includes('Наставник'), `${id}: условия практики не переносим на работу`)
  }
  const m = toHhVacancy(vacancyById('merchandiser')!).payload as Record<string, any>
  assert.equal(m.work_format[0].id, 'FIELD_WORK')
  assert.equal(m.work_schedule_by_days[0].id, 'FIVE_ON_TWO_OFF')
  assert.equal(m.working_hours[0].id, 'HOURS_8')
  const s = toHhVacancy(vacancyById('store-worker')!).payload as Record<string, any>
  assert.equal(s.work_schedule_by_days[0].id, 'TWO_ON_TWO_OFF')
  assert.equal(s.working_hours[0].id, 'HOURS_12')
})

test('описание: корпоративный автобус один раз, маршрут и контакты, без «!» и дат', () => {
  for (const v of vacancies) {
    const d = text(toHhVacancy(v).payload.description)
    assert.equal(count(d, 'корпоративный'), 1, `${v.id}: корпоративный автобус назван ${count(d, 'корпоративный')} раз`)
    assert.ok(!d.includes('Корпоративный транспорт'), v.id)
    assert.ok(d.includes('Как добраться: от м. «Озёрная» ходит корпоративный автобус'), v.id)
    assert.ok(d.includes(contacts.address) && d.includes(contacts.email) && d.includes(contacts.phoneNote), v.id)
    assert.ok(!d.includes('!') && !d.includes('..'), `${v.id}: «!» или двойная точка`)
    assert.ok(!/\b(19|20)\d{2}\b|\d{1,2}\.\d{1,2}\.\d{2,4}/.test(d.replace(/1978/g, '')), `${v.id}: дата в описании`)
  }
})

test('ориентир и вакансия без роли не публикуются', () => {
  const base = vacancyById('lab-chemist')!
  const estimate: Vacancy = { ...base, id: 'synthetic-estimate', pay: { from: 50000, estimate: true } }
  assert.ok(toHhVacancy(estimate).problems.some((x) => x.includes('ориентир')))
  const noRole: Vacancy = { ...base, id: 'synthetic-no-role' }
  assert.ok(toHhVacancy(noRole).problems.some((x) => x.includes('роли')))
  const bottling = toHhVacancy(vacancyById('bottling-operator')!)
  // «график сменный» без 2/2 в источнике — честно предупреждаем, а не угадываем
  assert.ok(bottling.warnings.some((w) => w.includes('справочником hh.ru')))
})
