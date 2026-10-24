// Типы помощника, общие для инструментов, цикла и сценария бота

/** Действие, которое помощник предлагает кнопкой. Сценарий бота превращает его в свою кнопку */
export type AssistantAction =
  | { type: 'open_vacancy'; vacancyId: string }
  | { type: 'calc_earnings'; vacancyId?: string }
  | { type: 'start_application'; vacancyId?: string }
  | { type: 'start_quiz' }
  | { type: 'open_vacancies' }
  | { type: 'start_tour'; stage?: number }
  | { type: 'start_game' }

/** Что человек рассказал о себе. Без имени и телефона — только учёба, сроки и интересы */
export type AssistantProfile = {
  studyField?: string
  /** Месяцы 3–9, когда можно работать */
  months?: number[]
  interests?: string[]
  district?: string
  noExperience?: boolean
}

export type AssistantTurn = { role: 'user' | 'assistant'; text: string }

/** Вопрос без ответа — для HR-панели. Текст уже очищен от телефонов, почты и ников */
export type KbGapInput = { channel: string; topic: string; question: string }

export type AssistantInput = {
  question: string
  history: AssistantTurn[]
  profile?: AssistantProfile
  /** Постоянный id диалога — для кэша промпта в GigaChat */
  sessionId: string
  channel: string
}

export type AssistantReply = {
  text: string
  actions: AssistantAction[]
  profile?: AssistantProfile
  /** Вопрос передан в отдел персонала */
  escalated: boolean
  /**
   * Кто ответил: модель, офлайн-режим, ответ отдела персонала из «Вопросов к Квасычу» (hr)
   * или запасной ответ: guard — модель ответила, но проверка не пропустила; fallback — модель не ответила или не успела
   */
  source: 'llm' | 'offline' | 'hr' | 'guard' | 'fallback'
}

export interface Assistant {
  readonly mode: 'gigachat' | 'offline' | string
  answer(input: AssistantInput): Promise<AssistantReply>
}
