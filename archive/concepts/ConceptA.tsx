import { useRef } from 'react'
import { Link } from 'react-router'
import { Photo } from '../components/Photo'
import { gsap, prefersReducedMotion, ScrollTrigger, useGSAP } from '../lib/motion'
import { nb } from '../lib/typo'
import { dela, yeseva } from './a/fonts'
import { SalaryPanel } from './a/SalaryPanel'
import { Seal } from './a/Seal'

// Направление «Этикетка»: страница собрана как этикетка банки кваса —
// кремовая бумага, золото и тёмный квас, рамки-линейки, круглая печать, цена как главный элемент.

const grain =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")"

const ticker = ['Квас двойного брожения', '70 000 бутылок в час', 'С 1978 года', 'Москва, Рябиновая, 44', 'Сезон март — сентябрь']

const keyframes = `
@keyframes a-seal-spin { to { transform: rotate(360deg) } }
.a-seal-ring { transform-origin: 50% 50%; animation: a-seal-spin 28s linear infinite }
@keyframes a-marquee { to { transform: translateX(-50%) } }
.a-marquee { animation: a-marquee 36s linear infinite }
@media (prefers-reduced-motion: reduce) { .a-seal-ring, .a-marquee { animation: none } }
`

export function ConceptA() {
  const scope = useRef<HTMLDivElement>(null)

  useGSAP(
    () => {
      document.fonts.ready.then(() => ScrollTrigger.refresh())
      const money = scope.current!.querySelector<HTMLElement>('.a-money')!
      if (prefersReducedMotion()) return

      const counter = { v: 0 }
      gsap
        .timeline({ defaults: { ease: 'expo.out' } })
        .from('.a-arch', { clipPath: 'inset(100% 0% 0% 0%)', duration: 1.5 }, 0)
        .from('.a-arch-photo', { scale: 1.25, duration: 2.2 }, 0)
        .from('.a-line', { yPercent: 110, duration: 1.1, stagger: 0.08 }, 0.15)
        .from('.a-fade', { y: 18, opacity: 0, duration: 0.9, stagger: 0.06 }, 0.45)
        .from('.a-seal', { scale: 0.4, rotate: -120, opacity: 0, duration: 1.2, ease: 'back.out(1.6)' }, 0.9)
        .to(
          counter,
          {
            v: 57000,
            duration: 1.6,
            ease: 'power3.out',
            onUpdate: () => {
              money.textContent = (Math.round(counter.v / 1000) * 1000).toLocaleString('ru-RU')
            },
          },
          0.5,
        )

      gsap.from('#salary li, #salary h2', {
        y: 30,
        opacity: 0,
        duration: 0.8,
        ease: 'expo.out',
        stagger: 0.06,
        scrollTrigger: { trigger: '#salary', start: 'top 75%' },
      })
    },
    { scope },
  )

  return (
    <div ref={scope} className="min-h-screen bg-[#F2E6CE] text-[#3A2313]">
      <style>{keyframes}</style>

      {/* Шапка */}
      <header className="sticky top-0 z-30 border-b border-[#3A2313]/20 bg-[#F2E6CE]/95 backdrop-blur">
        <div className="container-x flex h-[68px] items-center justify-between gap-6 md:h-[76px]">
          <Link to="/concept/a" aria-label="Очаково">
            <img src="/brand/logo-wordmark-red.svg" alt="Очаково" width={195} height={24} className="h-[18px] w-auto md:h-5" />
          </Link>
          <nav className="hidden items-center gap-8 text-[15px] font-medium md:flex">
            <a href="#salary" className="hover:text-[#D50032]">Зарплата</a>
            <Link to="/vacancies" className="hover:text-[#D50032]">Вакансии</Link>
            <Link to="/game" className="hover:text-[#D50032]">Поймай брак</Link>
          </nav>
          <Link
            to="/apply"
            className="inline-flex h-10 items-center rounded-full bg-[#D50032] px-5 text-[15px] font-semibold text-white transition-colors hover:bg-[#B0002A] md:h-11"
          >
            Откликнуться
          </Link>
        </div>
      </header>

      {/* Первый экран */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 opacity-[0.13] mix-blend-multiply" style={{ backgroundImage: grain }} />
        <div className="container-x relative grid gap-10 pt-6 pb-14 md:pt-10 lg:min-h-[calc(100svh-76px)] lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:items-center lg:gap-16 lg:pb-10">
          <div className="min-w-0">
            <div className="a-fade flex items-center justify-between border-y-[3px] border-double border-[#3A2313] py-2 font-display text-[11px] font-semibold tracking-[0.18em] uppercase sm:text-[13px] md:text-[15px]">
              <span>Летняя работа и практика</span>
              <span>Сезон 2027</span>
            </div>

            <h1 className="mt-6 text-[clamp(42px,12vw,104px)] leading-[0.94] tracking-[-0.01em] md:mt-8 lg:text-[clamp(56px,6.4vw,104px)]" style={yeseva}>
              <span className="block overflow-hidden pb-[0.06em]">
                <span className="a-line block">Работа на лето</span>
              </span>
              <span className="block overflow-hidden pb-[0.06em]">
                <span className="a-line block">
                  в <span className="text-[#D50032]">«Очаково»</span>
                </span>
              </span>
            </h1>

            <div className="a-fade mt-7 border-t-[6px] border-b border-[#3A2313] pt-3 pb-5 md:mt-10">
              <div className="flex justify-between font-display text-[11px] font-semibold tracking-[0.18em] uppercase sm:text-[13px] md:text-[15px]">
                <span>Без опыта · в месяц</span>
                <span>до НДФЛ</span>
              </div>
              <p className="mt-2 flex items-baseline gap-2 text-[clamp(60px,18vw,150px)] leading-[0.9] tabular-nums lg:text-[clamp(96px,10.4vw,150px)]" style={dela}>
                <span className="a-money">57 000</span>
                <span className="font-sans text-[0.55em] font-extrabold">₽</span>
              </p>
              <p className="mt-3 text-[16px] md:text-[18px]">
                {nb('До 107 000 ₽ на конвейерной линии. Зарплата официально, два раза в месяц.')}
              </p>
            </div>

            <div className="a-fade mt-7 flex flex-col gap-3 sm:flex-row">
              <Link
                to="/apply"
                className="inline-flex h-14 items-center justify-center rounded-full bg-[#D50032] px-8 text-[16px] font-semibold text-white transition-colors hover:bg-[#B0002A]"
              >
                Откликнуться
              </Link>
              <Link
                to="/game"
                className="inline-flex h-14 items-center justify-center gap-3 rounded-full border-[1.5px] border-[#3A2313] px-7 text-[16px] font-semibold transition-colors hover:bg-[#3A2313] hover:text-[#F2E6CE]"
              >
                Поймай брак
                <span className="font-display text-[14px] tracking-[0.12em] uppercase opacity-70">игра · 30 сек</span>
              </Link>
            </div>

            <p className="a-fade mt-6 text-[15px] text-[#3A2313]/75">
              {nb('Москва, ул. Рябиновая, 44 · автобус от м. «Озёрная» · можно без резюме')}
            </p>
          </div>

          {/* Арка с фото, золотая подложка со сдвигом и печать */}
          <div className="relative mx-auto w-full max-w-[520px] min-w-0 pr-3 pb-3 lg:mr-0">
            <div className="absolute top-3 right-0 bottom-0 left-3 rounded-t-full bg-[#E8A70B]" />
            <div className="a-arch relative aspect-[4/5] overflow-hidden rounded-t-full lg:aspect-[3/4.2]">
              <Photo
                name="excursion"
                alt="Студенты в белых халатах на производстве «Очаково»"
                sizes="(min-width: 1024px) 38vw, 92vw"
                priority
                className="a-arch-photo absolute inset-0"
              />
              <div className="pointer-events-none absolute inset-3 rounded-t-full border border-[#F2E6CE]/80 md:inset-4" />
            </div>
            <Seal className="a-seal absolute top-[10%] -right-1 w-[118px] md:top-[12%] md:right-auto md:-left-14 md:w-[168px]" />
          </div>
        </div>
      </section>

      {/* Лента с фактами, как текст по кругу банки */}
      <div className="overflow-hidden bg-[#3A2313] py-4 text-[#F2E6CE] md:py-5" aria-hidden="true">
        <div className="a-marquee flex w-max">
          {[0, 1].map((k) => (
            <div key={k} className="flex shrink-0 items-center">
              {ticker.map((t) => (
                <span key={t} className="flex items-center text-[22px] uppercase md:text-[30px]" style={dela}>
                  <span className="px-7">{t}</span>
                  <span className="size-2.5 rounded-full bg-[#E8A70B]" />
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>

      <SalaryPanel />

      {/* Игра */}
      <section className="bg-[#3A2313] text-[#F2E6CE]">
        <div className="container-x grid items-center gap-10 py-16 md:grid-cols-[1fr_minmax(0,0.9fr)] md:py-24">
          <div>
            <p className="font-display text-[15px] font-semibold tracking-[0.18em] text-[#E8A70B] uppercase">Игра · 30 секунд</p>
            <h2 className="mt-4 text-[clamp(52px,7.5vw,112px)] leading-[0.92]" style={dela}>
              Поймай брак
            </h2>
            <p className="mt-5 max-w-[460px] text-[17px] text-[#F2E6CE]/80 md:text-[19px]">
              {nb('Убери с ленты бутылки без крышки, с недоливом и кривой этикеткой. Десять лучших за неделю едут на экскурсию на завод.')}
            </p>
            <Link
              to="/game"
              className="mt-8 inline-flex h-14 items-center justify-center rounded-full bg-[#E8A70B] px-8 text-[16px] font-semibold text-[#3A2313] transition-colors hover:bg-[#F2E6CE]"
            >
              Играть
            </Link>
          </div>
          <div className="overflow-hidden rounded-t-[200px]">
            <Photo name="cans-line" alt="Банки кваса на линии розлива" sizes="(min-width: 768px) 45vw, 92vw" className="aspect-[5/4]" />
          </div>
        </div>
      </section>

      <footer className="container-x flex flex-col gap-3 py-8 text-[14px] text-[#3A2313]/70 md:flex-row md:items-center md:justify-between">
        <img src="/brand/logo-wordmark-red.svg" alt="Очаково" width={195} height={24} className="h-4 w-auto" />
        <p>rabota@ochakovo.ru · +7 495 785-39-30, доб. 1155, 2107</p>
      </footer>
    </div>
  )
}
