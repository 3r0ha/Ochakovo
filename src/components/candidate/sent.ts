import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Application } from '@shared/applications'
import { isPractice, vacancyById } from '@shared/content/vacancies'

/** Последняя отправленная заявка — шапка показывает «Заявка отправлена», страница заявки — её номер и что дальше */
export type SentApplication = Pick<Application, 'id' | 'name' | 'phone' | 'contact' | 'vacancyId'> & {
  friend: string
  /** Ключ к статусу заявки: только этот браузер может спросить, что с ней. У старых заявок его нет — тогда показываем обещание и контакты */
  token?: string
  /** Заявка на практику (оплачиваемую, бесплатную или от вуза): «Моя заявка» показывает документы и Учебный центр */
  practice?: boolean
  /** В каком мессенджере человек открыл бота по ссылке с «Моей заявки»: туда придёт ответ HR */
  bot?: 'telegram' | 'max'
}

/** Что нужно запомнить: заявка из формы (statusToken) или из чата на сайте (token, DialogReply.application) */
export type SentInput = Pick<Application, 'id' | 'name' | 'phone' | 'contact' | 'vacancyId'> &
  Partial<Pick<Application, 'practiceSchool' | 'format'>> & { friend?: string; statusToken?: string; token?: string }

/** Практика ли это: отметка «Практика от вуза», формат или вакансия практики */
export const isPracticeApplication = (app: SentInput) => {
  const v = vacancyById(app.vacancyId ?? '')
  return app.practiceSchool === true || app.format === 'Оплачиваемая практика' || app.format === 'Бесплатная практика' || (v ? isPractice(v) : false)
}

type SentState = {
  last: SentApplication | null
  remember: (app: SentInput) => void
  /** Человек открыл бота по ссылке привязки — запоминаем мессенджер */
  setBot: (bot: 'telegram' | 'max') => void
  /** «Отправить ещё одну»: форма снова пустая, шапка — снова «Откликнуться» */
  forget: () => void
}

export const useSentApplication = create<SentState>()(
  persist(
    (set) => ({
      last: null,
      remember: (app) =>
        set({
          last: {
            id: app.id,
            name: app.name,
            phone: app.phone,
            contact: app.contact,
            vacancyId: app.vacancyId,
            friend: app.friend ?? '',
            ...((app.statusToken ?? app.token) ? { token: app.statusToken ?? app.token } : {}),
            ...(isPracticeApplication(app) ? { practice: true } : {}),
          },
        }),
      setBot: (bot) => set((s) => (s.last ? { last: { ...s.last, bot } } : s)),
      forget: () => set({ last: null }),
    }),
    { name: 'ochakovo.application' },
  ),
)

/** Номер заявки — его называют HR и боту. Короткие номера показываем целиком (как в HR-панели и в ответах бота), длинные — по последним 6 знакам */
export const applicationNumber = (id: string) => (id.length <= 12 ? id : id.slice(-6)).toUpperCase()
