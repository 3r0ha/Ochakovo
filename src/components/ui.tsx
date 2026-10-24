import type { ComponentProps, ReactNode } from 'react'
import { Link } from 'react-router'

type Variant = 'brand' | 'ink' | 'white' | 'outline' | 'outline-white'

const variants: Record<Variant, string> = {
  brand: 'bg-brand text-white hover:bg-brand-deep',
  ink: 'bg-ink text-white hover:bg-brand',
  white: 'bg-white text-ink hover:bg-paper',
  outline: 'text-ink ring-1 ring-inset ring-ink/25 hover:ring-ink',
  'outline-white': 'text-white ring-1 ring-inset ring-white/40 hover:ring-white',
}

export const buttonClass = (variant: Variant = 'brand', extra = '') =>
  `group inline-flex h-14 items-center justify-center gap-3 rounded-full px-7 font-display text-[19px] font-bold uppercase tracking-[0.02em] transition-colors duration-300 disabled:pointer-events-none disabled:opacity-40 ${variants[variant]} ${extra}`

/** Стрелка «вверх-вправо», как на круглых кнопках ochakovo.ru */
export function Arrow({ className = 'size-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M4 12 12 4M5.5 4H12v6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" />
    </svg>
  )
}

function ButtonArrow() {
  return (
    <span className="relative -mr-1 grid size-5 place-items-center overflow-hidden">
      <Arrow className="size-4 transition-transform duration-300 ease-out-expo group-hover:translate-x-5 group-hover:-translate-y-5" />
      <Arrow className="absolute size-4 -translate-x-5 translate-y-5 transition-transform duration-300 ease-out-expo group-hover:translate-x-0 group-hover:translate-y-0" />
    </span>
  )
}

type LinkButtonProps = Omit<ComponentProps<typeof Link>, 'className'> & {
  variant?: Variant
  className?: string
  arrow?: boolean
}

export function LinkButton({ variant, className, arrow = true, children, ...rest }: LinkButtonProps) {
  return (
    <Link {...rest} className={buttonClass(variant, className)}>
      {children}
      {arrow && <ButtonArrow />}
    </Link>
  )
}

type ButtonProps = Omit<ComponentProps<'button'>, 'className'> & {
  variant?: Variant
  className?: string
  arrow?: boolean
}

export function Button({ variant, className, arrow = false, children, ...rest }: ButtonProps) {
  return (
    <button {...rest} className={buttonClass(variant, className)}>
      {children}
      {arrow && <ButtonArrow />}
    </button>
  )
}

/** Круглая кнопка-стрелка — фирменный приём ochakovo.ru */
export function RoundArrow({ className = '', tone = 'ink' }: { className?: string; tone?: 'ink' | 'white' | 'brand' }) {
  const tones = {
    ink: 'bg-ink text-white group-hover:bg-brand',
    white: 'bg-white text-ink',
    brand: 'bg-brand text-white',
  }
  return (
    <span className={`grid size-11 shrink-0 place-items-center rounded-full transition-colors duration-300 ${tones[tone]} ${className}`}>
      <Arrow className="size-4 transition-transform duration-300 ease-out-expo group-hover:rotate-45" />
    </span>
  )
}

/** Подпись секции: номер и название, отделённые тонкой линией */
export function SectionLabel({ index, children, light = false }: { index: string; children: ReactNode; light?: boolean }) {
  return (
    <div className={`flex items-center gap-4 text-[13px] font-medium uppercase tracking-[0.14em] ${light ? 'text-white/70' : 'text-mute'}`}>
      <span className="tabular-nums">{index}</span>
      <span className={`h-px w-10 ${light ? 'bg-white/40' : 'bg-ink/25'}`} />
      <span>{children}</span>
    </div>
  )
}

/** Заголовок секции: короткая красная подводка и крупный заголовок обычным регистром */
export function SectionHead({ kicker, title, text, light = false, className = '' }: { kicker?: string; title: ReactNode; text?: ReactNode; light?: boolean; className?: string }) {
  return (
    <div className={className}>
      {kicker && <p className={`text-[15px] font-semibold ${light ? 'text-sun' : 'text-brand'}`}>{kicker}</p>}
      <h2 className="mt-3 max-w-[16ch] text-[clamp(36px,5.2vw,72px)] leading-[1.02] font-extrabold tracking-[-0.035em]">{title}</h2>
      {text && <p className={`mt-5 max-w-[560px] text-lg ${light ? 'text-white/80' : 'text-ink/75'}`}>{text}</p>}
    </div>
  )
}
