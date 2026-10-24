import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { checkinReasonLabel, hardSignal } from '@shared/adaptation'
import { declineReasonLabel, erasedLabel, missingProfile, seasonOutcomes, type ApplicationStatus, type HrApplication } from '@shared/applications'
import {
  applyFilter,
  attendancePending,
  builtInViews,
  callable,
  callbackDue,
  defaultView,
  filterToParams,
  isEmptyFilter,
  inReserve,
  isFriendSource,
  paramsToFilter,
  slaBreached,
  sortApps,
  tasksDone,
  type HrFilter,
  type SortKey,
  type SortSpec,
} from '@shared/hrFilter'
import { AddCandidate } from './AddCandidate'
import { ImportDialog } from './ImportDialog'
import { createView, deleteView, exportApplications, getViews, type ExportFormat, type HrUser, type SavedView, type Staff } from '../../lib/api'
import { BulkBar } from './BulkBar'
import { saveBlob } from './download'
import { activeChips, FilterBar } from './FilterBar'
import type { CallControl } from './CandidateDrawer'
import { ago, caseFacts, formatDate, formatPhone, monthsRange, sourceName, vacancyTitle, when, channelName } from './hrUtils'
import { CheckRow, Popover } from './overlay'
import { useToast } from './toasts'
import { chip, Dash, Empty, hrBtn, pageTitle, StatusSelect } from './ui'

const exportLabels = {
  xlsx: 'Excel (.xlsx) с листом «Воронка»',
  csv: 'CSV для Excel',
  csv1c: 'CSV для 1С (Windows-1251)',
  json: 'JSON для интеграций',
} as const

/** Сколько строк рисовать за раз: остальные — по «Показать ещё». Счётчики и выделение — по всему отбору */
const PAGE = 100

type Props = {
  /** Импорт закончен — перечитать список */
  onImported: () => void
  apps: HrApplication[]
  /** Идёт обзвон — строка «вернуться к обзвону» над списком */
  call: CallControl | null
  /** Начать обзвон по заявкам в этом порядке */
  onStartCall: (ids: string[]) => void
  loaded: boolean
  me: HrUser
  staff: Staff[]
  onOpen: (id: string) => void
  onStatus: (app: HrApplication, status: ApplicationStatus) => void
  onChanged: (apps: HrApplication[]) => void
  readOnly?: boolean
}

type ViewItem = { id: string; name: string; filter: HrFilter; alert?: boolean; saved?: SavedView }

/** Условия отбора без порядка, поиска и выделенных строк — по ним вид узнаётся в адресе */
const conditions = (f: HrFilter) => filterToParams({ ...f, sort: undefined, q: undefined, ids: undefined })
/** Все условия вида есть в отборе с теми же значениями: отбор — это вид плюс уточнения */
const within = (view: HrFilter, f: HrFilter) => {
  const mine = conditions(f)
  return [...conditions(view)].every(([k, v]) => mine.get(k) === v)
}

/** Заявки: виды-очереди с числами, фильтры, таблица с быстрой сменой статуса и массовыми действиями */
export function Candidates({ apps, loaded, me, staff, onOpen, onStatus, onChanged, onImported, readOnly, call, onStartCall }: Props) {
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const filter = useMemo(() => paramsToFilter(params), [params])
  const [views, setViews] = useState<SavedView[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (readOnly) return
    getViews().then(setViews).catch(() => {})
  }, [readOnly])
  // Часы «ждёт N ч» и подсветка просрочки обновляются сами
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(t)
  }, [])

  const setFilter = useCallback(
    (f: HrFilter) => {
      const next = filterToParams(f)
      const card = params.get('card')
      if (card) next.set('card', card)
      setParams(next, { replace: true })
    },
    [params, setParams],
  )

  // Список открывается видом «В работе», если в адресе нет отбора. «Все» после этого остаётся «Все»: вид ставится один раз
  const landed = useRef(false)
  useEffect(() => {
    if (landed.current) return
    landed.current = true
    if (![...params.keys()].some((k) => k !== 'card')) setFilter(defaultView.filter)
  }, [params, setFilter])

  // Обезличенные заявки (по сроку хранения или по запросу) — не работа: в списке и очередях их нет, в воронке они считаются
  const rows = useMemo(() => sortApps(applyFilter(apps, filter, { meId: me.id, now }).filter((a) => !a.anonymizedAt), filter.sort, now), [apps, filter, me.id, now])
  const [shown, setShown] = useState(PAGE)
  const filterKey = filterToParams(filter).toString()
  // Другой отбор — снова первые 100 строк
  useEffect(() => setShown(PAGE), [filterKey])
  const visibleRows = rows.slice(0, shown)
  const sort = filter.sort ?? { key: 'date' as const, dir: 'desc' as const }
  /** Клик по заголовку: та же колонка — сменить направление, другая — разумное направление по умолчанию */
  const sortBy = (key: SortKey) =>
    setFilter({
      ...filter,
      sort: sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'date' || key === 'waiting' ? 'desc' : 'asc' },
    })
  const [dialog, setDialog] = useState<null | 'add' | 'import'>(null)
  const live = useMemo(() => apps.filter((a) => !a.duplicateOf && !a.anonymizedAt), [apps])

  // Виды-очереди с числом заявок в каждом: «Ждут ответа · 8». Подсвеченные (просрочка, сигнал) — только когда не пусто
  const allViews: ViewItem[] = useMemo(
    () => [...builtInViews, ...views.map((v) => ({ id: `v${v.id}`, name: v.name, filter: v.filter, saved: v }))],
    [views],
  )
  const counts = useMemo(() => new Map(allViews.map((v) => [v.id, applyFilter(live, v.filter, { meId: me.id, now }).length])), [allViews, live, me.id, now])
  // Вид, от которого идёт отбор: самый подробный из тех, чьи условия все есть в адресе
  const base = useMemo(
    () => [...allViews].sort((x, y) => [...conditions(y.filter).keys()].length - [...conditions(x.filter).keys()].length).find((v) => within(v.filter, filter)) ?? allViews.find((v) => v.id === 'all')!,
    [allViews, filter],
  )
  const extras = activeChips(filter, base.filter, { staff, sources: [] })

  // Выделение — только среди видимых строк
  useEffect(() => {
    const visible = new Set(rows.map((r) => r.id))
    setSelected((s) => {
      const next = new Set([...s].filter((id) => visible.has(id)))
      return next.size === s.size ? s : next
    })
  }, [rows])
  const toggle = (id: string) => setSelected((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])))
  // «Выбрать все найденные» — весь отбор, а не только нарисованные строки
  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.id))
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(rows.map((r) => r.id)))
  // Обзвон — по найденным, кому есть смысл звонить: новые, «Связались», «Не отвечает» и задачи «перезвонить». Порядок — как в списке
  const callList = useMemo(() => rows.filter((a) => callable(a, now)), [rows, now])

  const saveView = async () => {
    const name = window.prompt('Название вида, например «Июль, ночные смены»')?.trim()
    if (!name) return
    try {
      const view = await createView(name, filterToParams({ ...filter, ids: undefined }).toString())
      setViews((v) => [...v, view])
      toast({ text: `Вид «${view.name}» сохранён` })
    } catch (e) {
      toast({ text: 'Вид не сохранился', detail: (e as Error).message, tone: 'error' })
    }
  }

  const removeView = async (v: SavedView) => {
    await deleteView(v.id).catch(() => {})
    setViews((list) => list.filter((x) => x.id !== v.id))
  }

  const [extra, setExtra] = useState(false)
  const doExport = async (format: ExportFormat, close: () => void) => {
    close()
    try {
      const blob = await exportApplications(format, filterToParams(filter).toString(), extra ? ['quiz', 'game'] : [])
      saveBlob(blob, format === 'csv1c' ? 'Кандидаты для 1С.csv' : `Заявки.${format}`)
    } catch (e) {
      toast({ text: 'Выгрузка не получилась', detail: (e as Error).message.startsWith('HTTP') ? 'Проверь соединение и попробуй ещё раз' : (e as Error).message, tone: 'error' })
    }
  }
  const exportMenu = (close: () => void) => (
    <div className="flex w-64 flex-col gap-1">
      <p className="px-1 pb-1 text-[13px] text-night/70">
        {isEmptyFilter(filter) ? 'Все заявки' : 'Только отфильтрованные'}: {rows.length}
      </p>
      {(['xlsx', 'csv', 'csv1c', 'json'] as const).map((f) => (
        <button key={f} onClick={() => void doExport(f, close)} className="px-1 py-1.5 text-left text-[15px] hover:bg-night/5">
          {exportLabels[f]}
        </button>
      ))}
      <div className="mt-1 border-t border-night/10 pt-1">
        <CheckRow checked={extra} onChange={setExtra}>
          Счёт в игре и подбор работы
        </CheckRow>
      </div>
    </div>
  )

  const selectedApps = rows.filter((r) => selected.has(r.id))
  const callButton = !readOnly && (callList.length > 0 || call) && (
    <button
      onClick={() => (call ? call.onResume() : onStartCall(callList.map((a) => a.id)))}
      title="Новые, «Связались», «Не отвечает» и кому пора перезвонить, по очереди в карточке. Клавиши: Д (дозвонились), Н (не дозвонились), → (дальше)"
      className={hrBtn.smallRed}
    >
      {call ? 'Продолжить обзвон' : `Обзвон · ${callList.length}`}
    </button>
  )

  return (
    <section aria-labelledby="list-title">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <h1 id="list-title" className={`${pageTitle} mr-auto`}>
          Заявки
        </h1>
        {callButton}
        {!readOnly && (
          <div className="hidden items-center gap-5 lg:flex">
            <button onClick={() => setDialog('add')} className={hrBtn.smallGhost}>
              + Кандидат
            </button>
            <button onClick={() => setDialog('import')} className={hrBtn.text}>
              Импорт из файла
            </button>
          </div>
        )}
        <Popover label="Выгрузить" align="right" className="hidden lg:block">
          {exportMenu}
        </Popover>
        {/* Телефон: редкие действия — в «Ещё», чтобы список начинался выше */}
        <Popover label="Ещё" align="right" className="lg:hidden">
          {(close) => (
            <div className="flex w-64 flex-col gap-1">
              {!readOnly && (
                <>
                  <button onClick={() => (close(), setDialog('add'))} className="px-1 py-2 text-left text-[15px] hover:bg-night/5">
                    + Кандидат
                  </button>
                  <button onClick={() => (close(), setDialog('import'))} className="px-1 py-2 text-left text-[15px] hover:bg-night/5">
                    Импорт из файла
                  </button>
                </>
              )}
              <p className="mt-1 border-t border-night/10 px-1 pt-2 text-[13px] font-semibold text-night">Выгрузить</p>
              {exportMenu(close)}
            </div>
          )}
        </Popover>
      </div>

      {/* Виды — очередь работы с числами. На телефоне листаются вбок, справа — затухание */}
      <div className="relative mt-4 -mr-4 lg:mr-0">
        <div
          className="flex gap-1.5 overflow-x-auto pr-8 pb-1 [scrollbar-width:none] lg:flex-wrap lg:overflow-visible lg:pr-0"
          role="group"
          aria-label="Виды списка"
        >
          {allViews.map((v) => {
            const n = counts.get(v.id) ?? 0
            const active = base.id === v.id
            if (v.alert && !n && !active) return null
            const alert = v.alert && n > 0 && !active
            return (
              <span key={v.id} className="inline-flex shrink-0">
                <button
                  onClick={() => setFilter(v.filter)}
                  aria-pressed={active}
                  className={chip(active, { alert, compact: true })}
                >
                  {v.name}
                  <span className={`tabular-nums ${alert ? 'font-semibold' : 'opacity-70'}`}>· {n}</span>
                </button>
                {v.saved && (
                  <button
                    onClick={() => void removeView(v.saved!)}
                    aria-label={`Удалить вид «${v.name}»`}
                    className="-ml-px grid h-9 w-8 place-items-center text-white/60 ring-1 ring-white/25 ring-inset hover:text-white"
                  >
                    ×
                  </button>
                )}
              </span>
            )
          })}
          {!readOnly && extras.length > 0 && (
            <button onClick={() => void saveView()} className={`${chip(false, { compact: true })} shrink-0`}>
              + Сохранить вид
            </button>
          )}
        </div>
        <span className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-night lg:hidden" aria-hidden="true" />
      </div>

      <div className="mt-3">
        <FilterBar filter={filter} onChange={setFilter} apps={apps} staff={staff} base={base.filter} found={rows.length} sort={sort} />
      </div>

      {call && (
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 border-l-4 border-periwinkle bg-periwinkle/[0.08] px-4 py-2.5 text-[15px]" role="status">
          <span>
            Обзвон: {call.position} из {call.total} · дозвонились {call.reached}, недозвон {call.missed}
          </span>
          <button onClick={call.onResume} className={hrBtn.text}>
            Продолжить
          </button>
          <button onClick={call.onStop} className={hrBtn.text}>
            Закончить
          </button>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px] text-white/60">
        {!isEmptyFilter(filter) && <p role="status">Найдено: {rows.length} из {live.length}</p>}
        {!readOnly && rows.length > 0 && selected.size > 0 && (
          <button onClick={toggleAll} aria-pressed={allChecked} className="text-white/80 underline decoration-white/30 underline-offset-4 hover:text-white lg:hidden">
            {allChecked ? 'Снять выделение' : `Выбрать все найденные · ${rows.length}`}
          </button>
        )}
      </div>

      {/* Телефон и планшет: карточки */}
      <ul className="mt-2 flex flex-col border-t border-white/10 lg:hidden">
        {visibleRows.map((a) => {
          const late = slaBreached(a, now)
          const steps = nextSteps(a, now)
          const facts = factsLine(a, now)
          return (
            <li key={a.id} className={`flex gap-3 border-b border-white/10 py-3 ${late ? 'bg-brand/[0.07]' : ''}`}>
              {!readOnly && (
                <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggle(a.id)} aria-label={`Выбрать ${a.name}`} className="mt-1 size-5 shrink-0 accent-[var(--color-brand)]" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <button onClick={() => onOpen(a.id)} className={`min-w-0 text-left text-[16px] break-words ${a.status === 'declined' ? 'text-white/65' : 'font-medium'}`}>
                    {fullName(a)}
                  </button>
                  <span className={`shrink-0 text-[13px] tabular-nums ${late ? 'font-semibold text-brand-bright' : 'text-white/60'}`}>
                    {a.status === 'new' ? `ждёт ${ago(a.createdAt, now)}` : formatDate(a.createdAt).split(',')[0]}
                  </span>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <StatusSelect value={a.status} onChange={(s) => onStatus(a, s)} label={`Статус: ${a.name}`} disabled={readOnly || Boolean(a.anonymizedAt)} />
                  {a.phone ? (
                    <a href={`tel:${a.phone.replace(/[^+\d]/g, '')}`} className="text-[15px] tabular-nums text-white/85 underline decoration-white/25 underline-offset-4">
                      {formatPhone(a.phone)}
                    </a>
                  ) : (
                    <span className="text-[14px] break-words text-white/60">{a.contact || 'нет телефона'}</span>
                  )}
                </div>
                <p className="mt-1.5 text-[14px] break-words text-white/70">
                  {vacancyTitle(a.vacancyId)} · {monthsRange(a.months)}
                </p>
                {facts.length > 0 && <FactsText a={a} facts={facts} className="mt-0.5 text-[13px] break-words" />}
                {steps.main && <StepsText steps={steps} className="mt-1 text-[14px]" />}
              </div>
            </li>
          )
        })}
      </ul>

      {/* Ноутбук: таблица, строка — две линии */}
      <div className="mt-2 hidden lg:block">
        <table className="w-full table-fixed border-collapse text-left text-[14px]">
          <thead className="sticky top-[101px] z-10 bg-night xl:top-14">
            <tr className="border-b border-white/30 text-[12px] tracking-[0.08em] text-white/60 uppercase">
              {!readOnly && (
                <th className="w-9 py-2.5">
                  <input
                    type="checkbox"
                    checked={allChecked}
                    onChange={toggleAll}
                    aria-label={`Выбрать все найденные: ${rows.length}`}
                    title={`Выбрать все найденные: ${rows.length}`}
                    className="size-4 accent-[var(--color-brand)]"
                  />
                </th>
              )}
              {/* Ширины — в шапке: скрытые на узком экране колонки («Ведёт», «Источник») не сдвигают остальные */}
              <SortHead label="Кандидат" k="name" sort={sort} onSort={sortBy} className="w-[25%] min-[1400px]:w-[23%]" />
              <SortHead label="Статус" k="status" sort={sort} onSort={sortBy} className="w-[156px]" />
              <SortHead label="Следующий шаг" k="interview" sort={sort} onSort={sortBy} title="Сортировать по времени собеседования" />
              <SortHead label="Вакансия" k="vacancy" sort={sort} onSort={sortBy} className="w-[13%]" />
              <th className="w-[148px] py-2.5 pr-3 font-semibold">Телефон</th>
              <th className="hidden w-[8%] py-2.5 pr-3 font-semibold xl:table-cell">Ведёт</th>
              <th className="hidden w-[8%] py-2.5 pr-3 font-semibold min-[1400px]:table-cell">Источник</th>
              <SortHead label="Пришла" k="date" sort={sort} onSort={sortBy} alt={{ key: 'waiting', label: 'ждёт' }} className="w-[128px]" />
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((a) => {
              const late = slaBreached(a, now)
              const dim = a.status === 'declined'
              const steps = nextSteps(a, now)
              const facts = factsLine(a, now)
              const f = caseFacts(a, now)
              const tasks = tasksDone(a)
              return (
                <tr
                  key={a.id}
                  onClick={() => onOpen(a.id)}
                  className={`cursor-pointer border-b border-white/10 align-top transition-colors hover:bg-white/[0.05] ${selected.has(a.id) ? 'bg-white/[0.06]' : late ? 'bg-brand/[0.07]' : ''}`}
                >
                  {!readOnly && (
                    <td className="py-2" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggle(a.id)} aria-label={`Выбрать ${a.name}`} className="mt-1 size-4 accent-[var(--color-brand)]" />
                    </td>
                  )}
                  <td className="py-2 pr-3">
                    <div className="flex min-w-0 items-baseline gap-2">
                      <button
                        onClick={(e) => (e.stopPropagation(), onOpen(a.id))}
                        title={fullName(a)}
                        className={`min-w-0 truncate text-left text-[15px] underline-offset-4 hover:underline ${dim ? 'text-white/65' : 'font-medium'}`}
                      >
                        {fullName(a)}
                      </button>
                      {f.age && !a.anonymizedAt && (
                        <span className={`shrink-0 text-[13px] whitespace-nowrap ${a.adult === false ? 'font-semibold text-brand-bright' : 'text-white/70'}`}>
                          {a.adult === false ? `${f.age}, нет 18` : f.age}
                        </span>
                      )}
                      {tasks > 0 && !a.anonymizedAt && <TasksMark n={tasks} />}
                    </div>
                    {facts.length > 0 ? <FactsText a={a} facts={facts} className="truncate text-[13px]" /> : <p className="text-[13px]"><Dash /></p>}
                  </td>
                  <td className="py-1.5 pr-3" onClick={(e) => e.stopPropagation()}>
                    <StatusSelect value={a.status} onChange={(s) => onStatus(a, s)} label={`Статус: ${a.name}`} disabled={readOnly || Boolean(a.anonymizedAt)} />
                  </td>
                  <td className="py-2 pr-3">{steps.main ? <StepsText steps={steps} oneLine /> : <Dash />}</td>
                  <td className="py-2 pr-3">
                    <p className="truncate" title={vacancyTitle(a.vacancyId)}>
                      {vacancyTitle(a.vacancyId)}
                    </p>
                    <p className="truncate text-[13px] text-white/60">{monthsRange(a.months)}</p>
                  </td>
                  <td className="py-2 pr-3" onClick={(e) => e.stopPropagation()}>
                    {a.phone ? (
                      <a href={`tel:${a.phone.replace(/[^+\d]/g, '')}`} className="whitespace-nowrap tabular-nums underline-offset-4 hover:underline">
                        {formatPhone(a.phone)}
                      </a>
                    ) : (
                      !a.contact && <Dash />
                    )}
                    {a.contact && (
                      <p className="truncate text-[13px] text-white/60" title={a.contact}>
                        {a.contact}
                      </p>
                    )}
                  </td>
                  <td className="hidden truncate py-2 pr-3 whitespace-nowrap text-white/75 xl:table-cell" title={a.assigneeName ?? undefined}>
                    {a.assigneeName ?? <Dash />}
                  </td>
                  <td className="hidden py-2 pr-3 min-[1400px]:table-cell">
                    <p className="truncate text-white/75" title={sourceName(a.source)}>
                      {sourceName(a.source)}
                    </p>
                    <p className="truncate text-[13px] text-white/60">{channelName(a.channel)}</p>
                  </td>
                  <td className="py-2 tabular-nums">
                    <p className="text-white/70">{formatDate(a.createdAt).split(',')[0]}</p>
                    <p className={`text-[13px] whitespace-nowrap ${late ? 'font-semibold text-brand-bright' : 'text-white/60'}`}>
                      {a.status === 'new' ? `ждёт ${ago(a.createdAt, now)}` : formatDate(a.createdAt).split(', ')[1]}
                    </p>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {rows.length > shown && (
        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2">
          <button onClick={() => setShown((n) => n + PAGE)} className={hrBtn.smallGhost}>
            Показать ещё {Math.min(PAGE, rows.length - shown)}
          </button>
          <p className="text-[13px] text-white/60">
            Показано {shown} из {rows.length}
          </p>
        </div>
      )}

      {loaded && !rows.length && (
        <Empty
          title={apps.length ? 'Никого не нашли' : 'Заявок пока нет'}
          action={
            !apps.length
              ? undefined
              : filter.q && Object.keys(filter).some((k) => k !== 'q' && k !== 'sort')
                ? { label: 'Искать во всех заявках', onClick: () => setFilter({ q: filter.q }) }
                : extras.length
                  ? { label: 'Сбросить фильтры', onClick: () => setFilter(base.filter) }
                  : base.id !== 'all'
                    ? { label: 'Показать все заявки', onClick: () => setFilter({}) }
                    : undefined
          }
        >
          {apps.length ? (filter.q ? 'По этому запросу в выбранном виде заявок нет.' : 'В этом виде сейчас пусто.') : 'Новые заявки с сайта и из ботов появятся здесь сами.'}
        </Empty>
      )}

      {/* Панель действий не размонтируется: результат (кому позвонить) остаётся, даже если строки ушли из фильтра */}
      {!readOnly && <BulkBar selected={selectedApps} apps={apps} staff={staff} reserveView={Boolean(filter.reserve)} onClear={() => setSelected(new Set())} onChanged={onChanged} />}
      {!readOnly && (
        <>
          <AddCandidate open={dialog === 'add'} onClose={() => setDialog(null)} onCreated={(a) => (onChanged([a]), onOpen(a.id))} onOpen={onOpen} />
          <ImportDialog open={dialog === 'import'} apps={apps} me={me} staff={staff} onClose={() => setDialog(null)} onImported={onImported} />
        </>
      )}
    </section>
  )
}

/** Имя для списка; у обезличенной заявки — пометка, почему имени нет */
const fullName = (a: HrApplication) => erasedLabel(a) ?? [a.lastName, a.name, a.middleName].filter(Boolean).join(' ')

/** «Задания 3/4» у имени: сколько из четырёх заданий на сайте или в боте пройдено */
function TasksMark({ n }: { n: number }) {
  return (
    <span className={`shrink-0 text-[13px] whitespace-nowrap tabular-nums ${n === 4 ? 'text-sage' : 'text-white/60'}`} title={`Пройдено заданий на сайте или в боте: ${n} из 4`}>
      Задания {n}/4
    </span>
  )
}

/**
 * Вторая строка под именем: учёба, когда может выйти и пометки (по приглашению, с другом, практика, резерв).
 * В строке не помещается — обрезается, целиком — во всплывающей подсказке
 */
function factsLine(a: HrApplication, now: number) {
  if (a.anonymizedAt) return []
  const f = caseFacts(a, now)
  const tags = [
    isFriendSource(a.source) ? 'по приглашению' : '',
    a.friend ? 'с другом' : '',
    a.practiceSchool ? 'практика от вуза' : '',
    a.wantsToStay ? 'хочет остаться' : '',
    a.reserve || (inReserve(a) && a.status === 'declined') ? 'резерв' : '',
  ].filter(Boolean)
  return [f.study, f.start, ...tags].filter(Boolean)
}

function FactsText({ a, facts, className = '' }: { a: HrApplication; facts: string[]; className?: string }) {
  return (
    <p className={`text-white/60 ${className}`} title={facts.join(' · ')}>
      {facts.map((t, i) => (
        <span key={t} className={a.practiceSchool && t === 'практика от вуза' ? 'text-white/80' : undefined}>
          {i > 0 ? ' · ' : ''}
          {t}
        </span>
      ))}
    </p>
  )
}

type Tone = 'alert' | 'warn' | 'normal' | 'muted'
type Step = { text: string; tone: Tone }
const toneClass: Record<Tone, string> = { alert: 'font-semibold text-brand-bright', warn: 'text-periwinkle', normal: 'text-white', muted: 'text-white/60' }

/**
 * Следующий шаг по заявке и задачи к нему. Главное — по статусу: связаться, собеседование, перезвонить, первая смена.
 * Задачи — то, что мешает следующему шагу: дубль, нет согласия, не хватает анкеты, документы по практике
 */
function nextSteps(a: HrApplication, now: number): { main: Step | null; todo: Step[] } {
  if (a.anonymizedAt) return { main: null, todo: [] }
  let main: Step
  const hard = hardSignal(a)
  if (hard) main = { text: `Тяжело на смене${hard.reason ? `: ${checkinReasonLabel(hard.reason).toLowerCase()}` : ''}`, tone: 'alert' }
  else if (a.status === 'interview' && a.interview) {
    const past = new Date(a.interview.startsAt).getTime() < now
    if (attendancePending(a, now)) main = { text: `Собеседование ${when(a.interview.startsAt, now)} · итог не отмечен`, tone: 'alert' }
    else main = { text: `Собеседование ${when(a.interview.startsAt, now)}${a.interview.attended === 'yes' ? ' · явка' : ''}`, tone: past ? 'muted' : 'warn' }
  } else if (a.callbackAt && !['declined', 'started'].includes(a.status)) {
    const overdue = new Date(a.callbackAt).getTime() < now
    main = { text: `Перезвонить ${when(a.callbackAt, now)}${a.noAnswerCount ? ` · недозвонов ${a.noAnswerCount}` : ''}`, tone: overdue ? 'alert' : callbackDue(a, now) ? 'normal' : 'muted' }
  } else if (a.status === 'new') main = { text: 'Связаться', tone: slaBreached(a, now) ? 'alert' : 'muted' }
  else if (a.status === 'no_answer') main = { text: a.noAnswerCount ? `Позвонить ещё · недозвонов ${a.noAnswerCount}` : 'Позвонить ещё', tone: 'normal' }
  else if (a.status === 'contacted') main = { text: 'Пригласить на собеседование', tone: 'muted' }
  else if (a.status === 'interview') main = { text: 'Назначить время собеседования', tone: 'warn' }
  else if (a.status === 'hired') main = a.firstShiftAt ? { text: `Первая смена ${when(a.firstShiftAt, now)}`, tone: 'muted' } : { text: 'Назначить первую смену', tone: 'warn' }
  else if (a.status === 'started')
    main = a.seasonOutcome ? { text: seasonOutcomes.find((o) => o.id === a.seasonOutcome)?.label ?? 'Итог сезона отмечен', tone: 'muted' } : { text: 'На смене · итог сезона не отмечен', tone: 'muted' }
  else main = { text: a.declineReason ? `Отказ: ${declineReasonLabel(a.declineReason).toLowerCase()}` : 'Отказ', tone: 'muted' }

  const todo: Step[] = []
  if (a.duplicates) todo.push({ text: a.duplicates === 1 ? 'склеить дубль' : `склеить дубли: ${a.duplicates}`, tone: 'warn' })
  if (a.consentSource === 'none') todo.push({ text: 'получить согласие', tone: 'warn' })
  const missing = missingProfile(a)
  if (missing.length && ['interview', 'hired'].includes(a.status)) todo.push({ text: `анкета: не хватает ${missing.length}`, tone: 'warn' })
  if (['hired', 'started'].includes(a.status) && a.practiceDocs.length > 0 && a.practiceDocs.length < 4) todo.push({ text: `документы: ${a.practiceDocs.length} из 4`, tone: 'muted' })
  return { main, todo }
}

/** Шаг и задачи. oneLine — в таблице: шаг в первой строке, задачи во второй, длинное обрезается */
function StepsText({ steps, className = '', oneLine }: { steps: { main: Step | null; todo: Step[] }; className?: string; oneLine?: boolean }) {
  if (!steps.main) return null
  const all = [steps.main, ...steps.todo].map((s) => s.text).join(' · ')
  if (!oneLine)
    return (
      <p className={`break-words ${className}`}>
        <span className={toneClass[steps.main.tone]}>{steps.main.text}</span>
        {steps.todo.map((t) => (
          <span key={t.text} className={toneClass[t.tone]}>
            {' · '}
            {t.text}
          </span>
        ))}
      </p>
    )
  return (
    <div className={className} title={all}>
      <p className={`truncate ${toneClass[steps.main.tone]}`}>{steps.main.text}</p>
      {steps.todo.length > 0 && (
        <p className="truncate text-[13px]">
          {steps.todo.map((t, i) => (
            <span key={t.text} className={toneClass[t.tone]}>
              {i > 0 ? ' · ' : ''}
              {t.text}
            </span>
          ))}
        </p>
      )}
    </div>
  )
}

/** Заголовок колонки с сортировкой. alt — вторая сортировка той же колонки («ждёт» у даты) */
function SortHead({
  label,
  k,
  sort,
  onSort,
  title,
  alt,
  className = '',
}: {
  label: string
  k: SortKey
  sort: SortSpec
  onSort: (k: SortKey) => void
  title?: string
  alt?: { key: SortKey; label: string }
  className?: string
}) {
  const active = sort.key === k || (alt && sort.key === alt.key)
  const arrow = sort.dir === 'asc' ? '↑' : '↓'
  return (
    <th className={`py-2.5 pr-3 font-semibold ${className}`} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <span className="inline-flex items-center gap-2 whitespace-nowrap">
        <button onClick={() => onSort(k)} title={title} className={`inline-flex items-center gap-1 uppercase hover:text-white ${sort.key === k ? 'text-white' : ''}`}>
          {label}
          {sort.key === k && <span className="text-brand-bright" aria-hidden="true">{arrow}</span>}
        </button>
        {alt && (
          <button onClick={() => onSort(alt.key)} className={`inline-flex items-center gap-1 normal-case hover:text-white ${sort.key === alt.key ? 'text-white' : ''}`}>
            {alt.label}
            {sort.key === alt.key && <span className="text-brand-bright" aria-hidden="true">{arrow}</span>}
          </button>
        )}
      </span>
    </th>
  )
}
