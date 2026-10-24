import {
  COMPANY_QUIZ_ROUND,
  companyQuizPassed,
  companyQuizResult,
  companyQuizRound,
  type CompanyQuizRoundItem,
  type CompanyQuizTopic,
} from '@shared/content/companyQuiz'
import { paidPracticeInfo } from '@shared/content/practice'
import { plural } from './result'

// «Что ты знаешь об „Очаково“» — ход прохождения без браузера: раунд, ответ, переход, счёт и тексты итога.
// Вопросы, варианты и объяснения — shared/content/companyQuiz.ts; здесь только порядок действий,
// поэтому всё чистые функции: их сверяет scripts/tests/w2-game-company-quiz.test.ts

/** Тема вопроса — подпись над ним */
export const topicLabels: Record<CompanyQuizTopic, string> = {
  history: 'История',
  kvass: 'Квас',
  company: 'Компания',
  practice: 'Практика',
  mentor: 'Наставник',
  season: 'Сезон',
  life: 'Условия',
}

/** Буквы вариантов, как в «Подборе работы» */
export const optionLetters = ['А', 'Б', 'В', 'Г'] as const

export type QuizPlay = {
  items: CompanyQuizRoundItem[]
  /** Номер текущего вопроса; равен items.length — раунд закончен */
  index: number
  /** Выбранный вариант по каждому отвеченному вопросу — индекс в перемешанных options */
  picks: number[]
}

/** Новый раунд: COMPANY_QUIZ_ROUND случайных вопросов, варианты перемешаны. rng — для повторяемых проверок */
export const newPlay = (rng: () => number = Math.random, size = COMPANY_QUIZ_ROUND): QuizPlay => ({ items: companyQuizRound(rng, size), index: 0, picks: [] })

export const isFinished = (p: QuizPlay) => p.index >= p.items.length
/** На текущий вопрос уже ответили — видно объяснение, ждём «Дальше» */
export const isAnswered = (p: QuizPlay) => !isFinished(p) && p.picks.length > p.index
export const currentItem = (p: QuizPlay): CompanyQuizRoundItem | null => p.items[p.index] ?? null

/** Ответ на текущий вопрос. Второй ответ на тот же вопрос и вариант вне списка ничего не меняют */
export function answer(p: QuizPlay, option: number): QuizPlay {
  const item = currentItem(p)
  if (!item || isAnswered(p) || !Number.isInteger(option) || option < 0 || option >= item.options.length) return p
  return { ...p, picks: [...p.picks, option] }
}

/** К следующему вопросу или к итогу — только после ответа */
export const advance = (p: QuizPlay): QuizPlay => (isAnswered(p) ? { ...p, index: p.index + 1 } : p)

/** Верный ли ответ на вопрос с этим номером; null — ещё не отвечали */
export const verdictAt = (p: QuizPlay, i: number): boolean | null => (i < p.picks.length ? p.picks[i] === p.items[i].answer : null)

export const scoreOf = (p: QuizPlay) => p.picks.filter((pick, i) => pick === p.items[i]?.answer).length

/** Вопросы с неверным ответом — для разбора на итоге: вопрос и правильный вариант */
export const mistakesOf = (p: QuizPlay) =>
  p.items.flatMap((item, i) => (i < p.picks.length && p.picks[i] !== item.answer ? [{ id: item.id, question: item.question, right: item.options[item.answer] }] : []))

/** Клавиша → номер варианта: 1–4 и буквы А–Г в русской раскладке; иначе null */
export function optionForKey(key: string, count: number): number | null {
  const digit = /^[1-9]$/.test(key) ? Number(key) - 1 : -1
  const letter = optionLetters.indexOf(key.toUpperCase() as (typeof optionLetters)[number])
  const i = digit >= 0 ? digit : letter
  return i >= 0 && i < count ? i : null
}

/** «Верно» или «Неверно» и что прочитать экранному диктору: объяснение уже начинается с правильного ответа */
export function feedbackFor(item: CompanyQuizRoundItem, picked: number) {
  const correct = picked === item.answer
  return {
    correct,
    title: correct ? 'Верно' : 'Неверно',
    announce: `${correct ? 'Верно' : 'Неверно'}. ${item.explain}`,
  }
}

/**
 * Фраза итога без счёта в начале: счёт стоит рядом крупно. Если значок заработан, о нём говорит плашка под итогом,
 * поэтому здесь только про ошибки; иначе — хвост companyQuizResult: сколько не хватило до значка
 */
export function resultTail(score: number, total: number): string {
  const misses = total - score
  if (companyQuizPassed(score, total)) return misses === 0 ? 'Все ответы верные.' : misses === 1 ? 'Одна ошибка, разбор ниже.' : `Ошибок: ${misses}, разбор ниже.`
  const tail = companyQuizResult(score, total)
    .replace(/^\d+ из \d+\s*(?:[.,—–-]\s*)?/, '')
    .trim()
  return tail.charAt(0).toUpperCase() + tail.slice(1)
}

/** Одна строка о практике для итога: суммы и число отделов — из «Описания практики» через shared */
export function practiceLine(): string {
  const n = paidPracticeInfo.units.length
  const rub = (x: number) => x.toLocaleString('ru-RU')
  return `Оплачиваемая практика: от ${rub(paidPracticeInfo.payFrom)} до ${rub(paidPracticeInfo.payTo)} ₽ в месяц до вычета налога, ${n} ${plural(n, ['отдел', 'отдела', 'отделов'])}, наставник у каждого новичка.`
}
