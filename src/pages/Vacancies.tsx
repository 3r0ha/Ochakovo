import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { FreePracticeRow, VacancyRow } from '../components/candidate/VacancyRow'
import { plural } from '../components/candidate/applyText'
import { passesFilters, sectionFacts, usefulFilters, type FilterId } from '../components/candidate/vacancyList'
import { departments } from '@shared/content/departments'
import { contacts } from '@shared/content/content'
import { dorm, practiceDocs, TRAINING_CENTER_ROOM } from '@shared/content/handbook'
import { freePracticeInfo, paidPracticeInfo } from '@shared/content/practice'
import { estimateNote, formatRub, freePractice, minPracticePay, paidPractice, PRACTICE_PERIOD, vacancies, vacancyById, type Vacancy } from '@shared/content/vacancies'
import { FitLine, sectionTitle, Ticker } from '../home/kit'
import { openKvasychChat } from '../components/chat/bus'
import { nb } from '../lib/typo'
import { seasonYear } from '../lib/season'
import { useProfile } from '../store/profile'

// Страница вакансий по «Описанию практики» «Очаково»: сначала оплачиваемая практика (роли, суммы, графики, что даёт компания),
// затем бесплатная практика по договорённости (задачи, отклик с отметкой «Практика от вуза»), затем работа с суммой с hh.ru.
// Под оглавлением — быстрые фильтры по данным вакансий. Срок и требования, общие для раздела, — во вступлении раздела,
// в строках только своё. Все цифры — из shared/content: vacancies.ts, practice.ts, handbook.ts.

/** Работа — всё, что не практика: вакансии с суммой с hh.ru */
const work = vacancies.filter((v) => v.format !== 'Оплачиваемая практика' && v.format !== 'Бесплатная практика')

const rub = (n: number) => formatRub(n)
/** Сумма практики одной цифрой — нижняя граница по ролям. Строки ролей пишут «от 70 000 ₽», вилка «56 000–70 000» с ними спорила */
const practiceFrom = () => `от ${rub(minPracticePay)}`

const facts = () => [
  `Оплачиваемая практика ${practiceFrom()}`,
  'Наставник у каждого новичка',
  'Без испытательного срока для студентов',
  `Общежитие студентам за ${rub(dorm.priceStudent)}`,
  'Зарплата 12-го и 27-го',
  contacts.routeShort,
  'Берём с 18 лет',
]

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)

export function Vacancies() {
  const [params] = useSearchParams()
  const quizResult = useProfile((s) => s.quizResult)
  const quizVacancy = useProfile((s) => s.quizVacancy)
  const picked = vacancyById(quizVacancy ?? '')
  // ?open=<id> — ссылка с главной ведёт к нужной вакансии, раскрывает и подсвечивает её
  const [arrived, setArrived] = useState<string | null>(() => vacancyById(params.get('open') ?? '')?.id ?? null)
  const [filters, setFilters] = useState<FilterId[]>([])
  const matched = (v: Vacancy) => (picked ? v.id === picked.id : v.department === quizResult)
  const shown = (list: Vacancy[]) => list.filter((v) => passesFilters(v, filters))

  const paid = shown(paidPractice)
  const free = shown(freePractice)
  const jobs = shown(work)
  const total = paid.length + free.length + jobs.length
  const filtered = filters.length > 0
  const chips = usefulFilters(vacancies)

  // Общее для раздела — по всем ролям раздела, с фильтром тоже: вступление от фильтра не меняется
  const paidFacts = sectionFacts(paidPractice)
  const freeFacts = sectionFacts(freePractice)
  const workFacts = sectionFacts(work)
  // «С начала марта или апреля…» — формулировка компании; если срок в панели поменяли у всех, берём его
  const paidPeriod = paidFacts.period === PRACTICE_PERIOD ? paidPracticeInfo.period : paidFacts.period

  /** Разделы страницы — для оглавления под заголовком; число — сколько ролей видно с фильтром */
  const sections = [
    { id: 'paid', title: 'Оплачиваемая практика', count: paid.length, note: `${practiceFrom()} в месяц` },
    { id: 'free', title: 'Бесплатная практика', count: free.length, note: 'по договорённости с вузом' },
    { id: 'work', title: 'Работа', count: jobs.length, note: workFacts.period ? lowerFirst(workFacts.period) : 'постоянная' },
  ]

  const toggle = (id: FilterId) => setFilters((on) => (on.includes(id) ? on.filter((x) => x !== id) : [...on, id]))
  // «Показать эту вакансию»: если её прячет фильтр — фильтр снимаем. Повторное нажатие тоже прокручивает
  const reveal = (v: Vacancy) => {
    if (!passesFilters(v, filters)) setFilters([])
    setArrived(null)
    window.setTimeout(() => setArrived(v.id), 0)
  }

  return (
    <div className="min-h-svh bg-night pt-[calc(72px+var(--invite-h,0px))] text-white">
      <section className="container-x pt-10 pb-10 md:pt-16 md:pb-14">
        <p className="font-display text-[18px] font-extrabold tracking-[0.08em] text-white/55 uppercase md:text-[20px]">
          Сезон {seasonYear()} · Москва, ул.{' '}Рябиновая,{' '}44
        </p>
        <h1 className="mt-4 font-display leading-[0.8] font-black uppercase">
          <FitLine>Вакансии</FitLine>
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-white/80 md:text-xl">
          {nb('Оплачиваемая практика в 4 отделах завода, бесплатная практика по договорённости с вузом или колледжем и постоянная работа. Берём с 18 лет, резюме не нужно.')}
        </p>
        {/* Оглавление: три раздела страницы, в каждом — сколько ролей и главный факт. Раздел, который фильтр опустошил, — без ссылки */}
        <nav aria-label="Разделы" className="mt-10 grid border-t-[3px] border-white md:grid-cols-3">
          {sections.map((s, i) => {
            const inner = (
              <>
                <span className="font-display text-[clamp(28px,2.4vw,36px)] leading-none font-black uppercase">
                  {s.title}
                  <span className="ml-2 text-white/45 tabular-nums group-hover:text-brand-bright">{s.count}</span>
                </span>
                <span className="ml-auto text-[15px] text-white/60 md:ml-0">{nb(s.note)}</span>
              </>
            )
            const cls = `group flex items-baseline gap-4 border-b border-white/15 py-4 md:flex-col md:gap-1 md:border-b-0 md:py-5 ${i ? 'md:border-l md:border-white/15 md:pl-6' : ''}`
            return s.count ? (
              <a key={s.id} href={`#${s.id}`} className={`${cls} transition-colors hover:text-brand-bright`}>
                {inner}
              </a>
            ) : (
              <div key={s.id} className={`${cls} text-white/40`}>
                {inner}
              </div>
            )
          })}
        </nav>

        {/* Быстрые фильтры: каждый — по полю данных вакансий; число — сколько ролей подходит */}
        {chips.length > 0 && (
          <div className="mt-6 flex flex-col gap-3 md:flex-row md:items-center md:gap-5">
            <div role="group" aria-label="Быстрый фильтр" className="flex flex-wrap gap-2">
              {chips.map((f) => {
                const on = filters.includes(f.id)
                return (
                  <button
                    key={f.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggle(f.id)}
                    className={`inline-flex min-h-11 items-center gap-2 px-4 text-[15px] transition-colors duration-200 ${
                      on ? 'bg-white font-medium text-ink' : 'text-white/85 ring-1 ring-white/30 ring-inset hover:ring-white'
                    }`}
                  >
                    {f.label}
                    <span className={`tabular-nums ${on ? 'text-ink/60' : 'text-white/50'}`}>{f.count}</span>
                  </button>
                )
              })}
            </div>
            <p aria-live="polite" className="flex min-h-11 items-center gap-4 text-[15px] text-white/65">
              {filtered && (
                <>
                  {nb(total ? `Показано ${total} из ${vacancies.length}` : 'Под все фильтры сразу ничего не подошло')}
                  <button
                    type="button"
                    onClick={() => setFilters([])}
                    className="inline-flex min-h-11 items-center text-white underline decoration-white/35 underline-offset-4 hover:decoration-white"
                  >
                    Сбросить
                  </button>
                </>
              )}
            </p>
          </div>
        )}
      </section>

      <Ticker items={facts()} className="border-y border-white/10 bg-coal py-3.5 font-display text-[clamp(22px,2.2vw,32px)] font-extrabold tracking-[0.04em] uppercase md:py-4" />

      {(picked || quizResult) && (
        <div className="container-x pt-12 md:pt-16">
          <div className="flex flex-col gap-3 border-l-[5px] border-brand pl-5 md:flex-row md:items-baseline md:gap-6">
            <p className="font-display text-[clamp(26px,2.6vw,36px)] leading-none font-black uppercase">
              Подбор работы советует: <span className="text-brand-bright">{picked ? picked.title : departments[quizResult!].name}</span>
            </p>
            {picked && (
              <button
                type="button"
                onClick={() => reveal(picked)}
                className="w-fit text-[17px] text-white/75 underline decoration-white/35 underline-offset-4 transition-colors hover:text-white hover:decoration-white"
              >
                Показать эту вакансию
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Оплачиваемая практика ── */}
      {paid.length > 0 && (
        <section id="paid" aria-labelledby="paid-title" className="container-x scroll-mt-20 pt-16 md:pt-24">
          <div className="grid gap-8 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-end lg:gap-16">
            <div>
              {/* Над заголовком — факты. Слоган здесь не ставим: его выбирает анкета /focus, и он подсказывал бы ответ */}
              <p className="font-display text-[clamp(20px,1.8vw,26px)] font-extrabold tracking-[0.04em] text-white/60 uppercase">
                {`${paidPracticeInfo.units.length} ${plural(paidPracticeInfo.units.length, ['отдел', 'отдела', 'отделов'])} · ${paidPractice.length} ${plural(paidPractice.length, ['роль', 'роли', 'ролей'])} · берём с 18 лет`}
              </p>
              <h2 id="paid-title" className={`${sectionTitle} mt-3`}>
                Оплачиваемая практика
              </h2>
            </div>
            <div className="lg:pb-2">
              <p className="font-display text-[clamp(44px,4.6vw,72px)] leading-none font-black text-white tabular-nums">{practiceFrom()}</p>
              <p className="mt-2 text-[15px] leading-snug text-white/65">{nb('в месяц до вычета налога, сумма зависит от роли, с ночными сменами больше')}</p>
            </div>
          </div>

          {/* Общее для всех ролей: срок и отделы, кого ждём, договор. В строках ролей это не повторяется */}
          <div className="mt-10 grid gap-x-10 gap-y-3 border-t border-white/15 pt-6 text-[17px] leading-relaxed text-white/80 md:grid-cols-2 lg:grid-cols-3">
            <p>{nb(`${paidPeriod ? `${paidPeriod}. ` : ''}${paidPracticeInfo.units.length} отдела: ${paidPracticeInfo.units.join(', ').toLowerCase()}.`)}</p>
            {paidFacts.requirements.length > 0 && <p>{nb(`${paidFacts.requirements.join('. ')}.`)}</p>}
            <p>{nb(`${paidPracticeInfo.contract}.`)}</p>
          </div>

          {/* Что даёт компания — шесть коротких строк из «Описания практики» и справочника студента */}
          <ul aria-label="Что даёт компания" className="mt-10 grid gap-x-10 sm:grid-cols-2 lg:grid-cols-3">
            {paidPracticeInfo.benefits.map((b, i) => (
              <li key={b} className="flex gap-4 border-t border-white/15 py-5">
                <span aria-hidden="true" className="font-display text-[28px] leading-none font-black text-brand-bright tabular-nums">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span className="text-[17px] leading-snug">{nb(b)}</span>
              </li>
            ))}
          </ul>

          <ul aria-label="Роли оплачиваемой практики" className="mt-12 border-t-[3px] border-white">
            {paid.map((v) => (
              <VacancyRow key={v.id} vacancy={v} facts={paidFacts} matched={matched(v)} highlight={arrived === v.id} />
            ))}
          </ul>
        </section>
      )}

      {/* ── Бесплатная практика ── */}
      {free.length > 0 && (
        <section id="free" aria-labelledby="free-title" className="container-x scroll-mt-20 pt-20 md:pt-28">
          <div className="grid gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-end lg:gap-16">
            <h2 id="free-title" className={sectionTitle}>
              Бесплатная практика
              <span className="block text-white/45">по договорённости</span>
            </h2>
            <div className="flex flex-col gap-3 text-[17px] leading-relaxed text-white/80 lg:pb-2">
              <p>{nb(`${freePracticeInfo.text} Срок и график тоже по договорённости.`)}</p>
              {/* Отметка «Практика от вуза» — один раз здесь, под кнопками строк её нет */}
              <p>
                {nb(
                  `${freeFacts.requirements.length ? `${freeFacts.requirements.join('. ')}: ` : ''}отклик отсюда ставит в заявке отметку «Практика от вуза», HR сразу видит, что нужны договор, дневник и характеристика.`,
                )}
              </p>
            </div>
          </div>

          <ul aria-label="Направления бесплатной практики" className="mt-10 border-t-[3px] border-white">
            {free.map((v) => (
              <FreePracticeRow key={v.id} vacancy={v} facts={freeFacts} matched={matched(v)} highlight={arrived === v.id} />
            ))}
          </ul>

          {/* Документы по практике — справочник студента: что, от кого и когда; куда нести */}
          <div className="mt-12 bg-coal p-6 md:p-10">
            <div className="grid gap-6 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:gap-12">
              <div>
                <h3 className="font-display text-[clamp(30px,2.8vw,42px)] leading-[0.92] font-black uppercase">Документы по практике</h3>
                <p className="mt-3 text-[16px] leading-snug text-white/70">
                  {nb(`Для оплачиваемой и бесплатной практики одни и те же. Документы несут в Учебный центр, кабинет\u00A0${TRAINING_CENTER_ROOM}.`)}
                </p>
              </div>
              <ol className="grid gap-x-6 sm:grid-cols-2 lg:grid-cols-4">
                {practiceDocs.map((d, i) => (
                  <li key={d.id} className="flex flex-col gap-2 border-t border-white/15 py-4">
                    <span aria-hidden="true" className="font-display text-[28px] leading-none font-black text-brand-bright">
                      {i + 1}
                    </span>
                    <span className="font-display text-[22px] leading-[0.95] font-extrabold uppercase">{d.title}</span>
                    <span className="text-[15px] leading-snug text-white/65">{nb(`${d.who}, ${d.when}`)}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>
      )}

      {/* ── Работа ── */}
      {jobs.length > 0 && (
        <section id="work" aria-labelledby="work-title" className="container-x scroll-mt-20 pt-20 md:pt-28">
          <div className="grid gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-end lg:gap-16">
            <h2 id="work-title" className={sectionTitle}>
              Работа
            </h2>
            <p className="text-[17px] leading-relaxed text-white/80 lg:pb-2">
              {nb(`Постоянные вакансии «Очаково» в Москве${workFacts.period ? `, ${lowerFirst(workFacts.period)}` : ''}. Суммы взяты из вакансий компании на hh.ru.`)}
            </p>
          </div>
          <ul aria-label="Вакансии работы" className="mt-10 border-t-[3px] border-white">
            {jobs.map((v) => (
              <VacancyRow key={v.id} vacancy={v} facts={workFacts} matched={matched(v)} highlight={arrived === v.id} />
            ))}
          </ul>
        </section>
      )}

      <div className="container-x pt-12 pb-16 md:pb-24">
        <p className="max-w-2xl text-[15px] leading-relaxed text-white/60">
          {/* Сноска верна для каждой строки: у практики — «Описание практики», у работы — hh.ru (shared/content/vacancies.ts) */}
          {nb(estimateNote)}
        </p>
        {/* Кнопка чата не встаёт поверх строк вакансий, поэтому вход в чат есть и здесь, сразу под списком */}
        <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-white/70">
          {nb('Квасыч отвечает про график, общежитие, документы и медосмотр.')}{' '}
          <button
            type="button"
            onClick={() => openKvasychChat()}
            className="text-white underline decoration-white/35 underline-offset-4 transition-colors hover:decoration-white"
          >
            Открыть чат
          </button>
        </p>
      </div>

      {/* Финальная полоса, как на главной */}
      <Link to="/apply" className="group block border-t border-white/10 bg-coal transition-colors duration-300 hover:text-brand-bright">
        <div className="container-x flex flex-col gap-2 py-8 md:py-10">
          <span className="text-[15px] text-white/75 md:text-[17px]">Если подходящей нет, HR подберёт позицию</span>
          <span className="flex items-center gap-5 md:gap-8">
            <span className="min-w-0 flex-1 font-display leading-[0.8] font-black uppercase">
              <FitLine>Заявка без вакансии</FitLine>
            </span>
            <svg viewBox="0 0 64 24" fill="none" className="w-12 shrink-0 text-brand transition-transform duration-500 ease-out-expo group-hover:translate-x-2 md:w-20" aria-hidden="true">
              <path d="M0 12h60M50 2l10 10-10 10" stroke="currentColor" strokeWidth="3" />
            </svg>
          </span>
        </div>
      </Link>
    </div>
  )
}
