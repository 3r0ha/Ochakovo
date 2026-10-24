import { useCallback, useEffect, useRef, useState } from 'react'
import { myRefCode } from '../../lib/ref'
import { useProfile } from '../../store/profile'
import { useSentApplication } from '../candidate/sent'
import { sentApplication, siteProgress } from './bus'

// Чат на сайте — тот же бот, что в Telegram и MAX: POST /api/dialog с каналом 'web'.
// История живёт в sessionStorage (переживает переходы между страницами),
// id пользователя — в localStorage, чтобы бот помнил прогресс между визитами.

/** Сколько ждать ответа бота. Дольше — показываем «Квасыч не ответил» и «Повторить» */
export const CHAT_TIMEOUT_MS = 30_000

export type ChatButton =
  | { kind: 'action'; text: string; action: string }
  | { kind: 'link'; text: string; url: string }
  /** Кнопка мини-приложения Telegram: в чате на сайте это обычная ссылка */
  | { kind: 'app'; text: string; url: string }
  | { kind: 'contact'; text: string }

/** Чего бот ждёт в поле ввода после сообщения: имя, телефон или ник, любой текст (OutMessage.input в server/dialog/types.ts) */
export type InputHint = 'name' | 'phone' | 'date' | 'free'

type BotMessage = { text: string; image?: { url: string }; buttons?: ChatButton[][]; replace?: boolean; input?: InputHint }
/** Заявка, сохранённая этим ответом (DialogReply.application): браузер запоминает её для «Моей заявки» */
type ChatApplication = { id: string; token: string; name: string; phone: string; contact: string; vacancyId: string; friend: string }
type Reply = { messages: BotMessage[]; notice?: string; application?: ChatApplication }

export type ChatEntry =
  | { id: string; from: 'bot'; text: string; image?: string; buttons?: ChatButton[][]; input?: InputHint; batch: number }
  | { id: string; from: 'user'; text: string }

/** Почему не получилось: timeout — бот не ответил за CHAT_TIMEOUT_MS, busy — слишком много сообщений подряд (429), error — остальное */
export type ChatFailure = { reason: 'timeout' | 'busy' | 'error'; retryAfter?: number }

class ChatHttpError extends Error {
  constructor(
    public status: number,
    public retryAfter?: number,
  ) {
    super(`dialog ${status}`)
  }
}

type ChatEvent =
  | { type: 'start'; payload?: string }
  | { type: 'action'; action: string }
  | { type: 'text'; text: string }
  | { type: 'contact'; phone: string }

type Stored = { entries: ChatEntry[]; batch: number; started: boolean; askedText: boolean }

const TRANSCRIPT_KEY = 'ochakovo.chat.v1'
const USER_KEY = 'ochakovo.chat.uid'

/** 128 случайных бит из crypto: по id сервер находит переписку, угадать чужой нельзя */
const makeId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')

function userId() {
  try {
    let id = localStorage.getItem(USER_KEY)
    if (!id) {
      id = `w-${Date.now().toString(36)}-${makeId()}`
      localStorage.setItem(USER_KEY, id)
    }
    return id
  } catch {
    return `w-${makeId()}`
  }
}

function loadStored(): Stored {
  try {
    const raw = sessionStorage.getItem(TRANSCRIPT_KEY)
    if (raw) return JSON.parse(raw) as Stored
  } catch {
    // повреждённая история — начинаем заново
  }
  return { entries: [], batch: 0, started: false, askedText: false }
}

async function post(event: ChatEvent, signal: AbortSignal): Promise<Reply> {
  const res = await fetch('/api/dialog', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // siteProgress — задания, пройденные на странице: бот в чате показывает ту же «Смену», что и сайт
    // application — заявка из этого браузера: бот ответит на «что с моей заявкой» её статусом
    // refCode — личный код приглашения браузера: «Позвать друга» в чате и заявка из чата берут тот же код, что и сайт
    body: JSON.stringify({ user: { channel: 'web', id: userId() }, event, siteProgress: siteProgress(), ...sentApplication(), refCode: myRefCode() }),
    signal,
  })
  if (!res.ok) {
    const retry = Number(res.headers.get('retry-after'))
    throw new ChatHttpError(res.status, Number.isFinite(retry) && retry > 0 ? retry : undefined)
  }
  return (await res.json()) as Reply
}

/** Доступен ли сервер с ботом: на статическом хостинге API нет */
async function checkApi(): Promise<boolean> {
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), 4000)
  try {
    const res = await fetch('/api/health', { signal: ctrl.signal })
    if (!res.ok) return false
    const body = (await res.json()) as { engine?: boolean }
    return Boolean(body.engine)
  } catch {
    return false
  } finally {
    window.clearTimeout(timer)
  }
}

export function useChat() {
  const [state, setState] = useState<Stored>(loadStored)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<{ event: ChatEvent; failure: ChatFailure } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [available, setAvailable] = useState<boolean | null>(null)
  const abort = useRef<AbortController | null>(null)
  const profileSource = useProfile((s) => s.source)

  useEffect(() => {
    try {
      sessionStorage.setItem(TRANSCRIPT_KEY, JSON.stringify(state))
    } catch {
      // хранилище недоступно — история просто не сохранится
    }
  }, [state])

  useEffect(() => {
    if (!notice) return
    const id = window.setTimeout(() => setNotice(null), 3200)
    return () => window.clearTimeout(id)
  }, [notice])

  useEffect(() => () => abort.current?.abort(), [])

  const ensureAvailable = useCallback(async () => {
    if (available !== null) return available
    const ok = await checkApi()
    setAvailable(ok)
    return ok
  }, [available])

  /**
   * Отправить событие. echo — что показать от имени человека.
   * Нажатие кнопки: если бот отвечает с replace, сообщение с кнопкой меняется на месте и эхо не нужно
   * (так работают переключатели месяцев и шаги подбора); иначе эхо и новые сообщения добавляются вниз.
   */
  const send = useCallback(async (event: ChatEvent, opts: { echo?: string; echoNow?: boolean; sourceId?: string } = {}) => {
    abort.current?.abort()
    const ctrl = new AbortController()
    abort.current = ctrl
    // Бот молчит дольше CHAT_TIMEOUT_MS — обрываем запрос и предлагаем повторить
    let timedOut = false
    const timer = window.setTimeout(() => {
      timedOut = true
      ctrl.abort()
    }, CHAT_TIMEOUT_MS)
    setFailed(null)
    setBusy(true)
    const { echo, echoNow, sourceId } = opts
    if (echo && echoNow) setState((s) => ({ ...s, entries: [...s.entries, { id: makeId(), from: 'user', text: echo }] }))
    try {
      const reply = await post(event, ctrl.signal)
      // Заявка из чата: шапка покажет «Моя заявка», страница /apply — её статус
      if (reply.application?.id && reply.application.token) useSentApplication.getState().remember(reply.application)
      setState((s) => {
        const batch = s.batch + 1
        let entries = s.entries
        const [first, ...rest] = reply.messages
        const toEntry = (m: BotMessage, id = makeId()): ChatEntry => ({ id, from: 'bot', text: m.text, image: m.image?.url, buttons: m.buttons, input: m.input, batch })
        const inPlace = Boolean(first?.replace && sourceId && entries.some((e) => e.id === sourceId))
        if (inPlace) {
          entries = entries.map((e) => (e.id === sourceId ? toEntry(first, sourceId) : e))
          entries = [...entries, ...rest.map((m) => toEntry(m))]
        } else {
          if (echo && !echoNow) entries = [...entries, { id: makeId(), from: 'user', text: echo }]
          entries = [...entries, ...reply.messages.map((m) => toEntry(m))]
        }
        return { ...s, entries, batch, started: true }
      })
      if (reply.notice) setNotice(reply.notice)
    } catch (e) {
      // Оборвали сами новым сообщением или «Сначала» — это не ошибка
      if (timedOut) setFailed({ event, failure: { reason: 'timeout' } })
      else if (e instanceof ChatHttpError && e.status === 429) setFailed({ event, failure: { reason: 'busy', retryAfter: e.retryAfter } })
      else if ((e as Error).name !== 'AbortError') setFailed({ event, failure: { reason: 'error' } })
    } finally {
      window.clearTimeout(timer)
      if (abort.current === ctrl) setBusy(false)
    }
  }, [])

  /** Метка источника для бота: ?src из адреса, иначе первая метка из профиля, иначе 'site' */
  const startPayload = useCallback(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('src')
    return (fromUrl || profileSource || 'site').replace(/[^\w-]/g, '').slice(0, 64) || 'site'
  }, [profileSource])

  const start = useCallback(async () => {
    if (state.started || busy) return
    if (!(await ensureAvailable())) return
    await send({ type: 'start', payload: startPayload() })
  }, [state.started, busy, ensureAvailable, startPayload, send])

  const press = useCallback((button: ChatButton, sourceId: string) => {
    if (button.kind === 'action') void send({ type: 'action', action: button.action }, { echo: button.text, sourceId })
  }, [send])

  const sendText = useCallback((text: string) => {
    const clean = text.trim().slice(0, 1000)
    if (!clean) return
    setState((s) => ({ ...s, askedText: true }))
    void send({ type: 'text', text: clean }, { echo: clean, echoNow: true })
  }, [send])

  const sendContact = useCallback((phone: string) => {
    void send({ type: 'contact', phone }, { echo: phone, echoNow: true })
  }, [send])

  const retry = useCallback(() => {
    if (failed) void send(failed.event)
  }, [failed, send])

  /** «Сначала»: чистим историю и заново запускаем бота */
  const reset = useCallback(() => {
    abort.current?.abort()
    setState({ entries: [], batch: 0, started: false, askedText: false })
    setFailed(null)
    void send({ type: 'start', payload: startPayload() })
  }, [send, startPayload])

  // Подсказка поля ввода — по последнему сообщению бота: шаг имени, телефона или свободный вопрос
  const lastBot = [...state.entries].reverse().find((e) => e.from === 'bot')
  const expect: InputHint = (lastBot?.from === 'bot' && lastBot.input) || 'free'

  return {
    entries: state.entries,
    lastBatch: state.batch,
    started: state.started,
    askedText: state.askedText,
    busy,
    failed: Boolean(failed),
    failure: failed?.failure ?? null,
    expect,
    notice,
    available,
    ensureAvailable,
    start,
    press,
    sendText,
    sendContact,
    retry,
    reset,
  }
}
