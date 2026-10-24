import { create } from 'zustand'
import { lockScroll } from '../../lib/motion'
import { useActivities } from '../../store/activities'
import { useProfile } from '../../store/profile'
import { useSentApplication } from '../candidate/sent'

/** Открыть чат с Квасычем из любого места сайта: window.dispatchEvent(new Event(OPEN_CHAT_EVENT)) */
export const OPEN_CHAT_EVENT = 'open-kvasych-chat'

/** Вопрос, с которым открыли чат: панель забирает его один раз и отправляет после приветствия */
let pendingQuestion: string | null = null

/**
 * Открыть чат с Квасычем; с вопросом — чат сразу его отправит.
 * В onClick передавать стрелкой: onClick={() => openKvasychChat()}, иначе событие клика примется за вопрос
 */
export function openKvasychChat(question?: string) {
  const q = typeof question === 'string' ? question.trim().slice(0, 1000) : ''
  if (q) pendingQuestion = q
  window.dispatchEvent(new Event(OPEN_CHAT_EVENT))
}

/** Забрать вопрос, с которым открыли чат (один раз) */
export function takePendingQuestion(): string | null {
  const q = pendingQuestion
  pendingQuestion = null
  return q
}

/** Что сейчас висит поверх страницы: меню, сообщение о задании, полоса чата */
type Overlay = {
  toast: boolean
  menu: boolean
  /** На телефоне внизу экрана полоса «Спросить Квасыча» — сообщения о заданиях встают над ней */
  bar: boolean
  setToast: (v: boolean) => void
  setMenu: (v: boolean) => void
  setBar: (v: boolean) => void
}

export const useOverlay = create<Overlay>()((set) => ({
  toast: false,
  menu: false,
  bar: false,
  setToast: (toast) => set({ toast }),
  setMenu: (menu) => set({ menu }),
  setBar: (bar) => set({ bar }),
}))

/** Высота полосы чата на телефоне — столько же отступа получает низ страницы */
export const CHAT_BAR_HEIGHT = 52

/** Прогресс заданий на сайте — уходит в /api/dialog, чтобы бот в чате видел ту же «Смену», что и страница */
export type SiteProgress = {
  game: boolean
  money: boolean
  quiz: boolean
  myth: boolean
  /** Вакансия из подбора работы */
  quizVacancy?: string
  /** Месяцы из «Собери лето» */
  months?: number[]
  /** Лучший счёт в «Поймай брак» */
  conveyorBest?: number
}

export function siteProgress(): SiteProgress {
  const done = useActivities.getState().done
  const p = useProfile.getState()
  return {
    game: Boolean(done.game),
    money: Boolean(done.money),
    quiz: Boolean(done.quiz),
    myth: Boolean(done.myth),
    ...(p.quizVacancy ? { quizVacancy: p.quizVacancy } : {}),
    ...(p.months?.length ? { months: p.months } : {}),
    ...(p.conveyorBest ? { conveyorBest: p.conveyorBest } : {}),
  }
}

/**
 * Заблокировать прокрутку страницы под чатом или меню без сдвига вёрстки.
 * Там, где полоса прокрутки занимает место (Windows, мышь на Mac), она исчезает — страница стала бы шире
 * и всё прыгнуло бы вправо. Поэтому место полосы оставляем пустым (того же тёмного цвета, что и затемнение),
 * а фиксированная шапка не заезжает на него — переменная --lock-gap.
 */
export function lockPage(locked: boolean) {
  const root = document.documentElement
  const gap = locked ? window.innerWidth - root.clientWidth : 0
  lockScroll(locked)
  root.style.setProperty('--lock-gap', `${gap}px`)
  root.style.paddingRight = gap > 0 ? `${gap}px` : ''
  root.style.backgroundColor = gap > 0 ? 'var(--color-night)' : ''
}

/** Номер и ключ заявки из этого браузера — для вопроса «что с моей заявкой» в чате. Старая заявка без ключа — ничего */
export function sentApplication(): { application?: { id: string; token: string } } {
  const last = useSentApplication.getState().last
  return last?.token ? { application: { id: last.id, token: last.token } } : {}
}
