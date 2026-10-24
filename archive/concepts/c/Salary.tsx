import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { Photo, type PhotoName } from '../../components/Photo'
import { gsap, prefersReducedMotion, useGSAP } from '../../lib/motion'
import { nb } from '../../lib/typo'
import { CtaLink, TextLink } from './kit'

type Role = {
  title: string
  meta: string
  from?: number
  to?: number
  note?: string
  photo: PhotoName
  vacancy?: string
}

// Цифры — вакансии «Очаково» в Москве на hh.ru, до вычета налога
const roles: Role[] = [
  {
    title: 'Рабочий фирменного магазина',
    meta: '2/2, дневные смены по 12 часов · без опыта',
    from: 57000,
    to: 89000,
    photo: 'products',
    vacancy: 'store-worker',
  },
  {
    title: 'Оператор конвейерной линии',
    meta: '2/2, смены по 12 часов · без опыта, обучат на месте',
    from: 107000,
    photo: 'line-kvass',
    vacancy: 'bottling-operator',
  },
  {
    title: 'Экскурсовод на производстве',
    meta: '2/2, дневные смены · подходит студентам-историкам',
    from: 73000,
    photo: 'brewhouse',
    vacancy: 'tour-guide',
  },
  {
    title: 'Практика по специальности',
    meta: 'Лаборатория, производство, офис · для профильных направлений',
    note: 'оплачивается',
    photo: 'lab',
  },
]

const periods = [
  { id: 'month', label: 'в месяц', months: 1, caption: 'в месяц' },
  { id: 'summer', label: 'за лето', months: 3, caption: 'за три летних месяца' },
  { id: 'season', label: 'за сезон', months: 7, caption: 'за сезон, март — сентябрь' },
] as const

const fmt = (n: number) => Math.round(n / 1000) * 1000

/** Число, которое плавно досчитывает до нового значения */
function Count({ value }: { value: number }) {
  const el = useRef<HTMLSpanElement>(null)
  const current = useRef(value)
  useEffect(() => {
    const node = el.current
    if (!node) return
    const state = { v: current.current }
    const tween = gsap.to(state, {
      v: value,
      duration: prefersReducedMotion() ? 0 : 0.9,
      ease: 'expo.out',
      onUpdate: () => {
        node.textContent = fmt(state.v).toLocaleString('ru-RU')
      },
      onComplete: () => {
        current.current = value
      },
    })
    return () => {
      current.current = state.v
      tween.kill()
    }
  }, [value])
  return <span ref={el}>{value.toLocaleString('ru-RU')}</span>
}

export function Salary() {
  const scope = useRef<HTMLElement>(null)
  const [period, setPeriod] = useState<(typeof periods)[number]>(periods[0])
  const [active, setActive] = useState(0)

  useGSAP(
    () => {
      if (prefersReducedMotion()) return
      gsap.from('.c-sal-title', {
        yPercent: 100,
        duration: 1.3,
        ease: 'expo.out',
        scrollTrigger: { trigger: scope.current, start: 'top 75%' },
      })
      gsap.from('.c-sal-row', {
        opacity: 0,
        y: 30,
        duration: 1,
        stagger: 0.08,
        ease: 'expo.out',
        scrollTrigger: { trigger: '.c-sal-list', start: 'top 85%' },
      })
    },
    { scope },
  )

  return (
    <section ref={scope} id="salary" className="relative overflow-hidden bg-(--c-bg) py-24 text-(--c-fg) md:py-36">
      {/* Фон за строками: кадр той роли, на которую навели */}
      <div className="pointer-events-none absolute inset-0 hidden md:block" aria-hidden="true">
        {roles.map((r, i) => (
          <Photo
            key={r.photo}
            name={r.photo}
            alt=""
            sizes="100vw"
            className={`absolute inset-0 transition-[opacity,scale] duration-[1200ms] ease-out-expo ${
              active === i ? 'scale-100 opacity-[0.16]' : 'scale-110 opacity-0'
            }`}
          />
        ))}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_75%_55%,transparent_10%,var(--c-bg)_70%)]" />
      </div>

      <div className="container-x relative">
        <div className="flex flex-col gap-8 md:flex-row md:items-end md:justify-between">
          <h2 className="display overflow-hidden pt-[0.1em] text-[clamp(88px,17vw,280px)]">
            <span className="c-sal-title block">Зарплата</span>
          </h2>
          <div className="md:pb-6">
            <div className="flex gap-6" role="tablist" aria-label="Период">
              {periods.map((p) => (
                <button
                  key={p.id}
                  role="tab"
                  aria-selected={period.id === p.id}
                  onClick={() => setPeriod(p)}
                  className={`border-b pb-1 font-display text-[22px] tracking-[0.06em] uppercase transition-colors duration-300 ${
                    period.id === p.id ? 'border-brand text-(--c-fg)' : 'border-transparent text-(--c-fg)/45 hover:text-(--c-fg)/80'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <p className="mt-4 max-w-[360px] text-[15px] text-(--c-fg)/55">
              {nb('До вычета налога. Официально, на карту, два раза в месяц.')}
            </p>
          </div>
        </div>

        <ul className="c-sal-list mt-14 border-t border-(--c-fg)/15 md:mt-20">
          {roles.map((r, i) => {
            const isActive = active === i
            return (
              <li
                key={r.title}
                className="c-sal-row border-b border-(--c-fg)/15"
                onPointerEnter={() => setActive(i)}
                onClick={() => setActive(i)}
              >
                <Link
                  to={r.vacancy ? `/vacancies?open=${r.vacancy}` : '/vacancies'}
                  className={`grid items-baseline gap-x-6 gap-y-2 py-7 transition-opacity duration-500 md:grid-cols-[64px_1.3fr_1fr] md:py-9 ${
                    isActive ? 'opacity-100' : 'md:opacity-45'
                  }`}
                >
                  <span className="c-serif text-[22px] text-(--c-amber)">0{i + 1}</span>
                  <span>
                    <span className="display block text-[clamp(36px,4.4vw,68px)]">{r.title}</span>
                    <span className="mt-2 block text-[15px] text-(--c-fg)/60 md:text-base">{nb(r.meta)}</span>
                  </span>
                  <span className="c-serif text-[clamp(44px,5vw,84px)] leading-none md:text-right">
                    {r.from ? (
                      <>
                        {!r.to && <span className="mr-2 text-[0.5em] text-(--c-fg)/60">от</span>}
                        <Count value={fmt(r.from * period.months)} />
                        {r.to && (
                          <>
                            <span className="text-(--c-fg)/40">–</span>
                            <Count value={fmt(r.to * period.months)} />
                          </>
                        )}
                        <span className="ml-2 text-[0.6em]">₽</span>
                        <span className="mt-2 block font-sans text-[14px] not-italic text-(--c-fg)/50">{period.caption}</span>
                      </>
                    ) : (
                      <span className="text-(--c-fg)/70">{r.note}</span>
                    )}
                  </span>
                </Link>
                {/* На телефоне — кадр под активной строкой */}
                <div
                  className={`grid transition-[grid-template-rows] duration-700 ease-out-expo md:hidden ${isActive ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
                >
                  <div className="overflow-hidden">
                    <Photo name={r.photo} alt="" sizes="100vw" className="mb-7 aspect-[16/9]" />
                  </div>
                </div>
              </li>
            )
          })}
        </ul>

        <div className="mt-14 flex flex-col gap-6 sm:flex-row sm:items-center sm:gap-10">
          <CtaLink to="/apply">Откликнуться</CtaLink>
          <TextLink to="/vacancies">Все вакансии и стажировки</TextLink>
        </div>
      </div>
    </section>
  )
}
