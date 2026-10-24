import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Link } from 'react-router'
import { maskBirthDate } from '@shared/birthDate'
import { RESPONSE_WORDS } from '@shared/candidateStatus'
import { waitText } from '../candidate/applyText'
import drawn from 'virtual:mascot-poses'
import { Pictogram } from '../../home/Pictogram'
import { Mascot } from '../Mascot'
import { lockPage, OPEN_CHAT_EVENT, takePendingQuestion } from './bus'
import { Message } from './Message'
import { CHAT_TIMEOUT_MS, useChat, type ChatFailure, type InputHint } from './useChat'

// Панель чата — отдельный чанк: грузится только когда человек открыл чат

const ease = [0.16, 1, 0.3, 1] as const

const suggestions = ['Сколько платят без опыта?', 'Можно работать только летом?', 'Где жить, если я не из Москвы?']

type FieldMode = InputHint | 'handle'

/**
 * Поле ввода под шаг бота: на шаге имени — «Имя», на шаге телефона — цифровая клавиатура (inputmode=tel),
 * в остальное время — вопрос. Бот на шаге телефона принимает и ник, а на цифровой клавиатуре букв нет —
 * поэтому на сенсорном экране рядом кнопка «Ник вместо номера», она включает обычную клавиатуру (режим handle).
 * На компьютере переключателя нет, подсказка — «Телефон или @ник». Подпись для скринридера меняется вместе с подсказкой
 */
const inputFor: Record<FieldMode, { label: string; placeholder: string; inputMode?: 'tel' | 'text' | 'numeric'; autoComplete: string }> = {
  name: { label: 'Имя для заявки', placeholder: 'Имя', inputMode: 'text', autoComplete: 'given-name' },
  phone: { label: 'Телефон для заявки', placeholder: 'Номер телефона', inputMode: 'tel', autoComplete: 'tel' },
  date: { label: 'Дата рождения для заявки', placeholder: 'ДД.ММ.ГГГГ', inputMode: 'numeric', autoComplete: 'bday' },
  handle: { label: 'Ник в Telegram или MAX для заявки', placeholder: '@ник в Telegram или MAX', inputMode: 'text', autoComplete: 'off' },
  free: { label: 'Вопрос Квасычу', placeholder: 'Напиши вопрос', autoComplete: 'off' },
}

/** Что сказать, если ответ не пришёл */
const failureText = (f: ChatFailure | null) =>
  f?.reason === 'timeout'
    ? `Квасыч не ответил за ${CHAT_TIMEOUT_MS / 1000} секунд.`
    : f?.reason === 'busy'
      ? `Слишком много сообщений подряд. Подожди ${waitText(f.retryAfter ?? 10)}.`
      : 'Не получилось отправить.'

export default function ChatPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const chat = useChat()

  // Первое открытие — бот здоровается; дальше история берётся из sessionStorage.
  // Если чат открыли с вопросом (openKvasychChat(question)), вопрос уходит после приветствия
  useEffect(() => {
    if (!open) return
    lockPage(true)
    let alive = true
    // Вопрос забираем только из живого эффекта: в StrictMode первый, отброшенный запуск его не съест
    const ask = async () => {
      if (!alive || !(await chat.ensureAvailable()) || !alive) return
      const q = takePendingQuestion()
      if (q) chat.sendText(q)
    }
    void chat.start().then(ask)
    // Чат уже открыт, а вопрос пришёл снова
    const onOpen = () => void ask()
    window.addEventListener(OPEN_CHAT_EVENT, onOpen)
    return () => {
      alive = false
      window.removeEventListener(OPEN_CHAT_EVENT, onOpen)
      lockPage(false)
    }
    // старт нужен только при открытии панели
  }, [open])

  return <AnimatePresence>{open && <Panel chat={chat} onClose={onClose} />}</AnimatePresence>
}

function Panel({ chat, onClose }: { chat: ReturnType<typeof useChat>; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState('')
  const [confirmReset, setConfirmReset] = useState(false)
  const seen = useRef({ count: chat.entries.length, batch: chat.lastBatch })

  const lastBotBatch = chat.lastBatch
  const unavailable = chat.available === false
  // Ник вместо номера на шаге телефона: обычная клавиатура до следующего ответа бота.
  // Переключатель нужен только на сенсорном экране — на клавиатуре компьютера буквы есть всегда
  const [touch] = useState(() => window.matchMedia('(pointer: coarse)').matches)
  const [handle, setHandle] = useState(false)
  useEffect(() => setHandle(false), [chat.lastBatch])
  const field =
    chat.expect === 'phone' && !touch ? { ...inputFor.phone, placeholder: 'Телефон или @ник' } : inputFor[chat.expect === 'phone' && handle ? 'handle' : chat.expect]
  const switchKeyboard = () => {
    setHandle((h) => !h)
    // Клавиатура телефона меняется при новом фокусе: кнопка его забрала, возвращаем в поле
    window.setTimeout(() => input.current?.focus(), 0)
  }

  // Прокрутка: к началу нового ответа (длинный ответ читается сверху), вниз — для своего сообщения и «печатает»,
  // без прокрутки — когда бот поменял сообщение на месте (переключатели месяцев, шаги подбора)
  useLayoutEffect(() => {
    const feed = list.current
    if (!feed || !panel.current) return
    // Низкий экран (сильное увеличение, телефон боком): прокручивается вся панель, а не только лента
    const el = getComputedStyle(feed).overflowY === 'visible' ? panel.current : feed
    const prev = seen.current
    seen.current = { count: chat.entries.length, batch: chat.lastBatch }
    const smooth = chat.entries.length > 3 ? 'smooth' : 'auto'
    const appended = chat.entries.length > prev.count
    if (chat.lastBatch > prev.batch && appended) {
      const firstNew = chat.entries.find((e) => e.from === 'bot' && e.batch === chat.lastBatch)
      const node = firstNew && el.querySelector<HTMLElement>(`[data-entry="${firstNew.id}"]`)
      if (node) {
        const top = node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
        el.scrollTo({ top: Math.max(0, top - 16), behavior: smooth })
        return
      }
    }
    if (appended || chat.busy || chat.failed) el.scrollTo({ top: el.scrollHeight, behavior: smooth })
  }, [chat.entries, chat.lastBatch, chat.busy, chat.failed])

  useEffect(() => {
    const id = window.setTimeout(() => (unavailable ? panel.current?.querySelector<HTMLElement>('a,button')?.focus() : input.current?.focus()), 60)
    return () => window.clearTimeout(id)
  }, [unavailable])

  // Esc закрывает панель, даже если фокус потерян (кнопка стала неактивной на время ответа)
  useEffect(() => {
    const onEsc = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onEsc)
    return () => document.removeEventListener('keydown', onEsc)
  }, [onClose])

  // Tab не выходит за пределы панели
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !panel.current) return
    const items = [...panel.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled])')]
    if (!items.length) return
    const first = items[0]
    const last = items.at(-1)!
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    if (!text.trim() || chat.busy) return
    chat.sendText(text)
    setText('')
  }

  // Enter — отправить, Shift+Enter — новая строка (во время набора с подсказками клавиатуры не трогаем)
  const onInputKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  // Поле растёт вместе с текстом, до четырёх строк
  useLayoutEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`
  }, [text])

  return (
    <>
      <motion.div
        className="fixed inset-0 z-[58] hidden bg-night/70 md:block"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.3 }}
        onClick={onClose}
        aria-hidden="true"
      />
      <motion.div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-title"
        onKeyDown={onKeyDown}
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ duration: 0.5, ease }}
        data-lenis-prevent
        className="fixed inset-0 z-[60] flex flex-col bg-night text-white md:inset-y-0 md:right-0 md:left-auto md:w-[420px] md:border-l md:border-white/10 [@media(max-height:480px)]:overflow-y-auto [@media(max-height:480px)]:overscroll-contain"
      >
        {/* Шапка панели — обычный div: элемент header внутри диалога читался бы как шапка всего сайта */}
        <div className="flex items-center gap-3 border-b border-white/10 px-4 pt-[max(12px,env(safe-area-inset-top))] pb-3 md:px-5">
          {/* Пока картинки Квасыча нет — фирменная пиктограмма «Стеклянная бутылка»: красная на тёмно-сером, как велит брендбук */}
          {drawn.includes('face') ? (
            <Mascot pose="face" dark className="size-11 shrink-0 rounded-full bg-coal" />
          ) : (
            <span aria-hidden="true" className="grid size-11 shrink-0 place-items-center bg-coal text-brand">
              <Pictogram id="glass-bottle" className="size-7" />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h2 id="chat-title" className="font-display text-[26px] leading-none font-black uppercase">
              Квасыч
            </h2>
            <p className="mt-1 text-[13px] leading-tight text-white/60">Вакансии, задания и заявка</p>
          </div>
          {chat.started && !confirmReset && (
            <button
              type="button"
              onClick={() => setConfirmReset(true)}
              className="inline-flex min-h-11 shrink-0 items-center px-2 text-[13px] text-white/60 underline-offset-4 hover:text-white hover:underline"
            >
              Начать заново
            </button>
          )}
          <button type="button" onClick={onClose} aria-label="Закрыть чат" className="relative grid size-11 shrink-0 place-items-center text-white/80 hover:text-white">
            <span className="absolute h-[2px] w-5 rotate-45 bg-current" />
            <span className="absolute h-[2px] w-5 -rotate-45 bg-current" />
          </button>
        </div>

        {/* «Начать заново» стирает переписку — переспрашиваем */}
        {confirmReset && (
          <div className="flex items-center gap-3 border-b border-white/10 bg-coal px-4 py-3 md:px-5" role="group" aria-label="Начать разговор заново">
            <p className="flex-1 text-[14px] text-white/80">Начать заново? Переписка сотрётся.</p>
            <button
              type="button"
              autoFocus
              onClick={() => {
                setConfirmReset(false)
                chat.reset()
              }}
              className="px-3 py-2 font-display text-[16px] font-extrabold tracking-[0.04em] text-white uppercase hover:text-brand"
            >
              Да
            </button>
            <button type="button" onClick={() => setConfirmReset(false)} className="px-3 py-2 text-[14px] text-white/60 hover:text-white">
              Нет
            </button>
          </div>
        )}

        <div
          ref={list}
          data-lenis-prevent
          className="relative flex-1 overflow-y-auto overscroll-contain px-4 py-5 md:px-5 [@media(max-height:480px)]:flex-none [@media(max-height:480px)]:overflow-visible"
          aria-live="polite"
        >
          {unavailable ? (
            <div className="flex h-full flex-col justify-center">
              <p className="font-display text-[34px] leading-[0.95] font-black uppercase">Чат сейчас недоступен</p>
              <p className="mt-3 text-[15px] text-white/70">{`Можно сразу оставить заявку, HR свяжется в течение ${RESPONSE_WORDS}.`}</p>
              <Link
                to="/apply"
                onClick={onClose}
                className="mt-6 inline-flex h-14 items-center justify-center bg-brand px-6 font-display text-[19px] font-extrabold tracking-[0.04em] uppercase hover:bg-white hover:text-brand"
              >
                Оставить заявку
              </Link>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {chat.entries.map((entry) => (
                <Message
                  key={entry.id}
                  entry={entry}
                  active={entry.from === 'bot' && entry.batch === lastBotBatch && !chat.busy}
                  onPress={chat.press}
                  onContact={chat.sendContact}
                />
              ))}
              {chat.busy && (
                <div className="flex w-fit gap-1.5 bg-coal px-4 py-3.5" role="status" aria-label="Квасыч печатает">
                  {[0, 1, 2].map((i) => (
                    <motion.span
                      key={i}
                      className="size-1.5 rounded-full bg-white/70"
                      animate={{ opacity: [0.25, 1, 0.25] }}
                      transition={{ duration: 1, repeat: Infinity, delay: i * 0.18 }}
                    />
                  ))}
                </div>
              )}
              {chat.failed && !chat.busy && (
                <p className="text-[14px] text-white/70" role="status">
                  {failureText(chat.failure)}{' '}
                  <button type="button" onClick={chat.retry} className="text-white underline underline-offset-4 hover:text-brand">
                    Повторить
                  </button>
                </p>
              )}
            </div>
          )}
        </div>

        {!unavailable && (
          <div className="border-t border-white/10 px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] md:px-5">
            <AnimatePresence>
              {chat.notice && (
                <motion.p
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="mb-2 text-[13px] text-white/60"
                  role="status"
                >
                  {chat.notice}
                </motion.p>
              )}
            </AnimatePresence>
            {/* Готовые вопросы — пока человек ничего не писал и бот не ждёт имя или телефон для заявки. Переносятся на новую
                строку целиком: в ленте с прокруткой вбок последний вопрос обрезался посередине слова */}
            {chat.started && !chat.askedText && chat.expect === 'free' && (
              <div className="mb-3 flex flex-wrap gap-2">
                {suggestions.map((q) => (
                  <button
                    key={q}
                    type="button"
                    disabled={chat.busy}
                    onClick={() => chat.sendText(q)}
                    className="min-h-11 px-3.5 py-2 text-left text-[14px] leading-snug text-white/80 ring-1 ring-white/20 ring-inset transition-colors hover:bg-white hover:text-ink disabled:opacity-40"
                  >
                    {q}
                  </button>
                ))}
              </div>
            )}
            {/* Шаг телефона: на цифровой клавиатуре нет букв — ник набирается после переключения */}
            {chat.expect === 'phone' && touch && (
              <button
                type="button"
                onClick={switchKeyboard}
                className="mb-2 inline-flex min-h-11 items-center text-[14px] text-white/75 underline decoration-white/30 underline-offset-4 hover:text-white hover:decoration-white"
              >
                {handle ? 'Ввести номер телефона' : 'Ник вместо номера'}
              </button>
            )}
            <form onSubmit={submit} className="flex items-end gap-2">
              <label htmlFor="chat-input" className="sr-only">
                {field.label}
              </label>
              <textarea
                ref={input}
                id="chat-input"
                rows={1}
                value={text}
                // На шаге даты рождения точки ставит маска, как в форме заявки
                onChange={(e) => setText(chat.expect === 'date' ? maskBirthDate(e.target.value) : e.target.value)}
                onKeyDown={onInputKey}
                maxLength={1000}
                inputMode={field.inputMode}
                autoComplete={field.autoComplete}
                enterKeyHint="send"
                placeholder={field.placeholder}
                className="min-h-12 min-w-0 flex-1 resize-none bg-coal px-4 py-3 text-[16px] leading-snug text-white outline-none ring-1 ring-white/10 ring-inset placeholder:text-white/45 focus:ring-white/40"
              />
              <button
                type="submit"
                disabled={chat.busy || !text.trim()}
                // Неактивная — нейтральная серая: красный на 40 % превращался в бордовый и выглядел как отдельный цвет
                className="h-12 shrink-0 bg-brand px-5 font-display text-[18px] font-extrabold tracking-[0.04em] uppercase transition-colors hover:bg-white hover:text-brand disabled:bg-coal disabled:text-white/40 disabled:ring-1 disabled:ring-white/10 disabled:ring-inset disabled:hover:bg-coal disabled:hover:text-white/40"
              >
                Отправить
              </button>
            </form>
            <p className="mt-2 text-[12px] leading-snug text-white/60">
              Квасыч отвечает по данным «Очаково» и может ошибаться. Точные условия подтвердит HR.{' '}
              <a href="/privacy" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-white">
                Политика обработки данных
              </a>
            </p>
          </div>
        )}
      </motion.div>
    </>
  )
}
