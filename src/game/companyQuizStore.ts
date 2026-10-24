import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { trackEvent } from '../lib/api'

// Итог «Что ты знаешь об „Очаково“» в этом браузере: лучший счёт и последний раунд.
// Только счёт — ни ответов, ни личных данных. По нему главная и страница игры показывают «Лучший результат 6 из 7»,
// а заявка может взять companyQuizSnapshot() (подключение — у владельца формы заявки)

export type CompanyQuizScore = { score: number; total: number }

type CompanyQuizState = {
  /** Лучший счёт — только растёт */
  best: CompanyQuizScore | null
  /** Последний законченный раунд */
  last: CompanyQuizScore | null
  /** Сколько раундов доведено до итога */
  rounds: number
  finish: (score: number, total: number) => void
}

const valid = (score: number, total: number) => Number.isInteger(score) && Number.isInteger(total) && total > 0 && score >= 0 && score <= total

export const useCompanyQuiz = create<CompanyQuizState>()(
  persist(
    (set) => ({
      best: null,
      last: null,
      rounds: 0,
      finish: (score, total) =>
        set((s) => {
          if (!valid(score, total)) return s
          // Первый законченный раунд — событие в анонимной воронке, как у заданий смены: без счёта и ответов
          if (s.rounds === 0) trackEvent('task_done', { task: 'company' })
          const better = !s.best || score / total > s.best.score / s.best.total
          return { rounds: s.rounds + 1, last: { score, total }, best: better ? { score, total } : s.best }
        }),
    }),
    { name: 'ochakovo.companyQuiz', version: 1 },
  ),
)

/** Счёт для заявки: лучший результат или null, если раунд ни разу не закончен */
export const companyQuizSnapshot = (): CompanyQuizScore | null => useCompanyQuiz.getState().best
