import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'
import { COMPANY_QUIZ_ROUND } from '@shared/content/companyQuiz'
import { dorm } from '@shared/content/handbook'
import { paidPracticeInfo } from '@shared/content/practice'
import { formatRub, maxEntryPay, minPracticePay } from '@shared/content/vacancies'
import { SOURCE_CODE_RE } from '@shared/sources'
import { ApiError, ApiValidationError, request } from '../lib/api'
import { scrollToTarget } from '../lib/motion'
import { nb } from '../lib/typo'
import { useProfile } from '../store/profile'

// Фокус-группа за 10 минут (w2-fc-1): анонимная анкета о концепции «Смена» на /focus?s=<метка>.
// Сначала три слогана и главное о практике, потом шесть вопросов по одному, проверка ответов и отправка.
// Вопросы и варианты приходят с сервера (GET /api/focus, server/db/focus.ts) — дословно по протоколу
// docs/brand/focus-group.md, раздел 5: так ответы онлайн и на очных встречах можно сравнить.
// Ни имени, ни телефона, ни даты рождения. Один ответ с устройства — cookie сервера; повтор — «Ответ уже записан».
// Метка из ссылки запоминается и как источник посетителя: заявку потом видно в «Воронке» по той же метке.

type Option = { id: string; label: string }
type Question =
  | { id: string; kind: 'one'; title: string; short: string; look?: 'slogan'; hint?: string; options: Option[] }
  | { id: string; kind: 'text'; title: string; short: string; max: number; hint: string }
type Survey = { version: number; questions: Question[]; answered: boolean }

type Phase = { at: 'loading' } | { at: 'failed' } | { at: 'intro' } | { at: 'ask'; step: number } | { at: 'review' } | { at: 'done'; already: boolean }

const ease = [0.16, 1, 0.3, 1] as const
const TITLE = 'Анкета о слогане'

const eyebrow = 'font-display text-[17px] font-bold tracking-[0.08em] uppercase'
const btnBase =
  'inline-flex min-h-12 items-center justify-center gap-3 px-7 py-2 text-center font-display text-[19px] leading-[1.05] font-bold tracking-[0.06em] uppercase transition-colors duration-300 disabled:pointer-events-none disabled:opacity-40 sm:min-h-14 sm:text-[20px]'
const btnRed = `${btnBase} bg-brand text-white hover:bg-white hover:text-brand`
const btnGhost = `${btnBase} text-white ring-1 ring-white/60 ring-inset hover:bg-white hover:text-ink`
const btnQuiet =
  'inline-flex min-h-11 items-center gap-2 font-display text-[17px] font-bold tracking-[0.08em] text-white/70 uppercase transition-colors hover:text-white'

/** Метка из ссылки: ?s=fg-a, на всякий случай и ?src=. Как метки источников: латиница, цифры, дефис */
function tagFrom(params: URLSearchParams): string {
  const raw = (params.get('s') ?? params.get('src') ?? '').trim().toLowerCase()
  return SOURCE_CODE_RE.test(raw) ? raw : ''
}

/** «4 отдела», «6 вопросов» */
function count(n: number, one: string, few: string, many: string) {
  const d = n % 10
  const h = n % 100
  return `${n} ${d === 1 && h !== 11 ? one : d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many}`
}

/** «56 000–70 000 ₽» — суммы из вакансий, как на главной и в «Вакансиях» */
const payRange = () => `${minPracticePay.toLocaleString('ru-RU')}–${formatRub(maxEntryPay)}`

/** Главное о практике до вопросов: без этого на «Что зацепило» и «Подать заявку» онлайн ответить нечем (протокол, раздел 5) */
const facts = () => [
  {
    value: payRange(),
    text: `в месяц до вычета налога. ${count(paidPracticeInfo.units.length, 'отдел', 'отдела', 'отделов')}: ${paidPracticeInfo.units.map((u) => u.toLowerCase()).join(', ')}`,
  },
  { value: 'Наставник', text: 'у каждого новичка: опытный сотрудник, обученный в Учебном центре компании' },
  { value: 'Без испытательного срока', text: 'у студентов: вместо него производственная практика по срочному трудовому договору' },
  { value: formatRub(dorm.priceStudent), text: 'койко-место в общежитии для студентов, половину оплачивает компания' },
]

export function Focus() {
  const [params] = useSearchParams()
  const tag = tagFrom(params)
  const [survey, setSurvey] = useState<Survey | null>(null)
  const [phase, setPhase] = useState<Phase>({ at: 'loading' })
  const [answers, setAnswers] = useState<Record<string, string>>({})
  /** Правка из проверки ответов: после ответа — сразу к проверке */
  const [editing, setEditing] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  // Фокус переводим только после действия человека: на новый вопрос, проверку или итог
  const moveFocus = useRef(false)
  const focusOnMount = useCallback((el: HTMLElement | null) => {
    if (!el || !moveFocus.current) return
    moveFocus.current = false
    el.focus({ preventScroll: true })
  }, [])

  const load = useCallback(() => {
    setPhase({ at: 'loading' })
    request<Survey>('/api/focus')
      .then((s) => {
        setSurvey(s)
        setPhase(s.answered ? { at: 'done', already: true } : { at: 'intro' })
      })
      .catch(() => setPhase({ at: 'failed' }))
  }, [])
  useEffect(load, [load])

  // Метка анкеты — и метка посетителя: если потом будет заявка, HR увидит, что человек пришёл с фокус-группы.
  // Запоминается первая метка, как у ?src=
  useEffect(() => {
    if (tag) useProfile.getState().setSource(tag)
  }, [tag])

  // Шапка сайта ставит заголовок вкладки по адресу — свой ставим кадром позже, поверх (как на /game)
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      document.title = `${TITLE} — Сезон в «Очаково»`
    })
    return () => cancelAnimationFrame(frame)
  }, [phase.at])

  const go = useCallback((next: Phase) => {
    moveFocus.current = true
    setPhase(next)
    // Новый вопрос не прячется под шапкой: после длинного списка страница могла уехать вниз
    requestAnimationFrame(() => {
      const el = root.current
      if (el && el.getBoundingClientRect().top < 72) scrollToTarget(el, -96)
    })
  }, [])

  const questions = survey?.questions ?? []
  const total = questions.length

  const next = useCallback(
    (step: number) => {
      if (editing || step + 1 >= total) {
        setEditing(false)
        go({ at: 'review' })
      } else go({ at: 'ask', step: step + 1 })
    },
    [editing, go, total],
  )

  const answer = useCallback((id: string, value: string) => setAnswers((a) => ({ ...a, [id]: value })), [])

  const edit = (step: number) => {
    setEditing(true)
    go({ at: 'ask', step })
  }

  /** «Назад»: при правке — к проверке, с первого вопроса — к слоганам, иначе — к прошлому вопросу */
  const back = (step: number) => {
    if (editing) {
      setEditing(false)
      go({ at: 'review' })
    } else go(step === 0 ? { at: 'intro' } : { at: 'ask', step: step - 1 })
  }

  return (
    <div className="bg-night text-white" data-surface="dark">
      <div ref={root} className="container-x scroll-mt-24 pt-28 pb-20 md:pt-36 md:pb-28">
        {phase.at === 'intro' || phase.at === 'loading' || phase.at === 'failed' ? (
          <Intro
            slogans={survey?.questions.find((q): q is Extract<Question, { kind: 'one' }> => q.kind === 'one' && q.look === 'slogan')?.options.filter((o) => o.id !== 'none') ?? null}
            total={total || 6}
            phase={phase.at}
            headingRef={focusOnMount}
            onStart={() => go({ at: 'ask', step: 0 })}
            onRetry={load}
          />
        ) : (
          <>
            {/* На шагах анкеты заголовок страницы компактный: на телефоне вопрос должен попасть в первый экран */}
            <h1 className={`${eyebrow} text-white/60`}>
              {TITLE}
              <span className="sr-only">. Анонимно, без имени и телефона</span>
            </h1>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={phase.at === 'ask' ? `ask-${phase.step}` : phase.at}
                initial={{ opacity: 0, x: 40 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -40 }}
                transition={{ duration: 0.35, ease }}
                className="mt-8 md:mt-10"
              >
                {phase.at === 'ask' && questions[phase.step] && (
                  <Step
                    question={questions[phase.step]}
                    index={phase.step}
                    total={total}
                    value={answers[questions[phase.step].id] ?? ''}
                    editing={editing}
                    headingRef={focusOnMount}
                    onAnswer={answer}
                    onNext={() => next(phase.step)}
                    onBack={() => back(phase.step)}
                  />
                )}
                {phase.at === 'review' && (
                  <Review
                    questions={questions}
                    answers={answers}
                    tag={tag}
                    headingRef={focusOnMount}
                    onEdit={edit}
                    onBack={() => go({ at: 'ask', step: total - 1 })}
                    onSent={(already) => go({ at: 'done', already })}
                    onMissing={(step) => go({ at: 'ask', step })}
                  />
                )}
                {phase.at === 'done' && <Done already={phase.already} headingRef={focusOnMount} />}
              </motion.div>
            </AnimatePresence>
          </>
        )}
      </div>
    </div>
  )
}

// ── Начало: три слогана и главное о практике ──────────────────────────────

function Intro({
  slogans,
  total,
  phase,
  headingRef,
  onStart,
  onRetry,
}: {
  slogans: Option[] | null
  total: number
  phase: 'intro' | 'loading' | 'failed'
  /** «Назад» с первого вопроса возвращает сюда — фокус на заголовок */
  headingRef: (el: HTMLElement | null) => void
  onStart: () => void
  onRetry: () => void
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-y-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-x-16 lg:gap-y-10">
      <header className="lg:col-start-1 lg:row-start-1">
        <p className={`${eyebrow} text-white/75`}>Анкета · {count(total, 'вопрос', 'вопроса', 'вопросов')} · 2&nbsp;минуты</p>
        <h1 ref={headingRef} tabIndex={-1} className="display mt-4 text-[clamp(64px,8.2vw,128px)] outline-none">
          Помоги выбрать <span className="text-brand">слоган</span>
        </h1>
        <p className="mt-6 max-w-[520px] text-[17px] leading-relaxed text-white/80 md:text-[19px]">
          {nb('«Очаково» зовёт студентов на оплачиваемую практику и выбирает, как об этом сказать. Прочитай три варианта и факты о практике, потом ответь на вопросы.')}
        </p>
      </header>

      <div className="min-w-0 lg:col-start-2 lg:row-span-2 lg:row-start-1">
        <section aria-labelledby="focus-slogans">
          <h2 id="focus-slogans" className={`${eyebrow} text-white/75`}>
            Три варианта слогана
          </h2>
          {slogans ? (
            <ol className="mt-4 border-t border-white">
              {slogans.map((s, i) => (
                <li key={s.id} className="flex items-baseline gap-5 border-b border-white/20 py-4 md:gap-7 md:py-5">
                  <span className="w-6 shrink-0 font-display text-[24px] leading-none font-black text-brand-bright tabular-nums" aria-hidden="true">
                    {i + 1}
                  </span>
                  <span className="font-display text-[clamp(30px,3.6vw,52px)] leading-[0.95] font-black uppercase">{s.label}</span>
                </li>
              ))}
            </ol>
          ) : (
            // Пока анкета грузится — место под три строки, чтобы страница не прыгала
            <div className="mt-4 border-t border-white" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex h-[78px] items-center border-b border-white/20 md:h-[94px]">
                  <span className="h-6 w-3/5 bg-white/[0.06]" />
                </div>
              ))}
            </div>
          )}
        </section>

        <section aria-labelledby="focus-facts" className="mt-12">
          <h2 id="focus-facts" className={`${eyebrow} text-white/75`}>
            Практика коротко
          </h2>
          <dl className="mt-4 grid grid-cols-[minmax(0,1fr)] border-t border-white/20 sm:grid-cols-2 sm:gap-x-8">
            {facts().map((f) => (
              <div key={f.value} className="border-b border-white/20 py-4 md:py-5">
                <dt className="font-display text-[clamp(28px,2.6vw,38px)] leading-[0.95] font-black uppercase">{nb(f.value)}</dt>
                <dd className="mt-2 text-[15px] leading-snug text-white/70 md:text-[16px]">{nb(f.text)}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>

      <div className="lg:col-start-1 lg:row-start-2 lg:self-start">
        {phase === 'failed' ? (
          <div role="alert" className="max-w-[460px]">
            <p className="font-display text-[26px] leading-none font-black uppercase">Анкета не открылась</p>
            <p className="mt-2 text-[16px] text-white/75">{nb('Нет связи с сервером. Проверь интернет и попробуй ещё раз.')}</p>
            <button type="button" onClick={onRetry} className={`${btnGhost} mt-5 w-full sm:w-fit`}>
              Попробовать ещё раз
            </button>
          </div>
        ) : (
          <>
            <button type="button" onClick={onStart} disabled={phase === 'loading'} className={`${btnRed} w-full sm:w-fit`} data-focus-start>
              Мне есть 18, начать
            </button>
            <p className="mt-4 max-w-[420px] text-[15px] leading-snug text-white/65">
              {nb('Анкета анонимная: без имени, телефона и даты рождения. Отвечают с 18 лет, потому что на практику берут с 18.')}
            </p>
          </>
        )}
      </div>
    </div>
  )
}

// ── Прогресс ───────────────────────────────────────────────────────────────

/** «2/6» и полоска из шести делений: пройденные — белые, текущее — красное. done — все отвечены (проверка) */
function Progress({ index, total, done = false }: { index: number; total: number; done?: boolean }) {
  return (
    <div className="flex items-center gap-4" data-focus-progress>
      <span className="font-display text-[22px] leading-none font-black tabular-nums" aria-hidden="true">
        {done ? total : index + 1}/{total}
      </span>
      <span className="flex max-w-[288px] flex-1 gap-1.5" aria-hidden="true">
        {Array.from({ length: total }, (_, i) => (
          <span key={i} className={`h-1 flex-1 ${done || i < index ? 'bg-white' : i === index ? 'bg-brand-bright' : 'bg-white/20'}`} />
        ))}
      </span>
    </div>
  )
}

// ── Вопрос ─────────────────────────────────────────────────────────────────

function Step({
  question,
  index,
  total,
  value,
  editing,
  headingRef,
  onAnswer,
  onNext,
  onBack,
}: {
  question: Question
  index: number
  total: number
  value: string
  editing: boolean
  headingRef: (el: HTMLElement | null) => void
  onAnswer: (id: string, value: string) => void
  onNext: () => void
  onBack: () => void
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-x-16 gap-y-8 lg:grid-cols-2">
      <div>
        <Progress index={index} total={total} />
        <h2
          ref={headingRef}
          tabIndex={-1}
          data-focus-question={question.id}
          className="mt-8 font-display text-[clamp(36px,4vw,60px)] leading-[0.92] font-black uppercase outline-none md:mt-10"
        >
          <span className="sr-only">
            Вопрос {index + 1} из {total}.{' '}
          </span>
          {nb(question.title)}
        </h2>
        {question.kind === 'one' && question.hint && <p className="mt-4 text-[16px] text-white/65">{nb(question.hint)}</p>}
      </div>
      <div>
        {question.kind === 'one' ? (
          <Choice question={question} value={value} onPick={(v) => onAnswer(question.id, v)} onNext={onNext} />
        ) : (
          <FreeText question={question} value={value} onChange={(v) => onAnswer(question.id, v)} onNext={onNext} editing={editing} />
        )}
        <button type="button" onClick={onBack} className={`${btnQuiet} mt-6`}>
          <span aria-hidden="true">←</span> {editing ? 'К проверке' : 'Назад'}
        </button>
      </div>
    </div>
  )
}

/** Варианты: нажатие выбирает и через мгновение ведёт дальше. Цифры 1–9 на клавиатуре — то же самое */
function Choice({ question, value, onPick, onNext }: { question: Extract<Question, { kind: 'one' }>; value: string; onPick: (v: string) => void; onNext: () => void }) {
  const busy = useRef(false)
  const slogan = question.look === 'slogan'

  const pick = useCallback(
    (id: string) => {
      if (busy.current) return
      busy.current = true
      onPick(id)
      // Выбранный вариант успевает подсветиться — видно, что нажатие засчитано
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      window.setTimeout(onNext, reduced ? 0 : 240)
    },
    [onPick, onNext],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return
      const target = e.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      const main = document.getElementById('main')
      if (target && target !== document.body && main && !main.contains(target)) return
      const n = Number(e.key)
      if (!Number.isInteger(n) || n < 1 || n > question.options.length) return
      e.preventDefault()
      pick(question.options[n - 1].id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pick, question.options])

  return (
    <>
      <ul className="border-t border-white" aria-label="Варианты ответа">
        {question.options.map((o, i) => {
          const chosen = value === o.id
          const big = slogan && o.id !== 'none'
          return (
            <li key={o.id} className="border-b border-white/25">
              <button
                type="button"
                onClick={() => pick(o.id)}
                aria-pressed={chosen}
                data-focus-option={o.id}
                className={`flex w-full items-baseline gap-4 py-4 pr-4 text-left transition-colors duration-200 md:py-5 ${
                  chosen ? 'bg-white text-ink' : 'hover:bg-white/[0.07] focus-visible:bg-white/[0.07]'
                }`}
              >
                <span className={`w-8 shrink-0 pl-2 font-display text-[24px] leading-[0.95] font-black tabular-nums ${chosen ? 'text-brand' : 'text-white/55'}`} aria-hidden="true">
                  {i + 1}
                </span>
                <span
                  className={`min-w-0 flex-1 ${
                    big ? 'font-display text-[clamp(26px,2.6vw,38px)] leading-[0.95] font-black uppercase' : 'text-[17px] leading-snug md:text-[20px]'
                  }`}
                >
                  {nb(o.label)}
                  {chosen && <span className="mt-1.5 block font-display text-[15px] font-bold tracking-[0.08em] uppercase">Твой ответ</span>}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      <p className="mt-4 hidden text-[15px] text-white/60 [@media(hover:hover)_and_(pointer:fine)_and_(min-width:768px)]:block">
        {nb(`С клавиатуры: цифры 1–${question.options.length}.`)}
      </p>
    </>
  )
}

/** Телефон, почта, ник или ссылка в свободном ответе — их сервер вырезает (cleanFreeText в server/db/focus.ts) */
const CONTACT_LIKE = /\d{3}[\s-]?\d{2}[\s-]?\d{2}|\d{10}|@[\w.]{3,}|[\w.+-]+@[\w-]+\.|https?:\/\/|www\.|t\.me\//i

/** Свободный ответ: до max знаков, можно пропустить */
function FreeText({
  question,
  value,
  onChange,
  onNext,
  editing,
}: {
  question: Extract<Question, { kind: 'text' }>
  value: string
  onChange: (v: string) => void
  onNext: () => void
  editing: boolean
}) {
  const id = `focus-${question.id}`
  const left = question.max - value.length
  const submit = (e: FormEvent) => {
    e.preventDefault()
    onNext()
  }
  return (
    <form onSubmit={submit} noValidate>
      <label htmlFor={id} className="sr-only">
        {question.title}
      </label>
      <textarea
        id={id}
        value={value}
        maxLength={question.max}
        rows={5}
        onChange={(e) => onChange(e.target.value.slice(0, question.max))}
        aria-describedby={`${id}-hint ${id}-left`}
        className="block w-full resize-y border border-white/30 bg-white/[0.04] p-4 text-[17px] leading-relaxed text-white placeholder:text-white/45 focus:border-white md:text-[19px]"
        placeholder="Свой ответ"
      />
      <div className="mt-3 flex items-start justify-between gap-6 text-[15px] leading-snug text-white/65">
        <p id={`${id}-hint`}>{nb(question.hint)}</p>
        <p id={`${id}-left`} className="shrink-0 tabular-nums">
          осталось {left}
        </p>
      </div>
      {/* Анкета анонимная: телефон, почту и ник сервер вырежет до записи — говорим об этом заранее */}
      {CONTACT_LIKE.test(value) && (
        <p className="mt-3 border-l-2 border-white/40 pl-3 text-[15px] leading-snug text-white/80" role="status">
          {nb('Похоже на контакт. Телефон, почту, ник и ссылки уберём перед записью, потому что анкета анонимная.')}
        </p>
      )}
      <button type="submit" className={`${value.trim() ? btnRed : btnGhost} mt-6 w-full sm:w-fit`}>
        {value.trim() ? (editing ? 'Сохранить' : 'Дальше') : 'Пропустить'}
      </button>
    </form>
  )
}

// ── Проверка и отправка ────────────────────────────────────────────────────

function answerText(q: Question, value: string): string {
  if (q.kind === 'text') return value.trim() || 'Без ответа'
  return q.options.find((o) => o.id === value)?.label ?? 'Нет ответа'
}

function Review({
  questions,
  answers,
  tag,
  headingRef,
  onEdit,
  onBack,
  onSent,
  onMissing,
}: {
  questions: Question[]
  answers: Record<string, string>
  tag: string
  headingRef: (el: HTMLElement | null) => void
  onEdit: (step: number) => void
  onBack: () => void
  onSent: (already: boolean) => void
  onMissing: (step: number) => void
}) {
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<ReactNode>(null)
  const [trap, setTrap] = useState('')
  const missing = questions.findIndex((q) => q.kind === 'one' && !answers[q.id])

  const send = async (e: FormEvent) => {
    e.preventDefault()
    if (sending) return
    if (missing >= 0) return onMissing(missing)
    setSending(true)
    setError(null)
    try {
      await request<{ ok: true }>('/api/focus', { method: 'POST', body: JSON.stringify({ s: tag || undefined, answers, website: trap }) })
      onSent(false)
    } catch (err) {
      setSending(false)
      if (err instanceof ApiError && err.status === 409) return onSent(true)
      if (err instanceof ApiValidationError) {
        const step = questions.findIndex((q) => err.errors[q.id])
        if (step >= 0) return onMissing(step)
      }
      if (err instanceof ApiError && err.status === 429) {
        const minutes = Math.max(1, Math.ceil((err.retryAfter ?? 60) / 60))
        return setError(nb(`С этой сети уже много ответов. Попробуй через ${minutes} мин.`))
      }
      setError(nb('Не отправилось, нет связи с сервером. Ответы остались здесь, нажми «Отправить» ещё раз.'))
    }
  }

  return (
    <form onSubmit={send} noValidate className="grid grid-cols-[minmax(0,1fr)] gap-x-16 gap-y-8 lg:grid-cols-2">
      <div>
        <Progress index={questions.length} total={questions.length} done />
        <h2 ref={headingRef} tabIndex={-1} className="mt-8 font-display text-[clamp(44px,5vw,76px)] leading-[0.92] font-black uppercase outline-none md:mt-10">
          Проверь ответы
        </h2>
        <p className="mt-4 max-w-[460px] text-[17px] leading-relaxed text-white/75">
          {nb('Любой ответ можно поменять до отправки. С одного устройства принимаем один ответ, после отправки его не изменить.')}
        </p>
      </div>

      <div>
        <dl className="border-t border-white" data-focus-review>
          {questions.map((q, i) => (
            <div key={q.id} className="flex items-start gap-4 border-b border-white/25 py-4">
              <div className="min-w-0 flex-1">
                <dt className="text-[15px] leading-snug text-white/60">
                  {i + 1}. {nb(q.title)}
                </dt>
                <dd className={`mt-1 text-[17px] leading-snug md:text-[19px] ${q.kind === 'text' && !answers[q.id]?.trim() ? 'text-white/50' : ''}`}>
                  {nb(answerText(q, answers[q.id] ?? ''))}
                </dd>
              </div>
              <button
                type="button"
                onClick={() => onEdit(i)}
                className="shrink-0 py-1 text-[15px] text-white/75 underline decoration-white/40 underline-offset-4 hover:text-white"
              >
                Изменить<span className="sr-only"> ответ на вопрос {i + 1}</span>
              </button>
            </div>
          ))}
        </dl>

        {/* Ловушка для ботов: человек поле не видит и не попадает в него с клавиатуры. Заполненное — ответ не записывается */}
        <div aria-hidden="true" className="pointer-events-none absolute -left-[9999px] h-px w-px overflow-hidden opacity-0">
          <label htmlFor="focus-website">Сайт</label>
          <input id="focus-website" name="website" type="text" tabIndex={-1} autoComplete="off" value={trap} onChange={(e) => setTrap(e.target.value)} />
        </div>

        {error && (
          <p role="alert" className="mt-6 border-l-2 border-brand-bright pl-4 text-[16px] leading-snug">
            {error}
          </p>
        )}
        <div className="mt-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6">
          <button type="submit" disabled={sending} className={`${btnRed} w-full sm:w-fit`}>
            {sending ? 'Отправляем' : 'Отправить'}
          </button>
          <button type="button" onClick={onBack} className={btnQuiet}>
            <span aria-hidden="true">←</span> Назад
          </button>
        </div>
        <p className="mt-4 text-[15px] leading-snug text-white/60">{nb('Анонимно: без имени, телефона и даты рождения.')}</p>
      </div>
    </form>
  )
}

// ── Итог ───────────────────────────────────────────────────────────────────

function Done({ already, headingRef }: { already: boolean; headingRef: (el: HTMLElement | null) => void }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-x-16 gap-y-10 lg:grid-cols-[5fr_7fr]" data-focus-done={already ? 'already' : 'sent'}>
      <div>
        <h2 ref={headingRef} tabIndex={-1} className="display text-[clamp(64px,8vw,120px)] outline-none">
          {already ? (
            <>
              Ответ уже <span className="text-brand">записан</span>
            </>
          ) : (
            <>
              Спасибо, ответ <span className="text-brand">записан</span>
            </>
          )}
        </h2>
        <p className="mt-6 max-w-[520px] text-[17px] leading-relaxed text-white/80 md:text-[19px]" role="status">
          {already
            ? nb('С этого устройства анкету уже прошли, второй ответ не засчитаем.')
            : nb('Ответы считают вместе и без имён. По итогам выберут слоган для листовок, сайта и мерча.')}
        </p>
      </div>

      <div className="border-t-[3px] border-white pt-5 lg:self-end">
        <p className="max-w-[620px] text-[19px] leading-snug md:text-[22px]">
          {nb(`Оплачиваемая практика в «Очаково» с наставником: ${payRange()} в месяц до вычета налога, с 18 лет.`)}
        </p>
        <div className="mt-6 grid gap-2.5 sm:flex sm:flex-wrap sm:gap-3">
          <Link to="/vacancies#paid" className={btnRed}>
            Оплачиваемая практика
          </Link>
          <Link to="/apply" className={btnGhost}>
            Откликнуться
          </Link>
        </div>
        <Link to="/game?t=quiz" className="mt-6 inline-block text-[17px] text-white/75 underline decoration-white/40 underline-offset-4 hover:text-white">
          {nb(`Что ты знаешь об «Очаково»: ${COMPANY_QUIZ_ROUND} контрольных вопросов`)}
        </Link>
      </div>
    </div>
  )
}
