import { AnimatePresence, motion } from 'motion/react'
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'

// Всплывающие сообщения панели. У действий с заявкой — кнопка «Отменить»:
// статус возвращается, а сообщение кандидату, если ещё не ушло, не отправляется.

export type ToastInput = {
  text: string
  detail?: string
  /** Строки истории, которые отменит кнопка «Отменить» */
  undo?: number[]
  tone?: 'info' | 'error'
  /** Сколько показывать, мс */
  ms?: number
  /** Своя отмена вместо строк истории: например, «Отделить» склеенные дубли. Ответ — текст ошибки или null */
  revert?: () => Promise<string | null>
}

type Toast = ToastInput & { id: number }

const ToastContext = createContext<(t: ToastInput) => void>(() => {})

export const useToast = () => useContext(ToastContext)

/** Сколько места снизу занято панелью, поверх которой сообщения показывать нельзя */
const ClearanceContext = createContext<(key: symbol, px: number) => void>(() => {})

/** Обычный отступ сообщений от низа экрана, px */
const TOAST_BOTTOM = 80

/**
 * Панель внизу экрана (полоса обзвона на телефоне, действия с выбранными) поднимает сообщения над собой:
 * иначе «Отменить» закрывало бы телефон следующего кандидата или кнопки панели. Скрытая панель места не занимает
 */
export function useToastClearance(ref: RefObject<HTMLElement | null>, active = true) {
  const set = useContext(ClearanceContext)
  useEffect(() => {
    const el = ref.current
    if (!active || !el) return
    const key = Symbol('clearance')
    const update = () => set(key, el.getClientRects().length ? Math.ceil(window.innerHeight - el.getBoundingClientRect().top) : 0)
    const observer = new ResizeObserver(update)
    observer.observe(el)
    window.addEventListener('resize', update)
    update()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
      set(key, 0)
    }
  }, [ref, active, set])
}

export function ToastProvider({ children, onUndo }: { children: ReactNode; onUndo: (historyIds: number[]) => Promise<string | null> }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const seq = useRef(0)

  const push = useCallback((t: ToastInput) => {
    const id = ++seq.current
    setToasts((list) => [...list.slice(-3), { ...t, id }])
  }, [])
  const close = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), [])
  const [clearance, setClearance] = useState<Map<symbol, number>>(() => new Map())
  const clear = useCallback(
    (key: symbol, px: number) =>
      setClearance((m) => {
        if ((m.get(key) ?? 0) === px) return m
        const next = new Map(m)
        if (px > 0) next.set(key, px)
        else next.delete(key)
        return next
      }),
    [],
  )
  const bottom = Math.max(TOAST_BOTTOM, ...[...clearance.values()].map((px) => px + 12))

  return (
    <ToastContext.Provider value={push}>
      <ClearanceContext.Provider value={clear}>{children}</ClearanceContext.Provider>
      {/* data-hr-toasts: карточка кандидата пускает Tab сюда, к «Отменить», — см. useFocusTrap */}
      <div
        data-hr-toasts
        aria-live="polite"
        style={{ bottom }}
        className="pointer-events-none fixed inset-x-3 z-[70] flex flex-col items-start gap-2 md:right-auto md:left-6 md:w-[420px]"
      >
        <AnimatePresence initial={false}>
          {toasts.map((t) => (
            <ToastItem key={t.id} toast={t} onClose={() => close(t.id)} onUndo={onUndo} push={push} />
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  )
}

function ToastItem({
  toast,
  onClose,
  onUndo,
  push,
}: {
  toast: Toast
  onClose: () => void
  onUndo: (ids: number[]) => Promise<string | null>
  push: (t: ToastInput) => void
}) {
  const [hover, setHover] = useState(false)
  const [busy, setBusy] = useState(false)
  const canUndo = Boolean(toast.undo?.length || toast.revert)
  const ms = toast.ms ?? (canUndo ? 12000 : 6000)

  useEffect(() => {
    if (hover || busy) return
    const timer = window.setTimeout(onClose, ms)
    return () => window.clearTimeout(timer)
  }, [hover, busy, ms, onClose])

  const undo = async () => {
    setBusy(true)
    const error = toast.revert ? await toast.revert() : await onUndo(toast.undo!)
    onClose()
    push(error ? { text: 'Не получилось отменить', detail: error, tone: 'error' } : { text: 'Отменено' })
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -24 }}
      transition={{ duration: 0.25 }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      role={toast.tone === 'error' ? 'alert' : 'status'}
      className={`pointer-events-auto flex w-full items-start gap-4 bg-white px-4 py-3 text-night shadow-[0_8px_30px_rgba(0,0,0,0.45)] ${
        toast.tone === 'error' ? 'border-l-4 border-brand' : ''
      }`}
    >
      <div className="min-w-0 flex-1">
        <p className="text-[15px] leading-snug font-medium">{toast.text}</p>
        {toast.detail && <p className="mt-0.5 text-[14px] leading-snug text-night/80">{toast.detail}</p>}
      </div>
      {canUndo ? (
        <button onClick={undo} disabled={busy} className="shrink-0 font-display text-[16px] font-extrabold tracking-[0.05em] text-brand uppercase hover:underline">
          Отменить
        </button>
      ) : null}
      <button onClick={onClose} aria-label="Закрыть" className="-mr-1 grid size-6 shrink-0 place-items-center text-night/40 hover:text-night">
        <svg viewBox="0 0 12 12" className="size-3" aria-hidden="true">
          <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      </button>
    </motion.div>
  )
}
