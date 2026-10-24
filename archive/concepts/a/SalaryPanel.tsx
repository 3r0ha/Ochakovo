import { animate, motion, useMotionValue, useTransform } from 'motion/react'
import { useEffect, useId, useState } from 'react'
import { Link } from 'react-router'
import { Photo, type PhotoName } from '../../components/Photo'
import { nb } from '../../lib/typo'
import { dela, yeseva } from './fonts'

type Role = {
  id: string
  title: string
  from: number
  to?: number
  note: string
  photo: PhotoName
  place: string
}

// Цифры — открытые вакансии «Очаково» в Москве на hh.ru, до вычета НДФЛ
const roles: Role[] = [
  {
    id: 'bottling-operator',
    title: 'Оператор конвейерной линии',
    from: 107000,
    note: '2/2, смены по 12 часов · без опыта',
    photo: 'line-kvass',
    place: 'Линия розлива кваса',
  },
  {
    id: 'tour-guide',
    title: 'Экскурсовод на производстве',
    from: 73000,
    note: '2/2, дневные смены · для студентов-историков',
    photo: 'brewhall',
    place: 'Варочный цех',
  },
  {
    id: 'store-worker',
    title: 'Рабочий фирменного магазина',
    from: 57000,
    to: 89000,
    note: '2/2, дневные смены · без опыта и резюме',
    photo: 'products',
    place: 'Фирменный магазин',
  },
]

const periods = [
  { months: 1, label: '1 месяц' },
  { months: 3, label: 'Лето' },
  { months: 7, label: 'Март — сентябрь' },
]

const conditions = [
  'Официально, с первого дня',
  'Обед в столовой — часть оплачивает завод',
  'ДМС',
  'Общежитие рядом с заводом',
  'Автобус от м. «Озёрная»',
]

const rub = (n: number) => n.toLocaleString('ru-RU')

function Total({ value }: { value: number }) {
  const mv = useMotionValue(value)
  const text = useTransform(mv, (v) => rub(Math.round(v / 1000) * 1000))
  useEffect(() => {
    const c = animate(mv, value, { duration: 0.7, ease: [0.16, 1, 0.3, 1] })
    return () => c.stop()
  }, [mv, value])
  return <motion.span>{text}</motion.span>
}

/** Форма бутылки для фото — в долях от рамки, чтобы тянулась под любой размер */
function BottleClip({ id }: { id: string }) {
  return (
    <svg width="0" height="0" className="absolute" aria-hidden="true">
      <clipPath id={id} clipPathUnits="objectBoundingBox">
        <path d="M0.38,0 H0.62 V0.12 C0.62,0.2 0.98,0.24 0.98,0.36 V0.94 Q0.98,1 0.9,1 H0.1 Q0.02,1 0.02,0.94 V0.36 C0.02,0.24 0.38,0.2 0.38,0.12 Z" />
      </clipPath>
    </svg>
  )
}

/** «Зарплата» в виде панели состава на этикетке: строки — должности, внизу — итог за сезон */
export function SalaryPanel() {
  const [roleId, setRoleId] = useState(roles[0].id)
  const [months, setMonths] = useState(3)
  const clipId = useId().replace(/:/g, '')
  const role = roles.find((r) => r.id === roleId)!

  return (
    <section id="salary" className="relative overflow-hidden bg-[#E8A70B] py-16 text-[#3A2313] md:py-28">
      <BottleClip id={clipId} />
      <div className="container-x grid items-center gap-12 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-20">
        <div className="bg-[#F6EDD9] px-5 py-7 shadow-[0_30px_60px_-30px_rgba(58,35,19,0.55)] md:px-10 md:py-10">
          <div className="flex flex-col gap-2 border-b-[6px] border-[#3A2313] pb-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
            <h2 className="text-[clamp(44px,7vw,84px)] leading-[0.9]" style={dela}>
              Зарплата
            </h2>
            <p className="text-[14px] leading-tight font-medium sm:pb-1.5 sm:text-right md:text-[15px]">
              в месяц, до НДФЛ
              <br />
              выплаты 2 раза в месяц
            </p>
          </div>

          <ul>
            {roles.map((r) => {
              const active = r.id === role.id
              return (
                <li key={r.id} className="border-b border-[#3A2313]/70">
                  <button
                    onClick={() => setRoleId(r.id)}
                    aria-pressed={active}
                    className={`grid w-full items-baseline gap-x-4 gap-y-1 px-3 py-4 text-left transition-colors sm:grid-cols-[1fr_auto] md:py-5 ${
                      active ? 'bg-[#3A2313] text-[#F6EDD9]' : 'hover:bg-[#3A2313]/8'
                    }`}
                  >
                    <span className="text-[17px] leading-tight font-semibold md:text-[21px]">{r.title}</span>
                    <span className="text-[22px] font-bold whitespace-nowrap tabular-nums sm:text-right sm:text-[19px] md:text-[22px]">
                      {r.to ? `${rub(r.from)}–${rub(r.to)}` : `от ${rub(r.from)}`}&nbsp;₽
                    </span>
                    <span className={`text-[14px] sm:col-span-2 md:text-[15px] ${active ? 'text-[#F6EDD9]/75' : 'text-[#3A2313]/70'}`}>
                      {r.note}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>

          <div className="mt-6 border-y-[6px] border-[#3A2313] py-5">
            <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
              <div>
                <p className="font-display text-[13px] font-semibold tracking-[0.18em] uppercase">Итого за сезон</p>
                <div className="mt-3 inline-flex border border-[#3A2313]" role="group" aria-label="Срок работы">
                  {periods.map((p) => (
                    <button
                      key={p.months}
                      onClick={() => setMonths(p.months)}
                      aria-pressed={p.months === months}
                      className={`px-3 py-2 text-[14px] font-semibold transition-colors md:px-4 md:text-[15px] ${
                        p.months === months ? 'bg-[#3A2313] text-[#F6EDD9]' : 'hover:bg-[#3A2313]/8'
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-[clamp(44px,6.4vw,76px)] leading-none tabular-nums" style={dela}>
                <Total value={role.from * months} />
                <span className="ml-1 font-sans text-[0.7em] font-extrabold">₽</span>
              </p>
            </div>
          </div>

          <div className="mt-5">
            <p className="font-display text-[13px] font-semibold tracking-[0.18em] uppercase">Условия</p>
            <p className="mt-2 text-[15px] leading-relaxed md:text-[17px]">{nb(conditions.join(' · '))}</p>
          </div>

          <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Link
              to={`/apply?vacancy=${role.id}`}
              className="inline-flex h-14 items-center justify-center rounded-full bg-[#D50032] px-8 text-[16px] font-semibold text-white transition-colors hover:bg-[#B0002A]"
            >
              Откликнуться на эту работу
            </Link>
            <Link to="/vacancies" className="text-[15px] font-semibold underline decoration-1 underline-offset-4 hover:text-[#D50032]">
              Все вакансии
            </Link>
          </div>
        </div>

        <figure className="hidden lg:block">
          <div className="relative aspect-[1/2.15] w-full" style={{ clipPath: `url(#${clipId})` }}>
            {roles.map((r) => (
              <Photo
                key={r.id}
                name={r.photo}
                alt=""
                sizes="340px"
                className={`absolute inset-0 transition-opacity duration-700 ${r.id === role.id ? 'opacity-100' : 'opacity-0'}`}
              />
            ))}
          </div>
          <figcaption className="mt-4 text-center" style={yeseva}>
            <span className="text-[26px]">{role.place}</span>
          </figcaption>
        </figure>
      </div>
    </section>
  )
}
