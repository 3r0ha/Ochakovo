import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { nb } from '../lib/typo'

/**
 * Ролик «Смена изнутри»: настоящая смена на заводе, снятая самим «Очаково» (archive/case-materials/video).
 * Ролики подготовлены node scripts/media.mjs video: вырезаны сцены с алкогольными этикетками и концовка с прежним логотипом,
 * H.264 720p и 480p с faststart, постеры AVIF и WebP с размытой мини-превью. Данные ниже — из public/video/manifest.json.
 *
 * Как ведёт себя плеер:
 *  • до нажатия грузится только постер: у <video> preload="none", файл ролика не запрашивается;
 *  • запускается по кнопке «Посмотреть смену» (клавиатура — Enter и пробел), стартует без звука, звук включается отдельной кнопкой
 *    или в плеере; речи в роликах нет — музыка и титры, это сказано в подписи;
 *  • ставится на паузу, когда уходит с экрана или вкладка скрыта; одновременно играет только один ролик;
 *  • на телефоне и при экономии трафика берёт 480p (1,6 МБ), иначе 720p (до 4 МБ).
 *
 * Использование: <ShiftVideo id="bottling-operator" /> — постер с кнопкой; <ShiftVideo id="lab-assistant" variant="button" /> —
 * только кнопка «Посмотреть смену · 0:25», плеер раскрывается по нажатию (для карточек вакансий).
 */

// <media:videos> — блок пишет node scripts/media.mjs video из public/video/manifest.json, руками не править
export const SHIFT_VIDEOS = [
  {
    "id": "machinist",
    "profession": "Машинист технологических установок",
    "department": "Производство углекислоты",
    "duration": 31.3,
    "speech": false,
    "steps": [
      "Подготовься к работе",
      "Следи за работой",
      "Контролируй и управляй",
      "Наставники всему научат",
      "Закрепляй пройденный материал",
      "Твоя точность — наш успех"
    ],
    "width": 1280,
    "height": 720,
    "files": {
      "480": "/video/machinist-480.mp4",
      "720": "/video/machinist-720.mp4"
    },
    "poster": {
      "avif": {
        "640": "/video/machinist-640.avif",
        "1280": "/video/machinist-1280.avif"
      },
      "webp": {
        "640": "/video/machinist-640.webp",
        "1280": "/video/machinist-1280.webp"
      }
    },
    "lqip": "data:image/webp;base64,UklGRmIAAABXRUJQVlA4IFYAAACQAwCdASoYAA4APu1iqk4ppaQiMAgBMB2JbACsAAeppAj5ZD0gAP1Ke6cTTapTmmXKjO3BbLi+1RtwJEVwrnzEsbsEFqT47verQbR+pWao0aGc3sgAAA=="
  },
  {
    "id": "bottling-operator",
    "profession": "Оператор линии розлива",
    "department": "Цех розлива напитков",
    "duration": 27,
    "speech": false,
    "steps": [
      "Надень форму",
      "Следи за работой",
      "Контролируй и управляй",
      "Наставники всегда помогут",
      "Твоя точность — наш успех",
      "Обучайся легко и просто"
    ],
    "width": 1280,
    "height": 720,
    "files": {
      "480": "/video/bottling-operator-480.mp4",
      "720": "/video/bottling-operator-720.mp4"
    },
    "poster": {
      "avif": {
        "640": "/video/bottling-operator-640.avif",
        "1280": "/video/bottling-operator-1280.avif"
      },
      "webp": {
        "640": "/video/bottling-operator-640.webp",
        "1280": "/video/bottling-operator-1280.webp"
      }
    },
    "lqip": "data:image/webp;base64,UklGRnIAAABXRUJQVlA4IGYAAAAQBACdASoYAA4APu1iqU2ppaOiMAgBMB2JZAC7ABuoed7Dm+/xehXpAAD+BnEsw0/dj+28TDWEsEh2AgKs504Gu7JcUGQV/EDusnJkkSl8JEVaxGVT+24AlwEHXg5Vl2+zbBG4AAA="
  },
  {
    "id": "lab-assistant",
    "profession": "Лаборант",
    "department": "Лаборатория",
    "duration": 25.2,
    "speech": false,
    "steps": [
      "Надень форму",
      "Контролируй процесс",
      "Выполняй органолептические анализы",
      "Наставники всему научат",
      "Проверяй качество",
      "Обучайся легко и просто",
      "Закрепляй пройденный материал"
    ],
    "width": 1280,
    "height": 720,
    "files": {
      "480": "/video/lab-assistant-480.mp4",
      "720": "/video/lab-assistant-720.mp4"
    },
    "poster": {
      "avif": {
        "640": "/video/lab-assistant-640.avif",
        "1280": "/video/lab-assistant-1280.avif"
      },
      "webp": {
        "640": "/video/lab-assistant-640.webp",
        "1280": "/video/lab-assistant-1280.webp"
      }
    },
    "lqip": "data:image/webp;base64,UklGRlgAAABXRUJQVlA4IEwAAABwAwCdASoYAA4APu1kqk4ppaQiMAgBMB2JZQDA3AMViiyFIAAA+nGwmxgDPti85MW9jAyL6NVzP7a9iOnyElTH0hspLjyRcRbdwAAA"
  }
] as const
// </media:videos>

export type ShiftVideoData = (typeof SHIFT_VIDEOS)[number]
export type ShiftVideoId = ShiftVideoData['id']

export function shiftVideo(id: ShiftVideoId): ShiftVideoData {
  const v = SHIFT_VIDEOS.find((x) => x.id === id)
  if (!v) throw new Error(`нет ролика ${id}`)
  return v
}

/** 25,2 → «0:25» */
export function formatDuration(seconds: number) {
  const s = Math.round(seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Длительность для экранного диктора: «25 секунд» */
export function durationWords(seconds: number) {
  const s = Math.round(seconds)
  const n10 = s % 10
  const n100 = s % 100
  const word = n10 === 1 && n100 !== 11 ? 'секунда' : n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14) ? 'секунды' : 'секунд'
  return `${s} ${word}`
}

/** Подпись про звук: речи нет — смотреть можно без звука; есть — просим включить */
export function soundNote(v: { speech: boolean }) {
  return v.speech ? 'В ролике говорят, включи звук.' : 'Без слов, только музыка и титры. Смотреть можно без звука.'
}

type Connection = { saveData?: boolean; effectiveType?: string }

/** 480p — телефону, при экономии трафика и медленной сети; иначе 720p */
export function pickQuality(env?: { width: number; connection?: Connection }): '480' | '720' {
  const e = env ?? (typeof window === 'undefined' ? undefined : { width: window.innerWidth, connection: (navigator as Navigator & { connection?: Connection }).connection })
  if (!e) return '720'
  if (e.connection?.saveData || /(^|-)(2g|3g)$/.test(e.connection?.effectiveType ?? '')) return '480'
  return e.width < 640 ? '480' : '720'
}

/** Играет только один ролик: запуск одного ставит на паузу остальные */
let playing: HTMLVideoElement | null = null

type Props = {
  id: ShiftVideoId
  /** poster — постер с кнопкой поверх; button — только кнопка, плеер раскрывается по нажатию */
  variant?: 'poster' | 'button'
  /** Показать под роликом, что в нём: титры по порядку */
  showSteps?: boolean
  /** Подписи про звук и титры — только для экранного диктора: раздел сказал про звук один раз для всех роликов */
  quietCaption?: boolean
  /** Подсказка браузеру о ширине постера, как у Photo */
  sizes?: string
  className?: string
  /** Для счётчиков: ролик запущен */
  onPlay?: (id: ShiftVideoId) => void
  /** Что показать на постере над кнопкой вместо названия профессии */
  title?: ReactNode
}

export function ShiftVideo({ id, variant = 'poster', showSteps = true, quietCaption = false, sizes = '(min-width: 1024px) 720px, 100vw', className = '', onPlay, title }: Props) {
  const v = shiftVideo(id)
  const [open, setOpen] = useState(variant === 'poster')
  const [started, setStarted] = useState(false)
  const [muted, setMuted] = useState(true)
  const [posterLoaded, setPosterLoaded] = useState(false)
  const [quality] = useState(() => pickQuality())
  const video = useRef<HTMLVideoElement>(null)
  const box = useRef<HTMLDivElement>(null)
  /** Кнопка раскрыла плеер — запустить ролик сразу, как он появится */
  const autostart = useRef(false)
  const stepsId = useId()
  const duration = formatDuration(v.duration)
  const label = `Посмотреть смену: ${v.profession}, ${durationWords(v.duration)}`

  const start = useCallback(() => {
    const el = video.current
    if (!el) return
    el.muted = muted
    // play() — прямо в обработчике нажатия: так iOS разрешает запуск
    const p = el.play()
    setStarted(true)
    p?.catch(() => setStarted(false))
    // Фокус — на плеер: дальше пробел и стрелки управляют самим роликом
    requestAnimationFrame(() => el.focus({ preventScroll: true }))
  }, [muted])

  // Пауза вне экрана и на скрытой вкладке
  useEffect(() => {
    const el = video.current
    const area = box.current
    if (!el || !area) return
    const stop = () => {
      if (!el.paused) el.pause()
    }
    // Видно меньше четверти ролика — пауза
    const io = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(([e]) => e.intersectionRatio < 0.25 && stop(), { threshold: [0, 0.25] })
    io?.observe(area)
    const onHidden = () => document.hidden && stop()
    document.addEventListener('visibilitychange', onHidden)
    const onPlaying = () => {
      if (playing && playing !== el) playing.pause()
      playing = el
    }
    el.addEventListener('play', onPlaying)
    return () => {
      io?.disconnect()
      document.removeEventListener('visibilitychange', onHidden)
      el.removeEventListener('play', onPlaying)
      if (playing === el) playing = null
    }
  }, [open])

  // Вариант «кнопка»: плеер появился — сразу запускаем (без звука это разрешено без жеста)
  useEffect(() => {
    if (open && autostart.current) {
      autostart.current = false
      start()
    }
  }, [open, start])

  if (!open)
    return (
      <button
        type="button"
        aria-label={label}
        onClick={() => {
          autostart.current = true
          setOpen(true)
        }}
        className={`group inline-flex min-h-11 items-center gap-2 font-display text-[17px] font-bold tracking-[0.04em] uppercase transition-colors hover:text-brand ${className}`}
      >
        <span className="underline decoration-1 underline-offset-4">Посмотреть смену</span>
        <span className="font-sans text-[15px] font-normal tracking-normal normal-case tabular-nums opacity-70">{duration}</span>
      </button>
    )

  const set = (format: 'avif' | 'webp') =>
    Object.entries(v.poster[format])
      .map(([w, src]) => `${src} ${w}w`)
      .join(', ')

  return (
    <figure className={`m-0 ${className}`}>
      <div
        ref={box}
        data-surface="dark"
        className="relative aspect-video overflow-hidden bg-night bg-cover bg-center text-white [container-type:inline-size]"
        style={posterLoaded ? undefined : { backgroundImage: `url(${v.lqip})` }}
      >
        <video
          ref={video}
          // Файл не грузится, пока не нажали «Посмотреть смену»
          preload="none"
          src={v.files[quality]}
          width={v.width}
          height={v.height}
          playsInline
          muted={muted}
          controls={started}
          disablePictureInPicture
          aria-label={`Ролик «${v.profession}»`}
          aria-describedby={showSteps ? stepsId : undefined}
          tabIndex={started ? 0 : -1}
          onVolumeChange={(e) => setMuted(e.currentTarget.muted)}
          onEnded={() => setStarted(false)}
          onPlay={() => onPlay?.(id)}
          className="absolute inset-0 size-full bg-night object-cover"
        />
        {!started && (
          <>
            <picture className="absolute inset-0" aria-hidden="true">
              <source type="image/avif" srcSet={set('avif')} sizes={sizes} />
              <source type="image/webp" srcSet={set('webp')} sizes={sizes} />
              <img
                src={v.poster.webp['640']}
                alt=""
                width={v.width}
                height={v.height}
                loading="lazy"
                decoding="async"
                onLoad={() => setPosterLoaded(true)}
                className={`size-full object-cover transition-opacity duration-500 motion-reduce:transition-none ${posterLoaded ? 'opacity-100' : 'opacity-0'}`}
              />
            </picture>
            <div aria-hidden="true" className="absolute inset-0 bg-[linear-gradient(to_top,rgb(12_12_12/0.92),rgb(12_12_12/0.55)_45%,transparent_85%)]" />
            <button
              type="button"
              aria-label={label}
              onClick={start}
              // Кольцо фокуса внутри: снаружи его обрезал бы край постера
              className="group absolute inset-0 flex flex-col items-start justify-end gap-3 p-4 text-left focus-visible:shadow-[inset_0_0_0_6px_var(--color-night)] focus-visible:outline-offset-[-4px] sm:p-6"
            >
              <span className="font-display text-[clamp(26px,5cqi,44px)] leading-[0.9] font-black uppercase">{title ?? nb(v.profession)}</span>
              <span className="inline-flex h-11 items-center gap-3 bg-brand px-4 font-display text-[17px] font-bold tracking-[0.04em] uppercase transition-colors group-hover:bg-white group-hover:text-brand group-focus-visible:bg-white group-focus-visible:text-brand">
                Посмотреть смену
                <span className="font-sans text-[15px] font-normal tracking-normal tabular-nums">{duration}</span>
              </span>
            </button>
          </>
        )}
      </div>
      <figcaption className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[15px] leading-snug">
        <span className="sr-only">{nb(soundNote(v))}</span>
        {started && (
          <button
            type="button"
            onClick={() => {
              const el = video.current
              if (el) el.muted = !el.muted
            }}
            className="min-h-11 underline decoration-1 underline-offset-4 hover:text-brand"
          >
            {v.speech ? (muted ? 'Включить звук' : 'Выключить звук') : muted ? 'Включить музыку' : 'Выключить музыку'}
          </button>
        )}
        {showSteps && (
          <span id={stepsId} className={quietCaption ? 'sr-only' : 'basis-full opacity-75'}>
            <span className="sr-only">{`${v.profession}, ${v.department}. `}</span>
            {nb(`В ролике: ${v.steps.map((s, i) => (i ? s.toLowerCase() : s)).join(' → ')}.`)}
          </span>
        )}
      </figcaption>
    </figure>
  )
}
