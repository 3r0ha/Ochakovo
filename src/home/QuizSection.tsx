import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useRef, useState } from 'react'
import { Link } from 'react-router'
import { myths } from '@shared/content/content'
import { departments, type DepartmentId } from '@shared/content/departments'
import { stages } from '@shared/content/production'
import { quiz, scoreQuiz } from '@shared/content/quiz'
import { scheduleLine, vacancies, vacancyById, type Vacancy } from '@shared/content/vacancies'
import type { PhotoName } from '../components/Photo'
import { useReveal } from '../lib/motion'
import { nb } from '../lib/typo'
import { useActivities } from '../store/activities'
import { useSentApplication } from '../components/candidate/sent'
import { useProfile } from '../store/profile'
import { Announce, ButtonLink, Duo, EstimateNote, NextStep, payText, say, sectionTitle, TaskLabel } from './kit'
import { mythFigure } from './tasks'

const ease = [0.16, 1, 0.3, 1] as const
const letters = ['А', 'Б', 'В', 'Г', 'Д', 'Е', 'Ж', 'З', 'И', 'К', 'Л', 'М']
const lowerFirst = (t: string) => t.charAt(0).toLowerCase() + t.slice(1)

const monthIndex: Record<string, number> = { март: 3, апрель: 4, май: 5, июнь: 6, июль: 7, август: 8, сентябрь: 9 }
const monthName: Record<number, string> = { 3: 'март', 4: 'апрель', 5: 'май', 6: 'июнь', 7: 'июль', 8: 'август', 9: 'сентябрь' }
/** «с июня» — начало срока */
const monthFrom: Record<number, string> = { 3: 'марта', 4: 'апреля', 5: 'мая', 6: 'июня', 7: 'июля', 8: 'августа', 9: 'сентября' }

/**
 * Месяцы вакансии из строки «Июнь — август». Срок другого вида — «Март или апрель — июль или середина августа»
 * у практики, «Срок по договорённости», «Круглый год» — пустой список: летних месяцев от себя не обещаем
 */
function periodMonths(period: string): number[] {
  const [from, to] = period.toLowerCase().split(/\s*—\s*/)
  const a = monthIndex[from]
  const b = monthIndex[to ?? from]
  if (!a || !b || b < a) return []
  return Array.from({ length: b - a + 1 }, (_, i) => a + i)
}

/** Человек выбрал «1–2 месяца летом»: главным показываем летние месяцы вакансии, а не весь её срок */
function summerText(v: Vacancy) {
  const summer = periodMonths(v.period).filter((m) => m >= 6 && m <= 8)
  if (!summer.length) return null
  const range = summer.length > 1 ? `с ${monthFrom[summer[0]]} по ${monthName[summer.at(-1)!]}` : `на ${monthName[summer[0]]}`
  return `Можно ${range}`
}

/**
 * Фото отдела для итога. Каждый кадр на главной — один раз: «Путь кваса», карточки мифов и первый экран свои кадры
 * уже показывают, поэтому у отдела — первый кадр из списка, которого там нет. Свободного кадра нет — итог без фото
 */
const elsewhere = new Set<PhotoName>([
  ...stages.map((s) => s.photo),
  ...myths.flatMap((m) => (m.photo && !mythFigure(m) ? [m.photo] : [])),
  'excursion',
  'excursion-portrait',
])
const deptChoices: Record<DepartmentId, PhotoName[]> = {
  production: ['hero-line', 'line-kvass'],
  quality: ['grain', 'lab'],
  engineering: ['brewhall', 'brewhouse'],
  logistics: ['driver', 'cans-line'],
  sales: ['kvass-mug', 'products'],
  office: ['plant'],
}
const deptPhoto = (v: Vacancy): PhotoName | null => deptChoices[v.department].find((p) => !elsewhere.has(p)) ?? null

/**
 * Три лучшие вакансии по ответам и «почему» для каждой — какие ответы дали ей очки.
 * Первая совпадает с scoreQuiz: при равенстве выше та, что раньше в списке вакансий.
 */
function rank(answers: number[]): { v: Vacancy; why: string[] }[] {
  const total = new Map<string, number>()
  const why = new Map<string, { text: string; w: number }[]>()
  answers.forEach((a, q) => {
    const pick = quiz[q]?.answers[a]
    if (!pick) return
    for (const [id, w] of Object.entries(pick.weights)) {
      total.set(id, (total.get(id) ?? 0) + w)
      why.set(id, [...(why.get(id) ?? []), { text: pick.text, w }])
    }
  })
  return vacancies
    .filter((v) => total.get(v.id))
    .sort((a, b) => total.get(b.id)! - total.get(a.id)! || vacancies.indexOf(a) - vacancies.indexOf(b))
    .slice(0, 3)
    .map((v) => ({ v, why: why.get(v.id)!.sort((x, y) => y.w - x.w).slice(0, 2).map((x) => x.text) }))
}

const whyLine = (why: string[]) => `Совпало с ответами: ${why.map((t) => `«${lowerFirst(t)}»`).join(' и ')}`

/** Задание «Подбор работы»: четыре вопроса — и конкретная вакансия или практика: с суммой или «без оплаты» */
export function QuizSection() {
  const saved = useProfile((s) => s.quizVacancy)
  const savedAnswers = useProfile((s) => s.quizAnswers)
  const setQuizResult = useProfile((s) => s.setQuizResult)
  const setQuizVacancy = useProfile((s) => s.setQuizVacancy)
  const setQuizAnswers = useProfile((s) => s.setQuizAnswers)
  const complete = useActivities((s) => s.complete)
  const [picks, setPicks] = useState<number[]>([])
  const [restarted, setRestarted] = useState(false)
  const [message, setMessage] = useState<{ key: number; text: string } | null>(null)
  // Фокус переводим только после действия человека, а не при загрузке страницы
  const moveFocus = useRef(false)
  // Новый вопрос или итог появляется после анимации ухода старого — фокусируем его в момент появления
  const heading = useCallback((el: HTMLHeadingElement | null) => {
    if (!el || !moveFocus.current) return
    moveFocus.current = false
    el.focus({ preventScroll: true })
  }, [])

  const step = picks.length
  const finished = step === quiz.length
  const answers = finished ? picks : !restarted ? savedAnswers : null
  const ranked = answers?.length === quiz.length ? rank(answers) : []
  const resultId = finished ? scoreQuiz(picks.map((a, q) => quiz[q].answers[a])) : !restarted ? saved : null
  const vacancy = resultId ? vacancyById(resultId) : undefined
  const alternatives = ranked.filter((r) => r.v.id !== vacancy?.id).slice(0, 2)
  const mainWhy = ranked.find((r) => r.v.id === vacancy?.id)?.why
  const shortSummer = !!answers?.some((a, q) => quiz[q]?.answers[a]?.text.startsWith('1–2 месяца'))
  const summer = vacancy && shortSummer ? summerText(vacancy) : null
  const dept = vacancy ? departments[vacancy.department] : undefined
  const photo = vacancy ? deptPhoto(vacancy) : null
  // «Собери лето» уже положил в заявку другую должность — не подменяем молча, а спрашиваем
  const moneyId = useProfile((s) => s.moneyVacancy)
  const chosenId = useProfile((s) => s.chosenVacancy)
  const setChosen = useProfile((s) => s.setChosenVacancy)
  const sent = useSentApplication((s) => s.last)
  const moneyVacancy = !sent && moneyId && vacancy && moneyId !== vacancy.id ? vacancyById(moneyId) : undefined
  const chosen = moneyVacancy ? [vacancy!, moneyVacancy].find((v) => v.id === chosenId) : vacancy

  const title = useReveal<HTMLHeadingElement>()

  const answer = (index: number) => {
    navigator.vibrate?.(8)
    moveFocus.current = true
    const next = [...picks, index]
    setPicks(next)
    if (next.length === quiz.length) {
      const id = scoreQuiz(next.map((a, q) => quiz[q].answers[a]))
      const v = vacancyById(id)!
      setQuizVacancy(id)
      setQuizAnswers(next)
      setQuizResult(v.department)
      // Новый результат подбора — прежний выбор между вакансиями сбрасываем
      useProfile.getState().setChosenVacancy(null)
      complete('quiz')
      setMessage(say(`Подбор готов: ${v.title}, ${payText(v).replace('\u00A0', ' ')}${v.pay ? ' в месяц' : ''}. Вакансия подставится в заявку.`))
    } else setMessage(say(`Вопрос ${next.length + 1} из ${quiz.length}`))
  }

  return (
    <section id="quiz" className="bg-coal py-20 text-white md:py-28">
      <Announce message={message} />
      <div className="container-x">
        <TaskLabel id="quiz" light />
        <div className="mt-6 grid grid-cols-[minmax(0,1fr)] gap-x-16 gap-y-10 lg:grid-cols-[4fr_7fr]">
          <div>
            <h2 ref={title} className={sectionTitle}>
              Подбор
              <br />
              работы
            </h2>
            <p className="mt-5 max-w-[340px] text-[17px] leading-relaxed text-white">
              {nb('Ответь на четыре вопроса, и сайт подберёт вакансию или практику. Она сама подставится в заявку.')}
            </p>
            {vacancy && dept && (
              <motion.figure
                key={vacancy.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.6, ease }}
                className="mt-10 hidden max-w-[420px] lg:block"
              >
                {photo && <Duo name={photo} tone="mono" sizes="(min-width: 1440px) 420px, 30vw" className="mb-4 aspect-[4/5]" />}
                <figcaption>
                  <span className="block font-display text-[22px] font-extrabold tracking-[0.04em] uppercase">Отдел: {dept.name}</span>
                  <span className="mt-1 block text-[17px] leading-relaxed text-white">{nb(dept.description)}</span>
                </figcaption>
              </motion.figure>
            )}
          </div>

          <div className="min-h-[440px]">
            <AnimatePresence mode="wait">
              {vacancy ? (
                <motion.div
                  key={`r-${vacancy.id}`}
                  initial={{ opacity: 0, y: 30 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.6, ease }}
                >
                  <h3 ref={heading} tabIndex={-1} className="outline-none">
                    <span className="block font-display text-[19px] font-bold tracking-[0.08em] uppercase">Тебе подойдёт</span>
                    <span className="mt-3 block font-display text-[clamp(38px,4.6vw,76px)] leading-[0.88] font-black break-words uppercase hyphens-auto" lang="ru">
                      {vacancy.title}
                    </span>
                  </h3>
                  <p className="mt-4 font-display text-[clamp(36px,3.4vw,56px)] leading-none font-black tabular-nums">
                    {payText(vacancy)}
                    {/* У бесплатной практики суммы нет — «в месяц» не пишем */}
                    {vacancy.pay && <span className="ml-2 font-sans text-[15px] font-medium tracking-normal normal-case">в месяц</span>}
                    <EstimateNote v={vacancy} light />
                  </p>
                  {mainWhy && <p className="mt-3 max-w-[560px] text-[15px] leading-snug">{nb(whyLine(mainWhy))}</p>}

                  <dl className="mt-6 grid gap-x-8 border-t border-white sm:grid-cols-2">
                    <div className="border-b border-white/40 py-3">
                      <dt className="text-[14px]">График</dt>
                      <dd className="text-[17px] font-medium">{scheduleLine(vacancy)}</dd>
                    </div>
                    <div className="border-b border-white/40 py-3">
                      <dt className="text-[14px]">Когда</dt>
                      <dd className="text-[17px] font-medium">
                        {summer ? (
                          <>
                            {summer} · {vacancy.format.toLowerCase()}
                            <span className="block text-[14px] font-normal">{nb('Срок обсуждают на собеседовании')}</span>
                          </>
                        ) : (
                          <>
                            {vacancy.period} · {vacancy.format.toLowerCase()}
                          </>
                        )}
                      </dd>
                    </div>
                  </dl>
                  <ul className="mt-4 space-y-1.5 text-[17px]">
                    {vacancy.tasks.map((t) => (
                      <li key={t} className="flex gap-3">
                        <span className="mt-[0.65em] h-[2px] w-3 shrink-0 bg-white" />
                        {t}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-3 text-[15px]">{nb(vacancy.requirements)}</p>

                  {moneyVacancy && (
                    <div className="mt-8 border-t-[3px] border-white pt-5" role="group" aria-labelledby="quiz-pick">
                      <p id="quiz-pick" className="max-w-[560px] text-[17px] leading-snug">
                        {nb(`В «Собери лето» выбрана другая должность. Какую отправить в заявке?`)}
                      </p>
                      <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
                        {[vacancy, moneyVacancy].map((v) => {
                          const on = chosen?.id === v.id
                          return (
                            <button
                              key={v.id}
                              onClick={() => {
                                setChosen(v.id)
                                setMessage(say(`В заявке: ${v.title}`))
                              }}
                              aria-pressed={on}
                              className={`flex min-h-16 flex-col items-start justify-center px-5 py-3 text-left ring-1 ring-white ring-inset transition-colors ${
                                on ? 'bg-white text-ink' : 'hover:bg-white hover:text-ink'
                              }`}
                            >
                              <span className="font-display text-[20px] leading-[1.05] font-extrabold uppercase">{v.title}</span>
                              <span className="mt-1 font-display text-[19px] font-black tabular-nums">
                                {payText(v)}
                                <span className="ml-2 font-sans text-[13px] font-medium normal-case">
                                  {v.id === vacancy.id ? 'по подбору' : 'из «Собери лето»'}
                                </span>
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {sent && sent.vacancyId !== vacancy.id && (
                    <div className="mt-8 border-t-[3px] border-white pt-5">
                      <p className="max-w-[560px] text-[17px] leading-snug">
                        {nb('Заявка уже отправлена. Если эта вакансия интереснее, скажи об этом HR на собеседовании.')}
                      </p>
                      <ButtonLink to="/apply" variant="white" className="mt-4 w-fit">
                        Моя заявка
                      </ButtonLink>
                    </div>
                  )}

                  <NextStep after="quiz" vacancy={chosen} className="mt-7" />

                  {alternatives.length > 0 && (
                    <div className="mt-10">
                      <p className="font-display text-[19px] font-bold tracking-[0.08em] uppercase">Ещё подойдут</p>
                      <ul className="mt-3 border-t border-white">
                        {alternatives.map(({ v, why }) => (
                          <li key={v.id} className="border-b border-white/40 py-4">
                            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                              <Link to={`/vacancies?open=${v.id}`} className="font-display text-[clamp(24px,2.2vw,32px)] leading-[0.95] font-extrabold uppercase hover:underline">
                                {v.title}
                              </Link>
                              <span className="font-display text-[22px] font-black whitespace-nowrap tabular-nums">
                                {payText(v)}
                                <EstimateNote v={v} light />
                              </span>
                            </div>
                            <p className="mt-1 text-[15px] font-medium">{scheduleLine(v)}</p>
                            <p className="mt-1.5 text-[15px] leading-snug">{nb(whyLine(why))}</p>
                            <Link to={`/apply?vacancy=${v.id}`} className="-mb-2.5 inline-block py-2.5 text-[15px] font-medium underline decoration-white/60 underline-offset-4 hover:decoration-white">
                              Откликнуться на эту вакансию
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <button
                    onClick={() => {
                      moveFocus.current = true
                      setPicks([])
                      setRestarted(true)
                      setMessage(say(`Подбор заново. Вопрос 1 из ${quiz.length}`))
                    }}
                    className="mt-2 -mb-3 py-3 text-[15px] underline decoration-white/60 underline-offset-4 hover:decoration-white"
                  >
                    Пройти заново
                  </button>
                </motion.div>
              ) : (
                <motion.div
                  key={`q-${step}`}
                  initial={{ opacity: 0, x: 50 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -50 }}
                  transition={{ duration: 0.45, ease }}
                >
                  <div className="flex items-center gap-4">
                    <span className="font-display text-[22px] font-black tabular-nums">
                      {step + 1}/{quiz.length}
                    </span>
                    <span className="flex flex-1 gap-1.5" aria-hidden="true">
                      {quiz.map((_, i) => (
                        <span key={i} className={`h-1 flex-1 transition-colors duration-500 ${i <= step ? 'bg-brand' : 'bg-white/30'}`} />
                      ))}
                    </span>
                  </div>
                  <h3 ref={heading} tabIndex={-1} className="mt-7 font-display text-[clamp(40px,4.2vw,68px)] leading-[0.88] font-black uppercase outline-none">
                    {quiz[step].text}
                  </h3>
                  <ul className="mt-6 border-t border-white">
                    {quiz[step].answers.map((a, i) => (
                      <li key={a.text} className="border-b border-white/40">
                        <button
                          onClick={() => answer(i)}
                          className="group flex w-full items-center gap-5 py-3 text-left text-[17px] leading-snug transition-colors hover:bg-white hover:text-brand focus-visible:bg-white focus-visible:text-brand md:py-4 md:text-xl"
                        >
                          <span className="w-8 shrink-0 pl-2 font-display text-[24px] font-black" aria-hidden="true">
                            {letters[i] ?? i + 1}
                          </span>
                          {a.text}
                        </button>
                      </li>
                    ))}
                  </ul>
                  {step > 0 && (
                    <button
                      onClick={() => {
                        moveFocus.current = true
                        setPicks(picks.slice(0, -1))
                      }}
                      className="mt-2 -mb-3 py-3 text-[15px] underline decoration-white/60 underline-offset-4 hover:decoration-white"
                    >
                      Назад
                    </button>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </section>
  )
}
