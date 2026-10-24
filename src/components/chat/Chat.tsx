import { AnimatePresence, motion } from 'motion/react'
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { Link, useLocation } from 'react-router'
import { useSentApplication } from '../candidate/sent'
import { inTelegram } from '../../lib/telegram'
import { CHAT_BAR_HEIGHT, OPEN_CHAT_EVENT, useOverlay } from './bus'

// Здесь только кнопка. Сама панель чата — отдельный чанк, грузится при первом открытии
const loadPanel = () => import('./ChatPanel')
const ChatPanel = lazy(loadPanel)

const ease = [0.16, 1, 0.3, 1] as const

/** На главной кнопка появляется после первого экрана: там уже есть две главные кнопки */
function usePastHero(pathname: string) {
  const onHome = pathname === '/'
  const [past, setPast] = useState(!onHome)
  useEffect(() => {
    if (!onHome) {
      setPast(true)
      return
    }
    const check = () => setPast(window.scrollY > window.innerHeight * 0.7)
    check()
    window.addEventListener('scroll', check, { passive: true })
    return () => window.removeEventListener('scroll', check)
  }, [onHome])
  return past
}

/** Компьютер или планшет — вкладка в правом поле; телефон — полоса внизу */
function useDesktop() {
  const query = '(min-width: 768px)'
  const [desktop, setDesktop] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const m = window.matchMedia(query)
    const on = () => setDesktop(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return desktop
}

/**
 * Есть ли на экране один из разделов: кнопку прячем над игрой (она перекрывала бы ленту), а полосу на телефоне —
 * ещё и над «Спросить Квасыча» со своим полем и над финальной кнопкой «Откликнуться»: там она повторяла бы их
 */
function useSectionsInView(pathname: string, ids: readonly string[]) {
  const [inView, setInView] = useState(false)
  const key = ids.join(' ')
  useEffect(() => {
    setInView(false)
    const els = key.split(' ').flatMap((id) => document.getElementById(id) ?? [])
    if (!els.length) return
    const seen = new Set<Element>()
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) seen.add(e.target)
          else seen.delete(e.target)
        }
        setInView(seen.size > 0)
      },
      { threshold: 0.15 },
    )
    for (const el of els) io.observe(el)
    return () => io.disconnect()
  }, [pathname, key])
  return inView
}

const GAME = ['game'] as const
const BAR_HIDDEN_OVER = ['game', 'bot', 'final'] as const

/** Курсор в поле ввода: на телефоне открыта клавиатура, полоса над ней закрывала бы поле */
function useTyping() {
  const [typing, setTyping] = useState(false)
  useEffect(() => {
    const field = (t: EventTarget | null) => t instanceof HTMLElement && Boolean(t.closest('input:not([type=checkbox]):not([type=radio]),textarea,select,[contenteditable]'))
    const onIn = (e: FocusEvent) => setTyping(field(e.target))
    const onOut = () => setTyping(false)
    document.addEventListener('focusin', onIn)
    document.addEventListener('focusout', onOut)
    return () => {
      document.removeEventListener('focusin', onIn)
      document.removeEventListener('focusout', onOut)
    }
  }, [])
  return typing
}

const INTERACTIVE = 'a[href],button,input,select,textarea,label,summary,[role="button"],[role="link"],[tabindex]:not([tabindex="-1"])'

/**
 * Кнопка чата никогда не лежит поверх ссылок и кнопок страницы: проверяем, что под ней, по событиям —
 * прокрутка, смена размера окна и страницы (раскрылся список, догрузилась картинка), нажатия. Постоянного опроса нет:
 * в покое страница не тратит ни кадров, ни заряда
 */
function useCoversInteractive(root: RefObject<HTMLElement | null>, enabled: boolean) {
  // Пока не проверили — считаем, что перекрывает: кнопка не мелькает поверх ссылки при появлении
  const [covers, setCovers] = useState(true)
  useEffect(() => {
    if (!enabled) {
      setCovers(true)
      return
    }
    let frame = 0
    let clearTimer = 0
    const check = () => {
      frame = 0
      const el = root.current
      if (!el) return
      const r = el.getBoundingClientRect()
      if (!r.width) return
      // Сетка точек с шагом 10 px — мелкая кнопка-стрелка не проскочит между ними.
      // Сверху и снизу — запас; по бокам без запаса: кнопка стоит в поле страницы вплотную к контенту
      const pad = 6
      const step = 10
      const xs: number[] = []
      const ys: number[] = []
      for (let x = r.left + 1; x < r.right; x += step) xs.push(x)
      xs.push(r.right - 1)
      for (let y = r.top - pad; y < r.bottom + pad; y += step) ys.push(y)
      ys.push(r.bottom + pad - 1)
      // На время проверки кнопку убираем из попадания — elementFromPoint вернёт то, что под ней. Кадр не перерисовывается
      el.style.visibility = 'hidden'
      const hit = xs.some((x) => ys.some((y) => Boolean(document.elementFromPoint(x, y)?.closest(INTERACTIVE))))
      el.style.visibility = ''
      // Прячем сразу, а показываем с задержкой — чтобы кнопка не мигала на краю ссылки.
      // Отложенный показ не перезапускаем при каждой проверке, иначе при частых проверках он не наступит никогда
      if (hit) {
        window.clearTimeout(clearTimer)
        clearTimer = 0
        setCovers(true)
      } else if (!clearTimer) {
        clearTimer = window.setTimeout(() => {
          clearTimer = 0
          setCovers(false)
        }, 180)
      }
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(check)
    }
    // После остановки прокрутки страница ещё доезжает (плавный скролл, анимации, привязанные к прокрутке) —
    // поэтому проверяем и через мгновение после последнего события, и потом ещё раз
    let settle1 = 0
    let settle2 = 0
    const onScroll = () => {
      schedule()
      window.clearTimeout(settle1)
      window.clearTimeout(settle2)
      settle1 = window.setTimeout(schedule, 160)
      settle2 = window.setTimeout(schedule, 700)
    }
    schedule()
    // Страница сменила высоту (догрузились шрифты, раскрылась вакансия) — проверяем сразу.
    // Нажатие может раскрыть что-то без смены высоты (вкладки, анимация) — проверяем и после того, как всё доедет
    const resize = new ResizeObserver(onScroll)
    resize.observe(document.body)
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', schedule)
    document.addEventListener('click', onScroll, { capture: true, passive: true })
    return () => {
      resize.disconnect()
      cancelAnimationFrame(frame)
      window.clearTimeout(clearTimer)
      window.clearTimeout(settle1)
      window.clearTimeout(settle2)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', schedule)
      document.removeEventListener('click', onScroll, { capture: true })
    }
  }, [enabled, root])
  return covers
}

export function Chat() {
  const { pathname } = useLocation()
  const [open, setOpen] = useState(false)
  // Панель монтируется при первом открытии и дальше живёт: переписка не теряется между открытиями
  const [loaded, setLoaded] = useState(false)
  const gameInView = useSectionsInView(pathname, GAME)
  const coveredForBar = useSectionsInView(pathname, BAR_HIDDEN_OVER)
  const typing = useTyping()
  const sent = useSentApplication((s) => s.last)
  const pastHero = usePastHero(pathname)
  const menu = useOverlay((s) => s.menu)
  const setBar = useOverlay((s) => s.setBar)
  const desktop = useDesktop()
  const root = useRef<HTMLDivElement>(null)
  const launcher = useRef<HTMLButtonElement>(null)
  // Кто открыл чат — туда вернётся фокус после закрытия; и открыли ли его кнопкой с клавиатуры
  const opener = useRef<Element | null>(null)
  const byKeyboard = useRef(false)
  const fromLauncherRef = useRef(false)
  // Фокус с клавиатуры на кнопке: пока он там, кнопку не прячем, даже если под ней ссылка
  const [pinned, setPinned] = useState(false)
  // Фокус на полосе чата (телефон): пока он там, полосу не убираем
  const [barFocused, setBarFocused] = useState(false)

  // Чат — для кандидатов: в HR-панели и на страницах игр кнопка не нужна. В мини-приложении Telegram человек и так
  // в чате с ботом Квасыча, второй чат поверх игр лишний
  const hiddenHere = inTelegram || pathname.startsWith('/hr') || pathname.startsWith('/game') || pathname.startsWith('/play')
  const placed = !hiddenHere && !gameInView && pastHero && !menu
  // Компьютер: вкладка в правом поле страницы, прячется, если под ней ссылка или кнопка
  const covers = useCoversInteractive(root, desktop && placed && !open)
  const visible = placed && !open && (!covers || pinned)
  // Три вспышки точки — каждый раз, когда вкладка снова выезжает после первого экрана: точка перерисовывается заново
  const [placedRound, setPlacedRound] = useState(0)
  useEffect(() => {
    if (placed) setPlacedRound((n) => n + 1)
  }, [placed])
  // Телефон: полоса внизу экрана. Под неё у страницы оставлен отступ, поэтому она ничего не закрывает насовсем
  const bar = !desktop && !open && !hiddenHere && (barFocused || (placed && !coveredForBar && !typing))
  // Главное действие полосы — отклик; на анкетах и после отправки заявки остаётся только Квасыч
  const applyInBar = !sent && pathname !== '/apply' && pathname !== '/focus'
  useEffect(() => setBar(bar), [bar, setBar])

  const show = useCallback(() => {
    opener.current = document.activeElement
    // Полоса на телефоне на время чата убирается — запоминаем сразу, что открыли именно её
    fromLauncherRef.current = Boolean(launcher.current) && document.activeElement === launcher.current
    byKeyboard.current = document.activeElement === launcher.current && Boolean(launcher.current?.matches(':focus-visible'))
    setLoaded(true)
    setOpen(true)
  }, [])

  const close = useCallback(() => {
    setOpen(false)
    const prev = opener.current
    const fromLauncher = fromLauncherRef.current
    // Открыли вкладкой с клавиатуры или полосой на телефоне — фокус вернётся на неё, и она не спрячется, пока фокус на ней
    const keyboard = fromLauncher && (byKeyboard.current || !window.matchMedia('(min-width: 768px)').matches)
    if (keyboard) {
      setPinned(true)
      setBarFocused(true)
    }
    window.setTimeout(() => {
      // Открыли из меню или со страницы — фокус на тот элемент, если он ещё на месте; иначе — в начало содержимого
      const alive = prev instanceof HTMLElement && prev.isConnected && prev !== document.body && !prev.closest('[inert]')
      // Полоса на телефоне пока чат открыт убрана и появляется заново — берём новую кнопку, а не старую
      const back = keyboard ? launcher.current : !fromLauncher && alive ? (prev as HTMLElement) : document.getElementById('main')
      back?.focus({ preventScroll: true })
    }, 80)
  }, [])

  // Открыть чат может любая часть сайта: window.dispatchEvent(new Event('open-kvasych-chat'))
  useEffect(() => {
    window.addEventListener(OPEN_CHAT_EVENT, show)
    return () => window.removeEventListener(OPEN_CHAT_EVENT, show)
  }, [show])

  return (
    <>
      <aside aria-label="Чат с Квасычем">
      {/* Компьютер: место вкладки зарезервировано всегда (по нему проверяем, что под ней), сама вкладка выезжает и уезжает.
          Кнопка не снимается со страницы, пока уезжает: она сразу inert, поэтому уезжающую вкладку нельзя нажать или найти Tab */}
      {desktop && !hiddenHere && (
        <div ref={root} className="pointer-events-none fixed right-0 bottom-8 z-20 h-[156px] w-[112px]">
          <motion.button
            ref={launcher}
            type="button"
            onClick={show}
            onPointerEnter={() => void loadPanel()}
            onFocus={(e) => {
              void loadPanel()
              if (e.currentTarget.matches(':focus-visible')) setPinned(true)
            }}
            onBlur={() => setPinned(false)}
            inert={!visible}
            aria-haspopup="dialog"
            aria-label="Спросить Квасыча в чате про вакансии и заявку"
            initial={{ x: '130%' }}
            animate={{ x: visible ? 0 : '130%' }}
            transition={{ duration: 0.4, ease }}
            className="group pointer-events-auto absolute inset-0 block"
          >
            {/* Квасыч выглядывает из-за правого края экрана: поза «выглядывает» отражена, край картинки совпадает с краем окна */}
            <img
              src={PEEK}
              alt=""
              draggable={false}
              className="absolute right-[-14px] bottom-[34px] h-[120px] w-auto -scale-x-100"
            />
            <span className="absolute right-0 bottom-0 flex items-center gap-2 bg-night px-3 py-2 font-display text-[15px] leading-none font-extrabold tracking-[0.06em] text-white uppercase ring-1 ring-white/20 transition-colors ring-inset group-hover:bg-brand">
              <LiveDot key={placedRound} className="text-brand transition-colors group-hover:text-white" />
              Чат-бот
            </span>
          </motion.button>
        </div>
      )}

      {/* Телефон: полоса внизу экрана после первого экрана — «Откликнуться» под большим пальцем и Квасыч рядом */}
      <AnimatePresence>
        {bar && (
          <motion.div
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ duration: 0.35, ease }}
            className="fixed inset-x-0 bottom-0 z-20 flex border-t border-white/15 bg-night pb-[env(safe-area-inset-bottom)] text-white"
          >
            {applyInBar && (
              <Link
                to="/apply"
                className="flex min-w-0 flex-[2] items-center justify-center gap-3 bg-brand font-display text-[19px] font-extrabold tracking-[0.06em] uppercase active:bg-brand-deep"
                style={{ height: CHAT_BAR_HEIGHT }}
              >
                Откликнуться
                <span aria-hidden="true" className="block h-[2px] w-5 bg-current" />
              </Link>
            )}
            <button
              ref={launcher}
              type="button"
              onClick={show}
              onFocus={() => {
                void loadPanel()
                setBarFocused(true)
              }}
              onBlur={() => setBarFocused(false)}
              onTouchStart={() => void loadPanel()}
              aria-haspopup="dialog"
              aria-label="Спросить Квасыча"
              className="relative flex min-w-0 flex-1 items-center justify-center gap-2.5 font-display text-[18px] font-extrabold tracking-[0.06em] uppercase active:bg-coal"
              style={{ height: CHAT_BAR_HEIGHT }}
            >
              {/* Над полосой у правого края выглядывает Квасыч: видно, что за кнопкой живой собеседник */}
              <img src={PEEK} alt="" draggable={false} className="pointer-events-none absolute right-[-10px] bottom-full h-[78px] w-auto -scale-x-100" />
              <LiveDot className="text-brand" />
              {applyInBar ? 'Чат-бот' : 'Чат-бот Квасыч'}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      </aside>

      {loaded && (
        <Suspense fallback={null}>
          <ChatPanel open={open} onClose={close} />
        </Suspense>
      )}
    </>
  )
}

/** Поза «выглядывает» (public/mascot, фон убран scripts/mascot-cutout.py) */
const PEEK = '/mascot/kvasych-peek.webp'

/**
 * Точка «на связи» — мигает три раза при появлении и замирает: вечная анимация отвлекала бы от чтения и тратила кадры.
 * При «уменьшить движение» не мигает вовсе
 */
function LiveDot({ className = '' }: { className?: string }) {
  return (
    <span className={`relative flex size-2 shrink-0 ${className}`} aria-hidden="true">
      {/* Три вспышки: число повторов — строчным стилем, он сильнее записи animation у класса animate-ping */}
      <span className="absolute inline-flex size-full rounded-full bg-current opacity-60 motion-safe:animate-ping" style={{ animationIterationCount: 3 }} />
      <span className="relative inline-flex size-2 rounded-full bg-current" />
    </span>
  )
}
