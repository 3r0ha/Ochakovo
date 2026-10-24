import { vacancyById } from '@shared/content/vacancies'
import type { Progress } from './storage'
import type { SiteProgress } from './types'

// «Смена» — четыре задания, как на сайте: игра, «Собери лето», подбор работы, «Правда или миф»

/** action — раздел в боте, anchor — блок на главной сайта */
export const tasks: { key: 'game' | 'money' | 'quiz' | 'myth'; label: string; action: string; anchor: string }[] = [
  { key: 'game', label: 'Поймай брак', action: 'm:game', anchor: '#game' },
  { key: 'money', label: 'Собери лето', action: 'm:money', anchor: '#money' },
  { key: 'quiz', label: 'Подбор работы', action: 'm:quiz', anchor: '#quiz' },
  { key: 'myth', label: 'Правда или миф', action: 'm:myth', anchor: '#myth' },
]

export const isDone = (p: Progress, key: keyof Progress) => p[key] !== undefined && p[key] !== false
export const doneCount = (p: Progress) => tasks.filter((t) => isDone(p, t.key)).length

export const listRu = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} и ${items.at(-1)}`)

/** Строка статуса для меню: в начале — зачем задания, дальше — коротко, что осталось. После заявки — без «подставит в заявку» */
export function shiftStatus(p: Progress, applied = false) {
  const n = doneCount(p)
  if (n === tasks.length) return `Смена закрыта: ${n} из ${n}. HR увидит это в заявке.`
  const left = tasks.filter((t) => !isDone(p, t.key)).map((t) => `«${t.label}»`)
  if (n === 0 && !applied) {
    return `Смена 0/${tasks.length}. Четыре коротких задания: ${listRu(left)}. «Подбор работы» подставит вакансию в заявку, а HR увидит, какие задания пройдены.`
  }
  return `Смена ${n}/${tasks.length}. Осталось: ${listRu(left)}.`
}

/** Строка после выполнения задания */
export function shiftLine(p: Progress) {
  const n = doneCount(p)
  if (n === tasks.length) return `Смена закрыта: ${n} из ${n}. HR увидит это в заявке.`
  return `Смена ${n}/${tasks.length}.`
}

/**
 * Задания, пройденные на сайте, засчитываются и в чате. Сайт только добавляет: то, что уже есть в сессии, не меняем.
 * Подбор работы без вакансии отмечаем пустой строкой — задание пройдено, но вакансию в заявку не подставляем
 */
export function mergeSiteProgress(p: Progress, site: SiteProgress) {
  if (site.game && p.game === undefined) p.game = site.conveyorBest ?? 0
  if (site.money && !p.money) p.money = true
  if (site.months?.length && !p.months?.length) p.months = [...site.months]
  if (site.quiz && p.quiz === undefined) p.quiz = site.quizVacancy && vacancyById(site.quizVacancy) ? site.quizVacancy : ''
  if (site.myth && p.myth === undefined) p.myth = 0
}

/** Ответ на «сколько заданий я прошёл»: что пройдено и что осталось */
export function progressText(p: Progress) {
  const n = doneCount(p)
  const done = tasks.filter((t) => isDone(p, t.key)).map((t) => `«${t.label}»`)
  const left = tasks.filter((t) => !isDone(p, t.key)).map((t) => `«${t.label}»`)
  if (n === tasks.length) return `Смена ${n}/${n}: все задания пройдены. HR увидит это в заявке.`
  if (n === 0) return `Смена 0/${tasks.length}: заданий пока не пройдено. Осталось ${listRu(left)}, каждое на пару минут. HR увидит в заявке, какие пройдены.`
  return `Смена ${n}/${tasks.length}: ${n === 1 ? 'пройдено' : 'пройдены'} ${listRu(done)}. Осталось ${listRu(left)}.`
}

/** «Сколько заданий я прошёл?», «какие задания остались», «мой прогресс». Про задачи на работе — не сюда */
export function isProgressQuestion(text: string) {
  const t = text.toLowerCase().replace(/ё/g, 'е').replace(/(?<![а-я])(скока|скоко|скок)(?![а-я])/g, 'сколько')
  if (/склад|лини[яиюей]|магазин|лаборатор|экскурсовод|оператор|стажер|ваканс|работ[ауеы]|собеседован|медкомисс|инструктаж/.test(t)) return false
  return (
    /задани[йяеюи]|прогресс|смен[аеу]\s*\d\s*\/\s*4/.test(t) ||
    /(что|сколько|чего)\s(мне\s)?(еще\s)?осталось\s(пройти|сделать)/.test(t) ||
    /(что|сколько)\s.*(я\s)?(уже\s)?(прош[её]л|прошла|выполнил|выполнила)(?![а-я])/.test(t)
  )
}
