import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Suspense, useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties, type MouseEvent, type Ref } from 'react'
import { Link, Outlet, useLocation } from 'react-router'
import { contacts } from '@shared/content/content'
import { formatRub, minMonthlyPay } from '@shared/content/vacancies'
import { ShiftBottle } from '../home/kit'
import { HEADER_OFFSET, SHIFT_HINT, tasks } from '../home/tasks'
import { scrollToTarget, scrollToTop, startSmoothScroll } from '../lib/motion'
import { analyticsIds, currentChoice, onAnalyticsChange, setAnalyticsChoice, startAnalytics, trackPage } from '../lib/analytics'
import { invitedBy } from '../lib/ref'
import { selectDoneCount, useActivities } from '../store/activities'
import { useProfile } from '../store/profile'
import { applicationNumber, useSentApplication } from './candidate/sent'
import { CHAT_BAR_HEIGHT, lockPage, openKvasychChat, useOverlay } from './chat/bus'
import { Chat } from './chat/Chat'
import { startTypographer } from '../lib/typo'
import { Loading } from './Loading'
import { Logo } from './Logo'

const nav = [
  { label: 'Зарплата', to: '/#money' },
  { label: 'Условия', to: '/#conditions' },
  { label: 'Поймай брак', to: '/#play' },
  { label: 'Вакансии', to: '/vacancies' },
  { label: 'Вопросы', to: '/#faq' },
]

const ease = [0.16, 1, 0.3, 1] as const

// Заголовок вкладки: у главной — тот же, что сервер ставит в homeMeta (server/app.ts), у остальных страниц — своё название.
// Из document.title его брать нельзя: при входе по ссылке на /vacancies там уже заголовок вакансий
const HOME_TITLE = `Работа на лето в «Очаково» — от ${formatRub(minMonthlyPay)} в месяц`
const SITE = 'Сезон в «Очаково»'
const titles: Record<string, string> = {
  '/vacancies': 'Вакансии',
  '/apply': 'Заявка',
  '/game': 'Поймай брак',
  '/focus': 'Анкета о слогане',
  '/consent': 'Согласие на обработку данных',
  '/privacy': 'Персональные данные',
  '/hr': 'Отдел персонала',
  '/hr/login': 'Вход для HR',
}

function useDocumentTitle(pathname: string) {
  useEffect(() => {
    const path = pathname.replace(/\/+$/, '') || '/'
    document.title = path === '/' ? HOME_TITLE : `${titles[path] ?? 'Страница не найдена'} — ${SITE}`
  }, [pathname])
}

/** Прокрутка к разделу главной. Фокус — туда же, чтобы с клавиатуры следующий Tab шёл по разделу, а не по шапке */
function jumpTo(selector: string) {
  // Фрагмент — не всегда якорь: ссылка на заявку #app=<номер>.<ключ> разбирается на странице заявки
  let el: HTMLElement | null = null
  try {
    el = document.querySelector<HTMLElement>(selector)
  } catch {
    return
  }
  if (!el) return
  scrollToTarget(el, HEADER_OFFSET)
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1')
  el.focus({ preventScroll: true })
}

/**
 * Ссылка на страницу или раздел главной. Это настоящая ссылка (открывается в новой вкладке, видна как ссылка),
 * но на самой главной не перезагружает маршрут, а плавно прокручивает к разделу
 */
function AnchorLink({ to, onGo, ...rest }: Omit<ComponentProps<typeof Link>, 'to' | 'onClick'> & { to: string; onGo?: () => void }) {
  const { pathname } = useLocation()
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    onGo?.()
    const [path, hash] = to.split('#')
    const plain = e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey
    if (!plain || !hash || (path || '/') !== pathname) return
    e.preventDefault()
    // Меню закрывается в этот же момент — снимаем блокировку прокрутки сразу, иначе прокрутка не начнётся
    lockPage(false)
    jumpTo(`#${hash}`)
  }
  return <Link to={to} onClick={onClick} {...rest} />
}

/**
 * Новая страница: фокус — на её заголовок, скринридер вежливо объявляет название.
 * Без этого после перехода фокус остаётся на исчезнувшей ссылке и с клавиатуры приходится начинать сначала
 */
function useRouteFocus(pathname: string, hash: string) {
  const [announce, setAnnounce] = useState('')
  const firstLoad = useRef(true)
  useEffect(() => {
    if (firstLoad.current) {
      firstLoad.current = false
      return
    }
    // Переход к разделу главной — фокус ставит jumpTo
    if (hash) return
    let frame = 0
    let tries = 0
    // Страницы грузятся отдельными чанками — ждём, пока появится заголовок
    const focusHeading = () => {
      const h = document.querySelector<HTMLElement>('#main h1')
      if (!h) {
        if (tries++ < 240) frame = requestAnimationFrame(focusHeading)
        return
      }
      if (!h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1')
      h.focus({ preventScroll: true })
      setAnnounce(document.title)
    }
    frame = requestAnimationFrame(focusHeading)
    return () => cancelAnimationFrame(frame)
  }, [pathname, hash])
  return announce
}

export function Layout() {
  const { pathname, hash, search } = useLocation()
  const menu = useOverlay((s) => s.menu)
  useDocumentTitle(pathname)
  const announce = useRouteFocus(pathname, hash)
  // Внизу экрана на телефоне — полоса чата; у подвала под неё оставлен отступ
  const chatBar = !pathname.startsWith('/hr') && !pathname.startsWith('/game')

  useEffect(() => startSmoothScroll(), [])
  // Счётчики — только при ID от сервера и согласии в плашке; первый просмотр отправляет сам запуск, дальше — каждый переход
  const firstView = useRef(true)
  useEffect(() => {
    if (firstView.current) {
      firstView.current = false
      startAnalytics()
      return
    }
    trackPage(pathname + search)
  }, [pathname, search])
  // Типограф: неразрывные пробелы во всём тексте сайта, включая ответы бота и тексты из данных
  useEffect(() => startTypographer(), [])
  useEffect(() => {
    if (!hash) return scrollToTop()
    const id = window.setTimeout(() => jumpTo(hash), 150)
    return () => window.clearTimeout(id)
  }, [pathname, hash])

  const skip = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault()
    const main = document.getElementById('main')
    main?.focus({ preventScroll: true })
    main?.scrollIntoView()
  }

  return (
    <div className="flex min-h-dvh flex-col">
      {!menu && (
        <a
          href="#main"
          onClick={skip}
          className="sr-only z-[70] bg-white px-5 py-3 font-display text-[18px] font-extrabold tracking-[0.05em] text-ink uppercase focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
        >
          К содержанию
        </a>
      )}
      <Header />
      {/* Пока открыто меню, страница под ним недоступна ни мышью, ни с клавиатуры, ни для скринридера */}
      <main id="main" tabIndex={-1} inert={menu} className="flex-1 outline-none">
        <Suspense fallback={<Loading />}>
          <Outlet />
        </Suspense>
      </main>
      <Footer inert={menu} chatBar={chatBar} />
      <Chat />
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
    </div>
  )
}

/** Счётчик смены: четыре бутылки и «N/4». По нажатию — объяснение и список заданий */
function ShiftProgress({ open, onToggle, ref }: { open: boolean; onToggle: () => void; ref?: Ref<HTMLButtonElement> }) {
  const done = useActivities((s) => s.done)
  const count = useActivities(selectDoneCount)
  const closed = count === tasks.length

  return (
    <button
      ref={ref}
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={open ? 'shift-info' : undefined}
      aria-label={closed ? 'Смена закрыта, 4 из 4. Что это' : `Смена ${count} из 4. Что это`}
      className="group flex h-11 shrink-0 items-center gap-2 text-white sm:gap-3"
    >
      {/* Совсем узкий экран (320) — только «0/4»; 360–379 — только бутылки; шире — всё */}
      <span className="flex gap-[3px] max-[359px]:hidden">
        {tasks.map((t) => (
          <ShiftBottle key={t.id} full={!!done[t.id]} className="h-5 w-auto sm:h-6 md:h-7" />
        ))}
      </span>
      <span className="font-display text-[17px] leading-none font-bold tracking-[0.06em] whitespace-nowrap uppercase min-[360px]:max-[379px]:hidden">
        <span className={closed ? 'text-brand-bright' : ''}>
          <span className="hidden sm:inline">Смена </span>
          {count}/4
        </span>
      </span>
    </button>
  )
}

/** Что такое «Смена» — открывается по нажатию на счётчик, Esc и щелчок мимо закрывают */
function ShiftInfo({ notch, onClose, ref }: { notch: number; onClose: (refocus: boolean) => void; ref?: Ref<HTMLDivElement> }) {
  const done = useActivities((s) => s.done)
  const count = useActivities(selectDoneCount)
  return (
    <motion.div
      ref={ref}
      id="shift-info"
      role="dialog"
      aria-label="Смена: 4 задания на главной"
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.25, ease }}
      className="absolute top-[calc(100%-4px)] right-5 w-[min(340px,calc(100vw-40px))] bg-paper px-4 pt-3.5 pb-2 text-ink shadow-[0_18px_40px_-16px_rgba(0,0,0,0.6)] md:right-10"
    >
      <span className="absolute -top-1.5 size-3 rotate-45 bg-paper" style={{ right: Math.max(10, notch - 6) }} aria-hidden="true" />
      <p className="text-[15px] leading-snug">
        <span className="font-semibold">{count === tasks.length ? 'Смена закрыта, отметка будет в заявке.' : 'Смена состоит из 4 заданий на главной.'}</span> {SHIFT_HINT}.
      </p>
      <ul className="mt-2">
        {tasks.map((t) => (
          <li key={t.id} className="border-t border-ink/10 first:border-t-0">
            <AnchorLink to={`/${t.anchor}`} onGo={() => onClose(false)} className="flex min-h-11 items-center gap-3 text-[15px] hover:text-brand">
              <ShiftBottle full={!!done[t.id]} className="h-5 w-auto" />
              <span className="flex-1">{t.label}</span>
              <span className="text-[13px] text-mute">{done[t.id] ? 'пройдено' : 'не пройдено'}</span>
            </AnchorLink>
          </li>
        ))}
      </ul>
    </motion.div>
  )
}

function Header() {
  const [hidden, setHidden] = useState(false)
  const menu = useOverlay((s) => s.menu)
  const setMenu = useOverlay((s) => s.setMenu)
  const setToastShown = useOverlay((s) => s.setToast)
  const chatBarShown = useOverlay((s) => s.bar)
  const { pathname } = useLocation()
  const count = useActivities(selectDoneCount)
  const [toast, setToast] = useState<number | null>(null)
  const prevCount = useRef(count)
  const [info, setInfo] = useState(false)
  const info_ = useRef<HTMLDivElement>(null)
  const menuButton = useRef<HTMLButtonElement>(null)
  const counter = useRef<HTMLButtonElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const [notch, setNotch] = useState(0)
  const sent = useSentApplication((s) => s.last)

  // Выполнено задание — короткое сообщение внизу экрана
  useEffect(() => {
    if (count > prevCount.current) {
      setToast(count)
      const id = window.setTimeout(() => setToast(null), 2200)
      prevCount.current = count
      return () => window.clearTimeout(id)
    }
    prevCount.current = count
  }, [count])
  useEffect(() => setToastShown(toast !== null && !menu), [toast, menu, setToastShown])

  useEffect(() => {
    let last = window.scrollY
    const onScroll = () => {
      const y = window.scrollY
      if (y > 200 && y > last + 4) setHidden(true)
      else if (y < last - 4 || y <= 200) setHidden(false)
      last = y
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // Меню закрывается при любом переходе
  useEffect(() => setMenu(false), [pathname, setMenu])

  useEffect(() => {
    if (!menu) return
    lockPage(true)
    // Esc закрывает меню и возвращает фокус на кнопку
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setMenu(false)
      menuButton.current?.focus()
    }
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('keydown', onEsc)
      lockPage(false)
    }
  }, [menu, setMenu])

  // Объяснение смены: фокус — на первое задание, Esc возвращает фокус на счётчик, щелчок мимо или уход фокуса — закрывают
  const closeInfo = (refocus: boolean) => {
    setInfo(false)
    if (refocus) counter.current?.focus()
  }
  useEffect(() => {
    if (!info) return
    const focus = window.setTimeout(() => info_.current?.querySelector<HTMLElement>('a')?.focus({ preventScroll: true }), 40)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeInfo(true)
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (!info_.current?.contains(t) && !counter.current?.contains(t)) closeInfo(false)
    }
    const onFocus = (e: FocusEvent) => {
      const t = e.target as Node
      if (!info_.current?.contains(t) && !counter.current?.contains(t)) setInfo(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('focusin', onFocus)
    return () => {
      window.clearTimeout(focus)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('focusin', onFocus)
    }
  }, [info])
  useEffect(() => setInfo(false), [pathname, menu])

  // Хвостик карточки смотрит на счётчик смены, где бы он ни оказался при этой ширине экрана
  useLayoutEffect(() => {
    if (!info) return
    const measure = () => {
      const c = counter.current?.getBoundingClientRect()
      const b = bar.current
      if (!c || !b) return
      const padRight = parseFloat(getComputedStyle(b).paddingRight)
      setNotch(b.getBoundingClientRect().right - padRight - (c.left + c.width / 2))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [info])

  const closeMenu = () => setMenu(false)
  const show = !hidden || menu || info

  return (
    <>
      <header
        className={`fixed top-0 right-[var(--lock-gap,0px)] left-0 z-40 text-white transition-[translate,background-color] duration-500 ease-out-expo ${
          show ? 'translate-y-0' : '-translate-y-full'
        } ${menu ? 'bg-transparent' : 'bg-night/85 backdrop-blur-md'}`}
      >
        <div ref={bar} className="container-x relative flex h-[72px] items-center justify-between gap-2 min-[360px]:gap-3 sm:gap-5">
          <Link to="/" onClick={closeMenu} aria-label="Очаково, на главную" className="flex h-11 shrink-0 items-center">
            <Logo variant="line" className="h-auto w-[92px] min-[380px]:w-[104px] sm:w-[132px] md:w-[160px]" />
          </Link>

          <nav aria-label="Разделы" className="hidden items-center gap-7 xl:flex">
            {nav.map((item) => (
              <AnchorLink
                key={item.to}
                to={item.to}
                aria-current={item.to === pathname ? 'page' : undefined}
                className="relative flex h-11 items-center text-[15px] text-white/75 transition-colors hover:text-white aria-[current=page]:text-white after:absolute after:bottom-2 after:left-0 after:h-px after:w-full after:origin-right after:scale-x-0 after:bg-current after:transition-transform after:duration-300 hover:after:origin-left hover:after:scale-x-100"
              >
                {item.label}
              </AnchorLink>
            ))}
          </nav>

          <div className="flex items-center gap-1.5 sm:gap-3 md:gap-6">
            <ShiftProgress ref={counter} open={info} onToggle={() => setInfo((o) => !o)} />
            {/* Обе подписи лежат в одной клетке, видна одна: ширина кнопки не меняется после отправки, меню не сдвигается */}
            <Link
              to="/apply"
              onClick={closeMenu}
              aria-label={sent ? `Моя заявка, номер ${applicationNumber(sent.id)}: отправлена` : undefined}
              className={`inline-grid h-11 shrink-0 place-items-center px-2 font-display text-[14px] font-extrabold min-[360px]:px-2.5 min-[360px]:text-[15px] tracking-[0.05em] uppercase transition-colors sm:px-3 sm:text-[16px] md:px-5 md:text-[18px] [&>span]:col-start-1 [&>span]:row-start-1 ${
                sent ? 'ring-1 ring-white/40 ring-inset hover:bg-white hover:text-ink' : 'bg-brand hover:bg-white hover:text-brand'
              }`}
            >
              <span className={sent ? 'invisible' : ''} aria-hidden={sent ? true : undefined}>
                Откликнуться
              </span>
              <span className={sent ? '' : 'invisible'} aria-hidden={sent ? undefined : true}>
                Моя заявка
              </span>
            </Link>
            <button
              ref={menuButton}
              type="button"
              onClick={() => setMenu(!menu)}
              aria-controls={menu ? 'mobile-menu' : undefined}
              data-burger
              className="relative -mr-2 grid size-11 shrink-0 place-items-center xl:hidden"
              aria-label={menu ? 'Закрыть меню' : 'Открыть меню'}
              aria-expanded={menu}
            >
              <span className={`absolute h-[2px] w-6 bg-current transition-transform duration-300 ${menu ? 'rotate-45' : '-translate-y-[4px]'}`} />
              <span className={`absolute h-[2px] w-6 bg-current transition-transform duration-300 ${menu ? '-rotate-45' : 'translate-y-[4px]'}`} />
            </button>
          </div>

          <AnimatePresence>{info && !menu && <ShiftInfo ref={info_} notch={notch} onClose={closeInfo} />}</AnimatePresence>
        </div>
        <InviteLine hidden={menu} />
      </header>

      <AnimatePresence>{menu && <MobileMenu onGo={closeMenu} />}</AnimatePresence>

      {/* Задание выполнено. Телефон — внизу, над полосой чата; компьютер — справа под шапкой, где нет кнопок разделов */}
      <AnimatePresence>
        {toast !== null && !menu && (
          <motion.div
            initial={{ y: 12, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 12, opacity: 0 }}
            transition={{ duration: 0.35, ease }}
            role="status"
            style={{ '--toast-bottom': chatBarShown ? `calc(${CHAT_BAR_HEIGHT + 12}px + env(safe-area-inset-bottom))` : 'max(16px, env(safe-area-inset-bottom))' } as CSSProperties}
            className="pointer-events-none fixed inset-x-0 bottom-(--toast-bottom) z-50 flex justify-center px-4 md:inset-x-auto md:top-[88px] md:right-10 md:bottom-auto md:px-0"
          >
            <p className="flex items-center gap-3 bg-ink px-4 py-2.5 font-display text-[17px] font-bold tracking-[0.05em] text-white uppercase shadow-[0_10px_30px_rgba(0,0,0,0.35)]">
              <span className="flex gap-[3px]">
                {tasks.map((t, i) => (
                  <ShiftBottle key={t.id} full={i < toast} className="h-5 w-auto" />
                ))}
              </span>
              {toast === tasks.length ? 'Смена закрыта · 4/4' : `Задание выполнено · ${toast}/4`}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}

const INVITE_HIDDEN_KEY = 'ochakovo.invite.hidden'
/** Высота строки приглашения: страницы сайта добавляют её к отступу сверху через --invite-h */
const INVITE_LINE_HEIGHT = 40

/**
 * Пришли по ссылке друга (метка friend-<код>, не своя) — под шапкой одна строка «Тебя позвали…», пока нет своей заявки.
 * «Скрыть» убирает её до конца визита. Строка едет вместе с шапкой; пока она видна, на корне страницы стоит
 * --invite-h, и страницы с отступом pt-[calc(72px+var(--invite-h,0px))] не уходят под неё. На странице игры строки нет
 */
function InviteLine({ hidden: menuOpen }: { hidden: boolean }) {
  const source = useProfile((s) => s.source)
  const sent = useSentApplication((s) => s.last)
  const { pathname } = useLocation()
  const [closed, setClosed] = useState(() => {
    try {
      return sessionStorage.getItem(INVITE_HIDDEN_KEY) === '1'
    } catch {
      return false
    }
  })
  const visible = !closed && !sent && !pathname.startsWith('/game') && Boolean(invitedBy(source))
  useLayoutEffect(() => {
    if (!visible) return
    const root = document.documentElement
    root.style.setProperty('--invite-h', `${INVITE_LINE_HEIGHT}px`)
    return () => {
      root.style.removeProperty('--invite-h')
    }
  }, [visible])
  if (!visible) return null
  const hide = () => {
    setClosed(true)
    try {
      sessionStorage.setItem(INVITE_HIDDEN_KEY, '1')
    } catch {
      // без хранилища строка вернётся после перезагрузки
    }
  }
  return (
    <div className={`border-t border-white/10 bg-coal ${menuOpen ? 'invisible' : ''}`}>
      <div className="container-x flex items-center justify-between gap-4 text-[14px] md:text-[15px]" style={{ height: INVITE_LINE_HEIGHT }}>
        {/* На телефоне — только первая фраза без «на практику»: строка одна и не обрезается */}
        <p className="min-w-0 truncate">
          <span className="font-semibold text-brand-bright">
            Тебя позвали<span className="hidden md:inline"> на практику</span> в «Очаково».
          </span>
          <span className="hidden text-white/80 md:inline">
            {pathname === '/apply' ? ' В заявке уже отмечено «Иду с другом».' : ' Отправь свою заявку, отметка «Иду с другом» в ней уже стоит.'}
          </span>
        </p>
        <button type="button" onClick={hide} className="-mr-2 inline-flex h-10 shrink-0 items-center px-2 text-white/70 underline decoration-white/30 underline-offset-4 hover:text-white">
          Скрыть
        </button>
      </div>
    </div>
  )
}

function MobileMenu({ onGo }: { onGo: () => void }) {
  const done = useActivities((s) => s.done)
  const sent = useSentApplication((s) => s.last)
  const { pathname } = useLocation()
  const first = useRef<HTMLAnchorElement>(null)
  // Меньше движения — меню появляется сразу, без «шторки» и выезда пунктов
  const still = useReducedMotion()
  useEffect(() => {
    const id = window.setTimeout(() => first.current?.focus({ preventScroll: true }), still ? 0 : 200)
    return () => window.clearTimeout(id)
  }, [])
  return (
    <motion.div
      id="mobile-menu"
      role="dialog"
      aria-label="Меню"
      initial={still ? false : { clipPath: 'inset(0 0 100% 0)' }}
      animate={{ clipPath: 'inset(0 0 0% 0)' }}
      exit={still ? undefined : { clipPath: 'inset(0 0 100% 0)' }}
      transition={{ duration: still ? 0 : 0.6, ease }}
      data-lenis-prevent
      className="fixed inset-0 z-30 flex flex-col overflow-y-auto overscroll-contain bg-night pt-[72px] text-white xl:hidden"
    >
      <nav aria-label="Разделы" className="container-x flex flex-col items-start pt-6">
        {nav.map((item, i) => (
          <motion.div
            key={item.to}
            initial={still ? false : { y: 40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.12 + i * 0.05, duration: 0.6, ease }}
          >
            <AnchorLink
              ref={i === 0 ? first : undefined}
              to={item.to}
              onGo={onGo}
              aria-current={item.to === pathname ? 'page' : undefined}
              className="display block py-1 text-[clamp(52px,14vw,96px)] transition-colors hover:text-brand aria-[current=page]:text-brand-bright"
            >
              {item.label}
            </AnchorLink>
          </motion.div>
        ))}
      </nav>

      <div className="container-x mt-10">
        <p className="font-display text-[17px] font-bold tracking-[0.08em] text-white/60 uppercase">Смена · 4 задания</p>
        <ul className="mt-3 border-t border-white/15">
          {tasks.map((a) => (
            <li key={a.id} className="border-b border-white/15">
              <AnchorLink to={`/${a.anchor}`} onGo={onGo} className="flex min-h-14 w-full items-center gap-4 py-3 text-left text-lg">
                <ShiftBottle full={!!done[a.id]} className="h-7 w-auto" />
                <span className="flex-1">{a.label}</span>
                <span className="text-[15px] text-white/60">{done[a.id] ? 'пройдено' : 'не пройдено'}</span>
              </AnchorLink>
            </li>
          ))}
        </ul>
      </div>

      {/* Действия прилипают к низу меню: на коротком экране «Спросить Квасыча» не уезжает за край */}
      <div className="sticky bottom-0 mt-auto border-t border-white/15 bg-night pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="container-x grid grid-cols-2 gap-2">
          {sent ? (
            <Link
              to="/apply"
              onClick={onGo}
              className="flex h-14 items-center justify-center px-2 text-center font-display text-[20px] leading-none font-extrabold tracking-[0.05em] uppercase ring-1 ring-white/40 ring-inset"
            >
              Моя заявка
            </Link>
          ) : (
            <Link
              to="/apply"
              onClick={onGo}
              className="flex h-14 items-center justify-center bg-brand px-2 font-display text-[20px] font-extrabold tracking-[0.05em] uppercase"
            >
              Откликнуться
            </Link>
          )}
          <button
            type="button"
            onClick={() => {
              onGo()
              openKvasychChat()
            }}
            className="flex h-14 items-center justify-center px-2 text-center font-display text-[20px] leading-none font-extrabold tracking-[0.05em] uppercase ring-1 ring-white/35 ring-inset hover:bg-white hover:text-ink"
          >
            Спросить Квасыча
          </button>
        </div>
        <a href={`mailto:${contacts.email}`} className="container-x mt-1 flex min-h-11 items-center justify-center text-white/70">
          {contacts.email}
        </a>
      </div>
    </motion.div>
  )
}

const footerLink = 'inline-flex min-h-11 w-fit items-center transition-colors hover:text-white'

/**
 * Выбор про счётчики: плашка «Разрешить / Не надо» в подвале, пока человек не выбрал, потом — строка-переключатель.
 * Без ID счётчиков от сервера нет ни плашки, ни строки
 */
function useAnalyticsChoice() {
  const [ids] = useState(analyticsIds)
  const [choice, setChoice] = useState(currentChoice)
  useEffect(() => onAnalyticsChange(() => setChoice(currentChoice())), [])
  return { ids, choice }
}

function AnalyticsBar() {
  const { ids, choice } = useAnalyticsChoice()
  if (!ids || choice) return null
  const names = [ids.metrika && 'Яндекс Метрика', ids.vk && 'пиксель VK Рекламы'].filter(Boolean).join(' и ')
  return (
    <div role="region" aria-label="Счётчики посещений" className="border-t border-white/10 bg-coal">
      <div className="container-x flex flex-col gap-4 py-5 md:flex-row md:items-center md:justify-between md:gap-10">
        <p className="max-w-2xl text-[15px] leading-snug text-white/80">
          {`${names[0].toUpperCase()}${names.slice(1)} считают посещения и шаги на сайте без имени, телефона и номера заявки. Включить?`}{' '}
          <Link to="/privacy" className="whitespace-nowrap text-white underline decoration-white/35 underline-offset-4 hover:decoration-white">
            Подробнее
          </Link>
        </p>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => setAnalyticsChoice('yes')}
            className="inline-flex min-h-11 items-center bg-white px-4 font-display text-[17px] font-extrabold tracking-[0.04em] text-ink uppercase transition-colors hover:bg-brand hover:text-white"
          >
            Разрешить
          </button>
          <button
            type="button"
            onClick={() => setAnalyticsChoice('no')}
            className="inline-flex min-h-11 items-center px-4 font-display text-[17px] font-extrabold tracking-[0.04em] uppercase ring-1 ring-white/40 ring-inset transition-colors hover:bg-white hover:text-ink"
          >
            Не надо
          </button>
        </div>
      </div>
    </div>
  )
}

/** Строка в подвале после выбора: можно передумать */
function AnalyticsToggle() {
  const { ids, choice } = useAnalyticsChoice()
  if (!ids || !choice) return null
  return (
    <button type="button" onClick={() => setAnalyticsChoice(choice === 'yes' ? 'no' : 'yes')} className={`${footerLink} text-left`}>
      {choice === 'yes' ? 'Выключить счётчики' : 'Включить счётчики'}
    </button>
  )
}

function Footer({ inert, chatBar }: { inert: boolean; chatBar: boolean }) {
  return (
    <footer inert={inert} className="bg-night text-white">
      <AnalyticsBar />
      <div className="container-x grid gap-12 border-t border-white/10 pt-16 pb-12 md:grid-cols-[1.4fr_1fr_1fr] md:pt-20">
        <div>
          <Logo variant="block" title="Очаково. Натуральные напитки" className="h-16 w-auto" />
          <p className="mt-6 max-w-sm text-white/70">
            {contacts.address}. {contacts.routeShort}.
          </p>
        </div>
        <nav aria-label="Кандидатам" className="flex flex-col text-white/75">
          <p className="mb-2 font-display text-[15px] font-bold tracking-[0.1em] text-white/60 uppercase">Кандидатам</p>
          {nav.map((item) => (
            <AnchorLink key={item.to} to={item.to} className={footerLink}>
              {item.label}
            </AnchorLink>
          ))}
        </nav>
        <div className="flex flex-col text-white/75">
          <p className="mb-2 font-display text-[15px] font-bold tracking-[0.1em] text-white/60 uppercase">Отдел персонала</p>
          <a href={`mailto:${contacts.email}`} className={footerLink}>
            {contacts.email}
          </a>
          <a href={`tel:${contacts.phone.replace(/[^+\d]/g, '')}`} className={`${footerLink} flex-col items-start! justify-center py-1.5`}>
            {contacts.phone}
            <span className="block text-sm text-white/60">{contacts.phoneNote}</span>
          </a>
          <a href={`https://wa.me/${contacts.whatsapp}`} target="_blank" rel="noreferrer" className={footerLink}>
            WhatsApp
          </a>
        </div>
      </div>
      <div
        className={`container-x flex flex-col gap-2 border-t border-white/10 py-4 text-[13px] text-white/60 md:flex-row md:items-center md:justify-between ${
          chatBar ? 'max-md:pb-[calc(var(--chat-bar)+16px+env(safe-area-inset-bottom))]' : ''
        }`}
        style={{ '--chat-bar': `${CHAT_BAR_HEIGHT}px` } as CSSProperties}
      >
        {/* Неразрывные пробелы расставлены вручную: «АО МПБК» и «компании · фото» не разрываются, типограф эту строку не трогает */}
        <p className="py-2" data-no-typo>
          {'Решение команды на кейс «Открой#Моспром» для АО\u00A0МПБК «Очаково». Неофициальный сайт компании\u00A0· фото с\u00A0ochakovo.ru'}
        </p>
        <div className="flex flex-wrap gap-x-6">
          <Link to="/privacy" className={footerLink}>
            Политика обработки данных
          </Link>
          <Link to="/consent" className={footerLink}>
            Согласие
          </Link>
          <Link to="/hr" className={footerLink}>
            Для HR
          </Link>
          <AnalyticsToggle />
        </div>
      </div>
    </footer>
  )
}
