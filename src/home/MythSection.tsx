import { AnimatePresence, motion, useMotionValue, useTransform, type PanInfo } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Photo } from '../components/Photo'
import { buildDeck, type MythCard as Card } from '@shared/content/content'
import { scrollToTarget } from '../lib/motion'
import { nb } from '../lib/typo'
import { useActivities } from '../store/activities'
import { Announce, NextStep, say, sectionTitle, TaskLabel } from './kit'
import { KnowledgeCheck } from './KnowledgeCheck'
import { HEADER_OFFSET, mythFigure } from './tasks'

const ease = [0.16, 1, 0.3, 1] as const

/** Новая колода; повтор не отдаёт ту же, что была */
function freshDeck(prev?: Card[]) {
  const key = (d: Card[]) => d.map((c) => c.id).join()
  let deck = buildDeck()
  for (let i = 0; prev && i < 8 && key(deck) === key(prev); i++) deck = buildDeck()
  return deck
}

const NUMBER = '\\d[\\d\\u00A0\\u202F /]*\\d|\\d'
/**
 * «12 часов» → число «12» и подпись «часов». Несколько чисел («610 · 807») — целиком числом,
 * слово без числа («Без опыта») — целиком подписью
 */
function splitFigure(text: string) {
  const m = new RegExp(`^\\s*(${NUMBER})\\s*(.*)$`).exec(text)
  if (!m) return { num: '', rest: text.trim() }
  if (/\d/.test(m[2])) return { num: text.trim(), rest: '' }
  return { num: m[1].trim(), rest: m[2].trim() }
}

/**
 * Число на карточке до ответа — из самого утверждения: «7 000 бутылок в час», а после ответа «70 000».
 * В утверждении нет числа — до ответа обложка «Правда или миф»: цифра карточки («2 раза в месяц») выдала бы ответ
 */
function figureBefore(card: Card, truth: string) {
  const t = splitFigure(truth)
  if (!t.num || !t.rest) return null
  const unit = t.rest.split(/\s+/)[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`(${NUMBER})\\s*${unit}`, 'i').exec(card.claim)
  return m ? { num: m[1].trim(), rest: t.rest } : null
}

/** Позиционирование задаёт вызывающий (absolute на карточке), иначе relative — внутри лежит абсолютный слой */
const place = (className: string) => (/\b(absolute|fixed|sticky)\b/.test(className) ? '' : 'relative')

/** Плашка с числом: число фирменным красным на тёмном, размер подстраивается под ширину карточки */
function Figure({ num, rest, className = '' }: { num: string; rest: string; className?: string }) {
  const len = num.replace(/\s/g, '').length
  const size = len <= 2 ? 40 : len <= 3 ? 36 : len <= 5 ? 30 : len <= 7 ? 24 : 18
  return (
    <div className={`${place(className)} overflow-hidden bg-coal text-white [container-type:inline-size] ${className}`}>
      <div className="absolute inset-0 flex flex-col justify-end p-[6cqi]">
        {num && (
          <span className="font-display leading-[0.78] font-black whitespace-nowrap text-brand-bright tabular-nums" style={{ fontSize: `${size}cqi` }}>
            {num}
          </span>
        )}
        {rest && (
          <span className={`font-display leading-[0.88] font-black uppercase ${num ? 'mt-[2cqi] text-[9cqi]' : 'text-[19cqi]'}`}>{nb(rest)}</span>
        )}
      </div>
    </div>
  )
}

/** Обложка карточки до ответа, когда число выдало бы ответ */
function Cover({ className = '' }: { className?: string }) {
  return (
    <div className={`${place(className)} overflow-hidden bg-coal [container-type:inline-size] ${className}`} aria-hidden="true">
      <p className="absolute inset-x-0 bottom-0 p-[6cqi] font-display text-[19cqi] leading-[0.84] font-black text-white uppercase">
        Правда
        <br />
        <span className="text-brand-bright">или миф</span>
      </p>
    </div>
  )
}

/** Иллюстрация карточки: число (до ответа — число из утверждения или обложка) или архивное фото */
function CardPicture({ card, answered, sizes, className = '' }: { card: Card; answered: boolean; sizes: string; className?: string }) {
  const truth = mythFigure(card)
  if (truth) {
    const f = answered ? splitFigure(truth) : figureBefore(card, truth)
    return f ? <Figure num={f.num} rest={f.rest} className={className} /> : <Cover className={className} />
  }
  if (card.photo) return <Photo name={card.photo} alt="" sizes={sizes} className={className} imgClassName="brightness-[0.9]" />
  return <div className={`bg-coal ${className}`} />
}

/** Итог: счёт и один конкретный вывод — с карточки, на которой ошибся первым */
function resultLine(score: number, total: number, card: Card) {
  if (score === total) return `${score} из ${total}, все ответы верные`
  if (score >= 3) return `${score} из ${total}. Теперь знаешь и то, что ${card.takeaway}`
  return `${score} из ${total}. Зато теперь знаешь, что ${card.takeaway}`
}

const countWord: Record<number, string> = { 3: 'Три', 4: 'Четыре', 5: 'Пять', 6: 'Шесть', 7: 'Семь' }

/**
 * Задание «Правда или миф»: колода из buildDeck — факты о заводе и о работе. Свайп вправо — правда, влево — миф.
 * «Сыграть ещё раз» раздаёт новую колоду
 */
export function MythSection() {
  const complete = useActivities((s) => s.complete)
  const [deck, setDeck] = useState(() => freshDeck())
  const [index, setIndex] = useState(0)
  const [answer, setAnswer] = useState<boolean | null>(null)
  /** Верно ли ответил на каждую карточку — для счёта и факта на итоге */
  const [results, setResults] = useState<boolean[]>([])
  const [message, setMessage] = useState<{ key: number; text: string } | null>(null)
  const score = results.filter(Boolean).length

  const total = deck.length
  const finished = index >= total
  const card = deck[Math.min(index, total - 1)]
  const correct = answer !== null && answer === card.truth
  const section = useRef<HTMLElement>(null)
  const stack = useRef<HTMLDivElement>(null)
  // Фокус переводим только после действия человека — на новую карточку, разбор ответа или итог
  const moveFocus = useRef(false)
  const focusOnMount = useCallback((el: HTMLElement | null) => {
    if (!el || !moveFocus.current) return
    moveFocus.current = false
    el.focus({ preventScroll: true })
  }, [])

  const pick = (value: boolean) => {
    if (answer !== null || finished) return
    navigator.vibrate?.(10)
    moveFocus.current = true
    setAnswer(value)
    const next = [...results, value === card.truth]
    setResults(next)
    setMessage(say(`Счёт: ${next.filter(Boolean).length} из ${total}`))
  }
  const next = () => {
    const n = index + 1
    moveFocus.current = true
    setAnswer(null)
    setIndex(n)
    if (n >= total) {
      complete('myth')
      setMessage(say(`Итог: ${score} из ${total}`))
    }
    // Новая карточка не должна прятаться под шапкой: на телефоне фото уезжало вверх
    requestAnimationFrame(() => {
      const el = stack.current
      if (el && el.getBoundingClientRect().top < -HEADER_OFFSET) scrollToTarget(el, HEADER_OFFSET - 12)
    })
  }
  const restart = () => {
    moveFocus.current = true
    setDeck(freshDeck(deck))
    setIndex(0)
    setResults([])
    setAnswer(null)
  }
  // На итоге — факт, который стоит запомнить: первый, где ответ был неверным, иначе первый по порядку
  const wrong = results.findIndex((r) => !r)
  const keep = deck[wrong >= 0 ? wrong : 0]

  // Стрелки ← и → отвечают, Enter — следующий факт. Только когда фокус внутри секции: иначе стрелки нужны другим блокам
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (finished || !section.current?.contains(document.activeElement)) return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (answer === null && e.key === 'ArrowLeft') pick(false)
      else if (answer === null && e.key === 'ArrowRight') pick(true)
      else if (answer !== null && e.key === 'Enter' && tag !== 'BUTTON' && tag !== 'A') next()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <section ref={section} id="myth" className="overflow-hidden bg-white py-20 text-ink md:py-28">
      <Announce message={message} />
      <div className="container-x grid grid-cols-[minmax(0,1fr)] gap-x-16 gap-y-10 lg:grid-cols-[1fr_minmax(0,500px)] lg:items-start">
        <div>
          <TaskLabel id="myth" />
          <h2 className={`mt-6 ${sectionTitle}`}>
            Правда
            <br />
            <span className="text-brand">или миф</span>
          </h2>
          <p className="mt-5 max-w-[380px] text-[17px] leading-relaxed text-ink/70">
            {nb(`${countWord[total] ?? total} фактов о\u00A0заводе и\u00A0работе.`)}{' '}
            {/* Палец — свайп, мышь — кнопки и стрелки */}
            <span className="[@media(hover:hover)_and_(pointer:fine)]:hidden">{nb('Свайп вправо, если правда, и влево, если миф.')}</span>
            <span className="hidden [@media(hover:hover)_and_(pointer:fine)]:inline">{nb('Отвечай кнопками «Миф» и «Правда» или стрелками ← и →.')}</span>
          </p>

          {/* Счёт — одно место на всю игру */}
          <div className="mt-8 border-t-[3px] border-ink pt-4">
            <div className="flex items-end gap-4">
              <p className="font-display text-[clamp(64px,7vw,112px)] leading-[0.8] font-black tabular-nums">
                {score}
                <span className="text-ink/60">/{total}</span>
              </p>
              <p className="pb-1 font-display text-[17px] font-bold tracking-[0.08em] text-mute uppercase">
                верных
                <br />
                ответов
              </p>
            </div>
            <div className="mt-4 flex gap-1.5" aria-hidden="true">
              {deck.map((_, i) => (
                <span key={i} className={`h-1 flex-1 ${i < index ? 'bg-ink' : i === index && !finished ? 'bg-brand' : 'bg-ink/15'}`} />
              ))}
            </div>
          </div>

          {finished && (
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, ease }}
              className="mt-10 grid grid-cols-[minmax(0,1fr)] gap-5 sm:grid-cols-[180px_minmax(0,1fr)]"
            >
              <CardPicture card={keep} answered sizes="180px" className="aspect-square max-w-[240px]" />
              <div>
                <p className="font-display text-[17px] font-bold tracking-[0.08em] text-mute uppercase">
                  {wrong >= 0 ? 'Почему так' : 'Стоит запомнить'}
                </p>
                {/* Миф зачёркнут, крупно то, что на самом деле: иначе крупное утверждение читается как правда */}
                {keep.truth ? (
                  <p className="mt-2 font-display text-[clamp(26px,2.4vw,34px)] leading-[0.95] font-extrabold uppercase">
                    <span className="text-leaf">Правда: </span>
                    {nb(keep.claim)}
                  </p>
                ) : (
                  <>
                    <p className="mt-2 text-[17px] leading-snug text-ink/55">
                      <span className="font-semibold text-brand">Миф: </span>
                      <s className="decoration-brand decoration-2">{nb(keep.claim)}</s>
                    </p>
                    <p className="mt-2 font-display text-[clamp(26px,2.4vw,34px)] leading-[0.95] font-extrabold uppercase">{nb(keep.fact)}</p>
                  </>
                )}
                <p className="mt-2 text-[16px] leading-relaxed text-ink/80">{nb(keep.explain)}</p>
              </div>
            </motion.div>
          )}
        </div>

        <div ref={stack} className="relative mx-auto mt-5 w-full max-w-[500px] lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:mt-5">
          {!finished &&
            [2, 1].map((d) =>
              index + d < total ? (
                // Следующие карточки выглядывают сверху узкими краями, как колода: снизу они читались бы как серая тень
                <div
                  key={d}
                  aria-hidden="true"
                  className="absolute inset-x-0 top-0 h-full origin-top bg-ink"
                  style={{ transform: `translateY(${-d * 9}px) scale(${1 - d * 0.05})`, opacity: 1 - d * 0.3 }}
                />
              ) : null,
            )}

          <AnimatePresence mode="popLayout" initial={false}>
            {finished ? (
              <motion.div
                key="done"
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, ease }}
                className="relative bg-ink p-6 text-white md:p-8"
              >
                <h3 ref={focusOnMount} tabIndex={-1} className="font-display text-[clamp(30px,3vw,40px)] leading-[0.95] font-black uppercase outline-none">
                  {resultLine(score, total, keep)}
                </h3>
                <NextStep after="myth" className="mt-7" />
                <button onClick={restart} className="mt-2 -mb-3 py-3 text-[15px] text-white/75 underline decoration-white/40 underline-offset-4 hover:text-white">
                  Сыграть ещё раз
                </button>
              </motion.div>
            ) : (
              <MythCard
                key={`${card.id}-${index}`}
                card={card}
                index={index}
                total={total}
                answer={answer}
                correct={correct}
                onPick={pick}
                onNext={next}
                focusRef={focusOnMount}
              />
            )}
          </AnimatePresence>
        </div>

        {/* Контрольные вопросы — рядом с заданием: на компьютере под счётом, на телефоне после карточек */}
        <KnowledgeCheck className="lg:col-start-1 lg:row-start-2 lg:mt-6 lg:self-end" />
      </div>
    </section>
  )
}

function MythCard({
  card,
  index,
  total,
  answer,
  correct,
  onPick,
  onNext,
  focusRef,
}: {
  card: Card
  index: number
  total: number
  answer: boolean | null
  correct: boolean
  onPick: (v: boolean) => void
  onNext: () => void
  /** Фокус на утверждение новой карточки и на разбор ответа */
  focusRef: (el: HTMLElement | null) => void
}) {
  const figure = !!mythFigure(card)
  const x = useMotionValue(0)
  const rotate = useTransform(x, [-200, 200], [-8, 8])
  const truthHint = useTransform(x, [20, 120], [0, 1])
  const mythHint = useTransform(x, [-120, -20], [1, 0])

  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.x > 110) onPick(true)
    else if (info.offset.x < -110) onPick(false)
  }

  return (
    <motion.article
      style={{ x, rotate }}
      drag={answer === null ? 'x' : false}
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.9}
      onDragEnd={onDragEnd}
      initial={{ opacity: 0, y: 40, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: answer ? 320 : -320, rotate: answer ? 10 : -10, transition: { duration: 0.45, ease } }}
      transition={{ duration: 0.5, ease }}
      className="relative flex cursor-grab touch-pan-y flex-col bg-ink text-white select-none active:cursor-grabbing md:min-h-[540px]"
    >
      <div className="relative aspect-[16/10] overflow-hidden">
        <CardPicture card={card} answered={answer !== null} sizes="(min-width: 1024px) 500px, 100vw" className="absolute inset-0" />
        <span className="absolute top-4 left-4 bg-ink px-2.5 py-1 font-display text-[17px] font-bold tabular-nums">
          {index + 1}/{total}
        </span>
        <motion.span aria-hidden="true" style={{ opacity: truthHint }} className="absolute top-4 right-4 bg-white px-3 py-1 font-display text-[22px] font-black text-ink uppercase">
          Правда
        </motion.span>
        <motion.span aria-hidden="true" style={{ opacity: mythHint }} className="absolute top-4 right-4 bg-white px-3 py-1 font-display text-[22px] font-black text-ink uppercase">
          Миф
        </motion.span>
        {answer !== null && (
          // На фото — штамп по центру поверх затемнения, на числе — в углу: число после ответа и есть разбор
          <motion.div
            initial={{ opacity: 0, scale: 1.2 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.4, ease }}
            className={figure ? 'absolute top-4 right-4' : 'absolute inset-0 grid place-items-center bg-ink/45'}
            aria-hidden="true"
          >
            <span
              className={`block font-display leading-none font-black uppercase ${figure ? 'px-3 py-1.5 text-[clamp(28px,4vw,40px)]' : 'px-5 py-2 text-[clamp(44px,6vw,64px)]'} ${
                correct ? 'bg-white text-ink' : 'bg-brand text-white'
              }`}
            >
              {card.truth ? 'Правда' : 'Миф'}
            </span>
          </motion.div>
        )}
      </div>

      <div className="flex flex-1 flex-col p-5 md:p-7">
        {/* После ответа миф зачёркнут и приглушён, крупным ниже встаёт то, что на самом деле */}
        <p
          ref={answer === null ? focusRef : undefined}
          tabIndex={-1}
          className={`font-display leading-[0.95] font-extrabold uppercase outline-none ${
            answer !== null && !card.truth ? 'text-[clamp(22px,2.2vw,28px)] text-white/45 line-through decoration-brand decoration-[3px]' : 'text-[clamp(30px,3vw,40px)]'
          }`}
        >
          <span className="sr-only">Факт {index + 1} из {total}: </span>
          {nb(card.claim)}
        </p>

        {answer === null ? (
          <div className="mt-6 grid grid-cols-2 gap-2 md:mt-auto md:pt-6">
            <button
              onClick={() => onPick(false)}
              className="h-14 font-display text-[22px] font-extrabold tracking-[0.05em] uppercase ring-1 ring-white/50 ring-inset transition-colors hover:bg-white hover:text-ink"
            >
              ← Миф
            </button>
            <button
              onClick={() => onPick(true)}
              className="h-14 bg-white font-display text-[22px] font-extrabold tracking-[0.05em] text-ink uppercase transition-colors hover:bg-brand hover:text-white"
            >
              Правда →
            </button>
          </div>
        ) : (
          <motion.div
            ref={focusRef}
            tabIndex={-1}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease }}
            className="mt-4 outline-none md:mt-auto md:pt-5"
          >
            <p className={`font-display text-[22px] font-extrabold tracking-[0.05em] uppercase ${correct ? 'text-white' : 'text-brand-bright'}`}>
              {correct ? 'Верно' : 'Неверно'}: это {card.truth ? 'правда' : 'миф'}
            </p>
            {!card.truth && <p className="mt-2 font-display text-[clamp(26px,2.6vw,34px)] leading-[0.95] font-extrabold uppercase">{nb(card.fact)}</p>}
            <p className="mt-2 text-[16px] leading-relaxed text-white/80">{nb(card.explain)}</p>
            <button
              onClick={onNext}
              className="mt-5 h-14 w-full bg-brand font-display text-[22px] font-extrabold tracking-[0.05em] uppercase transition-colors hover:bg-white hover:text-brand"
            >
              {index + 1 < total ? 'Следующий факт' : 'Итог'}
            </button>
          </motion.div>
        )}
      </div>
    </motion.article>
  )
}
