import { motion, useReducedMotion, useScroll, useTransform } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { photos } from '@shared/photos'
import { Photo, type PhotoName } from '../components/Photo'
import { PAY_DAYS } from '@shared/content/handbook'
import { maxEntryPay, minMonthlyPay, netPay } from '@shared/content/vacancies'
import { scrollToTarget } from '../lib/motion'
import { seasonYear } from '../lib/season'
import { nb } from '../lib/typo'
import { useSentApplication } from '../components/candidate/sent'
import { HeroBelt } from './HeroBelt'
import { btn, ButtonLink, Dash, FitLine, useInvite } from './kit'
import { HEADER_OFFSET } from './tasks'

const rub = (n: number) => n.toLocaleString('ru-RU')

// Вертикальный кадр для телефона появляется в манифесте отдельно; пока его нет — везде горизонтальный
const PORTRAIT = 'excursion-portrait'
const portraitName = (PORTRAIT in photos ? PORTRAIT : null) as PhotoName | null
const narrow = '(max-width: 767px)'

/**
 * На телефоне кадр — полоса сверху во всю ширину (лица не под заголовком), на планшете и шире — весь экран по высоте:
 * на вертикальном экране он шире экрана — подсказываем браузеру реальную ширину
 */
const sizesFor = (name: PhotoName) => {
  const { w, h } = photos[name]
  return `(max-width: 767px) 100vw, (max-aspect-ratio: ${w}/${h}) ${Math.ceil((w / h) * 100)}vh, 100vw`
}

/** Один кадр на экран: телефону — вертикальный, если он есть. Второй не грузится вовсе */
function useHeroPhoto(): PhotoName {
  const [isNarrow, setNarrow] = useState(() => window.matchMedia(narrow).matches)
  useEffect(() => {
    const mq = window.matchMedia(narrow)
    const on = () => setNarrow(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return portraitName && isNarrow ? portraitName : 'excursion'
}

/** Кому и когда — словами кейса. На телефоне короче, чтобы «Откликнуться» осталось в первом экране */
// Точка-разделитель держится за предыдущее слово (неразрывный пробел перед «·»): строка не начинается с точки
const FACTS_WIDE = nb('Оплачиваемая практика и работа\u00A0· студентам и выпускникам с 18 лет\u00A0· сезон с марта по сентябрь')
const FACTS_SHORT = nb('Оплачиваемая практика и работа\u00A0· с 18 лет\u00A0· сезон с марта по сентябрь')

/**
 * Первый экран: живые люди в цеху, заголовок, вилка зарплаты, кому подходит и два действия.
 * Сумма, строка фактов и кнопки видны с первого кадра. Двигаются только фото (короткий наезд и параллакс)
 * и строки заголовка (выезд из-под маски за 0,4 с) — на CSS и motion, при «уменьшить движение» всё стоит
 */
export function Hero() {
  const scope = useRef<HTMLElement>(null)
  const heroPhoto = useHeroPhoto()
  const sent = useSentApplication((s) => s.last)
  const { invite, status } = useInvite()
  const calm = useReducedMotion()
  // Параллакс от прокрутки: кадров нет, пока страница стоит
  const { scrollYProgress } = useScroll({ target: scope, offset: ['start start', 'end start'] })
  const drift = useTransform(scrollYProgress, [0, 1], ['0%', '12%'])

  return (
    <section ref={scope} className="hero relative flex min-h-svh flex-col overflow-hidden bg-night text-white">
      <motion.div
        className="hero-photo-wrap absolute inset-x-0 top-[72px] h-[var(--hero-photo-h)] md:inset-0 md:h-auto"
        style={calm ? undefined : { y: drift }}
      >
        <Photo
          key={heroPhoto}
          name={heroPhoto}
          alt="Ребята в белых халатах в цехе «Очаково»"
          sizes={sizesFor(heroPhoto)}
          priority
          className="hero-photo absolute inset-0 bg-night"
          // Первый кадр без проявления: он виден сразу, пока под ним размытая превью
          imgClassName={`hero-img ${heroPhoto === 'excursion' ? 'object-[62%_30%]' : 'object-[50%_30%]'} brightness-[0.78] !opacity-100 !transition-none`}
        />
      </motion.div>
      {/* Затемнение: на телефоне — пол под лентой; шире — слева под текстом и снизу, лица справа остаются светлыми */}
      <div className="hero-shade absolute inset-x-0 top-[72px] h-[var(--hero-photo-h)] md:inset-0 md:h-auto" />

      {/* Лента с квасом: на телефоне — на тёмном «полу» внизу фото-полосы, шире — вдоль нижнего края экрана */}
      <div className="relative mt-[calc(72px+var(--hero-photo-h)-80px)] md:order-last md:mt-0">
        <HeroBelt />
      </div>

      <div className="hero-copy relative px-4 pt-3 pb-8 md:mt-auto md:px-8 md:pt-32 md:pb-4">
        <p className="font-display text-[17px] font-bold tracking-[0.12em] uppercase max-md:sr-only md:text-[19px]">Сезон {seasonYear()}</p>

        <h1 className="font-display leading-[0.8] font-black uppercase md:mt-3">
          <span className="sr-only">Работа на лето в «Очаково»</span>
          <span aria-hidden="true">
            <span className="block overflow-hidden pt-[2%] md:hidden">
              <span className="hero-line block">
                <FitLine max="var(--hero-cap-m)">Работа</FitLine>
              </span>
            </span>
            <span className="block overflow-hidden md:hidden">
              <span className="hero-line block [animation-delay:40ms]">
                <FitLine max="var(--hero-cap-m)">на лето</FitLine>
              </span>
            </span>
            <span className="hidden overflow-hidden pt-[1%] md:block">
              <span className="hero-line block">
                {/* Кегль не больше доли высоты окна (--hero-cap в index.css): на ноутбуке заголовок не наезжает на лица и оставляет место сумме */}
                <FitLine max="var(--hero-cap)">Работа на лето</FitLine>
              </span>
            </span>
          </span>
        </h1>

        {/* На телефоне кегль считается от ширины колонки (cqi): от 320 px строки целиком помещаются. Без nowrap — при своих интервалах текст переносится, а не обрезается.
            На ноутбуке два столбца: слева продолжение заголовка и действия, справа сумма и факты — так блок ниже и заголовок не наезжает на лица */}
        <div className="mt-2 grid grid-cols-[minmax(0,1fr)] gap-3 max-lg:[container-type:inline-size] md:mt-4 md:gap-5 lg:mt-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:gap-x-12 lg:gap-y-6">
          {/* Продолжение заголовка: читалкам его уже назвал h1 */}
          <p
            aria-hidden="true"
            data-hero-brand
            className="font-display leading-[0.8] font-black text-brand uppercase max-lg:[overflow-wrap:anywhere] max-lg:text-[min(56px,calc(100cqi/4.8))] lg:col-start-1 lg:row-start-1 lg:self-end lg:text-[clamp(48px,7vw,116px)]"
          >
            в «Очаково»
          </p>
          <div className="lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-end lg:text-right">
            <p data-hero-sum className="font-display leading-[0.85] font-black tabular-nums max-lg:[overflow-wrap:anywhere] max-lg:text-[min(64px,calc(100cqi/6.6))] lg:text-[clamp(52px,5.6vw,92px)] lg:whitespace-nowrap">
              {/* <wbr> — разрешённый перенос после тире, если человек увеличил интервалы между буквами */}
              {rub(minMonthlyPay)}–<wbr />
              {rub(maxEntryPay)}&nbsp;₽
            </p>
            {/* Подписи не расширяют столбец: он шириной с сумму, текст переносится под неё */}
            <p className="mt-2 text-[15px] leading-snug text-balance text-white/80 md:text-[17px] lg:[contain:inline-size]">
              в месяц до вычета налога · на руки от {rub(netPay(minMonthlyPay))}&nbsp;₽
              {/* Дни выплат — с планшета: на телефоне строка короче, «Откликнуться» остаётся в первом экране */}
              <span className="max-md:hidden">, выплаты {PAY_DAYS[0]}-го и&nbsp;{PAY_DAYS[1]}-го</span>
            </p>
            <p data-hero-facts className="mt-1.5 text-[15px] leading-snug font-medium text-balance text-white md:mt-2 md:text-[17px] lg:[contain:inline-size]">
              <span className="md:hidden">{FACTS_SHORT}</span>
              <span className="max-md:hidden">{FACTS_WIDE}</span>
            </p>
          </div>

          <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center md:mt-1 lg:col-start-1 lg:row-start-2 lg:mt-0 lg:self-end">
            {sent ? (
              <>
                <ButtonLink to="/apply">Моя заявка</ButtonLink>
                <button type="button" onClick={invite} className={btn.ghost}>
                  Позвать друга
                  <Dash />
                </button>
              </>
            ) : (
              <>
                <ButtonLink to="/apply" className="hero-apply">
                  Откликнуться
                </ButtonLink>
                {/* На телефоне игра — сама лента над заголовком и ссылка «Игра · 20 с» на ней, а «Позвать друга» ждёт в финале:
                    первый экран остаётся с одной кнопкой, и она видна без прокрутки даже на 360 × 740 */}
                <button type="button" onClick={() => scrollToTarget('#play', HEADER_OFFSET)} className={`${btn.ghost} max-md:hidden`}>
                  Поймай брак · 20 с
                  <Dash />
                </button>
                {/* Позвать друга можно и до своей заявки: ссылка с личным кодом свяжет две заявки у HR */}
                <button
                  type="button"
                  onClick={invite}
                  className="self-start py-3 max-md:hidden font-display text-[17px] font-bold tracking-[0.08em] uppercase underline decoration-brand-bright decoration-2 underline-offset-[6px] hover:decoration-white sm:self-center sm:px-2 md:text-[19px]"
                >
                  Позвать друга
                </button>
              </>
            )}
            {status && (
              <p className="text-[15px] text-white/80 sm:w-full" role="status">
                {status}
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
