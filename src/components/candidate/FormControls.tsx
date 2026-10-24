import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { ComponentProps, ReactNode } from 'react'

// Поля на тёмном фоне: только нижняя линия, подпись узким капсом над полем
const lineInput =
  'w-full rounded-none border-0 border-b bg-transparent py-3 text-[19px] text-white outline-none transition-colors duration-300 placeholder:text-white/40 focus-visible:outline-none'

const lineState = (error?: string) =>
  // Ошибка — одинаково заметна у поля в фокусе и без него: двойная красная линия
  `${error ? 'border-brand-bright shadow-[0_1px_0_0_var(--color-brand-bright)]' : 'border-white/25 hover:border-white/50 focus:border-white focus:shadow-[0_1px_0_0_white]'}`

const labelClass = 'block font-display text-[18px] font-extrabold tracking-[0.06em] text-white/55 uppercase'

type FieldProps = {
  id: string
  label: string
  required?: boolean
  error?: string
  hint?: string
  children: ReactNode
  className?: string
}

export function Field({ id, label, required, error, hint, children, className = '' }: FieldProps) {
  return (
    <div className={className}>
      <label htmlFor={id} className={labelClass}>
        {label}
        {/* Звёздочка — для глаз; скринридер узнаёт об обязательности из aria-required у поля */}
        {required && (
          <span className="text-brand-bright" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="mt-2 text-[15px] font-medium text-brand-bright">
          {error}
        </p>
      ) : (
        hint && (
          <p id={`${id}-hint`} className="mt-2 text-[15px] text-white/55">
            {hint}
          </p>
        )
      )}
    </div>
  )
}

export function TextInput({ error, className = '', ...rest }: ComponentProps<'input'> & { error?: string }) {
  return (
    <input
      {...rest}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? `${rest.id}-error` : rest['aria-describedby']}
      className={`${lineInput} ${lineState(error)} ${className}`}
    />
  )
}

export function TextArea({ error, className = '', ...rest }: ComponentProps<'textarea'> & { error?: string }) {
  return (
    <textarea
      {...rest}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? `${rest.id}-error` : rest['aria-describedby']}
      className={`${lineInput} ${lineState(error)} min-h-24 resize-none ${className}`}
    />
  )
}

export function Select({ error, className = '', children, ...rest }: ComponentProps<'select'> & { error?: string }) {
  return (
    <div className="relative">
      <select
        {...rest}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${rest.id}-error` : rest['aria-describedby']}
        className={`${lineInput} ${lineState(error)} cursor-pointer appearance-none pr-8 [&>option]:bg-coal [&>option]:text-white ${rest.value === '' ? 'text-white/60' : ''} ${className}`}
      >
        {children}
      </select>
      <svg viewBox="0 0 16 16" fill="none" className="pointer-events-none absolute top-1/2 right-0 size-4 -translate-y-1/2 text-white/70" aria-hidden="true">
        <path d="m3.5 6 4.5 4.5L12.5 6" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    </div>
  )
}

type CheckProps = {
  id: string
  checked: boolean
  onChange: (checked: boolean) => void
  error?: string
  required?: boolean
  /** На красной плашке: отмеченный квадрат белый с красной галочкой, иначе он слился бы с фоном */
  onRed?: boolean
  children: ReactNode
}

/** Квадратный чекбокс: нативный input скрыт, но остаётся доступным с клавиатуры */
export function Checkbox({ id, checked, onChange, error, required, onRed = false, children }: CheckProps) {
  return (
    <div>
      <label htmlFor={id} className="group flex cursor-pointer items-start gap-4">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          aria-invalid={error ? true : undefined}
          aria-required={required || undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          className="peer sr-only"
        />
        <span
          className={`mt-0.5 grid size-6 shrink-0 place-items-center border-2 transition-colors duration-200 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-white ${
            checked
              ? onRed
                ? 'border-white bg-white text-brand'
                : 'border-brand bg-brand text-white'
              : error
                ? 'border-brand-bright'
                : onRed
                  ? 'border-white/70 group-hover:border-white'
                  : 'border-white/40 group-hover:border-white'
          }`}
          aria-hidden="true"
        >
          {checked && (
            <svg viewBox="0 0 16 16" fill="none" className="size-4">
              <path d="m3 8.5 3.2 3L13 4.5" stroke="currentColor" strokeWidth="2.2" />
            </svg>
          )}
        </span>
        <span className={`text-[15px] leading-snug ${onRed ? 'text-white' : 'text-white/80'}`}>
          {children}
          {/* Обязательная отметка — со звёздочкой, как обязательные поля; скринридер узнаёт из aria-required */}
          {required && (
            <span className="text-brand-bright" aria-hidden="true">
              {' '}
              *
            </span>
          )}
        </span>
      </label>
      {error && (
        <p id={`${id}-error`} className="mt-2 ml-10 text-[15px] font-medium text-brand-bright">
          {error}
        </p>
      )}
    </div>
  )
}

type MonthProps = {
  pressed: boolean
  onClick: () => void
  children: ReactNode
}

/** Клетка месяца — как в «Собери лето» на главной */
export function MonthCell({ pressed, onClick, children }: MonthProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      className={`h-14 font-display text-[20px] font-extrabold tracking-[0.04em] uppercase transition-colors duration-300 ${
        pressed ? 'bg-white text-ink' : 'text-white ring-1 ring-white/30 ring-inset hover:ring-white'
      }`}
    >
      {children}
    </button>
  )
}

type SegmentedProps<T extends string> = {
  id: string
  label: string
  hint?: string
  options: { id: T; label: string }[]
  value: T | ''
  onChange: (value: T | '') => void
  /** Обязательный вопрос: звёздочка у подписи, повторное нажатие выбор не снимает */
  required?: boolean
  error?: string
  /** Сетка вариантов, например «grid-cols-2 md:grid-cols-4». Без неё — все варианты в одну строку */
  gridClassName?: string
  /** Подпись только для скринридера: переключатель стоит под подписью поля, которое он переключает */
  hideLabel?: boolean
  /** Свои id у радиокнопок вариантов — по ним на вариант ссылаются проверки и подписи */
  optionIds?: Partial<Record<T, string>>
  /** Компактные кнопки — для переключателя внутри поля */
  compact?: boolean
}

/**
 * Выбор из двух-четырёх вариантов кнопками — вместо выпадающего списка.
 * Внутри обычные радиокнопки: стрелки и пробел работают как везде. Необязательный вопрос
 * снимается повторным нажатием на выбранный вариант, обязательный — нет.
 * Первая радиокнопка получает id={id}: на неё уходит фокус, когда вопрос не заполнен
 */
export function Segmented<T extends string>({ id, label, hint, options, value, onChange, required, error, gridClassName, hideLabel, optionIds, compact }: SegmentedProps<T>) {
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined
  return (
    <fieldset aria-describedby={describedBy} aria-required={required || undefined} aria-invalid={error ? true : undefined}>
      <legend className={hideLabel ? 'sr-only' : labelClass}>
        {label}
        {required && (
          <span className="text-brand-bright" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </legend>
      <div
        className={`${hideLabel ? '' : 'mt-3'} grid gap-2 ${gridClassName ?? ''}`}
        style={gridClassName ? undefined : { gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      >
        {options.map((o, i) => {
          const on = value === o.id
          return (
            <label
              key={o.id}
              className={`flex cursor-pointer items-center justify-center text-center leading-tight transition-colors duration-200 ${compact ? 'min-h-11 px-4 py-1.5 text-[15px]' : 'min-h-12 px-2 py-2 text-[15px]'} has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-white ${
                on
                  ? 'bg-white font-medium text-ink'
                  : `text-white/85 ring-1 ring-inset hover:ring-white ${error ? 'ring-brand-bright' : 'ring-white/30'}`
              }`}
            >
              <input
                id={optionIds?.[o.id] ?? (i === 0 ? id : undefined)}
                type="radio"
                name={id}
                value={o.id}
                checked={on}
                onChange={() => onChange(o.id)}
                onClick={() => on && !required && onChange('')}
                className="sr-only"
              />
              {o.label}
            </label>
          )
        })}
      </div>
      {error ? (
        <p id={`${id}-error`} className="mt-2 text-[15px] font-medium text-brand-bright">
          {error}
        </p>
      ) : (
        hint && (
          <p id={`${id}-hint`} className="mt-2 text-[14px] leading-snug text-white/60">
            {hint}
          </p>
        )
      )}
    </fieldset>
  )
}

type DisclosureProps = {
  id: string
  open: boolean
  onToggle: () => void
  title: string
  /** Серая приписка отдельной строкой под заголовком: «Звонок с HR будет короче» */
  note: string
  children: ReactNode
}

/** Свёрнутая часть формы: строка с плюсом, по нажатию раскрывается. Значения внутри сохраняются и в свёрнутом виде */
export function Disclosure({ id, open, onToggle, title, note, children }: DisclosureProps) {
  const still = useReducedMotion()
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        className="flex w-full items-center justify-between gap-6 py-5 text-left font-display text-[clamp(24px,2.2vw,30px)] leading-none font-extrabold uppercase transition-colors hover:text-brand"
      >
        <span>
          {/* Приписка — своей строкой и обычным шрифтом: длинная строка капсом на телефоне переносилась посередине */}
          {title}
          <span className="mt-1.5 block font-sans text-[15px] leading-snug font-normal tracking-normal text-white/60 normal-case">{note}</span>
        </span>
        <span className={`relative block size-4 shrink-0 transition-transform duration-300 ${open ? 'rotate-45 text-brand' : ''}`} aria-hidden="true">
          <span className="absolute top-1/2 left-0 h-[2px] w-full -translate-y-1/2 bg-current" />
          <span className="absolute top-0 left-1/2 h-full w-[2px] -translate-x-1/2 bg-current" />
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={id}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: still ? 0 : 0.5, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
