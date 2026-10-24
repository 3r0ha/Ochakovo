import type { CSSProperties, ReactNode } from 'react'
import { Link } from 'react-router'

/** Палитра «Кино»: тёплый чёрный, тёплый белый, янтарь из кадра и фирменный красный */
export const cinema = {
  '--c-bg': '#0c0a08',
  '--c-fg': '#f3ece1',
  '--c-amber': '#eaae5e',
} as CSSProperties

/** Стили, которых нет в общей теме: зерно плёнки, засветки, серифный акцент */
export function CinemaStyles() {
  return (
    <style>{`
      .c-serif { font-family: 'Cormorant Garamond Variable', Georgia, serif; font-style: italic; font-weight: 500; letter-spacing: -0.01em; }
      .c-grain {
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
        animation: c-grain 0.9s steps(3) infinite;
      }
      @keyframes c-grain {
        0% { transform: translate(0, 0) }
        33% { transform: translate(-3%, 2%) }
        66% { transform: translate(2%, -3%) }
        100% { transform: translate(0, 0) }
      }
      .c-leak { animation: c-leak 16s ease-in-out infinite alternate; }
      @keyframes c-leak {
        from { transform: translate(-6%, -4%) scale(1); opacity: .55 }
        to { transform: translate(8%, 6%) scale(1.25); opacity: .85 }
      }
      .c-cue { animation: c-cue 2.4s cubic-bezier(.16,1,.3,1) infinite; transform-origin: top; }
      @keyframes c-cue {
        0% { transform: scaleY(0); opacity: 1 }
        60% { transform: scaleY(1); opacity: 1 }
        100% { transform: scaleY(1); opacity: 0 }
      }
      @media (prefers-reduced-motion: reduce) { .c-grain, .c-leak, .c-cue { animation: none } }
    `}</style>
  )
}

export function CtaLink({ to, children, className = '' }: { to: string; children: ReactNode; className?: string }) {
  return (
    <Link
      to={to}
      className={`group inline-flex h-14 items-center gap-4 bg-brand px-7 font-display text-[20px] font-bold tracking-[0.06em] text-white uppercase transition-colors duration-300 hover:bg-brand-deep ${className}`}
    >
      {children}
      <span className="block h-px w-6 bg-white transition-[width] duration-500 ease-out-expo group-hover:w-10" />
    </Link>
  )
}

export function TextLink({ to, children, className = '' }: { to: string; children: ReactNode; className?: string }) {
  return (
    <Link to={to} className={`group inline-flex items-baseline gap-3 text-[17px] text-(--c-fg) ${className}`}>
      <span className="border-b border-(--c-fg)/30 pb-0.5 transition-colors duration-300 group-hover:border-(--c-fg)">{children}</span>
      <span className="transition-transform duration-500 ease-out-expo group-hover:translate-x-1.5">→</span>
    </Link>
  )
}
