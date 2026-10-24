import { vacancies } from './vacancies'

// Подбор работы: ответы дают очки конкретным вакансиям (id из vacancies.ts).
// Профильная учёба весит 5–6. Роли, где нужна профильная учёба (лаборатория, практика с инженерами), без неё набирают
// не больше 5 очков: маркетолог не попадает в лабораторию, а историк — к инженерам. Срок решает формат: «1–2 месяца» — бесплатная практика
// по договорённости, «с весны до конца лета» — оплачиваемая практика, «постоянно» — работа.
// Свойства проверяет scripts/tests/c2-facts-quiz.test.ts — перебором всех сочетаний ответов

export type QuizAnswer = {
  text: string
  weights: Record<string, number>
}

export type QuizQuestion = {
  text: string
  answers: QuizAnswer[]
}

export const quiz: QuizQuestion[] = [
  {
    text: 'Что тебе ближе?',
    answers: [
      { text: 'Делать руками и видеть результат', weights: { 'bottling-operator': 3, 'fermentation-assistant': 2, 'store-worker': 2, storekeeper: 1, 'logistics-planner': 1 } },
      { text: 'Разбираться в технике и автоматике', weights: { 'automation-intern': 2, 'bottling-operator': 2, 'fermentation-assistant': 1 } },
      { text: 'Анализы, точность, контроль качества', weights: { 'lab-chemist': 2, 'microbiologist-intern': 1, 'fermentation-assistant': 1 } },
      { text: 'Общаться с людьми', weights: { merchandiser: 3, 'store-worker': 2, storekeeper: 1, 'marketing-intern': 1 } },
      { text: 'Придумывать идеи, снимать ролики, писать тексты', weights: { 'marketing-intern': 3, merchandiser: 1 } },
      { text: 'Цифры, таблицы, документы', weights: { 'warehouse-operator': 3, storekeeper: 2, 'logistics-planner': 1, 'automation-intern': 1 } },
    ],
  },
  {
    text: 'Где комфортнее работать?',
    answers: [
      { text: 'В цехе, в смене с командой', weights: { 'bottling-operator': 2, 'fermentation-assistant': 2, 'automation-intern': 1 } },
      { text: 'В лаборатории', weights: { 'lab-chemist': 2, 'microbiologist-intern': 1 } },
      { text: 'На складе, в магазине или в разъездах', weights: { 'warehouse-operator': 2, storekeeper: 2, 'store-worker': 2, merchandiser: 2, 'logistics-planner': 1 } },
      { text: 'В офисе за ноутбуком', weights: { 'marketing-intern': 2, 'automation-intern': 1 } },
    ],
  },
  {
    text: 'На кого учишься?',
    answers: [
      { text: 'Технолог, химик, биолог', weights: { 'lab-chemist': 6, 'fermentation-assistant': 5, 'microbiologist-intern': 5 } },
      { text: 'Инженерное дело, автоматизация, IT', weights: { 'automation-intern': 6, 'bottling-operator': 2, 'fermentation-assistant': 1 } },
      { text: 'Логистика, экономика, менеджмент', weights: { 'warehouse-operator': 5, storekeeper: 4, 'logistics-planner': 4, merchandiser: 1 } },
      { text: 'Маркетинг, реклама, PR, дизайн', weights: { 'marketing-intern': 6, merchandiser: 1 } },
      { text: 'История, педагогика, гуманитарное', weights: { 'marketing-intern': 6 } },
      { text: 'Другое или пока не учусь', weights: { 'bottling-operator': 3, 'store-worker': 3, storekeeper: 2, 'warehouse-operator': 1 } },
    ],
  },
  {
    text: 'Сколько времени есть?',
    answers: [
      {
        text: '1–2 месяца, практика от вуза',
        weights: { 'automation-intern': 2, 'microbiologist-intern': 2, 'logistics-planner': 2, 'marketing-intern': 2 },
      },
      {
        text: 'С весны до конца лета',
        weights: { 'bottling-operator': 2, 'fermentation-assistant': 2, 'lab-chemist': 1, 'warehouse-operator': 2, storekeeper: 2 },
      },
      {
        text: 'Хочу работать постоянно',
        weights: { 'store-worker': 3, merchandiser: 4, 'bottling-operator': 1, 'fermentation-assistant': 1, 'warehouse-operator': 1, storekeeper: 1 },
      },
    ],
  },
]

/** Возвращает id вакансии с наибольшей суммой очков; при равенстве — ту, что выше в списке вакансий */
export function scoreQuiz(picks: QuizAnswer[]): string {
  const total = new Map<string, number>()
  for (const pick of picks) for (const [id, w] of Object.entries(pick.weights)) total.set(id, (total.get(id) ?? 0) + w)
  return vacancies.reduce((best, v) => ((total.get(v.id) ?? 0) > (total.get(best) ?? 0) ? v.id : best), vacancies[0].id)
}
