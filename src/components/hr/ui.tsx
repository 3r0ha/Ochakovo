import type { ComponentProps, ReactNode } from 'react'
import { applicationStatuses, type ApplicationStatus } from '@shared/applications'

// Общие детали HR-панели: кнопки, поля, значок и переключатель статуса, пустые состояния

const focusRing = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white'

/**
 * Выключенная кнопка во всей панели выглядит одинаково: прозрачная, тонкая рамка, приглушённый текст.
 * Почему выключена — подписью рядом (DisabledHint), а не догадкой по цвету
 */
const off = 'disabled:pointer-events-none disabled:bg-transparent disabled:text-white/40 disabled:ring-1 disabled:ring-white/15 disabled:ring-inset'

const btnBase = `inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap px-5 font-display text-[17px] font-extrabold tracking-[0.05em] uppercase transition-colors duration-200 ${focusRing} ${off}`
const smallBase = `inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap px-3 font-display text-[15px] font-extrabold tracking-[0.05em] uppercase transition-colors duration-200 ${focusRing} ${off}`

/**
 * Кнопки панели. Красная — одно главное действие на экране, остальные — контурные.
 * small — основа маленькой кнопки без цвета; text — действие в строке списка: подчёркнутый текст без рамки
 */
export const hrBtn = {
  red: `${btnBase} bg-brand text-white hover:bg-brand-deep`,
  ghost: `${btnBase} text-white ring-1 ring-white/35 ring-inset hover:ring-white`,
  small: smallBase,
  smallRed: `${smallBase} bg-brand text-white hover:bg-brand-deep`,
  smallGhost: `${smallBase} text-white ring-1 ring-white/30 ring-inset hover:ring-white`,
  text: `inline-flex min-h-8 items-center text-[14px] text-white/80 underline decoration-white/30 underline-offset-4 transition-colors hover:text-white hover:decoration-white ${focusRing} disabled:pointer-events-none disabled:text-white/40 disabled:no-underline`,
}

/**
 * Переключатель-чип: выбранный — лёгкая заливка, рамка и красная черта снизу; так он не похож на главную кнопку.
 * Невыбранный — тонкая рамка. alert — красный: просрочка или сигнал. plain — обычный шрифт без капса: метки, статусы, коды
 */
export const chip = (active: boolean, opts: { alert?: boolean; plain?: boolean; compact?: boolean } = {}) =>
  `${opts.compact ? compactChip : opts.plain ? plainChip : smallBase} ring-1 ring-inset ${
    active
      ? 'bg-white/[0.12] text-white ring-white/60 shadow-[inset_0_-3px_0_var(--color-brand-bright)]'
      : opts.alert
        ? 'text-brand-bright ring-brand/60 hover:bg-brand/[0.08] hover:ring-brand-bright'
        : 'text-white ring-white/25 hover:bg-white/[0.05] hover:ring-white/60'
  }`
const plainChip = `inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap px-3 text-[15px] transition-colors duration-200 ${focusRing} ${off}`
/** Плотный чип: виды над списком заявок — десять штук помещаются в строку на ноутбуке */
const compactChip = `inline-flex h-9 items-center justify-center gap-1 whitespace-nowrap px-2.5 text-[14px] font-medium transition-colors duration-200 ${focusRing} ${off}`

/**
 * Статусы различаются не только словом: у каждого свой цвет и форма точки. Пустой кружок — с кандидатом ещё не говорили,
 * заливка — шаг сделан. Палитра — фирменная: белый, сиреневый, голубой, шалфей, зелёный, красный и серые
 */
export const statusDot: Record<ApplicationStatus, string> = {
  new: 'ring-2 ring-current ring-inset',
  contacted: 'bg-lilac',
  no_answer: 'ring-2 ring-smoke ring-inset',
  interview: 'bg-periwinkle',
  hired: 'bg-sage',
  started: 'bg-leaf ring-2 ring-sage ring-inset',
  declined: 'bg-brand-bright',
}

/** Значок статуса в строке списка и в шапке карточки: цвет текста, заливка и рамка. Контраст текста — от 5:1 */
export const statusPill: Record<ApplicationStatus, string> = {
  new: 'bg-white/[0.08] text-white ring-1 ring-white/50 ring-inset',
  contacted: 'bg-lilac/[0.1] text-lilac ring-1 ring-lilac/35 ring-inset',
  no_answer: 'text-white/75 border border-dashed border-white/35',
  interview: 'bg-periwinkle/[0.12] text-periwinkle ring-1 ring-periwinkle/40 ring-inset',
  hired: 'text-sage ring-1 ring-sage/50 ring-inset',
  started: 'bg-leaf/40 text-white ring-1 ring-leaf ring-inset',
  declined: 'bg-brand/[0.14] text-brand-bright ring-1 ring-brand/50 ring-inset',
}

export const statusMeta = (s: ApplicationStatus | undefined) => applicationStatuses.find((x) => x.id === (s ?? 'new'))!

/** Точка и слово статуса; цвет слова — от родителя (на белом во всплывающей панели — тёмный) */
export function StatusBadge({ status, className = '' }: { status: ApplicationStatus | undefined; className?: string }) {
  const meta = statusMeta(status)
  return (
    <span className={`inline-flex items-center gap-2 whitespace-nowrap ${className}`}>
      <span className={`size-2.5 shrink-0 rounded-full ${statusDot[meta.id]}`} aria-hidden="true" />
      {meta.label}
    </span>
  )
}

/** Статус значком без выбора: в дублях, у приглашённых друзей */
export function StatusPill({ status, className = '' }: { status: ApplicationStatus | undefined; className?: string }) {
  const meta = statusMeta(status)
  return (
    <span className={`inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[13px] whitespace-nowrap ${statusPill[meta.id]} ${className}`}>
      <span className={`size-2 shrink-0 rounded-full ${statusDot[meta.id]}`} aria-hidden="true" />
      {meta.label}
    </span>
  )
}

/**
 * Статус в строке списка: выглядит как значок, открывается системным списком —
 * работает с клавиатуры и на телефоне без своих выпадашек.
 */
export function StatusSelect({
  value,
  onChange,
  label,
  disabled,
  className = '',
}: {
  value: ApplicationStatus
  onChange: (s: ApplicationStatus) => void
  label: string
  disabled?: boolean
  className?: string
}) {
  return (
    <span
      className={`relative inline-flex h-8 items-center gap-1.5 rounded-full pr-2.5 pl-3 text-[14px] transition-colors focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-white hover:brightness-125 ${statusPill[value]} ${className}`}
    >
      <StatusBadge status={value} />
      <svg viewBox="0 0 10 6" className="h-1.5 w-2.5 opacity-70" aria-hidden="true">
        <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as ApplicationStatus)}
        onClick={(e) => e.stopPropagation()}
        className="absolute inset-0 cursor-pointer appearance-none opacity-0 disabled:cursor-default"
      >
        {applicationStatuses.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
    </span>
  )
}

const field = 'w-full bg-transparent text-[16px] text-white placeholder:text-white/55'

export function HrInput({ className = '', ...rest }: ComponentProps<'input'>) {
  return <input {...rest} className={`${field} h-11 border-b border-white/30 focus:border-white [color-scheme:dark] ${className}`} />
}

export function HrSelect({ className = '', children, ...rest }: ComponentProps<'select'>) {
  return (
    <select {...rest} className={`${field} h-11 cursor-pointer border-b border-white/30 bg-night pr-6 focus:border-white ${className}`}>
      {children}
    </select>
  )
}

/** Компактный выпадающий фильтр. Выбранный — белым; снять его можно и чипом под панелью фильтров */
export function FilterSelect({ className = '', active, children, ...rest }: ComponentProps<'select'> & { active?: boolean }) {
  return (
    <select
      {...rest}
      className={`h-9 max-w-[250px] cursor-pointer rounded-none border-b bg-night pr-6 text-[14px] focus:border-white ${
        active ? 'border-white font-medium text-white' : 'border-white/25 text-white/75'
      } ${className}`}
    >
      {children}
    </select>
  )
}

export function HrTextArea({ className = '', ...rest }: ComponentProps<'textarea'>) {
  return (
    <textarea
      {...rest}
      className={`w-full resize-y border border-white/20 bg-white/[0.03] p-3 text-[15px] leading-snug text-white placeholder:text-white/55 focus:border-white/70 ${className}`}
    />
  )
}

export function HrLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="block font-display text-[15px] font-extrabold tracking-[0.06em] text-white/60 uppercase">
      {children}
    </label>
  )
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'error'; children: ReactNode }) {
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`border-l-2 py-1 pl-4 text-[15px] ${tone === 'error' ? 'border-brand text-white' : 'border-white/40 text-white/70'}`}>
      {children}
    </div>
  )
}

/** Почему кнопка рядом выключена: что заполнить или выбрать */
export function DisabledHint({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <p id={id} className="text-[13px] leading-snug text-white/60">
      {children}
    </p>
  )
}

/** Заголовок раздела панели — компактный, чтобы таблица помещалась на первом экране */
export const pageTitle = 'font-display text-[clamp(30px,3vw,40px)] leading-none font-black uppercase'

/**
 * Пустое состояние — одно на всю панель: заголовок 22 px слева, пояснение и, если есть, кнопка следующего шага
 */
export function Empty({ title, children, action, className = '' }: { title: string; children?: ReactNode; action?: { label: string; onClick: () => void }; className?: string }) {
  return (
    <div className={`border-b border-white/10 py-8 ${className}`}>
      <p className="font-display text-[22px] leading-none font-black uppercase">{title}</p>
      {children && <p className="mt-2 max-w-xl text-[15px] leading-snug text-white/60">{children}</p>}
      {action && (
        <button type="button" onClick={action.onClick} className={`${hrBtn.smallGhost} mt-4`}>
          {action.label}
        </button>
      )}
    </div>
  )
}

/** Скопировать текст: для звонка кандидату с сайта */
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** Пусто: прочерк для глаза, «нет» для экранного диктора */
export function Dash() {
  return (
    <>
      <span aria-hidden="true" className="text-white/55">
        —
      </span>
      <span className="sr-only">нет</span>
    </>
  )
}

/** День месяца словами («пн, <число> <месяц>», со временем — через запятую) рядом с полем даты: браузер с английским языком показывает поле в американском порядке */
export function RuDate({ value, className = '' }: { value: string; className?: string }) {
  if (!value) return null
  const [day, time] = value.split('T')
  const d = new Date(`${day}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return null
  const text = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', weekday: 'short', timeZone: 'UTC' })
  return (
    <span className={`text-[13px] text-white/60 ${className}`} aria-hidden="true">
      {time ? `${text}, ${time.slice(0, 5)}` : text}
    </span>
  )
}

/**
 * Итог прошедшего собеседования — одни и те же кнопки в карточке и в «Графике».
 * Явка оставляет статус, неявка ставит отказ с причиной «Неявка на собеседование»
 */
export function AttendanceButtons({ busy, onYes, onNo, label, compact }: { busy?: boolean; onYes: () => void; onNo: () => void; label?: string; compact?: boolean }) {
  const size = compact ? 'h-8 px-2.5 text-[14px]' : 'h-9 px-3 text-[15px]'
  const base = `inline-flex items-center justify-center whitespace-nowrap font-display font-extrabold tracking-[0.05em] uppercase ring-1 ring-inset transition-colors ${focusRing} ${off} ${size}`
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={label}>
      <button type="button" onClick={onYes} disabled={busy} className={`${base} text-white ring-white/40 hover:bg-white/[0.06] hover:ring-white`}>
        Явка
      </button>
      <button type="button" onClick={onNo} disabled={busy} className={`${base} text-brand-bright ring-brand/60 hover:bg-brand/[0.08] hover:ring-brand-bright`}>
        Неявка
      </button>
    </div>
  )
}
