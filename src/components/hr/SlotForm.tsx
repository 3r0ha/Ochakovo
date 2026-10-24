import { interviewDefaults, type HrApplication, type InterviewSlot } from '@shared/applications'
import { slotWarning, workdayAfter } from '@shared/workdays'
import { hrWork, type SlotBody } from '../../lib/api'
import { HrInput, HrLabel, RuDate } from './ui'

// Слот собеседования: дата, время, адрес, что взять. Адрес и «что взять» запоминаются
// в браузере — у одного HR обычно одно место собеседований.

export type SlotDraft = {
  date: string
  time: string
  address: string
  bring: string
  withoutSlot: boolean
  /** HR подтвердил время вне рабочего: выходной, праздник, вечер */
  confirmOff?: boolean
}

const KEY = 'ochakovo.hr.slot'
const MSK = 3 * 3600e3

function remembered(): Pick<SlotDraft, 'address' | 'bring'> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<SlotDraft> | null
    return { address: v?.address || interviewDefaults.address, bring: v?.bring || interviewDefaults.bring }
  } catch {
    return { ...interviewDefaults }
  }
}

export function rememberSlot(d: SlotDraft) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ address: d.address, bring: d.bring }))
  } catch {
    // без localStorage просто не запоминаем
  }
}

/** Черновик слота: из текущего собеседования или завтра в 11:00 с запомненным адресом */
export function initialSlot(existing?: InterviewSlot | null): SlotDraft {
  if (existing) {
    const wall = new Date(new Date(existing.startsAt).getTime() + MSK).toISOString()
    return { date: wall.slice(0, 10), time: wall.slice(11, 16), address: existing.address, bring: existing.bring, withoutSlot: false }
  }
  // Ближайший рабочий день по календарю отдела: выходные, праздники и переносы пропускаем
  const day = new Date(workdayAfter(1, 11, Date.now(), hrWork).getTime() + MSK)
  return { date: day.toISOString().slice(0, 10), time: '11:00', ...remembered(), withoutSlot: false }
}

/** Для запроса: время по Москве в ISO. null — без даты («согласуем по телефону») */
export function slotBody(d: SlotDraft): SlotBody | null {
  if (d.withoutSlot) return null
  return { startsAt: new Date(`${d.date}T${d.time}:00+03:00`).toISOString(), address: d.address.trim(), bring: d.bring.trim() }
}

/** Слот как InterviewSlot — для предпросмотра сообщения */
export function draftSlot(d: SlotDraft): Pick<InterviewSlot, 'startsAt' | 'address' | 'bring'> | null {
  const b = slotBody(d)
  return b && !Number.isNaN(new Date(b.startsAt).getTime()) ? b : null
}

export function SlotForm({ value, onChange, id, allowWithout = true }: { value: SlotDraft; onChange: (d: SlotDraft) => void; id: string; allowWithout?: boolean }) {
  // Другая дата или время — подтверждение «вне рабочего» нужно заново
  const set = (patch: Partial<SlotDraft>) => onChange({ ...value, ...patch, ...('date' in patch || 'time' in patch ? { confirmOff: false } : {}) })
  return (
    <div className="flex flex-col gap-4">
      {allowWithout && (
        <label className="inline-flex cursor-pointer items-center gap-2.5 text-[15px] text-white/80">
          <input type="checkbox" checked={value.withoutSlot} onChange={(e) => set({ withoutSlot: e.target.checked })} className="size-4 accent-[var(--color-brand)]" />
          Время согласуем по телефону
        </label>
      )}
      {!value.withoutSlot && (
        <>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <HrLabel htmlFor={`${id}-date`}>Дата</HrLabel>
              <HrInput id={`${id}-date`} type="date" value={value.date} min={new Date(Date.now() + MSK).toISOString().slice(0, 10)} onChange={(e) => set({ date: e.target.value })} />
              <RuDate value={value.date} className="mt-1 block" />
            </div>
            <div>
              <HrLabel htmlFor={`${id}-time`}>Время, Москва</HrLabel>
              <HrInput id={`${id}-time`} type="time" step={900} value={value.time} onChange={(e) => set({ time: e.target.value })} />
            </div>
          </div>
          {slotOffHours(value) && (
            <div className="border-l-4 border-periwinkle bg-periwinkle/[0.08] p-3 text-[14px]" role="alert">
              <p>{slotOffHours(value)}.</p>
              <label className="mt-2 inline-flex cursor-pointer items-center gap-2.5">
                <input type="checkbox" checked={Boolean(value.confirmOff)} onChange={(e) => set({ confirmOff: e.target.checked })} className="size-4 accent-[var(--color-brand)]" />
                Да, назначить на это время
              </label>
            </div>
          )}
          <div>
            <HrLabel htmlFor={`${id}-address`}>Адрес и как пройти</HrLabel>
            <HrInput id={`${id}-address`} value={value.address} onChange={(e) => set({ address: e.target.value })} placeholder="Москва, ул. Рябиновая, 44" />
          </div>
          <div>
            <HrLabel htmlFor={`${id}-bring`}>Что взять с собой</HrLabel>
            <HrInput id={`${id}-bring`} value={value.bring} onChange={(e) => set({ bring: e.target.value })} placeholder="паспорт" />
          </div>
        </>
      )}
    </div>
  )
}

/** Почему слот нельзя сохранить; null — можно. Те же правила, что на сервере */
export function slotProblem(d: SlotDraft, now = Date.now()): string | null {
  if (d.withoutSlot) return null
  if (!d.date || !d.time) return 'Укажи дату и время'
  const at = new Date(`${d.date}T${d.time}:00+03:00`).getTime()
  if (Number.isNaN(at)) return 'Не получилось прочитать дату или время'
  if (at < now) return 'Это время уже прошло'
  if (at > now + 180 * 864e5) return 'Не дальше чем на полгода вперёд'
  if (d.address.trim().length < 5) return 'Укажи адрес собеседования'
  const off = slotWarning(new Date(at), hrWork)
  if (off && !d.confirmOff) return `${off}. Отметь, что так и задумано`
  return null
}

/** Выходной, праздник или вне рабочего дня — предупреждение для формы */
export function slotOffHours(d: SlotDraft) {
  if (d.withoutSlot || !d.date || !d.time) return null
  const at = new Date(`${d.date}T${d.time}:00+03:00`)
  return Number.isNaN(at.getTime()) ? null : slotWarning(at, hrWork)
}

/**
 * Сколько уже назначено на этот час и сколько будет вместе с новыми.
 * except — заявки, которые сейчас переносим: их старое время не считаем.
 */
export function slotLoad(d: SlotDraft, apps: HrApplication[], adding: number, except: string[] = []) {
  if (d.withoutSlot || !d.date || !d.time) return null
  const hour = `${d.date}T${d.time.slice(0, 2)}`
  const booked = apps.filter(
    (a) =>
      a.status === 'interview' &&
      a.interview &&
      !a.duplicateOf &&
      !except.includes(a.id) &&
      new Date(new Date(a.interview.startsAt).getTime() + MSK).toISOString().slice(0, 13) === hour,
  ).length
  return { booked, total: booked + adding, capacity: hrWork.slotCapacity }
}

/** Подсказка о загрузке часа: сколько назначено и не перебор ли */
export function SlotLoadNote({ load }: { load: ReturnType<typeof slotLoad> }) {
  if (!load) return null
  const over = load.total > load.capacity
  return (
    <p role={over ? 'alert' : 'status'} className={`text-[14px] ${over ? 'text-periwinkle' : 'text-white/60'}`}>
      {over
        ? `На этот час будет ${load.total} при норме ${load.capacity}. Раздели на два часа или увеличь норму в настройках`
        : `На этот час назначено ${load.booked}, будет ${load.total} из ${load.capacity}`}
    </p>
  )
}
