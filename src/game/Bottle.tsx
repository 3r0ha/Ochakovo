import { memo, useId, type CSSProperties } from 'react'
import { KVAS_GLYPH, WORDMARK } from './label'

export type BottleKind = 'ok' | 'nocap' | 'lowfill' | 'label'

const BODY = 'M15.5 10h9v6.5c0 3.6 10.5 7.4 10.5 15V89a7 7 0 0 1-7 7H12a7 7 0 0 1-7-7V31.5c0-7.6 10.5-11.4 10.5-15z'
/** Контур бутылки в системе viewBox 0 0 40 100 — им же рисует картинка для сторис (storyImage.ts) */
export const BOTTLE_BODY = BODY

type Props = {
  kind?: BottleKind
  className?: string
  /** dark — для тёмной сцены: стекло с белым контуром, квас янтарного цвета */
  tone?: 'light' | 'dark'
  /** Брак послабее, для финала смены: недолив на треть, этикетка чуть съехала. Видно, но надо присмотреться */
  subtle?: boolean
}

const palettes = {
  light: {
    glass: 'var(--color-white)',
    outline: 'var(--color-ink)',
    labelStroke: 'var(--color-ink)',
    foam: 'var(--color-white)',
    foamStroke: 'var(--color-ink)',
    target: 'var(--color-brand)',
    surface: '#e7b77a',
  },
  dark: {
    glass: 'rgb(255 255 255 / 0.08)',
    outline: 'rgb(255 255 255 / 0.92)',
    labelStroke: undefined,
    foam: 'var(--color-white)',
    foamStroke: 'none',
    target: 'rgb(255 255 255 / 0.85)',
    surface: '#e7b77a',
  },
}

// Квас на просвет: тёплый янтарь у поверхности, густой коричневый ко дну
export const KVASS_TOP = '#b06a26'
export const KVASS_BOTTOM = '#5a2f0e'

export type BottleShapeProps = {
  /** Уровень налива: 0 — пустая, 1 — полная */
  level: number
  /** kvass — налив цвета кваса (KVASS_TOP → KVASS_BOTTOM), white — белым, для красного фона */
  fill?: 'kvass' | 'white'
  /** Сколько миллисекунд наливается до нового уровня; 0 — сразу (так и при уменьшении движения) */
  duration?: number
  className?: string
}

/**
 * Силуэт той же бутылки, что в игре, без этикетки и брака: бутылки «Смены» и большая бутылка в «Собери лето».
 * Контур — currentColor. Картинка декоративная (aria-hidden): уровень вслух называет текст рядом
 */
export function BottleShape({ level, fill = 'kvass', duration = 0, className }: BottleShapeProps) {
  const clip = useId()
  const grad = `${clip}-fill`
  const top = 10
  const height = 96 - top
  const filled = Math.max(0, Math.min(1, level))
  return (
    <svg viewBox="0 0 40 100" className={className} aria-hidden="true">
      <defs>
        <clipPath id={clip}>
          <path d={BODY} />
        </clipPath>
        <linearGradient id={grad} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={fill === 'white' ? 'var(--color-white)' : KVASS_TOP} />
          <stop offset="1" stopColor={fill === 'white' ? 'var(--color-white)' : KVASS_BOTTOM} />
        </linearGradient>
      </defs>
      <g clipPath={`url(#${clip})`}>
        <rect
          x="0"
          y={top}
          width="40"
          height={height}
          fill={`url(#${grad})`}
          style={{ transform: `translateY(${(1 - filled) * height}px)`, transition: duration > 0 ? `transform ${duration}ms cubic-bezier(0.16, 1, 0.3, 1)` : undefined }}
        />
      </g>
      <path d={BODY} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  )
}

// Этикетка: белая полоса во всю ширину бутылки, «КВАС» красным шрифтом заголовков и знак «ОЧАКОВО» под ним.
// Координаты — в системе viewBox 0 0 40 100, как у силуэта
export const LABEL_BOX = { x: 5, y: 49, width: 30, height: 21 }
const KVAS_W = 22
const KVAS_K = KVAS_W / (KVAS_GLYPH.maxX - KVAS_GLYPH.minX)
const KVAS_H = (KVAS_GLYPH.maxY - KVAS_GLYPH.minY) * KVAS_K
const MARK_W = 17
const MARK_K = MARK_W / WORDMARK.width
const MARK_H = WORDMARK.height * MARK_K
const MARK_GAP = 2.2
/** «КВАС» и знак вместе стоят по центру этикетки */
const KVAS_Y = LABEL_BOX.y + (LABEL_BOX.height - (KVAS_H + MARK_GAP + MARK_H)) / 2
const MARK_Y = KVAS_Y + KVAS_H + MARK_GAP
/** На маленькой бутылке знака нет — «КВАС» опускается в центр этикетки */
const KVAS_SHIFT = LABEL_BOX.y + (LABEL_BOX.height - KVAS_H) / 2 - KVAS_Y
const r = (n: number) => Math.round(n * 1000) / 1000

/**
 * Бутылка ниже 70 px (или уже 28 px): знак «ОЧАКОВО» в полтора пикселя не читается, на этикетке остаётся только «КВАС».
 * Размер знает контейнер-обёртка (container-type: size), поэтому правило работает при любом классе размера у вызова
 */
const SMALL_HIDE = '[@container_(height<70px)_or_(width<28px)]:hidden'
const SMALL_SHIFT = '[@container_(height<70px)_or_(width<28px)]:translate-y-(--kvas-shift)'

function Label({ stroke }: { stroke?: string }) {
  const { x, y, width, height } = LABEL_BOX
  return (
    <g data-label="">
      <rect x={x} y={y} width={width} height={height} fill="var(--color-white)" stroke={stroke} strokeWidth={stroke ? 0.9 : undefined} />
      <g className={SMALL_SHIFT} style={{ '--kvas-shift': `${r(KVAS_SHIFT)}px` } as CSSProperties}>
        <path
          data-kvas=""
          transform={`translate(${r(20 - KVAS_W / 2 - KVAS_GLYPH.minX * KVAS_K)} ${r(KVAS_Y - KVAS_GLYPH.minY * KVAS_K)}) scale(${r(KVAS_K * 1000) / 1000})`}
          d={KVAS_GLYPH.d}
          fill="var(--color-brand)"
        />
      </g>
      <path
        data-wordmark=""
        className={SMALL_HIDE}
        transform={`translate(${r(20 - MARK_W / 2)} ${r(MARK_Y)}) scale(${r(MARK_K * 1000) / 1000})`}
        d={WORDMARK.d}
        fill="var(--color-brand)"
        fillRule="evenodd"
      />
    </g>
  )
}

/**
 * Плоская бутылка для мини-игры. Брак утрирован, чтобы читаться с первого взгляда:
 * открытое горлышко с пеной, пустая на две трети бутылка, сорванная этикетка.
 * Кривая этикетка — та же этикетка «КВАС», повёрнутая и съехавшая вниз.
 * memo: в игре лента перерисовывается каждый кадр, а бутылка меняется только с видом брака
 */
export const Bottle = memo(function Bottle({ kind = 'ok', className = '', tone = 'light', subtle = false }: Props) {
  const clip = useId()
  const grad = `${clip}-kvass`
  const c = palettes[tone]
  const liquidTop = kind === 'lowfill' ? (subtle ? 46 : 70) : 27

  return (
    // Обёртка задаёт размер: по ней этикетка решает, показывать ли знак. aspect-ratio — для вызовов вида h-16 w-auto
    <span className={`block aspect-[2/5] [container-type:size] ${className}`} aria-hidden="true">
      <svg viewBox="0 0 40 100" className="block size-full" overflow="visible">
        <defs>
          <clipPath id={clip}>
            <path d={BODY} />
          </clipPath>
          <linearGradient id={grad} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={KVASS_TOP} />
            <stop offset="1" stopColor={KVASS_BOTTOM} />
          </linearGradient>
        </defs>
        <path d={BODY} fill={c.glass} />
        <g clipPath={`url(#${clip})`}>
          <rect x="0" y={liquidTop} width="40" height={96 - liquidTop} fill={`url(#${grad})`} />
          {/* Светлая полоска пены на поверхности */}
          <rect x="0" y={liquidTop} width="40" height="2" fill={c.surface} opacity="0.85" />
          <rect x="9" y={liquidTop + 4} width="2.6" height={Math.max(0, 86 - liquidTop)} rx="1.3" fill="var(--color-white)" opacity="0.2" />
          {kind === 'lowfill' && (
            // Пустая часть: пунктир уровня, до которого должно быть налито
            <line x1="5" x2="35" y1="27" y2="27" stroke={c.target} strokeWidth="1.2" strokeDasharray="2.4 2" />
          )}
        </g>

        {kind === 'label' ? (
          // Этикетка съехала: повёрнута и сдвинута вниз, углы выходят за силуэт
          <g transform={subtle ? 'rotate(-9 20 59.5) translate(0 3.5)' : 'rotate(-28 20 59.5) translate(0 6)'}>
            <Label stroke={c.labelStroke} />
          </g>
        ) : (
          <Label stroke={c.labelStroke} />
        )}

        <path d={BODY} fill="none" stroke={c.outline} strokeWidth="1.4" strokeLinejoin="round" />

        {kind === 'nocap' ? (
          // Крышки нет: открытое горлышко и пена через край
          <g>
            <ellipse cx="20" cy="10" rx="4.5" ry="1.4" fill={KVASS_TOP} stroke={c.outline} strokeWidth="1" />
            <circle cx="17" cy="6" r="2.2" fill={c.foam} stroke={c.foamStroke} strokeWidth="0.9" />
            <circle cx="22.5" cy="4.2" r="2.8" fill={c.foam} stroke={c.foamStroke} strokeWidth="0.9" />
            <circle cx="19.5" cy="0" r="1.7" fill={c.foam} stroke={c.foamStroke} strokeWidth="0.9" />
          </g>
        ) : tone === 'dark' ? (
          // На тёмном крышка красная с белым бликом — не путается с белой пеной брака
          <>
            <rect x="14" y="2" width="12" height="8.5" rx="1.2" fill="var(--color-brand)" stroke={c.outline} strokeWidth="1" />
            <rect x="15.5" y="3.4" width="9" height="1.2" rx="0.6" fill="var(--color-white)" opacity="0.6" />
          </>
        ) : (
          <>
            <rect x="14" y="2" width="12" height="8.5" rx="1.2" fill="var(--color-brand)" />
            <rect x="14" y="8.4" width="12" height="1.2" fill="var(--color-brand-deep)" />
          </>
        )}
      </svg>
    </span>
  )
})
