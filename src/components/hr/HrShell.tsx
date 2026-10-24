import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Link } from 'react-router'

/** Раздел панели. more — второстепенный: на ноутбуке он в меню «Ещё», на телефоне — в общей ленте разделов */
export type HrTab = { id: string; label: string; count?: number; more?: boolean }

type Props = {
  tabs?: HrTab[]
  active?: string
  onTab?: (id: string) => void
  user?: { name: string; role: 'hr' | 'admin' } | null
  onLogout?: () => void
  children: ReactNode
}

/** Закрыть всплывающее меню по Esc и клику мимо; фокус после Esc — на кнопку меню */
function useDismiss(open: boolean, close: () => void, root: RefObject<HTMLElement | null>, trigger: RefObject<HTMLButtonElement | null>) {
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && close()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      close()
      trigger.current?.focus()
    }
    const onFocus = (e: FocusEvent) => e.target instanceof Node && !root.current?.contains(e.target) && close()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    document.addEventListener('focusin', onFocus)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('focusin', onFocus)
    }
  }, [open, close, root, trigger])
}

const chevron = (open: boolean) => (
  <svg viewBox="0 0 10 6" className={`h-1.5 w-2.5 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true">
    <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
  </svg>
)

/**
 * Каркас панели HR: компактная шапка вместо сайта для кандидатов. На ноутбуке — основные разделы и «Ещё»
 * (фокус-группа, боты, рассылка, настройки), справа — меню учётной записи. На телефоне разделы листаются вбок:
 * открытый раздел всегда на виду, справа — затухание, пока есть что листать
 */
export function HrShell({ tabs = [], active, onTab, user, onLogout, children }: Props) {
  const main = tabs.filter((t) => !t.more)
  const more = tabs.filter((t) => t.more)
  const activeMore = more.find((t) => t.id === active)

  const tabButton = (t: HrTab, mobile: boolean) => (
    <button
      key={t.id}
      onClick={() => onTab?.(t.id)}
      aria-current={active === t.id ? 'page' : undefined}
      data-tab={t.id}
      className={`relative inline-flex shrink-0 items-center gap-1.5 font-display font-extrabold tracking-[0.05em] whitespace-nowrap uppercase transition-colors ${
        mobile ? 'h-11 text-[16px]' : 'h-14 text-[17px]'
      } ${active === t.id ? 'text-white' : 'text-white/60 hover:text-white'}`}
    >
      {t.label}
      {t.count ? <span className="rounded-full bg-brand px-1.5 font-sans text-[11px] leading-[18px] font-semibold tracking-normal text-white">{t.count}</span> : null}
      {active === t.id && <span className="absolute inset-x-0 bottom-0 h-[3px] bg-brand" aria-hidden="true" />}
    </button>
  )

  // Телефон: открытый раздел — в середину ленты; затухание справа — пока лента не долистана до конца
  const strip = useRef<HTMLElement>(null)
  const [atEnd, setAtEnd] = useState(true)
  const measure = () => {
    const el = strip.current
    if (el) setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 4)
  }
  useEffect(() => {
    const el = strip.current
    const tab = el?.querySelector<HTMLElement>(`[data-tab="${active}"]`)
    if (el && tab && el.scrollWidth > el.clientWidth) el.scrollTo({ left: Math.max(0, tab.offsetLeft - (el.clientWidth - tab.offsetWidth) / 2) })
    measure()
  }, [active, tabs.length])
  useEffect(() => {
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  return (
    <div className="min-h-dvh overflow-x-clip bg-night text-white [&_:focus-visible]:outline-2 [&_:focus-visible]:outline-offset-2 [&_:focus-visible]:outline-brand-bright">
      <a href="#hr-main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:bg-white focus:px-3 focus:py-2 focus:text-night">
        К содержимому
      </a>
      <header className="sticky top-0 z-40 border-b border-white/10 bg-night/95 backdrop-blur">
        <div className="flex h-14 items-center gap-8 px-4 md:px-6">
          <Link to="/hr" className="flex shrink-0 items-center" aria-label="Панель HR «Очаково»">
            <span className="font-display text-[20px] leading-none font-black tracking-[0.02em] uppercase">
              Очаково <span className="text-white/60">· HR</span>
            </span>
          </Link>
          {tabs.length > 0 && (
            <nav aria-label="Разделы панели" className="hidden min-w-0 items-center gap-6 xl:flex">
              {main.map((t) => tabButton(t, false))}
              {more.length > 0 && <MoreMenu tabs={more} active={activeMore} onTab={(id) => onTab?.(id)} />}
            </nav>
          )}
          {user && <AccountMenu user={user} onLogout={onLogout} />}
        </div>
        {tabs.length > 0 && (
          <div className="relative xl:hidden">
            <nav ref={strip} onScroll={measure} aria-label="Разделы панели" className="flex gap-5 overflow-x-auto px-4 [scrollbar-width:none] md:px-6">
              {tabs.map((t) => tabButton(t, true))}
              <span className="w-6 shrink-0" aria-hidden="true" />
            </nav>
            {!atEnd && <span className="pointer-events-none absolute inset-y-0 right-0 w-12 bg-gradient-to-l from-night" aria-hidden="true" />}
          </div>
        )}
      </header>
      <main id="hr-main" className="px-4 pt-5 pb-24 md:px-6">
        {children}
      </main>
    </div>
  )
}

/** «Ещё» на ноутбуке: второстепенные разделы. Открыт один из них — его название на кнопке и красная черта под ней */
function MoreMenu({ tabs, active, onTab }: { tabs: HrTab[]; active?: HrTab; onTab: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useDismiss(open, () => setOpen(false), root, trigger)
  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`relative inline-flex h-14 items-center gap-1.5 font-display text-[17px] font-extrabold tracking-[0.05em] whitespace-nowrap uppercase transition-colors ${
          active ? 'text-white' : 'text-white/60 hover:text-white'
        }`}
      >
        {active ? `Ещё: ${active.label}` : 'Ещё'}
        {chevron(open)}
        {active && <span className="absolute inset-x-0 bottom-0 h-[3px] bg-brand" aria-hidden="true" />}
      </button>
      {open && (
        <ul className="absolute top-full left-0 z-50 mt-px min-w-[220px] border border-white/15 bg-coal py-1.5 shadow-[0_12px_40px_rgba(0,0,0,0.6)]">
          {tabs.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => {
                  setOpen(false)
                  onTab(t.id)
                }}
                aria-current={active?.id === t.id ? 'page' : undefined}
                className={`flex w-full items-center gap-2 px-4 py-2.5 text-left font-display text-[17px] font-extrabold tracking-[0.05em] uppercase hover:bg-white/[0.06] ${
                  active?.id === t.id ? 'text-white shadow-[inset_3px_0_0_var(--color-brand)]' : 'text-white/75'
                }`}
              >
                {t.label}
                {t.count ? <span className="rounded-full bg-brand px-1.5 font-sans text-[11px] leading-[18px] font-semibold tracking-normal text-white">{t.count}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Учётная запись: имя на кнопке, роль и «Выйти» — в меню */
function AccountMenu({ user, onLogout }: { user: { name: string; role: 'hr' | 'admin' }; onLogout?: () => void }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useDismiss(open, () => setOpen(false), root, trigger)
  return (
    <div ref={root} className="relative ml-auto min-w-0">
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`Учётная запись: ${user.name}`}
        className="flex h-10 max-w-[44vw] min-w-0 items-center gap-2 text-[14px] text-white/75 hover:text-white xl:max-w-[240px]"
      >
        <span className="truncate">{user.name}</span>
        {chevron(open)}
      </button>
      {open && (
        <div className="absolute top-full right-0 z-50 mt-2 w-64 border border-white/15 bg-coal p-4 shadow-[0_12px_40px_rgba(0,0,0,0.6)]">
          <p className="text-[15px] break-words text-white">{user.name}</p>
          <p className="mt-0.5 text-[13px] text-white/60">{user.role === 'admin' ? 'Администратор панели' : 'Сотрудник отдела персонала'}</p>
          {onLogout && (
            <button type="button" onClick={onLogout} className="mt-3 inline-flex min-h-9 items-center text-[15px] text-white underline decoration-white/30 underline-offset-4 hover:decoration-white">
              Выйти
            </button>
          )}
        </div>
      )}
    </div>
  )
}
