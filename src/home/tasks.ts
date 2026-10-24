import { steps, type MythCard } from '@shared/content/content'
import { PLANT_BOTTLES_PER_HOUR } from '@shared/content/production'
import { activityList, type ActivityId } from '../store/activities'

/** Задания в порядке появления на странице. Якорь игры ведёт сразу к полю с кнопкой «Играть» */
const order: { id: ActivityId; anchor: string }[] = [
  { id: 'money', anchor: '#money' },
  { id: 'quiz', anchor: '#quiz' },
  { id: 'game', anchor: '#play' },
  { id: 'myth', anchor: '#myth' },
]

export const tasks = order.map((t) => ({ ...t, label: activityList.find((a) => a.id === t.id)!.label }))

export type Task = (typeof tasks)[number]

/** Следующее невыполненное задание после текущего (по кругу), иначе — null */
export function nextTask(done: Partial<Record<ActivityId, true>>, after?: ActivityId): Task | null {
  const start = after ? tasks.findIndex((t) => t.id === after) + 1 : 0
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[(start + i) % tasks.length]
    if (!done[t.id] && t.id !== after) return t
  }
  return null
}

/** Отступ под фиксированную шапку при прокрутке к заданию */
export const HEADER_OFFSET = -84

/** Единственная фраза о пользе заданий на странице — для шапки и финала */
export const SHIFT_HINT = 'Задания заполнят часть анкеты за тебя, а результаты попадут в заявку'

/**
 * Смена закрыта, заявки ещё нет: что осталось. Поля анкеты по кейсу (ФИО, дата рождения, учёба, контакт, когда выйти)
 * не перечисляем — их задаёт форма; срок — из шагов заявки в shared/content/content.ts
 */
export const SHIFT_DONE_LEFT = `Вакансия и месяцы уже в заявке. Осталось рассказать о себе, это ${steps[0].time}.`

/**
 * Крупная цифра вместо фото на карточке «Правда или миф» — у карточек про работу (поле figure)
 * и у карточки про масштаб завода: кадр с банками на линии уже стоит в «Пути кваса». null — карточка с фото
 */
export function mythFigure(card: MythCard): string | null {
  if (card.figure) return card.figure
  if (card.id === 'bottles-per-hour') return `${PLANT_BOTTLES_PER_HOUR.toLocaleString('ru-RU')} бутылок в час`
  return null
}
