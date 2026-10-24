import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { departments } from '@shared/content/departments'
import { formatRub, hasNightShifts, netPay, payLabel, type Vacancy } from '@shared/content/vacancies'
import type { PhotoName } from '@shared/photos'
import { btn, Dash, Duo } from '../../home/kit'
import { scrollToTarget } from '../../lib/motion'
import { nb } from '../../lib/typo'
import { SHIFT_VIDEOS, ShiftVideo, type ShiftVideoId } from '../ShiftVideo'
import { glueChains, ownPeriod, ownRequirements, type SectionFacts } from './vacancyList'

// Строки страницы вакансий. На телефоне строка короткая: отдел, название, сумма, график одной строкой и «Откликнуться»;
// часы смен, задачи, кого ждём и ролик — по «Подробнее». На компьютере всё видно сразу, в три колонки.
// Срок и требования, общие для раздела, стоят во вступлении раздела — в строке только то, что у роли своё.
// У ролей с роликом компании — «Посмотреть смену»: постер, видео по нажатию, файл не грузится заранее (ShiftVideo).

/** Ролики «Смена изнутри» к ролям: цех розлива и лаборатория (public/video/manifest.json) */
const roleVideo: Record<string, ShiftVideoId> = {
  'bottling-operator': 'bottling-operator',
  'lab-chemist': 'lab-assistant',
}

/**
 * Фото к ролям без ролика — только если кадр про эту работу: варочный цех и продукция для магазина.
 * null — подходящего кадра нет, лучше без фото: склад на фото с водителем фуры и мерчандайзер на линии с банками сбивали с толку
 */
const rolePhoto: Record<string, PhotoName | null> = {
  'fermentation-assistant': 'brewhouse',
  'warehouse-operator': null,
  storekeeper: null,
  'store-worker': 'products',
  merchandiser: null,
}

export const videoFor = (v: Vacancy): ShiftVideoId | null => {
  const id = roleVideo[v.id]
  return id && SHIFT_VIDEOS.some((x) => x.id === id) ? id : null
}

/** Фото роли: своё, если задано (null — без фото), иначе фото отдела */
const photoFor = (v: Vacancy): PhotoName | null => (v.id in rolePhoto ? rolePhoto[v.id] : departments[v.department].photo)

/** Отдел так, как его называет компания, или направление сайта */
export const unitName = (v: Vacancy) => v.unit ?? departments[v.department].name

const kicker = 'font-display text-[17px] font-extrabold tracking-[0.07em] uppercase'
const label = 'font-display text-[16px] font-extrabold tracking-[0.07em] text-white/55 uppercase'

/** Пункты списка — короткая черта вместо маркера-значка */
function Dashes({ items }: { items: string[] }) {
  return (
    <ul className="mt-2 flex flex-col gap-1.5 text-[16px] leading-snug text-white/85">
      {items.map((t) => (
        <li key={t} className="grid grid-cols-[1.25rem_1fr]">
          <span aria-hidden="true" className="mt-[0.7em] block h-[2px] w-2.5 bg-brand-bright" />
          {nb(t)}
        </li>
      ))}
    </ul>
  )
}

/**
 * Строка, на которую пришли по ссылке ?open=<id>: раскрывается, прокручивается к себе и подсвечивается на пару секунд.
 * Раскрытие «Подробнее» на телефоне — здесь же: ссылка с главной открывает строку целиком
 */
function useArrival(highlight: boolean) {
  const ref = useRef<HTMLLIElement>(null)
  const [lit, setLit] = useState(highlight)
  const [open, setOpen] = useState(highlight)
  useEffect(() => {
    if (!highlight || !ref.current) return
    const el = ref.current
    setLit(true)
    setOpen(true)
    // Ждём, пока Layout сбросит прокрутку после перехода; прокрутка — общая для сайта (учитывает плавный скролл и шапку)
    const scroll = window.setTimeout(() => scrollToTarget(el), 350)
    const off = window.setTimeout(() => setLit(false), 2600)
    return () => {
      window.clearTimeout(scroll)
      window.clearTimeout(off)
    }
  }, [highlight])
  return { ref, lit, open, setOpen }
}

/**
 * Подложка строки — отдельным слоем шире строки: линии между строками остаются по краю колонки,
 * а подсветка не сдвигает текст
 */
const rowSurface = (lit: boolean) =>
  `relative isolate before:pointer-events-none before:absolute before:inset-y-0 before:-inset-x-3 before:-z-10 before:bg-coal before:transition-opacity before:duration-[1200ms] md:before:-inset-x-5 ${lit ? 'before:opacity-100' : 'before:opacity-0'}`

/** «Подробнее» — только на телефоне: на компьютере подробности видны всегда */
function MoreToggle({ open, onToggle, controls }: { open: boolean; onToggle: () => void; controls: string }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={controls}
      className="flex min-h-11 w-full items-center justify-between gap-4 border-y border-white/15 py-2 text-left text-[16px] text-white/85 transition-colors hover:text-white md:hidden"
    >
      {open ? 'Свернуть' : 'Подробнее'}
      <span className={`relative block size-3.5 shrink-0 transition-transform duration-300 ${open ? 'rotate-45' : ''}`} aria-hidden="true">
        <span className="absolute top-1/2 left-0 h-[2px] w-full -translate-y-1/2 bg-current" />
        <span className="absolute top-0 left-1/2 h-full w-[2px] -translate-x-1/2 bg-current" />
      </span>
    </button>
  )
}

type RowProps = {
  vacancy: Vacancy
  /** Общее для раздела — во вступлении раздела, в строке не повторяем */
  facts: SectionFacts
  /** Советует подбор работы */
  matched?: boolean
  /** Пришли по ссылке на эту вакансию */
  highlight?: boolean
}

/**
 * Роль оплачиваемой практики или работа: название и сумма, график и задачи, ролик смены или фото отдела, «Откликнуться».
 * На телефоне — короткой строкой, подробности и ролик по «Подробнее»
 */
export function VacancyRow({ vacancy, facts, matched = false, highlight = false }: RowProps) {
  const { ref, lit, open, setOpen } = useArrival(highlight)
  const video = videoFor(vacancy)
  const photo = video ? null : photoFor(vacancy)
  const nights = hasNightShifts(vacancy)
  // «Срочный набор» никогда не стоит рядом с ориентиром: срочно нанимают туда, где сумма уже известна
  const hot = Boolean(vacancy.hot && vacancy.pay && !vacancy.pay.estimate)
  const titleId = `vacancy-${vacancy.id}-title`
  const detailsId = `vacancy-${vacancy.id}-details`
  const period = ownPeriod(vacancy, facts)
  const requirements = ownRequirements(vacancy, facts)
  // На телефоне подробности свёрнуты; на компьютере видны всегда
  const shown = open ? '' : 'hidden md:block'
  const media = Boolean(video || photo)

  return (
    <li ref={ref} id={`vacancy-row-${vacancy.id}`} aria-labelledby={titleId} className={`scroll-mt-24 border-b border-white/15 py-8 md:py-12 ${rowSurface(lit)}`}>
      {/* Без ролика и фото подробности занимают и колонку картинки — колонки строк остаются на тех же местах */}
      <div
        className={`grid gap-x-10 gap-y-5 md:gap-y-7 ${
          media
            ? "md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] md:[grid-template-areas:'head_media'_'info_media'_'cta_media'] lg:grid-cols-[minmax(0,4fr)_minmax(0,4fr)_minmax(0,5fr)] lg:[grid-template-areas:'head_info_media'_'cta_info_media']"
            : "md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] md:[grid-template-areas:'head_info'_'cta_info'] lg:grid-cols-[minmax(0,4fr)_minmax(0,4fr)_minmax(0,5fr)] lg:[grid-template-areas:'head_info_info'_'cta_info_info']"
        }`}
      >
        <div className="md:[grid-area:head]">
          <p className={`${kicker} flex flex-wrap gap-x-4 gap-y-1 text-white/55`}>
            <span>{unitName(vacancy)}</span>
            {matched && <span className="text-brand-bright">Советует подбор работы</span>}
            {hot && <span className="text-brand-bright">Срочный набор</span>}
          </p>
          <h3 id={titleId} className="mt-2 font-display text-[clamp(34px,3.4vw,52px)] leading-[0.9] font-black uppercase">
            {vacancy.title}
          </h3>
          <p className="mt-4 font-display text-[clamp(36px,3.2vw,48px)] leading-none font-black text-brand-bright tabular-nums">{payLabel(vacancy)}</p>
          {vacancy.pay && (
            <p className="mt-2 text-[15px] leading-snug text-white/65">
              {nb(`в месяц до вычета налога${vacancy.payNote ? `, ${vacancy.payNote}` : ''}`)}
              <span className="block">{nb(`на руки от ${formatRub(netPay(vacancy.pay.from))}`)}</span>
            </p>
          )}
          {/* График одной строкой — на телефоне в свёрнутой строке; на компьютере он в колонке «График» */}
          <p className="mt-4 text-[16px] leading-snug text-white md:hidden">{nb(glueChains(vacancy.schedule))}</p>
        </div>

        <MoreToggle open={open} onToggle={() => setOpen(!open)} controls={detailsId} />

        <div id={detailsId} className={`md:[grid-area:info] ${shown}`}>
          <dl className="grid gap-5">
            <div>
              <dt className={label}>График</dt>
              <dd className="mt-2 text-[16px] leading-snug">
                <span className="hidden md:block">{nb(glueChains(vacancy.schedule))}</span>
                {vacancy.hours && <span className="block text-white/65">{nb(vacancy.hours)}</span>}
                {nights && !/ночн|ночь/i.test(`${vacancy.schedule} ${vacancy.hours ?? ''}`) && <span className="block text-white/65">Бывают ночные смены</span>}
                {period && <span className="block text-white/65">{nb(glueChains(period))}</span>}
              </dd>
            </div>
            <div>
              <dt className={label}>Что делать</dt>
              <dd>
                <Dashes items={vacancy.tasks} />
              </dd>
            </div>
            {requirements && (
              <div>
                <dt className={label}>Кого ждём</dt>
                <dd className="mt-2 text-[16px] leading-snug text-white/85">{nb(requirements)}</dd>
              </div>
            )}
          </dl>
        </div>

        {/* Ролик — на телефоне в подробностях, на компьютере колонкой справа. Фото отдела — только на широком экране */}
        {media && (
          <div className={`md:[grid-area:media] ${video ? shown : 'hidden md:block'}`}>
            {video ? (
              <ShiftVideo id={video} title={unitName(vacancy)} showSteps={false} sizes="(min-width: 1024px) 520px, (min-width: 768px) 55vw, 100vw" />
            ) : (
              <Duo name={photo!} tone="mono" sizes="(min-width: 1024px) 520px, 55vw" className="aspect-video" />
            )}
          </div>
        )}

        <div className="md:[grid-area:cta] md:self-end">
          <Link to={`/apply?vacancy=${vacancy.id}`} className={`${btn.red} w-full sm:w-fit`} aria-describedby={titleId}>
            Откликнуться
            <Dash />
          </Link>
        </div>
      </div>
    </li>
  )
}

/**
 * Направление бесплатной практики: кому подходит, задачи, отклик с отметкой «Практика от вуза» (о ней — во вступлении раздела).
 * На телефоне задачи — по «Подробнее»
 */
export function FreePracticeRow({ vacancy, facts, matched = false, highlight = false }: RowProps) {
  const { ref, lit, open, setOpen } = useArrival(highlight)
  const titleId = `vacancy-${vacancy.id}-title`
  const detailsId = `vacancy-${vacancy.id}-details`
  const requirements = ownRequirements(vacancy, facts)
  return (
    <li
      ref={ref}
      id={`vacancy-row-${vacancy.id}`}
      aria-labelledby={titleId}
      className={`scroll-mt-24 grid gap-x-10 gap-y-5 border-b border-white/15 py-8 md:grid-cols-[minmax(0,4fr)_minmax(0,5fr)_auto] md:items-start md:py-10 ${rowSurface(lit)}`}
    >
      <div>
        <p className={`${kicker} flex flex-wrap gap-x-4 text-white/55`}>
          <span>{departments[vacancy.department].name}</span>
          {matched && <span className="text-brand-bright">Советует подбор работы</span>}
        </p>
        <h3 id={titleId} className="mt-2 font-display text-[clamp(30px,2.8vw,42px)] leading-[0.92] font-black uppercase">
          {vacancy.title}
        </h3>
        <p className="mt-3 font-display text-[22px] leading-none font-extrabold tracking-[0.04em] text-white/75 uppercase">{payLabel(vacancy)}</p>
        {requirements && <p className="mt-3 text-[15px] leading-snug text-white/65">{nb(requirements)}</p>}
      </div>
      <MoreToggle open={open} onToggle={() => setOpen(!open)} controls={detailsId} />
      <div id={detailsId} className={open ? '' : 'hidden md:block'}>
        <p className={label}>Задачи</p>
        <Dashes items={vacancy.tasks} />
      </div>
      <div className="md:text-right">
        <Link to={`/apply?vacancy=${vacancy.id}&practice=1`} className={`${btn.ghost} w-full sm:w-fit`} aria-describedby={titleId}>
          Откликнуться
          <Dash />
        </Link>
      </div>
    </li>
  )
}
