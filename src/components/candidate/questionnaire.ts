import type { DepartmentId } from '@shared/content/departments'
import { asksPortfolio as vacancyAsksPortfolio, hasNightShifts, medBookDepartments, needsMedBook, vacancies, vacancyById } from '@shared/content/vacancies'

/**
 * Какие вопросы анкеты показывать в форме заявки — в зависимости от направления и вакансии.
 * Правила (где нужна медкнижка, где бывают ночные смены) общие с ботом — в shared/content/vacancies.ts.
 * Направление не выбрано — значит, HR подберёт сам: спрашиваем то, что поможет подобрать.
 */

export function asksMedBook(department: DepartmentId | '', vacancyId: string) {
  const v = vacancyById(vacancyId)
  if (v) return needsMedBook(v)
  return !department || medBookDepartments.includes(department)
}

export function asksShifts(department: DepartmentId | '', vacancyId: string) {
  const v = vacancyById(vacancyId)
  if (v) return hasNightShifts(v)
  return vacancies.some((x) => (!department || x.department === department) && hasNightShifts(x))
}

/**
 * Портфолио — для практики в офисе: маскоты, ролики, электронный курс. Вакансия выбрана — правило общее с ботом
 * (asksPortfolio в shared/content/vacancies.ts); выбрано только направление «Офис» — спрашиваем
 */
export function asksPortfolio(department: DepartmentId | '', vacancyId: string) {
  const v = vacancyById(vacancyId)
  return v ? vacancyAsksPortfolio(v) : department === 'office'
}
