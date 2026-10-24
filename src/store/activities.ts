import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { trackEvent } from '../lib/api'

/** Четыре активности на главной — «смена». Прогресс виден в шапке и уходит в заявку */
export type ActivityId = 'game' | 'money' | 'quiz' | 'myth'

export const activityList: { id: ActivityId; label: string; anchor: string }[] = [
  { id: 'game', label: 'Поймай брак', anchor: '#game' },
  { id: 'money', label: 'Собери лето', anchor: '#money' },
  { id: 'quiz', label: 'Подбор работы', anchor: '#quiz' },
  { id: 'myth', label: 'Правда или миф', anchor: '#myth' },
]

type ActivitiesState = {
  done: Partial<Record<ActivityId, true>>
  complete: (id: ActivityId) => void
}

export const useActivities = create<ActivitiesState>()(
  persist(
    (set) => ({
      done: {},
      complete: (id) =>
        set((s) => {
          if (s.done[id]) return s
          // Задание пройдено впервые — отмечаем в анонимной воронке
          trackEvent('task_done', { task: id })
          return { done: { ...s.done, [id]: true } }
        }),
    }),
    { name: 'ochakovo.activities' },
  ),
)

export const selectDoneCount = (s: ActivitiesState) => Object.keys(s.done).length
