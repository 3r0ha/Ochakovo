import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router'
import { vacancyById } from '@shared/content/vacancies'
import { Mascot, type MascotPose } from '../components/Mascot'
import { Announce, say } from '../home/kit'
import { HEADER_OFFSET, nextTask } from '../home/tasks'
import { trackEvent } from '../lib/api'
import { prefersReducedMotion, scrollToTarget } from '../lib/motion'
import { inviteUrl } from '../lib/ref'
import { sfx } from '../lib/sfx'
import { nb } from '../lib/typo'
import { useOffscreenPause } from '../lib/useOffscreenPause'
import { useActivities } from '../store/activities'
import { useProfile } from '../store/profile'
import { Bottle, type BottleKind } from './Bottle'
import { challengeLine, compareLine, compareSpoken, encodeChallenge, newSeed, type Challenge } from './challenge'
import { BELT_H, BELT_Y, ConveyorStage, stageHeight } from './ConveyorStage'
import { DefectLegend } from './DefectLegend'
import { defectsTotal, offersJob, plural, scaleLine, shareText, verdict } from './result'
import { renderStory, saveStory, storyFileName } from './storyImage'
import { GAME_SECONDS, multFor, useConveyorGame, type GameEvent, type GameStats } from './useConveyorGame'

/** Почти чёрный, как фон сайта (--color-night): тёплый оттенок читался коричневым рядом с шапкой и подвалом */
export const NIGHT = '#0c0c0c'

const ease = [0.16, 1, 0.3, 1] as const
const DEMO: BottleKind[] = ['ok', 'nocap', 'ok', 'ok', 'lowfill', 'ok', 'label', 'ok']

export const btnRed =
  'inline-flex h-12 items-center justify-center gap-4 bg-brand px-7 font-display text-[19px] font-bold tracking-[0.06em] text-white uppercase transition-colors duration-300 hover:bg-white hover:text-brand sm:h-14 sm:text-[20px]'
export const btnGhost =
  'inline-flex h-12 items-center justify-center gap-4 px-7 font-display text-[19px] font-bold tracking-[0.06em] text-white uppercase ring-1 ring-white/60 ring-inset transition-colors duration-300 hover:bg-white hover:text-ink sm:h-14 sm:text-[20px]'
/** Подписи сцены — тем же шрифтом, что подписи секций */
const label = 'font-display text-[17px] font-bold tracking-[0.08em] uppercase'

type Phase = 'idle' | 'warmup' | 'countdown' | 'playing' | 'result'

/** Разминку показываем один раз — при первой игре */
const WARMUP_KEY = 'ochakovo.game.warmup'
const warmupSeen = () => {
  try {
    return localStorage.getItem(WARMUP_KEY) === '1'
  } catch {
    return true
  }
}
const markWarmupSeen = () => {
  try {
    localStorage.setItem(WARMUP_KEY, '1')
  } catch {
    // хранилище недоступно — разминка просто покажется ещё раз
  }
}

type Props = {
  className?: string
  /** Длительность раунда, сек */
  duration?: number
  /** Что показать под сценой после раунда — на странице игры подробности раунда */
  resultExtras?: (stats: GameStats) => ReactNode
  /** Результат, который прислал друг (/game?c=…): та же лента по сиду, строка над лентой и сравнение после раунда */
  challenge?: Challenge | null
}

/** «Поймай брак» прямо на странице: заставка с демо-лентой, раунд, итог */
export function InlineGame({ className = '', duration = GAME_SECONDS, resultExtras, challenge = null }: Props) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [count, setCount] = useState(3)
  const [result, setResult] = useState<GameStats | null>(null)
  const [prevBest, setPrevBest] = useState(0)
  const [cue, setCue] = useState<{ key: number; text: string } | null>(null)
  const best = useProfile((s) => s.conveyorBest)
  const root = useRef<HTMLDivElement>(null)
  const speedups = useRef(0)
  const seq = useRef(0)
  /** Сид раунда: из ссылки друга или новый на каждый раунд — он уходит в ссылку «Поделиться» */
  const roundSeed = useRef(challenge?.seed ?? newSeed())
  const [calm] = useState(prefersReducedMotion)
  const [message, setMessage] = useState<{ key: number; text: string } | null>(null)

  const onEvent = (e: GameEvent) => {
    if (e === 'catch') {
      sfx.pop()
      navigator.vibrate?.(15)
    } else if (e === 'combo') sfx.coin()
    else if (e === 'mistake') {
      sfx.error()
      navigator.vibrate?.([30, 40, 30])
    } else if (e === 'miss') sfx.tap()
    else if (e === 'speedup') {
      sfx.unlock()
      speedups.current++
      setCue({ key: ++seq.current, text: speedups.current > 1 ? 'Скоро финиш, смотри внимательнее' : 'Скорость растёт' })
    }
  }

  const game = useConveyorGame({
    running: phase === 'playing',
    calm,
    duration,
    onEvent,
    onEnd: (stats) => {
      setPrevBest(useProfile.getState().conveyorBest)
      useProfile.getState().setConveyorBest(stats.score)
      // Задание смены засчитывает раунд, где поймана хотя бы одна бутылка с браком: просто дождаться конца — не игра
      if (stats.caught > 0) useActivities.getState().complete('game')
      setResult(stats)
      setPhase('result')
      const total = defectsTotal(stats)
      const compare = challenge ? ` ${compareSpoken(stats.score, challenge.score)}` : ''
      setMessage(say(`Время вышло. ${stats.score} ${plural(stats.score, ['очко', 'очка', 'очков'])}, поймано ${stats.caught} из ${total}.${compare}`))
      sfx.fanfare()
    },
  })

  // Отсчёт перед стартом
  useEffect(() => {
    if (phase !== 'countdown') return
    if (count === 0) {
      setPhase('playing')
      const keys = window.matchMedia('(hover: hover) and (pointer: fine)').matches
      setMessage(say(`Смена началась, ${duration} секунд. Жми на бутылки с браком${keys ? ', с клавиатуры жми пробел, когда бутылка в рамке «Контроль»' : ''}.`))
      return
    }
    sfx.tap()
    const id = window.setTimeout(() => setCount((c) => c - 1), 500)
    return () => window.clearTimeout(id)
  }, [phase, count])

  useEffect(() => {
    if (!cue) return
    const id = window.setTimeout(() => setCue(null), 1300)
    return () => window.clearTimeout(id)
  }, [cue])

  // Последние 5 секунд — тиканье
  const secsLeft = Math.ceil(game.timeLeft)
  useEffect(() => {
    if (phase === 'playing' && secsLeft <= 5 && secsLeft > 0) sfx.tap()
  }, [phase, secsLeft])

  // Клавиатура во время смены: пробел или Enter снимает бутылку в рамке контроля
  useEffect(() => {
    if (phase !== 'playing') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== ' ' && e.key !== 'Enter') return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      e.preventDefault()
      game.hitZone()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, game.hitZone])

  const countdown = () => {
    // Фокус — на саму игру: пробел работает сразу, а читалка понимает, где мы
    root.current?.focus({ preventScroll: true })
    // Вызов друга — всегда его лента, и при «Ещё раз» тоже; иначе каждый раунд — новая
    roundSeed.current = challenge?.seed ?? newSeed()
    game.reset(roundSeed.current)
    speedups.current = 0
    setCue(null)
    setResult(null)
    setCount(3)
    setPhase('countdown')
  }

  const start = () => {
    // На телефоне лента должна быть целиком на экране
    const top = root.current?.getBoundingClientRect().top ?? 0
    if (root.current && (top < 0 || top > window.innerHeight * 0.35)) scrollToTarget(root.current, -88)
    if (warmupSeen()) countdown()
    else {
      setResult(null)
      setPhase('warmup')
    }
  }

  const finishWarmup = () => {
    markWarmupSeen()
    countdown()
  }

  const live = phase === 'countdown' || phase === 'playing'
  const s = game.stats
  const total = result ? defectsTotal(result) : 0

  return (
    <div
      ref={root}
      tabIndex={-1}
      role="region"
      aria-label="Игра «Поймай брак»"
      className={`relative isolate overflow-hidden text-white outline-none ${className}`}
      style={{ background: NIGHT }}
    >
      <Announce message={message} />
      <style>{`
        @keyframes ig-roll { from { transform: translateX(-50%) } to { transform: translateX(0) } }
        @keyframes ig-stripes { from { transform: translateX(-40px) } to { transform: translateX(0) } }
        @media (prefers-reduced-motion: reduce) { .ig-anim { animation: none !important } }
      `}</style>
      {/* Глубина сцены: светлее в середине и красное свечение под лентой */}
      <div
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            'radial-gradient(90% 55% at 50% 100%, rgb(213 0 50 / 0.18) 0%, transparent 60%), radial-gradient(110% 80% at 50% 35%, #1a1a1a 0%, #0c0c0c 72%)',
        }}
      />

      <div className="px-5 pt-5 md:px-8 md:pt-7">
        {live ? (
          <Hud score={s.score} streak={s.streak} timeLeft={game.timeLeft} duration={duration} />
        ) : (
          <div className={`flex items-center justify-between gap-4 whitespace-nowrap text-white/75 ${label}`}>
            {/* Название игры уже в заголовке над сценой — здесь только длина раунда */}
            <span>Раунд · {duration}&nbsp;секунд</span>
            <span className="flex items-center gap-5">
              {best > 0 && (
                <span className="hidden sm:inline">
                  Лучший результат <span className="text-white">{best}</span>
                </span>
              )}
              <MuteToggle />
            </span>
          </div>
        )}
        {/* Прислали результат: над лентой, пока раунд не начался */}
        {challenge && (phase === 'idle' || phase === 'warmup') && (
          <p data-game-challenge className="mt-4 max-w-[640px] border-l-[3px] border-brand pl-3 text-[15px] leading-snug text-white md:text-[17px]">
            {nb(challengeLine(challenge))}
          </p>
        )}
      </div>

      {phase === 'result' && result ? (
        <ResultPanel
          stats={result}
          total={total}
          best={Math.max(best, result.score)}
          record={prevBest > 0 && result.score > prevBest}
          minHeight={stageHeight(game.bottleH)}
          onReplay={start}
          seed={roundSeed.current}
          challenge={challenge}
        />
      ) : (
      <ConveyorStage
        tone="dark"
        beltRef={game.beltRef}
        width={game.width}
        items={live ? game.items : []}
        floats={live ? game.floats : []}
        bottleW={game.bottleW}
        bottleH={game.bottleH}
        beltOffset={game.beltOffset}
        clock={game.clock}
        onHit={game.hit}
        zone={phase === 'playing' ? game.zone : undefined}
        calm={calm}
        underlay={!live && phase !== 'warmup' && <DemoBelt bottleW={game.bottleW} bottleH={game.bottleH} />}
        overlay={
          <>
            {phase === 'idle' && (
              <IdleOverlay
                onStart={() => {
                  // Нажали «Играть» — событие воронки без очков; «Ещё раз» его не повторяет
                  trackEvent('game_start')
                  start()
                }}
              />
            )}
            {phase === 'warmup' && <Warmup onDone={finishWarmup} />}
            <AnimatePresence>
              {phase === 'countdown' && count > 0 && (
                <motion.div
                  key={count}
                  initial={{ opacity: 0, scale: 1.3 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.85 }}
                  transition={{ duration: 0.28, ease }}
                  className="display pointer-events-none absolute inset-0 grid place-items-center text-[clamp(120px,22vw,220px)] text-brand"
                >
                  {count}
                </motion.div>
              )}
            </AnimatePresence>
            <AnimatePresence>
              {cue && (
                <motion.div
                  key={cue.key}
                  initial={{ opacity: 0, y: -14 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.4, ease }}
                  className="pointer-events-none absolute inset-x-0 top-3 flex justify-center"
                >
                  <span className="display bg-brand px-5 py-1.5 text-[24px] text-white md:text-[30px]">{cue.text}</span>
                </motion.div>
              )}
            </AnimatePresence>
          </>
        }
      />
      )}

      <div className="px-5 pt-1 pb-6 md:px-8 md:pb-8">
        {phase === 'idle' && (
          <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-[17px] text-white/85">Какой бывает брак:</p>
              <p className="sr-only mt-1 text-[15px] text-white/70 [@media(hover:hover)_and_(pointer:fine)_and_(min-width:768px)]:not-sr-only">
                С&nbsp;клавиатуры: пробел снимает бутылку в&nbsp;рамке «Контроль».
              </p>
              <DefectLegend className="mt-5" />
            </div>
          </div>
        )}
        {phase === 'result' && result && resultExtras?.(result)}
      </div>
    </div>
  )
}

/** Лента на заставке: бутылки медленно едут сами, пока не нажали «Играть» */
function DemoBelt({ bottleW, bottleH }: { bottleW: number; bottleH: number }) {
  const row = [...DEMO, ...DEMO]
  // Заставка далеко внизу страницы — пока её не видно, лента стоит
  const { ref, paused } = useOffscreenPause<HTMLDivElement>()
  const playState = paused ? 'paused' : 'running'
  return (
    <>
      {/* Рёбра ленты двигает transform — без перерисовки каждый кадр; едут вправо, к складу, как в игре */}
      <div
        ref={ref}
        className="pointer-events-none absolute inset-x-0 overflow-hidden"
        style={{ bottom: BELT_Y, height: BELT_H, backgroundColor: '#1c1c1c', boxShadow: 'inset 0 1px 0 var(--color-brand)' }}
      >
        <div
          className="ig-anim absolute inset-y-0 right-0 -left-10"
          style={{
            backgroundImage: 'repeating-linear-gradient(90deg, rgba(255,255,255,0.07) 0 2px, transparent 2px 40px)',
            animation: 'ig-stripes 0.55s linear infinite',
            animationPlayState: playState,
          }}
        />
      </div>
      <div
        className="ig-anim pointer-events-none absolute left-0 flex w-max"
        // Отступ справа равен зазору: половина ряда ровно повторяет вторую, без рывка на стыке
        style={{ bottom: BELT_Y + BELT_H - 1, gap: bottleW * 0.9, paddingRight: bottleW * 0.9, animation: `ig-roll ${DEMO.length * 2.4}s linear infinite`, animationPlayState: playState }}
        aria-hidden="true"
      >
        {row.map((kind, i) => (
          <div key={i} style={{ width: bottleW, height: bottleH }} className="opacity-45">
            <Bottle kind={kind} tone="dark" className="size-full" />
          </div>
        ))}
      </div>
    </>
  )
}

function IdleOverlay({ onStart }: { onStart: () => void }) {
  return (
    <div className="absolute inset-0 grid place-items-center bg-[radial-gradient(60%_55%_at_50%_45%,rgb(12_12_12/0.8)_0%,rgb(12_12_12/0.35)_100%)]">
      {/* Правило — прямо над кнопкой: до нажатия видно, что делать; картинки брака — в легенде под лентой */}
      <div className="-mt-6 flex flex-col items-center gap-3">
        <p className="text-center text-[17px] font-medium text-white md:text-[19px]">Жми на&nbsp;брак, нормальные пропускай</p>
        <button
          onClick={onStart}
          className="group flex h-16 items-center gap-5 bg-brand px-10 text-white transition-colors duration-300 hover:bg-white hover:text-brand md:h-20 md:px-12"
        >
          <span className="display text-[36px] md:text-[44px]">Играть</span>
          <span className="block h-[3px] w-8 bg-current transition-[width] duration-500 ease-out-expo group-hover:w-12" aria-hidden="true" />
        </button>
      </div>
      <div className="absolute right-8 bottom-[70px] hidden lg:block">
        <Mascot pose="inspector" dark className="h-52 w-40" />
      </div>
    </div>
  )
}

/** Разминка перед первой игрой: две бутылки, одна с браком. Без таймера, можно пропустить */
function Warmup({ onDone }: { onDone: () => void }) {
  const [order] = useState(() => (Math.random() < 0.5 ? (['ok', 'nocap'] as const) : (['nocap', 'ok'] as const)))
  const [state, setState] = useState<'ask' | 'wrong' | 'right'>('ask')
  const first = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    first.current?.focus({ preventScroll: true })
  }, [])

  // Клавиши 1 и 2 — выбор бутылки с клавиатуры
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '1' || e.key === '2') pick(order[Number(e.key) - 1])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  useEffect(() => {
    if (state !== 'right') return
    const id = window.setTimeout(onDone, 1100)
    return () => window.clearTimeout(id)
  }, [state, onDone])

  const pick = (kind: 'ok' | 'nocap') => {
    if (state === 'right') return
    if (kind === 'nocap') {
      sfx.pop()
      setState('right')
    } else {
      sfx.error()
      setState('wrong')
    }
  }

  const text =
    state === 'right'
      ? 'Верно: у этой нет крышки. Теперь то же самое на скорость.'
      : state === 'wrong'
        ? 'Эта нормальная, её пропускай. Найди бутылку с браком.'
        : 'Тренировка. У одной бутылки брак, нажми на неё.'

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-[rgb(12_10_8/0.92)] px-5 text-center">
      <p className={`max-w-[440px] text-[17px] leading-snug md:text-xl ${state === 'wrong' ? 'text-brand' : 'text-white'}`} role="status">
        {text}
      </p>
      <div className="flex items-end gap-8 md:gap-14">
        {order.map((kind, i) => (
          <button
            key={kind}
            ref={i === 0 ? first : undefined}
            onClick={() => pick(kind)}
            aria-label={`Бутылка ${i + 1}`}
            className={`relative h-[150px] w-[64px] outline-none transition-transform duration-300 focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-8 focus-visible:ring-offset-[#0c0a08] md:h-[190px] md:w-[80px] ${
              state === 'right' && kind === 'nocap' ? '-translate-y-3' : 'hover:-translate-y-1'
            }`}
          >
            <Bottle kind={kind} tone="dark" className="size-full" />
            <span className="absolute -bottom-7 left-1/2 -translate-x-1/2 text-[13px] text-white/45 tabular-nums">{i + 1}</span>
          </button>
        ))}
      </div>
      <button onClick={onDone} className="mt-3 -mb-3 py-3 text-[15px] text-white/75 underline decoration-white/40 underline-offset-4 hover:text-white">
        Пропустить тренировку
      </button>
    </div>
  )
}

/**
 * «Поделиться результатом»: системное меню на телефоне, иначе ссылка в буфер обмена.
 * Ссылка — приглашение с личным кодом браузера и вызовом: /game?c=<сид>-<очки>-<поймано>-<лишние>-<брака>&src=ref_<код>.
 * Друг попадает сразу в игру, на ту же ленту, и видит присланный результат
 */
function useShare(stats: GameStats, seed: number) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const url = inviteUrl(`/game?c=${encodeChallenge({ seed, score: stats.score, caught: stats.caught, extra: stats.mistakes, total: defectsTotal(stats) })}`)
  const text = shareText(stats)

  const share = async () => {
    // Событие воронки — одно на нажатие, без очков
    trackEvent('share', { kind: 'game' })
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Поймай брак', text, url })
        return
      }
      await navigator.clipboard.writeText(`${text} ${url}`)
      setState('copied')
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return
      setState('failed')
    }
  }
  const status = state === 'copied' ? 'Ссылка скопирована' : state === 'failed' ? `Скопируй ссылку: ${url}` : ''
  return { share, status }
}

/** «Сохранить картинку»: PNG для сторис через меню «Поделиться» с файлом, иначе скачивание */
function useStory(stats: GameStats) {
  const [state, setState] = useState<'idle' | 'busy' | 'downloaded' | 'failed'>('idle')
  const save = async () => {
    if (state === 'busy') return
    setState('busy')
    try {
      const blob = await renderStory(stats)
      const how = await saveStory(blob, storyFileName(stats))
      setState(how === 'downloaded' ? 'downloaded' : 'idle')
    } catch {
      setState('failed')
    }
  }
  const status = state === 'downloaded' ? 'Картинка сохранена' : state === 'failed' ? 'Картинку сохранить не получилось' : ''
  return { save, busy: state === 'busy', status }
}

/** Квасыч реагирует на тот же счёт, что и разбор: за нажатия по всему подряд он не радуется */
function verdictPose(stats: GameStats): MascotPose {
  const total = defectsTotal(stats)
  if (total === 0 || stats.mistakes >= 3) return 'meh'
  const share = stats.caught / total
  return share >= 0.9 && stats.mistakes <= 1 ? 'wow' : share >= 0.6 ? 'thumbs' : 'meh'
}

type ResultProps = {
  stats: GameStats
  total: number
  best: number
  record: boolean
  /** Высота как у сцены: итог встаёт на место ленты без скачка страницы */
  minHeight: number
  onReplay: () => void
  /** Сид раунда — для ссылки «Поделиться» */
  seed: number
  /** Присланный результат: сравнение и «Откликнуться вдвоём» */
  challenge: Challenge | null
}

/** Итог раунда — в потоке страницы, а не поверх ленты: на телефоне кнопки не вылезают за сцену */
function ResultPanel({ stats, total, best, record, minHeight, onReplay, seed, challenge }: ResultProps) {
  // Работу оператора предлагаем только за точный раунд: весь брак снят, нормальные почти не тронуты
  const sharp = offersJob(stats)
  const operator = vacancyById('bottling-operator')
  const heading = useRef<HTMLHeadingElement>(null)
  const { share, status: shareStatus } = useShare(stats, seed)
  const story = useStory(stats)
  const status = story.status || shareStatus
  const done = useActivities((s) => s.done)
  const next = nextTask(done, 'game')
  const onHome = useLocation().pathname === '/'

  useEffect(() => {
    heading.current?.focus({ preventScroll: true })
  }, [])

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease }}
      className="relative flex flex-col justify-center px-5 py-6 md:px-10"
      style={{ minHeight }}
    >
      <h3 ref={heading} tabIndex={-1} className="outline-none">
        <span className={`block text-white/75 ${label}`}>{record ? 'Новый рекорд' : 'Время вышло'}</span>
        <span className="mt-2 flex items-baseline gap-3">
          <span className="display text-[clamp(80px,13vw,160px)] leading-[0.8] tabular-nums">{stats.score}</span>
          <span className="display text-[clamp(28px,3.4vw,44px)] text-white/75">{plural(stats.score, ['очко', 'очка', 'очков'])}</span>
        </span>
      </h3>
      <p className="mt-3 text-[15px] text-white/75 md:text-[17px]">
        Поймано {stats.caught} из&nbsp;{total} · лучший результат {best}
      </p>
      {/* Вызов друга: два числа рядом, без соревнования и оценок */}
      {challenge && (
        <p data-game-compare className="display mt-4 text-[clamp(30px,3.6vw,48px)]">
          {compareLine(stats.score, challenge.score)}
        </p>
      )}
      <p className="mt-3 max-w-[560px] text-[17px] leading-snug md:text-xl">
        {verdict(stats)}
        {sharp && operator?.pay && (
          <>
            {' '}{operator.title} снимает брак на&nbsp;выходе и&nbsp;получает{' '}
            <span className="font-semibold whitespace-nowrap">от {operator.pay.from.toLocaleString('ru-RU')}&nbsp;₽</span> в&nbsp;месяц.
          </>
        )}
      </p>
      <p className="mt-3 max-w-[560px] text-[15px] leading-snug text-white/75 md:text-[17px]" data-game-scale>
        {scaleLine(stats)}
      </p>
      {/* Телефон: «Откликнуться» во всю ширину, под ним «Ещё раз» и «Дальше» парой; поделиться — ссылками ниже */}
      <div className="mt-6 grid grid-cols-2 gap-2.5 sm:flex sm:flex-wrap sm:gap-3">
        {challenge ? (
          // Пришли по вызову друга: в заявке сразу отмечено «Иду с другом»
          <Link to={sharp ? '/apply?vacancy=bottling-operator&friend=1' : '/apply?friend=1'} className={`${btnRed} col-span-2`}>
            Откликнуться вдвоём
          </Link>
        ) : (
          <Link to={sharp ? '/apply?vacancy=bottling-operator' : '/apply'} className={`${btnRed} col-span-2`}>
            Откликнуться
          </Link>
        )}
        <button onClick={onReplay} className={`${btnGhost} ${next ? '' : 'col-span-2'} max-sm:px-3`}>
          Ещё раз
        </button>
        {next &&
          (onHome ? (
            <button onClick={() => scrollToTarget(next.anchor, HEADER_OFFSET)} className={`${btnGhost} max-sm:h-auto max-sm:min-h-12 max-sm:px-3 max-sm:py-2 max-sm:text-center max-sm:leading-tight`}>
              Дальше: {next.label}
            </button>
          ) : (
            <Link to={`/${next.anchor}`} className={`${btnGhost} max-sm:h-auto max-sm:min-h-12 max-sm:px-3 max-sm:py-2 max-sm:text-center max-sm:leading-tight`}>
              Дальше: {next.label}
            </Link>
          ))}
      </div>
      <div className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <button
          onClick={share}
          className="-my-2 py-2 text-[15px] text-white/75 underline decoration-white/40 underline-offset-4 hover:text-white"
        >
          Поделиться результатом
        </button>
        <button
          onClick={story.save}
          disabled={story.busy}
          data-game-story
          className="-my-2 py-2 text-[15px] text-white/75 underline decoration-white/40 underline-offset-4 hover:text-white disabled:opacity-60"
        >
          Сохранить картинку для сторис
        </button>
        <p className="min-h-[1.4em] text-[15px] text-white/75" role="status">
          {status}
        </p>
      </div>
      <div className="absolute right-8 bottom-8 hidden xl:block">
        <Mascot pose={verdictPose(stats)} dark className="h-52 w-40" />
      </div>
    </motion.div>
  )
}

function Hud({ score, streak, timeLeft, duration }: { score: number; streak: number; timeLeft: number; duration: number }) {
  const secs = Math.ceil(timeLeft)
  const finale = secs <= 5
  const mult = multFor(streak)
  const filled = Math.min(streak, 6)
  return (
    <div>
      <div className="grid grid-cols-3 items-end">
        <div>
          <p className={`text-white/70 ${label}`}>Очки</p>
          <motion.p
            key={score}
            initial={{ y: score > 0 ? -6 : 0 }}
            animate={{ y: 0 }}
            transition={{ type: 'spring', stiffness: 500, damping: 20 }}
            className="display mt-1 text-[clamp(48px,7vw,76px)] tabular-nums"
          >
            {score}
          </motion.p>
        </div>
        <div className="flex flex-col items-center">
          <p className={`text-white/70 ${label}`}>Серия</p>
          <motion.p
            key={mult}
            initial={{ scale: mult > 1 ? 1.5 : 1 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 420, damping: 16 }}
            className={`display mt-1 text-[clamp(48px,7vw,76px)] ${mult > 1 ? 'text-brand' : 'text-white/40'}`}
          >
            ×{mult}
          </motion.p>
          <div className="mt-1 flex w-24 gap-1">
            {Array.from({ length: 6 }, (_, i) => (
              <span key={i} className={`h-1 flex-1 transition-colors duration-200 ${i < filled ? 'bg-brand' : 'bg-white/15'} ${i === 2 ? 'mr-1' : ''}`} />
            ))}
          </div>
        </div>
        <div className="text-right">
          <p className={`${label} ${finale ? 'text-white' : 'text-white/70'}`}>Осталось</p>
          <motion.p
            key={finale ? secs : 'steady'}
            initial={{ scale: finale ? 1.3 : 1 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 400, damping: 15 }}
            className={`display mt-1 origin-right text-[clamp(48px,7vw,76px)] tabular-nums ${finale ? 'text-brand' : ''}`}
          >
            0:{String(secs).padStart(2, '0')}
          </motion.p>
        </div>
      </div>
      <div className="mt-3 h-[2px] bg-white/12">
        <div className="h-full bg-brand" style={{ width: `${(timeLeft / duration) * 100}%` }} />
      </div>
    </div>
  )
}

function MuteToggle() {
  const muted = useProfile((s) => s.muted)
  const toggle = useProfile((s) => s.toggleMuted)
  return (
    <button onClick={toggle} className="h-9 px-3 ring-1 ring-white/50 ring-inset transition-colors hover:bg-white hover:text-ink">
      Звук: {muted ? 'выкл' : 'вкл'}
    </button>
  )
}
