import type { Button, OutMessage } from '../dialog/types'
import { byteLength, hasContactButton, layoutRows, splitText, toHtml } from './render'

// Сборщики запросов к API мессенджеров: OutMessage → тело запроса. Без сети, без файлов и без часов.
// Ими пользуются адаптеры (telegram.ts, max.ts), предпросмотр в HR-панели (preview.ts) и проверки,
// поэтому разметка, раскладка кнопок, нарезка длинных текстов и место картинки везде одинаковые.

// ── Telegram ─────────────────────────────────────────────────────────────

export const TG_TEXT_LIMIT = 4096
export const TG_CAPTION_LIMIT = 1024
/** Запас под HTML-теги и экранирование */
export const TG_SAFE_TEXT = TG_TEXT_LIMIT - 296
export const TG_SAFE_CAPTION = TG_CAPTION_LIMIT - 124
/** Подсказка в поле ввода на шаге телефона (input_field_placeholder, до 64 знаков) */
export const PHONE_PLACEHOLDER = 'Телефон или @ник'
/** Подпись отдельного сообщения со ссылками, когда под сообщением reply-клавиатура */
export const TG_LINKS_TEXT = 'Ссылки:'

export type TgInlineButton = { text: string; url?: string; callback_data?: string; web_app?: { url: string } }
export type TgInlineMarkup = { inline_keyboard: TgInlineButton[][] }
export type TgReplyButton = { text: string; request_contact?: boolean }
export type TgReplyMarkup = { keyboard: TgReplyButton[][]; resize_keyboard: true; one_time_keyboard: true; input_field_placeholder?: string }
export type TgMarkup = TgInlineMarkup | TgReplyMarkup | { remove_keyboard: true }

/**
 * Что адаптер помнит о чате между сообщениями. Кнопка «Отправить контакт» в Telegram бывает только в reply-клавиатуре,
 * а её текстовые кнопки приходят обычным текстом — их адаптер переводит обратно в action
 */
export type TgChatState = {
  /** Показана reply-клавиатура с запросом контакта */
  replyKeyboard: boolean
  /** Текст reply-кнопки → action */
  replyActions: Map<string, string>
  /** Последняя reply-клавиатура: её показываем снова, если вместо своего номера пришёл чужой контакт */
  replyMarkup?: TgReplyMarkup
}

export const newTgChat = (): TgChatState => ({ replyKeyboard: false, replyActions: new Map() })

/**
 * Один вызов Bot API. sendPhoto несёт путь к картинке отдельно: адаптер шлёт её файлом (multipart) или file_id из кэша.
 * editMessageReplyMarkup с lastMessage правит последнее сообщение, отправленное этим же планом
 */
export type TgCall =
  | { method: 'sendMessage'; body: Record<string, unknown> }
  | { method: 'sendPhoto'; body: Record<string, unknown>; photo: string }
  | { method: 'editMessageReplyMarkup'; body: Record<string, unknown>; lastMessage: true }
  | { method: 'editMessageText' | 'editMessageMedia' | 'deleteMessage'; body: Record<string, unknown> }

/** Action длиннее 64 байт Telegram не примет: такую кнопку пропускаем, onSkip пишет о ней в журнал */
export type OnSkip = (action: string) => void

/** Inline-клавиатура: ряды как в сценарии, ссылки — url, действия — callback_data. Кнопки контакта сюда не попадают */
export function tgInlineKeyboard(rows: Button[][] | undefined, onSkip?: OnSkip): TgInlineMarkup | undefined {
  if (!rows?.length) return undefined
  const keyboard = rows
    .map((row) =>
      row.flatMap((b): TgInlineButton[] => {
        if (b.kind === 'link') return [{ text: b.text, url: b.url }]
        // Мини-приложение открывается внутри Telegram; web_app работает только в личном чате с ботом, как у нас
        if (b.kind === 'app') return [{ text: b.text, web_app: { url: b.url } }]
        if (b.kind === 'action') {
          if (byteLength(b.action) > 64) {
            onSkip?.(b.action)
            return []
          }
          return [{ text: b.text, callback_data: b.action }]
        }
        return []
      }),
    )
    .filter((r) => r.length)
  return keyboard.length ? { inline_keyboard: keyboard } : undefined
}

/**
 * Reply-клавиатура для сообщения с кнопкой контакта: контакт — request_contact, действия — текстовые кнопки
 * (actions: текст → action), ссылки возвращаются отдельно — они уходят следующим сообщением с inline-кнопками
 */
export function tgReplyKeyboard(rows: Button[][], input?: OutMessage['input']) {
  const actions = new Map<string, string>()
  const links: Button[][] = []
  const keyboard = rows
    .map((row) =>
      row.flatMap((b): TgReplyButton[] => {
        if (b.kind === 'contact') return [{ text: b.text, request_contact: true }]
        if (b.kind === 'action') {
          actions.set(b.text, b.action)
          return [{ text: b.text }]
        }
        links.push([b])
        return []
      }),
    )
    .filter((r) => r.length)
  const markup: TgReplyMarkup = {
    keyboard,
    resize_keyboard: true,
    one_time_keyboard: true,
    // На шаге телефона поле ввода подсказывает, что можно написать номер или ник
    ...(input === 'phone' ? { input_field_placeholder: PHONE_PLACEHOLDER } : {}),
  }
  return { markup, actions, links }
}

/**
 * Вызовы Bot API для одного сообщения сценария. Меняет chat так же, как отправка: reply-клавиатура показана или убрана.
 * Картинка уходит первой; текст, если не влезает в подпись, — следом частями; кнопки — на последней части.
 * Сообщение с контактной кнопкой уходит с reply-клавиатурой, ссылки — отдельным сообщением.
 * Следующее сообщение убирает reply-клавиатуру (remove_keyboard), а его inline-кнопки добавляются правкой.
 * Пустой текст без картинки — пустой план
 */
export function tgPlanSend(chatId: string, msg: OutMessage, chat: TgChatState, onSkip?: OnSkip): TgCall[] {
  let markup: TgMarkup | undefined
  let linksAfter: Button[][] = []
  let inlineAfterRemove: TgInlineMarkup | undefined

  if (hasContactButton(msg.buttons)) {
    const r = tgReplyKeyboard(msg.buttons ?? [], msg.input)
    chat.replyActions = r.actions
    chat.replyMarkup = r.markup
    chat.replyKeyboard = true
    markup = r.markup
    linksAfter = r.links
  } else {
    const inline = tgInlineKeyboard(msg.buttons, onSkip)
    if (chat.replyKeyboard) {
      // Убираем reply-клавиатуру этим сообщением, а inline-кнопки добавим правкой
      markup = { remove_keyboard: true }
      inlineAfterRemove = inline
      chat.replyKeyboard = false
      chat.replyActions = new Map()
      chat.replyMarkup = undefined
    } else markup = inline
  }

  const calls: TgCall[] = []
  const textCall = (text: string, isLast: boolean): TgCall => ({
    method: 'sendMessage',
    body: { chat_id: chatId, text: toHtml(text), parse_mode: 'HTML', ...(isLast && markup ? { reply_markup: markup } : {}) },
  })

  if (msg.image) {
    const fits = msg.text.length <= TG_SAFE_CAPTION
    const parts = fits ? [] : splitText(msg.text, TG_SAFE_TEXT)
    calls.push({
      method: 'sendPhoto',
      photo: msg.image.path,
      body: {
        chat_id: chatId,
        ...(fits && msg.text ? { caption: toHtml(msg.text), parse_mode: 'HTML' } : {}),
        ...(parts.length === 0 && markup ? { reply_markup: markup } : {}),
      },
    })
    parts.forEach((part, i) => calls.push(textCall(part, i === parts.length - 1)))
  } else {
    if (!msg.text.trim()) return []
    const parts = splitText(msg.text, TG_SAFE_TEXT)
    parts.forEach((part, i) => calls.push(textCall(part, i === parts.length - 1)))
  }

  if (inlineAfterRemove) calls.push({ method: 'editMessageReplyMarkup', lastMessage: true, body: { chat_id: chatId, reply_markup: inlineAfterRemove } })
  if (linksAfter.length) {
    const links = tgInlineKeyboard(linksAfter, onSkip)
    if (links) calls.push({ method: 'sendMessage', body: { chat_id: chatId, text: TG_LINKS_TEXT, reply_markup: links } })
  }
  return calls
}

/** Сообщение, на кнопку которого нажали: его номер и было ли это фото */
export type TgOriginal = { messageId: number; photo: boolean }

/**
 * Правка сообщения с нажатой кнопкой вместо отправки нового. null — править нельзя (reply-клавиатура, кнопка контакта,
 * длинный текст, фото ↔ текст, картинки ещё нет в кэше): тогда старое сообщение удаляется (tgDeleteCall) и уходит новое.
 * cachedPhoto — file_id картинки msg.image, если она уже загружалась
 */
export function tgPlanEdit(chatId: string, original: TgOriginal, msg: OutMessage, chat: TgChatState, cachedPhoto?: string, onSkip?: OnSkip): TgCall | null {
  const canEdit = !chat.replyKeyboard && !hasContactButton(msg.buttons) && msg.text.length <= (msg.image ? TG_SAFE_CAPTION : TG_SAFE_TEXT)
  if (!canEdit) return null
  const reply_markup = tgInlineKeyboard(msg.buttons, onSkip) ?? { inline_keyboard: [] }
  if (!original.photo && !msg.image) {
    return { method: 'editMessageText', body: { chat_id: chatId, message_id: original.messageId, text: toHtml(msg.text), parse_mode: 'HTML', reply_markup } }
  }
  if (original.photo && msg.image && cachedPhoto) {
    return {
      method: 'editMessageMedia',
      body: { chat_id: chatId, message_id: original.messageId, media: { type: 'photo', media: cachedPhoto, caption: toHtml(msg.text), parse_mode: 'HTML' }, reply_markup },
    }
  }
  return null
}

export const tgDeleteCall = (chatId: string, messageId: number): TgCall => ({ method: 'deleteMessage', body: { chat_id: chatId, message_id: messageId } })

/** Ответ на нажатие inline-кнопки: без него у кнопки крутятся часики. notice — всплывающее уведомление, до 200 знаков */
export const tgAnswerCallback = (callbackId: string, notice?: string) => ({ callback_query_id: callbackId, ...(notice ? { text: notice.slice(0, 200) } : {}) })

// ── MAX ──────────────────────────────────────────────────────────────────

export const MAX_TEXT_LIMIT = 4000
export const MAX_SAFE_TEXT = MAX_TEXT_LIMIT - 300
/** Кнопок в ряду: всего не больше 7, ссылок и запроса контакта — не больше 3 */
export const MAX_ROW = 7
export const MAX_ROW_NARROW = 3
/** Длина подписи кнопки в MAX */
export const MAX_BUTTON_TEXT = 128

export type MaxButton =
  | { type: 'callback'; text: string; payload: string }
  | { type: 'link'; text: string; url: string }
  | { type: 'request_contact'; text: string }
export type MaxKeyboard = { type: 'inline_keyboard'; payload: { buttons: MaxButton[][] } }
export type MaxImage = { type: 'image'; payload: { token: string } }
export type MaxBody = { text: string; format: 'html'; attachments: (MaxImage | MaxKeyboard)[] }

/** Клавиатура MAX: кнопки только inline, «Отправить контакт» — request_contact рядом с остальными; длинные ряды делятся */
export function maxKeyboard(rows: Button[][] | undefined): MaxKeyboard | null {
  if (!rows?.length) return null
  const laid = layoutRows(rows, MAX_ROW, MAX_ROW_NARROW, ['link', 'app', 'contact'])
  const buttons = laid.map((row) =>
    row.map((b): MaxButton => {
      const text = b.text.slice(0, MAX_BUTTON_TEXT)
      if (b.kind === 'action') return { type: 'callback', text, payload: b.action }
      // Мини-приложений Telegram в MAX нет: та же страница игр открывается ссылкой
      if (b.kind === 'link' || b.kind === 'app') return { type: 'link', text, url: b.url }
      return { type: 'request_contact', text }
    }),
  )
  return { type: 'inline_keyboard', payload: { buttons } }
}

/**
 * Тела POST /messages для одного сообщения сценария: длинный текст — частями, картинка — к первой части, кнопки — к последней.
 * imageToken — токен загруженной картинки msg.image (null — картинки нет). Пустые тела (maxSendable) не отправляются
 */
export function maxBodies(msg: OutMessage, imageToken: string | null): MaxBody[] {
  const parts = msg.text.trim() ? splitText(msg.text, MAX_SAFE_TEXT) : ['']
  const image: MaxImage | null = imageToken ? { type: 'image', payload: { token: imageToken } } : null
  const kb = maxKeyboard(msg.buttons)
  return parts.map((text, i) => {
    const attachments: MaxBody['attachments'] = []
    if (i === 0 && image) attachments.push(image)
    if (i === parts.length - 1 && kb) attachments.push(kb)
    return { text: text ? toHtml(text) : '', format: 'html', attachments }
  })
}

export const maxSendable = (body: MaxBody) => Boolean(body.text) || body.attachments.length > 0

/**
 * Ответ на нажатие кнопки одним вызовом POST /answers: уведомление и/или замена сообщения с кнопкой.
 * Заменить можно, только если новое сообщение — одно тело (короткий текст). replaced — первое сообщение уже ушло этим вызовом.
 * null — отвечать на нажатие нечем
 */
export function maxAnswer(notice: string | undefined, replacement: MaxBody[] | null): { body: Record<string, unknown>; replaced: boolean } | null {
  const body: Record<string, unknown> = {}
  if (notice) body.notification = notice
  const replaced = Boolean(replacement && replacement.length === 1)
  if (replaced) body.message = replacement![0]
  return Object.keys(body).length ? { body, replaced } : null
}

export const maxMessagePath = (userId: string) => `/messages?user_id=${encodeURIComponent(userId)}`
export const maxAnswerPath = (callbackId: string) => `/answers?callback_id=${encodeURIComponent(callbackId)}`
