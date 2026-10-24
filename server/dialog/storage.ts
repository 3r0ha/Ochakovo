import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { emptyHrFields, type Application, type ApplicationInput, type BotChannel, type HrApplication } from '@shared/applications'
import { ConsentRequiredError, consentError, normalizeApplicationInput, UnderageError } from '@shared/applicationInput'
import { isAdultByBirthDate } from '@shared/birthDate'
import { candidateStatus, type CandidateStatus } from '@shared/candidateStatus'
import { defaultWorkSettings, type WorkSettings } from '@shared/workdays'
import type { KbGapInput } from '../assistant/types'
import { PER_HOUR, personKey, REPEAT_MINUTES, type IntakeResult } from '../candidate/intake'
import type { DialogUser } from './types'

// Хранилище, которое нужно сценариям бота. Реализация на PostgreSQL — server/db/index.ts,
// для проверок сценариев без базы — memoryStorage ниже.

export type Progress = {
  /** Лучший счёт в чат-версии «Поймай брак» */
  game?: number
  money?: boolean
  /** Месяцы, выбранные в «Собери лето», — подставляются в заявку */
  months?: number[]
  /** id вакансии из подбора работы */
  quiz?: string
  /** Сколько верных ответов в «Правда или миф», если пройдено до конца */
  myth?: number
  /** Лучший счёт в контрольных вопросах «Что ты знаешь об „Очаково“». В «Смену» не входит */
  companyQuiz?: number
}

export type Session = {
  /** Текущий сценарий ('apply', 'quiz', …) или null — главное меню */
  flow: string | null
  /** Произвольные данные шага сценария */
  data: Record<string, unknown>
  progress: Progress
  /** Метка источника из диплинка, сохраняется при первом /start */
  source: string | null
  /**
   * Подписка «Напомнить о наборе»: направление, если подписан и не отписался. Живёт в bot_users, а не в сессии:
   * хранилище подставляет её при чтении и не пишет в сессию
   */
  remind?: { dept: string } | null
}

export const emptySession = (): Session => ({ flow: null, data: {}, progress: {}, source: null })

/** Сессия для записи: без подписки — она хранится отдельно */
export const sessionToSave = (s: Session): Session => {
  const { remind: _remind, ...rest } = s
  return rest
}

/** Сколько живёт ссылка «Получать ответы о заявке в Telegram или MAX» */
export const BOT_LINK_TTL_HOURS = 24

/** Одноразовый токен ссылки на бота: 24 случайных байта, 32 символа base64url. В start-параметре — app_<токен>, до 64 символов */
export function newBotLinkToken() {
  const token = randomBytes(24).toString('base64url')
  return { token, hash: botLinkHash(token) }
}

export const botLinkHash = (token: string) => createHash('sha256').update(token).digest('hex')

/** Совпадает ли хеш из базы с хешем токена — за постоянное время */
export function sameBotLinkHash(stored: string | null | undefined, token: string) {
  if (!stored) return false
  const a = Buffer.from(stored, 'hex')
  const b = Buffer.from(botLinkHash(token), 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Токен из start-параметра app_<токен> или null */
export function botLinkToken(payload: string | null | undefined) {
  const m = /^app_([A-Za-z0-9_-]{20,60})$/.exec((payload ?? '').trim())
  return m ? m[1] : null
}

export interface Storage {
  getSession(user: DialogUser): Promise<Session>
  saveSession(user: DialogUser, session: Session): Promise<void>
  saveApplication(input: ApplicationInput): Promise<Application>
  /**
   * Приём заявки кандидата так же, как с сайта (server/candidate/intake.ts): тот же телефон или ник за 10 минут — already_applied,
   * больше трёх заявок с них за час — phone_limit. Бот сохраняет заявки только так, а не через saveApplication
   */
  acceptApplication(input: ApplicationInput): Promise<IntakeResult>
  /** Вопрос, на который помощник не нашёл ответа, — для HR-панели. Без личных данных */
  logGap?(gap: KbGapInput): Promise<void>
  /** Последняя заявка пользователя бота (не обезличенная) — для «Что с моей заявкой» через candidateStatus */
  latestApplicationFor?(channel: string, channelUserId: string): Promise<HrApplication | null>
  /** Статус заявки по номеру и токену — чат на сайте передаёт их в meta.application */
  statusForToken?(id: string, token: string): Promise<CandidateStatus | null>
  /** Рабочие дни и праздники отдела — третий аргумент candidateStatus */
  workSettings?(): Promise<WorkSettings>
  /**
   * Привязать заявку с сайта к этому чату по одноразовому токену из ссылки start=app_<токен>.
   * Пишет bot_channel и bot_user_id, канал и источник заявки не меняет. Токен гаснет после первого использования.
   * null — токена нет, он чужой, использован, просрочен или заявка обезличена: ответ одинаковый и ничего не раскрывает
   */
  linkBotApplication?(token: string, user: DialogUser): Promise<{ id: string } | null>
  /** /stop: отвязать заявки с сайта от этого чата. Возвращает, сколько отвязано */
  unlinkBot?(user: DialogUser): Promise<number>
  /** «Напомнить о наборе»: подписать с направлением и меткой источника или (null) — «Не присылать» */
  setRemind?(user: DialogUser, sub: { dept: string; source: string | null } | null): Promise<void>
  /** «Удалить мои данные»: обезличить заявки этого чата (и привязанные с сайта), удалить диалог, имя, ник и подписку */
  eraseUser?(user: DialogUser): Promise<{ applications: number }>
}

/**
 * Заявка так, как её сохраняет PostgreSQL (server/db saveApplication): та же сборка из shared,
 * без согласия — ConsentRequiredError, время согласия — время записи
 */
function asStored(raw: ApplicationInput): Omit<Application, 'id' | 'createdAt'> {
  const a = normalizeApplicationInput(raw)
  const problem = consentError(a)
  if (problem) throw new ConsentRequiredError(problem)
  if (isAdultByBirthDate(a.birthDate) === false) throw new UnderageError()
  const { consent: _consent, website: _website, ...rest } = a
  return { ...rest, consentAt: new Date().toISOString() }
}

/** Заявка в памяти: статус, этапы, собеседование и привязку к боту проверки сценариев выставляют сами — HR-панели здесь нет */
export type MemoryApplication = Application &
  Partial<Pick<HrApplication, 'interview' | 'reached' | 'botChannel' | 'botUserId' | 'anonymizedAt'>> & { botLinkHash?: string | null; botLinkExpiresAt?: number | null }

/** Подписка «Напомнить о наборе» в памяти — как колонки remind_* в bot_users */
export type MemoryRemind = { dept: string | null; source: string | null; at: string | null; offAt: string | null }

/** Хранилище в памяти — для симулятора и проверок сценариев */
export function memoryStorage(): Storage & {
  applications: MemoryApplication[]
  gaps: KbGapInput[]
  reminds: Map<string, MemoryRemind>
  /** Пользователи ботов, как bot_users: удаление данных стирает имя и ник, а строка остаётся — счётчики аудитории не меняются */
  botUsers: Map<string, { firstName: string | null; username: string | null }>
  createBotLink(appId: string, names?: BotNames): Promise<BotLinks | null>
} {
  const sessions = new Map<string, Session>()
  const applications: MemoryApplication[] = []
  const tokens = new Map<string, string>()
  const reminds = new Map<string, MemoryRemind>()
  const botUsers = new Map<string, { firstName: string | null; username: string | null }>()
  // Без статуса заявка «Новая», как сразу после отправки
  const asHr = (a: MemoryApplication): HrApplication => ({
    ...emptyHrFields(),
    ...a,
    status: a.status ?? 'new',
    reached: a.reached ?? [a.status ?? 'new'],
    interview: a.interview ?? null,
    botChannel: a.botChannel ?? null,
    botUserId: a.botUserId ?? null,
  })
  const gaps: KbGapInput[] = []
  const key = (u: DialogUser) => `${u.channel}:${u.id}`
  const live = (a: MemoryApplication) => !a.anonymizedAt
  const mine = (a: MemoryApplication, u: { channel: string; id: string }) =>
    (a.channel === u.channel && a.channelUserId === u.id) || (a.botChannel === u.channel && a.botUserId === u.id)
  return {
    applications,
    gaps,
    reminds,
    botUsers,
    async getSession(user) {
      botUsers.set(key(user), { firstName: user.firstName ?? botUsers.get(key(user))?.firstName ?? null, username: user.username ?? botUsers.get(key(user))?.username ?? null })
      const r = reminds.get(key(user))
      const remind = r?.at && !r.offAt ? { dept: r.dept ?? 'any' } : null
      return { ...structuredClone(sessions.get(key(user)) ?? emptySession()), remind }
    },
    async saveSession(user, session) {
      sessions.set(key(user), structuredClone(sessionToSave(session)))
    },
    async saveApplication(input) {
      const app: Application = { ...asStored(input), id: Math.random().toString(36).slice(2, 8).toUpperCase(), createdAt: new Date().toISOString() }
      // Код приглашения уникален, как в базе: при совпадении заявка принимается, код не записывается
      if (app.refCode && applications.some((a) => a.refCode === app.refCode)) app.refCode = null
      applications.unshift(app)
      const token = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('')
      tokens.set(app.id, token)
      return { ...app, statusToken: token }
    },
    // Те же правила, что у acceptApplication в PostgreSQL. Сохраняет через this.saveApplication: проверка,
    // подменившая saveApplication (сбой базы), видит его и здесь
    async acceptApplication(input) {
      const key = personKey(input)
      const now = Date.now()
      const same = applications.filter((a) => {
        const age = now - Date.parse(a.createdAt)
        if (age > 3600_000) return false
        const other = personKey(a)
        return Boolean((key.phone && other.phone === key.phone) || (key.contact && other.contact === key.contact))
      })
      if (same.some((a) => now - Date.parse(a.createdAt) < REPEAT_MINUTES * 60_000)) return { ok: false, error: 'already_applied' }
      if (same.length >= PER_HOUR) {
        const oldest = Math.min(...same.map((a) => Date.parse(a.createdAt)))
        return { ok: false, error: 'phone_limit', retryAfter: Math.max(1, Math.ceil((oldest + 3600_000 - now) / 1000)) }
      }
      return { ok: true, application: await this.saveApplication(input) }
    },
    async latestApplicationFor(channel, channelUserId) {
      const app = applications.find((a) => live(a) && mine(a, { channel, id: channelUserId }))
      return app ? asHr(app) : null
    },
    async createBotLink(appId, names = botNamesFromEnv()) {
      const app = applications.find((a) => a.id === appId && live(a))
      const links = app ? botLinks(names, '') : {}
      if (!app || !Object.keys(links).length) return null
      const { token, hash } = newBotLinkToken()
      app.botLinkHash = hash
      app.botLinkExpiresAt = Date.now() + BOT_LINK_TTL_HOURS * 3600_000
      return botLinks(names, token)
    },
    async linkBotApplication(token, user) {
      if (user.channel === 'web') return null
      const hash = botLinkHash(token)
      const app = applications.find((a) => a.botLinkHash === hash)
      if (!app || !sameBotLinkHash(app.botLinkHash, token) || !live(app) || (app.botLinkExpiresAt ?? 0) < Date.now()) return null
      app.botChannel = user.channel as BotChannel
      app.botUserId = user.id
      app.botLinkHash = null
      app.botLinkExpiresAt = null
      return { id: app.id }
    },
    async unlinkBot(user) {
      const linked = applications.filter((a) => a.botChannel === user.channel && a.botUserId === user.id)
      for (const a of linked) {
        a.botChannel = null
        a.botUserId = null
      }
      return linked.length
    },
    async setRemind(user, sub) {
      const was = reminds.get(key(user)) ?? { dept: null, source: null, at: null, offAt: null }
      const now = new Date().toISOString()
      reminds.set(key(user), sub ? { dept: sub.dept, source: sub.source, at: now, offAt: null } : { ...was, offAt: was.at ? now : was.offAt })
    },
    async eraseUser(user) {
      const own = applications.filter((a) => live(a) && mine(a, user))
      for (const a of own) {
        Object.assign(a, { name: '', lastName: '', middleName: '', phone: '', contact: '', school: '', friend: '', portfolio: '', comment: '', channelUserId: undefined, botChannel: null, botUserId: null, birthDate: '' })
        a.anonymizedAt = new Date().toISOString()
        tokens.delete(a.id)
      }
      sessions.delete(key(user))
      reminds.delete(key(user))
      if (botUsers.has(key(user))) botUsers.set(key(user), { firstName: null, username: null })
      return { applications: own.length }
    },
    async statusForToken(id, token) {
      const app = applications.find((a) => a.id === id && live(a))
      return app && tokens.get(id) === token ? candidateStatus(asHr(app)) : null
    },
    async workSettings() {
      return defaultWorkSettings
    },
    async logGap(gap) {
      gaps.unshift(gap)
    },
  }
}

/** Имена ботов для ссылок: t.me/<имя> и max.ru/<ник>. null — бот не подключён */
export type BotNames = { telegram: string | null; max: string | null }
export type BotLinks = { telegram?: string; max?: string }

/** Имена из TELEGRAM_BOT_USERNAME и MAX_BOT_NICK — без @ и адреса; странное значение — как не заданное */
export function botNamesFromEnv(env: NodeJS.ProcessEnv = process.env): BotNames {
  const clean = (v: string | undefined, re: RegExp) => {
    const s = (v ?? '').trim().replace(/^https?:\/\/[^/]+\//i, '').replace(/^@/, '')
    return re.test(s) ? s : null
  }
  return { telegram: clean(env.TELEGRAM_BOT_USERNAME, /^[A-Za-z][A-Za-z0-9_]{3,31}$/), max: clean(env.MAX_BOT_NICK, /^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$/) }
}

/** Диплинки на ботов с токеном привязки: start=app_<токен> */
export function botLinks(names: BotNames, token: string): BotLinks {
  const start = `app_${token}`
  return {
    ...(names.telegram ? { telegram: `https://t.me/${names.telegram}?start=${start}` } : {}),
    ...(names.max ? { max: `https://max.ru/${names.max}?start=${start}` } : {}),
  }
}
