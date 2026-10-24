import { useEffect, useState, type FormEvent } from 'react'
import { interviewDefaults } from '@shared/applications'
import { ApiValidationError, hrWork } from '../../lib/api'
import { closeHiringDay, createHiringDay, hiringDays, type HiringDay } from '../../lib/hr/booking'
import { useToast } from './toasts'
import { chip, copyText, hrBtn, HrInput, HrLabel, HrTextArea, Notice, RuDate } from './ui'

// Дни найма в «Графике»: день открытых дверей с собеседованиями по часам. Кандидат по ссылке дня (?src=<метка>,
// в боте start=<метка>) сразу выбирает час. Оформление в тот же день не обещаем — дату назовёт HR.
// Плакат и листовка с QR — та же страница, что для меток источников: /hr/poster?src=<метка>

const dayTitle = (day: string) =>
  new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' }).format(new Date(`${day}T12:00:00+03:00`))

const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`

/** Часы рабочего дня отдела — из настроек панели */
const workHours = () => Array.from({ length: Math.max(0, hrWork.end - hrWork.start) }, (_, i) => hrWork.start + i)

export function HiringDays() {
  const toast = useToast()
  const [days, setDays] = useState<HiringDay[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [adding, setAdding] = useState(false)

  const load = () =>
    hiringDays().then(
      (list) => (setDays(list), setFailed(false)),
      () => setFailed(true),
    )
  useEffect(() => {
    void load()
  }, [])

  // Без сервера (демо в браузере) дней найма нет — раздел не показываем
  if (failed && !days) return null

  const close = async (d: HiringDay) => {
    if (!window.confirm(`Отменить день найма ${dayTitle(d.day)}? По ссылке больше не запишутся, назначенные собеседования останутся.`)) return
    try {
      await closeHiringDay(d.id)
      toast({ text: 'День найма отменён' })
      await load()
    } catch {
      toast({ text: 'Не получилось отменить', detail: 'Проверь соединение и попробуй ещё раз', tone: 'error' })
    }
  }

  const open = (days ?? []).filter((d) => !d.closedAt)
  const past = (days ?? []).filter((d) => d.closedAt)

  return (
    <section aria-labelledby="hiring-days-title" className="mt-12 border-t border-white/15 pt-8">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <h2 id="hiring-days-title" className="font-display text-[clamp(26px,2.6vw,34px)] leading-none font-black uppercase">
          Дни найма
        </h2>
        {!adding && (
          <button type="button" className={chip(false)} onClick={() => setAdding(true)}>
            + День найма
          </button>
        )}
      </div>
      <p className="mt-3 max-w-2xl text-[15px] text-white/60">
        Экскурсия по цехам и собеседования в один день. Кандидат по ссылке или QR сам выбирает час, места по часам считаются здесь. Оформление идёт в обычном
        порядке, в тот же день его не обещаем.
      </p>

      {adding && (
        <NewDay
          onCancel={() => setAdding(false)}
          onCreated={async () => {
            setAdding(false)
            toast({ text: 'День найма создан', detail: 'Ссылка и плакат с QR есть в карточке дня' })
            await load()
          }}
        />
      )}

      {days && !open.length && !adding && <p className="mt-6 text-[15px] text-white/55">Открытых дней найма нет.</p>}

      <ul className="mt-6 grid gap-4 lg:grid-cols-2">
        {open.map((d) => (
          <DayCard key={d.id} day={d} onClose={() => void close(d)} />
        ))}
      </ul>

      {past.length > 0 && (
        <details className="mt-6">
          <summary className="cursor-pointer text-[15px] text-white/60">Прошедшие и отменённые · {past.length}</summary>
          <ul className="mt-4 grid gap-4 lg:grid-cols-2">
            {past.map((d) => (
              <DayCard key={d.id} day={d} />
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

function DayCard({ day, onClose }: { day: HiringDay; onClose?: () => void }) {
  const toast = useToast()
  const total = day.hours.length * day.capacity
  const booked = Object.values(day.booked).reduce((a, b) => a + b, 0)
  const copy = async (url: string) => toast((await copyText(url)) ? { text: 'Ссылка скопирована' } : { text: 'Не получилось скопировать', detail: url, tone: 'error' })
  return (
    <li className="bg-coal p-5 ring-1 ring-white/10 ring-inset">
      <p className="font-display text-[26px] leading-none font-black uppercase">{dayTitle(day.day)}</p>
      <p className="mt-2 text-[15px] text-white/65">
        {day.address} · записано {booked} из {total} · по ссылке пришли {day.offers}
      </p>
      {day.note && <p className="mt-2 text-[15px] text-white/80">{day.note}</p>}
      <ul className="mt-4 flex flex-wrap gap-2" aria-label="Записано по часам">
        {day.hours.map((h) => {
          const n = day.booked[hourLabel(h)] ?? 0
          return (
            <li key={h} className={`px-2.5 py-1.5 text-[15px] tabular-nums ring-1 ring-inset ${n >= day.capacity ? 'bg-white/[0.12] font-semibold ring-white' : 'ring-white/25'}`}>
              {hourLabel(h)} · {n}/{day.capacity}
            </li>
          )
        })}
      </ul>
      {!day.closedAt && (
        <div className="mt-5 flex flex-wrap gap-2">
          <button type="button" className={`${hrBtn.small} ring-1 ring-white/35 ring-inset`} onClick={() => void copy(day.links.site)}>
            Ссылка на сайт
          </button>
          {day.links.telegram && (
            <button type="button" className={`${hrBtn.small} ring-1 ring-white/35 ring-inset`} onClick={() => void copy(day.links.telegram!)}>
              Ссылка в Telegram
            </button>
          )}
          {day.links.max && (
            <button type="button" className={`${hrBtn.small} ring-1 ring-white/35 ring-inset`} onClick={() => void copy(day.links.max!)}>
              Ссылка в MAX
            </button>
          )}
          <a href={`/hr/poster?src=${encodeURIComponent(day.label)}`} target="_blank" rel="noreferrer" className={`${hrBtn.small} ring-1 ring-white/35 ring-inset`}>
            Плакат с QR
          </a>
          {onClose && (
            <button type="button" className={`${hrBtn.small} text-white/70 hover:text-white`} onClick={onClose}>
              Отменить день
            </button>
          )}
        </div>
      )}
    </li>
  )
}

function NewDay({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => void }) {
  const [day, setDay] = useState('')
  const [hours, setHours] = useState<number[]>([])
  const [capacity, setCapacity] = useState(3)
  const [address, setAddress] = useState(interviewDefaults.address)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const toggle = (h: number) => setHours((list) => (list.includes(h) ? list.filter((x) => x !== h) : [...list, h].sort((a, b) => a - b)))

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!day) return setError('Выбери дату')
    if (!hours.length) return setError('Отметь хотя бы один час собеседований')
    setBusy(true)
    setError(null)
    try {
      await createHiringDay({ day, hours, capacity, address: address.trim() || undefined, note: note.trim() || undefined })
      onCreated()
    } catch (err) {
      setError(err instanceof ApiValidationError ? err.message : 'Не получилось сохранить. Попробуй ещё раз.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="mt-6 grid max-w-2xl gap-5 bg-coal p-5 ring-1 ring-white/10 ring-inset">
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <HrLabel htmlFor="hd-day">Дата</HrLabel>
          <HrInput id="hd-day" type="date" value={day} onChange={(e) => setDay(e.target.value)} required />
          <RuDate value={day} className="mt-1 block" />
        </div>
        <div>
          <HrLabel htmlFor="hd-capacity">Мест в каждом часе</HrLabel>
          <HrInput id="hd-capacity" type="number" min={1} max={20} value={capacity} onChange={(e) => setCapacity(Math.max(1, Math.min(20, Number(e.target.value) || 1)))} />
        </div>
      </div>
      <fieldset>
        <legend className="font-display text-[15px] font-extrabold tracking-[0.06em] text-white/50 uppercase">Часы собеседований</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {workHours().map((h) => (
            <button key={h} type="button" aria-pressed={hours.includes(h)} className={chip(hours.includes(h))} onClick={() => toggle(h)}>
              {hourLabel(h)}
            </button>
          ))}
        </div>
      </fieldset>
      <div>
        <HrLabel htmlFor="hd-address">Адрес</HrLabel>
        <HrInput id="hd-address" value={address} onChange={(e) => setAddress(e.target.value)} />
      </div>
      <div>
        <HrLabel htmlFor="hd-note">Заметка для команды</HrLabel>
        <HrTextArea id="hd-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Экскурсия в 10:00, встречаем на проходной" />
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className={hrBtn.red}>
          Создать день
        </button>
        <button type="button" onClick={onCancel} className={hrBtn.ghost}>
          Отмена
        </button>
      </div>
    </form>
  )
}
