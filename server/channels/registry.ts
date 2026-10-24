import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ChannelAdapter, DialogEngine, OutMessage } from '../dialog/types'
import type { Logger } from './render'

// Реестр адаптеров мессенджеров. Адаптер подключается, только если задан его токен
// и файл модуля уже существует — так сервер запускается и без ботов.
//
// Модули server/channels/<channel>.ts экспортируют фабрику
//   create<Channel>Adapter(token, { secret }): ChannelAdapter & AdapterExtras
// секрет вебхука адаптер получает при создании и сам передаёт мессенджеру в setWebhook.
//
// Вебхуки работают только с секретом. С PUBLIC_URL и токеном, но без *_WEBHOOK_SECRET секрет
// создаётся при запуске (32 случайных байта) и уходит мессенджеру при регистрации вебхука.
// Без PUBLIC_URL вебхуков нет: боты опрашивают API сами, а маршруты /bots/* отвечают 403.

export type AdapterExtras = {
  /** Зарегистрировать вебхук в мессенджере (секрет адаптер получил при создании) */
  setWebhook?(url: string): Promise<void>
  /** Дополнительная проверка входящего вебхука сверх секрета в заголовке */
  verifyWebhook?(headers: Headers): boolean
  /** Исходящее сообщение пользователю: уведомления о статусе заявки */
  sendTo?(userId: string, messages: OutMessage[]): Promise<void>
}

export type Adapter = ChannelAdapter & AdapterExtras

export type BotChannelName = Adapter['channel']

type Known = { channel: BotChannelName; tokenEnv: string; secretEnv: string; module: string; factory: string }

const known: Known[] = [
  { channel: 'telegram', tokenEnv: 'TELEGRAM_BOT_TOKEN', secretEnv: 'TELEGRAM_WEBHOOK_SECRET', module: './telegram.ts', factory: 'createTelegramAdapter' },
  { channel: 'max', tokenEnv: 'MAX_BOT_TOKEN', secretEnv: 'MAX_WEBHOOK_SECRET', module: './max.ts', factory: 'createMaxAdapter' },
]

export type AdapterFactory = (token: string, opts: { secret?: string }) => Adapter

export type Registry = {
  /**
   * Подключённый адаптер и секрет его вебхука. secret есть только в режиме вебхуков (задан PUBLIC_URL):
   * без него маршрут /bots/<канал> отвечает 403
   */
  get(channel: string): { adapter: Adapter; secret: string | undefined } | undefined
  active(): string[]
  /** Включённые (задан токен), но не поднявшиеся адаптеры: модуля нет или фабрика упала. Для проверки готовности */
  failed(): string[]
  start(engine: DialogEngine, opts: { publicUrl?: string; signal: AbortSignal }): void
}

export type LoadOptions = {
  /** Подменить фабрики адаптеров (проверки с фейковым API мессенджера) */
  factories?: Partial<Record<BotChannelName, AdapterFactory>>
  log?: Logger
}

/**
 * Секрет вебхука: 32 случайных байта в base64url (43 знака).
 * Подчёркивание заменяем дефисом: в описании подписки MAX разрешены только латиница, цифры и дефис
 */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString('base64url').replace(/_/g, '-')
}

/** Секрет из окружения годится и Telegram, и MAX: 5–256 знаков из латиницы, цифр, _ и - */
const SECRET_RE = /^[A-Za-z0-9_-]{5,256}$/

export async function loadAdapters(env: NodeJS.ProcessEnv = process.env, opts: LoadOptions = {}): Promise<Registry> {
  const log = opts.log ?? console
  const loaded = new Map<string, { adapter: Adapter; secret: string | undefined }>()
  const failed = new Set<string>()
  const envPublicUrl = env.PUBLIC_URL?.trim() || undefined

  for (const k of known) {
    const token = env[k.tokenEnv]?.trim()
    if (!token) continue
    try {
      let factory = opts.factories?.[k.channel]
      if (!factory) {
        const url = new URL(k.module, import.meta.url)
        if (!existsSync(fileURLToPath(url))) throw new Error(`${k.tokenEnv} задан, но модуля ${k.module} нет`)
        const mod = (await import(url.href)) as Record<string, unknown>
        factory = mod[k.factory] as AdapterFactory | undefined
        if (typeof factory !== 'function') throw new Error(`модуль не экспортирует ${k.factory}`)
      }

      // Секрет нужен только вебхукам: без PUBLIC_URL бот сам опрашивает API мессенджера
      let secret: string | undefined
      if (envPublicUrl) {
        const configured = env[k.secretEnv]?.trim()
        if (configured && !SECRET_RE.test(configured)) throw new Error(`${k.secretEnv}: нужны 5–256 знаков из латиницы, цифр, _ и -`)
        if (configured && configured.length < 32) log.warn(`[bots] ${k.secretEnv} короче 32 знаков, лучше оставить пустым: сервер создаст надёжный сам`)
        secret = configured || generateWebhookSecret()
        if (!configured) log.info(`[bots] ${k.channel}: секрет вебхука сгенерирован`)
      }

      loaded.set(k.channel, { adapter: factory(token, { secret }), secret })
      log.info(`[bots] адаптер ${k.channel} подключён`)
    } catch (e) {
      log.error(`[bots] не удалось подключить ${k.channel}: ${(e as Error).message}`)
      failed.add(k.channel)
    }
  }

  return {
    get: (channel) => loaded.get(channel),
    active: () => [...loaded.keys()],
    failed: () => [...failed],
    start(engine, { publicUrl = envPublicUrl, signal }) {
      for (const [channel, { adapter, secret }] of loaded) {
        if (publicUrl) {
          const hook = `${publicUrl.replace(/\/$/, '')}/bots/${channel}`
          // Вебхук без секрета не ставим: такие запросы маршрут всё равно отклонит
          if (!secret) log.error(`[bots] ${channel}: вебхук не установлен: нет секрета, PUBLIC_URL не был задан при загрузке адаптеров`)
          else if (adapter.setWebhook)
            adapter
              .setWebhook(hook)
              .then(() => log.info(`[bots] ${channel}: вебхук ${hook}`))
              .catch((e) => log.error(`[bots] ${channel}: вебхук не установлен: ${(e as Error).message}`))
          else log.info(`[bots] ${channel}: ждём вебхуки на ${hook}`)
        } else {
          log.info(`[bots] ${channel}: long polling`)
          adapter.startPolling(engine, signal).catch((e) => {
            if (!signal.aborted) log.error(`[bots] ${channel}: polling остановлен с ошибкой: ${(e as Error).message}`)
          })
        }
      }
    },
  }
}
