import { useRef, useState } from 'react'
import {
  applicationStatuses,
  declineReasons,
  seasonLeaveReasons,
  seasonOutcomes,
  statusLabel,
  type ApplicationStatus,
  type DeclineReason,
  type HrApplication,
  type SeasonLeaveReason,
  type SeasonOutcome,
} from '@shared/applications'
import { evenSplit, filterToParams } from '@shared/hrFilter'
import { hourKey, mskAt, spreadSlots } from '@shared/workdays'
import { ApiValidationError, exportApplications, hrChannels, hrSms, hrWork, type BulkResult, type ExportFormat, type SlotBody, type SpreadBody, type Staff } from '../../lib/api'
import { bulkChunked as bulkAction, distribute } from '../../lib/hr/desk'
import { BookingError, bulkSeason, offerBooking, reserveMessage, type SeasonFields } from '../../lib/hr/pipeline'
import { saveBlob } from './download'
import { formatPhone, plural } from './hrUtils'
import { Dialog } from './overlay'
import { initialSlot, rememberSlot, slotBody, SlotForm, slotLoad, SlotLoadNote, slotProblem, type SlotDraft } from './SlotForm'
import { useToast, useToastClearance } from './toasts'
import { chip, copyText, HrInput, HrLabel, HrSelect, HrTextArea, hrBtn, Notice, RuDate } from './ui'

type Props = {
  selected: HrApplication[]
  /** Все заявки — чтобы посчитать загрузку часа собеседований */
  apps: HrApplication[]
  staff: Staff[]
  /** Открыт вид «Резерв»: в сообщении — готовый текст про места, рядом — «Вернуть в работу» */
  reserveView?: boolean
  onClear: () => void
  onChanged: (apps: HrApplication[]) => void
}

/** Сообщение дойдёт через бота: заявка из бота или заявка с сайта, привязанная к боту, и бот подключён */
const reachable = (a: HrApplication) => {
  const chat = a.channel && a.channel !== 'web' && a.channel !== 'hr' && a.channelUserId ? a.channel : a.botUserId ? a.botChannel : null
  return Boolean(chat && hrChannels.includes(chat))
}

/** Кому позвонить; contact — ник или почта, если телефона нет */
type CallList = (BulkResult['calls'][number] & { contact: string })[]

/** Ошибка сервера — дословно, если это проверка данных; иначе общий текст */
const errorText = (e: unknown) => (e instanceof ApiValidationError || e instanceof BookingError ? e.message : 'Нет связи с сервером. Проверь соединение и попробуй ещё раз')

/**
 * Массовые действия с выделенными заявками: статус, ответственный, сообщение, выгрузка.
 * Компонент живёт всё время: окно «Кому позвонить» не пропадает, когда строки уходят из фильтра.
 */
export function BulkBar({ selected, apps, staff, reserveView, onClear, onChanged }: Props) {
  const toast = useToast()
  const [dialog, setDialog] = useState<null | 'interview' | 'declined' | 'message' | 'distribute' | 'season'>(null)
  // Снимок выделения на момент открытия окна: строки могут уйти из фильтра, пока окно открыто
  const [target, setTarget] = useState<HrApplication[]>([])
  const [calls, setCalls] = useState<CallList>([])
  const [busy, setBusy] = useState(false)
  const ids = selected.map((a) => a.id)
  // Сообщения с «Отменить» — над панелью действий, а не поверх её кнопок
  const bar = useRef<HTMLDivElement>(null)
  useToastClearance(bar, selected.length > 0)

  const open = (d: typeof dialog) => {
    setTarget(selected)
    setDialog(d)
  }

  const finish = (r: BulkResult, text: string) => {
    onChanged(r.applications)
    const undo = r.done.flatMap((d) => (d.historyId ? [d.historyId] : []))
    const queued = r.done.filter((d) => d.notify?.notify === 'queued').length
    const detail = [queued ? `Сообщений в очереди: ${queued}, уйдут через 20 с` : '', r.calls.length ? `Позвонить: ${r.calls.length}` : '', r.failed.length ? `Не вышло: ${r.failed.length}` : '']
      .filter(Boolean)
      .join(' · ')
    toast({ text, detail: detail || undefined, undo: undo.length ? undo : undefined })
    setDialog(null)
    if (r.calls.length) setCalls(r.calls.map((c) => ({ ...c, contact: r.applications.find((a) => a.id === c.id)?.contact ?? '' })))
  }

  /** Выполнить; true — получилось. Ошибки проверки сервера показываем дословно */
  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
      return true
    } catch (e) {
      toast({ text: 'Не получилось', detail: errorText(e), tone: 'error' })
      return false
    } finally {
      setBusy(false)
    }
  }

  const setStatus = (status: ApplicationStatus) => {
    if (status === 'interview') return open('interview')
    if (status === 'declined') return open('declined')
    void run(async () => finish(await bulkAction(ids, { action: 'status', status }), `${statusLabel(status)}: ${ids.length}`))
  }

  const assign = (value: string) => {
    if (value === 'even') return open('distribute')
    return run(async () => {
      const assigneeId = value === 'none' ? null : Number(value)
      const r = await bulkAction(ids, { action: 'assign', assigneeId })
      finish(r, assigneeId === null ? `Без ответственного: ${ids.length}` : `Ведёт ${staff.find((s) => s.id === assigneeId)?.name ?? ''}: ${ids.length}`)
    })
  }

  /** «Предложить выбрать время»: кандидаты сами выбирают час собеседования */
  const offer = () =>
    run(async () => {
      const r = await offerBooking(ids)
      const failed = r.failed?.length ?? 0
      toast({ text: `Предложили выбрать время: ${ids.length - failed}`, detail: failed ? `Не вышло: ${failed}. ${r.failed![0].error}` : 'Кому бот и SMS не напишут, увидят предложение на «Моей заявке» или узнают при звонке' })
    })

  /** «Вернуть в работу» из «Резерва»: статус «Связались» без сообщения кандидату, причина отказа сбрасывается */
  const backToWork = () => run(async () => finish(await bulkAction(ids, { action: 'status', status: 'contacted' }), `Вернули в работу: ${ids.length}`))

  const doExport = (format: ExportFormat) =>
    run(async () => {
      const blob = await exportApplications(format, filterToParams({ ids }).toString())
      saveBlob(blob, format === 'csv1c' ? 'Кандидаты для 1С (выбранные).csv' : `Заявки (выбранные).${format}`)
    })

  const targetIds = target.map((a) => a.id)
  const select = 'h-9 cursor-pointer border-b border-white/30 bg-coal pr-6 text-[14px] text-white focus:border-white'

  return (
    <>
      {selected.length > 0 && (
        <div ref={bar} className="fixed inset-x-0 bottom-0 z-40 border-t border-white/15 bg-coal/95 backdrop-blur" role="region" aria-label="Действия с выбранными заявками">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 md:px-6">
            <p className="font-display text-[20px] leading-none font-black uppercase">Выбрано: {ids.length}</p>
            <select aria-label="Сменить статус выбранным" className={select} value="" disabled={busy} onChange={(e) => e.target.value && setStatus(e.target.value as ApplicationStatus)}>
              <option value="">Сменить статус</option>
              {applicationStatuses.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
            <select aria-label="Назначить ответственного" className={select} value="" disabled={busy} onChange={(e) => e.target.value && void assign(e.target.value)}>
              <option value="">Назначить</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
              {staff.length > 1 && <option value="even">Поровну между сотрудниками</option>}
              <option value="none">Снять ответственного</option>
            </select>
            <button className={`${hrBtn.small} text-white ring-1 ring-white/30 ring-inset hover:ring-white`} disabled={busy} onClick={() => open('message')}>
              Сообщение
            </button>
            {selected.some((a) => ['new', 'contacted', 'no_answer'].includes(a.status)) && (
              <button className={`${hrBtn.small} text-white ring-1 ring-white/30 ring-inset hover:ring-white`} disabled={busy} onClick={() => void offer()}>
                Предложить выбрать время
              </button>
            )}
            {selected.some((a) => a.status === 'started') && (
              <button className={`${hrBtn.small} text-white ring-1 ring-white/30 ring-inset hover:ring-white`} disabled={busy} onClick={() => open('season')}>
                Итог сезона
              </button>
            )}
            {reserveView && selected.some((a) => a.status === 'declined') && (
              <button className={hrBtn.smallGhost} disabled={busy} onClick={() => void backToWork()}>
                Вернуть в работу
              </button>
            )}
            <select aria-label="Выгрузить выбранные" className={select} value="" disabled={busy} onChange={(e) => e.target.value && void doExport(e.target.value as ExportFormat)}>
              <option value="">Выгрузить</option>
              <option value="xlsx">Excel</option>
              <option value="csv">CSV</option>
              <option value="csv1c">CSV для 1С</option>
              <option value="json">JSON</option>
            </select>
            <button onClick={onClear} className="ml-auto h-9 text-[14px] text-white/70 underline-offset-4 hover:text-white hover:underline">
              Снять выделение
            </button>
          </div>
        </div>
      )}

      <BulkInterview
        open={dialog === 'interview'}
        target={target}
        apps={apps}
        busy={busy}
        onClose={() => setDialog(null)}
        onSubmit={(b) => run(async () => finish(await bulkAction(targetIds, { action: 'status', status: 'interview', ...b }), `Собеседование: ${targetIds.length}`))}
      />
      <BulkDecline
        open={dialog === 'declined'}
        count={target.length}
        busy={busy}
        onClose={() => setDialog(null)}
        onSubmit={(declineReason) => run(async () => finish(await bulkAction(targetIds, { action: 'status', status: 'declined', declineReason }), `Отказ: ${targetIds.length}`))}
      />
      <BulkSeason
        open={dialog === 'season'}
        target={target}
        busy={busy}
        onClose={() => setDialog(null)}
        onSubmit={(season) => run(async () => finish(await bulkSeason(targetIds.filter((id) => target.find((a) => a.id === id)?.status === 'started'), season), 'Итог сезона отмечен'))}
      />
      <BulkMessage
        open={dialog === 'message'}
        target={target}
        preset={reserveView ? reserveMessage : undefined}
        busy={busy}
        onClose={() => setDialog(null)}
        onSubmit={(text) => run(async () => finish(await bulkAction(targetIds, { action: 'message', text }), `Сообщение: ${targetIds.length}`))}
      />
      <Distribute
        open={dialog === 'distribute'}
        count={target.length}
        staff={staff}
        busy={busy}
        onClose={() => setDialog(null)}
        onSubmit={(assignees) =>
          run(async () => {
            const r = await distribute(targetIds, assignees)
            const parts = assignees.map((id) => `${staff.find((s) => s.id === id)?.name ?? id} (${r.split.get(id) ?? 0})`)
            finish(r, `Раздали поровну: ${parts.join(', ')}`)
          })
        }
      />
      <CallListDialog calls={calls} onClose={() => setCalls([])} />
    </>
  )
}

function BulkInterview({
  open,
  target,
  apps,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean
  target: HrApplication[]
  apps: HrApplication[]
  busy: boolean
  onClose: () => void
  onSubmit: (b: {
    slot?: SlotBody
    withoutSlot?: boolean
    allowOffHours?: boolean
    allowUnderage?: boolean
    allowNoConsent?: boolean
    spread?: SpreadBody
    lastNames?: Record<string, string>
  }) => Promise<boolean>
}) {
  const [draft, setDraft] = useState<SlotDraft>(() => initialSlot())
  // Охрана ищет кандидатов в списке на проходную по фамилии. Без неё приглашаем, но предупреждаем и даём вписать
  const [lastNames, setLastNames] = useState<Record<string, string>>({})
  const noLastName = target.filter((a) => !a.lastName)
  const filledNames = Object.fromEntries(Object.entries(lastNames).filter(([id, v]) => v.trim() && noLastName.some((a) => a.id === id)))
  const named = Object.keys(filledNames).length ? { lastNames: filledNames } : {}
  // Нет 18 лет по анкете — предупреждаем до «Пригласить», а не ошибкой после
  const minors = target.filter((a) => a.adult === false)
  const [allowUnderage, setAllowUnderage] = useState(false)
  // Согласия нет (рекомендация) — приглашение только с подтверждением, как в карточке
  const noConsent = target.filter((a) => a.consentSource === 'none' && a.status !== 'interview')
  const [allowNoConsent, setAllowNoConsent] = useState(false)
  const minorsBlock = (minors.length > 0 && !allowUnderage) || (noConsent.length > 0 && !allowNoConsent)
  const confirmed = { allowUnderage, ...(allowNoConsent ? { allowNoConsent } : {}) }
  // Одному человеку раскладывать нечего — сразу одно время
  const [mode, setMode] = useState<'one' | 'spread'>('one')
  const spreadMode = mode === 'spread' && target.length > 1
  const problem = slotProblem(draft)
  const reach = target.filter(reachable).length
  const submit = async () => {
    const slot = slotBody(draft)
    if (slot) rememberSlot(draft)
    await onSubmit(slot ? { slot, allowOffHours: draft.confirmOff, ...confirmed, ...named } : { withoutSlot: true, ...confirmed, ...named })
  }
  const lastNamesNote = noLastName.length > 0 && (
    <details className="mb-5 border-l-4 border-periwinkle bg-periwinkle/[0.08] p-3 text-[14px]" open={noLastName.length <= 3}>
      <summary className="cursor-pointer">
        Нет фамилии у&nbsp;{noLastName.length}, без неё охрана не&nbsp;найдёт человека в&nbsp;списке на&nbsp;проходную. Пригласить можно и&nbsp;так, а&nbsp;фамилии можно вписать здесь
      </summary>
      <ul className="mt-3 flex flex-col gap-2">
        {noLastName.map((a) => (
          <li key={a.id}>
            <label className="grid items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
              <span className="break-words text-white/80">
                {a.name} · {a.id}
              </span>
              <input
                value={lastNames[a.id] ?? ''}
                onChange={(e) => setLastNames((m) => ({ ...m, [a.id]: e.target.value }))}
                placeholder="Фамилия"
                aria-label={`Фамилия: ${a.name}, заявка ${a.id}`}
                autoComplete="off"
                className="h-9 w-full border-b border-white/30 bg-transparent text-[15px] text-white placeholder:text-white/55 focus:border-white"
              />
            </label>
          </li>
        ))}
      </ul>
    </details>
  )
  const minorsNote = minors.length > 0 && (
    <div className="mb-5 border-l-4 border-periwinkle bg-periwinkle/[0.08] p-3 text-[14px]" role="alert">
      <p>
        По анкете нет 18 лет: {minors.map((a) => [a.lastName, a.name].filter(Boolean).join(' ')).join(', ')}. На завод берут с 18 лет. Сними их с выделения или подтверди, если в анкете ошибка.
      </p>
      <label className="mt-2 inline-flex cursor-pointer items-center gap-2.5">
        <input type="checkbox" checked={allowUnderage} onChange={(e) => setAllowUnderage(e.target.checked)} className="size-4 accent-[var(--color-brand)]" />
        Всё равно пригласить
      </label>
    </div>
  )
  const noConsentNote = noConsent.length > 0 && (
    <div className="mb-5 border-l-4 border-periwinkle bg-periwinkle/[0.08] p-3 text-[14px]" role="alert">
      <p>
        Нет согласия на обработку данных: {noConsent.map((a) => [a.lastName, a.name].filter(Boolean).join(' ')).join(', ')}. Их добавили по рекомендации. При звонке скажи, откуда номер, и получи согласие.
      </p>
      <label className="mt-2 inline-flex cursor-pointer items-center gap-2.5">
        <input type="checkbox" checked={allowNoConsent} onChange={(e) => setAllowNoConsent(e.target.checked)} className="size-4 accent-[var(--color-brand)]" />
        Всё равно пригласить
      </label>
    </div>
  )
  return (
    <Dialog open={open} title={`Собеседование · ${target.length}`} onClose={onClose} wide={spreadMode}>
      {target.length > 1 && (
        <div className="mb-5 flex flex-wrap gap-2" role="group" aria-label="Как назначить время">
          <button type="button" aria-pressed={!spreadMode} onClick={() => setMode('one')} className={chip(!spreadMode)}>
            Одно время для всех
          </button>
          <button type="button" aria-pressed={spreadMode} onClick={() => setMode('spread')} className={chip(spreadMode)}>
            Разложить по норме
          </button>
        </div>
      )}
      {minorsNote}
      {noConsentNote}
      {lastNamesNote}
      {spreadMode ? (
        <SpreadForm target={target} apps={apps} busy={busy || minorsBlock} reach={reach} onSubmit={(spread) => onSubmit({ spread, ...confirmed, ...named })} />
      ) : (
        <>
          <p className="mb-5 text-[15px] text-white/65">
            Все выбранные получат одно время, например для группового собеседования. В бот уйдёт {reach} из {target.length}
            {hrSms ? ', остальным SMS, если номер мобильный' : ''}. Если сообщение кому-то не дойдёт, покажем список для звонка.
          </p>
          <SlotForm id="bulk-slot" value={draft} onChange={setDraft} />
          <div className="mt-4">
            <SlotLoadNote load={slotLoad(draft, apps, target.length, target.map((a) => a.id))} />
          </div>
          {problem && <p className="mt-3 text-[14px] text-brand-bright" role="alert">{problem}</p>}
          <button onClick={() => void submit()} disabled={Boolean(problem) || busy || minorsBlock} className={`${hrBtn.red} mt-5 w-full sm:w-fit`}>
            {busy ? 'Приглашаем' : 'Пригласить'}
          </button>
        </>
      )}
    </Dialog>
  )
}

const dayTitle = (day: string) =>
  new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', weekday: 'long', day: 'numeric', month: 'long' }).format(mskAt(day, 12))

/**
 * «Разложить по норме»: выбранные — по часам собеседований, начиная с первого дня, каждый час до нормы
 * с учётом уже назначенных. Сначала те, кто ждёт дольше. Перед отправкой — раскладка по дням и часам
 */
function SpreadForm({
  target,
  apps,
  busy,
  reach,
  onSubmit,
}: {
  target: HrApplication[]
  apps: HrApplication[]
  busy: boolean
  reach: number
  onSubmit: (spread: SpreadBody) => Promise<boolean>
}) {
  const base = initialSlot()
  const [from, setFrom] = useState(base.date)
  const [fromHour, setFromHour] = useState(Math.min(Math.max(10, hrWork.start), hrWork.end - 1))
  const [toHour, setToHour] = useState(hrWork.end - 1 > Math.max(10, hrWork.start) ? hrWork.end - 1 : hrWork.end)
  const [stagger, setStagger] = useState(true)
  const [lunch, setLunch] = useState<number | null>(hrWork.start <= 13 && hrWork.end > 14 ? 13 : null)
  const [dayLimit, setDayLimit] = useState('')
  const [address, setAddress] = useState(base.address)
  const [bring, setBring] = useState(base.bring)

  const ids = new Set(target.map((a) => a.id))
  const booked: Record<string, number> = {}
  for (const a of apps)
    if (a.status === 'interview' && a.interview && !a.duplicateOf && !ids.has(a.id)) {
      const key = hourKey(new Date(a.interview.startsAt))
      booked[key] = (booked[key] ?? 0) + 1
    }
  const queue = [...target].sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt))
  const limit = Number.parseInt(dayLimit, 10)
  const slots = from
    ? spreadSlots(queue.length, { from, fromHour, toHour, capacity: hrWork.slotCapacity, booked, settings: hrWork, stagger, lunchHour: lunch, dayLimit: limit > 0 ? limit : null })
    : []
  const step = Math.floor(60 / hrWork.slotCapacity)
  const timeOf = (iso: string) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
  const plan = slots.map((s, i) => ({ ...s, app: queue[i] }))
  const days = [...new Set(plan.map((p) => p.hour.slice(0, 10)))]
  const short = queue.length - plan.length
  const problem = !from
    ? 'Укажи первый день'
    : toHour <= fromHour
      ? 'Конец раньше начала'
      : address.trim().length < 5
        ? 'Укажи адрес собеседования'
        : short > 0
          ? `Не хватает мест для ${short} из ${queue.length}. Начни раньше, добавь часы или увеличь норму в настройках`
          : null
  const hours = Array.from({ length: hrWork.end - hrWork.start + 1 }, (_, i) => hrWork.start + i)
  const name = (a: HrApplication) => [a.lastName, a.name].filter(Boolean).join(' ') || a.id

  const submit = async () => {
    rememberSlot({ ...base, address, bring })
    await onSubmit({ address: address.trim(), bring: bring.trim(), slots: plan.map((p) => ({ id: p.app.id, startsAt: p.startsAt })) })
  }

  return (
    <div>
      <p className="mb-5 text-[15px] text-white/65">
        У каждого своё время. Часы заполняются до нормы {hrWork.slotCapacity} человек с учётом уже назначенных, только в рабочие дни, первыми идут те, кто ждёт дольше. В бот уйдёт {reach} из {target.length}. Если сообщение кому-то не дойдёт, покажем список для звонка.
      </p>
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <HrLabel htmlFor="spread-from">С какого дня</HrLabel>
          <HrInput id="spread-from" type="date" value={from} min={new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10)} onChange={(e) => setFrom(e.target.value)} />
          <RuDate value={from} className="mt-1 block" />
        </div>
        <div>
          <HrLabel htmlFor="spread-start">С, Москва</HrLabel>
          <HrSelect id="spread-start" value={fromHour} onChange={(e) => setFromHour(Number(e.target.value))}>
            {hours.slice(0, -1).map((h) => (
              <option key={h} value={h}>{`${h}:00`}</option>
            ))}
          </HrSelect>
        </div>
        <div>
          <HrLabel htmlFor="spread-end">До</HrLabel>
          <HrSelect id="spread-end" value={toHour} onChange={(e) => setToHour(Number(e.target.value))}>
            {hours.slice(1).map((h) => (
              <option key={h} value={h}>{`${h}:00`}</option>
            ))}
          </HrSelect>
        </div>
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <div>
          <HrLabel htmlFor="spread-lunch">Обед</HrLabel>
          <HrSelect id="spread-lunch" value={lunch ?? ''} onChange={(e) => setLunch(e.target.value === '' ? null : Number(e.target.value))}>
            <option value="">без перерыва</option>
            {hours.slice(0, -1).map((h) => (
              <option key={h} value={h}>{`${h}:00–${h + 1}:00`}</option>
            ))}
          </HrSelect>
        </div>
        <div>
          <HrLabel htmlFor="spread-limit">Не больше в день</HrLabel>
          <HrInput id="spread-limit" type="number" min={1} max={200} inputMode="numeric" value={dayLimit} onChange={(e) => setDayLimit(e.target.value)} placeholder="без лимита" />
        </div>
        <label className="inline-flex cursor-pointer items-center gap-2.5 self-end pb-2 text-[15px] text-white/80">
          <input type="checkbox" checked={stagger} onChange={(e) => setStagger(e.target.checked)} className="size-4 accent-[var(--color-brand)]" />
          Каждому своё время, шаг {step} мин
        </label>
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <HrLabel htmlFor="spread-address">Адрес и как пройти</HrLabel>
          <HrInput id="spread-address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Москва, ул. Рябиновая, 44" />
        </div>
        <div>
          <HrLabel htmlFor="spread-bring">Что взять с собой</HrLabel>
          <HrInput id="spread-bring" value={bring} onChange={(e) => setBring(e.target.value)} placeholder="паспорт" />
        </div>
      </div>

      {plan.length > 0 && (
        <div className="mt-6 border-t border-white/15 pt-4">
          <p className="text-[15px]" role="status">
            {short > 0 ? `Разложено ${plan.length} из ${queue.length}` : `Все ${queue.length} ${days.length === 1 ? 'за один день' : `за ${plural(days.length, 'рабочий день', 'рабочих дня', 'рабочих дней')}`}`}
          </p>
          <div className="mt-3 max-h-[40vh] overflow-y-auto pr-1" tabIndex={0} aria-label="Раскладка по дням и часам">
            {days.map((day) => {
              const inDay = plan.filter((p) => p.hour.startsWith(day))
              const byHour = [...new Set(inDay.map((p) => p.hour))]
              return (
                <section key={day} className="mb-4">
                  <h3 className="font-display text-[18px] font-extrabold uppercase">{dayTitle(day)}</h3>
                  <ul className="mt-1">
                    {byHour.map((h) => {
                      const people = inDay.filter((p) => p.hour === h)
                      const before = booked[h] ?? 0
                      return (
                        <li key={h} className="grid grid-cols-[64px_1fr] gap-3 border-b border-white/10 py-2 text-[14px]">
                          <span className="tabular-nums">{`${Number(h.slice(11))}:00`}</span>
                          <span>
                            <span className="text-white/60">
                              {before ? `уже ${before}, ` : ''}
                              {before + people.length} из {hrWork.slotCapacity} ·{' '}
                            </span>
                            {people.map((p) => (stagger ? `${timeOf(p.startsAt)} ${name(p.app)}` : name(p.app))).join(', ')}
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                </section>
              )
            })}
          </div>
        </div>
      )}
      {problem && <p className="mt-3 text-[14px] text-brand-bright" role="alert">{problem}</p>}
      <button onClick={() => void submit()} disabled={Boolean(problem) || busy} className={`${hrBtn.red} mt-5 w-full sm:w-fit`}>
        {busy ? 'Приглашаем' : `Пригласить ${plan.length}`}
      </button>
    </div>
  )
}

/** «Назначить → поровну между…»: выбранные заявки по очереди раздаются отмеченным сотрудникам */
function Distribute({ open, count, staff, busy, onClose, onSubmit }: { open: boolean; count: number; staff: Staff[]; busy: boolean; onClose: () => void; onSubmit: (assignees: number[]) => void }) {
  const [picked, setPicked] = useState<number[] | null>(null)
  const chosen = picked ?? staff.map((s) => s.id)
  const toggle = (id: number) => setPicked(chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id])
  // Раскладка та же, что у сервера: по кругу в порядке списка
  const split = evenSplit(Array.from({ length: count }, (_, i) => i), staff.map((s) => s.id).filter((id) => chosen.includes(id)))
  return (
    <Dialog open={open} title={`Поровну · ${count}`} onClose={onClose}>
      <p className="mb-4 text-[15px] text-white/65">Заявки по очереди достанутся отмеченным сотрудникам, у каждого будет поровну (разница не больше одной). Отменить можно одной кнопкой.</p>
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">Между кем раздать</legend>
        {staff.map((s) => (
          <label key={s.id} className="flex cursor-pointer items-center justify-between gap-3 border-b border-white/10 py-2 text-[15px]">
            <span className="inline-flex items-center gap-2.5">
              <input type="checkbox" checked={chosen.includes(s.id)} onChange={() => toggle(s.id)} className="size-4 accent-[var(--color-brand)]" />
              {s.name}
            </span>
            <span className="text-white/60 tabular-nums">{chosen.includes(s.id) ? (split.get(s.id)?.length ?? 0) : '—'}</span>
          </label>
        ))}
      </fieldset>
      <button onClick={() => onSubmit(staff.map((s) => s.id).filter((id) => chosen.includes(id)))} disabled={busy || !chosen.length} className={`${hrBtn.red} mt-6 w-full sm:w-fit`}>
        {busy ? 'Раздаём' : chosen.length ? `Раздать ${count} между ${chosen.length}` : 'Отметь сотрудников'}
      </button>
    </Dialog>
  )
}

function BulkDecline({ open, count, busy, onClose, onSubmit }: { open: boolean; count: number; busy: boolean; onClose: () => void; onSubmit: (r: DeclineReason) => void }) {
  const [reason, setReason] = useState<DeclineReason | ''>('')
  return (
    <Dialog open={open} title={`Отказ · ${count}`} onClose={onClose}>
      <HrLabel htmlFor="bulk-reason">Причина</HrLabel>
      <HrSelect id="bulk-reason" value={reason} onChange={(e) => setReason(e.target.value as DeclineReason)}>
        <option value="">Выбери причину</option>
        {declineReasons.map((r) => (
          <option key={r.id} value={r.id}>
            {r.label}
          </option>
        ))}
      </HrSelect>
      <p className="mt-4 text-[15px] text-white/65">Кандидатам из ботов уйдёт сообщение об отказе по шаблону. Причину видят только сотрудники.</p>
      <button onClick={() => reason && onSubmit(reason)} disabled={!reason || busy} className={`${hrBtn.red} mt-6 w-full sm:w-fit`}>
        Отказать
      </button>
    </Dialog>
  )
}

/** Итог сезона массово — только у тех, кто «На смене»: остальных в выделении пропускаем */
function BulkSeason({ open, target, busy, onClose, onSubmit }: { open: boolean; target: HrApplication[]; busy: boolean; onClose: () => void; onSubmit: (s: SeasonFields) => void }) {
  const [outcome, setOutcome] = useState<SeasonOutcome | ''>('')
  const [reason, setReason] = useState<SeasonLeaveReason | ''>('')
  const [reserve, setReserve] = useState<'keep' | 'on' | 'off'>('keep')
  const started = target.filter((a) => a.status === 'started').length
  const ready = (outcome !== '' || reserve !== 'keep') && (outcome !== 'left' || reason !== '')
  const body: SeasonFields = {
    ...(outcome ? { seasonOutcome: outcome, ...(outcome === 'left' ? { seasonLeaveReason: reason } : {}) } : {}),
    ...(reserve !== 'keep' ? { reserve: reserve === 'on' } : {}),
  }
  return (
    <Dialog open={open} title={`Итог сезона · ${started}`} onClose={onClose}>
      {started < target.length && <p className="mb-4 text-[15px] text-white/65">Итог ставят только тем, кто на смене: {started} из {target.length}. Остальных пропустим.</p>}
      <fieldset className="flex flex-col gap-2 text-[15px]">
        <legend className="mb-1 text-[14px] text-white/80">Итог</legend>
        {[{ id: '' as const, label: 'Не менять' }, ...seasonOutcomes].map((o) => (
          <label key={o.id || 'keep'} className="inline-flex cursor-pointer items-center gap-2.5">
            <input type="radio" name="bulk-outcome" checked={outcome === o.id} onChange={() => setOutcome(o.id)} className="size-4 accent-[var(--color-brand)]" />
            {o.label}
          </label>
        ))}
      </fieldset>
      {outcome === 'left' && (
        <div className="mt-4">
          <HrLabel htmlFor="bulk-leave">Почему ушли</HrLabel>
          <HrSelect id="bulk-leave" value={reason} onChange={(e) => setReason(e.target.value as SeasonLeaveReason)}>
            <option value="">Выбери причину</option>
            {seasonLeaveReasons.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </HrSelect>
        </div>
      )}
      <fieldset className="mt-5 flex flex-col gap-2 text-[15px]">
        <legend className="mb-1 text-[14px] text-white/80">Звать в штат или в резерв (видят только сотрудники)</legend>
        {(
          [
            ['keep', 'Не менять'],
            ['on', 'Отметить'],
            ['off', 'Снять отметку'],
          ] as const
        ).map(([id, label]) => (
          <label key={id} className="inline-flex cursor-pointer items-center gap-2.5">
            <input type="radio" name="bulk-reserve" checked={reserve === id} onChange={() => setReserve(id)} className="size-4 accent-[var(--color-brand)]" />
            {label}
          </label>
        ))}
      </fieldset>
      <button onClick={() => onSubmit(body)} disabled={!ready || busy || !started} className={`${hrBtn.red} mt-6 w-full sm:w-fit`}>
        {busy ? 'Сохраняем' : `Отметить: ${started}`}
      </button>
    </Dialog>
  )
}

function BulkMessage({
  open,
  target,
  preset,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean
  target: HrApplication[]
  /** Готовый текст — для вида «Резерв»: появились места */
  preset?: string
  busy: boolean
  onClose: () => void
  onSubmit: (text: string) => Promise<boolean>
}) {
  const [text, setText] = useState('')
  const bots = target.filter(reachable).length
  return (
    <Dialog open={open} title="Сообщение" onClose={onClose}>
      <p className="mb-4 text-[15px] text-white/65">
        В бот уйдёт {bots} из {target.length}. Остальным бот не напишет. После отправки покажем, кому позвонить, и&nbsp;текст для каждого.
      </p>
      {preset && text !== preset && (
        <button type="button" onClick={() => setText(preset)} className="mb-3 text-left text-[14px] text-periwinkle underline underline-offset-4">
          Вставить готовый текст: снова есть места
        </button>
      )}
      <HrLabel htmlFor="bulk-text">Текст</HrLabel>
      <HrTextArea id="bulk-text" rows={5} value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} className="mt-2" placeholder="Например: в четверг смена начинается в 9:00, остальное без изменений." />
      <p className="mt-1 text-right text-[13px] text-white/60">{text.length} / 1000</p>
      {text.trim().length > 0 && text.trim().length < 5 && <p className="text-[14px] text-brand-bright">Слишком коротко, нужно хотя бы 5 знаков</p>}
      <button
        onClick={async () => (await onSubmit(text.trim())) && setText('')}
        disabled={text.trim().length < 5 || busy}
        className={`${hrBtn.red} mt-4 w-full sm:w-fit`}
      >
        Отправить
      </button>
    </Dialog>
  )
}

/** Кому позвонить: у каждого свой текст — с его именем, номером заявки и временем */
function CallListDialog({ calls, onClose }: { calls: CallList; onClose: () => void }) {
  const [copied, setCopied] = useState<string | null>(null)
  const copy = async (key: string, text: string) => {
    if (await copyText(text)) setCopied(key)
  }
  const all = calls.map((c) => `${c.name}, ${c.phone ? formatPhone(c.phone) : c.contact || 'нет телефона'}\n${c.text}`).join('\n\n')
  return (
    <Dialog open={calls.length > 0} title={`Позвонить · ${calls.length}`} onClose={onClose} wide>
      <Notice>Этим кандидатам бот не напишет: заявка пришла с&nbsp;сайта, добавлена вручную или бот сейчас не&nbsp;подключён. Позвони или напиши в&nbsp;мессенджер, текст у каждого свой.</Notice>
      <ol className="mt-5 border-t border-white/10">
        {calls.map((c) => (
          <li key={c.id} className="border-b border-white/10 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <span className="font-medium">{c.name}</span>
              {c.phone ? (
                <a href={`tel:${c.phone.replace(/[^+\d]/g, '')}`} className="tabular-nums underline-offset-4 hover:underline">
                  {formatPhone(c.phone)}
                </a>
              ) : (
                <span className="break-words text-white/70">{c.contact || '—'}</span>
              )}
            </div>
            <p className="mt-2 text-[14px] leading-snug text-white/75">{c.text}</p>
            <button onClick={() => void copy(c.id, c.text)} className="mt-2 text-[14px] text-white underline underline-offset-4">
              {copied === c.id ? 'Скопировано' : 'Скопировать текст'}
            </button>
          </li>
        ))}
      </ol>
      <div className="mt-5 flex flex-wrap gap-3">
        <button className={hrBtn.ghost} onClick={() => void copy('all', all)}>
          {copied === 'all' ? 'Скопировано' : 'Скопировать весь список'}
        </button>
        <button className={hrBtn.ghost} onClick={onClose}>
          Готово
        </button>
      </div>
    </Dialog>
  )
}
