import { useState } from 'react'
import { photos, type PhotoName } from '@shared/photos'

export type { PhotoName }

type Props = {
  name: PhotoName
  alt: string
  /** Подсказка браузеру, какой ширины будет картинка: '100vw', '(min-width: 768px) 50vw, 100vw' … */
  sizes: string
  /** Первый экран: грузить сразу и с высоким приоритетом */
  priority?: boolean
  className?: string
  imgClassName?: string
}

/**
 * Адаптивное фото: AVIF с запасным WebP, набор ширин, ленивая загрузка
 * и размытая мини-превью из манифеста, пока грузится оригинал.
 */
export function Photo({ name, alt, sizes, priority, className = '', imgClassName = '' }: Props) {
  const meta = photos[name]
  const [loaded, setLoaded] = useState(false)
  const set = (ext: string) => meta.widths.map((w) => `/photos/${name}-${w}.${ext} ${w}w`).join(', ')
  const fallback = meta.widths.find((w) => w >= 960) ?? meta.widths.at(-1)

  return (
    <picture
      className={`block overflow-hidden bg-cover bg-center ${className}`}
      style={loaded ? undefined : { backgroundImage: `url(${meta.lqip})` }}
    >
      <source type="image/avif" srcSet={set('avif')} sizes={sizes} />
      <source type="image/webp" srcSet={set('webp')} sizes={sizes} />
      <img
        src={`/photos/${name}-${fallback}.webp`}
        alt={alt}
        width={meta.w}
        height={meta.h}
        loading={priority ? 'eager' : 'lazy'}
        decoding={priority ? 'sync' : 'async'}
        fetchPriority={priority ? 'high' : 'auto'}
        onLoad={() => setLoaded(true)}
        className={`size-full object-cover transition-opacity duration-700 ${loaded ? 'opacity-100' : 'opacity-0'} ${imgClassName}`}
      />
    </picture>
  )
}
