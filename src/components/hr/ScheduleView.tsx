import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import type { HrApplication } from '@shared/applications'
import { attendancePending } from '@shared/hrFilter'
import { dayKind, dayOffLabel, isWorkDay, mskParts } from '@shared/workdays'
import { hrWork } from '../../lib/api'
import { markAttendance } from '../../lib/hr/desk'
import { HiringDays } from './HiringDays'
import { vacancyTitle } from './hrUtils'
import { planText } from './notifyText'
import { useToast } from './toasts'
import { AttendanceButtons, chip, Empty, pageTitle, StatusBadge } from './ui'

const DAY = 864e5
const MSK = 3 * 3600e3
const dayNames = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']

/** Понедельник недели, в которую попадает момент, — YYYY-MM-DD по Москве */
const weekStart = (at: number) => {
  const p = mskParts(at)
  return new Date(Date.parse(`${p.day}T00:00:00Z`) - (p.dow - 1) * DAY).toISOString().slice(0, 10)
}
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10)
const statusText = (a: HrApplication) => (a.status === 'hired' ? 'к оформлению' : a.status === 'started' ? 'на смене' : a.status === 'declined' ? 'отказ' : '')
const dayTitle = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' })

type Slot = { hour: string; apps: HrApplication[] }

/** График собеседований по дням недели: часы, загрузка относительно нормы, перебор и время вне работы, явка у прошедших */
export function ScheduleView({ apps, onOpen, onChanged }: { apps: HrApplication[]; onOpen: (id: string) => void; onChanged: (apps: HrApplication[]) => void }) {
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  /** Явка или неявка с прошедшего собеседования. Неявка — отказ без сообщения кандидату; «Отменить» возвращает как было */
  const mark = async (a: HrApplication, attended: 'yes' | 'no') => {
    setBusy(a.id)
    try {
      const r = await markAttendance(a.id, attended)
      onChanged([r.application])
      const who = [a.lastName, a.name].filter(Boolean).join(' ')
      toast({
        text: attended === 'yes' ? `${who}: явка` : `${who}: неявка, отказ`,
        detail: attended === 'no' ? (planText(r.notify) ?? 'Кандидату ничего не отправлено') : undefined,
        undo: r.historyId ? [r.historyId] : undefined,
      })
    } catch (e) {
      toast({ text: 'Не отметилось', detail: (e as Error).message || 'Проверь соединение и попробуй ещё раз', tone: 'error' })
    } finally {
      setBusy(null)
    }
  }
  const now = Date.now()
  // По умолчанию — текущая неделя; если на ней больше никого не ждём и отмечать явку некому, то неделя ближайшего собеседования.
  // Прошедшие собеседования этой недели без отметки держат текущую неделю: иначе в пятницу HR не увидит, кого отметить
  const pickWeek = (list: HrApplication[]) => {
    const now = Date.now()
    const current = weekStart(now)
    const live = list.filter((a) => a.status === 'interview' && a.interview && !a.duplicateOf && !a.anonymizedAt)
    if (live.some((a) => attendancePending(a, now) && weekStart(new Date(a.interview!.startsAt).getTime()) === current)) return current
    const upcoming = live
      .map((a) => new Date(a.interview!.startsAt).getTime())
      .filter((t) => t > now)
      .sort((x, y) => x - y)
    return upcoming.length && !upcoming.some((t) => weekStart(t) === current) ? weekStart(upcoming[0]) : current
  }
  const [week, setWeek] = useState(() => pickWeek(apps))
  // Заявки могли загрузиться после открытия раздела — выбрать неделю один раз, пока HR сам не листал
  const touched = useRef(false)
  useEffect(() => {
    if (!touched.current && apps.length) setWeek(pickWeek(apps))
  }, [apps.length])
  const go = (w: string) => {
    touched.current = true
    setWeek(w)
  }
  const today = mskParts(Date.now()).day
  const capacity = hrWork.slotCapacity

  const days = useMemo(() => {
    // Отказ после неявки остаётся в графике с отметкой: видно, кто не пришёл
    const list = apps.filter((a) => a.interview && !a.duplicateOf && !a.anonymizedAt && (a.status !== 'declined' || a.interview.attended === 'no'))
    return Array.from({ length: 7 }, (_, i) => {
      const day = addDays(week, i)
      const slots = new Map<string, HrApplication[]>()
      for (const a of list) {
        const wall = new Date(new Date(a.interview!.startsAt).getTime() + MSK).toISOString()
        if (wall.slice(0, 10) !== day) continue
        const hour = `${wall.slice(11, 13)}:00`
        slots.set(hour, [...(slots.get(hour) ?? []), a])
      }
      const sorted: Slot[] = [...slots]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([hour, list]) => ({ hour, apps: list.sort((x, y) => x.interview!.startsAt.localeCompare(y.interview!.startsAt)) }))
      return { day, dow: i + 1, slots: sorted, workday: isWorkDay(day, hrWork), off: dayOffLabel(day, hrWork), holiday: dayKind(day, hrWork) === 'holiday' }
    })
  }, [apps, week])

  const total = days.reduce((n, d) => n + d.slots.reduce((m, s) => m + s.apps.length, 0), 0)
  // Итог не отмечен — по всем неделям, как плитка в «Заявках»
  const unmarked = apps.filter((a) => !a.duplicateOf && !a.anonymizedAt && attendancePending(a, now)).length
  const overloaded = days.flatMap((d) => d.slots.filter((s) => s.apps.length > capacity)).length
  const outside = days.reduce(
    (n, d) => n + d.slots.filter((s) => !d.workday || Number(s.hour.slice(0, 2)) < hrWork.start || Number(s.hour.slice(0, 2)) >= hrWork.end).length,
    0,
  )

  return (
    <section aria-labelledby="schedule-title">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <h1 id="schedule-title" className={pageTitle}>
          График
        </h1>
        <div className="flex items-center gap-2">
          <button onClick={() => go(addDays(week, -7))} className={chip(false)} aria-label="Предыдущая неделя">
            ←
          </button>
          <button onClick={() => go(weekStart(Date.now()))} aria-pressed={week === weekStart(Date.now())} className={chip(week === weekStart(Date.now()))}>
            Эта неделя
          </button>
          <button onClick={() => go(addDays(week, 7))} className={chip(false)} aria-label="Следующая неделя">
            →
          </button>
        </div>
        <p className="text-[14px] text-white/65" role="status">
          {dayTitle(week)} – {dayTitle(addDays(week, 6))}: собеседований {total}. Норма в час: {capacity}.
          {overloaded ? ` Перебор в ${overloaded} ${overloaded === 1 ? 'часе' : 'часах'}.` : ''}
          {outside ? ` Вне рабочего времени: ${outside}.` : ''}
          {unmarked ? <span className="font-semibold text-brand-bright"> Итог не отмечен: {unmarked}.</span> : ''}
        </p>
      </div>

      {total === 0 ? (
        <Empty title="Собеседований нет" className="mt-5" action={{ label: 'Следующая неделя', onClick: () => go(addDays(week, 7)) }}>
          На эту неделю никого не пригласили. Пригласить можно из карточки кандидата или выделив несколько заявок в списке.
        </Empty>
      ) : (
        <ol className="mt-5 grid gap-px bg-white/10 lg:grid-cols-7">
          {days.map((d) => (
            <li key={d.day} className={`min-w-0 bg-night p-3 ${d.slots.length ? '' : 'hidden lg:block'} ${d.workday ? '' : 'lg:bg-coal'}`}>
              <h2 className={`flex items-baseline justify-between gap-2 border-b pb-2 ${d.day === today ? 'border-brand-bright' : 'border-white/15'}`}>
                <span className="font-display text-[22px] leading-none font-black uppercase">
                  {dayNames[d.dow - 1]}
                  <span className="sr-only">,</span>
                </span>
                <span className={`text-[13px] ${d.day === today ? 'text-brand-bright' : 'text-white/60'}`}>
                  {d.day === today ? 'сегодня, ' : ''}
                  {dayTitle(d.day)}
                </span>
              </h2>
              {d.slots.length > 0 && (
                <Link to={`/hr/pass?date=${d.day}`} className="mt-2 inline-block text-[13px] text-white/75 underline underline-offset-4 hover:text-white">
                  Список на проходную
                </Link>
              )}
              {d.off && d.off !== 'рабочий по переносу' && <p className={`mt-2 text-[13px] ${d.holiday ? 'text-periwinkle' : 'text-white/60'}`}>{d.off}</p>}
              {d.off === 'рабочий по переносу' && <p className="mt-2 text-[13px] text-white/60">рабочий по переносу</p>}
              {!d.slots.length && d.workday && <p className="mt-2 text-[13px] text-white/60">Свободно</p>}
              <ul className="mt-2 flex flex-col gap-3">
                {d.slots.map((s) => {
                  const over = s.apps.length > capacity
                  const h = Number(s.hour.slice(0, 2))
                  const off = !d.workday || h < hrWork.start || h >= hrWork.end
                  return (
                    <li key={s.hour}>
                      <p className={`flex flex-wrap items-baseline justify-between gap-x-3 text-[13px] tabular-nums ${over ? 'font-semibold text-brand-bright' : 'text-white/70'}`}>
                        <span className="font-semibold">{s.hour}</span>
                        <span className="text-right">
                          {s.apps.length} из {capacity}
                          {over ? ' · перебор' : ''}
                          {off ? ' · вне рабочего времени' : ''}
                        </span>
                      </p>
                      <ul className="mt-1 flex flex-col">
                        {s.apps.map((a) => {
                          const who = [a.lastName, a.name, a.middleName].filter(Boolean).join(' ')
                          // Время у фамилии — только если собеседование не ровно в начале часа: час уже в заголовке
                          const time = new Date(a.interview!.startsAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' })
                          return (
                            <li key={a.id}>
                              <button onClick={() => onOpen(a.id)} className="flex w-full flex-col items-start rounded-sm px-1 py-1 text-left hover:bg-white/[0.06]">
                                <span className="w-full text-[14px] break-words">
                                  {!time.endsWith(':00') && <span className="text-white/60 tabular-nums">{time} </span>}
                                  {who}
                                </span>
                                <span className="w-full text-[13px] break-words text-white/60">
                                  {vacancyTitle(a.vacancyId)}
                                  {a.interview!.selfBooked ? ' · самозапись' : ''}
                                </span>
                                {a.interview!.attended === 'no' ? (
                                  <span className="text-[13px] font-semibold text-brand-bright">неявка</span>
                                ) : a.interview!.attended === 'yes' ? (
                                  <span className="text-[13px] text-sage">явка{a.status !== 'interview' ? ` · ${statusText(a)}` : ''}</span>
                                ) : (
                                  a.status !== 'interview' && <StatusBadge status={a.status} className="text-[13px] text-white/70" />
                                )}
                              </button>
                              {attendancePending(a, now) && (
                                <div className="mt-1 px-1">
                                  <AttendanceButtons compact busy={busy === a.id} onYes={() => void mark(a, 'yes')} onNo={() => void mark(a, 'no')} label={`Итог собеседования: ${who}`} />
                                </div>
                              )}
                            </li>
                          )
                        })}
                      </ul>
                    </li>
                  )
                })}
              </ul>
            </li>
          ))}
        </ol>
      )}
      <HiringDays />
    </section>
  )
}
