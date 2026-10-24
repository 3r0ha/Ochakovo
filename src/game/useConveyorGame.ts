import { useCallback, useEffect, useRef, useState } from 'react'
import type { BottleKind } from './Bottle'
import { newSeed, slotRandom } from './challenge'

/** Одна длина раунда везде: на главной и на странице игры */
export const GAME_SECONDS = 20

export type DefectKind = Exclude<BottleKind, 'ok'>

export const DEFECT_NAMES: Record<DefectKind, string> = {
  nocap: 'Без крышки',
  lowfill: 'Недолив',
  label: 'Кривая этикетка',
}

export type BeltItem = {
  id: number
  /** Номер бутылки в раунде (логический слот): по сиду у слота всегда один и тот же вид — на любом экране */
  slot: number
  x: number
  kind: BottleKind
  /** Брак послабее — появляется в финале смены */
  subtle: boolean
  state: 'moving' | 'caught'
  /** Игровое время, когда бутылку поймали, сек */
  changedAt: number
  /** Нормальную бутылку уже тронули: штраф только один раз, бутылка едет дальше */
  touchedAt: number | null
}

export type FloatText = {
  id: number
  /** Центр подписи по горизонтали, px от левого края ленты */
  x: number
  text: string
  sub?: string
  tone: 'good' | 'bad'
  bornAt: number
}

export type GameStats = {
  score: number
  caught: number
  mistakes: number
  missed: number
  /** Из пропущенного — тонкий брак финала */
  subtleMissed: number
  streak: number
  maxMult: number
  /** Сколько бутылок проехало по ленте за раунд: брак и нормальные, пойманные и нет */
  bottles: number
  /** Длина раунда, сек — для строки о масштабе завода */
  seconds: number
}

export type GameEvent = 'catch' | 'mistake' | 'miss' | 'speedup' | 'combo'

/** ×1 → ×2 после 3 пойманных подряд → ×3 после 6 */
export const multFor = (streak: number) => (streak >= 6 ? 3 : streak >= 3 ? 2 : 1)

/**
 * Размер бутылки. На телефоне — около 66 px в ширину: к концу смены на ленте 4 бутылки и между ними
 * остаётся зазор под палец; на широком экране — до 120 px
 */
export const bottleWidth = (beltWidth: number) =>
  beltWidth < 600 ? Math.round(Math.min(84, Math.max(62, beltWidth * 0.19))) : Math.round(Math.min(120, Math.max(92, beltWidth * 0.085)))
export const bottleHeight = (bw: number) => Math.round(bw * 2.5)

const DEFECTS: DefectKind[] = ['nocap', 'lowfill', 'label']
const DEFECT_RATE = 0.45
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/** Первые секунды — спокойно, чтобы разобраться: 8 с в полной смене, чуть меньше в короткой */
export const calmFor = (duration: number) => Math.round(duration * 0.3)
/** Финал смены: последние 8 секунд лента быстрее, бутылок больше, брак тоньше */
const FINALE = 8
/** Моменты, когда игра объявляет «Скорость растёт» и «Финиш» */
export const speedupsFor = (duration: number) => [calmFor(duration), Math.max(calmFor(duration) + 2, duration - FINALE)]

/** 0 в спокойной фазе, дальше плавно растёт до 1 к концу смены */
const intensity = (t: number, duration: number) => {
  const calm = calmFor(duration)
  const p = Math.min(1, Math.max(0, (t - calm) / (duration - calm)))
  return p * (2 - p)
}
/** 0 до финала, плавно до 1 к последней секунде */
const finale = (t: number, duration: number) => {
  const p = Math.min(1, Math.max(0, (t - (duration - FINALE)) / (FINALE - 1)))
  return p * p * (3 - 2 * p)
}
/**
 * Время проезда через всю ленту: 5.5 с в начале, 3.2 с к финалу и 2.4 с в последние секунды —
 * каждая бутылка видна не меньше двух секунд. В спокойном режиме («меньше движения») не быстрее 3.4 с
 */
const crossTime = (t: number, duration: number, calm: boolean) =>
  lerp(lerp(5.5, calm ? 4.4 : 3.2, intensity(t, duration)), calm ? 3.4 : 2.4, finale(t, duration))

/** Рамка контроля для игры с клавиатуры: точка на ленте, где пробел снимает бутылку */
export const zoneCenter = (beltWidth: number) => Math.round(beltWidth * 0.68)
/** Сколько бутылок одновременно на ленте: 4 в начале, 6 к финалу, до 7.5 в последние секунды (на телефоне упирается в минимальный зазор) */
const visibleTarget = (t: number, duration: number) => lerp(4, 6, intensity(t, duration)) + 1.5 * finale(t, duration)
/** Минимальный шаг между бутылками: зазор не меньше трети бутылки, чтобы промах пальцем не попадал в соседнюю */
const minGap = (bw: number, f = 0) => bw * lerp(1.45, 1.33, f)
/** Расстояние между бутылками в пикселях: лента любой ширины заполнена одинаково плотно. jitter — 0,9…1,1 из слота */
const spacingPx = (t: number, duration: number, W: number, bw: number, jitter: number) =>
  Math.max(minGap(bw, finale(t, duration)), (W + bw) / visibleTarget(t, duration)) * jitter
/**
 * Бутылка логического слота по сиду. okInRow — сколько нормальных шло перед ней: больше двух подряд не бывает.
 * Тонкий брак зависит ещё и от момента смены (subtleChance), вид бутылки — только от сида и номера слота
 */
export function slotBottle(seed: number, slot: number, okInRow: number, subtleChance = 0): { kind: BottleKind; subtle: boolean; jitter: number } {
  const r = slotRandom(seed, slot)
  const [rDefect, rKind, rSubtle, rGap] = [r(), r(), r(), r()]
  const jitter = 0.9 + rGap * 0.2
  if (okInRow < 2 && rDefect >= DEFECT_RATE) return { kind: 'ok', subtle: false, jitter }
  const kind = DEFECTS[Math.min(DEFECTS.length - 1, Math.floor(rKind * DEFECTS.length))]
  return { kind, subtle: kind !== 'nocap' && rSubtle < subtleChance, jitter }
}

const freshStats = (): GameStats => ({ score: 0, caught: 0, mistakes: 0, missed: 0, subtleMissed: 0, streak: 0, maxMult: 1, bottles: 0, seconds: 0 })

type Options = {
  running: boolean
  /** Спокойный режим: лента разгоняется меньше (для prefers-reduced-motion) */
  calm?: boolean
  /** Длительность смены, сек. На главной — короткий раунд, на странице игры — полный */
  duration?: number
  onEnd: (stats: GameStats) => void
  onEvent?: (event: GameEvent) => void
}

/**
 * Игровой цикл конвейера. Состояние мира живёт в ref-ах, перерисовка — одним счётчиком кадров.
 * Время считается суммой dt, поэтому свёрнутая вкладка ставит смену на паузу.
 */
export function useConveyorGame({ running, calm = false, duration = GAME_SECONDS, onEnd, onEvent }: Options) {
  const width = useRef(350)
  const items = useRef<BeltItem[]>([])
  const floats = useRef<FloatText[]>([])
  const stats = useRef<GameStats>(freshStats())
  const clock = useRef(0)
  const beltOffset = useRef(0)
  const seq = useRef(0)
  const okInRow = useRef(0)
  /** Сид раунда и номер следующей бутылки: вид брака берётся по слоту, а не по пикселям и кадрам */
  const seed = useRef(newSeed())
  const slot = useRef(0)
  const [, setFrame] = useState(0)

  const handlers = useRef({ onEnd, onEvent })
  useEffect(() => {
    handlers.current = { onEnd, onEvent }
  })

  // Callback-ref: лента появляется только после интро, поэтому меряем её с момента монтирования
  const beltRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    width.current = el.clientWidth
    const ro = new ResizeObserver(() => {
      width.current = el.clientWidth
      setFrame((f) => f + 1)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /**
   * Следующая бутылка. Не больше двух нормальных подряд — делать есть что всегда. В финале часть брака тоньше: недолив на треть,
   * этикетка чуть съехала. Все случайные числа — из слота (slotRandom): у кого тот же сид, у того та же лента
   */
  const nextBottle = useCallback((subtleChance = 0): { slot: number; kind: BottleKind; subtle: boolean; jitter: number } => {
    const n = slot.current++
    const b = slotBottle(seed.current, n, okInRow.current, subtleChance)
    okInRow.current = b.kind === 'ok' ? okInRow.current + 1 : 0
    return { slot: n, ...b }
  }, [])

  /** Новый раунд. roundSeed — сид из ссылки друга или прошлого раунда; без него — новый */
  const reset = useCallback((roundSeed?: number) => {
    items.current = []
    floats.current = []
    stats.current = freshStats()
    clock.current = 0
    okInRow.current = 0
    seed.current = roundSeed ?? newSeed()
    slot.current = 0
    // Лента уже едет: левая половина сразу заполнена, на широком экране не ждём первую бутылку
    const W = width.current
    const bw = bottleWidth(W)
    const gap = Math.max(minGap(bw), (W + bw) / 4)
    // Порядок в массиве — справа налево: последняя бутылка всегда самая левая
    for (let x = W * 0.45; x > -bw * 0.5; x -= gap) {
      const { jitter: _jitter, ...b } = nextBottle()
      items.current.push({ id: ++seq.current, x, ...b, state: 'moving', changedAt: 0, touchedAt: null })
      stats.current.bottles++
    }
    setFrame((f) => f + 1)
  }, [nextBottle])

  useEffect(() => {
    if (!running) return
    let raf = 0
    let last = performance.now()
    const bw0 = bottleWidth(width.current)
    let nextSpacing = Math.max(minGap(bw0), (width.current + bw0) / 4)
    let cues = speedupsFor(duration).filter((at) => at > clock.current)

    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      clock.current += dt
      const t = clock.current
      const W = width.current
      const bw = bottleWidth(W)
      const speed = (W + bw) / crossTime(t, duration, calm)
      if (cues.length && t >= cues[0]) {
        cues = cues.slice(1)
        handlers.current.onEvent?.('speedup')
      }
      beltOffset.current = (beltOffset.current + speed * dt) % 40

      // Пойманная бутылка замирает и гаснет — расстояние считаем от последней едущей
      const lastItem = items.current.findLast((i) => i.state === 'moving')
      // Новая бутылка, когда предыдущая отъехала на нужное расстояние
      // Бутылки идут до самого конца: в последние секунды лента полная, а не пустеет
      if ((!lastItem || lastItem.x + bw >= nextSpacing) && t < duration - 0.3) {
        // Тонкий брак: изредка во второй половине смены, чаще в финале
        const subtleChance = 0.15 * intensity(t, duration) + 0.75 * finale(t, duration)
        const { jitter, ...b } = nextBottle(subtleChance)
        items.current.push({ id: ++seq.current, x: -bw, ...b, state: 'moving', changedAt: 0, touchedAt: null })
        stats.current.bottles++
        nextSpacing = spacingPx(t, duration, W, bw, jitter)
      }

      const s = stats.current
      items.current = items.current.filter((it) => {
        if (it.state === 'caught') return t - it.changedAt < 0.55
        it.x += speed * dt
        if (it.x <= W) return true
        if (it.kind !== 'ok') {
          s.missed++
          if (it.subtle) s.subtleMissed++
          s.streak = 0
          floats.current.push({ id: ++seq.current, x: W - 90, text: 'Пропустили брак', tone: 'bad', bornAt: t })
          handlers.current.onEvent?.('miss')
        }
        return false
      })
      floats.current = floats.current.filter((f) => t - f.bornAt < 0.9)

      setFrame((f) => f + 1)
      if (t >= duration) {
        handlers.current.onEnd({ ...s, seconds: duration })
        return
      }
      raf = requestAnimationFrame(loop)
    }

    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [running, calm, duration, nextBottle])

  const hit = useCallback(
    (id: number) => {
      if (!running) return
      const it = items.current.find((i) => i.id === id)
      if (!it || it.state !== 'moving') return
      const s = stats.current
      const bw = bottleWidth(width.current)
      const center = it.x + bw / 2
      if (it.kind === 'ok') {
        if (it.touchedAt !== null) return
        it.touchedAt = clock.current
        s.mistakes++
        s.streak = 0
        s.score = Math.max(0, s.score - 5)
        floats.current.push({ id: ++seq.current, x: center, text: 'Это нормальная', sub: '−5', tone: 'bad', bornAt: clock.current })
        handlers.current.onEvent?.('mistake')
      } else {
        const points = 10 * multFor(s.streak)
        const multBefore = multFor(s.streak)
        it.state = 'caught'
        it.changedAt = clock.current
        s.caught++
        s.streak++
        s.score += points
        s.maxMult = Math.max(s.maxMult, multFor(s.streak))
        const leveledUp = multFor(s.streak) > multBefore
        floats.current.push({
          id: ++seq.current,
          x: center,
          text: DEFECT_NAMES[it.kind],
          sub: `+${points}`,
          tone: 'good',
          bornAt: clock.current,
        })
        handlers.current.onEvent?.('catch')
        // Новый множитель сообщаем после поимки, чтобы реакция на серию перекрыла обычную
        if (leveledUp) handlers.current.onEvent?.('combo')
      }
    },
    [running],
  )

  /** Клавиатура: снять бутылку, которая сейчас в рамке контроля. Нет бутылки в рамке — ничего не происходит */
  const hitZone = useCallback(() => {
    if (!running) return false
    const bw = bottleWidth(width.current)
    const zone = zoneCenter(width.current)
    const inZone = items.current
      .filter((it) => it.state === 'moving' && Math.abs(it.x + bw / 2 - zone) <= bw * 0.7)
      .sort((a, b) => Math.abs(a.x + bw / 2 - zone) - Math.abs(b.x + bw / 2 - zone))
    if (!inZone[0]) return false
    hit(inZone[0].id)
    return true
  }, [running, hit])

  const bw = bottleWidth(width.current)
  return {
    beltRef,
    width: width.current,
    bottleW: bw,
    bottleH: bottleHeight(bw),
    items: items.current,
    floats: floats.current,
    stats: stats.current,
    clock: clock.current,
    timeLeft: Math.max(0, duration - clock.current),
    duration,
    beltOffset: beltOffset.current,
    hit,
    hitZone,
    zone: zoneCenter(width.current),
    /** Сид текущего раунда — уходит в ссылку «Поделиться» */
    seed: seed.current,
    reset,
  }
}
