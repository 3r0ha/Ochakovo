import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { Photo, type PhotoName } from '../../components/Photo'

/**
 * Строка, растянутая ровно на ширину контейнера: размер шрифта подбирается по факту,
 * после загрузки шрифтов и при каждом ресайзе.
 */
export function FitLine({ children, className = '' }: { children: string; className?: string }) {
  const box = useRef<HTMLDivElement>(null)
  const text = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    const fit = () => {
      const el = text.current
      const wrap = box.current
      if (!el || !wrap) return
      el.style.fontSize = '100px'
      const width = el.getBoundingClientRect().width
      if (width) el.style.fontSize = `${(100 * wrap.clientWidth) / width}px`
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(box.current!)
    document.fonts.ready.then(fit)
    return () => ro.disconnect()
  }, [children])

  return (
    <div ref={box} className="w-full">
      <span ref={text} className={`inline-block whitespace-nowrap ${className}`}>
        {children}
      </span>
    </div>
  )
}

/**
 * Двухцветное фото: чёрно-белый кадр, умноженный на фирменный красный.
 * Трансформации вешаем на обёртку, иначе смешивание не увидит красный фон.
 */
export function Duo({
  name,
  sizes,
  priority,
  tone = 'red',
  className = '',
}: {
  name: PhotoName
  sizes: string
  priority?: boolean
  tone?: 'red' | 'mono'
  className?: string
}) {
  return (
    <div className={`relative overflow-hidden ${tone === 'red' ? 'bg-brand' : 'bg-ink'} ${className}`}>
      <Photo
        name={name}
        alt=""
        sizes={sizes}
        priority={priority}
        className="absolute inset-0 !bg-none"
        imgClassName={tone === 'red' ? 'grayscale contrast-[1.35] brightness-[1.08] mix-blend-multiply' : 'grayscale contrast-[1.2]'}
      />
    </div>
  )
}

/** Бегущая строка с фактами */
export function Ticker({ items, className = '', speed = 36 }: { items: string[]; className?: string; speed?: number }) {
  const row = (hidden: boolean) => (
    <div className="flex shrink-0 items-center" aria-hidden={hidden || undefined}>
      {items.map((item) => (
        <span key={item} className="flex items-center">
          <span className="px-6 whitespace-nowrap">{item}</span>
          <span className="size-2 bg-current" />
        </span>
      ))}
    </div>
  )
  return (
    <div className={`overflow-hidden ${className}`}>
      <div className="flex w-max animate-[belt-roll_var(--speed)_linear_infinite]" style={{ ['--speed' as string]: `${speed}s` }}>
        {row(false)}
        {row(true)}
      </div>
    </div>
  )
}

/** Маленькая «трафаретная» метка, как маркировка на цеху */
export function Tag({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span className={`inline-block bg-ink px-2 py-1 font-display text-[15px] leading-none font-bold tracking-[0.08em] text-white uppercase ${className}`}>
      {children}
    </span>
  )
}
