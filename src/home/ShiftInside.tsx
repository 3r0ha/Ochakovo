import { Link } from 'react-router'
import { vacancyById } from '@shared/content/vacancies'
import { ShiftVideo, type ShiftVideoId } from '../components/ShiftVideo'
import { useReveal } from '../lib/motion'
import { Dash, payText, sectionTitle } from './kit'

/**
 * Ролики и вакансии, о которых они. Оператор линии розлива и лаборант — роли оплачиваемой практики;
 * машинист работает на производстве углекислоты, такой практики нет — ролик без ссылки на вакансию
 */
const items: { id: ShiftVideoId; vacancy?: string }[] = [
  { id: 'bottling-operator', vacancy: 'bottling-operator' },
  { id: 'lab-assistant', vacancy: 'lab-chemist' },
  { id: 'machinist' },
]

/**
 * «Смена изнутри»: три ролика «Очаково» о профессиях — честное превью работы до заявки (кейс: «посмотри смену изнутри»,
 * это снижает отсев). Плеер — ShiftVideo: до нажатия грузится только постер, звук не включается сам, вне экрана — пауза,
 * одновременно играет один ролик
 */
export function ShiftInside() {
  const title = useReveal<HTMLHeadingElement>()
  return (
    <section id="shift" className="bg-night py-20 text-white md:py-28">
      <div className="container-x">
        <h2 ref={title} className={sectionTitle}>
          Смена изнутри
        </h2>

        <ul className="mt-10 grid grid-cols-[minmax(0,1fr)] gap-x-6 gap-y-12 md:mt-12 lg:grid-cols-3">
          {items.map((item) => {
            const v = item.vacancy ? vacancyById(item.vacancy) : undefined
            return (
              <li key={item.id} data-shift-video={item.id} className="flex flex-col">
                <ShiftVideo id={item.id} quietCaption sizes="(min-width: 1024px) 440px, 100vw" className="mb-4" />
                {v && (
                  <Link
                    to={`/vacancies?open=${v.id}`}
                    className="group mt-auto flex items-baseline justify-between gap-4 border-t border-white/25 pt-4 font-display text-[22px] leading-none font-extrabold uppercase hover:text-brand-bright"
                  >
                    <span>{v.title}</span>
                    <span className="flex items-center gap-3 whitespace-nowrap">
                      {payText(v)}
                      <Dash />
                    </span>
                  </Link>
                )}
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}
