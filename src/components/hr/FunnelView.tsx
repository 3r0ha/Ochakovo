import { motion } from 'motion/react'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { adaptationStats } from '@shared/adaptation'
import type { HrApplication } from '@shared/applications'
import { declineReasons, statusLabel } from '@shared/applications'
import { companyBaseline, describeSource, isAnyReferral, legacyReferralSources, taskBuckets, taskLabels, weekLabel } from '@shared/hr'
import {
  getFunnel,
  type FunnelReport,
  type FunnelRow,
  type InviteRow,
  type ReasonCount,
  type TaskLeadRow,
  type TasksHiringRow,
  type WeekRow,
} from '../../lib/hr/insights'
import { PlanView } from './PlanView'
import { chip, Empty, hrBtn, Notice, pageTitle } from './ui'
import { currentSourceNames } from './sourcesCache'

const ease = [0.16, 1, 0.3, 1] as const

type CountKey = 'visitors' | 'tasks' | 'applications' | 'interview' | 'hired' | 'started' | 'completed' | 'stayed'

/** Этапы воронки. base — от чего процент: по умолчанию от предыдущего этапа, итог сезона — от вышедших на смену */
/** Этапы воронки. base — от чего процент: по умолчанию от предыдущего этапа, итог сезона — от вышедших на смену. short — подпись в таблице */
const steps: { key: CountKey; label: string; short: string; hint: string; base?: CountKey }[] = [
  { key: 'visitors', label: 'Пришли', short: 'Пришли', hint: 'Уникальные посетители сайта и новые пользователи ботов' },
  { key: 'tasks', label: 'Прошли задание', short: 'Задание', hint: 'Хотя бы одно из четырёх заданий на сайте или в боте' },
  { key: 'applications', label: 'Заявка', short: 'Заявки', hint: 'Отправили заявку' },
  { key: 'interview', label: 'Собеседование', short: 'Собеседование', hint: 'Дошли до собеседования' },
  { key: 'hired', label: 'Приняты', short: 'Приняты', hint: 'Решили взять' },
  { key: 'started', label: 'Вышли на смену', short: 'Вышли', hint: 'Отработали первую смену' },
  { key: 'completed', label: 'Отработали сезон', short: 'Отработали', hint: 'Итог сезона «Сезон отработан» в карточке. Процент считается от вышедших на смену', base: 'started' },
  { key: 'stayed', label: 'В штате или резерве', short: 'Штат и резерв', hint: 'Отметка «Звать в штат / резерв» в карточке. Процент считается от вышедших на смену', base: 'started' },
]
/** Колонки итога сезона в таблице источников — по переключателю: в разгар набора они пустые */
const seasonKeys: CountKey[] = ['completed', 'stayed']

/** Дата для поля ввода — по Москве */
const isoDay = (d: Date) => new Date(d.getTime() + 3 * 3600e3).toISOString().slice(0, 10)
const daysAgo = (n: number) => isoDay(new Date(Date.now() - n * 864e5))

const presets = [
  { label: '7 дней', days: 7 },
  { label: '30 дней', days: 30 },
  { label: '90 дней', days: 90 },
]

const FRIENDS = 'friends'
const funnelKeys = ['visitors', 'tasks', 'applyOpen', 'applications', 'interview', 'hired', 'started'] as const
const extraKeys = ['completed', 'stayed', 'cost'] as const
const emptyRow = (source: string): FunnelRow => ({ source, visitors: 0, tasks: 0, applyOpen: 0, applications: 0, interview: 0, hired: 0, started: 0, completed: 0, stayed: 0 })
const addRow = (into: FunnelRow, r: FunnelRow) => {
  for (const k of funnelKeys) into[k] += r[k]
  for (const k of extraKeys) if (r[k] !== undefined) into[k] = (into[k] ?? 0) + r[k]!
}
const count = (r: FunnelRow, k: CountKey) => r[k] ?? 0

/** Строка расшифровки приглашений: filter — метка для списка заявок; null — строка собрана из нескольких меток */
type Child = FunnelRow & { label: string; filter: string | null }
type Group = FunnelRow & { label: string; unknown: boolean; children?: Child[] }

const pct = (a: number, b: number, digits = 0) => (!b ? '—' : !a ? '0%' : `${((a / b) * 100).toFixed(digits).replace('.', ',')}%`)
const share = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`)
/** Доля для сравнения с компанией: мелкие — с сотыми, как «0,02%» в кейсе */
const fineShare = (v: number) => `${(v * 100).toFixed(v < 0.01 ? 2 : v < 0.1 ? 1 : 0).replace('.', ',')}%`
/** 30 000 ₽ — с неразрывными пробелами */
const rub = (v: number) => `${Math.round(v).toLocaleString('ru-RU').replace(/\s/g, ' ')} ₽`
/** Рубли за заявку или выход на смену: «—», пока нет расхода или нет ни одной заявки или выхода */
const perUnit = (cost: number | undefined, n: number) => (cost && n ? rub(cost / n) : '—')

const hoursText = (h: number) => (h < 1 ? 'меньше часа' : h < 48 ? `${Math.round(h)} ч` : `${Math.round(h / 24)} дн`)

const reasonShort: Record<string, string> = {
  no_slots: 'нет мест',
  schedule: 'график',
  age: 'младше 18',
  documents: 'документы',
  no_show: 'неявка',
  no_show_shift: 'неявка на смену',
  candidate_refused: 'отказ кандидата',
  other: 'другое',
  '': 'без причины',
}

const th = 'py-2.5 pr-3 text-right align-bottom font-semibold'
/**
 * Первая колонка на телефоне не уезжает при прокрутке таблицы вбок. Полоска слева закрывает поле рамки прокрутки:
 * без неё у края экрана видны уехавшие ячейки (тень ячейки таблицы Chrome здесь не рисует). Фон — непрозрачный, в цвет строки
 */
const sticky = (bg = 'bg-night') =>
  `sticky left-0 z-10 w-[150px] min-w-[150px] ${bg} before:absolute before:inset-y-0 before:-left-4 before:w-4 before:bg-night md:static md:w-auto md:min-w-0 md:bg-transparent md:before:hidden`
const stickyCol = sticky()
/** Строки расшифровки приглашений и подсвеченной метки — тот же оттенок, что у строки, только без прозрачности */
const stickyChild = sticky('bg-[color-mix(in_srgb,var(--color-night),white_3%)]')
const stickyUnknown = sticky('bg-[color-mix(in_srgb,var(--color-night),var(--color-periwinkle)_7%)]')
const tableHead = 'border-b border-white/30 text-[12px] tracking-[0.06em] text-white/65 uppercase'
const sectionTitle = 'font-display text-[26px] leading-none font-black uppercase'
const note = 'mt-2 text-[13px] leading-snug text-white/65'

/** Приглашения друзей — одной группой: с кодом (по имени пригласившего) и старые метки без кода */
function friendsGroup(rows: FunnelRow[], referrers: Record<string, string>): Group | null {
  const friends = rows.filter((r) => isAnyReferral(r.source))
  if (!friends.length) return null
  const group: Group = { ...emptyRow(FRIENDS), label: 'Приглашения друзей', unknown: false, children: [] }
  const anonymous: Child[] = []
  const legacy: Child[] = []
  for (const r of friends) {
    addRow(group, r)
    if (legacyReferralSources.includes(r.source)) legacy.push({ ...r, label: '', filter: r.source })
    else {
      const name = referrers[r.source.slice('friend-'.length)]
      if (name) group.children!.push({ ...r, label: `От: ${name}`, filter: r.source })
      else anonymous.push({ ...r, label: '', filter: r.source })
    }
  }
  // Без имени и без кода — по одной строке: коды и старые метки сами по себе ничего не говорят
  const merge = (list: Child[], label: string): Child | null => {
    if (!list.length) return null
    const row: Child = { ...emptyRow(list[0].source), label, filter: list.length === 1 ? list[0].filter : null }
    for (const c of list) addRow(row, c)
    return row
  }
  for (const c of [merge(anonymous, 'Пригласивший без заявки'), merge(legacy, 'Без кода: старые ссылки')]) if (c) group.children!.push(c)
  group.children!.sort((a, b) => b.applications - a.applications || b.visitors - a.visitors)
  return group
}

/**
 * «Воронка»: этапы → источники и недели → скорость ответа и явка → причины отказов и ухода → план →
 * первые недели на смене → приглашения, задания и наём → сравнение с цифрами компании. Клик по источнику — его заявки
 */
export function FunnelView({ apps, onSource }: { apps: HrApplication[]; onSource: (source: string) => void }) {
  const [from, setFrom] = useState(daysAgo(29))
  const [to, setTo] = useState(isoDay(new Date()))
  const [data, setData] = useState<FunnelReport | null>(null)
  const [error, setError] = useState(false)
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'sources' | 'weeks'>('sources')
  const [season, setSeason] = useState(false)

  // Перезапрашиваем и при изменении заявок: смена статуса сразу видна в воронке
  useEffect(() => {
    let alive = true
    setError(false)
    getFunnel(from, to)
      .then((d) => alive && setData(d))
      .catch(() => alive && setError(true))
    return () => {
      alive = false
    }
  }, [from, to, apps])

  const { total, groups } = useMemo(() => {
    const rows = data?.rows ?? []
    const total = emptyRow('total')
    if (data?.costsKnown) total.cost = 0
    for (const r of rows) addRow(total, r)
    const groups: Group[] = rows
      .filter((r) => !isAnyReferral(r.source))
      .map((r) => {
        const d = describeSource(r.source, currentSourceNames())
        return { ...r, label: r.source === '' ? 'Прямой заход на сайт' : d.label, unknown: d.kind === 'unknown' }
      })
    const friends = friendsGroup(rows, data?.referrers ?? {})
    if (friends) groups.push(friends)
    groups.sort((a, b) => b.applications - a.applications || b.visitors - a.visitors || (b.cost ?? 0) - (a.cost ?? 0))
    return { total, groups }
  }, [data])

  const filterKey = (g: Group) => (g.source === '' ? 'direct' : g.source)
  const hasUnknown = groups.some((g) => g.unknown)
  const costs = Boolean(data?.costsKnown)
  const columns = steps.filter((s) => season || !seasonKeys.includes(s.key))

  /** Ячейки строки источника: этапы, итог сезона с долей от вышедших, конверсии и расход */
  const cells = (r: FunnelRow, pad: string) => (
    <>
      {columns.map((s) => {
        const v = count(r, s.key)
        return (
          <td key={s.key} className={`${pad} pr-3 text-right ${v ? '' : 'text-white/60'}`}>
            {v}
            {s.base && v > 0 && <span className="block text-[13px] text-white/65">{pct(v, count(r, s.base))}</span>}
          </td>
        )
      })}
      <td className={`${pad} pr-3 text-right text-white/75`}>{pct(r.applications, r.visitors)}</td>
      <td className={`${pad} ${costs ? 'pr-3' : ''} text-right ${r.started ? 'text-white' : 'text-white/60'}`}>{pct(r.started, r.visitors, 1)}</td>
      {costs && (
        <>
          <td className={`${pad} pr-3 text-right whitespace-nowrap ${r.cost ? '' : 'text-white/60'}`}>{r.cost ? rub(r.cost) : '—'}</td>
          <td className={`${pad} pr-3 text-right whitespace-nowrap ${r.cost && r.applications ? '' : 'text-white/60'}`}>{perUnit(r.cost, r.applications)}</td>
          <td className={`${pad} text-right whitespace-nowrap ${r.cost && r.started ? '' : 'text-white/60'}`}>{perUnit(r.cost, r.started)}</td>
        </>
      )}
    </>
  )
  const stickyHead = 'sticky top-0 z-20 bg-night'

  return (
    <section aria-labelledby="funnel-title">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 id="funnel-title" className={pageTitle}>
            Воронка
          </h1>
          <p className="mt-2 max-w-2xl text-[14px] leading-snug text-white/65">
            Посетители сайта считаются анонимно. Этап засчитан, если кандидат в&nbsp;нём побывал. Число под этапом и&nbsp;полоса показывают долю от&nbsp;предыдущего этапа,
            а&nbsp;у&nbsp;итога сезона долю от&nbsp;вышедших на&nbsp;смену.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {presets.map((p) => {
            const active = from === daysAgo(p.days - 1) && to === isoDay(new Date())
            return (
              <button key={p.days} onClick={() => (setFrom(daysAgo(p.days - 1)), setTo(isoDay(new Date())))} aria-pressed={active} className={chip(active)}>
                {p.label}
              </button>
            )
          })}
          <label className="flex items-center gap-2 text-[14px] text-white/65">
            с
            <input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} className="h-9 border-b border-white/30 bg-transparent text-white [color-scheme:dark] focus:border-white" />
          </label>
          <label className="flex items-center gap-2 text-[14px] text-white/65">
            по
            <input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} className="h-9 border-b border-white/30 bg-transparent text-white [color-scheme:dark] focus:border-white" />
          </label>
          <p className="w-full text-[13px] text-white/65 lg:text-right" aria-live="polite">
            Период: {ruPeriod(from, to)}
          </p>
        </div>
      </div>

      {error && (
        <div className="mt-6">
          <Notice tone="error">Воронка не загрузилась. Обнови страницу.</Notice>
        </div>
      )}

      <ol className="mt-6 grid grid-cols-2 gap-px bg-white/10 md:grid-cols-4 xl:grid-cols-8">
        {steps.map((s, i) => {
          const value = count(total, s.key)
          const base = s.base ? count(total, s.base) : i ? count(total, steps[i - 1].key) : 0
          // Полоса — та же доля, что подписана под числом: от предыдущего этапа (у итога сезона — от вышедших)
          const share = i === 0 ? (value ? 1 : 0) : base ? Math.min(1, value / base) : 0
          return (
            <li key={s.key} className={`px-4 py-4 ${s.base ? 'bg-[color-mix(in_srgb,var(--color-night),white_3%)]' : 'bg-night'}`} title={s.hint}>
              {/* Две строки под подпись — там, где в одном ряду есть длинная «В штате или резерве»: цифры стоят ровно */}
              <p className={`text-[12px] leading-tight tracking-[0.06em] text-white/65 uppercase ${s.base ? 'min-h-[2lh]' : 'md:min-h-[2lh]'}`}>{s.label}</p>
              <p className="mt-1.5 font-display text-[clamp(40px,3.6vw,56px)] leading-[0.85] font-black tabular-nums">{data ? value : '—'}</p>
              <p className="mt-1.5 min-h-4 text-[13px] text-white/65 tabular-nums">
                {!data ? '' : i === 0 ? 'за период' : `${pct(value, base, value && base && value / base < 0.1 ? 1 : 0)} ${s.base ? 'от вышедших' : 'от предыдущего'}`}
              </p>
              <div className="mt-2 h-[6px] bg-white/10">
                <motion.div initial={{ scaleX: 0 }} animate={{ scaleX: data ? share : 0 }} transition={{ duration: 0.8, delay: i * 0.05, ease }} className={`h-full origin-left ${i === 0 ? 'bg-white/40' : 'bg-brand'}`} />
              </div>
            </li>
          )
        })}
      </ol>

      <div className="mt-10 min-w-0">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Разрез воронки">
          <button onClick={() => setView('sources')} aria-pressed={view === 'sources'} className={chip(view === 'sources')}>
            По источникам
          </button>
          <button onClick={() => setView('weeks')} aria-pressed={view === 'weeks'} className={chip(view === 'weeks')}>
            По неделям
          </button>
          {view === 'sources' && (
            <button onClick={() => setSeason((v) => !v)} aria-pressed={season} className={`${chip(season)} sm:ml-auto`} title="Колонки «Отработали сезон» и «В штате или резерве»">
              Итог сезона
            </button>
          )}
        </div>

        {view === 'sources' ? (
          <>
            <h2 className={`${sectionTitle} sr-only`}>По источникам</h2>
            {/* min-w-0 у родителя: широкая таблица прокручивается внутри своей рамки, а не растягивает страницу. На ноутбуке шапка стоит на месте */}
            <div className="-mx-4 mt-3 overflow-x-auto px-4 md:mx-0 md:px-0 lg:max-h-[min(72vh,680px)] lg:overflow-y-auto" tabIndex={0} role="region" aria-label="Воронка по источникам, прокручивается по горизонтали">
              <table className={`w-full ${costs ? 'min-w-[1080px]' : season ? 'min-w-[960px]' : 'min-w-[820px]'} border-collapse text-left text-[14px] tabular-nums`}>
                <thead>
                  <tr className={tableHead}>
                    <th className="sticky top-0 left-0 z-30 w-[150px] min-w-[150px] bg-night py-2.5 pr-3 align-bottom font-semibold before:absolute before:inset-y-0 before:-left-4 before:w-4 before:bg-night md:w-auto md:min-w-0 md:before:hidden">
                      {/* На ноутбуке ширина под «Ярмарку Мосполитеха» в одну строку */}
                      <span className="block md:w-[190px]">Источник</span>
                    </th>
                    {columns.map((s) => (
                      <th key={s.key} className={`${th} ${stickyHead} whitespace-nowrap`} title={s.hint}>
                        {s.short}
                      </th>
                    ))}
                    <th className={`${th} ${stickyHead} whitespace-nowrap`} title="Доля пришедших, которые оставили заявку">
                      В заявку
                    </th>
                    <th className={`${costs ? th : 'py-2.5 text-right align-bottom font-semibold'} ${stickyHead} whitespace-nowrap`} title="Доля пришедших, которые вышли на смену">
                      В смену
                    </th>
                    {costs && (
                      <>
                        <th className={`${th} ${stickyHead} whitespace-nowrap`} title="Расход по метке за период из реестра меток">
                          Расход
                        </th>
                        <th className={`${th} ${stickyHead} whitespace-nowrap`} title="Рублей за одну заявку">
                          ₽ за заявку
                        </th>
                        <th className={`py-2.5 text-right align-bottom font-semibold ${stickyHead} whitespace-nowrap`} title="Рублей за один выход на смену">
                          ₽ за выход
                        </th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {groups.length > 1 && (
                    <tr className="border-b border-white/30 font-semibold">
                      <th scope="row" className={`${stickyCol} py-2.5 pr-3 pl-9 text-left font-semibold`}>
                        Итого
                      </th>
                      {cells(total, 'py-2.5')}
                    </tr>
                  )}
                  {groups.map((g) => (
                    <Fragment key={g.source}>
                      <tr className={`border-b border-white/10 hover:bg-white/[0.04] ${g.unknown ? 'bg-periwinkle/[0.07]' : ''}`}>
                        <td className={`${g.unknown ? stickyUnknown : stickyCol} py-2.5 pr-3`}>
                          <div className="flex items-center gap-3">
                            {g.children ? (
                              <button onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label="Показать пригласивших" className="grid size-6 shrink-0 place-items-center text-white/65 hover:text-white">
                                <span className={`inline-block transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true">
                                  ›
                                </span>
                              </button>
                            ) : (
                              <span className="w-6 shrink-0" aria-hidden="true" />
                            )}
                            {/* На телефоне пометка — под меткой: рядом узкая колонка ломала бы метку по дефису */}
                            <div className="flex min-w-0 flex-col items-start gap-0.5 md:flex-row md:items-center md:gap-3">
                              <button onClick={() => onSource(filterKey(g))} className="text-left underline-offset-4 hover:underline" title="Показать заявки из этого источника">
                                {g.unknown ? <span className="font-mono text-[13px] text-periwinkle">{g.label}</span> : g.label}
                                {g.children ? ` · ${g.children.length}` : ''}
                              </button>
                              {g.unknown && <span className="text-[12px] whitespace-nowrap text-periwinkle">метка без названия</span>}
                            </div>
                          </div>
                        </td>
                        {cells(g, 'py-2.5')}
                      </tr>
                      {g.children &&
                        open &&
                        g.children.map((c) => (
                          <tr key={`${c.label}:${c.source}`} className="border-b border-white/5 bg-white/[0.03] text-white/75">
                            <td className={`${stickyChild} py-2 pr-3 pl-9`}>
                              {c.filter ? (
                                <button onClick={() => onSource(c.filter!)} className="text-left underline-offset-4 hover:underline">
                                  {c.label}
                                </button>
                              ) : (
                                c.label
                              )}
                            </td>
                            {cells(c, 'py-2')}
                          </tr>
                        ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
              {data && !groups.length && <Empty title="За этот период пусто">Выбери период длиннее: например, «90 дней».</Empty>}
            </div>
            <p className="mt-3 max-w-3xl text-[13px] leading-snug text-white/65">
              Открыли форму заявки на&nbsp;сайте: {total.applyOpen}. Источник узнаём по&nbsp;метке в&nbsp;ссылке и&nbsp;QR: у&nbsp;каждой ярмарки, экскурсии и&nbsp;поста своя, их&nbsp;выдают
              в&nbsp;«Источниках».
              {hasUnknown && ' Подсвеченной метки нет в словаре источников, поэтому её название неизвестно. Дать название можно в «Источниках».'}
              {costs && ' Расход берётся из реестра меток за период. Прочерк в рублях за заявку и за выход значит, что расхода по метке нет или по ней пока никто не дошёл до этого шага.'}
            </p>
            <details className="mt-2 max-w-3xl text-[13px] text-white/65">
              <summary className="cursor-pointer underline decoration-white/30 underline-offset-4 hover:text-white">Для администратора: как устроена метка</summary>
              <p className="mt-1.5 leading-snug">
                Метка в ссылке на сайт: <code className="text-white/80">/?src=fair-mgupp</code>, в ссылке на бота: <code className="text-white/80">?start=fair-mgupp</code>. Метка
                сохраняется в заявке и в анонимных визитах.
              </p>
            </details>
          </>
        ) : (
          <WeeksTable data={data} />
        )}
      </div>

      <div className="mt-12 grid grid-cols-1 gap-x-10 gap-y-10 md:grid-cols-2">
        <div>
          <h2 className={sectionTitle}>Первый ответ</h2>
          <p className="mt-3 font-display text-[48px] leading-none font-black tabular-nums">{data?.firstResponseHours != null ? hoursText(data.firstResponseHours) : '—'}</p>
          <p className={`${note} max-w-md`}>
            Медиана времени, которое заявка ждёт первого действия HR. Цель: меньше суток.
            {data?.answered24h != null && ` В первые сутки ответили на ${share(data.answered24h)} заявок.`} Добавленных HR не считаем.
          </p>
        </div>
        <AttendanceBlock a={data?.attendance ?? null} />
      </div>

      <div className="mt-12 grid max-w-5xl grid-cols-1 gap-x-10 gap-y-10 md:grid-cols-2">
        <Reasons title="Почему отказ" list={data?.declines ?? null} empty="Отказов за период нет." />
        <Reasons title="Почему ушли" subtitle="до конца сезона" list={data?.leaves ?? null} empty="До конца сезона за период никто не ушёл." />
      </div>

      <PlanView apps={apps} />

      <AdaptationBlock apps={apps} from={from} to={to} />

      {data && <Invites list={data.invites ?? []} game={data.game ?? null} onSource={onSource} />}

      {data?.tasks && <TasksHiring rows={data.tasks.rows} fullShare={data.tasks.fullShare} target={data.tasks.target} leads={data.tasks.leads} />}

      {data?.caseMetrics && <CaseMetricsBlock m={data.caseMetrics} />}
    </section>
  )
}

/** Период словами под полями дат: браузер с английским языком показывает поле даты в американском порядке */
const ruPeriod = (from: string, to: string) => {
  const f = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' })
  return `${f(from)} – ${f(to)}`
}

/** Цифры кейса по данным панели рядом с цифрами компании: конверсия в найм, отсев, средний возраст принятых */
function CaseMetricsBlock({ m }: { m: FunnelReport['caseMetrics'] }) {
  const b = companyBaseline
  const items = [
    {
      id: 'hire',
      title: 'Конверсия в найм',
      ours: m.hireRate === null ? '—' : fineShare(m.hireRate),
      theirs: fineShare(b.hireRate),
      theirsNote: 'по данным компании',
      text:
        m.hireRate === null
          ? 'За период никто не пришёл, считать не из чего.'
          : `Приняты ${m.hired} из ${m.visitors} пришедших на сайт и в боты. В кейсе не сказано, от чего считала компания, поэтому сравнение ориентировочное.`,
    },
    {
      id: 'dropout',
      title: 'Ушли до конца сезона',
      ours: m.dropout === null ? '—' : fineShare(m.dropout),
      theirs: fineShare(b.probationDropout),
      theirsNote: 'по данным компании: отсев на испытательном сроке',
      text:
        m.dropout === null
          ? 'Итог сезона за период ещё ни у кого не отмечен. Его ставят в карточке «На смене».'
          : `Ушли ${m.left} из ${m.left + m.completed}, у кого отмечен итог сезона. У студентов испытательного срока нет, вместо него практика.`,
    },
    {
      id: 'age',
      title: 'Средний возраст принятых',
      ours: m.averageAge === null ? '—' : String(m.averageAge).replace('.', ','),
      theirs: String(b.averageAge),
      theirsNote: `по данным компании: все сотрудники, год назад ${b.averageAgeYearAgo}`,
      text: m.averageAge === null ? 'У принятых за период нет даты рождения в анкете.' : `По ${m.withAge} ${m.withAge % 10 === 1 && m.withAge % 100 !== 11 ? 'анкете' : 'анкетам'} принятых с датой рождения.`,
    },
  ]
  return (
    <section aria-labelledby="case-title" className="mt-12">
      <h2 id="case-title" className={sectionTitle}>
        Сравнение с&nbsp;цифрами компании
      </h2>
      <p className={`${note} max-w-3xl`}>Цифры компании взяты из&nbsp;кейса «Очаково», раздел «Диагностика проблемы». Панель считает за&nbsp;выбранный период.</p>
      <ul className="mt-5 grid grid-cols-1 gap-px bg-white/10 md:grid-cols-3">
        {items.map((it) => (
          <li key={it.id} className="bg-night py-4 md:px-5 md:first:pl-0">
            <h3 className="text-[12px] tracking-[0.06em] text-white/60 uppercase">{it.title}</h3>
            <dl className="mt-2 flex flex-wrap items-end gap-x-8 gap-y-2">
              <div>
                <dt className="sr-only">По данным панели</dt>
                <dd className="font-display text-[48px] leading-[0.85] font-black tabular-nums">{it.ours}</dd>
                <dd className="mt-1.5 text-[13px] text-white/65">по данным панели</dd>
              </div>
              <div>
                <dt className="sr-only">По данным компании</dt>
                <dd className="font-display text-[30px] leading-[0.85] font-black text-white/60 tabular-nums">{it.theirs}</dd>
                <dd className="mt-1.5 max-w-[200px] text-[13px] leading-tight text-white/65">{it.theirsNote}</dd>
              </div>
            </dl>
            <p className={`${note} max-w-sm`}>{it.text}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * «Первые недели на смене»: ответы новичков на «Как дела на смене» у заявок за период (shared/adaptation.ts).
 * Кейс: 38% отсеиваются на испытательном сроке — здесь видно, кому тяжело и связано ли это с уходом
 */
function AdaptationBlock({ apps, from, to }: { apps: HrApplication[]; from: string; to: string }) {
  const stats = useMemo(() => adaptationStats(apps.filter((a) => isoDay(new Date(a.createdAt)) >= from && isoDay(new Date(a.createdAt)) <= to)), [apps, from, to])
  const asked = stats.steps.reduce((n, s) => n + s.asked, 0)
  const outcome = (o: { left: number; total: number }) => (o.total ? `${pct(o.left, o.total)} (${o.left} из ${o.total})` : 'итог сезона ещё не отмечен')
  return (
    <section aria-labelledby="adapt-title" className="mt-12 max-w-3xl">
      <h2 id="adapt-title" className={sectionTitle}>
        Первые недели на&nbsp;смене
      </h2>
      <p className={`${note} max-w-3xl`}>
        Вопрос «Как дела на смене» новичкам после первой смены, через неделю и через месяц. Ответ «Тяжело» сразу ставит задачу перезвонить и поговорить, пока человек не ушёл.
      </p>
      {!asked ? (
        <p className={note}>За период никого не спрашивали. Вопросы начинаются после первой смены у «К оформлению» и «На смене».</p>
      ) : (
        <>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[520px] text-[14px] tabular-nums">
              <thead className="border-b border-white/30 text-left text-[12px] tracking-[0.06em] text-white/65 uppercase">
                <tr>
                  <th className="py-2 pr-3 font-normal">Когда</th>
                  <th className="py-2 pr-3 text-right font-normal">Ответили</th>
                  <th className="py-2 pr-3 text-right font-normal">Всё нормально</th>
                  <th className="py-2 pr-3 text-right font-normal">Есть вопрос</th>
                  <th className="py-2 text-right font-normal">Тяжело</th>
                </tr>
              </thead>
              <tbody>
                {stats.steps.map((s) => (
                  <tr key={s.id} className="border-t border-white/10">
                    <th scope="row" className="py-2 pr-3 text-left font-normal">
                      {s.label}
                    </th>
                    <td className="py-2 pr-3 text-right">
                      {s.answered} из {s.asked}
                    </td>
                    <td className="py-2 pr-3 text-right">{s.ok}</td>
                    <td className="py-2 pr-3 text-right">{s.question}</td>
                    <td className={`py-2 text-right ${s.hard ? 'font-semibold text-brand-bright' : ''}`}>{s.hard}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {stats.reasons.length > 0 && (
            <p className={`${note} max-w-3xl`}>Что тяжелее всего: {stats.reasons.map((r) => `${r.label.toLowerCase()} (${r.count})`).join(', ')}.</p>
          )}
          <dl className="mt-3 grid max-w-3xl gap-2 text-[14px] sm:grid-cols-2">
            <div>
              <dt className="text-white/60">Ушли до конца сезона после «Тяжело»</dt>
              <dd className="mt-0.5">{outcome(stats.afterHard)}</dd>
            </div>
            <div>
              <dt className="text-white/60">Ушли из остальных ответивших</dt>
              <dd className="mt-0.5">{outcome(stats.afterOk)}</dd>
            </div>
          </dl>
        </>
      )}
    </section>
  )
}

/** Явка на собеседование: доля пришедших среди прошедших собеседований с отметкой */
function AttendanceBlock({ a }: { a: FunnelReport['attendance'] | null }) {
  return (
    <div>
      <h2 className={sectionTitle}>Явка</h2>
      <p className="mt-3 font-display text-[48px] leading-none font-black tabular-nums">{a && a.marked ? pct(a.came, a.marked) : '—'}</p>
      <p className={note}>
        {!a
          ? 'Доля пришедших на собеседование.'
          : a.marked
            ? `Пришли ${a.came} из ${a.marked} прошедших собеседований с отметкой.`
            : 'Явку на прошедших собеседованиях за период ещё не отмечали.'}
        {a && a.unmarked > 0 && ` Без отметки осталось ${a.unmarked}, их отмечают в «Графике» или в карточке.`}
      </p>
    </div>
  )
}

function Reasons({ title, subtitle, list, empty }: { title: string; subtitle?: string; list: ReasonCount[] | null; empty: string }) {
  const total = list?.reduce((s, d) => s + d.count, 0) ?? 0
  return (
    <div>
      <h2 className={sectionTitle}>
        {title}
        {subtitle && <span className="mt-1 block font-sans text-[13px] font-normal tracking-normal text-white/60 normal-case">{subtitle}</span>}
      </h2>
      {list && !list.length && <p className="mt-3 text-[14px] text-white/60">{empty}</p>}
      <ul className="mt-3 border-t border-white/10">
        {list?.map((d) => (
          <li key={d.reason} className="flex items-baseline justify-between gap-4 border-b border-white/10 py-2 text-[14px]">
            <span className="text-white/80">{d.label}</span>
            <span className="tabular-nums whitespace-nowrap">
              {d.count} <span className="text-white/60">· {pct(d.count, total)}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

const INVITES_SHOWN = 8

const shareKinds: Record<string, string> = { game: 'игра', money: 'расчёт', invite: 'приглашение' }

/** Игра и «поделиться» на сайте: только когда за период есть такие события */
function GameShareStats({ g }: { g: NonNullable<FunnelReport['game']> }) {
  const by = Object.entries(g.sharedBy)
    .filter(([, n]) => n)
    .map(([k, n]) => `${shareKinds[k] ?? 'другое'} ${n}`)
    .join(' · ')
  const items = [
    { label: 'Нажали «Играть»', value: String(g.started), text: 'Посетители сайта, начавшие «Поймай брак»' },
    { label: 'Поделились', value: String(g.shared), text: by || 'Результатом, расчётом или приглашением' },
    { label: 'Пришли по ссылке → заявки', value: `${g.cameByLink} → ${g.applied}`, text: `По ссылке друга; оставили заявку ${pct(g.applied, g.cameByLink)}` },
  ]
  return (
    <div className="mt-8">
      <h3 className="font-display text-[22px] leading-none font-black uppercase">Игра и&nbsp;«поделиться»</h3>
      <p className={note}>Только сайт, по&nbsp;анонимным событиям за&nbsp;период.</p>
      <dl className="mt-4 grid grid-cols-1 gap-px bg-white/10 sm:grid-cols-3">
        {items.map((it) => (
          <div key={it.label} className="bg-night py-3 sm:px-5 sm:first:pl-0">
            <dt className="text-[12px] tracking-[0.06em] text-white/60 uppercase">{it.label}</dt>
            <dd className="mt-1.5 font-display text-[36px] leading-none font-black tabular-nums">{it.value}</dd>
            <dd className="mt-1.5 text-[13px] text-white/60">{it.text}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/** Приглашения, дошедшие до смены: кто позвал, кого и вышел ли приглашённый на смену. Ниже — игра и «поделиться» */
function Invites({ list, game, onSource }: { list: InviteRow[]; game: FunnelReport['game']; onSource: (source: string) => void }) {
  const [all, setAll] = useState(false)
  const started = list.filter((r) => r.started).length
  const shown = all ? list : list.slice(0, INVITES_SHOWN)
  const who = (r: InviteRow) => r.inviter || (r.source.startsWith('friend-') ? 'Пригласивший без заявки' : 'Старая ссылка без кода')
  return (
    <section aria-labelledby="invites-title" className="mt-12">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <h2 id="invites-title" className={sectionTitle}>
          Приглашения друзей
        </h2>
        {list.length > 0 && (
          <p className="text-[14px] text-white/70 tabular-nums">
            дошли до&nbsp;смены <span className="font-semibold text-white">{started}</span> из&nbsp;{list.length}
          </p>
        )}
      </div>
      <p className={`${note} max-w-3xl`}>Заявки периода, пришедшие по&nbsp;ссылке «Позвать друга». Сверху те, кто вышел на&nbsp;смену.</p>
      {!list.length ? (
        <p className="mt-3 text-[14px] text-white/60">За этот период по&nbsp;приглашениям заявок нет.</p>
      ) : (
        <>
          <ul className="mt-4 grid grid-cols-1 border-t border-white/10 lg:grid-cols-2 lg:gap-x-10">
            {shown.map((r) => (
              <li key={r.id} className="flex items-baseline justify-between gap-4 border-b border-white/10 py-2.5 text-[14px]">
                <span className="min-w-0">
                  <button onClick={() => onSource(r.source)} className="text-left text-white/70 underline-offset-4 hover:underline" title="Показать заявки по этому приглашению">
                    {who(r)}
                  </button>
                  <span className="text-white/60" aria-hidden="true">
                    {' '}
                    →{' '}
                  </span>
                  <span className="sr-only">, кого позвали: </span>
                  <span className="text-white">{r.invited}</span>
                </span>
                <span className={`shrink-0 text-right whitespace-nowrap ${r.started ? 'font-semibold text-leaf' : 'text-white/60'}`}>
                  {r.started ? 'на смене' : statusLabel(r.status).toLowerCase()}
                </span>
              </li>
            ))}
          </ul>
          {list.length > INVITES_SHOWN && (
            <button onClick={() => setAll((v) => !v)} className={`${hrBtn.small} mt-3 px-0 text-white/70 hover:text-white`} aria-expanded={all}>
              {all ? 'Свернуть' : `Показать всех · ${list.length}`}
            </button>
          )}
        </>
      )}
      {game && <GameShareStats g={game} />}
    </section>
  )
}

/** Отчёт по неделям: заявки недели и как далеко они дошли — сумма недель равна плиткам выше */
function WeeksTable({ data }: { data: FunnelReport | null }) {
  const weeks = data?.weeks ?? []
  const costs = Boolean(data?.costsKnown)
  const sum = (k: 'applications' | 'interview' | 'hired' | 'started' | 'declined' | 'completed' | 'stayed' | 'cost') => weeks.reduce((n, w) => n + (w[k] ?? 0), 0)
  const hasPlan = weeks.some((w) => w.planTarget !== null)
  const reasons = (d: Record<string, number>) =>
    [...declineReasons.map((r) => r.id as string), '']
      .filter((id) => d[id])
      .map((id) => `${reasonShort[id] ?? id} ${d[id]}`)
      .join(' · ')
  const planCell = (w: Pick<WeekRow, 'planTarget' | 'planDone'>) => (w.planTarget === null ? '—' : `${w.planDone ?? 0} из ${w.planTarget}`)
  const totalDeclines: Record<string, number> = {}
  for (const w of weeks) for (const [id, n] of Object.entries(w.declines)) totalDeclines[id] = (totalDeclines[id] ?? 0) + n

  const row = (key: string, label: string, w: Omit<WeekRow, 'start' | 'end'>, bold = false) => (
    <tr key={key} className={`border-b ${bold ? 'border-white/30 font-semibold' : 'border-white/10'}`}>
      <th scope="row" className={`${stickyCol} py-2.5 pr-3 text-left font-normal whitespace-nowrap`}>
        {bold ? <span className="font-semibold">{label}</span> : label}
      </th>
      <td className="py-2.5 pr-3 text-right">{w.applications}</td>
      <td className="py-2.5 pr-3 text-right">{w.firstResponseHours === null ? '—' : hoursText(w.firstResponseHours)}</td>
      <td className="py-2.5 pr-3 text-right">{share(w.answered24h)}</td>
      <td className="py-2.5 pr-3 text-right">{w.interview}</td>
      <td className="py-2.5 pr-3 text-right">{w.hired}</td>
      <td className="py-2.5 pr-3 text-right">{w.started}</td>
      <td className={`py-2.5 pr-3 text-right ${w.completed ? '' : 'text-white/60'}`}>{w.completed ?? 0}</td>
      <td className={`py-2.5 pr-3 text-right ${w.stayed ? '' : 'text-white/60'}`}>{w.stayed ?? 0}</td>
      <td className="py-2.5 pr-3 text-right">
        {w.declined}
        {w.declined > 0 && <span className="block text-[13px] font-normal whitespace-nowrap text-white/60">{reasons(w.declines)}</span>}
      </td>
      {costs && (
        <>
          <td className={`py-2.5 pr-3 text-right whitespace-nowrap ${w.cost ? '' : 'text-white/60'}`}>{w.cost ? rub(w.cost) : '—'}</td>
          <td className={`py-2.5 pr-3 text-right whitespace-nowrap ${w.cost && w.applications ? '' : 'text-white/60'}`}>{perUnit(w.cost ?? 0, w.applications)}</td>
          <td className={`py-2.5 pr-3 text-right whitespace-nowrap ${w.cost && w.started ? '' : 'text-white/60'}`}>{perUnit(w.cost ?? 0, w.started)}</td>
        </>
      )}
      <td className="py-2.5 text-right whitespace-nowrap">{planCell(w)}</td>
    </tr>
  )

  return (
    <>
      <h2 className={`${sectionTitle} sr-only`}>По неделям</h2>
      <div className="-mx-4 mt-3 overflow-x-auto px-4 md:mx-0 md:px-0" tabIndex={0} role="region" aria-label="Воронка по неделям, прокручивается по горизонтали">
        <table className={`w-full ${costs ? 'min-w-[1300px]' : 'min-w-[1040px]'} border-collapse text-left text-[14px] tabular-nums`}>
          <thead>
            <tr className={tableHead}>
              <th className={`${stickyCol} py-2.5 pr-3 align-bottom font-semibold`}>Неделя</th>
              <th className={th}>Заявки</th>
              <th className={th} title="Медиана: сколько заявка ждала первого действия HR">
                Первый ответ
              </th>
              <th className={th} title="Доля заявок, на которые ответили в первые 24 часа">
                За&nbsp;24&nbsp;ч
              </th>
              <th className={th}>Собеседование</th>
              <th className={th}>К оформлению</th>
              <th className={th}>На смене</th>
              <th className={th} title="Итог сезона «Сезон отработан»">
                Отработали сезон
              </th>
              <th className={th} title="Отметка «Звать в штат / резерв»">
                В штате или резерве
              </th>
              <th className={th}>Отказы</th>
              {costs && (
                <>
                  <th className={th} title="Расход по всем меткам реестра за неделю">
                    Расход
                  </th>
                  <th className={th}>₽ за заявку</th>
                  <th className={th}>₽ за выход на смену</th>
                </>
              )}
              <th className="py-2.5 text-right align-bottom font-semibold" title="Мест плана сезона закрыто к концу недели">
                План
              </th>
            </tr>
          </thead>
          <tbody>
            {[...weeks].reverse().map((w) => row(w.start, weekLabel(w.start, w.end), w))}
            {weeks.length > 0 &&
              row(
                'total',
                'Итого',
                {
                  applications: sum('applications'),
                  interview: sum('interview'),
                  hired: sum('hired'),
                  started: sum('started'),
                  declined: sum('declined'),
                  declines: totalDeclines,
                  firstResponseHours: data?.firstResponseHours ?? null,
                  answered24h: data?.answered24h ?? null,
                  planTarget: weeks.at(-1)!.planTarget,
                  planDone: weeks.at(-1)!.planDone,
                  completed: sum('completed'),
                  stayed: sum('stayed'),
                  cost: costs ? sum('cost') : null,
                },
                true,
              )}
          </tbody>
        </table>
        {data && !weeks.length && <Empty title="За этот период пусто">Выбери период длиннее: например, «90 дней».</Empty>}
      </div>
      <p className="mt-3 max-w-3xl text-[13px] leading-snug text-white/60">
        Заявки, этапы и&nbsp;итог сезона считаются по&nbsp;заявкам, пришедшим за&nbsp;неделю, поэтому сумма недель равна плиткам выше. План показывает, сколько мест плана сезона закрыто к&nbsp;концу недели.
        {!hasPlan && ' Плана на сезон пока нет, его задают ниже, в «Плане найма».'} Лист «Недели» с&nbsp;теми&nbsp;же цифрами есть в&nbsp;выгрузке Excel.
      </p>
    </>
  )
}

/** «Задания и наём»: доля заявок с «Заданиями 4/4» против цели, заявки по числу заданий и связь заданий с заявкой на сайте */
function TasksHiring({ rows, fullShare, target, leads }: { rows: TasksHiringRow[]; fullShare: number | null; target: number; leads: TaskLeadRow[] }) {
  const sum = (k: keyof Omit<TasksHiringRow, 'bucket'>) => rows.reduce((n, r) => n + r[k], 0)
  const reached = fullShare !== null && fullShare >= target
  const cells = (r: Omit<TasksHiringRow, 'bucket'>) => (
    <>
      <td className="py-2.5 pr-3 text-right">{r.applications}</td>
      <td className="py-2.5 pr-3 text-right">{r.interview}</td>
      <td className={`py-2.5 pr-3 text-right ${r.noShow ? '' : 'text-white/60'}`}>{r.noShow}</td>
      <td className="py-2.5 pr-3 text-right">{r.hired}</td>
      <td className="py-2.5 pr-3 text-right">{r.started}</td>
      <td className="py-2.5 text-right">{pct(r.started, r.applications)}</td>
    </>
  )
  const total = { applications: sum('applications'), interview: sum('interview'), noShow: sum('noShow'), hired: sum('hired'), started: sum('started') }
  const bestLead = Math.max(0, ...leads.map((l) => (l.visitors ? l.applied / l.visitors : 0)))

  return (
    <section aria-labelledby="tasks-title" className="mt-12 grid grid-cols-1 gap-10 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="min-w-0">
        <h2 id="tasks-title" className={sectionTitle}>
          Задания и наём
        </h2>
        <div className="mt-4 flex flex-wrap items-end gap-x-6 gap-y-2">
          <p className="font-display text-[48px] leading-none font-black tabular-nums">{share(fullShare)}</p>
          <p className="max-w-sm pb-1 text-[14px] leading-snug text-white/70">
            заявок с&nbsp;отметкой «Задания 4/4» (все четыре задания пройдены на&nbsp;сайте или в&nbsp;боте). Цель {Math.round(target * 100)}%{fullShare !== null && (reached ? ', достигнута' : '')}. Добавленные HR в&nbsp;долю не&nbsp;входят.
          </p>
        </div>
        <div className="relative mt-3 h-[6px] max-w-xl bg-white/10" role="img" aria-label={`Доля заявок с «Заданиями 4/4»: ${share(fullShare)}, цель ${Math.round(target * 100)}%`}>
          <div className={`h-full ${reached ? 'bg-leaf' : 'bg-brand'}`} style={{ width: `${Math.min(100, (fullShare ?? 0) * 100)}%` }} />
          <div className="absolute -top-1.5 h-[18px] w-[2px] bg-white" style={{ left: `${target * 100}%` }} aria-hidden="true" />
        </div>

        <div className="-mx-4 mt-6 overflow-x-auto px-4 md:mx-0 md:px-0" tabIndex={0} role="region" aria-label="Задания и наём, прокручивается по горизонтали">
          <table className="w-full min-w-[640px] border-collapse text-left text-[14px] tabular-nums">
            <thead>
              <tr className={tableHead}>
                <th className={`${stickyCol} py-2.5 pr-3 font-semibold`}>Задания</th>
                <th className={th}>Заявки</th>
                <th className={th}>Собеседование</th>
                <th className={th} title="Не пришли на собеседование">
                  Неявка
                </th>
                <th className={th}>К оформлению</th>
                <th className={th}>На смене</th>
                <th className="py-2.5 text-right font-semibold" title="Доля заявок, дошедших до смены">
                  % до смены
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const b = taskBuckets.find((x) => x.id === r.bucket)
                return (
                  <tr key={r.bucket} className="border-b border-white/10" title={b?.hint}>
                    <th scope="row" className={`${stickyCol} py-2.5 pr-3 text-left font-normal`}>
                      {b?.label ?? r.bucket}
                    </th>
                    {cells(r)}
                  </tr>
                )
              })}
              <tr className="border-b border-white/30 font-semibold">
                <th scope="row" className={`${stickyCol} py-2.5 pr-3 text-left font-semibold`}>
                  Итого
                </th>
                {cells(total)}
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-3 max-w-2xl text-[13px] leading-snug text-white/60">Сайт и&nbsp;боты вместе. «Итого» совпадает с&nbsp;плиткой «Заявка».</p>
      </div>

      <div className="min-w-0">
        <h3 className="font-display text-[22px] leading-none font-black uppercase">Какое задание ведёт к&nbsp;заявке</h3>
        <p className="mt-3 text-[13px] leading-snug text-white/60">
          Только сайт. Это связь, без доказательства причины: кто и&nbsp;так собирается работать, охотнее проходит задания.
        </p>
        <table className="mt-3 w-full border-collapse text-left text-[14px] tabular-nums">
          <thead>
            <tr className={tableHead}>
              <th className="py-2.5 pr-3 font-semibold">Задание</th>
              <th className={th}>Прошли</th>
              <th className="py-2.5 text-right font-semibold">С заявкой</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((l) => {
              const v = l.visitors ? l.applied / l.visitors : 0
              return (
                <tr key={l.task} className="border-b border-white/10">
                  <th scope="row" className="py-2.5 pr-3 text-left font-normal">
                    {l.task === 'none' ? <span className="text-white/70">Без заданий</span> : taskLabels[l.task]}
                  </th>
                  <td className="py-2.5 pr-3 text-right">{l.visitors}</td>
                  <td className="py-2.5 text-right">
                    <span className="whitespace-nowrap">
                      {l.applied} <span className="text-white/60">· {pct(l.applied, l.visitors)}</span>
                    </span>
                    <span className="mt-1.5 ml-auto block h-[2px] w-24 bg-white/10" aria-hidden="true">
                      <span className="block h-full bg-brand" style={{ width: `${bestLead ? (v / bestLead) * 100 : 0}%` }} />
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}
