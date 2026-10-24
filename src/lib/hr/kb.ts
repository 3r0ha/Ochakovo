import { request } from '../api'

// Вызовы API для ответов HR на «Вопросы к Квасычу» (пакет assistant): список, проверка текста, сохранение, правка.
// Сервер — server/api/hr-kb.ts; проверка текста — server/assistant/kbAnswers.ts (checkKbAnswer)

export type KbAnswer = {
  id: number
  createdAt: string
  updatedAt: string
  question: string
  variants: string[]
  answer: string
  enabled: boolean
  gapId: number | null
  authorName: string
}

export type KbAnswerField = 'question' | 'answer' | 'variants'

export type KbAnswerDraft = { question: string; answer: string; variants: string[] }

/** Разбор текста до сохранения: что мешает, что подсказать, что сохранится после очистки личных данных */
export type KbAnswerCheck = { errors: Partial<Record<KbAnswerField, string>>; hints: string[]; cleaned: KbAnswerDraft }

/** Пределы — те же, что на сервере (KB_LIMITS) */
export const KB_ANSWER_MAX = 700
export const KB_VARIANTS_MAX = 8

export const listKbAnswers = () => request<KbAnswer[]>('/api/hr/kb-answers', { hr: true })

export const checkKbAnswer = (draft: KbAnswerDraft) =>
  request<KbAnswerCheck>('/api/hr/kb-answers/check', { method: 'POST', hr: true, body: JSON.stringify(draft) })

export const createKbAnswer = (draft: KbAnswerDraft & { gapId?: number }) =>
  request<{ answer: KbAnswer; hints: string[]; resolved: number }>('/api/hr/kb-answers', { method: 'POST', hr: true, body: JSON.stringify(draft) })

export const updateKbAnswer = (id: number, patch: Partial<KbAnswerDraft> & { enabled?: boolean }) =>
  request<{ answer: KbAnswer; hints: string[]; resolved: number }>(`/api/hr/kb-answers/${id}`, { method: 'PATCH', hr: true, body: JSON.stringify(patch) })

/** Формулировки в поле — по одной в строке */
export const variantsFromText = (text: string) => [...new Set(text.split('\n').map((v) => v.trim()).filter(Boolean))]
