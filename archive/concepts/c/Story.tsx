import { useRef } from 'react'
import { Photo } from '../../components/Photo'
import { gsap, prefersReducedMotion, ScrollTrigger, useGSAP } from '../../lib/motion'
import { seasonYear } from '../../lib/season'
import { nb } from '../../lib/typo'
import { CtaLink, TextLink } from './kit'

const credits = [
  { label: 'Опыт', value: 'Не нужен. Можно без резюме' },
  { label: 'График', value: '2/2, дневные смены по 12 часов' },
  { label: 'Выплаты', value: 'Официально, два раза в месяц' },
  { label: 'Дорога', value: 'Автобус от м. «Озёрная»' },
  { label: 'Быт', value: 'Общежитие, столовая, ДМС' },
]

/**
 * Сцена-история: кадр стоит на месте (sticky), а по скроллу сменяются три «кадра»
 * и в конце появляется предложение. Без закрепления через pin — так стабильнее на телефоне.
 */
export function Story() {
  const scope = useRef<HTMLElement>(null)

  useGSAP(
    () => {
      document.fonts.ready.then(() => ScrollTrigger.refresh())
      const reduce = prefersReducedMotion()

      // Вход: кадр «проявляется», заголовок поднимается из-под маски
      gsap
        .timeline({ defaults: { ease: 'expo.out' } })
        .from('.c-photo-a', { opacity: 0, scale: 1.18, duration: reduce ? 0 : 2.6 }, 0)
        .from('.c-hero-line', { yPercent: 110, duration: reduce ? 0 : 1.4, stagger: 0.1 }, 0.35)
        .from('.c-hero-fade', { opacity: 0, y: 18, duration: reduce ? 0 : 1.2, stagger: 0.08 }, 0.9)

      if (reduce) {
        gsap.set('.c-beat, .c-photo-b', { opacity: 1 })
        return
      }

      // Первый кадр живёт как трейлер: линия розлива сменяется людьми и обратно
      const cycle = gsap
        .timeline({ repeat: -1, delay: 2.4 })
        .to('.c-photo-b', { opacity: 1, duration: 1.8, ease: 'power2.inOut' })
        .to('.c-photo-b', { opacity: 0, duration: 1.8, ease: 'power2.inOut' }, '+=3.2')
        .to({}, { duration: 3.2 })
      ScrollTrigger.create({
        trigger: scope.current,
        start: 'top top-=40',
        onEnter: () => {
          cycle.pause()
          gsap.to('.c-photo-b', { opacity: 0, duration: 0.6, overwrite: 'auto' })
        },
        onLeaveBack: () => cycle.restart(true),
      })

      const tl = gsap.timeline({
        defaults: { ease: 'none' },
        scrollTrigger: { trigger: scope.current, start: 'top top', end: 'bottom bottom', scrub: 0.9 },
      })
      const show = (sel: string, at: number) =>
        tl.fromTo(sel, { opacity: 0, y: 40, filter: 'blur(8px)' }, { opacity: 1, y: 0, filter: 'blur(0px)', duration: 0.07 }, at)
      const hide = (sel: string, at: number) => tl.to(sel, { opacity: 0, y: -40, filter: 'blur(8px)', duration: 0.06 }, at)

      tl.fromTo('.c-photo-a', { scale: 1.02 }, { scale: 1.28, duration: 0.7 }, 0)
        .to('.c-hero', { opacity: 0, y: -60, duration: 0.1 }, 0.06)
        .to('.c-shade', { opacity: 0.35, duration: 0.1 }, 0.08)
        .to('.c-cue', { opacity: 0, duration: 0.04 }, 0.02)
      show('.c-beat-1', 0.16)
      hide('.c-beat-1', 0.3)
      show('.c-beat-2', 0.36)
      hide('.c-beat-2', 0.5)
      tl.fromTo('.c-photo-b', { scale: 1.16 }, { scale: 1, duration: 0.2, immediateRender: false }, 0.5).to('.c-photo-b', { opacity: 1, duration: 0.1 }, 0.52)
      tl.to('.c-shade', { opacity: 0.55, duration: 0.06 }, 0.54)
      show('.c-beat-3', 0.58)
      hide('.c-beat-3', 0.72)
      tl.to('.c-shade', { opacity: 0.82, duration: 0.08 }, 0.72)
      show('.c-offer', 0.78)
      tl.from('.c-credit', { opacity: 0, y: 20, stagger: 0.012, duration: 0.05 }, 0.82).to({}, { duration: 0.1 }, 0.9)
    },
    { scope },
  )

  return (
    <section ref={scope} className="relative h-[330svh] md:h-[420svh]">
      <div className="sticky top-0 h-svh overflow-hidden">
        {/* Кадры */}
        <Photo
          name="hero-line"
          alt="Линия розлива «Очаково»: бутылки светятся в темноте цеха"
          sizes="100vw"
          priority
          className="c-photo-a absolute inset-0 will-change-transform"
          imgClassName="object-[60%_50%]"
        />
        <Photo
          name="excursion"
          alt="Ребята в белых халатах в цеху «Очаково»"
          sizes="100vw"
          className="c-photo-b absolute inset-0 opacity-0 will-change-transform"
          imgClassName="object-[50%_35%] brightness-[0.72] saturate-[0.9]"
        />

        {/* Свет и плёнка */}
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_55%_40%,transparent_35%,rgba(8,6,4,0.6)_100%)]" />
        <div className="c-shade pointer-events-none absolute inset-0 bg-(--c-bg) opacity-0" />
        <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-(--c-bg)/70 to-transparent" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[78%] bg-gradient-to-t from-(--c-bg) via-(--c-bg)/70 to-transparent md:h-[62%] md:via-(--c-bg)/55" />
        <div className="c-leak pointer-events-none absolute -top-[20%] -right-[15%] size-[70vmax] rounded-full bg-[radial-gradient(circle,rgba(255,150,60,0.35),transparent_60%)] mix-blend-screen" />
        <div className="c-leak pointer-events-none absolute -bottom-[30%] -left-[20%] size-[60vmax] rounded-full bg-[radial-gradient(circle,rgba(213,0,50,0.28),transparent_60%)] mix-blend-screen [animation-delay:-8s]" />

        {/* Первый кадр: что, где, сколько, куда нажать */}
        <div className="c-hero container-x absolute inset-x-0 bottom-0 pb-10 md:pb-14">
          <p className="c-hero-fade c-serif text-[22px] text-(--c-amber) [text-shadow:0_2px_18px_rgba(0,0,0,0.6)] md:text-[30px]">Москва, сезон {seasonYear()}</p>
          <h1 className="display mt-3 text-[clamp(62px,13.4vw,232px)] text-(--c-fg)">
            <span className="-mt-[0.12em] block overflow-hidden pt-[0.12em]">
              <span className="c-hero-line block">Работа на лето</span>
            </span>
            <span className="-mt-[0.12em] block overflow-hidden pt-[0.12em] pb-[0.03em]">
              <span className="c-hero-line block">в «Очаково»</span>
            </span>
          </h1>
          <div className="mt-7 flex flex-col gap-7 md:mt-10 md:flex-row md:items-end md:justify-between">
            <div className="c-hero-fade flex items-end gap-5">
              <p className="c-serif text-[clamp(52px,6vw,96px)] leading-[0.8] text-(--c-amber)">
                <span className="text-[0.45em] text-(--c-fg)/70">от </span>57 000 ₽
              </p>
              <p className="pb-1 text-[15px] leading-snug text-(--c-fg)/75">
                в месяц, без опыта
                <br />
                {nb('смены 2/2 · Рябиновая, 44')}
              </p>
            </div>
            <div className="c-hero-fade flex flex-col gap-5 sm:flex-row sm:items-center sm:gap-8">
              <CtaLink to="/apply">Откликнуться</CtaLink>
              <TextLink to="/game">Поймай брак — игра на 30 секунд</TextLink>
            </div>
          </div>
        </div>

        <div className="c-cue pointer-events-none absolute top-[38%] right-5 hidden flex-col items-center gap-3 text-[13px] tracking-[0.2em] text-(--c-fg)/60 uppercase [writing-mode:vertical-rl] md:right-10 md:flex">
          Листай
          <span className="h-16 w-px bg-(--c-fg)/60" />
        </div>

        {/* Три кадра истории */}
        <div className="c-beat c-beat-1 absolute inset-0 grid place-items-center px-5 text-center opacity-0">
          <div>
            <p className="display text-[clamp(64px,12vw,210px)] text-(--c-fg)">
              Москва,
              <br />
              Рябиновая, 44
            </p>
            <p className="mx-auto mt-6 max-w-[460px] text-[17px] text-(--c-fg)/75 md:text-lg">
              {nb('Завод «Очаково» работает здесь с 1978 года. Его строили к Олимпиаде-80.')}
            </p>
          </div>
        </div>

        <div className="c-beat c-beat-2 absolute inset-0 grid place-items-center px-5 text-center opacity-0">
          <div>
            <p className="c-serif text-[clamp(120px,22vw,380px)] leading-[0.8] text-(--c-amber)">70 000</p>
            <p className="display mt-2 text-[clamp(44px,7vw,120px)] text-(--c-fg)">бутылок в час</p>
            <p className="mx-auto mt-6 max-w-[460px] text-[17px] text-(--c-fg)/75 md:text-lg">
              {nb('Квас «Очаковский» варят здесь с 1996 года — по рецептам, которые собирали по деревням.')}
            </p>
          </div>
        </div>

        <div className="c-beat c-beat-3 absolute inset-0 grid place-items-center px-5 text-center opacity-0">
          <div>
            <p className="display text-[clamp(64px,12vw,210px)] text-(--c-fg)">
              Летом здесь
              <br />
              нужны люди
            </p>
            <p className="mx-auto mt-6 max-w-[480px] text-[17px] text-(--c-fg)/80 md:text-lg">
              {nb('С марта по сентябрь — на линию, на склад, в фирменный магазин и на экскурсии.')}
            </p>
          </div>
        </div>

        {/* Финальный кадр: предложение */}
        <div className="c-beat c-offer container-x absolute inset-0 flex flex-col justify-end pt-24 pb-10 opacity-0 md:justify-center md:pb-0">
          <div className="grid gap-10 md:grid-cols-[1.1fr_1fr] md:items-end md:gap-16">
            <div>
              <p className="c-serif text-[26px] text-(--c-amber) md:text-[34px]">от</p>
              <p className="c-serif -mt-2 text-[clamp(92px,13vw,220px)] leading-[0.85] text-(--c-fg)">57 000 ₽</p>
              <p className="display mt-3 text-[clamp(30px,3.6vw,56px)] text-(--c-fg)">в месяц без опыта</p>
              <div className="mt-8 flex flex-col gap-5 sm:flex-row sm:items-center sm:gap-8">
                <CtaLink to="/apply">Откликнуться</CtaLink>
                <TextLink to="/game">Сыграть в «Поймай брак»</TextLink>
              </div>
            </div>
            <dl className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
              {credits.map((c) => (
                <div key={c.label} className="c-credit border-t border-(--c-fg)/20 py-3.5 md:py-4">
                  <dt className="font-display text-[15px] tracking-[0.18em] text-(--c-amber) uppercase">{c.label}</dt>
                  <dd className="mt-1 text-[17px] text-(--c-fg)/90">{nb(c.value)}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </div>
    </section>
  )
}
