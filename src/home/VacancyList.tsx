import { Link } from 'react-router'
import { departments } from '@shared/content/departments'
import { freePracticeInfo, paidPracticeInfo } from '@shared/content/practice'
import { freePractice, paidPractice, scheduleLine, vacancies, type Vacancy } from '@shared/content/vacancies'
import { scrollToTarget, useReveal } from '../lib/motion'
import { nb } from '../lib/typo'
import { Dash, EstimateNote, payText, sectionTitle } from './kit'
import { HEADER_OFFSET } from './tasks'

const vacanciesWord = (n: number) => {
  const d = n % 10
  const h = n % 100
  if (d === 1 && h !== 11) return 'вакансия'
  if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return 'вакансии'
  return 'вакансий'
}
const rolesWord = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'роль' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'роли' : 'ролей')
const rub = (n: number) => n.toLocaleString('ru-RU')

/** Постоянная работа — живые вакансии «Очаково» на hh.ru */
const permanent = vacancies.filter((v) => v.format === 'Постоянная работа')

/**
 * Строка вакансии: название и отдел, затем что делать (у бесплатной практики — задачи, у работы — график и срок) и сумма.
 * Формат уже назван заголовком группы — в строке его нет. У бесплатной практики вместо суммы — тихое «без оплаты»:
 * крупным серым оно повторялось бы четыре раза подряд
 */
function Row({ v }: { v: Vacancy }) {
  const free = v.format === 'Бесплатная практика'
  return (
    <li className="border-b border-ink/15">
      <Link
        to={`/vacancies?open=${v.id}`}
        className="group grid gap-x-8 gap-y-1 py-6 transition-colors hover:bg-ink hover:text-white md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:px-4 md:py-7 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1.1fr)_minmax(13rem,auto)]"
      >
        <span>
          <span className="block font-display text-[clamp(28px,2.8vw,42px)] leading-[0.95] font-extrabold uppercase">{v.title}</span>
          <span className="mt-1.5 block text-[15px] text-mute group-hover:text-white/80">{departments[v.department].name}</span>
        </span>
        <span className="text-[15px] text-ink/75 group-hover:text-white/85 md:col-start-1 md:row-start-2 lg:col-start-2 lg:row-start-1 lg:text-[17px]">
          {free ? (
            nb(v.tasks.slice(0, 2).join(' · '))
          ) : (
            <>
              {scheduleLine(v)}
              <span className="lg:hidden"> · </span>
              <br className="hidden lg:block" />
              {v.period.toLowerCase()}
            </>
          )}
        </span>
        {free ? (
          <span className="mt-1 text-[15px] text-mute group-hover:text-white/80 md:col-start-2 md:row-span-2 md:row-start-1 md:mt-0 md:text-right lg:col-start-3 lg:row-span-1">
            {payText(v)}
          </span>
        ) : (
          <span className="mt-2 font-display text-[clamp(30px,2.8vw,42px)] leading-none font-black tabular-nums md:col-start-2 md:row-span-2 md:row-start-1 md:mt-0 md:text-right lg:col-start-3 lg:row-span-1">
            <span className="whitespace-nowrap">{payText(v)}</span>
            <span className="group-hover:[&>span]:text-white/80">
              <EstimateNote v={v} />
            </span>
          </span>
        )}
      </Link>
    </li>
  )
}

/**
 * «Вакансии» на главной — все три формата. Оплачиваемая практика одной строкой: её роли и суммы уже в блоке «Практика»
 * выше, строка ведёт туда. Ниже — бесплатная практика по договорённости и постоянная работа целиком
 */
export function VacancyList() {
  const title = useReveal<HTMLHeadingElement>()
  return (
    <section id="vacancies" className="bg-white py-20 text-ink md:py-28">
      <div className="container-x">
        <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <h2 ref={title} className={sectionTitle}>
            Вакансии
          </h2>
          <Link to="/vacancies" className="group flex w-fit items-center gap-4 font-display text-[22px] font-extrabold tracking-[0.05em] uppercase hover:text-brand md:pb-2">
            Все {vacancies.length} {vacanciesWord(vacancies.length)}
            <Dash />
          </Link>
        </div>

        <div className="mt-10 border-t-[3px] border-ink">
          <a
            href="#practice"
            data-vacancy-group="paid"
            onClick={(e) => {
              // Как ссылки шапки: прокрутка с отступом под шапку и фокус на блок — следующий Tab идёт по нему
              e.preventDefault()
              const el = document.getElementById('practice')
              if (!el) return
              scrollToTarget(el, HEADER_OFFSET)
              if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1')
              el.focus({ preventScroll: true })
            }}
            className="group grid w-full gap-x-8 gap-y-1 border-b border-ink/15 py-6 text-left transition-colors hover:bg-ink hover:text-white md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:px-4 md:py-7 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1.1fr)_minmax(13rem,auto)]"
          >
            <span>
              <span className="block font-display text-[clamp(28px,2.8vw,42px)] leading-[0.95] font-extrabold uppercase">Оплачиваемая практика</span>
              <span className="mt-1.5 block text-[15px] text-mute group-hover:text-white/80">
                {paidPractice.length} {rolesWord(paidPractice.length)} в&nbsp;{paidPracticeInfo.units.length} отделах, подробности в&nbsp;начале страницы
              </span>
            </span>
            <span className="text-[15px] text-ink/75 group-hover:text-white/85 md:col-start-1 md:row-start-2 lg:col-start-2 lg:row-start-1 lg:text-[17px]">
              {nb(paidPracticeInfo.units.map((u, i) => (i ? u.charAt(0).toLowerCase() + u.slice(1) : u)).join(', '))}
            </span>
            <span className="mt-2 font-display text-[clamp(30px,2.8vw,42px)] leading-none font-black whitespace-nowrap tabular-nums md:col-start-2 md:row-span-2 md:row-start-1 md:mt-0 md:text-right lg:col-start-3 lg:row-span-1">
              {rub(paidPracticeInfo.payFrom)}–{rub(paidPracticeInfo.payTo)}&nbsp;₽
            </span>
          </a>

          <div data-vacancy-group="free" className="mt-10">
            <h3 className="font-display text-[clamp(26px,2.4vw,34px)] leading-none font-black uppercase">{freePracticeInfo.title}</h3>
            <p className="mt-2 max-w-[640px] text-[15px] leading-snug text-ink/80 md:text-[17px]">{nb(freePracticeInfo.text)}</p>
            <ul className="mt-4 border-t border-ink">
              {freePractice.map((v) => (
                <Row key={v.id} v={v} />
              ))}
            </ul>
          </div>

          <div data-vacancy-group="work" className="mt-10">
            <h3 className="font-display text-[clamp(26px,2.4vw,34px)] leading-none font-black uppercase">Постоянная работа</h3>
            <p className="mt-2 max-w-[640px] text-[15px] leading-snug text-ink/80 md:text-[17px]">
              {nb('Круглый год. Суммы взяты из вакансий «Очаково» на hh.ru, в месяц до вычета налога.')}
            </p>
            <ul className="mt-4 border-t border-ink">
              {permanent.map((v) => (
                <Row key={v.id} v={v} />
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  )
}
