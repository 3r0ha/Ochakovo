import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Link } from 'react-router'
import { photos } from '@shared/photos'
import { stages, type Stage } from '@shared/content/production'
import { vacancyById } from '@shared/content/vacancies'
import { Photo } from '../components/Photo'
import { scrollToTarget, useReveal } from '../lib/motion'
import { nb } from '../lib/typo'
import { Dash, Duo, EstimateNote, payText, sectionTitle } from './kit'
import { QcFragment } from './QcFragment'
import { HEADER_OFFSET } from './tasks'

const ease = [0.16, 1, 0.3, 1] as const
const num = (i: number) => String(i + 1).padStart(2, '0')

/**
 * Кадр этапа. «Контроль качества» — рисунок линии из игры с бракованной бутылкой (QcFragment), а не фото.
 * Маленький снимок (лаборатория — 480 px) растянутым выглядел бы мыльным: он идёт монохромом через Duo
 * и не шире полутора своих размеров, по центру тёмной рамки. Остальные — обычным фото
 */
function StagePhoto({ stage, sizes, className = '' }: { stage: Stage; sizes: string; className?: string }) {
  if (stage.id === 'qc') return <QcFragment className={className} />
  const meta = photos[stage.photo]
  if (meta.w >= 960) return <Photo name={stage.photo} alt={stage.title} sizes={sizes} className={className} />
  return (
    <div className={`bg-night ${className}`} role="img" aria-label={stage.title}>
      <div className="mx-auto h-full" style={{ maxWidth: meta.w * 1.5 }}>
        <Duo name={stage.photo} sizes={`${Math.round(meta.w * 1.5)}px`} tone="mono" className="h-full" />
      </div>
    </div>
  )
}

/** Кто работает на этапе: должность и зарплата, ссылка на раскрытую вакансию */
function Workers({ stage }: { stage: Stage }) {
  const list = stage.vacancies.flatMap((id) => {
    const v = vacancyById(id)
    return v ? [v] : []
  })
  return (
    <div>
      <p className="font-display text-[17px] font-bold tracking-[0.08em] text-white/70 uppercase">Кто здесь работает</p>
      <ul className="mt-3 border-t border-white/25">
        {list.map((v) => (
          <li key={v.id} className="border-b border-white/15">
            <Link
              to={`/vacancies?open=${v.id}`}
              className="group flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3 transition-colors hover:text-brand"
            >
              <span className="font-display text-[clamp(22px,1.9vw,28px)] leading-[1] font-extrabold uppercase">{v.title}</span>
              {/* Сумма не рвётся, а «ориентир» при крупных интервалах уходит на следующую строку */}
              <span className="text-right font-display text-[clamp(20px,1.7vw,26px)] font-extrabold">
                <span className="whitespace-nowrap">{payText(v)}</span>
                <EstimateNote v={v} light />
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {stage.id === 'qc' && (
        <button
          onClick={() => scrollToTarget('#play', HEADER_OFFSET)}
          className="group mt-5 flex items-center gap-4 font-display text-[20px] font-extrabold tracking-[0.05em] text-brand uppercase hover:text-white"
        >
          Попробовать в «Поймай брак»
          <Dash />
        </button>
      )}
    </div>
  )
}

/** Десктоп: восемь этапов вдоль линии, под ней — открытый этап. Вкладки по правилам ARIA: фокус ходит стрелками */
function Stepper() {
  const [active, setActive] = useState(0)
  const stage = stages[active]
  const tabs = useRef<(HTMLButtonElement | null)[]>([])

  const go = (i: number, focus = false) => {
    const n = Math.min(stages.length - 1, Math.max(0, i))
    setActive(n)
    if (focus) tabs.current[n]?.focus()
  }

  const onKey = (e: KeyboardEvent) => {
    const keys: Record<string, number> = { ArrowRight: active + 1, ArrowLeft: active - 1, Home: 0, End: stages.length - 1 }
    if (!(e.key in keys)) return
    e.preventDefault()
    go(keys[e.key], true)
  }

  return (
    <div className="hidden md:block">
      <div className="relative mt-12">
        <div className="absolute top-[11px] right-0 left-0 h-[3px] bg-white/15" />
        <motion.div
          className="absolute top-[11px] left-0 h-[3px] bg-brand"
          animate={{ width: `${(active / (stages.length - 1)) * 100}%` }}
          transition={{ duration: 0.6, ease }}
        />
        <div className="relative grid grid-cols-8 gap-2" role="tablist" aria-label="Этапы производства" onKeyDown={onKey}>
          {stages.map((s, i) => (
              <button
                key={s.id}
                ref={(el) => {
                  tabs.current[i] = el
                }}
                role="tab"
                id={`path-tab-${s.id}`}
                aria-selected={i === active}
                aria-controls="path-panel"
                tabIndex={i === active ? 0 : -1}
                onClick={() => go(i)}
                className="group flex w-full flex-col items-start gap-3 text-left"
              >
                <span
                  className={`grid size-[25px] place-items-center border-[3px] transition-colors duration-300 ${
                    i <= active ? 'border-brand bg-brand' : 'border-white/30 bg-night group-hover:border-white'
                  }`}
                />
                <span className={`font-display text-[15px] font-bold tracking-[0.06em] uppercase ${i === active ? 'text-white' : 'text-white/60 group-hover:text-white'}`}>
                  {num(i)}
                </span>
                <span
                  className={`font-display text-[clamp(18px,1.5vw,22px)] leading-[1] font-extrabold uppercase transition-colors ${
                    i === active ? 'text-white' : 'text-white/60 group-hover:text-white'
                  }`}
                >
                  {s.title}
                </span>
              </button>
          ))}
        </div>
      </div>

      <div id="path-panel" className="mt-12 grid grid-cols-[1.15fr_1fr] gap-12 lg:gap-16" role="tabpanel" aria-labelledby={`path-tab-${stage.id}`}>
        <div className="relative aspect-[16/11] overflow-hidden bg-coal">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={stage.id}
              className="absolute inset-0"
              initial={{ opacity: 0, scale: 1.04 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.7, ease }}
            >
              <StagePhoto stage={stage} sizes="(min-width: 1440px) 720px, 52vw" className="absolute inset-0" />
            </motion.div>
          </AnimatePresence>
        </div>

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={stage.id}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.45, ease }}
            className="flex flex-col"
          >
            <p className="font-display text-[17px] font-bold tracking-[0.08em] text-white/70 uppercase">
              Этап {num(active)} из {num(stages.length - 1)}
            </p>
            <h3 className="mt-3 font-display text-[clamp(40px,4vw,64px)] leading-[0.9] font-black uppercase">{stage.title}</h3>
            <p className="mt-5 max-w-[520px] text-[18px] leading-relaxed text-white/80">{nb(stage.text)}</p>
            <div className="mt-8">
              <Workers stage={stage} />
            </div>
            <div className="mt-8 flex gap-3">
              <button
                onClick={() => go(active - 1)}
                disabled={active === 0}
                className="h-14 px-6 font-display text-[19px] font-extrabold tracking-[0.05em] uppercase ring-1 ring-white/60 ring-inset transition-colors enabled:hover:bg-white enabled:hover:text-ink disabled:cursor-not-allowed disabled:text-white/50 disabled:ring-white/20"
              >
                Назад
              </button>
              {active === stages.length - 1 ? (
                <Link
                  to="/vacancies"
                  className="group flex h-14 items-center gap-4 bg-brand px-6 font-display text-[19px] font-extrabold tracking-[0.05em] uppercase transition-colors hover:bg-white hover:text-brand"
                >
                  Все вакансии
                  <Dash />
                </Link>
              ) : (
                <button
                  onClick={() => go(active + 1)}
                  className="group flex h-14 items-center gap-4 bg-brand px-6 font-display text-[19px] font-extrabold tracking-[0.05em] uppercase transition-colors hover:bg-white hover:text-brand"
                >
                  {`Дальше: ${stages[active + 1].title}`}
                  <Dash />
                </button>
              )}
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  )
}

/**
 * Телефон: лента карточек листается пальцем. Карточка — фото и описание, а «кто здесь работает»
 * показываем один раз под лентой для текущего этапа: карточки одной высоты, без пустых хвостов
 */
function Strip() {
  const track = useRef<HTMLOListElement>(null)
  const [current, setCurrent] = useState(0)

  useEffect(() => {
    const el = track.current
    if (!el) return
    const onScroll = () => {
      const card = el.firstElementChild as HTMLElement | null
      if (!card) return
      const step = card.offsetWidth + 16
      setCurrent(Math.min(stages.length - 1, Math.round(el.scrollLeft / step)))
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  const scrollTo = (i: number) => {
    const el = track.current
    const card = el?.children[i] as HTMLElement | undefined
    if (el && card) el.scrollTo({ left: card.offsetLeft - el.offsetLeft - 20, behavior: 'smooth' })
  }

  return (
    <div className="md:hidden">
      <div className="container-x mt-8 flex items-center gap-3">
        <span className="font-display text-[17px] font-bold tracking-[0.08em] uppercase tabular-nums" aria-live="polite">
          {num(current)} / {num(stages.length - 1)}
        </span>
        <span className="relative h-[3px] flex-1 bg-white/15">
          <span
            className="absolute inset-y-0 left-0 bg-brand transition-[width] duration-300"
            style={{ width: `${((current + 1) / stages.length) * 100}%` }}
          />
        </span>
        <button
          onClick={() => scrollTo(current - 1)}
          disabled={current === 0}
          aria-label="Предыдущий этап"
          className="grid size-11 place-items-center font-display text-[22px] font-black ring-1 ring-white/60 ring-inset disabled:text-white/40 disabled:ring-white/20"
        >
          ←
        </button>
        <button
          onClick={() => scrollTo(current + 1)}
          disabled={current === stages.length - 1}
          aria-label="Следующий этап"
          className="grid size-11 place-items-center bg-brand font-display text-[22px] font-black disabled:bg-transparent disabled:text-white/40 disabled:ring-1 disabled:ring-white/20 disabled:ring-inset"
        >
          →
        </button>
      </div>
      <ol
        ref={track}
        className="mt-5 flex snap-x snap-mandatory items-start gap-4 overflow-x-auto overscroll-x-contain px-5 pb-2 [scrollbar-width:none]"
        aria-label="Этапы производства"
      >
        {stages.map((s, i) => (
          <li key={s.id} className="w-[84vw] max-w-[380px] shrink-0 snap-center" aria-current={i === current ? 'step' : undefined}>
            <StagePhoto stage={s} sizes="84vw" className="aspect-[4/3]" />
            <p className="mt-4 font-display text-[15px] font-bold tracking-[0.08em] text-white/70 uppercase">Этап {num(i)}</p>
            <h3 className="mt-1 font-display text-[40px] leading-[0.9] font-black uppercase">{s.title}</h3>
            <p className="mt-3 min-h-[calc(3lh)] text-[17px] leading-relaxed text-white/80">{nb(s.text)}</p>
          </li>
        ))}
      </ol>
      <div className="container-x mt-6">
        <Workers stage={stages[current]} />
      </div>
    </div>
  )
}

/** «Путь кваса»: производство от зерна до полки и люди на каждом этапе */
export function ProductionPath() {
  const title = useReveal<HTMLHeadingElement>()
  return (
    <section id="path" className="bg-night py-20 text-white md:py-28">
      <div className="container-x">
        <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
          <h2 ref={title} className={sectionTitle}>
            Путь кваса
          </h2>
          <p className="max-w-[440px] text-[18px] text-white/70 md:pb-2">
            {nb('Восемь этапов от зерна до магазина и должности на каждом из них.')}
          </p>
        </div>
        <Stepper />
      </div>
      <Strip />
    </section>
  )
}
