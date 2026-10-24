import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { Photo, type PhotoName } from '../../components/Photo'
import { gsap, prefersReducedMotion, useGSAP } from '../../lib/motion'
import { nb } from '../../lib/typo'
import { FitLine } from './parts'

type Role = {
  id: string
  title: string
  from: number
  to?: number
  details: string
  photo: PhotoName
}

// Москва, по вакансиям «Очаково» на hh.ru, до вычета НДФЛ
const roles: Role[] = [
  {
    id: 'store-worker',
    title: 'Рабочий фирменного магазина',
    from: 57000,
    to: 89000,
    details: '2/2, дневные смены по 12 часов · без опыта',
    photo: 'products',
  },
  {
    id: 'bottling-operator',
    title: 'Оператор конвейерной линии',
    from: 107000,
    details: '2/2, смены по 12 часов · без опыта, обучат на месте',
    photo: 'line-kvass',
  },
  {
    id: 'tour-guide',
    title: 'Экскурсовод на производстве',
    from: 73000,
    details: '2/2, дневные смены · подходит студентам-историкам',
    photo: 'archive-1978',
  },
]

const periods = [
  { months: 1, label: 'В месяц' },
  { months: 3, label: 'За лето' },
  { months: 7, label: 'За сезон' },
]

const perks = [
  ['Официально', 'с первого рабочего дня'],
  ['Два раза в месяц', 'приходит зарплата'],
  ['Общежитие', 'рядом с заводом'],
  ['Столовая', 'часть стоимости оплачивает завод'],
  ['ДМС', 'страховка за счёт компании'],
  ['Автобус', 'от метро «Озёрная» до завода'],
]

/** Число, которое плавно пересчитывается при переключении периода */
function Thousands({ value }: { value: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  const current = useRef(value)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const state = { v: current.current }
    const tween = gsap.to(state, {
      v: value,
      duration: prefersReducedMotion() ? 0 : 0.7,
      ease: 'expo.out',
      onUpdate: () => {
        el.textContent = Math.round(state.v / 1000).toLocaleString('ru-RU')
      },
    })
    current.current = value
    return () => {
      tween.kill()
    }
  }, [value])
  return <span ref={ref}>{Math.round(value / 1000).toLocaleString('ru-RU')}</span>
}

/** «Зарплата» в духе плаката: таблица с огромными цифрами и переключатель периода */
export function Salary() {
  const scope = useRef<HTMLElement>(null)
  const [months, setMonths] = useState(1)

  useGSAP(
    () => {
      if (prefersReducedMotion()) return
      gsap.from('.b-row', {
        yPercent: 40,
        opacity: 0,
        duration: 1,
        ease: 'expo.out',
        stagger: 0.08,
        scrollTrigger: { trigger: '.b-table', start: 'top 85%' },
      })
      gsap.from('.b-salary-title-inner', {
        yPercent: 100,
        duration: 1.2,
        ease: 'expo.out',
        scrollTrigger: { trigger: scope.current, start: 'top 75%' },
      })
    },
    { scope },
  )

  return (
    <section ref={scope} id="salary" className="overflow-hidden bg-paper pt-16 text-ink md:pt-24">
      <h2 className="overflow-hidden px-4 pt-[1.5%] font-display leading-[0.8] font-black uppercase md:px-8">
        <span className="b-salary-title-inner block">
          <FitLine>Зарплата</FitLine>
        </span>
      </h2>

      <div className="px-5 md:px-10">
        <div className="mt-8 flex flex-col gap-5 md:mt-12 md:flex-row md:items-end md:justify-between">
          <p className="max-w-[460px] text-[19px] leading-snug font-medium">
            {nb('Официально, два раза в месяц. Цифры — по открытым вакансиям завода в Москве, до вычета НДФЛ.')}
          </p>
          <div className="flex w-full ring-2 ring-ink ring-inset md:w-auto" role="group" aria-label="Период">
            {periods.map((p) => (
              <button
                key={p.months}
                onClick={() => setMonths(p.months)}
                aria-pressed={months === p.months}
                className={`h-14 flex-1 px-5 font-display text-[21px] font-black tracking-[0.03em] uppercase transition-colors md:flex-none md:px-7 ${
                  months === p.months ? 'bg-ink text-white' : 'hover:bg-ink/10'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <ol className="b-table mt-8 border-t-[3px] border-ink md:mt-12">
          {roles.map((r, i) => (
            <li key={r.id} className="b-row border-b-[3px] border-ink">
              <Link
                to={`/apply?vacancy=${r.id}`}
                className="group grid grid-cols-[1fr_auto] items-end gap-x-6 gap-y-3 py-6 transition-colors duration-300 hover:bg-brand hover:text-white md:grid-cols-[64px_1.1fr_1fr_200px] md:items-center md:px-4 md:py-8"
              >
                <span className="hidden font-display text-[34px] font-black text-ink/30 group-hover:text-white/60 md:block">0{i + 1}</span>
                <span className="col-span-2 md:col-span-1">
                  <span className="block font-display text-[clamp(32px,3.6vw,52px)] leading-[0.9] font-black uppercase">{r.title}</span>
                  <span className="mt-2 block text-[16px] text-ink/65 group-hover:text-white/80">{r.details}</span>
                </span>
                <span className="col-span-2 font-display leading-[0.82] font-black text-brand uppercase group-hover:text-white md:col-span-1 md:text-right">
                  <span className="text-[clamp(26px,2.4vw,36px)]">{r.to ? '' : 'от '}</span>
                  <span className="text-[clamp(76px,8vw,128px)] tabular-nums">
                    <Thousands value={r.from * months} />
                    {r.to && (
                      <>
                        –<Thousands value={r.to * months} />
                      </>
                    )}
                  </span>
                  <span className="text-[clamp(26px,2.4vw,36px)]">&nbsp;тыс.&nbsp;₽</span>
                </span>
                <span className="relative hidden aspect-[4/3] overflow-hidden md:block">
                  <Photo
                    name={r.photo}
                    alt=""
                    sizes="200px"
                    className="absolute inset-0"
                    imgClassName="grayscale contrast-[1.15] transition-[filter] duration-500 group-hover:grayscale-0"
                  />
                </span>
              </Link>
            </li>
          ))}
        </ol>

        <ul className="mt-14 grid grid-cols-2 border-l-[3px] border-ink md:mt-20 md:grid-cols-3 lg:grid-cols-6">
          {perks.map(([title, text]) => (
            <li key={title} className="border-r-[3px] border-b-[3px] border-ink p-4 md:p-5 [&:nth-child(-n+2)]:border-t-[3px] md:[&:nth-child(-n+3)]:border-t-[3px] lg:[&:nth-child(-n+6)]:border-t-[3px]">
              <p className="font-display text-[clamp(26px,2.2vw,32px)] leading-[0.9] font-black uppercase">{title}</p>
              <p className="mt-2 text-[15px] leading-snug text-ink/70">{nb(text)}</p>
            </li>
          ))}
        </ul>
      </div>

      {/* Финальная полоса — целиком кнопка */}
      <Link to="/apply" className="group mt-16 block bg-brand px-4 pt-6 pb-3 text-white transition-colors hover:bg-ink md:mt-24 md:px-8 md:pt-10 md:pb-5">
        <span className="flex items-center justify-between px-1 font-display text-[15px] font-bold tracking-[0.14em] uppercase md:text-[17px]">
          <span>Заявка за минуту · без резюме</span>
          <span className="hidden md:inline">Москва · ул. Рябиновая, 44</span>
        </span>
        <span className="mt-2 block font-display leading-[0.8] font-black uppercase">
          <FitLine>Откликнуться →</FitLine>
        </span>
      </Link>
    </section>
  )
}
