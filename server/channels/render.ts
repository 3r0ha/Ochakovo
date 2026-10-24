import type { Button } from '../dialog/types'

// Общие помощники адаптеров: разметка, нарезка длинного текста, раскладка кнопок

export function escapeHtml(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Текст сценария → HTML мессенджера: экранирование и **жирный** → <b>жирный</b> */
export function toHtml(text: string) {
  return escapeHtml(text).replace(/\*\*([\s\S]+?)\*\*/g, '<b>$1</b>')
}

/**
 * Режет текст на куски не длиннее limit, по абзацам, строкам или словам.
 * Если разрез попал внутрь **жирного**, закрывает его в одном куске и открывает в следующем.
 */
export function splitText(text: string, limit: number): string[] {
  const parts: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit)
    if (cut < limit / 2) cut = rest.lastIndexOf('\n', limit)
    if (cut < limit / 2) cut = rest.lastIndexOf(' ', limit)
    if (cut < limit / 2) cut = limit
    parts.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest) parts.push(rest)

  // Выравниваем незакрытый ** на стыках
  for (let i = 0; i < parts.length - 1; i++) {
    const marks = parts[i].match(/\*\*/g)?.length ?? 0
    if (marks % 2 === 1) {
      parts[i] += '**'
      parts[i + 1] = '**' + parts[i + 1]
    }
  }
  return parts
}

export const byteLength = (s: string) => Buffer.byteLength(s, 'utf8')

/**
 * Делит ряды кнопок, если канал ограничивает их число в ряду.
 * narrowKinds — типы кнопок, для которых действует отдельный лимит narrowMax (в MAX: ссылки и запрос контакта — не больше 3).
 */
export function layoutRows(rows: Button[][], maxPerRow: number, narrowMax = maxPerRow, narrowKinds: Button['kind'][] = []): Button[][] {
  const out: Button[][] = []
  for (const row of rows) {
    const limit = row.some((b) => narrowKinds.includes(b.kind)) ? Math.min(narrowMax, maxPerRow) : maxPerRow
    for (let i = 0; i < row.length; i += limit) out.push(row.slice(i, i + limit))
  }
  return out.filter((r) => r.length > 0)
}

export const hasContactButton = (rows: Button[][] | undefined) => Boolean(rows?.some((r) => r.some((b) => b.kind === 'contact')))

/** Последовательное выполнение задач по ключу (чат) и пауза между ними — чтобы не нарушать порядок и лимиты канала */
export class ChatQueue {
  private tails = new Map<string, Promise<unknown>>()
  private last = new Map<string, number>()

  constructor(private minInterval = 0) {}

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve()
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        if (this.minInterval > 0) {
          const wait = (this.last.get(key) ?? 0) + this.minInterval - Date.now()
          if (wait > 0) await sleep(wait)
        }
        try {
          return await task()
        } finally {
          this.last.set(key, Date.now())
        }
      })
    this.tails.set(key, next)
    // Чистим хвост очереди и при ошибке — без порождения необработанного отказа
    const cleanup = () => {
      if (this.tails.get(key) === next) this.tails.delete(key)
    }
    next.then(cleanup, cleanup)
    return next
  }
}

/**
 * «Печатает…» на время ответа: шлёт действие сразу и повторяет раз в intervalMs, пока не вызван stop().
 * stop() дожидается последнего запроса, чтобы ответ ушёл после него. Сбой пишется в журнал и ответу не мешает
 */
export function keepTyping(send: () => Promise<unknown>, intervalMs: number, log: Logger, label: string) {
  let pending: Promise<unknown> = Promise.resolve()
  let warned = false
  const fire = () => {
    pending = send().catch((e) => {
      // Одна запись на ответ: при повторах раз в несколько секунд журнал не засоряется
      if (!warned) log.warn(`${label}: ${(e as Error).message}`)
      warned = true
    })
  }
  fire()
  const timer = setInterval(fire, intervalMs)
  timer.unref?.()
  return async () => {
    clearInterval(timer)
    await pending
  }
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve()
    const id = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(id)
        resolve()
      },
      { once: true },
    )
  })

export type Logger = Pick<Console, 'info' | 'warn' | 'error'>
