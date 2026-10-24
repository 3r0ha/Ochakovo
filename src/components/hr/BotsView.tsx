import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { HrUser } from '../../lib/api'
import {
  cleanStartLabel,
  compactJson,
  getBotsStatus,
  getOutbox,
  getPreview,
  htmlParts,
  resetPreview,
  sendPreview,
  statusLines,
  type BotsStatus,
  type Outbox as OutboxData,
  type PreviewChannel,
  type PreviewFeed,
  type PreviewInput,
  type ViewButton,
  type ViewCall,
  type ViewItem,
} from '../../lib/hr/bots'
import { chip, hrBtn, Notice } from './ui'

// Вкладка «Боты» в панели HR: состояние каналов из настоящего окружения и предпросмотр ленты бота.
// Предпросмотр — тот же движок и те же сборщики запросов, что у Telegram и MAX, но в мессенджер ничего не уходит
// и в базу ничего не пишется (server/channels/preview.ts). Переключатель показывает ту же переписку в другом мессенджере.

export const ready: boolean = true

const channelLabel: Record<PreviewChannel, string> = { telegram: 'Telegram', max: 'MAX' }

/** Своя сессия предпросмотра у каждой вкладки браузера: переживает перезагрузку, не мешает соседней вкладке */
function previewSid(): string {
  const key = 'ochakovo.hr.botsPreview'
  const fresh = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('')
  try {
    const saved = sessionStorage.getItem(key)
    if (saved && /^[a-f0-9]{24}$/.test(saved)) return saved
    const sid = fresh()
    sessionStorage.setItem(key, sid)
    return sid
  } catch {
    return fresh()
  }
}

export function BotsView({ user }: { user: HrUser }) {
  const admin = user.role === 'admin'
  const [channel, setChannel] = useState<PreviewChannel>('telegram')
  const [status, setStatus] = useState<BotsStatus | null>(null)
  const [statusError, setStatusError] = useState(false)

  useEffect(() => {
    getBotsStatus()
      .then(setStatus)
      .catch(() => setStatusError(true))
  }, [])

  return (
    <section className="grid gap-12 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:gap-16">
      <div className="min-w-0">
        <h2 className="font-display text-[28px] leading-none font-black uppercase">Каналы</h2>
        <p className="mt-4 max-w-md text-[15px] leading-snug text-white/65">Сайт и боты работают на одном движке диалогов, поэтому сценарий, заявка и ответы Квасыча везде одинаковые.</p>
        {statusError && (
          <div className="mt-6">
            <Notice tone="error">Состояние каналов не загрузилось. Обнови страницу.</Notice>
          </div>
        )}
        <ul className="mt-8 border-t border-white/15">
          {(status ? statusLines(status) : []).map((line) => (
            <li key={line.id} className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-4 border-b border-white/15 py-4">
              <span className="font-display text-[20px] leading-tight font-extrabold tracking-[0.04em] uppercase">{line.title}</span>
              <div className="min-w-0">
                <p className="flex items-start gap-2 text-[16px] leading-snug">
                  <span
                    aria-hidden="true"
                    className={`mt-[7px] size-2.5 shrink-0 rounded-full ${line.tone === 'ok' ? 'bg-leaf' : line.tone === 'bad' ? 'bg-brand' : 'bg-transparent ring-2 ring-smoke ring-inset'}`}
                  />
                  <span>{line.state}</span>
                </p>
                <p className="mt-1 pl-[18px] text-[14px] leading-snug text-white/65">{line.hint}</p>
                {admin && line.admin && (
                  <details className="mt-1.5 pl-[18px] text-[13px] text-white/65">
                    <summary className="cursor-pointer underline decoration-white/30 underline-offset-4 hover:text-white">Для администратора</summary>
                    <p className="mt-1 leading-snug">{line.admin}</p>
                  </details>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="min-w-0">
        <Preview channel={channel} onChannel={setChannel} showCalls={admin} />
        <Outbox channel={channel} />
      </div>
    </section>
  )
}

/** showCalls — под сообщениями запрос к мессенджеру: только администратору, отделу персонала он не нужен */
function Preview({ channel, onChannel, showCalls }: { channel: PreviewChannel; onChannel: (c: PreviewChannel) => void; showCalls: boolean }) {
  const sid = useRef(previewSid()).current
  const [feed, setFeed] = useState<PreviewFeed | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [text, setText] = useState('')
  const feedRef = useRef<HTMLDivElement>(null)
  const startId = useId()
  const textId = useId()

  useEffect(() => {
    let alive = true
    getPreview(sid, channel)
      .then((f) => alive && setFeed(f))
      .catch(() => alive && setError('Лента не загрузилась. Обнови страницу.'))
    return () => {
      alive = false
    }
  }, [sid, channel])

  // Лента держится у последнего сообщения, как в мессенджере, — и когда догружаются картинки.
  // Если HR прокрутил ленту вверх читать, она остаётся на месте до следующего действия
  const stick = useRef(true)
  const listRef = useRef<HTMLOListElement>(null)
  const toBottom = useCallback(() => {
    const el = feedRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [])
  useEffect(() => {
    const list = listRef.current
    if (!list || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(toBottom)
    observer.observe(list)
    return () => observer.disconnect()
  }, [toBottom])
  const count = feed?.items.length ?? 0
  useEffect(() => {
    stick.current = true
    toBottom()
  }, [count, channel, toBottom])
  const onScroll = () => {
    const el = feedRef.current
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }

  const act = useCallback(
    async (input: PreviewInput) => {
      setBusy(true)
      setError(null)
      try {
        setFeed(await sendPreview(sid, channel, input))
      } catch {
        setError('Бот не ответил. Проверь соединение и попробуй ещё раз.')
      } finally {
        setBusy(false)
      }
    },
    [sid, channel],
  )

  const start = (e: FormEvent) => {
    e.preventDefault()
    const payload = cleanStartLabel(label)
    void act({ type: 'start', ...(payload ? { payload } : {}) })
  }

  const say = (e: FormEvent) => {
    e.preventDefault()
    const t = text.trim()
    if (!t) return
    setText('')
    void act({ type: 'text', text: t })
  }

  const restart = async () => {
    setBusy(true)
    try {
      await resetPreview(sid)
      setFeed(await getPreview(sid, channel))
      setError(null)
    } catch {
      setError('Не получилось начать заново. Обнови страницу.')
    } finally {
      setBusy(false)
    }
  }

  const press = (b: ViewButton, ref: { turn: number; msg: number } | null) => {
    if (b.kind === 'contact') return void act({ type: 'contact' })
    if (b.kind === 'action' && b.action && ref) void act({ type: 'press', ref, action: b.action, label: b.text })
  }

  const items = feed?.items ?? []

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="min-w-0">
          <h2 className="font-display text-[28px] leading-none font-black uppercase">Предпросмотр</h2>
          <p className="mt-3 text-[15px] leading-snug text-white/70">Тот же движок, что у ботов. В мессенджер ничего не уходит</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div role="radiogroup" aria-label="Вид мессенджера" className="flex gap-2">
            {(['telegram', 'max'] as const).map((c) => (
              <button key={c} role="radio" aria-checked={channel === c} onClick={() => onChannel(c)} className={chip(channel === c)}>
                {channelLabel[c]}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void restart()}
            disabled={busy || !items.length}
            className={`${hrBtn.small} text-white/80 underline-offset-4 hover:text-white hover:underline`}
          >
            Начать заново
          </button>
        </div>
      </div>

      <form onSubmit={start} className="mt-6 flex flex-wrap items-end gap-3">
        <label htmlFor={startId} className="sr-only">
          Метка для /start
        </label>
        <div className="flex h-11 min-w-0 flex-1 basis-56 items-center border-b border-white/30 focus-within:border-white">
          <span className="shrink-0 pr-2 font-mono text-[15px] text-white/65" aria-hidden="true">
            /start
          </span>
          <input
            id={startId}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="метка, например fair-mgupp"
            autoComplete="off"
            spellCheck={false}
            className="h-full min-w-0 flex-1 bg-transparent font-mono text-[15px] text-white placeholder:font-sans placeholder:text-white/55"
          />
        </div>
        <button type="submit" disabled={busy} className={hrBtn.red}>
          Запустить
        </button>
      </form>

      <div className="mt-5 border border-white/15 bg-coal">
        <div
          ref={feedRef}
          role="log"
          aria-live="polite"
          aria-label={`Лента бота в виде ${channelLabel[channel]}`}
          aria-busy={busy}
          onScroll={onScroll}
          className="h-[min(60vh,600px)] overflow-y-auto overscroll-contain px-3 py-4 sm:px-5"
        >
          {!items.length && (
            <div className="flex h-full flex-col justify-center px-2">
              <p className="font-display text-[22px] leading-none font-black uppercase">Лента пустая</p>
              <p className="mt-2 max-w-sm text-[15px] leading-snug text-white/65">
                Запусти бота с меткой, и он откроется так же, как по QR-коду с ярмарки. Дальше нажимай кнопки и пиши, как кандидат.
              </p>
            </div>
          )}
          <ol ref={listRef} className="flex flex-col gap-3">
            {items.map((item) => (
              <li key={`${channel}-${item.id}`} className={item.kind === 'user' ? 'flex justify-end' : item.kind === 'note' ? 'flex justify-center' : 'flex justify-start'}>
                <FeedItem item={item} disabled={busy} onPress={press} showCalls={showCalls} />
              </li>
            ))}
          </ol>
          {busy && <p className="mt-3 text-[14px] text-white/65">Квасыч отвечает</p>}
        </div>

        {feed?.keyboard && (
          <div className="border-t border-white/15 px-3 py-3 sm:px-5">
            <p className="text-[13px] text-white/65">В Telegram кнопка «Отправить номер» появляется на клавиатуре под полем ввода</p>
            <ButtonRows rows={feed.keyboard.rows} disabled={busy} onPress={(b) => press(b, feed.keyboard!.ref)} />
          </div>
        )}

        <form onSubmit={say} className="flex items-center gap-2 border-t border-white/15 px-3 py-2 sm:px-5">
          <label htmlFor={textId} className="sr-only">
            Сообщение боту
          </label>
          <input
            id={textId}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={feed?.placeholder ?? 'Сообщение боту'}
            maxLength={1000}
            autoComplete="off"
            className="h-11 min-w-0 flex-1 bg-transparent text-[16px] text-white placeholder:text-white/55"
          />
          <button type="submit" disabled={busy || !text.trim()} className={hrBtn.smallGhost}>
            Отправить
          </button>
        </form>
      </div>
      {error && (
        <div className="mt-4">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
    </div>
  )
}

/** «Исходящие»: приглашение и напоминание от HR так, как их увидит кандидат в выбранном мессенджере */
function Outbox({ channel }: { channel: PreviewChannel }) {
  const [data, setData] = useState<OutboxData | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let alive = true
    getOutbox(channel)
      .then((d) => {
        if (!alive) return
        setData(d)
        setError(false)
      })
      .catch(() => alive && setError(true))
    return () => {
      alive = false
    }
  }, [channel])

  return (
    <section aria-labelledby="outbox-title" className="mt-14">
      <h2 id="outbox-title" className="font-display text-[28px] leading-none font-black uppercase">
        Исходящие
      </h2>
      <p className="mt-3 max-w-xl text-[15px] leading-snug text-white/65">
        Так кандидат увидит в {channelLabel[channel]} сообщения отдела персонала. Тексты приглашения и напоминания берутся из «Настроек», кнопка «Меню» такая же, как в очереди уведомлений. Вопрос «Как дела на смене» приходит с кнопками ответа.
        {data ? ` Пример: ${data.sample.name}, заявка № ${data.sample.id}, собеседование завтра в 11:00.` : ''}
      </p>
      {error && (
        <div className="mt-4">
          <Notice tone="error">Исходящие не загрузились. Обнови страницу.</Notice>
        </div>
      )}
      <ul className="mt-6 border-t border-white/15">
        {(data?.entries ?? []).map((e) => (
          <li key={e.key} className="border-b border-white/15 py-5">
            <h3 className="font-display text-[20px] leading-tight font-extrabold tracking-[0.04em] uppercase">{e.title}</h3>
            <p className="mt-1 text-[14px] leading-snug text-white/65">
              {e.hint}
              {e.enabled ? '' : '. Выключено в «Настройках» и сейчас не отправляется'}
            </p>
            <div className="mt-4 border border-white/15 bg-coal px-3 py-4 sm:px-5">
              {e.items.map((item) => (item.kind === 'bot' ? <BotBubble key={item.id} item={item} /> : null))}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

function FeedItem({
  item,
  disabled,
  onPress,
  showCalls,
}: {
  item: ViewItem
  disabled: boolean
  onPress: (b: ViewButton, ref: { turn: number; msg: number } | null) => void
  showCalls: boolean
}) {
  if (item.kind === 'user') {
    return <p className="max-w-[85%] bg-brand-dark px-3.5 py-2 text-[15px] leading-snug break-words whitespace-pre-line text-white">{item.text}</p>
  }
  if (item.kind === 'note') {
    if (!item.calls.length || !showCalls) return <p className="max-w-[90%] text-center text-[13px] leading-snug text-white/65">{item.text}</p>
    return (
      <div className="w-full max-w-[min(90%,560px)] text-center">
        <Calls calls={item.calls} title={item.text} center />
      </div>
    )
  }
  return <BotBubble item={item} disabled={disabled} onPress={(b) => onPress(b, item.ref)} showCalls={showCalls} />
}

/** Сообщение бота: текст с **жирным**, картинка, кнопки в той раскладке, что ушла бы в мессенджер, и тело запроса */
export function BotBubble({
  item,
  disabled,
  onPress,
  showCalls = true,
}: {
  item: Extract<ViewItem, { kind: 'bot' }>
  disabled?: boolean
  /** Без обработчика кнопки показываются, но не нажимаются */
  onPress?: (b: ViewButton) => void
  showCalls?: boolean
}) {
  return (
    <div className="w-full max-w-[min(85%,440px)] min-w-0">
      <div className="bg-ash px-3.5 py-2.5 text-[15px] leading-snug break-words text-white">
        {item.image && <img src={item.image} alt="Картинка к сообщению" loading="lazy" className="mb-2.5 max-h-72 w-full bg-night object-contain" />}
        {item.html && (
          <p className="whitespace-pre-line">
            {htmlParts(item.html).map((p, i) => (p.bold ? <strong key={i}>{p.text}</strong> : <span key={i}>{p.text}</span>))}
          </p>
        )}
        {item.edited && <p className="mt-1.5 text-[12px] text-white/60">Сообщение изменено по нажатию кнопки</p>}
      </div>
      {item.buttons.length > 0 && <ButtonRows rows={item.buttons} disabled={disabled} onPress={onPress} />}
      {showCalls && item.calls.length > 0 && <Calls calls={item.calls} />}
    </div>
  )
}

function ButtonRows({ rows, disabled, onPress }: { rows: ViewButton[][]; disabled?: boolean; onPress?: (b: ViewButton) => void }) {
  const cell =
    'flex min-h-9 min-w-0 items-center justify-center px-2 py-1.5 text-center text-[14px] leading-tight break-words ring-1 ring-white/20 ring-inset transition-colors'
  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {rows.map((row, r) => (
        <div key={r} className="grid auto-cols-fr grid-flow-col gap-1.5">
          {row.map((b, i) => {
            if (b.kind === 'link') {
              return (
                <a key={i} href={b.url} target="_blank" rel="noreferrer" className={`${cell} underline decoration-white/35 underline-offset-4 hover:ring-white/60`}>
                  {b.text}
                  <span className="sr-only"> (ссылка, откроется в новой вкладке)</span>
                </a>
              )
            }
            if (!onPress) {
              return (
                <span key={i} className={`${cell} text-white/85`}>
                  {b.text}
                </span>
              )
            }
            return (
              <button key={i} type="button" disabled={disabled} onClick={() => onPress(b)} className={`${cell} hover:bg-white/[0.06] hover:ring-white/60 disabled:opacity-50`}>
                {b.text}
                {b.kind === 'contact' && <span className="sr-only"> (в предпросмотре уйдёт тестовый номер)</span>}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}

/**
 * Тело запроса после сборщика — как его увидел бы мессенджер, без токена бота. Только администратору.
 * title — подпись служебной строки ленты вместо «Что уходит в мессенджер»
 */
function Calls({ calls, title, center }: { calls: ViewCall[]; title?: string; center?: boolean }): ReactNode {
  return (
    <details className="mt-1.5 text-left">
      <summary className={`cursor-pointer text-[13px] leading-snug text-white/65 select-none hover:text-white ${center ? 'text-center' : ''}`}>
        {title ? (
          <>
            <span className="text-white/75">{title}</span> · что уходит в мессенджер
          </>
        ) : (
          'Что уходит в мессенджер'
        )}
      </summary>
      <div className="mt-1.5 flex flex-col gap-2">
        {calls.map((c, i) => (
          <div key={i} className="min-w-0 border border-white/10 bg-night">
            <p className="border-b border-white/10 px-2.5 py-1.5 font-mono text-[12px] break-all text-white/70">POST {c.path}</p>
            <pre className="max-h-80 overflow-auto px-2.5 py-2 font-mono text-[12px] leading-snug [overflow-wrap:anywhere] whitespace-pre-wrap text-white/80">
              {compactJson(c.body)}
            </pre>
          </div>
        ))}
      </div>
    </details>
  )
}
