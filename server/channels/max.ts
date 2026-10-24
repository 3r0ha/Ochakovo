import type { ChannelAdapter, DialogEngine, DialogEvent, DialogReply, DialogUser, OutMessage } from '../dialog/types'
import { defaultPublicDir, loadMedia, MediaCache } from './media'
import { maxAnswer, maxAnswerPath, maxBodies, maxMessagePath, maxSendable, type MaxBody } from './payload'
import { ChatQueue, keepTyping, sleep, type Logger } from './render'

// Адаптер MAX Bot API (platform-api2.max.ru) на чистом fetch. Тела сообщений собирает payload.ts (maxBodies, maxAnswer) —
// те же сборщики использует предпросмотр в HR-панели.
// Токен — только в заголовке Authorization. Сертификат API выпущен Russian Trusted Root CA:
// Node запускаем с NODE_EXTRA_CA_CERTS=certs/russian_trusted_root_ca.pem (см. certs/README.md).
// Кнопки в MAX только inline, поэтому «Отправить контакт» — обычная кнопка request_contact рядом с остальными.

const UPDATE_TYPES = ['bot_started', 'message_created', 'message_callback']

type MaxUser = { user_id: number; first_name?: string; last_name?: string; username?: string; is_bot?: boolean }
type MaxAttachment = { type: string; payload?: { vcf_info?: string; [k: string]: unknown } }
type MaxMessage = {
  sender?: MaxUser
  recipient?: { chat_id?: number; user_id?: number; chat_type?: string }
  body?: { mid?: string; text?: string | null; attachments?: MaxAttachment[] | null }
}
type MaxUpdate = {
  update_type: string
  timestamp?: number
  user?: MaxUser
  chat_id?: number
  payload?: string | null
  message?: MaxMessage
  callback?: { callback_id: string; payload?: string; user: MaxUser }
}

export type MaxOptions = {
  publicUrl?: string
  secret?: string
  /** Для тестов: адрес фейкового API */
  apiBase?: string
  publicDir?: string
  log?: Logger
  /** Пауза между запросами в один чат: лимит MAX — 2 запроса в секунду */
  chatInterval?: number
  /** Пауза между запросами /updates: не чаще раза в 300 мс */
  pollDelay?: number
  /** Как часто повторять «печатает…», пока бот готовит ответ */
  typingInterval?: number
}

export type MaxAdapter = ChannelAdapter & {
  /** Секрет вебхука: сервер сверяет его с заголовком X-Max-Bot-Api-Secret */
  secret?: string
  setWebhook(url: string): Promise<void>
  /** Сообщение пользователю не в ответ на его действие (например, о статусе заявки) */
  sendTo(userId: string, messages: OutMessage[]): Promise<void>
}

export class MaxApiError extends Error {
  constructor(
    public status: number,
    public code: string | undefined,
    message: string,
  ) {
    super(`MAX ${status} ${code ?? ''}: ${message}`)
  }
}

export function createMaxAdapter(token: string, opts: MaxOptions = {}): MaxAdapter {
  const apiBase = (opts.apiBase ?? 'https://platform-api2.max.ru').replace(/\/$/, '')
  const publicDir = opts.publicDir ?? defaultPublicDir()
  const log = opts.log ?? console
  const typingInterval = opts.typingInterval ?? 4000
  const media = new MediaCache()
  const updates = new ChatQueue()
  const requests = new ChatQueue(opts.chatInterval ?? 500)

  /** Вызов API; retry — повторять ли при 429 (служебные вызовы вроде «печатает…» не повторяем) */
  async function api<T>(method: string, path: string, body?: unknown, signal?: AbortSignal, retry = true): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(apiBase + path, {
        method,
        headers: { Authorization: token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
      })
      const json = (await res.json().catch(() => ({}))) as { code?: string; message?: string } & T
      if (res.ok) return json
      if (res.status === 429 && retry && attempt < 4) {
        await sleep(1000 * (attempt + 1), signal)
        continue
      }
      throw new MaxApiError(res.status, json.code, json.message ?? res.statusText)
    }
  }

  /** Запрос в конкретный чат — через очередь с паузой (лимит канала на чат) */
  const toChat = <T>(userId: string, method: string, path: string, body?: unknown) =>
    requests.run(userId, () => api<T>(method, path, body))

  /** «Печатает…» в чате диалога: chat_id берём из recipient входящего сообщения. Через ту же очередь, что и ответы */
  const typingOn = (userId: string, chatId: number) =>
    requests.run(userId, async () => {
      const res = await api<{ success?: boolean; message?: string }>('POST', `/chats/${chatId}/actions`, { action: 'typing_on' }, AbortSignal.timeout(3000), false)
      if (res.success === false) throw new Error(res.message ?? 'success: false')
    })

  async function imageToken(imagePath: string) {
    return media.getOrUpload(imagePath, async () => {
      const file = await loadMedia(imagePath, publicDir)
      const slot = await api<{ url: string; token?: string }>('POST', '/uploads?type=image')
      const form = new FormData()
      form.set('data', new Blob([file.data], { type: file.mime }), file.filename)
      // Загрузочный адрес отдельный, токен бота туда не отправляем
      const res = await fetch(slot.url, { method: 'POST', body: form })
      if (!res.ok) throw new MaxApiError(res.status, 'upload', await res.text())
      const json = (await res.json()) as { token?: string; photos?: Record<string, { token: string }> }
      const uploaded = json.token ?? Object.values(json.photos ?? {})[0]?.token ?? slot.token
      if (!uploaded) throw new Error('MAX: в ответе загрузки нет токена картинки')
      return uploaded
    })
  }

  /** Тела сообщений MAX для одного OutMessage: картинка — к первой части, кнопки — к последней */
  async function bodies(msg: OutMessage): Promise<MaxBody[]> {
    return maxBodies(msg, msg.image ? await imageToken(msg.image.path) : null)
  }

  /** POST /messages; сразу после загрузки картинка бывает «not ready» — ждём и повторяем */
  async function post(userId: string, body: unknown) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await toChat(userId, 'POST', maxMessagePath(userId), body)
      } catch (e) {
        const notReady = e instanceof MaxApiError && /attachment\.not\.ready|not\.ready/i.test(`${e.code} ${e.message}`)
        if (notReady && attempt < 5) {
          await sleep(500 * (attempt + 1))
          continue
        }
        throw e
      }
    }
  }

  async function send(userId: string, msg: OutMessage) {
    for (const body of await bodies(msg)) if (maxSendable(body)) await post(userId, body)
  }

  async function deliver(userId: string, reply: DialogReply, callbackId?: string) {
    const [first, ...rest] = reply.messages
    let firstSent = false

    if (callbackId) {
      // Ответ на нажатие: уведомление и/или замена сообщения с кнопкой одним вызовом /answers
      const answer = maxAnswer(reply.notice, first?.replace ? await bodies(first) : null)
      if (answer) {
        firstSent = answer.replaced
        await toChat(userId, 'POST', maxAnswerPath(callbackId), answer.body).catch((e) => {
          firstSent = false
          log.warn(`[max] /answers: ${(e as Error).message}`)
        })
      }
    }

    if (first && !firstSent) await send(userId, first)
    for (const msg of rest) await send(userId, msg)
  }

  const toUser = (u: MaxUser): DialogUser => ({
    channel: 'max',
    id: String(u.user_id),
    firstName: u.first_name,
    username: u.username,
  })

  async function handleUpdate(engine: DialogEngine, update: MaxUpdate) {
    if (update.update_type === 'bot_started' && update.user) {
      const user = toUser(update.user)
      return updates.run(user.id, async () => {
        const event: DialogEvent = { type: 'start', ...(update.payload ? { payload: update.payload } : {}) }
        await deliver(user.id, await engine.handle(user, event))
      })
    }

    if (update.update_type === 'message_callback' && update.callback) {
      const cb = update.callback
      const user = toUser(cb.user)
      return updates.run(user.id, async () => {
        const reply = await engine.handle(user, { type: 'action', action: cb.payload ?? '' })
        await deliver(user.id, reply, cb.callback_id)
      })
    }

    if (update.update_type === 'message_created' && update.message?.sender) {
      const m = update.message
      if (m.sender!.is_bot) return
      if (m.recipient?.chat_type && m.recipient.chat_type !== 'dialog') return
      const user = toUser(m.sender!)
      return updates.run(user.id, async () => {
        const contact = m.body?.attachments?.find((a) => a.type === 'contact')
        const phone = contact?.payload?.vcf_info ? phoneFromVcf(contact.payload.vcf_info) : null
        const text = m.body?.text ?? ''
        let event: DialogEvent | null = null
        if (phone) event = { type: 'contact', phone }
        else if (text) {
          const start = /^\/start(?:\s+(\S+))?/.exec(text)
          event = start ? { type: 'start', ...(start[1] ? { payload: start[1] } : {}) } : { type: 'text', text }
        }
        if (!event) return
        // На свободный текст ответ может готовиться несколько секунд (помощник) — показываем «печатает…»
        const chatId = m.recipient?.chat_id
        const stopTyping =
          event.type === 'text' && typeof chatId === 'number' ? keepTyping(() => typingOn(user.id, chatId), typingInterval, log, '[max] typing_on') : null
        let reply: DialogReply
        try {
          reply = await engine.handle(user, event)
        } finally {
          await stopTyping?.()
        }
        await deliver(user.id, reply)
      })
    }
  }

  async function safeHandle(engine: DialogEngine, update: MaxUpdate) {
    try {
      await handleUpdate(engine, update)
    } catch (e) {
      log.error(`[max] ${update.update_type}: ${(e as Error).stack ?? e}`)
    }
  }

  return {
    channel: 'max',
    secret: opts.secret,

    async startPolling(engine, signal) {
      let marker: number | undefined
      const pollDelay = opts.pollDelay ?? 300
      log.info('[max] long polling запущен')
      while (!signal.aborted) {
        try {
          const q = new URLSearchParams({ limit: '100', timeout: '30', types: UPDATE_TYPES.join(',') })
          if (marker !== undefined) q.set('marker', String(marker))
          const res = await api<{ updates: MaxUpdate[]; marker?: number | null }>('GET', `/updates?${q}`, undefined, signal)
          if (typeof res.marker === 'number') marker = res.marker
          for (const update of res.updates ?? []) void safeHandle(engine, update)
        } catch (e) {
          if (signal.aborted) break
          log.warn(`[max] /updates: ${(e as Error).message}`)
          await sleep(3000, signal)
        }
        await sleep(pollDelay, signal)
      }
      log.info('[max] long polling остановлен')
    },

    async handleWebhook(engine, body) {
      if (!body || typeof body !== 'object') return
      const list = Array.isArray((body as { updates?: unknown }).updates) ? (body as { updates: MaxUpdate[] }).updates : [body as MaxUpdate]
      for (const update of list) if (update?.update_type) await safeHandle(engine, update)
    },

    async sendTo(userId, messages) {
      await updates.run(userId, () => deliver(userId, { messages }))
    },

    async setWebhook(url) {
      await api('POST', '/subscriptions', { url, update_types: UPDATE_TYPES, ...(opts.secret ? { secret: opts.secret } : {}) })
      log.info(`[max] вебхук: ${url}`)
    },
  }
}

/** Номер из vCard контакта MAX: строка TEL…:79991234567. Переносы бывают и настоящими, и экранированными \r\n */
export function phoneFromVcf(vcf: string): string | null {
  const lines = vcf.replace(/\\r\\n|\\n/g, '\n').split(/\r?\n/)
  const tel = lines.find((l) => /^TEL/i.test(l.trim()))
  if (!tel) return null
  const digits = tel.slice(tel.lastIndexOf(':') + 1).replace(/\D/g, '')
  return digits ? `+${digits}` : null
}
