// Интерфейс языковой модели для помощника. Реализации: GigaChat (gigachat.ts) и офлайн-режим без ключа (offline.ts).
// Формат сообщений повторяет GigaChat: вызов функции приходит в ответе ассистента,
// результат возвращается сообщением с ролью function.

export type JsonSchema = {
  type: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array'
  description?: string
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
  enum?: (string | number)[]
  required?: string[]
}

export type LlmFunction = {
  /** Только латиница и _, не с цифры */
  name: string
  description: string
  parameters: JsonSchema
  /** Примеры запросов — GigaChat лучше выбирает функцию */
  few_shot_examples?: { request: string; params: Record<string, unknown> }[]
  return_parameters?: JsonSchema
}

export type LlmFunctionCall = { name: string; arguments: Record<string, unknown> }

export type LlmMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; function_call?: LlmFunctionCall; functions_state_id?: string }
  | { role: 'function'; name: string; content: string }

export type ChatRequest = {
  /** fast — выбрать функцию или извлечь профиль, answer — ответ человеку */
  model: 'fast' | 'answer'
  messages: LlmMessage[]
  functions?: LlmFunction[]
  functionCall?: 'auto' | 'none' | { name: string }
  /** Постоянный id диалога: GigaChat кэширует повторяющееся начало промпта */
  sessionId?: string
  maxTokens?: number
  /**
   * Общий срок ответа человеку (25 с в ботах, 20 с на сайте): прерывает ожидание в очереди, запрос и паузу перед повтором.
   * Прерванный запрос возвращает { kind: 'error', reason: 'timeout' }
   */
  signal?: AbortSignal
}

export type ChatUsage = { prompt: number; completion: number; total: number; cached?: number }

export type ChatResult =
  | { kind: 'text'; content: string; usage?: ChatUsage }
  | { kind: 'function_call'; call: LlmFunctionCall; functionsStateId?: string; content: string; usage?: ChatUsage }
  /** Модель отказалась отвечать по правилам модерации */
  | { kind: 'blacklist' }
  /** Ответ не получен: сеть, лимиты, неверные аргументы функции, срок вышел (timeout), очередь переполнена (queue-full) */
  | { kind: 'error'; reason: string }

export interface LlmProvider {
  /** gigachat | offline | имя тестового провайдера */
  readonly name: string
  chat(request: ChatRequest): Promise<ChatResult>
}
