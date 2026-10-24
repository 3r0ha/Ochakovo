import { request } from '../api'

// Вызовы API для вкладок «Боты» и «Рассылка» (пакет channels).
// Сервер — server/api/hr-bots.ts (состояние каналов и предпросмотр) и server/api/hr-broadcast.ts (рассылка и журнал).
// Типы повторяют ответы сервера: server/channels/preview.ts и server/channels/broadcast.ts

// ── Каналы ───────────────────────────────────────────────────────────────

export type ChannelState = { state: 'running' | 'failed' | 'off'; via: 'webhook' | 'polling' | null; name: string | null }

export type BotsStatus = {
  site: { engine: boolean }
  telegram: ChannelState
  max: ChannelState
  assistant: 'gigachat' | 'offline'
}

export const getBotsStatus = () => request<BotsStatus>('/api/hr/bots', { hr: true })

/**
 * Строки состояния для вкладки: что работает и что нужно для запуска — словами отдела персонала.
 * admin — технические подробности (переменные окружения, журнал сервера): их видит только администратор.
 * tone — цвет точки, смысл всегда в словах
 */
export type StatusLine = { id: string; title: string; state: string; hint: string; admin?: string; tone: 'ok' | 'off' | 'bad' }

export function statusLines(s: BotsStatus): StatusLine[] {
  const via = (c: ChannelState) => (c.via === 'webhook' ? 'Сообщения приходят вебхуком.' : 'Бот сам опрашивает API мессенджера.')
  const stuck = 'Бот подключён, но не отвечает. Сообщи администратору сервера.'
  const telegram: StatusLine =
    s.telegram.state === 'running'
      ? { id: 'telegram', title: 'Telegram', state: 'Работает', hint: `${s.telegram.name ? `@${s.telegram.name}: ` : ''}кандидаты пишут боту, сообщения отдела персонала доходят.`, admin: via(s.telegram), tone: 'ok' }
      : s.telegram.state === 'failed'
        ? { id: 'telegram', title: 'Telegram', state: 'Не запустился', hint: stuck, admin: 'Проверь TELEGRAM_BOT_TOKEN и журнал сервера.', tone: 'bad' }
        : {
            id: 'telegram',
            title: 'Telegram',
            state: 'Не подключён',
            hint: 'Бот готов к запуску, нужен токен от @BotFather. Подключает администратор сервера.',
            admin: 'Впиши токен в TELEGRAM_BOT_TOKEN и перезапусти сервер.',
            tone: 'off',
          }
  const max: StatusLine =
    s.max.state === 'running'
      ? { id: 'max', title: 'MAX', state: 'Работает', hint: `${s.max.name ? `${s.max.name}: ` : ''}кандидаты пишут боту, сообщения отдела персонала доходят.`, admin: via(s.max), tone: 'ok' }
      : s.max.state === 'failed'
        ? { id: 'max', title: 'MAX', state: 'Не запустился', hint: stuck, admin: 'Проверь MAX_BOT_TOKEN, сертификат Минцифры и журнал сервера.', tone: 'bad' }
        : {
            id: 'max',
            title: 'MAX',
            state: 'Не подключён',
            hint: 'Бот в MAX сначала регистрируют на самозанятого, ИП или компанию, потом его подключает администратор сервера.',
            admin: 'Впиши токен в MAX_BOT_TOKEN и перезапусти сервер.',
            tone: 'off',
          }
  return [
    s.site.engine
      ? { id: 'site', title: 'Сайт', state: 'Работает', hint: 'Чат с Квасычем на сайте работает по тому же сценарию и с теми же ответами, что и боты.', tone: 'ok' }
      : { id: 'site', title: 'Сайт', state: 'Чат не отвечает', hint: 'Сайт открывается, а чат и боты молчат. Сообщи администратору сервера.', admin: 'Движок диалогов не запустился, подробности в журнале сервера.', tone: 'bad' },
    telegram,
    max,
    s.assistant === 'gigachat'
      ? { id: 'assistant', title: 'Квасыч', state: 'Отвечает своими словами', hint: 'Вопросы разбирает GigaChat, ответ сверяется с базой знаний.', tone: 'ok' }
      : {
          id: 'assistant',
          title: 'Квасыч',
          state: 'Отвечает по базе знаний',
          hint: 'Без GigaChat: отвечает готовыми ответами из базы. Чтобы отвечал своими словами, администратор сервера подключает GigaChat.',
          admin: 'Ключ задаётся в GIGACHAT_AUTH_KEY.',
          tone: 'off',
        },
  ]
}

// ── Предпросмотр ─────────────────────────────────────────────────────────

export type PreviewChannel = 'telegram' | 'max'
export type MsgRef = { turn: number; msg: number }
export type ViewButton = { text: string; kind: 'action' | 'link' | 'contact'; action?: string; url?: string }
export type ViewCall = { method: string; path: string; body: unknown }
export type ViewItem =
  | { kind: 'bot'; id: number; html: string; image: string | null; buttons: ViewButton[][]; ref: MsgRef | null; calls: ViewCall[]; edited: boolean }
  | { kind: 'user'; id: number; text: string }
  | { kind: 'note'; id: number; text: string; calls: ViewCall[] }

export type PreviewFeed = {
  channel: PreviewChannel
  items: ViewItem[]
  keyboard: { rows: ViewButton[][]; ref: MsgRef } | null
  placeholder: string | null
  turns: number
}

export type PreviewInput =
  | { type: 'start'; payload?: string }
  | { type: 'text'; text: string }
  | { type: 'press'; ref: MsgRef; action: string; label: string }
  | { type: 'contact' }

export const getPreview = (sid: string, channel: PreviewChannel) =>
  request<PreviewFeed>(`/api/hr/bots/preview?sid=${encodeURIComponent(sid)}&channel=${channel}`, { hr: true })

export const sendPreview = (sid: string, channel: PreviewChannel, input: PreviewInput) =>
  request<PreviewFeed>('/api/hr/bots/preview', { method: 'POST', hr: true, body: JSON.stringify({ sid, channel, input }) })

export const resetPreview = (sid: string) => request<{ ok: true }>(`/api/hr/bots/preview?sid=${encodeURIComponent(sid)}`, { method: 'DELETE', hr: true })

/** «Исходящие»: сообщение HR кандидату (приглашение, напоминание) в виде мессенджера */
export type OutboxEntry = { key: string; title: string; hint: string; enabled: boolean; items: ViewItem[] }
export type Outbox = { channel: PreviewChannel; sample: { name: string; id: string }; entries: OutboxEntry[] }

export const getOutbox = (channel: PreviewChannel) => request<Outbox>(`/api/hr/bots/outbox?channel=${channel}`, { hr: true })

/** Метка источника для /start: латиница, цифры, _ и -, до 64 знаков — как у диплинков */
export const cleanStartLabel = (s: string) =>
  s
    .trim()
    .replace(/^\/start\s*/i, '')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 64)

/** Части текста бота: из разметки мессенджера — только <b>; остальное экранировано */
export function htmlParts(html: string): { text: string; bold: boolean }[] {
  const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  return html
    .split(/(<b>[\s\S]*?<\/b>)/)
    .filter(Boolean)
    .map((p) => (p.startsWith('<b>') ? { text: unesc(p.slice(3, -4)), bold: true } : { text: unesc(p), bold: false }))
}

/** Значение JSON в одну строку с пробелами после запятых и двоеточий; содержимое строк не меняется */
function inlineJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(inlineJson).join(', ')}]`
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
  return entries.length ? `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${inlineJson(v)}`).join(', ')} }` : '{}'
}

/** JSON в несколько строк, но короткие объекты и массивы — в одну: ряды кнопок читаются как ряды */
export function compactJson(value: unknown, indent = ''): string {
  const one = inlineJson(value)
  if (value === null || typeof value !== 'object' || one.length + indent.length <= 76) return one
  const inner = `${indent}  `
  if (Array.isArray(value)) return `[\n${value.map((v) => inner + compactJson(v, inner)).join(',\n')}\n${indent}]`
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
  return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${compactJson(v, inner)}`).join(',\n')}\n${indent}}`
}

// ── Рассылка ─────────────────────────────────────────────────────────────

export type RecruitState = 'closed' | 'open'
export type BroadcastKind = 'open' | 'deadline'
export type BroadcastSegment = 'all' | 'dept' | 'tasks'

export type Recruit = { state: RecruitState; endsOn: string | null; daysLeft: number | null; updatedAt: string | null; updatedBy: string }

export type Audience = { total: number; ready: number; recent: number; offline: number; byChannel: Record<PreviewChannel, number> }

export type BroadcastEntry = {
  id: number
  createdAt: string
  finishedAt: string | null
  userName: string
  kind: BroadcastKind
  segment: BroadcastSegment
  dept: string | null
  text: string
  status: 'sending' | 'done' | 'interrupted'
  recipients: number
  delivered: number
  blocked: number
  failed: number
  skippedRecent: number
  skippedOffline: number
  unsubscribed: number
}

export type BroadcastState = {
  recruit: Recruit
  /** Почему сообщение сейчас нельзя отправить; null — можно */
  kinds: Record<BroadcastKind, string | null>
  /** Подключён ли бот мессенджера */
  channels: Record<PreviewChannel, boolean>
  subscribers: { total: number; byChannel: Record<PreviewChannel, number>; byDept: Record<string, number> }
  broadcasts: BroadcastEntry[]
}

export type BroadcastDraft = { kind: BroadcastKind; segment: BroadcastSegment; dept?: string | null }

export type BroadcastPreview = {
  text: string
  unavailable: string | null
  audience: Audience
  views: Record<PreviewChannel, ViewItem[]>
}

export const getBroadcastState = () => request<BroadcastState>('/api/hr/broadcast', { hr: true })

export const saveRecruit = (state: RecruitState, endsOn: string | null) =>
  request<Pick<BroadcastState, 'recruit' | 'kinds' | 'channels'>>('/api/hr/broadcast/recruit', { method: 'PUT', hr: true, body: JSON.stringify({ state, endsOn }) })

export const previewBroadcast = (draft: BroadcastDraft) =>
  request<BroadcastPreview>('/api/hr/broadcast/preview', { method: 'POST', hr: true, body: JSON.stringify(draft) })

export const sendBroadcast = (draft: BroadcastDraft) =>
  request<{ broadcast: BroadcastEntry; audience: Audience }>('/api/hr/broadcast', { method: 'POST', hr: true, body: JSON.stringify(draft) })

export const getBroadcast = (id: number) => request<BroadcastEntry>(`/api/hr/broadcast/${id}`, { hr: true })

export const segmentLabels: Record<BroadcastSegment, string> = {
  all: 'Все подписавшиеся',
  dept: 'По направлению',
  tasks: 'Прошли задания, заявки нет',
}

/** Первая строка текста рассылки без разметки — название в журнале */
export const broadcastTitle = (text: string) => text.split('\n')[0].replace(/\*\*/g, '')
