import { formatRub, minMonthlyPay } from '@shared/content/vacancies'
import type { ChannelAdapter, DialogEngine, DialogEvent, DialogReply, DialogUser, OutMessage } from '../dialog/types'
import { defaultPublicDir, loadMedia, MediaCache } from './media'
import { newTgChat, tgAnswerCallback, tgDeleteCall, tgPlanEdit, tgPlanSend, type TgCall, type TgChatState } from './payload'
import { ChatQueue, keepTyping, sleep, type Logger } from './render'

// Адаптер Telegram Bot API на чистом fetch. Тела запросов собирает payload.ts (tgPlanSend, tgPlanEdit) —
// те же сборщики использует предпросмотр в HR-панели.
//
// Кнопка «Отправить контакт» в Telegram бывает только в reply-клавиатуре, а inline и reply
// нельзя повесить на одно сообщение. Поэтому сообщение с контактной кнопкой целиком
// уходит с reply-клавиатурой: action-кнопки становятся текстовыми, а их нажатие (пришедший
// текст) адаптер сам превращает обратно в событие action. Ссылки уходят отдельным сообщением
// с inline-клавиатурой. Следующее сообщение бота убирает reply-клавиатуру (ReplyKeyboardRemove),
// а его inline-кнопки добавляются следом через editMessageReplyMarkup.

export { PHONE_PLACEHOLDER } from './payload'
/** Ответ на чужой контакт: принимаем только номер того, кто пишет. Второй вариант — когда кнопки «Отправить номер» на экране нет */
export const FOREIGN_CONTACT_TEXT = 'Это чужой контакт. Отправь свой номер кнопкой или напиши его сообщением.'
export const FOREIGN_CONTACT_PLAIN = 'Это чужой контакт. Бот принимает только твой номер.'

type TgUser = { id: number; first_name?: string; username?: string; is_bot?: boolean }
type TgMessage = {
  message_id: number
  from?: TgUser
  chat: { id: number; type: string }
  text?: string
  photo?: { file_id: string }[]
  contact?: { phone_number: string; user_id?: number }
}
type TgUpdate = {
  update_id: number
  message?: TgMessage
  callback_query?: { id: string; from: TgUser; data?: string; message?: TgMessage }
}
type TgResponse<T> = { ok: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } }

export type TelegramOptions = {
  publicUrl?: string
  secret?: string
  /**
   * Адрес Bot API вместо https://api.telegram.org: фейковый API в проверках или свой прокси, если сервер стоит там,
   * откуда Telegram недоступен (переменная TELEGRAM_API_BASE)
   */
  apiBase?: string
  /** Адрес сайта для кнопки «Игры» у поля ввода (мини-приложение /play), по умолчанию SITE_URL */
  siteUrl?: string
  publicDir?: string
  log?: Logger
  /** Как часто повторять «печатает…», пока бот готовит ответ: статус в Telegram гаснет через 5 с */
  typingInterval?: number
}

export type TelegramAdapter = ChannelAdapter & {
  /** Секрет вебхука: сервер сверяет его с заголовком X-Telegram-Bot-Api-Secret-Token */
  secret?: string
  setWebhook(url: string): Promise<void>
  /** Сообщение пользователю не в ответ на его действие (например, о статусе заявки) */
  sendTo(userId: string, messages: OutMessage[]): Promise<void>
  /** Профиль бота: меню команд, описание и кнопка «Игры» у поля ввода. Вызывается при каждом запуске, повтор безвреден */
  configure(): Promise<void>
}

/** Меню команд: те, что понимает движок (server/dialog/engine.ts) */
const COMMANDS = [
  { command: 'start', description: 'Начать сначала' },
  { command: 'menu', description: 'Все разделы' },
  { command: 'help', description: 'Что умеет Квасыч' },
  { command: 'stop', description: 'Не присылать напоминания' },
  { command: 'delete', description: 'Удалить мои данные' },
]

/** Подпись в профиле и в ссылке на бота, до 120 знаков */
const SHORT_DESCRIPTION = `Квасыч из «Очаково»: практика и работа на лето от ${formatRub(minMonthlyPay)}, игры о заводе и заявка за 2 минуты`

/** Текст в пустом чате до «Старт», до 512 знаков */
const DESCRIPTION =
  'Я Квасыч, бот завода «Очаково» в Москве. Покажу вакансии и зарплаты, подберу работу под учёбу, приму заявку на ' +
  'оплачиваемую практику и отвечу на вопросы про смены, общежитие и дорогу. Игры о заводе открываются во весь экран кнопкой «Игры».'

export class TelegramApiError extends Error {
  constructor(
    public method: string,
    public code: number | undefined,
    description: string,
  ) {
    super(`Telegram ${method}: ${code ?? ''} ${description}`)
  }
}

export function createTelegramAdapter(token: string, opts: TelegramOptions = {}): TelegramAdapter {
  const apiBase = (opts.apiBase ?? (process.env.TELEGRAM_API_BASE?.trim() || 'https://api.telegram.org')).replace(/\/$/, '')
  const siteUrl = (opts.siteUrl ?? process.env.SITE_URL ?? '').trim().replace(/\/$/, '')
  const publicDir = opts.publicDir ?? defaultPublicDir()
  const log = opts.log ?? console
  const typingInterval = opts.typingInterval ?? 4000
  const media = new MediaCache()
  const updates = new ChatQueue()
  const chats = new Map<string, TgChatState>()

  const state = (chatId: string) => {
    let s = chats.get(chatId)
    if (!s) {
      s = newTgChat()
      chats.set(chatId, s)
    }
    return s
  }

  const skipped = (action: string) => log.error(`[telegram] action длиннее 64 байт, кнопка пропущена: ${action}`)

  /** Вызов Bot API; retry — повторять ли при 429 (служебные вызовы вроде «печатает…» не повторяем) */
  async function call<T>(method: string, body: Record<string, unknown> | FormData, signal?: AbortSignal, retry = true): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const isForm = body instanceof FormData
      const res = await fetch(`${apiBase}/bot${token}/${method}`, {
        method: 'POST',
        headers: isForm ? undefined : { 'content-type': 'application/json' },
        body: isForm ? body : JSON.stringify(body),
        signal,
      })
      const json = (await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }))) as TgResponse<T>
      if (json.ok) return json.result as T
      if (json.error_code === 429 && retry && attempt < 3) {
        await sleep((json.parameters?.retry_after ?? 1) * 1000, signal)
        continue
      }
      throw new TelegramApiError(method, json.error_code, json.description ?? 'unknown error')
    }
  }

  const notModified = (e: unknown) => e instanceof TelegramApiError && /message is not modified/i.test(e.message)

  async function uploadPhoto(chatId: string, imagePath: string, extra: Record<string, unknown>) {
    const cached = media.get(imagePath)
    if (cached) return call<TgMessage>('sendPhoto', { chat_id: chatId, photo: cached, ...extra })

    // Первая отправка — multipart; file_id запоминаем для следующих
    const file = await loadMedia(imagePath, publicDir)
    const form = new FormData()
    form.set('chat_id', chatId)
    form.set('photo', new Blob([file.data], { type: file.mime }), file.filename)
    for (const [k, v] of Object.entries(extra)) form.set(k, typeof v === 'string' ? v : JSON.stringify(v))
    const sent = await call<TgMessage>('sendPhoto', form)
    const fileId = sent.photo?.at(-1)?.file_id
    if (fileId) media.set(imagePath, fileId)
    return sent
  }

  /**
   * Выполнить план сборщика по порядку. Правка кнопок получает номер сообщения, ушедшего перед ней;
   * сообщение «Ссылки:» в плане всегда последнее и с правкой не встречается
   */
  async function run(chatId: string, calls: TgCall[]) {
    let last: TgMessage | undefined
    for (const c of calls) {
      if (c.method === 'sendPhoto') {
        const { chat_id: _chat, ...extra } = c.body
        last = await uploadPhoto(chatId, c.photo, extra)
      } else if (c.method === 'editMessageReplyMarkup') {
        if (last) await call('editMessageReplyMarkup', { ...c.body, message_id: last.message_id })
      } else if (c.method === 'sendMessage') last = await call<TgMessage>('sendMessage', c.body)
      else await call(c.method, c.body)
    }
    return last
  }

  /** Отправка одного сообщения сценария: картинка, текст частями, кнопки на последней части */
  async function send(chatId: string, msg: OutMessage) {
    const calls = tgPlanSend(chatId, msg, state(chatId), skipped)
    if (!calls.length) {
      log.warn('[telegram] пустое сообщение без картинки пропущено')
      return undefined
    }
    return run(chatId, calls)
  }

  /** Замена сообщения с кнопкой, на которую нажали. Не вышло — отправляем новое */
  async function replace(chatId: string, original: TgMessage, msg: OutMessage) {
    const chat = state(chatId)
    const target = { messageId: original.message_id, photo: Boolean(original.photo?.length) }
    const edit = tgPlanEdit(chatId, target, msg, chat, msg.image ? media.get(msg.image.path) : undefined, skipped)
    if (edit) {
      try {
        await call(edit.method, edit.body)
        return
      } catch (e) {
        if (notModified(e)) return
        log.warn(`[telegram] ${edit.method} не удался, отправляю новое: ${(e as Error).message}`)
      }
    }

    // Фото ↔ текст править нельзя: удаляем старое и шлём новое
    const del = tgDeleteCall(chatId, original.message_id)
    await call(del.method, del.body).catch(() => undefined)
    await send(chatId, msg)
  }

  async function deliver(chatId: string, reply: DialogReply, original?: TgMessage) {
    let replaced = false
    for (const msg of reply.messages) {
      if (msg.replace && original && !replaced) {
        replaced = true
        await replace(chatId, original, msg)
      } else await send(chatId, msg)
    }
  }

  function toUser(from: TgUser): DialogUser {
    return { channel: 'telegram', id: String(from.id), firstName: from.first_name, username: from.username }
  }

  /**
   * Бот работает только в личном чате с тем, кто пишет: группы, каналы и чат, не совпадающий
   * с отправителем, до сценария не доходят — иначе заявку или её статус можно было бы увести в чужой чат
   */
  const ownChat = (chat: { id: number; type: string }, from: TgUser) => chat.type === 'private' && chat.id === from.id

  async function handleUpdate(engine: DialogEngine, update: TgUpdate) {
    const cb = update.callback_query
    if (cb) {
      if (!cb.from || (cb.message && !ownChat(cb.message.chat, cb.from))) {
        log.warn(`[telegram] update ${update.update_id}: нажатие не из личного чата пропущено`)
        return
      }
      const chatId = String(cb.message?.chat.id ?? cb.from.id)
      return updates.run(chatId, async () => {
        const reply = await engine.handle(toUser(cb.from), { type: 'action', action: cb.data ?? '' })
        // Ответ на нажатие обязателен — иначе у кнопки крутится часик
        await call('answerCallbackQuery', tgAnswerCallback(cb.id, reply.notice)).catch((e) =>
          log.warn(`[telegram] answerCallbackQuery: ${(e as Error).message}`),
        )
        await deliver(chatId, reply, cb.message)
      })
    }

    const m = update.message
    if (!m || !m.from || m.from.is_bot) return
    if (!ownChat(m.chat, m.from)) {
      log.warn(`[telegram] update ${update.update_id}: сообщение не из личного чата пропущено`)
      return
    }
    const from = m.from
    const chatId = String(m.chat.id)
    return updates.run(chatId, async () => {
      const chat = state(chatId)
      let event: DialogEvent | null = null
      if (m.contact) {
        // Номер принимаем, только если человек поделился своим контактом, а не чужим из записной книжки
        if (m.contact.user_id !== from.id) {
          const keyboard = chat.replyKeyboard ? chat.replyMarkup : undefined
          await call('sendMessage', { chat_id: chatId, text: keyboard ? FOREIGN_CONTACT_TEXT : FOREIGN_CONTACT_PLAIN, ...(keyboard ? { reply_markup: keyboard } : {}) })
          return
        }
        event = { type: 'contact', phone: normalizePhone(m.contact.phone_number) }
      } else if (typeof m.text === 'string') {
        const start = /^\/start(?:@\w+)?(?:\s+(\S+))?/.exec(m.text)
        if (start) event = { type: 'start', ...(start[1] ? { payload: start[1] } : {}) }
        else if (chat.replyActions.has(m.text)) event = { type: 'action', action: chat.replyActions.get(m.text)! }
        else event = { type: 'text', text: m.text }
      }
      if (!event) return
      // На свободный текст ответ может готовиться несколько секунд (помощник) — показываем «печатает…»
      const stopTyping =
        event.type === 'text'
          ? keepTyping(() => call('sendChatAction', { chat_id: chatId, action: 'typing' }, AbortSignal.timeout(3000), false), typingInterval, log, '[telegram] sendChatAction')
          : null
      let reply: DialogReply
      try {
        reply = await engine.handle(toUser(from), event)
      } finally {
        await stopTyping?.()
      }
      await deliver(chatId, reply)
    })
  }

  async function safeHandle(engine: DialogEngine, update: TgUpdate) {
    try {
      await handleUpdate(engine, update)
    } catch (e) {
      log.error(`[telegram] update ${update.update_id}: ${(e as Error).stack ?? e}`)
    }
  }

  return {
    channel: 'telegram',
    secret: opts.secret,

    async startPolling(engine, signal) {
      let offset = 0
      log.info('[telegram] long polling запущен')
      while (!signal.aborted) {
        try {
          const batch = await call<TgUpdate[]>('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] }, signal)
          for (const update of batch) {
            offset = update.update_id + 1
            // Разные чаты обрабатываются параллельно, один чат — по порядку (ChatQueue)
            void safeHandle(engine, update)
          }
        } catch (e) {
          if (signal.aborted) break
          const err = e as Error
          if (err instanceof TelegramApiError && err.code === 409) {
            log.error('[telegram] у бота включён вебхук, long polling не работает. Удалите его: deleteWebhook или задайте PUBLIC_URL')
          } else log.warn(`[telegram] getUpdates: ${err.message}`)
          await sleep(3000, signal)
        }
      }
      log.info('[telegram] long polling остановлен')
    },

    async handleWebhook(engine, body) {
      if (!body || typeof body !== 'object' || !('update_id' in body)) return
      await safeHandle(engine, body as TgUpdate)
    },

    async sendTo(userId, messages) {
      // В личном чате id чата совпадает с id пользователя; та же очередь, что и у ответов бота
      await updates.run(userId, () => deliver(userId, { messages }))
    },

    async configure() {
      await call('setMyCommands', { commands: COMMANDS })
      await call('setMyShortDescription', { short_description: SHORT_DESCRIPTION.slice(0, 120) })
      await call('setMyDescription', { description: DESCRIPTION.slice(0, 512) })
      // Мини-приложение открывается только по https: на локальном сайте кнопка у поля ввода остаётся меню команд
      const menu = siteUrl.startsWith('https://')
        ? { type: 'web_app', text: 'Игры', web_app: { url: `${siteUrl}/play?src=telegram` } }
        : { type: 'commands' }
      await call('setChatMenuButton', { menu_button: menu })
      log.info(`[telegram] профиль бота: команды, описание, кнопка ${menu.type === 'web_app' ? '«Игры»' : 'меню команд'}`)
    },

    async setWebhook(url) {
      await call('setWebhook', {
        url,
        allowed_updates: ['message', 'callback_query'],
        ...(opts.secret ? { secret_token: opts.secret } : {}),
      })
      log.info(`[telegram] вебхук: ${url}`)
    },
  }
}

export function normalizePhone(raw: string) {
  const digits = raw.replace(/\D/g, '')
  return digits ? `+${digits}` : raw
}
