import { Link } from 'react-router'
import { perks } from '@shared/content/content'
import { dorm } from '@shared/content/handbook'
import { paidPracticeInfo } from '@shared/content/practice'
import { netPay, paidPractice, type Vacancy } from '@shared/content/vacancies'
import { useReveal } from '../lib/motion'
import { nb } from '../lib/typo'
import { ButtonLink, Dash, payText } from './kit'
import { Pictogram, type PictogramId } from './Pictogram'

// Кадр из ролика «Оператор линии розлива» (archive/case-materials/video, около 15 с): двое у пульта, без титров и банок.
// new URL(…, import.meta.url) — Vite кладёт файлы в сборку с хешем, а проверки в Node читают модуль без загрузчика картинок
const mentorAvif560 = new URL('./media/mentor-panel-560.avif', import.meta.url).href
const mentorAvif840 = new URL('./media/mentor-panel-840.avif', import.meta.url).href
const mentorWebp560 = new URL('./media/mentor-panel-560.webp', import.meta.url).href
const mentorWebp840 = new URL('./media/mentor-panel-840.webp', import.meta.url).href

const rub = (n: number) => n.toLocaleString('ru-RU')

/** Заголовок блока в две строки: что это и кто учит. Факт из «Справочника студента», без девиза */
export const PRACTICE_TITLE = ['Практика', 'с наставником'] as const

/**
 * Пиктограмма отдела — метка, как в концепции (образ 7): цех розлива — бутылка, технологический цех (цех варки) — варочный
 * котёл, лаборатория — контроль параметров, склад — цикл: продукция приходит и уходит. Жанры разные: продукция, оборудование, процесс
 */
const unitPictogram: Record<string, PictogramId> = {
  'Цех розлива': 'pet-bottle',
  'Технологический цех': 'kettle',
  Лаборатория: 'control',
  'Складской комплекс': 'cycle',
}

/** Отделы оплачиваемой практики в порядке «Описания практики», в каждом — его роли */
const units = paidPracticeInfo.units.map((unit) => ({ unit, roles: paidPractice.filter((v) => v.unit === unit) }))

const perkText = (title: string) => perks.find((p) => p.title === title)?.text ?? ''

/**
 * Что даёт компания — слова «Описания практики» и «Справочника студента» (perks в shared/content/content.ts).
 * Шесть фактов из задачи кейса: наставник, без испытательного срока, общежитие 3 400 ₽, половина обеда, спецодежда и медосмотр,
 * скидка на продукцию. «Наставник с первого дня» не пишем: в справочнике — «прикрепляют к каждому новичку», о первом дне ни слова
 */
const benefits: { big: string; text: string }[] = [
  { big: 'Наставник', text: perkText('Наставник') },
  { big: 'Без испытательного срока', text: perkText('Без испытательного срока') },
  {
    big: `Общежитие за ${rub(dorm.priceStudent)} ₽`,
    text: `За койко-место для студентов, половину оплачивает компания. ${dorm.address.replace(/^Москва,\s*ул\.\s*/, '')}, ${dorm.room}.`,
  },
  { big: 'Обед за полцены', text: perkText('Обед за полцены') },
  { big: 'Спецодежда и медосмотр', text: perkText('Спецодежда и медосмотр') },
  { big: 'Скидка на продукцию', text: perkText('Скидка на продукцию') },
]

/** Роль в строке отдела: название, чем занимается и сумма. Ссылка — на раскрытую вакансию */
function Role({ v }: { v: Vacancy }) {
  return (
    <li className="border-t border-ink/15 first:border-t-0">
      <Link
        to={`/vacancies?open=${v.id}`}
        className="group grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-6 gap-y-2 py-4 transition-colors hover:text-brand"
      >
        <span className="font-display text-[clamp(24px,2.1vw,30px)] leading-[0.95] font-extrabold uppercase">{v.title}</span>
        <span className="text-right">
          <span className="block font-display text-[clamp(24px,2.1vw,32px)] leading-none font-black whitespace-nowrap tabular-nums">{payText(v)}</span>
          {/* Подпись под суммой одной строкой: столбец суммы чуть шире, зато «больше» не отрывается от «с ночными сменами» */}
          {v.payNote && <span className="mt-1 block text-[13px] leading-tight whitespace-nowrap text-ink/75 md:text-[15px]">{v.payNote}</span>}
        </span>
        <span className="col-span-2 max-w-[640px] text-[15px] leading-snug text-ink/75 group-hover:text-brand">{nb(v.tasks.join(' · '))}</span>
      </Link>
    </li>
  )
}

/**
 * Оплачиваемая практика — главное предложение для студентов (кейс: «Описание практики» и «Справочник студента»).
 * Заголовок «Практика с наставником» рядом с суммой, образ «Наставник и новичок у пульта» — кадр из ролика «Очаково» о линии розлива,
 * четыре отдела с ролями и суммами, что даёт компания. Бесплатная практика — строкой со ссылкой на вакансии
 */
export function Practice() {
  const title = useReveal<HTMLHeadingElement>()
  return (
    <section id="practice" className="bg-white py-20 text-ink md:py-28">
      <div className="container-x">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-x-16 gap-y-10 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-end">
          <div>
            <p className="font-display text-[17px] font-bold tracking-[0.08em] uppercase">
              Оплачиваемая практика · {paidPracticeInfo.units.length} отдела · с&nbsp;18&nbsp;лет
            </p>
            <h2 ref={title} className="mt-6 font-display text-[clamp(52px,7.4vw,124px)] leading-[0.86] font-black uppercase">
              {PRACTICE_TITLE[0]}
              <br />
              <span className="text-brand">{PRACTICE_TITLE[1]}</span>
            </h2>
            <p data-practice-sum className="mt-8 font-display text-[clamp(30px,3.2vw,48px)] leading-[0.95] font-black tabular-nums">
              от {rub(paidPracticeInfo.payFrom)} до {rub(paidPracticeInfo.payTo)}&nbsp;₽ в&nbsp;месяц
            </p>
            <p className="mt-2 text-[17px] leading-snug">
              {nb(`до вычета налога, на руки от ${rub(netPay(paidPracticeInfo.payFrom))} ₽; за ночные смены больше`)}
            </p>
            <p className="mt-6 max-w-[600px] text-[17px] leading-relaxed text-ink/80">
              {nb(`${paidPracticeInfo.period}. ${paidPracticeInfo.contract}. Опыт не нужен, на старте учит наставник.`)}
            </p>
          </div>

          {/* Образ концепции «Наставник и новичок у пульта». Кадр — из ролика компании, без титров и банок с этикетками */}
          <figure className="m-0">
            <picture>
              <source type="image/avif" srcSet={`${mentorAvif560} 560w, ${mentorAvif840} 840w`} sizes="(min-width: 1024px) 40vw, 100vw" />
              <source type="image/webp" srcSet={`${mentorWebp560} 560w, ${mentorWebp840} 840w`} sizes="(min-width: 1024px) 40vw, 100vw" />
              <img
                src={mentorWebp840}
                width={840}
                height={550}
                loading="lazy"
                decoding="async"
                alt="Двое в красных кепках у сенсорного пульта линии розлива: младший нажимает на экран, старший смотрит"
                className="block aspect-[84/55] w-full bg-[#5d5555] object-cover"
              />
            </picture>
          </figure>
        </div>

        {/* Четыре отдела: пиктограмма, отдел, роли с суммами */}
        <div className="mt-16 md:mt-20">
          <h3 className="font-display text-[clamp(30px,2.8vw,40px)] leading-none font-black uppercase">Где практика</h3>
          <ul className="mt-6 border-t-[3px] border-ink">
            {units.map(({ unit, roles }) => (
              <li
                key={unit}
                data-practice-unit={unit}
                className="grid grid-cols-[minmax(0,1fr)] gap-x-8 gap-y-2 border-b border-ink/20 py-5 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)] md:py-6"
              >
                <div className="flex items-center gap-4 md:items-start md:pt-3">
                  <Pictogram id={unitPictogram[unit]} className="size-12 text-brand md:size-14" />
                  <span className="font-display text-[clamp(30px,2.8vw,44px)] leading-[0.9] font-black uppercase">{unit}</span>
                </div>
                <ul>
                  {roles.map((v) => (
                    <Role key={v.id} v={v} />
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>

        {/* Что даёт компания */}
        <div className="mt-16 md:mt-20">
          <h3 className="font-display text-[clamp(30px,2.8vw,40px)] leading-none font-black uppercase">Что даёт компания</h3>
          <ul className="mt-6 grid grid-cols-[minmax(0,1fr)] border-t-[3px] border-ink sm:grid-cols-2 lg:grid-cols-3">
            {benefits.map((b) => (
              <li key={b.big} className="border-b border-ink/20 py-5 sm:pr-8 md:py-6">
                <p className="font-display text-[clamp(28px,2.6vw,40px)] leading-[0.9] font-black uppercase">{nb(b.big)}</p>
                <p className="mt-2 max-w-[400px] text-[15px] leading-snug text-ink/80 md:text-[17px]">{nb(b.text)}</p>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-10 md:mt-12">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-8">
            <ButtonLink to="/apply" className="w-fit">
              Откликнуться
            </ButtonLink>
            <Link to="/vacancies" className="group flex w-fit items-center gap-4 py-3 font-display text-[22px] font-extrabold tracking-[0.05em] uppercase hover:text-brand">
              Роли и графики
              <Dash />
            </Link>
          </div>
        </div>
      </div>
    </section>
  )
}
