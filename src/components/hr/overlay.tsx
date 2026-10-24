import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'

// Всплывающие слои панели: окно поверх страницы и выпадающая панель у кнопки

const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'

/** Внутри свёрнутого <details> (кроме его <summary>): фокус туда не встанет, хотя размеры у элемента есть */
const folded = (el: HTMLElement) => {
  const d = el.closest('details:not([open])')
  return Boolean(d) && !(el.tagName === 'SUMMARY' && el.parentElement === d)
}

/** Элементы, до которых доходит Tab: видимые, не выключенные и не в свёрнутом блоке */
export function tabbables(root: Element | null): HTMLElement[] {
  if (!root) return []
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (el) => !el.closest('[inert]') && !folded(el) && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden',
  )
}

/** Окна, открытые друг над другом: Tab держит только верхнее */
const trapStack: symbol[] = []

/**
 * Фокус внутри окна: Tab и Shift+Tab ходят по кругу по окну, за его пределы не выходят. withToasts — ещё и по
 * всплывающим сообщениям с «Отменить», если они видны поверх окна (карточка кандидата). После закрытия фокус
 * возвращается туда, откуда окно открыли. Esc закрывает только верхнее из открытых окон
 */
export function useFocusTrap(container: RefObject<HTMLElement | null>, active: boolean, onEscape?: () => void, withToasts = false) {
  // Свежий обработчик без перезапуска эффекта: иначе каждая перерисовка родителя уводила бы фокус из поля
  const escape = useRef(onEscape)
  escape.current = onEscape
  useEffect(() => {
    if (!active) return
    const me = Symbol('trap')
    trapStack.push(me)
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
    const onKey = (e: KeyboardEvent) => {
      if (trapStack.at(-1) !== me || !container.current) return
      // Esc закрывает только верхнее окно. Открытый системный список (select) Esc закрывает сам
      if (e.key === 'Escape' && escape.current && !e.defaultPrevented) {
        e.preventDefault()
        escape.current()
        return
      }
      if (e.key !== 'Tab') return
      const list = [...tabbables(container.current), ...(withToasts ? tabbables(document.querySelector('[data-hr-toasts]')) : [])]
      if (!list.length) {
        e.preventDefault()
        container.current.focus()
        return
      }
      const at = list.indexOf(document.activeElement as HTMLElement)
      // Фокус на самом окне или вне списка — следующий шаг всё равно внутри окна
      const next = at === -1 ? (e.shiftKey ? list.length - 1 : 0) : (at + (e.shiftKey ? -1 : 1) + list.length) % list.length
      e.preventDefault()
      list[next].focus()
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      trapStack.splice(trapStack.indexOf(me), 1)
      returnFocus(opener)
    }
  }, [active, container, withToasts])
}

/**
 * Фокус после закрытия окна — на кнопку, которая его открыла. Если её больше нет (строка ушла из отбора,
 * панель действий скрылась) или окно открылось само — на заголовок раздела, чтобы не потерять место на странице
 */
function returnFocus(opener: HTMLElement | null) {
  if (opener?.isConnected && opener.getClientRects().length > 0 && !opener.closest('[inert]')) {
    opener.focus({ preventScroll: true })
    return
  }
  const heading = document.querySelector<HTMLElement>('#hr-main h1')
  if (!heading) return
  if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1
  heading.focus({ preventScroll: true })
}

/** Окно поверх панели: на телефоне — снизу во всю ширину. Esc и клик мимо закрывают */
export function Dialog({ open, title, onClose, children, wide }: { open: boolean; title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const panel = useRef<HTMLDivElement>(null)
  useFocusTrap(panel, open, onClose)
  useEffect(() => {
    if (open) panel.current?.focus()
  }, [open])

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[80] flex items-end justify-center md:items-center">
          <motion.div className="absolute inset-0 bg-night/80" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} aria-hidden="true" />
          <motion.div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            tabIndex={-1}
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 24 }}
            transition={{ duration: 0.2 }}
            className={`relative max-h-[90dvh] w-full overflow-y-auto bg-coal p-5 text-white outline-none md:p-7 ${wide ? 'md:max-w-[720px]' : 'md:max-w-[520px]'}`}
          >
            <div className="flex items-start justify-between gap-4">
              <h2 className="font-display text-[30px] leading-none font-black uppercase">{title}</h2>
              <button onClick={onClose} className="-mt-1 -mr-2 grid size-10 place-items-center text-white/60 hover:text-white" aria-label="Закрыть">
                <svg viewBox="0 0 14 14" className="size-3.5" aria-hidden="true">
                  <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.8" />
                </svg>
              </button>
            </div>
            <div className="mt-5">{children}</div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}

/** Кнопка с выпадающей панелью: закрывается по Esc, клику мимо и уходу фокуса */
export function Popover({
  label,
  active,
  children,
  align = 'left',
  className = '',
}: {
  label: ReactNode
  active?: boolean
  children: ReactNode | ((close: () => void) => ReactNode)
  align?: 'left' | 'right'
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  const close = () => setOpen(false)

  return (
    <div ref={root} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`inline-flex h-9 items-center gap-1.5 border-b pr-1 text-[14px] whitespace-nowrap transition-colors ${
          active ? 'border-white font-medium text-white' : 'border-white/25 text-white/75 hover:text-white'
        }`}
      >
        {label}
        <svg viewBox="0 0 10 6" className={`h-1.5 w-2.5 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true">
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
      {open && (
        <div
          className={`absolute top-full z-50 mt-2 max-h-[min(70vh,640px)] min-w-[220px] overflow-y-auto overscroll-contain bg-white p-3 text-night shadow-[0_12px_40px_rgba(0,0,0,0.5)] ${align === 'right' ? 'right-0' : 'left-0'}`}
        >
          {typeof children === 'function' ? children(close) : children}
        </div>
      )}
    </div>
  )
}

/** Строка-флажок для выпадающих панелей на белом фоне */
export function CheckRow({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 px-1 py-1.5 text-[15px] hover:bg-night/5">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-4 accent-[var(--color-brand)]" />
      {children}
    </label>
  )
}
