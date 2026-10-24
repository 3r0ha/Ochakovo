import { contacts } from '@shared/content/content'
import { handbookText, PAY_DAYS } from '@shared/content/handbook'
import { scheduleByUnit, scheduleNote, scheduleSummary, shiftHours } from '@shared/content/vacancies'
import type { ReactNode } from 'react'
import { useReveal } from '../lib/motion'
import { nb } from '../lib/typo'
import { ButtonLink, sectionTitle } from './kit'

/**
 * Пять строк «Условий» — как устроена жизнь на практике и на работе. Что даёт компания (наставник, общежитие, обед,
 * спецодежда, медосмотр) — в блоке «Практика» выше, здесь не повторяется.
 * Тексты — из «Справочника студента» (handbookText в shared/content/handbook.ts): те же, что отвечают бот и Квасыч.
 * График — из тех же данных, что чат отвечает на «какой график» (scheduleSummary), но таблицей по отделам: абзац с тремя
 * «день — ночь — отсыпной — выходной» читался тяжело. Дорога — contacts.route по предложениям: первым корпоративный автобус
 * от м. «Озёрная», по справочнику студента
 */
// Делим по точке перед заглавной буквой: «м. «Озёрная»» не рвётся
const routeLines = contacts.route.split(/\.\s+(?=[А-ЯЁ])/).map((x) => x.replace(/\.$/, '')).filter(Boolean)

/** Список строк подробности: первая — главная, остальные — отдельными пунктами */
function Lines({ lines }: { lines: ReactNode[] }) {
  return (
    <ul className="space-y-2">
      {lines.map((line, i) => (
        <li key={i} className={i === 0 ? 'font-medium' : ''}>
          {line}
        </li>
      ))}
    </ul>
  )
}

const rows: { k: string; big: string; v: ReactNode }[] = [
  { k: 'Деньги', big: `${PAY_DAYS[0]}-го и ${PAY_DAYS[1]}-го`, v: nb(handbookText('payday')) },
  {
    k: 'График',
    big: scheduleSummary.title,
    v: (
      <>
        <p className="font-medium">{nb(shiftHours)}</p>
        <table className="mt-3 w-full border-collapse text-left">
          <tbody>
            {scheduleByUnit.map((s) => (
              <tr key={s.unit} className="border-t border-ink/20 align-baseline">
                <th scope="row" className="w-[42%] py-2 pr-4 font-semibold">
                  {s.unit}
                </th>
                <td className="py-2">{nb(s.text)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3">{nb(scheduleNote)}</p>
      </>
    ),
  },
  { k: 'Учёба', big: 'Экзамены на заводе', v: nb(handbookText('exams')) },
  { k: 'Документы', big: 'Договор с вузом', v: nb(handbookText('practice-docs')) },
  { k: 'Дорога', big: 'Рябиновая, 44', v: <Lines lines={routeLines.map((l) => nb(`${l}.`))} /> },
]

/** Условия: одна таблица между двойными линейками — метка, факт крупно и подробность */
export function Conditions() {
  const title = useReveal<HTMLHeadingElement>()

  return (
    <section id="conditions" className="bg-white py-20 text-ink md:py-28">
      <div className="container-x">
        <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <h2 ref={title} className={sectionTitle}>
            Условия
          </h2>
          <ButtonLink to="/apply" variant="ink" className="w-fit">
            Откликнуться
          </ButtonLink>
        </div>

        {/* Двойная линейка сверху и снизу: 2 px, зазор 3 px, 1 px */}
        <div className="mt-10 border-y-2 border-ink py-[3px] md:mt-12">
          <dl className="border-y border-ink">
            {rows.map((r) => (
              <div
                key={r.k}
                className="grid grid-cols-[minmax(0,1fr)] gap-y-2 border-b border-ink/20 py-6 last:border-b-0 md:grid-cols-[minmax(7rem,0.55fr)_minmax(0,1.6fr)_minmax(0,1.7fr)] md:items-baseline md:gap-x-8 md:py-7 lg:gap-x-12"
              >
                <dt className="font-display text-[17px] font-bold tracking-[0.08em] uppercase">{r.k}</dt>
                <dd className="font-display text-[clamp(40px,4.4vw,68px)] leading-[0.9] font-black uppercase [overflow-wrap:anywhere]">{r.big}</dd>
                <dd className="max-w-[560px] text-[17px] leading-relaxed text-ink">{r.v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  )
}
