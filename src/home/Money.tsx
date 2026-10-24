import { animate, motion, useMotionValue, useTransform } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { PAY_DAYS } from '@shared/content/handbook'
import { paidPracticeInfo } from '@shared/content/practice'
import { netPay, scheduleLine, SHIFT_HOURS_2_2, shiftPay, vacancyById, type ShiftPay, type Vacancy } from '@shared/content/vacancies'
import { BottleShape } from '../game/Bottle'
import { useReveal } from '../lib/motion'
import { inviteUrl } from '../lib/ref'
import { seasonMonths } from '../lib/season'
import { nb } from '../lib/typo'
import { useProfile } from '../store/profile'
import { useActivities } from '../store/activities'
import { Announce, btn, Dash, NextStep, say, sectionTitle, TaskLabel } from './kit'

// Три должности с графиком 2/2 по 12 часов — у них считаются деньги за смену и в час (shiftPay).
// Суммы — по «Описанию практики» и hh.ru (shared/content/vacancies.ts): технологический цех и лаборатория — оплачиваемая
// практика, фирменный магазин — постоянная работа. Те же три должности считает бот
const roles: { id: string; short: string }[] = [
  { id: 'fermentation-assistant', short: 'Технологический цех' },
  { id: 'lab-chemist', short: 'Лаборатория' },
  { id: 'store-worker', short: 'Фирменный магазин' },
]

const SUMMER = [6, 7, 8]
const AFTER_EXAMS = [7, 8]
const SEASON = seasonMonths.map((m) => m.value)
/**
 * Месяцы оплачиваемой практики. «Описание практики»: «Длится с начала марта (начала апреля) до конца июля (середины августа)» —
 * сентябрь уже не практика. Постоянная работа — весь сезон
 */
const PRACTICE_MONTHS = [3, 4, 5, 6, 7, 8]
const isPaidPractice = (v: Vacancy) => v.format === 'Оплачиваемая практика'
const monthsFor = (v: Vacancy) => (isPaidPractice(v) ? PRACTICE_MONTHS : SEASON)
/** Выбранные месяцы, которые есть у должности; если не осталось ни одного — лето */
const fitMonths = (list: number[], v: Vacancy) => {
  const allowed = monthsFor(v)
  const kept = list.filter((m) => allowed.includes(m))
  return kept.length ? kept : SUMMER.filter((m) => allowed.includes(m))
}

const monthNames: Record<number, string> = { 3: 'март', 4: 'апрель', 5: 'май', 6: 'июнь', 7: 'июль', 8: 'август', 9: 'сентябрь' }
const monthShort: Record<number, string> = Object.fromEntries(seasonMonths.map((m) => [m.value, m.label]))
const rub = (n: number) => n.toLocaleString('ru-RU')
const lowerFirst = (t: string) => t.charAt(0).toLowerCase() + t.slice(1)
const plural = (n: number) => (n === 1 ? 'месяц' : n < 5 ? 'месяца' : 'месяцев')
const same = (a: number[], b: number[]) => a.length === b.length && a.every((m) => b.includes(m))
/** «с июня по август» для подряд идущих месяцев, иначе перечислением */
const monthFrom: Record<number, string> = { 3: 'марта', 4: 'апреля', 5: 'мая', 6: 'июня', 7: 'июля', 8: 'августа', 9: 'сентября' }
const monthsText = (list: number[]) => {
  const sorted = [...list].sort((a, b) => a - b)
  const solid = sorted.every((m, i) => !i || m === sorted[i - 1] + 1)
  if (sorted.length > 2 && solid) return `с ${monthFrom[sorted[0]]} по ${monthNames[sorted.at(-1)!]}`
  return sorted.map((m) => monthNames[m]).join(', ')
}

/** «≈ 6 200 ₽ на руки за смену, ≈ 520 ₽ в час при 15 сменах в месяц по 12 часов»: те же числа, что у Квасыча */
function shiftText(v: Vacancy, s: ShiftPay) {
  // В расчёте 15,2 смены — среднее за месяц; человеку понятнее «15 смен»
  const n = Math.round(s.shiftsPerMonth)
  const hours = SHIFT_HOURS_2_2
  const shifts = n % 10 === 1 && n % 100 !== 11 ? 'смене' : 'сменах'
  return `≈ ${rub(s.perShift)} ₽ на руки за смену, ≈ ${rub(s.perHour)} ₽ в час при ${n} ${shifts} в месяц по ${hours} часов${v.pay?.estimate ? ', ориентир' : ''}`
}

function Count({ value }: { value: number }) {
  const mv = useMotionValue(value)
  const text = useTransform(mv, (v) => rub(Math.round(v / 100) * 100))
  useEffect(() => {
    const c = animate(mv, value, { duration: 0.8, ease: [0.16, 1, 0.3, 1] })
    return () => c.stop()
  }, [mv, value])
  return <motion.span>{text}</motion.span>
}

/** Сколько миллисекунд наливается бутылка до нового уровня. При уменьшении движения CSS выключает переход — сразу */
const POUR_MS = 600

/**
 * Большая бутылка «Собери лето»: уровень — выбранные месяцы из семи месяцев сезона. Семь рисок по краю;
 * у налитых — выбранные месяцы снизу вверх, по одному на слой. Декоративная: сумму вслух называет текст рядом
 */
function SeasonBottle({ months, className = '' }: { months: number[]; className?: string }) {
  const sorted = [...months].sort((a, b) => a - b)
  // Жидкость в BottleShape — от y = 10 до y = 96 по viewBox 0 0 40 100
  const tickTop = (k: number) => `${96 - (86 * k) / SEASON.length}%`
  return (
    <div className={`relative aspect-[2/5] ${className}`} aria-hidden="true" data-season-bottle>
      <BottleShape level={months.length / SEASON.length} duration={POUR_MS} className="block size-full text-white" />
      <ol className="absolute inset-y-0 left-full ml-2 w-14">
        {SEASON.map((_, i) => {
          const k = i + 1
          const on = k <= sorted.length
          return (
            <li key={k} className="absolute left-0 flex -translate-y-1/2 items-center gap-1.5" style={{ top: tickTop(k) }}>
              <span className={`block h-[2px] w-3 ${on ? 'bg-white' : 'bg-white/35'}`} />
              <span className={`font-display text-[17px] leading-none font-bold tracking-[0.06em] uppercase ${on ? 'text-white' : 'text-transparent'}`}>
                {on ? monthShort[sorted[i]] : '·'}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/** «Поделиться расчётом»: меню телефона, иначе текст со ссылкой в буфер */
function ShareCalc({ text }: { text: string }) {
  const [status, setStatus] = useState('')
  const share = async () => {
    const url = inviteUrl('/#money')
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Собери лето в «Очаково»', text, url })
        return
      }
      await navigator.clipboard.writeText(`${text} ${url}`)
      setStatus('Расчёт и ссылка скопированы, можно отправлять.')
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setStatus(`Скопируй ссылку: ${url}`)
    }
  }
  return (
    <div className="mt-4">
      <button
        onClick={() => void share()}
        className="-my-3 py-3 text-[15px] text-white/80 underline decoration-white/40 underline-offset-4 hover:text-white"
      >
        Поделиться расчётом
      </button>
      <p className="mt-1 min-h-[1lh] text-[15px] text-white/80" role="status">
        {status}
      </p>
    </div>
  )
}

/**
 * Задание «Собери лето»: лето уже выбрано, месяцы и должность меняют сумму и уровень кваса в бутылке.
 * Задание засчитывается, когда человек сам подтверждает месяцы для заявки, а не от случайного нажатия
 */
export function Money() {
  const complete = useActivities((s) => s.complete)
  const savedMonths = useProfile((s) => s.months)
  const saveMonths = useProfile((s) => s.setMonths)
  const savedRole = useProfile((s) => s.moneyVacancy)
  const [roleId, setRoleId] = useState(() => (roles.some((r) => r.id === savedRole) ? savedRole! : roles[0].id))
  const [months, setMonths] = useState<number[]>(() => fitMonths(savedMonths?.length ? savedMonths : SUMMER, vacancyById(roleId)!))
  const [touched, setTouched] = useState(false)
  const [message, setMessage] = useState<{ key: number; text: string } | null>(null)
  const confirmedRef = useRef<HTMLParagraphElement>(null)
  const title = useReveal<HTMLHeadingElement>()
  const saved = !!savedMonths?.length && same(savedMonths, months) && savedRole === roleId

  const role = roles.find((r) => r.id === roleId)!
  const vacancy = vacancyById(role.id)!
  const allowed = monthsFor(vacancy)
  const practice = isPaidPractice(vacancy)
  const monthly = vacancy.pay!.from
  const total = monthly * months.length
  const net = netPay(total)
  const shift = shiftPay(vacancy)
  const perShift = shift ? shiftText(vacancy, shift) : ''

  const interact = () => setTouched(true)

  const confirm = () => {
    const profile = useProfile.getState()
    saveMonths(months)
    profile.setMoneyVacancy(roleId)
    // Должность поменялась — прежний выбор между «Собери лето» и подбором больше не действует
    if (profile.chosenVacancy && profile.chosenVacancy !== roleId) profile.setChosenVacancy(null)
    complete('money')
    setMessage(say(`В заявке: ${role.short}, ${monthsText(months)}.`))
  }

  // После подтверждения фокус — на строку «Месяцы в заявке», с неё видно следующий шаг
  const justSaved = useRef(false)
  useEffect(() => {
    if (saved && justSaved.current) confirmedRef.current?.focus({ preventScroll: true })
    justSaved.current = false
  }, [saved])
  const toggle = (m: number) => {
    if (!allowed.includes(m)) return
    navigator.vibrate?.(8)
    setMonths(months.includes(m) ? months.filter((x) => x !== m) : [...months, m].sort((a, b) => a - b))
    interact()
  }

  // Тот же расчёт, что на экране: сумма на руки и до вычета, деньги за смену и в час
  const shareText =
    `${vacancy.title}, ${monthsText(months)}: ≈ ${rub(net)} ₽ на руки, до вычета налога от ${rub(total)} ₽.` +
    (shift ? ` За смену ≈ ${rub(shift.perShift)} ₽, в час ≈ ${rub(shift.perHour)} ₽.` : '') +
    ' Посчитай своё лето в «Очаково»:'

  return (
    <section id="money" className="relative overflow-hidden bg-night py-20 text-white md:py-28">
      <div className="container-x">
        <TaskLabel id="money" light />
        <h2 ref={title} className={`mt-6 ${sectionTitle}`}>
          Собери лето
        </h2>

        <div className="mt-10 grid grid-cols-[minmax(0,1fr)] gap-12 lg:mt-14 lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-16 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div>
            <p className="font-display text-[19px] font-bold tracking-[0.08em] text-white/60 uppercase">Кем работать</p>
            <div className="mt-3 grid border-y border-white/25 sm:grid-cols-3" role="group" aria-label="Должность">
              {roles.map((r) => {
                const v = vacancyById(r.id)!
                const active = r.id === roleId
                return (
                  <button
                    key={r.id}
                    onClick={() => {
                      setRoleId(r.id)
                      // У практики нет сентября: месяцы, которых у должности нет, снимаются
                      setMonths(fitMonths(months, v))
                      interact()
                    }}
                    aria-pressed={active}
                    className={`flex items-baseline justify-between gap-3 border-white/25 px-4 py-4 text-left transition-colors sm:block sm:border-l sm:first:border-l-0 max-sm:border-b max-sm:last:border-b-0 ${
                      active ? 'bg-white text-ink' : 'hover:bg-white/8'
                    }`}
                  >
                    <span className="block font-display text-[24px] leading-none font-extrabold uppercase">{r.short}</span>
                    <span className="block font-display text-[20px] leading-none font-black whitespace-nowrap tabular-nums sm:mt-2 md:text-[22px]">
                      {v.pay!.to ? `${rub(v.pay!.from)}–${rub(v.pay!.to)}` : `от ${rub(v.pay!.from)}`}&nbsp;₽
                    </span>
                  </button>
                )
              })}
            </div>

            <div className="mt-9 flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
              <p className="text-[17px] text-white/80">
                {!touched && same(months, SUMMER) ? 'Выбрано лето. Нажми на месяц, чтобы добавить или убрать' : 'Нажми на месяц, чтобы добавить или убрать'}
              </p>
              <div className="flex shrink-0 flex-wrap gap-x-5">
                {[
                  { label: 'Только лето', value: SUMMER },
                  { label: 'После сессии', value: AFTER_EXAMS },
                  practice ? { label: 'Вся практика', value: PRACTICE_MONTHS } : { label: 'Весь сезон', value: SEASON },
                ].map((preset) => {
                  const isOn = same(preset.value, months)
                  return (
                    <button
                      key={preset.label}
                      onClick={() => {
                        setMonths(preset.value)
                        interact()
                      }}
                      aria-pressed={isOn}
                      className={`-my-3 w-fit py-3 text-[15px] underline underline-offset-4 ${isOn ? 'text-white decoration-white' : 'text-white/75 decoration-white/40 hover:text-white'}`}
                    >
                      {preset.label}
                    </button>
                  )
                })}
              </div>
            </div>
            <div className="mt-3 grid grid-cols-7 gap-1.5 md:gap-2" role="group" aria-label="Месяцы">
              {seasonMonths.map((m) => {
                const on = months.includes(m.value)
                const off = !allowed.includes(m.value)
                return (
                  <motion.button
                    key={m.value}
                    onClick={() => toggle(m.value)}
                    aria-pressed={on}
                    aria-label={monthNames[m.value]}
                    // Месяца нет у должности (сентябрь у практики): кнопка видна, но не нажимается — подпись ниже объясняет почему
                    disabled={off}
                    aria-describedby={off ? 'money-months-note' : undefined}
                    whileTap={off ? undefined : { scale: 0.92 }}
                    className={`relative flex h-20 flex-col items-center justify-end overflow-hidden pb-2 font-display text-[clamp(20px,2.2vw,30px)] font-extrabold uppercase ring-inset md:h-28 ${
                      off ? 'cursor-not-allowed text-white/30 ring-1 ring-white/15 [background:repeating-linear-gradient(135deg,transparent_0_7px,rgb(255_255_255/0.07)_7px_8px)]' : 'ring-1 ring-white/30'
                    }`}
                  >
                    {/* Месяц «наливается» красным снизу вверх */}
                    <motion.span
                      className="absolute inset-x-0 bottom-0 bg-brand"
                      initial={false}
                      animate={{ height: on ? '100%' : '0%' }}
                      transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
                    />
                    <span className={`relative ${on ? 'text-white' : off ? '' : 'text-white/70'}`}>{m.label}</span>
                  </motion.button>
                )
              })}
            </div>
            {practice && (
              <p id="money-months-note" className="mt-3 text-[15px] leading-snug text-white/75">
                {nb(`Практика идёт ${lowerFirst(paidPracticeInfo.period)}. В сентябре практики нет.`)}
              </p>
            )}

            <div className="mt-10 border-t-[3px] border-white pt-5">
              <Announce message={message} />
              <p className="font-display text-[19px] font-bold tracking-[0.08em] text-white/75 uppercase">
                {months.length ? `На руки за ${months.length} ${plural(months.length)}, примерно` : 'Выбери хотя бы один месяц'}
              </p>
              <div className="mt-2 flex items-end gap-4 lg:block">
                {/* Телефон и планшет: узкая бутылка слева от суммы, на компьютере — большая справа */}
                <div className="shrink-0 lg:hidden">
                  <SeasonBottle months={months} className="h-[104px] sm:h-[132px] [&_ol]:hidden" />
                </div>
                {months.length ? (
                  <div className="flex min-w-0 flex-wrap items-end gap-x-8 gap-y-3">
                    <p data-money-net className="font-display text-[clamp(64px,12vw,196px)] leading-[0.8] font-black text-brand tabular-nums [overflow-wrap:anywhere]">
                      <span className="text-[0.35em] text-white">≈&nbsp;</span>
                      <Count value={net} />
                      <span className="text-[0.55em]">&nbsp;₽</span>
                    </p>
                    <p className="pb-2 font-display text-[clamp(24px,2.2vw,34px)] leading-none font-black text-white/80 tabular-nums">
                      до вычета налога от <Count value={total} />&nbsp;₽
                    </p>
                  </div>
                ) : null}
              </div>
              {months.length && perShift ? (
                <p data-money-shift className="mt-4 font-display text-[clamp(22px,2vw,28px)] leading-[1.05] font-extrabold tracking-[0.02em] uppercase">
                  {nb(perShift)}
                </p>
              ) : null}
              <p className="mt-4 max-w-[600px] text-[17px] leading-relaxed text-white/75">
                {months.length
                  ? nb(
                      `${vacancy.title}: от ${rub(monthly)} ₽ в месяц × ${months.length} ${plural(months.length)}, ${scheduleLine(vacancy)}. ` +
                        `Зарплата приходит ${PAY_DAYS[0]}-го и ${PAY_DAYS[1]}-го, примерно по ${rub(Math.round(netPay(monthly) / 2 / 100) * 100)} ₽ на руки.` +
                        (vacancy.payNote ? ` ${vacancy.payNote.charAt(0).toUpperCase()}${vacancy.payNote.slice(1)}.` : ''),
                    )
                  : nb('Здесь появится сумма на руки.')}
              </p>
              {saved ? (
                <>
                  <p ref={confirmedRef} tabIndex={-1} className="mt-7 font-display text-[22px] font-extrabold tracking-[0.04em] uppercase outline-none">
                    В заявке: {role.short}, {monthsText(months)}
                  </p>
                  <ShareCalc text={shareText} />
                  <NextStep after="money" vacancy={vacancy} className="mt-4" />
                </>
              ) : (
                <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
                  <button
                    onClick={() => {
                      justSaved.current = true
                      confirm()
                    }}
                    disabled={!months.length}
                    className={`${btn.red} !h-auto min-h-16 !whitespace-normal py-3 text-left leading-[1.05] disabled:cursor-not-allowed disabled:bg-white/15 disabled:text-white/60`}
                  >
                    {savedMonths?.length ? 'Обновить заявку' : 'Подставить в заявку'}
                    <Dash />
                  </button>
                  <p className="text-[15px] leading-snug text-white/75">{nb('Должность и месяцы попадут в анкету, вводить их заново не придётся.')}</p>
                </div>
              )}
            </div>
          </div>

          {/* Компьютер: большая бутылка кваса — наливается вместе с месяцами; едет рядом с расчётом, пока он на экране */}
          <figure className="hidden lg:sticky lg:top-28 lg:flex lg:flex-col lg:items-center lg:self-start">
            <SeasonBottle months={months} className="h-[440px] -translate-x-7 xl:h-[500px]" />
            <figcaption className="mt-6 text-center font-display text-[22px] font-extrabold tracking-[0.06em] uppercase">
              {months.length} из {SEASON.length} месяцев сезона
            </figcaption>
          </figure>
        </div>
      </div>
    </section>
  )
}
