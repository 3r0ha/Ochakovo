import { Link } from 'react-router'
import { COMPANY_QUIZ_PASS, COMPANY_QUIZ_ROUND } from '@shared/content/companyQuiz'
import { useReveal } from '../lib/motion'
import { nb } from '../lib/typo'
import { Dash, sectionTitle, useInvite } from './kit'

/**
 * Мерч «Смена» на главной: вещи выдают за шаги на заводе, купить или получить за одну заявку нельзя.
 * Те же вещи и поводы, что в docs/brand/merch.md и на странице материалов; рисунки — уменьшенные копии
 * docs/brand/img/merch-*.webp в public/merch
 */
const items: { img: string; step: string; title: string; text: string }[] = [
  {
    img: 'pins',
    step: 'Викторина или экскурсия',
    title: 'Значок «1978»',
    text: `за ${COMPANY_QUIZ_PASS} верных ответов из ${COMPANY_QUIZ_ROUND} о заводе. Забирают на стенде или экскурсии, а если заявка подана, выдают в первый день`,
  },
  { img: 'socks', step: 'Ярмарка', title: 'Носки', text: 'за 7 вопросов о заводе без ошибок у стенда «Очаково»' },
  { img: 'tote', step: 'Друг вышел на смену', title: 'Шоппер «Состав смены»', text: 'каждому из двоих, когда друг по твоей ссылке отработал первую смену' },
  { img: 'longsleeve', step: 'Месяц на смене', title: 'Лонгслив «2/2»', text: 'так на заводе называют график смен. Выдаёт отдел персонала и заодно спрашивает, как дела' },
  { img: 'hoodie', step: 'Практика закончена', title: 'Худи «Я делаю натуральные напитки»', text: 'с пиктограммой отдела. Вручает наставник вместе с характеристикой' },
  { img: 'tee', step: 'Амбассадорам', title: 'Футболка «Двойное брожение»', text: 'тем, кто рассказывает о практике в вузе и снимается в роликах' },
]

export function MerchSection() {
  const title = useReveal<HTMLHeadingElement>()
  const { invite, status } = useInvite()
  return (
    <section id="merch" className="bg-night py-20 text-white md:py-28">
      <div className="container-x">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-x-16 gap-y-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-end">
          <h2 ref={title} className={sectionTitle}>
            Мерч за&nbsp;шаги на&nbsp;заводе
          </h2>
          <p className="max-w-[560px] text-[17px] leading-relaxed text-white/80 md:text-[19px]">
            {nb('Эти вещи не продают и не дают за одну заявку. Их получают за шаги: викторину, первую смену друга, месяц на смене, законченную практику. Логотип маленький, а надписи понятны тем, кто работал на заводе.')}
          </p>
        </div>

        <ul className="mt-12 grid grid-cols-[minmax(0,1fr)] gap-x-6 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((m) => (
            <li key={m.img}>
              <div className="bg-[#f3f1ed] p-4">
                <img src={`/merch/${m.img}.webp`} alt="" width={640} height={420} loading="lazy" decoding="async" className="block aspect-[16/10] w-full object-contain" />
              </div>
              <p className="mt-4 font-display text-[15px] font-bold tracking-[0.08em] text-brand-bright uppercase">{m.step}</p>
              <p className="mt-1 font-display text-[clamp(24px,2vw,30px)] leading-[0.95] font-extrabold uppercase">{nb(m.title)}</p>
              <p className="mt-2 text-[16px] leading-relaxed text-white/75">{nb(m.text)}</p>
            </li>
          ))}
        </ul>

        <div className="mt-12 flex flex-col gap-3 sm:flex-row">
          <Link to="/game?t=quiz" className="group inline-flex h-16 items-center justify-center gap-4 bg-brand px-8 font-display text-[22px] font-extrabold tracking-[0.05em] text-white uppercase transition-colors hover:bg-white hover:text-brand">
            Викторина за значок
            <Dash />
          </Link>
          <button
            type="button"
            onClick={invite}
            className="group inline-flex h-16 items-center justify-center gap-4 px-8 font-display text-[22px] font-extrabold tracking-[0.05em] text-white uppercase ring-1 ring-white/60 transition-colors ring-inset hover:bg-white hover:text-ink"
          >
            Позвать друга
            <Dash />
          </button>
        </div>
        {status && (
          <p className="mt-3 text-[15px] text-white/75" role="status">
            {status}
          </p>
        )}
      </div>
    </section>
  )
}
