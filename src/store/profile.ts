import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { DepartmentId } from '@shared/content/departments'

type ProfileState = {
  /** Направление, которое подобрал короткий тест на главной */
  quizResult: DepartmentId | null
  /** Конкретная вакансия из теста (id из vacancies.ts) */
  quizVacancy: string | null
  /** Месяцы из «Собери лето» — подставляются в заявку */
  months: number[] | null
  /** Ответы подбора работы (номер ответа на каждый вопрос) — чтобы показать запасные вакансии и «почему» */
  quizAnswers: number[] | null
  /** Должность из «Собери лето» (id из vacancies.ts) — сохраняется вместе с месяцами по кнопке «Готово» */
  moneyVacancy: string | null
  /**
   * Что человек сам выбрал для заявки, когда «Собери лето» и «Подбор работы» дали разные вакансии.
   * null — ещё не выбирал: тогда /apply спрашивает сам
   */
  chosenVacancy: string | null
  /** Лучший счёт в игре «Поймай брак» — только растёт */
  conveyorBest: number
  /** Показывать ли счёт игры в заявке: переключатель «Показать результат игры» в форме. На рекорд не влияет */
  attachScore: boolean
  name: string
  /** Откуда пришёл человек: ?src=fair-mgupp, ?utm_source=vk … (первое касание) */
  source: string | null
  /** Звук в игре. По умолчанию выключен: страницу часто открывают в транспорте и на парах */
  muted: boolean
  setQuizResult: (dept: DepartmentId | null) => void
  setQuizVacancy: (id: string | null) => void
  setMonths: (months: number[]) => void
  setQuizAnswers: (answers: number[] | null) => void
  setMoneyVacancy: (id: string | null) => void
  setChosenVacancy: (id: string | null) => void
  setConveyorBest: (score: number) => void
  setAttachScore: (attach: boolean) => void
  setName: (name: string) => void
  setSource: (source: string) => void
  toggleMuted: () => void
}

export const useProfile = create<ProfileState>()(
  persist(
    (set) => ({
      quizResult: null,
      quizVacancy: null,
      months: null,
      quizAnswers: null,
      moneyVacancy: null,
      chosenVacancy: null,
      conveyorBest: 0,
      attachScore: true,
      name: '',
      source: null,
      muted: true,
      setQuizResult: (quizResult) => set({ quizResult }),
      setQuizVacancy: (quizVacancy) => set({ quizVacancy }),
      setMonths: (months) => set({ months }),
      setQuizAnswers: (quizAnswers) => set({ quizAnswers }),
      setMoneyVacancy: (moneyVacancy) => set({ moneyVacancy }),
      setChosenVacancy: (chosenVacancy) => set({ chosenVacancy }),
      // Рекорд только растёт: слабый раунд или отказ показывать счёт его не снижают (для заявки — отдельный attachScore)
      setConveyorBest: (score) => set((s) => (Number.isFinite(score) && score > s.conveyorBest ? { conveyorBest: Math.round(score) } : s)),
      setAttachScore: (attachScore) => set({ attachScore }),
      setName: (name) => set({ name }),
      setSource: (source) => set((s) => (s.source ? s : { source })),
      toggleMuted: () => set((s) => ({ muted: !s.muted })),
    }),
    {
      name: 'ochakovo.profile',
      // Версия 1: звук по умолчанию выключен — один раз выключаем и у тех, кто уже заходил
      version: 1,
      migrate: (persisted, version) => (version < 1 ? { ...(persisted as object), muted: true } : persisted) as ProfileState,
    },
  ),
)
