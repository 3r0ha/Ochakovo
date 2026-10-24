import { useEffect, useRef, useState } from 'react'
import { Bottle, type BottleKind } from '../game/Bottle'
import { DEFECT_NAMES, type DefectKind } from '../game/useConveyorGame'
import { prefersReducedMotion, scrollToTarget } from '../lib/motion'
import { Announce, say } from './kit'
import { HEADER_OFFSET } from './tasks'

/** Бутылок в одном отрезке ленты; на экране — две копии подряд, чтобы лента шла без шва */
const N = 24
/** Где на отрезке брак: три на отрезок — новый брак въезжает на экран примерно раз в 10 секунд */
const defectSlots = () => [3, 11, 19]
const KINDS: DefectKind[] = ['nocap', 'lowfill', 'label']
/** В спокойном режиме лента стоит: брак — третья бутылка, его видно на любом экране */
const STATIC_DEFECT = 2

type Slot = BottleKind | 'gone'

const randomKind = () => KINDS[Math.floor(Math.random() * KINDS.length)]
const caughtText = (n: number) => {
  if (n === 1) return '1 брак пойман'
  const d = n % 10
  const h = n % 100
  const word = d === 1 && h !== 11 ? 'брак' : d >= 2 && d <= 4 && (h < 12 || h > 14) ? 'брака' : 'браков'
  return `Поймано ${n} ${word}`
}

/**
 * Подпись первого экрана: внизу едет лента с квасом, изредка попадается бутылка с браком.
 * Нажал на брак — он снят с ленты, рядом счётчик и приглашение в игру. Нормальные бутылки не наказывают.
 * Лента появляется после первой отрисовки (не мешает LCP), едет на CSS-transform и стоит, когда её не видно,
 * под курсором, при фокусе с клавиатуры и по кнопке «Пауза» (WCAG 2.2.2). Брак снимается и с остановленной ленты
 */
export function HeroBelt() {
  const [ready, setReady] = useState(false)
  const [calm] = useState(prefersReducedMotion)
  const [slots, setSlots] = useState<Slot[]>(() => {
    const defects = calm ? [STATIC_DEFECT] : defectSlots()
    return Array.from({ length: N }, (_, i) => (defects.includes(i) ? randomKind() : 'ok'))
  })
  const [lifting, setLifting] = useState<number | null>(null)
  const [count, setCount] = useState(0)
  /** Лента не на экране или вкладка скрыта */
  const [paused, setPaused] = useState(false)
  /** Человек остановил ленту кнопкой «Пауза» */
  const [stopped, setStopped] = useState(false)
  const [message, setMessage] = useState<{ key: number; text: string } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const timers = useRef<number[]>([])

  // Лента — не первая забота страницы: рисуем её, когда браузер освободился после первой отрисовки
  useEffect(() => {
    const show = () => setReady(true)
    // Safari без requestIdleCallback — просто чуть позже первой отрисовки
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(show, { timeout: 2500 })
      return () => window.cancelIdleCallback(id)
    }
    const id = setTimeout(show, 800)
    return () => clearTimeout(id)
  }, [])

  // Не на экране или вкладка скрыта — лента стоит
  useEffect(() => {
    const el = root.current
    if (!el || calm) return
    let visible = true
    const update = () => setPaused(!visible || document.hidden)
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting
      update()
    })
    io.observe(el)
    document.addEventListener('visibilitychange', update)
    return () => {
      io.disconnect()
      document.removeEventListener('visibilitychange', update)
    }
  }, [calm])

  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), [])

  const later = (fn: () => void, ms: number) => timers.current.push(window.setTimeout(fn, ms))

  const catchAt = (i: number) => {
    const kind = slots[i]
    if (kind === 'ok' || kind === 'gone' || lifting === i) return
    navigator.vibrate?.(12)
    const n = count + 1
    setCount(n)
    setLifting(i)
    setMessage(say(`Снято с ленты: ${DEFECT_NAMES[kind].toLowerCase()}. ${caughtText(n)}. Рядом кнопка «Сыграть 20 секунд».`))
    later(() => {
      setLifting(null)
      setSlots((s) => {
        const next = [...s]
        next[i] = 'gone'
        // Новый брак — подальше от пойманного: на телефоне он появится уже за краем экрана
        const j = calm ? (i + 2) % 7 : (i + N / 2) % N
        if (next[j] === 'ok') next[j] = randomKind()
        return next
      })
    }, 450)
    // Пустое место на ленте через полцикла снова занимает нормальная бутылка
    later(() => setSlots((s) => s.map((k, idx) => (idx === i && k === 'gone' ? 'ok' : k))), calm ? 1200 : 15000)
  }

  // С клавиатуры: снимаем брак, который сейчас виден на ленте (или ближайший к краю экрана)
  const catchByKey = () => {
    const el = root.current
    if (!el) return
    const defects = [...el.querySelectorAll<HTMLElement>('[data-slot][data-defect]')]
    const onScreen = defects.find((d) => {
      const r = d.getBoundingClientRect()
      return r.left >= 0 && r.right <= window.innerWidth
    })
    const target = onScreen ?? defects[0]
    if (target) catchAt(Number(target.dataset.slot))
  }

  const copy = (n: number) => (
    <div className="flex shrink-0 gap-5 pr-5 md:gap-10 md:pr-10" aria-hidden="true" key={n}>
      {slots.map((kind, i) => {
        const defect = kind !== 'ok' && kind !== 'gone'
        const style = lifting === i ? 'hb-lift' : kind === 'gone' ? 'opacity-0' : 'opacity-100'
        return defect ? (
          <button
            key={i}
            type="button"
            tabIndex={-1}
            data-slot={i}
            data-defect
            onClick={() => catchAt(i)}
            className={`hb-bottle relative -mx-2.5 -mt-3 h-[72px] w-[44px] cursor-pointer px-2.5 pt-3 md:h-[112px] md:w-[60px] short:h-[88px] short:w-[50px] ${style}`}
          >
            <Bottle kind={kind} tone="dark" className="size-full" />
          </button>
        ) : (
          <div key={i} data-slot={i} className={`hb-bottle h-[60px] w-[24px] md:h-[100px] md:w-[40px] short:h-[76px] short:w-[30px] ${style}`}>
            <Bottle kind="ok" tone="dark" className="size-full" />
          </div>
        )
      })}
    </div>
  )

  return (
    <div ref={root} className={`hb-root relative h-[104px] overflow-hidden md:h-[148px] short:h-[124px] ${paused || stopped ? 'hb-paused' : ''}`}>
      <style>{`
        @keyframes hb-roll { from { transform: translateX(-50%) } to { transform: translateX(0) } }
        @keyframes hb-stripes { from { transform: translateX(-40px) } to { transform: translateX(0) } }
        .hb-track { animation: hb-roll 34s linear infinite; will-change: transform }
        @media (min-width: 768px) { .hb-track { animation-duration: 47s } }
        .hb-band { animation: hb-stripes 1.29s linear infinite }
        @media (min-width: 768px) { .hb-band { animation-duration: 1.01s } }
        .hb-paused .hb-track, .hb-paused .hb-band { animation-play-state: paused }
        @media (hover: hover) { .hb-root:hover .hb-track, .hb-root:hover .hb-band { animation-play-state: paused } }
        .hb-root:has(:focus-visible) .hb-track, .hb-root:has(:focus-visible) .hb-band { animation-play-state: paused }
        .hb-bottle { transition: transform .45s cubic-bezier(.16,1,.3,1), opacity .45s ease }
        .hb-lift { transform: translateY(-22px); opacity: 0 }
        .hb-in { animation: hb-in .6s ease both }
        @keyframes hb-in { from { opacity: 0 } }
        @media (prefers-reduced-motion: reduce) { .hb-track, .hb-band { animation: none } }
      `}</style>
      <Announce message={message} />

      {/* Лента: полоса с бегущими рёбрами и красной кромкой, как в игре. Бутылки и рёбра едут вправо — к складу.
          Рёбра двигает transform, а не background-position: иначе браузер перерисовывал бы полосу каждый кадр */}
      <div
        className="absolute inset-x-0 bottom-6 h-2 overflow-hidden md:bottom-7 md:h-2.5"
        style={{ backgroundColor: '#1d1b19', boxShadow: 'inset 0 1px 0 var(--color-brand)' }}
        aria-hidden="true"
      >
        <div
          className={`absolute inset-y-0 right-0 -left-10 ${calm ? '' : 'hb-band'}`}
          style={{ backgroundImage: 'repeating-linear-gradient(90deg, rgba(255,255,255,0.08) 0 2px, transparent 2px 40px)' }}
        />
      </div>

      {ready && (
        <div className="hb-in absolute bottom-8 left-0 md:bottom-[38px]">
          <div className={`flex w-max items-end ${calm ? 'pl-5' : 'hb-track'}`}>{calm ? copy(0) : [copy(0), copy(1)]}</div>
        </div>
      )}

      {/* Подпись под лентой: подсказка, счётчик и приглашение в игру */}
      <div className="absolute inset-x-0 bottom-0 flex h-6 items-center justify-between gap-4 px-4 font-display text-[15px] font-bold tracking-[0.08em] uppercase md:h-7 md:px-8 md:text-[19px]">
        <span className={count ? 'text-white' : 'text-white/85'}>
          {count ? (
            caughtText(count)
          ) : (
            <>
              <span className="md:hidden">Найди брак и нажми</span>
              <span className="hidden md:inline">Найди бутылку с браком и нажми на неё</span>
            </>
          )}
          {/* Для клавиатуры и читалок: видна, только когда на ней фокус */}
          <button
            type="button"
            onClick={catchByKey}
            className="sr-only focus-visible:not-sr-only focus-visible:ml-3 focus-visible:underline focus-visible:underline-offset-4"
          >
            Снять брак с ленты
          </button>
        </span>
        <span className="flex shrink-0 items-center gap-4 md:gap-6">
          {!calm && (
            <button
              type="button"
              onClick={() => setStopped(!stopped)}
              className="-my-3 py-3 tracking-[0.08em] text-white/85 uppercase underline decoration-white/40 decoration-2 underline-offset-4 hover:text-white hover:decoration-white"
            >
              {stopped ? 'Пуск' : 'Пауза'}
              <span className="sr-only"> ленты</span>
            </button>
          )}
          {/* На телефоне кнопка игры в первом экране не помещается — ссылка на неё здесь сразу, не только после поимки */}
          {count === 0 && (
            <button
              type="button"
              onClick={() => scrollToTarget('#play', HEADER_OFFSET)}
              className="-my-3 shrink-0 py-3 tracking-[0.08em] text-white uppercase underline decoration-brand decoration-2 underline-offset-4 md:hidden"
            >
              Игра · 20 с →
            </button>
          )}
          {count > 0 && (
            <button
              type="button"
              onClick={() => scrollToTarget('#play', HEADER_OFFSET)}
              className="-my-3 py-3 tracking-[0.08em] text-white uppercase underline decoration-brand decoration-2 underline-offset-4 hover:decoration-white"
            >
              Сыграть 20 секунд →
            </button>
          )}
        </span>
      </div>
    </div>
  )
}
