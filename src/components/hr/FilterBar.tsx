import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  applicationStatuses,
  citizenshipOptions,
  declineReasons,
  medBookOptions,
  shiftOptions,
  startReadyOptions,
  statusLabel,
  type HrApplication,
} from '@shared/applications'
import { departmentList, type DepartmentId } from '@shared/content/departments'
import { vacancies, vacancyFormats, type VacancyFormat } from '@shared/content/vacancies'
import { filterToParams, isFriendSource, sourceKey, taskFilters, type HrFilter, type SortKey, type SortSpec, type TaskFilter } from '@shared/hrFilter'
import type { Staff } from '../../lib/api'
import { seasonMonths } from '../../lib/season'
import { sourceName } from './hrUtils'
import { CheckRow, Popover, useFocusTrap } from './overlay'
import { chip, FilterSelect, hrBtn, StatusBadge } from './ui'

const monthNames: Record<number, string> = { 3: 'март', 4: 'апрель', 5: 'май', 6: 'июнь', 7: 'июль', 8: 'август', 9: 'сентябрь' }

/** ГГГГ-ММ-ДД → число и месяц словами для чипа периода */
const ruDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' })

const waitingLabel = (h: number) => (h >= 48 && h % 24 === 0 ? `${h / 24} ${h / 24 < 5 ? 'дня' : 'дней'}` : `${h} ч`)

export const sortOptions: { value: string; label: string }[] = [
  { value: 'date:desc', label: 'новые' },
  { value: 'date:asc', label: 'старые' },
  { value: 'waiting:desc', label: 'дольше всех ждут ответа' },
  { value: 'interview:asc', label: 'ближайшие собеседования' },
  { value: 'status:asc', label: 'по статусу' },
  { value: 'vacancy:asc', label: 'по вакансии' },
  { value: 'name:asc', label: 'по фамилии' },
]

type Props = {
  filter: HrFilter
  onChange: (f: HrFilter) => void
  apps: HrApplication[]
  staff: Staff[]
  /** Вид, от которого идёт отбор: его условия чипами не повторяем, «Сбросить всё» возвращает к нему */
  base: HrFilter
  /** Сколько заявок найдено — для кнопки «Показать N» на телефоне */
  found: number
  sort: SortSpec
}

/** Поиск ждёт паузы в наборе: на тысячах заявок список не пересчитывается на каждую букву */
const SEARCH_DELAY_MS = 150

/** Убрать пустые поля: пустой фильтр не попадает в адрес */
const clean = (f: HrFilter) => {
  const next = { ...f }
  for (const k of Object.keys(next) as (keyof HrFilter)[]) {
    const v = next[k]
    if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) delete next[k]
  }
  return next
}

/**
 * Фильтры списка заявок. На ноутбуке на виду поиск, статус, вакансия, месяцы и «Ведёт», остальное — в «Ещё фильтры».
 * Выбранное — чипами под панелью, каждый снимается крестиком. На телефоне — кнопка «Фильтры» и лист во весь экран
 */
export function FilterBar({ filter, onChange, apps, staff, base, found, sort }: Props) {
  const [sheet, setSheet] = useState(false)
  const set = (patch: Partial<HrFilter>) => onChange(clean({ ...filter, ...patch }))

  // Строка поиска живёт сама по себе и уходит в фильтр через 150 мс после последней буквы
  const [query, setQuery] = useState(filter.q ?? '')
  const timer = useRef<number | null>(null)
  const latest = useRef(set)
  latest.current = set
  useEffect(() => {
    // Фильтр сбросили или выбрали вид — строка поиска следует за ним, если человек сейчас не печатает
    if (timer.current === null) setQuery(filter.q ?? '')
  }, [filter.q])
  useEffect(() => () => void (timer.current !== null && window.clearTimeout(timer.current)), [])
  const typeQuery = (value: string) => {
    setQuery(value)
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      timer.current = null
      latest.current({ q: value || undefined })
    }, SEARCH_DELAY_MS)
  }

  // Источники — только те, что есть в заявках; приглашения друзей одной строкой
  const sources = useMemo(() => {
    const keys = new Set(apps.map((a) => sourceKey(a)))
    const list = [...keys].filter((k) => k && !isFriendSource(k)).map((k) => ({ id: k, label: sourceName(k) }))
    list.sort((a, b) => a.label.localeCompare(b.label, 'ru'))
    if ([...keys].some(isFriendSource)) list.unshift({ id: 'friends', label: 'Приглашения друзей' })
    if (keys.has('')) list.unshift({ id: 'direct', label: 'Прямой заход' })
    return list
  }, [apps])

  const chips = activeChips(filter, base, { staff, sources })
  const statuses = filter.statuses ?? []
  const months = filter.months ?? []
  // «Ещё фильтры · N»: сколько условий выбрано за пределами видимых пяти
  const moreCount = chips.filter((c) => !['status', 'vacancy', 'months', 'assignee'].includes(c.key)).length
  const reset = () => onChange(clean({ ...base }))

  const statusChecks = applicationStatuses.map((s) => (
    <CheckRow key={s.id} checked={statuses.includes(s.id)} onChange={(v) => set({ statuses: v ? [...statuses, s.id] : statuses.filter((x) => x !== s.id) })}>
      <StatusBadge status={s.id} />
    </CheckRow>
  ))
  const monthChecks = seasonMonths.map((m) => (
    <CheckRow key={m.value} checked={months.includes(m.value)} onChange={(v) => set({ months: v ? [...months, m.value].sort((a, b) => a - b) : months.filter((x) => x !== m.value) })}>
      {monthNames[m.value]}
    </CheckRow>
  ))

  const vacancyOptions = (
    <>
      <option value="">Все вакансии</option>
      {vacancies.map((v) => (
        <option key={v.id} value={v.id}>
          {v.title}
        </option>
      ))}
    </>
  )
  const assigneeValue = filter.assignee === undefined ? '' : String(filter.assignee)
  const setAssignee = (v: string) => set({ assignee: v === '' ? undefined : v === 'me' || v === 'none' ? v : Number(v) })
  const assigneeOptions = (
    <>
      <option value="">Ведёт кто угодно</option>
      <option value="me">Мои заявки</option>
      <option value="none">Без ответственного</option>
      {staff.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </>
  )

  const search = (
    <label className="min-w-0 flex-1 lg:max-w-[360px] lg:min-w-[240px]">
      <span className="sr-only">Поиск</span>
      <input
        type="search"
        value={query}
        onChange={(e) => typeQuery(e.target.value)}
        placeholder="Имя, фамилия, телефон или номер заявки"
        className="h-10 w-full border-b border-white/30 bg-transparent text-[15px] text-white placeholder:text-white/55 focus:border-white"
      />
    </label>
  )

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-x-5 gap-y-2 lg:flex-wrap">
        {search}
        <div className="hidden lg:contents">
          {/* Статус из вида («В работе») не подсвечиваем: подсвечено то, что добавлено к виду */}
          <Popover label={statuses.length ? `Статус · ${statuses.length}` : 'Статус'} active={chips.some((c) => c.key === 'status')}>
            <div className="flex flex-col">{statusChecks}</div>
          </Popover>
          <FilterSelect aria-label="Вакансия" value={filter.vacancy ?? ''} active={Boolean(filter.vacancy)} onChange={(e) => set({ vacancy: e.target.value || undefined })}>
            {vacancyOptions}
          </FilterSelect>
          <Popover label={months.length ? `Месяцы · ${months.length}` : 'Месяцы'} active={chips.some((c) => c.key === 'months')}>
            <p className="mb-2 px-1 text-[13px] text-night/70">Кандидат готов работать хотя бы в&nbsp;один из&nbsp;выбранных месяцев</p>
            <div className="grid grid-cols-2 gap-x-2">{monthChecks}</div>
          </Popover>
          <FilterSelect aria-label="Ответственный" value={assigneeValue} active={filter.assignee !== undefined} onChange={(e) => setAssignee(e.target.value)}>
            {assigneeOptions}
          </FilterSelect>
          <Popover label={moreCount ? `Ещё фильтры · ${moreCount}` : 'Ещё фильтры'} active={moreCount > 0} align="right">
            <div className="grid w-[min(88vw,620px)] grid-cols-2 gap-x-6 gap-y-3 p-1 text-[15px]">
              <MoreFields filter={filter} set={set} sources={sources} light />
            </div>
          </Popover>
        </div>
        <button
          type="button"
          onClick={() => setSheet(true)}
          aria-haspopup="dialog"
          className={`h-10 shrink-0 border-b px-1 text-[15px] lg:hidden ${chips.length ? 'border-white text-white' : 'border-white/30 text-white/80'}`}
        >
          Фильтры{chips.length ? ` · ${chips.length}` : ''}
        </button>
      </div>

      {chips.length > 0 && (
        <ul className="flex flex-wrap items-center gap-2" aria-label="Выбранные фильтры">
          {chips.map((c) => (
            <li key={c.key}>
              <button
                type="button"
                onClick={() => onChange(clean(c.remove(filter, base)))}
                className="inline-flex h-8 max-w-[80vw] items-center gap-2 rounded-full bg-white/[0.08] pr-2.5 pl-3 text-[14px] text-white ring-1 ring-white/25 ring-inset hover:ring-white/60"
                aria-label={`Убрать фильтр: ${c.label}`}
              >
                <span className="truncate">{c.label}</span>
                <svg viewBox="0 0 10 10" className="size-2.5 shrink-0 text-white/70" aria-hidden="true">
                  <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.6" />
                </svg>
              </button>
            </li>
          ))}
          <li>
            <button type="button" onClick={reset} className="inline-flex min-h-8 items-center text-[14px] text-brand-bright underline decoration-brand-bright/40 underline-offset-4 hover:decoration-brand-bright">
              Сбросить всё
            </button>
          </li>
        </ul>
      )}

      <FilterSheet open={sheet} onClose={() => setSheet(false)} found={found} onReset={chips.length ? reset : undefined}>
        <SheetGroup title="Сначала">
          <select
            aria-label="Порядок списка"
            value={`${sort.key}:${sort.dir}`}
            onChange={(e) => {
              const [key, dir] = e.target.value.split(':') as [SortKey, 'asc' | 'desc']
              set({ sort: { key, dir } })
            }}
            className={sheetSelect}
          >
            {sortOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </SheetGroup>
        <SheetGroup title="Статус">
          <div className="grid grid-cols-2 gap-2">
            {applicationStatuses.map((s) => {
              const on = statuses.includes(s.id)
              return (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => set({ statuses: on ? statuses.filter((x) => x !== s.id) : [...statuses, s.id] })}
                  className={chip(on, { plain: true })}
                >
                  <StatusBadge status={s.id} />
                </button>
              )
            })}
          </div>
        </SheetGroup>
        <SheetGroup title="Вакансия">
          <select aria-label="Вакансия" value={filter.vacancy ?? ''} onChange={(e) => set({ vacancy: e.target.value || undefined })} className={sheetSelect}>
            {vacancyOptions}
          </select>
        </SheetGroup>
        <SheetGroup title="Месяцы">
          <div className="grid grid-cols-4 gap-2">
            {seasonMonths.map((m) => {
              const on = months.includes(m.value)
              return (
                <button key={m.value} type="button" aria-pressed={on} onClick={() => set({ months: on ? months.filter((x) => x !== m.value) : [...months, m.value].sort((a, b) => a - b) })} className={chip(on)}>
                  {m.label}
                </button>
              )
            })}
          </div>
        </SheetGroup>
        <SheetGroup title="Ведёт">
          <select aria-label="Ответственный" value={assigneeValue} onChange={(e) => setAssignee(e.target.value)} className={sheetSelect}>
            {assigneeOptions}
          </select>
        </SheetGroup>
        <MoreFields filter={filter} set={set} sources={sources} />
      </FilterSheet>
    </div>
  )
}

const sheetSelect = 'h-11 w-full cursor-pointer border-b border-white/30 bg-coal pr-6 text-[16px] text-white focus:border-white'

/** Остальные фильтры: в «Ещё фильтры» на ноутбуке (белая панель) и в листе на телефоне (тёмный) */
function MoreFields({ filter, set, sources, light }: { filter: HrFilter; set: (p: Partial<HrFilter>) => void; sources: { id: string; label: string }[]; light?: boolean }) {
  const sel = light ? 'h-9 w-full cursor-pointer border-b border-night/30 bg-white text-[15px] text-night' : sheetSelect
  const reasons = filter.declineReasons ?? []
  const field = (label: string, control: ReactNode) => (
    <label className={`flex flex-col gap-1 ${light ? 'text-[13px] text-night/70' : 'text-[14px] text-white/65'}`}>
      {label}
      {control}
    </label>
  )
  const check = (label: string, checked: boolean, onChange: (v: boolean) => void) =>
    light ? (
      <CheckRow checked={checked} onChange={onChange}>
        {label}
      </CheckRow>
    ) : (
      <label className="flex min-h-11 cursor-pointer items-center gap-3 text-[16px]">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-5 accent-[var(--color-brand)]" />
        {label}
      </label>
    )
  const dateInput = light ? 'h-9 w-full border-b border-night/30 bg-transparent text-[15px] text-night' : `${sheetSelect} [color-scheme:dark]`
  const left = (
    <>
      {field(
        'Направление',
        <select value={filter.department ?? ''} onChange={(e) => set({ department: (e.target.value || undefined) as DepartmentId | undefined })} className={sel}>
          <option value="">любое</option>
          {departmentList.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>,
      )}
      {field(
        'Источник',
        <select value={filter.source ?? ''} onChange={(e) => set({ source: e.target.value || undefined })} className={sel}>
          <option value="">любой</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>,
      )}
      {field(
        'Задания на сайте',
        <select
          value={filter.tasks ?? ''}
          title="Метка «Задания N/4»: сколько из четырёх заданий на сайте или в боте пройдено. Кандидаты, которых добавили HR, сюда не входят"
          onChange={(e) => set({ tasks: (e.target.value || undefined) as TaskFilter | undefined })}
          className={sel}
        >
          <option value="">любые</option>
          {taskFilters.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label.replace('Задания: ', '')}
            </option>
          ))}
        </select>,
      )}
      {field(
        'Ждут ответа',
        <select value={filter.waitingHours === undefined ? '' : String(filter.waitingHours)} onChange={(e) => set({ waitingHours: e.target.value === '' ? undefined : Number(e.target.value) })} className={sel}>
          <option value="">любое время</option>
          {[4, 24, 48, 72].map((h) => (
            <option key={h} value={h}>
              дольше {waitingLabel(h)}
            </option>
          ))}
        </select>,
      )}
      {field(
        'Когда может выйти',
        <select value={filter.startReady ?? ''} onChange={(e) => set({ startReady: (e.target.value || undefined) as HrFilter['startReady'] })} className={sel}>
          <option value="">когда угодно</option>
          {startReadyOptions.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
          <option value="none">не указано</option>
        </select>,
      )}
      <div className="grid grid-cols-2 gap-3">
        {field(
          'Пришли с',
          <>
            <input type="date" value={filter.from ?? ''} max={filter.to} onChange={(e) => set({ from: e.target.value || undefined })} className={dateInput} />
            {filter.from && <span className={light ? 'text-[13px] text-night/70' : 'text-[13px] text-white/60'}>{ruDay(filter.from)}</span>}
          </>,
        )}
        {field(
          'по',
          <>
            <input type="date" value={filter.to ?? ''} min={filter.from} onChange={(e) => set({ to: e.target.value || undefined })} className={dateInput} />
            {filter.to && <span className={light ? 'text-[13px] text-night/70' : 'text-[13px] text-white/60'}>{ruDay(filter.to)}</span>}
          </>,
        )}
      </div>
    </>
  )
  const right = (
    <>
      {field(
        'Гражданство',
        <select value={filter.citizenship ?? ''} onChange={(e) => set({ citizenship: (e.target.value || undefined) as HrFilter['citizenship'] })} className={sel}>
          <option value="">любое</option>
          {citizenshipOptions.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
          <option value="none">не указано</option>
        </select>,
      )}
      {field(
        'Медкнижка',
        <select value={filter.medBook ?? ''} onChange={(e) => set({ medBook: (e.target.value || undefined) as HrFilter['medBook'] })} className={sel}>
          <option value="">неважно</option>
          {medBookOptions.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
          <option value="none">не указано</option>
        </select>,
      )}
      {field(
        'Смены',
        <select value={filter.shifts ?? ''} onChange={(e) => set({ shifts: (e.target.value || undefined) as HrFilter['shifts'] })} className={sel}>
          <option value="">любые</option>
          {shiftOptions.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
          <option value="none">не указано</option>
        </select>,
      )}
      {field(
        '18 лет',
        <select value={filter.adult === undefined ? '' : filter.adult ? '1' : '0'} onChange={(e) => set({ adult: e.target.value === '' ? undefined : e.target.value === '1' })} className={sel}>
          <option value="">неважно</option>
          <option value="1">есть, по дате рождения или отметке</option>
          <option value="0">нет или не указано</option>
        </select>,
      )}
      {field(
        'Формат',
        <select value={filter.format ?? ''} onChange={(e) => set({ format: (e.target.value || undefined) as VacancyFormat | undefined })} className={sel}>
          <option value="">любой</option>
          {vacancyFormats.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>,
      )}
      <div className="flex flex-col">
        {check('Практика от вуза', Boolean(filter.practice), (v) => set({ practice: v || undefined }))}
        {check('Хочет остаться после сезона', Boolean(filter.stay), (v) => set({ stay: v || undefined }))}
        {check('Идут вдвоём: по приглашению', Boolean(filter.pair), (v) => set({ pair: v || undefined }))}
        {check('Есть дубли по телефону', Boolean(filter.duplicates), (v) => set({ duplicates: v || undefined }))}
      </div>
    </>
  )
  return (
    <>
      <div className="flex flex-col gap-3">{left}</div>
      <div className="flex flex-col gap-3">{right}</div>
      <fieldset className={light ? 'col-span-2 border-t border-night/10 pt-2' : 'flex flex-col'}>
        <legend className={light ? 'px-1 pb-1 text-[13px] text-night/70' : 'mb-2 font-display text-[15px] font-extrabold tracking-[0.06em] text-white/60 uppercase'}>Причина отказа (любая из отмеченных)</legend>
        <div className={light ? 'grid grid-cols-2' : 'flex flex-col'}>
          {declineReasons.map((r) => (
            <span key={r.id}>{check(r.label, reasons.includes(r.id), (v) => set({ declineReasons: v ? [...reasons, r.id] : reasons.filter((x) => x !== r.id) }))}</span>
          ))}
        </div>
      </fieldset>
    </>
  )
}

/** Лист фильтров на телефоне: во весь экран, поля во всю ширину, внизу — «Показать N» */
function FilterSheet({ open, onClose, found, onReset, children }: { open: boolean; onClose: () => void; found: number; onReset?: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null)
  useFocusTrap(panel, open, onClose)
  useEffect(() => {
    if (open) panel.current?.focus()
  }, [open])
  if (!open) return null
  return (
    <div ref={panel} role="dialog" aria-modal="true" aria-label="Фильтры" tabIndex={-1} className="fixed inset-0 z-[80] flex flex-col bg-coal text-white outline-none lg:hidden">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <h2 className="font-display text-[26px] leading-none font-black uppercase">Фильтры</h2>
        <button type="button" onClick={onClose} className="-mr-2 grid size-11 place-items-center text-white/70 hover:text-white" aria-label="Закрыть фильтры">
          <svg viewBox="0 0 14 14" className="size-4" aria-hidden="true">
            <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.8" />
          </svg>
        </button>
      </div>
      <div className="flex flex-1 flex-col gap-6 overflow-y-auto overscroll-contain px-4 py-5">{children}</div>
      <div className="flex items-center gap-4 border-t border-white/10 px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))]">
        {onReset && (
          <button type="button" onClick={onReset} className={`${hrBtn.text} shrink-0`}>
            Сбросить
          </button>
        )}
        <button type="button" onClick={onClose} className={`${hrBtn.red} flex-1`}>
          Показать {found}
        </button>
      </div>
    </div>
  )
}

function SheetGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-display text-[15px] font-extrabold tracking-[0.06em] text-white/60 uppercase">{title}</h3>
      {children}
    </section>
  )
}

type Chip = { key: string; label: string; remove: (f: HrFilter, base: HrFilter) => HrFilter }

/**
 * Чипы выбранных фильтров — всё, что отбор добавил к виду. Крестик возвращает условие к виду:
 * у «В работе» снятый статус снова «В работе», а не «все»
 */
export function activeChips(filter: HrFilter, base: HrFilter, ctx: { staff: Staff[]; sources: { id: string; label: string }[] }): Chip[] {
  const mine = filterToParams(filter)
  const theirs = filterToParams(base)
  const differs = (key: string) => mine.has(key) && mine.get(key) !== theirs.get(key)
  const back =
    (...fields: (keyof HrFilter)[]) =>
    (f: HrFilter, b: HrFilter) => {
      const next = { ...f }
      for (const k of fields) (next as Record<string, unknown>)[k] = b[k]
      return next
    }
  const out: Chip[] = []
  const add = (param: string, label: string, ...fields: (keyof HrFilter)[]) => differs(param) && out.push({ key: param, label, remove: back(...fields) })
  const opt = <T extends string>(list: { id: T; label: string }[], v: string | undefined) => (v === 'none' ? 'не указано' : (list.find((o) => o.id === v)?.label ?? v ?? '').toLowerCase())

  add('status', `Статус: ${(filter.statuses ?? []).map((s) => statusLabel(s).toLowerCase()).join(', ')}`, 'statuses')
  add('vacancy', `Вакансия: ${vacancies.find((v) => v.id === filter.vacancy)?.title ?? filter.vacancy}`, 'vacancy')
  add('months', `Месяцы: ${(filter.months ?? []).map((m) => monthNames[m] ?? m).join(', ')}`, 'months')
  const who = filter.assignee === 'me' ? 'мои заявки' : filter.assignee === 'none' ? 'без ответственного' : (ctx.staff.find((s) => s.id === filter.assignee)?.name ?? 'сотрудник')
  add('assignee', `Ведёт: ${who}`, 'assignee')
  add('dept', `Направление: ${departmentList.find((d) => d.id === filter.department)?.name ?? ''}`, 'department')
  add('source', `Источник: ${filter.source === 'friends' ? 'приглашения друзей' : filter.source === 'direct' ? 'прямой заход' : (ctx.sources.find((s) => s.id === filter.source)?.label ?? sourceName(filter.source ?? ''))}`, 'source')
  add('tasks', `Задания на сайте: ${(taskFilters.find((t) => t.id === filter.tasks)?.label ?? '').replace('Задания: ', '')}`, 'tasks')
  add('waiting', `Ждут ответа дольше ${waitingLabel(filter.waitingHours ?? 0)}`, 'waitingHours')
  add('callback', 'Перезвонить сегодня', 'callbackDue')
  add('unmarked', 'Итог собеседования не отмечен', 'unmarked')
  add('start', `Выход: ${opt(startReadyOptions, filter.startReady)}`, 'startReady')
  add('citizenship', `Гражданство: ${opt(citizenshipOptions, filter.citizenship)}`, 'citizenship')
  add('medbook', `Медкнижка: ${opt(medBookOptions, filter.medBook)}`, 'medBook')
  add('shifts', `Смены: ${opt(shiftOptions, filter.shifts)}`, 'shifts')
  add('adult', filter.adult ? '18 лет: есть' : '18 лет: нет или не указано', 'adult')
  add('format', `Формат: ${(filter.format ?? '').toLowerCase()}`, 'format')
  add('reasons', `Причина отказа: ${(filter.declineReasons ?? []).map((r) => declineReasons.find((x) => x.id === r)?.label.toLowerCase() ?? r).join(', ')}`, 'declineReasons')
  add('practice', 'Практика от вуза', 'practice')
  add('stay', 'Хочет остаться', 'stay')
  add('pair', 'Идут вдвоём', 'pair')
  add('dups', 'Есть дубли', 'duplicates')
  add('reserve', 'Резерв', 'reserve')
  add('hard', 'Тяжело на смене', 'hardShift')
  if (differs('from') || differs('to'))
    out.push({
      key: 'period',
      label: `Пришли${filter.from ? ` с ${ruDay(filter.from)}` : ''}${filter.to ? ` по ${ruDay(filter.to)}` : ''}`,
      remove: back('from', 'to'),
    })
  add('ids', `Выбранные: ${filter.ids?.length ?? 0}`, 'ids')
  return out
}
