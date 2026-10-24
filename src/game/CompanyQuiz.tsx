import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { Link } from 'react-router'
import { COMPANY_QUIZ_REWARD, COMPANY_QUIZ_ROUND, companyQuiz, companyQuizPassed, companyQuizPromise, companyQuizRewardWhere } from '@shared/content/companyQuiz'
import { plural } from '../components/candidate/applyText'
import { useSentApplication } from '../components/candidate/sent'
import { Announce, say } from '../home/kit'
import { scrollToTarget } from '../lib/motion'
import { sfx } from '../lib/sfx'
import { nb } from '../lib/typo'
import { BottleShape } from './Bottle'
import {
  advance,
  answer,
  currentItem,
  feedbackFor,
  isAnswered,
  isFinished,
  mistakesOf,
  newPlay,
  optionForKey,
  optionLetters,
  practiceLine,
  resultTail,
  scoreOf,
  topicLabels,
  verdictAt,
  type QuizPlay,
} from './companyQuizPlay'
import { useCompanyQuiz } from './companyQuizStore'

// Викторина «7 вопросов об „Очаково“» — контрольные вопросы на знание компании (кейс: «интерактивный блок с контрольными вопросами»).
// Раунд — COMPANY_QUIZ_ROUND случайных вопросов из shared/content/companyQuiz.ts. Ответ — сразу объяснение и источник,
// итог — счёт, разбор ошибок и ссылка на оплачиваемую практику. За каждый верный ответ наливается бутылка кваса.
// Зачем проходить: за COMPANY_QUIZ_PASS верных — значок «1978» (забрать на стенде, экскурсии или в первый день),
// лучший результат уходит в заявку
// CompanyQuiz — само прохождение (страница /game?t=quiz), CompanyQuizCard — карточка для главной: раскрывается на месте

const ease = [0.16, 1, 0.3, 1] as const

export type QuizTone = 'dark' | 'light'
type Size = 'page' | 'card'

/** Цвета под фон: dark — тёмная страница игры, light — белые секции главной */
const tones = {
  dark: {
    text: 'text-white',
    quiet: 'text-white/75',
    rule: 'border-white',
    ruleSoft: 'border-white/25',
    option: 'hover:bg-white hover:text-ink focus-visible:bg-white focus-visible:text-ink',
    right: 'bg-white text-ink',
    wrongTitle: 'text-brand-bright',
    primary: 'bg-brand text-white hover:bg-white hover:text-brand',
    ghost: 'text-white ring-1 ring-white/60 ring-inset hover:bg-white hover:text-ink',
    link: 'text-white/75 decoration-white/40 hover:text-white',
    surface: 'dark',
  },
  light: {
    text: 'text-ink',
    quiet: 'text-ink/70',
    rule: 'border-ink',
    ruleSoft: 'border-ink/15',
    option: 'hover:bg-ink hover:text-white focus-visible:bg-ink focus-visible:text-white',
    right: 'bg-ink text-white',
    wrongTitle: 'text-brand',
    primary: 'bg-ink text-white hover:bg-brand',
    ghost: 'text-ink ring-1 ring-ink/50 ring-inset hover:bg-ink hover:text-white',
    link: 'text-ink/70 decoration-ink/40 hover:text-ink',
    surface: 'light',
  },
} as const

const eyebrow = 'font-display text-[17px] font-bold tracking-[0.08em] uppercase'
const buttonBase =
  'inline-flex min-h-12 items-center justify-center gap-4 px-7 py-2 text-center font-display text-[19px] leading-[1.05] font-bold tracking-[0.06em] uppercase transition-colors duration-300 sm:min-h-14 sm:text-[20px]'

const plainSpaces = (t: string) => t.replace(/[  ]/g, ' ')

type QuizProps = {
  tone?: QuizTone
  size?: Size
  /** Уровень заголовка вопроса: на странице под h1 — h2, в карточке внутри секции — h3 */
  level?: 'h2' | 'h3'
  className?: string
}

/** Прохождение: вопросы по одному, ответ — сразу объяснение, в конце — итог. Новый раунд начинается сразу */
export function CompanyQuiz({ tone = 'dark', size = 'page', level = 'h2', className = '' }: QuizProps) {
  const t = tones[tone]
  const [play, setPlay] = useState<QuizPlay>(() => newPlay())
  const [message, setMessage] = useState<{ key: number; text: string } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const feedback = useRef<HTMLDivElement>(null)
  // Фокус переводим только после действия человека — на новый вопрос, на «Дальше» или на итог
  const moveFocus = useRef(size === 'card')
  const focusOnMount = useCallback((el: HTMLElement | null) => {
    if (!el || !moveFocus.current) return
    moveFocus.current = false
    el.focus({ preventScroll: true })
  }, [])

  const item = currentItem(play)
  const answered = isAnswered(play)
  const finished = isFinished(play)
  const total = play.items.length
  const score = scoreOf(play)
  const picked = answered ? play.picks[play.index] : null
  const page = size === 'page'

  const choose = (option: number) => {
    if (!item || answered) return
    const next = answer(play, option)
    if (next === play) return
    navigator.vibrate?.(8)
    setPlay(next)
    const f = feedbackFor(item, option)
    // Звук — как в «Поймай брак» и только если его включили там: по умолчанию выключен
    if (f.correct) sfx.pop()
    else sfx.error()
    setMessage(say(f.announce))
    // Объяснение и «Дальше» появляются под вариантами: на телефоне они могли остаться ниже экрана
    requestAnimationFrame(() => {
      const el = feedback.current
      if (!el) return
      el.querySelector<HTMLButtonElement>('[data-quiz-next]')?.focus({ preventScroll: true })
      const r = el.getBoundingClientRect()
      if (r.bottom > window.innerHeight - 8) scrollToTarget(el, Math.min(-96, -(window.innerHeight - r.height - 24)))
    })
  }

  const next = () => {
    if (!answered) return
    const after = advance(play)
    moveFocus.current = true
    setPlay(after)
    if (isFinished(after)) {
      const s = scoreOf(after)
      useCompanyQuiz.getState().finish(s, after.items.length)
      sfx.fanfare()
      setMessage(say(`Итог: ${s} из ${after.items.length}. ${resultTail(s, after.items.length)}`))
    } else setMessage(say(`Вопрос ${after.index + 1} из ${after.items.length}`))
    // Новый вопрос не должен прятаться под шапкой: после длинного объяснения страница могла уехать вниз
    requestAnimationFrame(() => {
      const el = root.current
      if (el && el.getBoundingClientRect().top < 72) scrollToTarget(el, -96)
    })
  }

  const restart = () => {
    moveFocus.current = true
    setPlay(newPlay())
    setMessage(say(`Новый раунд. Вопрос 1 из ${COMPANY_QUIZ_ROUND}`))
    requestAnimationFrame(() => {
      const el = root.current
      if (el && el.getBoundingClientRect().top < 72) scrollToTarget(el, -96)
    })
  }

  // Клавиши 1–4 или А–Г выбирают ответ, Enter после ответа — дальше. true — клавиша наша
  const handleKey = (e: { key: string; target: EventTarget | null; altKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
    if (e.altKey || e.ctrlKey || e.metaKey || finished || !item) return false
    const tag = (e.target as HTMLElement | null)?.tagName ?? ''
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false
    if (!answered) {
      const option = optionForKey(e.key, item.options.length)
      if (option === null) return false
      choose(option)
      return true
    }
    if (e.key === 'Enter' && tag !== 'BUTTON' && tag !== 'A') {
      next()
      return true
    }
    return false
  }

  // Карточка на главной слушает клавиши только внутри себя и не отдаёт их наружу: рядом «Правда или миф» со своими стрелками и Enter
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (page) return
    if (handleKey(e)) e.preventDefault()
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Enter') e.stopPropagation()
  }

  // На странице вопросы — главное содержимое: клавиши работают, где бы ни стоял фокус внутри страницы (но не в шапке и не в меню)
  const keyRef = useRef(handleKey)
  useEffect(() => {
    keyRef.current = handleKey
  })
  useEffect(() => {
    if (!page) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      const target = e.target as Node | null
      const main = document.getElementById('main')
      if (target && target !== document.body && main && !main.contains(target)) return
      if (keyRef.current(e)) e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [page])

  const Heading = level

  return (
    <div
      ref={root}
      onKeyDown={onKeyDown}
      data-company-quiz-play=""
      data-surface={t.surface}
      className={`relative ${t.text} ${className}`}
    >
      <Announce message={message} />
      <AnimatePresence mode="wait" initial={false}>
        {finished ? (
          <motion.div
            key={`result-${play.items[0]?.id}`}
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5, ease }}
            className={page ? 'grid grid-cols-[minmax(0,1fr)] gap-x-16 gap-y-10 lg:grid-cols-[5fr_7fr]' : ''}
          >
            <Result play={play} score={score} total={total} tone={tone} size={size} level={level} focusRef={focusOnMount} onRestart={restart} />
          </motion.div>
        ) : (
          item && (
            <motion.div
              key={`${play.items[0]?.id}-${play.index}`}
              initial={{ opacity: 0, x: 40 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -40 }}
              transition={{ duration: 0.4, ease }}
              className={page ? 'grid grid-cols-[minmax(0,1fr)] gap-x-16 gap-y-8 lg:grid-cols-2' : ''}
            >
              <div>
                <Progress play={play} tone={tone} size={size} />
                <p className={`${eyebrow} ${t.quiet} ${page ? 'mt-8 md:mt-10' : 'mt-6'}`} data-quiz-topic>
                  {topicLabels[item.topic]}
                </p>
                <Heading
                  ref={focusOnMount}
                  tabIndex={-1}
                  data-quiz-question
                  className={`mt-3 font-display leading-[0.92] font-black uppercase outline-none ${
                    page ? 'text-[clamp(36px,3.8vw,56px)]' : 'text-[clamp(28px,3vw,40px)]'
                  }`}
                >
                  <span className="sr-only">
                    Вопрос {play.index + 1} из {total}.{' '}
                  </span>
                  {nb(item.question)}
                </Heading>
              </div>

              <div>
                <ul className={`border-t ${t.rule} ${page ? '' : 'mt-6'}`} aria-label="Варианты ответа">
                  {item.options.map((option, i) => (
                    <Option
                      key={option}
                      letter={optionLetters[i] ?? String(i + 1)}
                      text={option}
                      tone={tone}
                      size={size}
                      state={!answered ? 'open' : i === item.answer ? 'right' : i === picked ? 'wrong' : 'other'}
                      onPick={() => choose(i)}
                    />
                  ))}
                </ul>

                {answered && picked !== null ? (
                  <Feedback ref={feedback} play={play} picked={picked} tone={tone} size={size} onNext={next} />
                ) : (
                  <p className={`mt-4 hidden text-[15px] ${t.quiet} [@media(hover:hover)_and_(pointer:fine)_and_(min-width:768px)]:block`}>
                    {nb('С клавиатуры: цифры 1–4 или буквы А–Г, после ответа Enter.')}
                  </p>
                )}
              </div>
            </motion.div>
          )
        )}
      </AnimatePresence>
    </div>
  )
}

/**
 * Счёт бутылками: верный ответ — бутылка наливается квасом, неверный — остаётся пустой с красным контуром.
 * Текущая — яркая, впереди — бледные. Число рядом и строка для диктора дублируют картинку словами
 */
function Progress({ play, tone, size, final = false }: { play: QuizPlay; tone: QuizTone; size: Size; final?: boolean }) {
  const total = play.items.length
  const score = scoreOf(play)
  const wrong = tone === 'dark' ? 'text-brand-bright' : 'text-brand'
  return (
    <div className="flex items-end gap-4" data-quiz-progress>
      {!final && (
        <span className="font-display text-[22px] leading-none font-black tabular-nums" aria-hidden="true">
          {Math.min(play.index + 1, total)}/{total}
        </span>
      )}
      <span className="flex items-end gap-1.5 sm:gap-2" aria-hidden="true">
        {play.items.map((item, i) => {
          const v = verdictAt(play, i)
          const state = v === true ? 'right' : v === false ? 'wrong' : i === play.index ? 'current' : 'ahead'
          return (
            <BottleShape
              key={item.id}
              level={v === true ? 0.84 : 0}
              duration={700}
              className={`w-auto shrink-0 ${size === 'page' ? 'h-11 md:h-14' : 'h-9'} ${state === 'wrong' ? wrong : state === 'ahead' ? 'opacity-35' : ''}`}
            />
          )
        })}
      </span>
      <span className="sr-only">
        {final ? `Верных ответов: ${score} из ${total}` : `Верных ответов: ${score}`}
      </span>
    </div>
  )
}

type OptionState = 'open' | 'right' | 'wrong' | 'other'

function Option({ letter, text, tone, size, state, onPick }: { letter: string; text: string; tone: QuizTone; size: Size; state: OptionState; onPick: () => void }) {
  const t = tones[tone]
  const look =
    state === 'open' ? t.option : state === 'right' ? t.right : state === 'wrong' ? 'bg-brand text-white' : 'opacity-55'
  const tag = state === 'right' ? 'Правильный ответ' : state === 'wrong' ? 'Твой ответ' : null
  return (
    <li className={`border-b ${t.ruleSoft}`}>
      <button
        onClick={onPick}
        disabled={state !== 'open'}
        data-quiz-option={state}
        className={`flex w-full items-start gap-4 text-left transition-colors duration-200 disabled:cursor-default ${
          size === 'page' ? 'py-4 pr-4 text-[17px] leading-snug md:py-5 md:text-[20px]' : 'py-3.5 pr-3 text-[17px] leading-snug'
        } ${look}`}
      >
        <span className="w-8 shrink-0 pl-2 font-display text-[24px] leading-[0.95] font-black" aria-hidden="true">
          {letter}
        </span>
        <span className="min-w-0 flex-1">
          {nb(text)}
          {tag && <span className="mt-1 block font-display text-[15px] font-bold tracking-[0.08em] uppercase">{tag}</span>}
        </span>
      </button>
    </li>
  )
}

function Feedback({
  ref,
  play,
  picked,
  tone,
  size,
  onNext,
}: {
  ref: Ref<HTMLDivElement>
  play: QuizPlay
  picked: number
  tone: QuizTone
  size: Size
  onNext: () => void
}) {
  const t = tones[tone]
  const item = play.items[play.index]
  const f = feedbackFor(item, picked)
  const last = play.index + 1 >= play.items.length
  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease }}
      className={size === 'page' ? 'mt-6 md:mt-8' : 'mt-5'}
      data-quiz-feedback={f.correct ? 'right' : 'wrong'}
    >
      <p className={`font-display text-[26px] leading-none font-black uppercase ${f.correct ? '' : t.wrongTitle}`}>{f.title}</p>
      <p className={`mt-2 max-w-[640px] leading-relaxed ${size === 'page' ? 'text-[17px] md:text-[19px]' : 'text-[16px]'}`}>{nb(item.explain)}</p>
      <p className={`mt-2 text-[14px] ${t.quiet}`}>Источник: {nb(item.source)}</p>
      <button onClick={onNext} data-quiz-next className={`${buttonBase} ${t.primary} mt-5 w-full sm:w-fit`}>
        {last ? 'Итог' : 'Следующий вопрос'}
      </button>
    </motion.div>
  )
}

function Result({
  play,
  score,
  total,
  tone,
  size,
  level,
  focusRef,
  onRestart,
}: {
  play: QuizPlay
  score: number
  total: number
  tone: QuizTone
  size: Size
  level: 'h2' | 'h3'
  focusRef: (el: HTMLElement | null) => void
  onRestart: () => void
}) {
  const t = tones[tone]
  const sent = useSentApplication((s) => s.last)
  const passed = companyQuizPassed(score, total)
  const mistakes = mistakesOf(play)
  const page = size === 'page'
  const Heading = level
  return (
    <>
      <div>
        <Heading ref={focusRef} tabIndex={-1} className="outline-none" data-quiz-result>
          <span className={`block ${eyebrow} ${t.quiet}`}>Итог</span>
          <span className="mt-3 flex items-end gap-4">
            <span className="sr-only">
              {score} из {total} верных ответов
            </span>
            <span
              aria-hidden="true"
              className={`font-display leading-[0.8] font-black tabular-nums ${page ? 'text-[clamp(96px,12vw,176px)]' : 'text-[clamp(72px,7vw,104px)]'}`}
            >
              {score}
              <span className="opacity-60">/{total}</span>
            </span>
            <span aria-hidden="true" className={`pb-1 ${eyebrow} ${t.quiet}`}>
              верных
              <br />
              ответов
            </span>
          </span>
        </Heading>
        <div className="mt-6">
          <Progress play={play} tone={tone} size={size} final />
        </div>
        <p className={`mt-5 max-w-[520px] leading-snug ${page ? 'text-[19px] md:text-[22px]' : 'text-[17px]'}`} data-quiz-tail>
          {nb(resultTail(score, total))}
        </p>
        {passed && <Badge tone={tone} />}
      </div>

      <div className={page ? '' : 'mt-8'}>
        <div className={`border-t-[3px] pt-5 ${t.rule}`} data-quiz-practice>
          <p className={`max-w-[620px] leading-snug ${page ? 'text-[19px] md:text-[22px]' : 'text-[17px]'}`}>{nb(practiceLine())}</p>
          {/* Главное действие — заявка; практика — вторым: на странице вакансий ещё один шаг до отклика */}
          <div className="mt-5 grid gap-2.5 sm:flex sm:flex-wrap sm:gap-3">
            <Link to="/apply" className={`${buttonBase} ${t.primary}`}>
              {sent ? 'Моя заявка' : 'Откликнуться'}
            </Link>
            <Link to="/vacancies#paid" className={`${buttonBase} ${t.ghost}`}>
              Оплачиваемая практика
            </Link>
            <button onClick={onRestart} className={`${buttonBase} ${t.ghost}`}>
              Ещё раз
            </button>
          </div>
          <p className={`mt-4 max-w-[620px] text-[15px] leading-snug ${t.quiet}`}>
            {nb(sent ? 'Лучший результат уже можно показать в заявке: HR видит его в карточке.' : 'Лучший результат попадёт в заявку, HR увидит его в карточке.')}
          </p>
        </div>

        {mistakes.length > 0 && (
          <Review tone={tone} size={size}>
            {mistakes.map((m) => (
              <li key={m.id} className={`border-b py-3.5 ${t.ruleSoft}`}>
                <p className="font-medium">{nb(m.question)}</p>
                <p className={`mt-1 ${t.quiet}`}>
                  Правильно: <span className={tone === 'dark' ? 'text-white' : 'text-ink'}>{nb(plainSpaces(m.right))}</span>
                </p>
              </li>
            ))}
          </Review>
        )}
      </div>
    </>
  )
}

/** Значок «1978» за пройденную викторину: такой же, как в коллекции мерча, и где его забрать */
function Badge({ tone }: { tone: QuizTone }) {
  const t = tones[tone]
  return (
    <div className={`mt-6 flex max-w-[560px] items-center gap-5 border-t pt-5 ${t.ruleSoft}`} data-quiz-badge>
      <span aria-hidden="true" className="grid size-20 shrink-0 place-items-center rounded-full bg-brand font-display text-[26px] font-black text-white">
        1978
      </span>
      <p className="text-[16px] leading-snug">
        <span className="block font-display text-[22px] font-extrabold uppercase">{nb(`${COMPANY_QUIZ_REWARD.charAt(0).toUpperCase()}${COMPANY_QUIZ_REWARD.slice(1)} твой`)}</span>
        <span className={`mt-1 block ${t.quiet}`}>{nb(companyQuizRewardWhere('screen'))}</span>
      </p>
    </div>
  )
}

function Review({ tone, size, children }: { tone: QuizTone; size: Size; children: ReactNode }) {
  const t = tones[tone]
  return (
    <div className={size === 'page' ? 'mt-10' : 'mt-8'} data-quiz-review>
      <p className={`${eyebrow} ${t.quiet}`}>Разбор ошибок</p>
      <ul className={`mt-2 border-t text-[16px] leading-snug ${t.ruleSoft}`}>{children}</ul>
    </div>
  )
}

/** Сколько вопросов в базе — «7 из 12» в подписи карточки */
export const COMPANY_QUIZ_TOTAL = companyQuiz.length

/**
 * Название и метка викторины — одни на странице игры, на главной и в карточке. «Викторина» — потому что
 * в меню сайта уже есть «Вопросы» (FAQ). Число вопросов — из данных раунда
 */
export const COMPANY_QUIZ_KICKER = 'Викторина'
export const COMPANY_QUIZ_TITLE = `${COMPANY_QUIZ_ROUND} ${plural(COMPANY_QUIZ_ROUND, ['вопрос', 'вопроса', 'вопросов'])} об\u00A0«Очаково»`

type CardProps = {
  className?: string
  /** light — белая секция главной, dark — тёмная */
  tone?: QuizTone
  /** Уровень заголовка карточки внутри секции главной */
  level?: 'h2' | 'h3'
}

/**
 * Карточка для главной: заголовок, что внутри и «Проверить себя». По кнопке вопросы раскрываются прямо на месте,
 * без перехода на другую страницу. Если раунд уже проходили — лучший результат
 */
export function CompanyQuizCard({ className = '', tone = 'light', level = 'h3' }: CardProps) {
  const t = tones[tone]
  const [started, setStarted] = useState(false)
  const best = useCompanyQuiz((s) => s.best)
  const Heading = level
  return (
    <div data-company-quiz className={`border-t-[3px] pt-5 ${t.rule} ${t.text} ${className}`}>
      <p className={eyebrow}>{COMPANY_QUIZ_KICKER}</p>
      {started ? (
        <>
          <p className="mt-2 font-display text-[clamp(24px,2.2vw,30px)] leading-[0.95] font-black uppercase">{COMPANY_QUIZ_TITLE}</p>
          <CompanyQuiz tone={tone} size="card" level={level} className="mt-6" />
        </>
      ) : (
        <>
          <Heading className="mt-3 font-display text-[clamp(34px,3.2vw,48px)] leading-[0.9] font-black uppercase">{COMPANY_QUIZ_TITLE}</Heading>
          <p className={`mt-3 max-w-[460px] text-[17px] leading-relaxed ${t.quiet}`}>
            {nb(`${COMPANY_QUIZ_ROUND} вопросов из ${COMPANY_QUIZ_TOTAL} про историю, квас, деньги и практику. ${companyQuizPromise()}`)}
          </p>
          {best && (
            <p className="mt-3 text-[15px] font-medium" data-quiz-best>
              Лучший результат: {best.score} из {best.total}
            </p>
          )}
          <button onClick={() => setStarted(true)} className={`${buttonBase} ${t.primary} mt-5 w-fit`}>
            {best ? 'Пройти ещё раз' : 'Проверить себя'}
          </button>
        </>
      )}
    </div>
  )
}
