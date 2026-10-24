import { useEffect, useMemo, useState } from 'react'
import type { HrApplication } from '@shared/applications'
import { vacancies } from '@shared/content/vacancies'
import { monthsRange } from '@shared/hr'
import { planMonths, planPeople, planProgress, planTotals, schoolSummary, seasonOf } from '@shared/hrPlan'
import { plural, vacancyTitle } from './hrUtils'
import { getPlan, savePlan, type PlanCellInfo } from '../../lib/api'
import { useToast } from './toasts'
import { hrBtn, Notice } from './ui'

const monthShort = (m: number) => new Date(Date.UTC(0, m - 1, 1)).toLocaleDateString('ru-RU', { month: 'short', timeZone: 'UTC' }).replace('.', '')

/**
 * План найма по вакансиям и месяцам: сколько нужно и сколько уже нашли. Прогресс — из «К оформлению» и «На смене».
 * С датой первой смены человек закрывает только её месяц. Ниже — свод для договоров о практике по учебным заведениям.
 * onOpen — открыть заявку из раскрытой строки свода
 */
export function PlanView({ apps, onOpen }: { apps: HrApplication[]; onOpen?: (id: string) => void }) {
  const toast = useToast()
  const season = seasonOf(Date.now())
  const [cells, setCells] = useState<PlanCellInfo[] | null>(null)
  const [edit, setEdit] = useState(false)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [error, setError] = useState(false)

  useEffect(() => {
    getPlan(season)
      .then((r) => setCells(r.cells))
      .catch(() => setError(true))
  }, [season])

  // Прогресс пересчитываем на месте: меняется статус — меняется план, без перезагрузки
  const live = useMemo(() => (cells ? planProgress(cells, apps, season) : []), [cells, apps, season])
  const total = planTotals(live)
  const people = useMemo(() => (cells ? planPeople(cells, apps, season) : { hired: 0, started: 0 }), [cells, apps, season])
  const key = (v: string, m: number) => `${v}:${m}`
  const at = (v: string, m: number) => live.find((c) => c.vacancyId === v && c.month === m)

  const startEdit = () => {
    setDraft(Object.fromEntries(live.map((c) => [key(c.vacancyId, c.month), String(c.target)])))
    setEdit(true)
  }
  const save = async () => {
    const entries = vacancies.flatMap((v) => planMonths.map((m) => ({ vacancyId: v.id, month: m, target: Number(draft[key(v.id, m)] || 0) })))
    if (entries.some((e) => !Number.isInteger(e.target) || e.target < 0)) return toast({ text: 'В плане нужны целые числа от нуля', tone: 'error' })
    try {
      const r = await savePlan(season, entries.filter((e) => e.target > 0 || at(e.vacancyId, e.month)))
      setCells(r.cells)
      setEdit(false)
      toast({ text: 'План сохранён' })
    } catch (e) {
      toast({ text: 'План не сохранился', detail: (e as Error).message, tone: 'error' })
    }
  }

  const rows = edit ? vacancies : vacancies.filter((v) => live.some((c) => c.vacancyId === v.id))

  return (
    <section aria-labelledby="plan-title" className="mt-12">
      <h2 id="plan-title" className="font-display text-[26px] leading-none font-black uppercase">
        План найма · сезон {season}
      </h2>
      {error && (
        <div className="mt-3">
          <Notice tone="error">План не загрузился.</Notice>
        </div>
      )}
      <p className="mt-2 max-w-3xl text-[14px] text-white/65">
        {live.length
          ? `Приняты ${people.hired}, вышли на смену ${people.started}. Мест по месяцам закрыто ${total.hired} из ${total.target}. Кто готов работать в июне–августе, закрывает каждый из этих месяцев, а кому назначили первую смену, закрывает только её месяц. В клетке показано, сколько принято и сколько нужно.`
          : 'Плана пока нет. Задай, сколько людей нужно на вакансию в каждый месяц, и прогресс посчитается сам по статусам «К оформлению» и «На смене».'}
      </p>
      {/* Кнопка — сразу под пояснением: что она сделает, написано прямо над ней */}
      <div className="mt-3 flex flex-wrap gap-2">
        {!edit ? (
          <button onClick={startEdit} className={hrBtn.smallGhost}>
            {live.length ? 'Изменить план' : 'Задать план'}
          </button>
        ) : (
          <>
            <button onClick={() => void save()} className={hrBtn.smallRed}>
              Сохранить
            </button>
            <button onClick={() => setEdit(false)} className={hrBtn.smallGhost}>
              Отмена
            </button>
          </>
        )}
      </div>
      {(rows.length > 0 || edit) && (
        <div className="-mx-4 mt-4 max-w-4xl overflow-x-auto px-4 md:mx-0 md:px-0" tabIndex={0} role="region" aria-label="План найма, прокручивается по горизонтали">
          <table className="w-full min-w-[760px] border-collapse text-left text-[14px] tabular-nums">
            <caption className="sr-only">План найма по вакансиям и месяцам: приняты из нужного</caption>
            <thead>
              <tr className="border-b border-white/30 text-[12px] tracking-[0.06em] text-white/65 uppercase">
                <th className="sticky left-0 z-10 w-[156px] min-w-[156px] bg-night py-2 pr-3 font-semibold md:static md:w-auto md:bg-transparent">Вакансия</th>
                {planMonths.map((m) => (
                  <th key={m} className="py-2 pr-3 text-right font-semibold">
                    {monthShort(m)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.id} className="border-b border-white/10">
                  <th scope="row" className="sticky left-0 z-10 bg-night py-2 pr-3 text-left font-normal break-words md:static md:bg-transparent">
                    {v.title}
                  </th>
                  {planMonths.map((m) => {
                    const c = at(v.id, m)
                    if (edit)
                      return (
                        <td key={m} className="py-1.5 pr-3 text-right">
                          <input
                            type="number"
                            min={0}
                            aria-label={`${v.title}, ${monthShort(m)}: сколько нужно`}
                            value={draft[key(v.id, m)] ?? ''}
                            onChange={(e) => setDraft((d) => ({ ...d, [key(v.id, m)]: e.target.value }))}
                            className="h-8 w-14 border-b border-white/30 bg-transparent text-right text-white"
                          />
                        </td>
                      )
                    if (!c) return <td key={m} className="py-2 pr-3 text-right text-white/60">·</td>
                    const done = c.hired >= c.target
                    return (
                      <td key={m} className={`py-2 pr-3 text-right ${done ? 'text-sage' : 'text-white'}`} title={`Вышли на смену: ${c.started}`}>
                        {c.hired} из {c.target}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Schools apps={apps} season={season} onOpen={onOpen} />
    </section>
  )
}

/**
 * Практика от вуза: учебное заведение → сколько человек → месяцы. Нужен для договоров с вузами и колледжами:
 * их заключают до начала практики. Названия сведены: «РХТУ» и «РХТУ им. Д. И. Менделеева» — одна строка
 */
function Schools({ apps, season, onOpen }: { apps: HrApplication[]; season: number; onOpen?: (id: string) => void }) {
  const rows = useMemo(() => schoolSummary(apps, season), [apps, season])
  const byId = useMemo(() => new Map(apps.map((a) => [a.id, a])), [apps])
  if (!rows.length) return null
  const people = rows.reduce((n, r) => n + r.ids.length, 0)
  return (
    <div className="mt-8">
      <h3 className="font-display text-[22px] leading-none font-black uppercase">Практика от вуза · по учебным заведениям</h3>
      <p className="mt-2 max-w-3xl text-[14px] text-white/65">
        {plural(people, 'человек', 'человека', 'человек')} с практикой в этом сезоне: отметка «Практика от вуза» или вакансия практики, без отказов. Договор с вузом или колледжем подписывают до начала практики.
      </p>
      <ul className="mt-3 max-w-3xl border-t border-white/15">
        {rows.map((r) => (
          <li key={r.key || 'none'} className="border-b border-white/10">
            <details>
              <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-4 gap-y-1 py-2.5 text-[15px]">
                <span className={`min-w-0 flex-1 break-words ${r.title ? '' : 'text-white/60'}`}>{r.title ?? 'Учёба не указана'}</span>
                <span className="tabular-nums">{plural(r.ids.length, 'человек', 'человека', 'человек')}</span>
                <span className="w-40 text-white/60">{r.months.length ? monthsRange(r.months) : 'месяцы не указаны'}</span>
              </summary>
              <ul className="pb-3 pl-4 text-[14px]">
                {r.ids.map((id) => {
                  const a = byId.get(id)!
                  const name = [a.lastName, a.name].filter(Boolean).join(' ')
                  return (
                    <li key={id} className="py-0.5">
                      {onOpen ? (
                        <button onClick={() => onOpen(id)} className="text-left underline-offset-4 hover:underline">
                          {name}
                        </button>
                      ) : (
                        name
                      )}
                      <span className="text-white/60">
                        {' '}
                        · {vacancyTitle(a.vacancyId)} · {a.school || 'учёба не указана'}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </details>
          </li>
        ))}
      </ul>
    </div>
  )
}
