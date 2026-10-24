import { createAssistant } from '../assistant/assistant'
import type { Assistant } from '../assistant/types'
import { offlineProvider } from '../llm/offline'
import { createEngine } from '../dialog/engine'
import { memoryStorage, type Storage } from '../dialog/storage'
import type { DialogEngine, DialogEvent, DialogReply, DialogUser, OutMessage } from '../dialog/types'
import { displayPath, mediaUrl } from './media'
import {
  maxAnswer,
  maxAnswerPath,
  maxBodies,
  maxMessagePath,
  maxSendable,
  newTgChat,
  tgAnswerCallback,
  tgDeleteCall,
  tgPlanEdit,
  tgPlanSend,
  type MaxBody,
  type MaxButton,
  type TgCall,
  type TgChatState,
  type TgInlineMarkup,
  type TgReplyMarkup,
} from './payload'
import { ChatQueue } from './render'

// Предпросмотр бота в HR-панели (вкладка «Боты»): тот же движок диалогов, что у Telegram и MAX, и те же сборщики
// запросов (payload.ts), но в мессенджер ничего не уходит. Движок свой: хранилище в памяти и офлайн-помощник,
// поэтому заявки, пробелы базы знаний, источники и воронка из предпросмотра в базу не попадают.
//
// Лента одна на оба мессенджера: переписка хранится как ответы движка (OutMessage), а вид для Telegram или MAX
// каждый раз собирается заново сборщиками. Переключатель меняет только вид: так видно, как один и тот же ответ
// выглядит в каждом мессенджере. Сессия движка общая для обоих каналов (sharedChannel).

export type PreviewChannel = 'telegram' | 'max'
export const previewChannels: PreviewChannel[] = ['telegram', 'max']

/** Сообщение сценария в истории: номер шага и номер сообщения в ответе */
export type MsgRef = { turn: number; msg: number }

/** Что сделал человек в ленте */
export type PreviewInput =
  | { type: 'start'; payload?: string }
  | { type: 'text'; text: string }
  /** Нажатие кнопки сообщения ref. label — подпись кнопки */
  | { type: 'press'; ref: MsgRef; action: string; label: string }
  /** «Отправить номер»: в предпросмотре уходит тестовый номер */
  | { type: 'contact' }
  /** Сообщение бота не в ответ на действие человека (sendTo): рассылка, уведомление HR. Из HTTP не принимается */
  | { type: 'push' }

/** Номер, который уходит по кнопке «Отправить номер» в предпросмотре */
export const PREVIEW_PHONE = '+79990000000'

export type ViewButton = { text: string; kind: 'action' | 'link' | 'contact'; action?: string; url?: string }

/** Запрос к API мессенджера так, как его собрал сборщик: метод, адрес без токена, тело */
export type ViewCall = { method: string; path: string; body: unknown }

export type ViewItem =
  | {
      kind: 'bot'
      id: number
      /** Текст в разметке мессенджера: экранированный HTML, из тегов — только <b> */
      html: string
      image: string | null
      buttons: ViewButton[][]
      /** Сообщение сценария, чьи кнопки под этим сообщением, — для нажатий */
      ref: MsgRef | null
      calls: ViewCall[]
      /** Сообщение изменено правкой по нажатию кнопки */
      edited: boolean
    }
  | { kind: 'user'; id: number; text: string }
  /** Служебная строка: нажата кнопка, всплывающее уведомление, запуск по ссылке */
  | { kind: 'note'; id: number; text: string; calls: ViewCall[] }

export type PreviewFeed = {
  channel: PreviewChannel
  items: ViewItem[]
  /** Telegram: reply-клавиатура под полем ввода (кнопка «Отправить номер» и текстовые кнопки) */
  keyboard: { rows: ViewButton[][]; ref: MsgRef } | null
  /** Подсказка в поле ввода (input_field_placeholder) */
  placeholder: string | null
  turns: number
}

export type Turn = { input: PreviewInput; reply: Pick<DialogReply, 'messages' | 'notice'> }

/** id чата в телах запросов предпросмотра: настоящих id людей здесь нет */
const CHAT_ID = '100200300'
const TG_PATH = (method: string) => `/bot<токен>/${method}`

const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

const tgButtons = (markup: TgInlineMarkup | undefined): ViewButton[][] =>
  (markup?.inline_keyboard ?? []).map((row) =>
    row.map((b): ViewButton => (b.url ? { text: b.text, kind: 'link', url: b.url } : { text: b.text, kind: 'action', action: b.callback_data })),
  )

const tgReplyButtons = (markup: TgReplyMarkup, chat: TgChatState): ViewButton[][] =>
  markup.keyboard.map((row) =>
    row.map((b): ViewButton => (b.request_contact ? { text: b.text, kind: 'contact' } : { text: b.text, kind: 'action', action: chat.replyActions.get(b.text) })),
  )

const maxButtons = (body: MaxBody): ViewButton[][] => {
  const kb = body.attachments.find((a) => a.type === 'inline_keyboard')
  if (!kb || kb.type !== 'inline_keyboard') return []
  return kb.payload.buttons.map((row) =>
    row.map((b: MaxButton): ViewButton => {
      if (b.type === 'callback') return { text: b.text, kind: 'action', action: b.payload }
      if (b.type === 'link') return { text: b.text, kind: 'link', url: b.url }
      return { text: b.text, kind: 'contact' }
    }),
  )
}

const pressLabel = (label: string) => `Нажата кнопка «${label}»`
const noticeLine = (notice: string) => `Всплывающее уведомление: «${notice}»`

const sameRef = (a: MsgRef | null, b: MsgRef) => Boolean(a && a.turn === b.turn && a.msg === b.msg)

/** Сообщение сценария с кнопкой контакта: в Telegram его кнопки — reply-клавиатура, нажатие приходит текстом */
const hasContact = (m: OutMessage | undefined) => Boolean(m?.buttons?.some((r) => r.some((b) => b.kind === 'contact')))

/** Сообщение сценария по ссылке из истории */
const messageAt = (turns: Turn[], ref: MsgRef) => turns[ref.turn]?.reply.messages[ref.msg]

// ── Вид для Telegram ─────────────────────────────────────────────────────

export function renderTelegram(turns: Turn[], imageUrl: (path: string) => string | null = mediaUrl): PreviewFeed {
  const chat = newTgChat()
  const items: ViewItem[] = []
  let nextId = 1
  // Кэш file_id, как у адаптера: первая отправка картинки — файлом, дальше — по file_id
  const uploaded = new Set<string>()
  let keyboard: PreviewFeed['keyboard'] = null
  let placeholder: string | null = null
  let callbackSeq = 0

  const photoBody = (c: Extract<TgCall, { method: 'sendPhoto' }>) => {
    const cached = uploaded.has(c.photo)
    uploaded.add(c.photo)
    return { ...c.body, photo: cached ? `file_id картинки ${displayPath(c.photo)}` : `файл ${displayPath(c.photo)} (multipart)` }
  }

  /** Выполнить план отправки: новые сообщения в ленте, reply-клавиатура, правка кнопок последнего сообщения */
  const runPlan = (calls: TgCall[], ref: MsgRef, extra: ViewCall[] = []) => {
    let last: Extract<ViewItem, { kind: 'bot' }> | undefined
    let first = true
    for (const c of calls) {
      const markup = c.body.reply_markup as TgInlineMarkup | TgReplyMarkup | { remove_keyboard: true } | undefined
      if (markup && 'keyboard' in markup) {
        keyboard = { rows: tgReplyButtons(markup, chat), ref }
        placeholder = markup.input_field_placeholder ?? null
      } else if (markup && 'remove_keyboard' in markup) {
        keyboard = null
        placeholder = null
      }
      if (c.method === 'sendPhoto' || c.method === 'sendMessage') {
        const html = String((c.method === 'sendPhoto' ? c.body.caption : c.body.text) ?? '')
        const view: ViewCall = { method: c.method, path: TG_PATH(c.method), body: c.method === 'sendPhoto' ? photoBody(c) : c.body }
        const item: ViewItem = {
          kind: 'bot',
          id: nextId++,
          html,
          image: c.method === 'sendPhoto' ? imageUrl(c.photo) : null,
          buttons: markup && 'inline_keyboard' in markup ? tgButtons(markup) : [],
          ref: markup && 'inline_keyboard' in markup ? ref : null,
          calls: [...(first ? extra : []), view],
          edited: false,
        }
        first = false
        items.push(item)
        // Сообщение «Ссылки:» правкой кнопок не трогается: правка идёт раньше него
        last = item
      } else if (c.method === 'editMessageReplyMarkup' && last) {
        const reply_markup = c.body.reply_markup as TgInlineMarkup
        last.buttons = tgButtons(reply_markup)
        last.ref = ref
        last.calls.push({ method: c.method, path: TG_PATH(c.method), body: { ...c.body, message_id: last.id } })
      }
    }
  }

  turns.forEach((turn, t) => {
    const { input, reply } = turn
    let original: Extract<ViewItem, { kind: 'bot' }> | undefined

    if (input.type === 'push') {
      // Сообщение без действия человека: только то, что отправил бот
    } else if (input.type === 'start') {
      items.push({ kind: 'user', id: nextId++, text: '/start' })
      if (input.payload) items.push({ kind: 'note', id: nextId++, text: `Метка из ссылки: ${input.payload}`, calls: [] })
    } else if (input.type === 'text') items.push({ kind: 'user', id: nextId++, text: input.text })
    else if (input.type === 'contact') items.push({ kind: 'user', id: nextId++, text: `Контакт: ${PREVIEW_PHONE}` })
    else if (hasContact(messageAt(turns, input.ref))) {
      // Кнопка reply-клавиатуры: Telegram присылает её подпись текстом, адаптер переводит её в action
      items.push({ kind: 'user', id: nextId++, text: input.label })
    } else {
      // Нажатие inline-кнопки: ответ на нажатие и, если сценарий просит, правка этого же сообщения
      original = [...items].reverse().find((i): i is Extract<ViewItem, { kind: 'bot' }> => i.kind === 'bot' && sameRef(i.ref, input.ref))
      items.push({
        kind: 'note',
        id: nextId++,
        text: reply.notice ? `${pressLabel(input.label)}. ${noticeLine(reply.notice)}` : pressLabel(input.label),
        calls: [{ method: 'answerCallbackQuery', path: TG_PATH('answerCallbackQuery'), body: tgAnswerCallback(`callback-${++callbackSeq}`, reply.notice) }],
      })
    }

    let replaced = false
    reply.messages.forEach((msg, m) => {
      const ref = { turn: t, msg: m }
      if (msg.replace && original && !replaced) {
        replaced = true
        const target = original
        const edit = tgPlanEdit(CHAT_ID, { messageId: target.id, photo: Boolean(target.image) }, msg, chat, msg.image && uploaded.has(msg.image.path) ? `file_id картинки ${displayPath(msg.image.path)}` : undefined)
        if (edit) {
          const body = edit.body as Record<string, unknown>
          const media = body.media as { caption?: string } | undefined
          target.html = String(media ? (media.caption ?? '') : (body.text ?? ''))
          if (media && msg.image) target.image = imageUrl(msg.image.path)
          target.buttons = tgButtons(body.reply_markup as TgInlineMarkup)
          target.ref = ref
          target.edited = true
          target.calls = [{ method: edit.method, path: TG_PATH(edit.method), body }]
          return
        }
        // Править нельзя: старое сообщение удаляется, новое уходит обычной отправкой
        const del = tgDeleteCall(CHAT_ID, target.id)
        items.splice(items.indexOf(target), 1)
        runPlan(tgPlanSend(CHAT_ID, msg, chat), ref, [{ method: del.method, path: TG_PATH(del.method), body: del.body }])
        return
      }
      runPlan(tgPlanSend(CHAT_ID, msg, chat), ref)
    })
  })

  return { channel: 'telegram', items, keyboard, placeholder, turns: turns.length }
}

// ── Вид для MAX ──────────────────────────────────────────────────────────

export function renderMax(turns: Turn[], imageUrl: (path: string) => string | null = mediaUrl): PreviewFeed {
  const items: ViewItem[] = []
  let nextId = 1
  let callbackSeq = 0
  /** Токен загруженной картинки, как у MAX: один на файл */
  const token = (m: OutMessage) => (m.image ? `токен картинки ${displayPath(m.image.path)}` : null)

  /** Что видно в сообщении: текст, картинка (только у тела с вложением image), кнопки и чьи они */
  const look = (body: MaxBody, msg: OutMessage, ref: MsgRef) => {
    const buttons = maxButtons(body)
    const image = body.attachments.some((a) => a.type === 'image') && msg.image ? imageUrl(msg.image.path) : null
    return { html: body.text, image, buttons, ref: buttons.length ? ref : null }
  }

  const send = (msg: OutMessage, ref: MsgRef) => {
    for (const body of maxBodies(msg, token(msg)).filter(maxSendable)) {
      items.push({ kind: 'bot', id: nextId++, ...look(body, msg, ref), calls: [{ method: 'POST', path: maxMessagePath('<id пользователя>'), body }], edited: false })
    }
  }

  turns.forEach((turn, t) => {
    const { input, reply } = turn
    const [first, ...rest] = reply.messages
    let firstSent = false

    if (input.type === 'push') {
      // Сообщение без действия человека: только то, что отправил бот
    } else if (input.type === 'start') {
      items.push({
        kind: 'note',
        id: nextId++,
        text: input.payload ? `Бот запущен по ссылке с меткой ${input.payload}` : 'Бот запущен',
        calls: [],
      })
    } else if (input.type === 'text') items.push({ kind: 'user', id: nextId++, text: input.text })
    else if (input.type === 'contact') items.push({ kind: 'user', id: nextId++, text: `Контакт: ${PREVIEW_PHONE}` })
    else {
      // Нажатие кнопки: уведомление и замена сообщения с кнопкой — одним вызовом /answers
      const original = [...items].reverse().find((i): i is Extract<ViewItem, { kind: 'bot' }> => i.kind === 'bot' && sameRef(i.ref, input.ref))
      const answer = maxAnswer(reply.notice, first?.replace ? maxBodies(first, token(first)) : null)
      const calls: ViewCall[] = answer ? [{ method: 'POST', path: maxAnswerPath(`callback-${++callbackSeq}`), body: answer.body }] : []
      items.push({ kind: 'note', id: nextId++, text: reply.notice ? `${pressLabel(input.label)}. ${noticeLine(reply.notice)}` : pressLabel(input.label), calls })
      if (answer?.replaced && first) {
        const next = look(answer.body.message as MaxBody, first, { turn: t, msg: 0 })
        // Сообщение с кнопкой в ленте есть всегда; если его отбросил предел длины ленты — показываем новым
        if (original) Object.assign(original, { ...next, calls, edited: true })
        else items.push({ kind: 'bot', id: nextId++, ...next, calls, edited: true })
        firstSent = true
      }
    }

    if (first && !firstSent) send(first, { turn: t, msg: 0 })
    rest.forEach((msg, i) => send(msg, { turn: t, msg: i + 1 }))
  })

  return { channel: 'max', items, keyboard: null, placeholder: null, turns: turns.length }
}

export const renderFeed = (channel: PreviewChannel, turns: Turn[], imageUrl?: (path: string) => string | null) =>
  channel === 'max' ? renderMax(turns, imageUrl) : renderTelegram(turns, imageUrl)

/** Сообщения, которые бот отправляет сам (sendTo): рассылка, приглашение и напоминание от HR — в виде мессенджера */
export const renderOutgoing = (channel: PreviewChannel, messages: OutMessage[], imageUrl?: (path: string) => string | null) =>
  renderFeed(channel, [{ input: { type: 'push' }, reply: { messages } }], imageUrl).items

/** Текст ленты без разметки — для проверок и журнала */
export const plainText = (html: string) => unesc(html.replace(/<\/?b>/g, ''))

// ── Сессии предпросмотра ─────────────────────────────────────────────────

/**
 * Одна сессия движка на оба канала: сценарии, подписка и заявка хранятся под одним каналом,
 * а сам движок получает тот канал, который выбран в переключателе, — тексты и ссылки уходят для него
 */
function sharedChannel(inner: Storage): Storage {
  const one = (u: DialogUser): DialogUser => ({ ...u, channel: 'telegram' })
  return {
    ...inner,
    getSession: (u) => inner.getSession(one(u)),
    saveSession: (u, s) => inner.saveSession(one(u), s),
    saveApplication: (input) => inner.saveApplication({ ...input, channel: 'telegram' }),
    acceptApplication: (input) => inner.acceptApplication({ ...input, channel: 'telegram' }),
    latestApplicationFor: (_channel, id) => inner.latestApplicationFor!('telegram', id),
    setRemind: (u, sub) => inner.setRemind!(one(u), sub),
    eraseUser: (u) => inner.eraseUser!(one(u)),
    linkBotApplication: (token, u) => inner.linkBotApplication!(token, one(u)),
    unlinkBot: (u) => inner.unlinkBot!(one(u)),
    // Вопросы без ответа в предпросмотре никуда не записываются
    logGap: async () => {},
  }
}

type Session = { engine: DialogEngine; turns: Turn[]; used: number }

export type PreviewOptions = {
  siteUrl: string
  /** Помощник; по умолчанию офлайн-режим без записи вопросов */
  assistant?: Assistant
  random?: () => number
  /** Сколько живёт сессия без действий; по умолчанию 30 минут */
  ttlMs?: number
  /** Сколько сессий держать в памяти; самая давняя вытесняется */
  maxSessions?: number
  /** Сколько шагов хранить в ленте; старые отбрасываются */
  maxTurns?: number
  now?: () => number
}

export type Preview = {
  /** Лента сессии в виде канала; пустая, если сессии нет */
  feed(key: string, channel: PreviewChannel): PreviewFeed
  /** Действие человека: движок отвечает, лента пересобирается */
  send(key: string, channel: PreviewChannel, input: PreviewInput): Promise<PreviewFeed>
  reset(key: string): void
  /** Сколько сессий в памяти — для проверок */
  size(): number
}

export const PREVIEW_TTL_MS = 30 * 60_000
export const PREVIEW_MAX_SESSIONS = 40
export const PREVIEW_MAX_TURNS = 80

/** Событие движка для действия в ленте */
function toEvent(input: PreviewInput): DialogEvent {
  switch (input.type) {
    case 'start':
      return { type: 'start', ...(input.payload ? { payload: input.payload } : {}) }
    case 'text':
      return { type: 'text', text: input.text }
    case 'press':
      return { type: 'action', action: input.action }
    case 'contact':
      return { type: 'contact', phone: PREVIEW_PHONE }
    case 'push':
      throw new Error('push: это сообщение бота, человек его не отправляет')
  }
}

export function createPreview(opts: PreviewOptions): Preview {
  const ttl = opts.ttlMs ?? PREVIEW_TTL_MS
  const maxSessions = opts.maxSessions ?? PREVIEW_MAX_SESSIONS
  const maxTurns = opts.maxTurns ?? PREVIEW_MAX_TURNS
  const now = opts.now ?? Date.now
  const sessions = new Map<string, Session>()
  const queue = new ChatQueue()
  let assistant = opts.assistant

  const sweep = () => {
    const t = now()
    for (const [key, s] of sessions) if (t - s.used > ttl) sessions.delete(key)
    while (sessions.size > maxSessions) {
      const oldest = [...sessions.entries()].sort((a, b) => a[1].used - b[1].used)[0]
      sessions.delete(oldest[0])
    }
  }

  const session = (key: string) => {
    sweep()
    let s = sessions.get(key)
    if (!s) {
      // Офлайн-помощник без записи вопросов: GigaChat и база здесь не нужны
      assistant ??= createAssistant({ provider: offlineProvider() })
      s = { engine: createEngine(sharedChannel(memoryStorage()), { siteUrl: opts.siteUrl, assistant, random: opts.random }), turns: [], used: now() }
      sessions.set(key, s)
      sweep()
    }
    s.used = now()
    return s
  }

  return {
    feed(key, channel) {
      sweep()
      const s = sessions.get(key)
      if (s) s.used = now()
      return renderFeed(channel, s?.turns ?? [])
    },
    send(key, channel, input) {
      return queue.run(key, async () => {
        const s = session(key)
        const user: DialogUser = { channel, id: 'preview' }
        const reply = await s.engine.handle(user, toEvent(input))
        s.turns.push({ input, reply: { messages: reply.messages, ...(reply.notice ? { notice: reply.notice } : {}) } })
        if (s.turns.length > maxTurns) {
          // Старые шаги отбрасываются вместе со ссылками на их сообщения
          const drop = s.turns.length - maxTurns
          s.turns = s.turns.slice(drop).map((turn) => (turn.input.type === 'press' ? { ...turn, input: { ...turn.input, ref: { ...turn.input.ref, turn: turn.input.ref.turn - drop } } } : turn))
        }
        return renderFeed(channel, s.turns)
      })
    },
    reset(key) {
      sessions.delete(key)
    },
    size: () => sessions.size,
  }
}
