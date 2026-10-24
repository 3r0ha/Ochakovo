import { useRef } from 'react'
import { Link } from 'react-router'
import { Bottle } from '../../game/Bottle'
import { gsap, prefersReducedMotion, scrollToTarget, ScrollTrigger, useGSAP } from '../../lib/motion'
import { nb } from '../../lib/typo'
import { Duo, FitLine, Tag, Ticker } from './parts'

const facts = [
  'Смена 2/2',
  'Смены по 12 часов',
  'Зарплата два раза в месяц',
  'Автобус от м. «Озёрная»',
  'Общежитие рядом с заводом',
  'Можно без резюме',
  'Март — сентябрь',
]

/** Первый экран-плакат: огромный шрифт во всю ширину, двухцветные фото, цифра и кнопки */
export function Hero() {
  const scope = useRef<HTMLElement>(null)

  useGSAP(
    () => {
      document.fonts.ready.then(() => ScrollTrigger.refresh())
      if (prefersReducedMotion()) return

      const money = scope.current!.querySelector<HTMLElement>('.b-money-value')
      const counter = { v: 0 }
      gsap
        .timeline({ defaults: { ease: 'expo.out' } })
        .from('.b-line', { yPercent: 100, duration: 1.15, stagger: 0.07 })
        .from('.b-photo', { clipPath: 'inset(100% 0% 0% 0%)', duration: 1.3, ease: 'expo.inOut' }, 0.15)
        .to(
          counter,
          {
            v: 57000,
            duration: 1.6,
            onUpdate: () => {
              if (money) money.textContent = (Math.round(counter.v / 100) * 100).toLocaleString('ru-RU')
            },
          },
          0.35,
        )
        .from('.b-fade', { y: 24, opacity: 0, duration: 0.9, stagger: 0.06 }, 0.55)
        .from('.b-game', { xPercent: 12, opacity: 0, duration: 1 }, 0.8)

      // Строки плаката слегка разъезжаются при прокрутке
      gsap.to('.b-shift-l', {
        xPercent: -7,
        ease: 'none',
        scrollTrigger: { trigger: scope.current, start: 'top top', end: 'bottom top', scrub: true },
      })
      gsap.to('.b-photo-inner', {
        yPercent: 10,
        ease: 'none',
        scrollTrigger: { trigger: scope.current, start: 'top top', end: 'bottom top', scrub: true },
      })
    },
    { scope },
  )

  return (
    <section ref={scope} className="relative overflow-hidden bg-brand pt-16 text-white md:pt-20">
      {/* Заголовок во всю ширину */}
      <h1 className="relative z-20 font-display leading-[0.8] font-black uppercase">
        <span className="sr-only">Работа на лето в «Очаково»</span>
        <span aria-hidden="true" className="b-shift-l block px-4 md:px-8">
          <span className="block overflow-hidden pt-[1.5%]">
            <span className="b-line block md:hidden">
              <FitLine>Работа</FitLine>
            </span>
            <span className="b-line hidden md:block">
              <FitLine>Работа на лето</FitLine>
            </span>
          </span>
          <span className="block overflow-hidden md:hidden">
            <span className="b-line block">
              <FitLine>на лето</FitLine>
            </span>
          </span>
        </span>
      </h1>

      <div className="relative mt-5 grid gap-x-8 px-5 md:mt-2 md:grid-cols-12 md:px-10">
        {/* Деньги и действие */}
        <div className="relative z-10 md:col-span-5 md:pt-10">
          <div className="b-fade flex flex-wrap gap-2">
            <Tag>Москва</Tag>
            <Tag>Без опыта</Tag>
          </div>
          <p className="mt-4 font-display leading-[0.82] font-black text-ink uppercase">
            <span className="block text-[clamp(30px,3vw,44px)]">от</span>
            <span className="block text-[clamp(96px,10.6vw,168px)] tabular-nums">
              <span className="b-money-value">57 000</span>&nbsp;₽
            </span>
          </p>
          <p className="b-fade mt-4 max-w-[420px] text-[19px] leading-snug font-medium">
            {nb('в месяц — рабочий фирменного магазина. На конвейерной линии — от 107 000 ₽.')}
          </p>
          <div className="b-fade mt-7 flex flex-col gap-3 sm:flex-row">
            <Link
              to="/apply"
              className="flex h-16 items-center justify-center bg-white px-8 font-display text-[24px] font-black tracking-[0.03em] text-brand uppercase transition-colors hover:bg-ink hover:text-white"
            >
              Откликнуться
            </Link>
            <button
              onClick={() => scrollToTarget('#salary')}
              className="hidden h-16 items-center justify-center px-6 font-display text-[22px] font-bold tracking-[0.03em] uppercase ring-2 ring-white ring-inset transition-colors hover:bg-white hover:text-brand sm:flex"
            >
              Все зарплаты
            </button>
          </div>
          <GameEntry className="relative mt-4 flex md:hidden" />
        </div>

        {/* Фото-коллаж, налезающий на заголовок */}
        <div className="relative mt-10 md:col-span-7 md:mt-[-4.5vw]">
          <div className="b-photo relative">
            <div className="relative aspect-[4/3] overflow-hidden md:aspect-[16/11]">
              <div className="b-photo-inner absolute -inset-y-[8%] inset-x-0">
                <Duo name="excursion" sizes="(min-width: 768px) 56vw, 100vw" priority className="size-full" />
              </div>
            </div>
            <p className="absolute -bottom-[0.16em] left-3 font-display text-[clamp(64px,6vw,104px)] leading-[0.8] font-black text-white uppercase md:left-5">
              в «Очаково»
            </p>
          </div>

          <GameEntry className="absolute right-0 -bottom-6 hidden w-[40%] min-w-[340px] md:flex" />
        </div>

      </div>

      <Ticker
        items={facts}
        className="mt-16 bg-ink py-4 font-display text-[clamp(24px,2.4vw,34px)] font-bold tracking-[0.04em] text-white uppercase md:mt-20"
      />
    </section>
  )
}

/** Вход в игру — чёрная плашка */
function GameEntry({ className = '' }: { className?: string }) {
  return (
    <Link to="/game" className={`b-game group z-10 items-center justify-between gap-4 bg-ink p-5 text-white md:p-6 ${className}`}>
      <span>
        <span className="block font-display text-[15px] font-bold tracking-[0.12em] text-white/60 uppercase">Игра · 30 секунд</span>
        <span className="mt-1 block font-display text-[clamp(40px,3.4vw,52px)] leading-[0.85] font-black uppercase">Поймай брак</span>
        <span className="mt-2 block text-[15px] leading-snug text-white/70">{nb('Лучшие 10 за неделю едут на экскурсию на завод')}</span>
      </span>
      <span className="flex shrink-0 items-end gap-1 transition-transform duration-500 group-hover:-translate-y-1">
        <Bottle kind="ok" className="h-16 w-auto md:h-20" />
        <Bottle kind="nocap" className="h-16 w-auto md:h-20" />
      </span>
    </Link>
  )
}
