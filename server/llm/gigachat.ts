import { randomUUID } from 'node:crypto'
import type { ChatRequest, ChatResult, ChatUsage, LlmFunctionCall, LlmMessage, LlmProvider } from './provider'

// Клиент GigaChat на fetch (developers.sber.ru/docs/ru/gigachat).
// Токен: POST oauth → access_token на 30 минут, держим в памяти и обновляем за минуту до истечения.
// Запросы: POST {base}/chat/completions с Bearer-токеном. Сертификат — Russian Trusted Root CA:
// сервер запускается с NODE_EXTRA_CA_CERTS=certs/russian_trusted_root_ca.pem (sh scripts/max-cert.sh).

export type GigaChatOptions = {
  /** Authorization Key из GigaChat Studio (base64 client_id:client_secret) */
  authKey: string
  /** GIGACHAT_API_PERS — физлица, GIGACHAT_API_B2B / GIGACHAT_API_CORP — юрлица */
  scope?: string
  models?: { fast?: string; answer?: string }
  baseUrl?: string
  oauthUrl?: string
  /** Одновременных запросов: для физлиц разрешён один */
  concurrency?: number
  /** Сколько запросов может ждать в очереди. Больше — сразу отказ (queue-full), помощник отвечает офлайн */
  maxQueue?: number
  timeouts?: { oauth?: number; chat?: number }
  /** Базовая пауза перед повтором, мс; дальше 2× и 4× плюс случайная добавка */
  retryBaseMs?: number
  fetchImpl?: typeof fetch
  log?: (message: string) => void
}

export class GigaChatError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

const DEFAULTS = {
  scope: 'GIGACHAT_API_PERS',
  fast: 'GigaChat-2',
  answer: 'GigaChat-2-Pro',
  baseUrl: 'https://api.giga.chat/v1',
  oauthUrl: 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth',
}

const RETRIES = 3
/** Повторов, когда у запроса есть общий срок: один — второй уже не уложится в 20–25 секунд */
const RETRIES_WITH_DEADLINE = 1
/** Сколько запросов ждёт в очереди по умолчанию: при одном одновременном запросе девятый ждал бы дольше срока */
const DEFAULT_MAX_QUEUE = 8

/** Срок ответа вышел: запрос сняли из очереди, прервали или не стали повторять */
export class AbortedError extends Error {
  constructor() {
    super('timeout')
  }
}
/** Очередь длиннее разрешённого: ждать бессмысленно, отвечает офлайн-режим */
export class QueueFullError extends Error {
  constructor() {
    super('queue-full')
  }
}

/**
 * Очередь: не больше max запросов одновременно, остальные ждут. Если ждут уже maxQueue — сразу QueueFullError.
 * signal снимает запрос из очереди (AbortedError) — место освобождается для следующих
 */
export function createLimiter(max: number, maxQueue = Infinity) {
  let active = 0
  const waiting: { start: () => void }[] = []
  const next = () => {
    while (active < max && waiting.length) {
      active++
      waiting.shift()!.start()
    }
  }
  const run = async <T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    if (signal?.aborted) throw new AbortedError()
    if (active >= max && waiting.length >= maxQueue) throw new QueueFullError()
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const i = waiting.indexOf(item)
        if (i >= 0) waiting.splice(i, 1)
        reject(new AbortedError())
      }
      const item = {
        start: () => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        },
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      waiting.push(item)
      next()
    })
    try {
      return await task()
    } finally {
      active--
      next()
    }
  }
  return Object.assign(run, { stats: () => ({ active, waiting: waiting.length }) })
}

/** Пауза, которую прерывает срок ответа */
function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortedError())
    const onAbort = () => {
      clearTimeout(timer)
      reject(new AbortedError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Ждать обещание, пока не вышел срок */
function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(new AbortedError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AbortedError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}

/** Аргументы функции приходят объектом, а по спецификации — строкой JSON. Принимаем оба варианта */
export function parseArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      // невалидный JSON — вернём пустые аргументы, инструмент сам проверит обязательные поля
    }
  }
  return {}
}

/** expires_at приходит в миллисекундах, но в старых примерах — в секундах */
const normalizeExpiry = (value: unknown) => {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return Date.now() + 30 * 60_000
  return n < 1e12 ? n * 1000 : n
}

const isTlsError = (e: unknown) => {
  const code = (e as { cause?: { code?: string } })?.cause?.code ?? ''
  return /CERT|SELF_SIGNED|UNABLE_TO_GET_ISSUER/.test(code)
}

function toGiga(m: LlmMessage) {
  switch (m.role) {
    case 'system':
    case 'user':
      return { role: m.role, content: m.content }
    case 'assistant':
      return {
        role: 'assistant',
        content: m.content,
        ...(m.function_call ? { function_call: m.function_call } : {}),
        ...(m.functions_state_id ? { functions_state_id: m.functions_state_id } : {}),
      }
    case 'function':
      return { role: 'function', name: m.name, content: m.content }
  }
}

type GigaResponse = {
  choices?: {
    message?: { role?: string; content?: string; function_call?: { name?: string; arguments?: unknown }; functions_state_id?: string }
    finish_reason?: string
  }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; precached_prompt_tokens?: number }
}

export function parseChatResponse(json: GigaResponse): ChatResult {
  const choice = json.choices?.[0]
  if (!choice) return { kind: 'error', reason: 'empty-response' }
  const usage: ChatUsage | undefined = json.usage
    ? {
        prompt: json.usage.prompt_tokens ?? 0,
        completion: json.usage.completion_tokens ?? 0,
        total: json.usage.total_tokens ?? 0,
        cached: json.usage.precached_prompt_tokens,
      }
    : undefined
  const message = choice.message ?? {}
  if (choice.finish_reason === 'blacklist') return { kind: 'blacklist' }
  if (message.function_call?.name) {
    const call: LlmFunctionCall = { name: message.function_call.name, arguments: parseArguments(message.function_call.arguments) }
    return { kind: 'function_call', call, functionsStateId: message.functions_state_id, content: message.content ?? '', usage }
  }
  if (choice.finish_reason === 'error') return { kind: 'error', reason: 'invalid-function-arguments' }
  return { kind: 'text', content: (message.content ?? '').trim(), usage }
}

export function createGigaChat(options: GigaChatOptions): LlmProvider {
  const scope = options.scope || DEFAULTS.scope
  const models = { fast: options.models?.fast || DEFAULTS.fast, answer: options.models?.answer || DEFAULTS.answer }
  const baseUrl = (options.baseUrl || DEFAULTS.baseUrl).replace(/\/$/, '')
  const oauthUrl = options.oauthUrl || DEFAULTS.oauthUrl
  const fetchImpl = options.fetchImpl ?? fetch
  const retryBase = options.retryBaseMs ?? 1000
  const timeouts = { oauth: options.timeouts?.oauth ?? 10_000, chat: options.timeouts?.chat ?? 60_000 }
  const limit = createLimiter(Math.max(1, options.concurrency ?? 1), Math.max(0, options.maxQueue ?? DEFAULT_MAX_QUEUE))
  const log = options.log ?? ((m: string) => console.warn(`[gigachat] ${m}`))

  let token: { value: string; expiresAt: number } | null = null
  let refreshing: Promise<string> | null = null
  let tlsHintShown = false

  const backoff = (attempt: number, retryAfter?: string | null, signal?: AbortSignal) => {
    const header = Number(retryAfter)
    if (Number.isFinite(header) && header > 0) return sleep(Math.min(header * 1000, 10_000), signal)
    return sleep(retryBase * 2 ** attempt + Math.random() * retryBase * 0.3, signal)
  }

  const noteNetworkError = (e: unknown) => {
    if (isTlsError(e) && !tlsHintShown) {
      tlsHintShown = true
      log('нет доверия к сертификату Минцифры: запустите сервер с NODE_EXTRA_CA_CERTS=certs/russian_trusted_root_ca.pem')
    }
  }

  async function fetchToken(): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      let response: Response
      try {
        response = await fetchImpl(oauthUrl, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${options.authKey}`,
            RqUID: randomUUID(),
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: `scope=${encodeURIComponent(scope)}`,
          signal: AbortSignal.timeout(timeouts.oauth),
        })
      } catch (e) {
        noteNetworkError(e)
        if (attempt < RETRIES) {
          await backoff(attempt)
          continue
        }
        throw new GigaChatError('токен: сеть недоступна')
      }
      if (response.ok) {
        const json = (await response.json()) as { access_token?: string; expires_at?: unknown }
        if (!json.access_token) throw new GigaChatError('токен: в ответе нет access_token')
        token = { value: json.access_token, expiresAt: normalizeExpiry(json.expires_at) }
        return token.value
      }
      if ((response.status === 429 || response.status >= 500) && attempt < RETRIES) {
        await backoff(attempt, response.headers.get('retry-after'))
        continue
      }
      throw new GigaChatError(`токен: HTTP ${response.status}`, response.status)
    }
  }

  /** Один общий запрос на обновление токена, даже если его ждут несколько диалогов */
  async function getToken(force = false): Promise<string> {
    if (!force && token && Date.now() < token.expiresAt - 60_000) return token.value
    refreshing ??= fetchToken().finally(() => {
      refreshing = null
    })
    return refreshing
  }

  async function complete(request: ChatRequest): Promise<ChatResult> {
    const functions = request.functions?.length ? request.functions : undefined
    const body = JSON.stringify({
      model: request.model === 'fast' ? models.fast : models.answer,
      messages: request.messages.map(toGiga),
      ...(functions ? { functions, function_call: request.functionCall ?? 'auto' } : {}),
      ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
    })

    const signal = request.signal
    const retries = signal ? RETRIES_WITH_DEADLINE : RETRIES
    const timeout = (): ChatResult => ({ kind: 'error', reason: 'timeout' })
    /** Пауза перед повтором; срок вышел — повтора не будет */
    const pause = async (attempt: number, retryAfter?: string | null) => {
      try {
        await backoff(attempt, retryAfter, signal)
        return true
      } catch {
        return false
      }
    }
    let refreshedAfter401 = false
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) return timeout()
      let response: Response
      try {
        const bearer = await untilAborted(getToken(), signal)
        response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${bearer}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': 'ochakovo-season/1.0',
            'X-Request-ID': randomUUID(),
            ...(request.sessionId ? { 'X-Session-ID': request.sessionId } : {}),
          },
          body,
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeouts.chat)]) : AbortSignal.timeout(timeouts.chat),
        })
      } catch (e) {
        if (signal?.aborted || e instanceof AbortedError) return timeout()
        if (e instanceof GigaChatError) return { kind: 'error', reason: e.message }
        noteNetworkError(e)
        if (attempt < retries) {
          if (!(await pause(attempt))) return timeout()
          continue
        }
        return { kind: 'error', reason: 'network' }
      }

      if (response.status === 401 && !refreshedAfter401) {
        refreshedAfter401 = true
        attempt--
        try {
          await untilAborted(getToken(true), signal)
        } catch (e) {
          if (e instanceof AbortedError) return timeout()
          return { kind: 'error', reason: (e as Error).message }
        }
        continue
      }
      if ((response.status === 429 || response.status >= 500) && attempt < retries) {
        if (!(await pause(attempt, response.headers.get('retry-after')))) return timeout()
        continue
      }
      try {
        if (!response.ok) {
          const detail = (await response.text().catch(() => '')).slice(0, 300)
          log(`HTTP ${response.status}: ${detail}`)
          return { kind: 'error', reason: `http-${response.status}` }
        }
        return parseChatResponse((await response.json()) as GigaResponse)
      } catch (e) {
        // Тело ответа не дочитали: срок вышел посреди чтения или сеть оборвалась
        if (signal?.aborted) return timeout()
        noteNetworkError(e)
        return { kind: 'error', reason: 'network' }
      }
    }
  }

  return {
    name: 'gigachat',
    chat: (request) =>
      limit(() => complete(request), request.signal).catch((e: unknown): ChatResult => {
        if (e instanceof QueueFullError) return { kind: 'error', reason: 'queue-full' }
        if (e instanceof AbortedError) return { kind: 'error', reason: 'timeout' }
        throw e
      }),
  }
}

/** Провайдер из переменных окружения или null, если ключа нет */
export function gigaChatFromEnv(env: NodeJS.ProcessEnv = process.env): LlmProvider | null {
  const authKey = env.GIGACHAT_AUTH_KEY?.trim()
  if (!authKey) return null
  return createGigaChat({
    authKey,
    scope: env.GIGACHAT_SCOPE?.trim() || undefined,
    models: { fast: env.GIGACHAT_MODEL_FAST?.trim() || undefined, answer: env.GIGACHAT_MODEL_ANSWER?.trim() || undefined },
    baseUrl: env.GIGACHAT_BASE_URL?.trim() || undefined,
    concurrency: Number(env.GIGACHAT_CONCURRENCY) || 1,
    maxQueue: env.GIGACHAT_QUEUE?.trim() ? Math.max(0, Number(env.GIGACHAT_QUEUE) || 0) : undefined,
  })
}
