import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { departments, type DepartmentId } from '@shared/content/departments'
import { formatRub, vacancyFormats, type VacancyFormat } from '@shared/content/vacancies'
import { ApiValidationError } from '../../lib/api'
import { nb } from '../../lib/typo'
import { adminVacancies, resetVacancy, saveVacancy, type AdminVacancy, type VacancyEditable, type VacancyHistoryEntry } from '../../lib/hr/admin'
import { formatDate } from './hrUtils'
import { Dialog } from './overlay'
import { useToast } from './toasts'
import { HrInput, HrLabel, hrBtn, Notice } from './ui'

const small = `${hrBtn.small} text-white ring-1 ring-white/30 ring-inset hover:ring-white`

/** «от 70 000 ₽», «57 000–89 000 ₽», «без оплаты» */
function payText(e: VacancyEditable) {
  if (!e.pay) return 'без оплаты'
  const range = e.pay.to ? `${e.pay.from.toLocaleString('ru-RU')}–${formatRub(e.pay.to)}` : `от ${formatRub(e.pay.from)}`
  return e.pay.estimate ? `${range}, ориентир` : range
}

/** Что поменялось одной строкой: «сумма: от 70 000 ₽ → от 110 000 ₽; закрыта» */
export function changeText(before: VacancyEditable, after: VacancyEditable): string {
  const parts: string[] = []
  if (before.open !== after.open) parts.push(after.open ? 'снова открыта' : 'закрыта')
  if (payText(before) !== payText(after)) parts.push(`сумма: ${payText(before)} → ${payText(after)}`)
  if (before.hot !== after.hot) parts.push(after.hot ? 'срочный набор' : 'без срочного набора')
  if (before.period.trim() !== after.period.trim()) parts.push(`период: «${after.period.trim()}»`)
  return parts.join('; ') || 'без изменений'
}

const placeOf = (v: AdminVacancy) => v.unit ?? departments[v.department as DepartmentId]?.name ?? ''

/**
 * Вакансии без программиста: открыта или закрыта, зарплата от и до, ориентир, «Срочный набор», период.
 * Правка сразу видна на сайте, в ботах и у Квасыча. Названия, задачи и графики — в данных компании, их меняет программист
 */
export function VacanciesView() {
  const [data, setData] = useState<{ vacancies: AdminVacancy[]; history: VacancyHistoryEntry[] } | null>(null)
  const [failed, setFailed] = useState(false)
  const [editing, setEditing] = useState<AdminVacancy | null>(null)

  const load = () =>
    adminVacancies()
      .then((d) => {
        setData(d)
        setFailed(false)
      })
      .catch(() => setFailed(true))
  useEffect(() => {
    void load()
  }, [])

  const groups = useMemo(
    () => vacancyFormats.map((format) => ({ format, list: (data?.vacancies ?? []).filter((v) => v.format === format) })).filter((g) => g.list.length),
    [data],
  )

  if (failed) return <Notice tone="error">Вакансии не загрузились. Обнови страницу.</Notice>
  if (!data) return <p className="text-white/50">Загружаем</p>

  return (
    <div className="grid gap-12 xl:grid-cols-[minmax(0,8fr)_minmax(0,4fr)] xl:gap-16">
      <div className="flex min-w-0 flex-col gap-10">
        <p className="max-w-3xl text-[15px] leading-snug text-white/70">
          Здесь меняются сумма, «Срочный набор», период и&nbsp;то, открыта&nbsp;ли вакансия. Правка сразу видна на&nbsp;сайте, в&nbsp;ботах и&nbsp;у&nbsp;Квасыча. Закрытая
          вакансия пропадает со&nbsp;страницы вакансий, из&nbsp;формы, бота и&nbsp;подбора; пришедшие заявки остаются. Названия, задачи и&nbsp;графики меняет программист.
        </p>
        {groups.map((g) => (
          <section key={g.format} aria-labelledby={`vac-${g.format}`} className="border-t-[3px] border-double border-white/60 pt-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h2 id={`vac-${g.format}`} className="font-display text-[26px] leading-none font-black uppercase">
                {g.format}
              </h2>
              <p className="text-[14px] text-white/60">{nb(formatHint[g.format] ?? '')}</p>
            </div>
            <ul className="mt-3">
              {g.list.map((v) => (
                <VacancyRow key={v.id} v={v} onEdit={() => setEditing(v)} />
              ))}
            </ul>
          </section>
        ))}
      </div>
      <History items={data.history} />
      <Editor
        v={editing}
        onClose={() => setEditing(null)}
        onSaved={(history) => {
          setData((d) => (d ? { ...d, history } : d))
          void load()
        }}
      />
    </div>
  )
}

/** Что можно править у формата — подсказка у заголовка группы */
const formatHint: Partial<Record<VacancyFormat, string>> = {
  'Оплачиваемая практика': 'Сумма обязательна, по «Описанию практики»',
  'Бесплатная практика': 'Без оплаты, по договорённости с вузом',
  'Постоянная работа': 'Сумма по вакансии на hh.ru',
}

function VacancyRow({ v, onEdit }: { v: AdminVacancy; onEdit: () => void }) {
  const c = v.current
  return (
    <li className={`flex items-start justify-between gap-4 border-b border-white/10 py-4 sm:items-center sm:gap-6 ${c.open ? '' : 'opacity-60'}`}>
      <div className="min-w-0">
        <p className="text-[17px] leading-snug font-medium">
          {v.title}
          {!c.open && <span className="text-brand-bright"> · закрыта</span>}
          {c.open && c.hot && <span className="text-periwinkle"> · срочный набор</span>}
        </p>
        <p className="mt-0.5 text-[14px] text-white/65">
          {placeOf(v)} · {payText(c)} · {c.period}
        </p>
        <p className="mt-1 text-[13px] text-white/50">
          {v.overridden && v.updatedBy ? `Изменено: ${v.updatedBy}${v.updatedAt ? `, ${formatDate(v.updatedAt)}` : ''}` : 'Как в данных компании'}
        </p>
      </div>
      <button onClick={onEdit} className={`${small} shrink-0`} aria-label={`Править: ${v.title}`}>
        Править
      </button>
    </li>
  )
}

function History({ items }: { items: VacancyHistoryEntry[] }) {
  return (
    <aside aria-labelledby="vac-history" className="flex min-w-0 flex-col gap-3 self-start border-t-[3px] border-double border-white/60 pt-4">
      <h2 id="vac-history" className="font-display text-[22px] leading-none font-black uppercase">
        История правок
      </h2>
      {!items.length ? (
        <p className="text-[14px] text-white/60">Правок ещё не было: на сайте данные компании.</p>
      ) : (
        <ol className="flex flex-col">
          {items.map((h) => (
            <li key={h.id} className="border-b border-white/10 py-3 text-[14px] leading-snug">
              <p className="font-medium">{h.vacancyTitle}</p>
              <p className="text-white/75">{nb(changeText(h.before, h.after))}</p>
              <p className="mt-0.5 text-[13px] text-white/50">
                {h.userName} · {formatDate(h.createdAt)}
              </p>
            </li>
          ))}
        </ol>
      )}
    </aside>
  )
}

/** Сумма из поля: только цифры, пробелы между разрядами можно */
const parseRub = (s: string) => {
  const digits = s.replace(/[\s  ]/g, '')
  return /^\d+$/.test(digits) ? Number(digits) : null
}

type Draft = { open: boolean; from: string; to: string; estimate: boolean; hot: boolean; period: string }

const draftOf = (e: VacancyEditable): Draft => ({
  open: e.open,
  from: e.pay ? String(e.pay.from) : '',
  to: e.pay?.to ? String(e.pay.to) : '',
  estimate: Boolean(e.pay?.estimate),
  hot: e.hot,
  period: e.period,
})

function Editor({ v, onClose, onSaved }: { v: AdminVacancy | null; onClose: () => void; onSaved: (history: VacancyHistoryEntry[]) => void }) {
  const toast = useToast()
  const [d, setD] = useState<Draft | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setD(v ? draftOf(v.current) : null)
    setErrors({})
  }, [v])

  if (!v || !d) return <Dialog open={false} title="" onClose={onClose}>{null}</Dialog>

  const free = v.format === 'Бесплатная практика'
  const set = (patch: Partial<Draft>) => setD({ ...d, ...patch })

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const found: Record<string, string> = {}
    const from = parseRub(d.from)
    const to = d.to.trim() ? parseRub(d.to) : undefined
    if (!free && from === null) found.payFrom = 'Только цифры: например, 70000'
    if (!free && d.to.trim() && to === null) found.payTo = 'Только цифры или пусто'
    if (!d.period.trim()) found.period = 'Укажи период'
    setErrors(found)
    if (Object.keys(found).length) return
    const next: VacancyEditable = {
      open: d.open,
      hot: d.hot,
      period: d.period.trim(),
      pay: free || from === null ? null : { from, ...(to ? { to } : {}), ...(d.estimate ? { estimate: true } : {}) },
    }
    setBusy(true)
    try {
      const r = await saveVacancy(v.id, next)
      toast({ text: r.changed ? `${v.title}: сохранено` : 'Ничего не поменялось', detail: r.changed ? 'На сайте, в ботах и у Квасыча уже новые данные' : undefined })
      onSaved(r.history)
      onClose()
    } catch (err) {
      if (err instanceof ApiValidationError) setErrors(err.errors)
      else toast({ text: 'Не сохранилось', detail: (err as Error).message, tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const reset = async () => {
    setBusy(true)
    try {
      const r = await resetVacancy(v.id)
      toast({ text: `${v.title}: как в данных компании` })
      onSaved(r.history)
      onClose()
    } catch (err) {
      toast({ text: 'Не получилось', detail: (err as Error).message, tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const err = (key: string) =>
    errors[key] ? (
      <p id={`ved-${key}-error`} className="mt-2 text-[14px] text-brand-bright">
        {errors[key]}
      </p>
    ) : null
  const check = 'size-4 shrink-0 accent-[var(--color-brand)]'

  return (
    <Dialog open title={v.title} onClose={onClose} wide>
      <form onSubmit={submit} className="flex flex-col gap-6" noValidate>
        <p className="-mt-2 text-[14px] text-white/65">
          {v.format} · {placeOf(v)} · {v.schedule}
        </p>

        <label className="flex cursor-pointer items-start gap-3 text-[15px]">
          <input type="checkbox" checked={d.open} onChange={(e) => set({ open: e.target.checked })} className={`${check} mt-1`} />
          <span>
            Открыта: принимаем отклики
            <span className="block text-[13px] text-white/55">Закрытая пропадает с&nbsp;сайта, из&nbsp;формы, бота и&nbsp;подбора. Пришедшие заявки остаются.</span>
          </span>
        </label>

        {free ? (
          <p className="border-l-2 border-white/30 py-1 pl-4 text-[14px] text-white/70">
            Без оплаты: у&nbsp;бесплатной практики суммы нет. Платную практику в&nbsp;этом отделе программист заводит отдельной вакансией.
          </p>
        ) : (
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 font-display text-[15px] font-extrabold tracking-[0.06em] text-white/50 uppercase">Зарплата в месяц до вычета налога</legend>
            <div className="grid grid-cols-2 gap-4 sm:max-w-md">
              <div>
                <HrLabel htmlFor="ved-from">От, ₽</HrLabel>
                <HrInput
                  id="ved-from"
                  inputMode="numeric"
                  autoComplete="off"
                  value={d.from}
                  onChange={(e) => set({ from: e.target.value })}
                  aria-invalid={Boolean(errors.payFrom)}
                  aria-describedby={errors.payFrom ? 'ved-payFrom-error' : 'ved-pay-hint'}
                  className="tabular-nums"
                />
              </div>
              <div>
                <HrLabel htmlFor="ved-to">До, ₽</HrLabel>
                <HrInput
                  id="ved-to"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="если есть"
                  value={d.to}
                  onChange={(e) => set({ to: e.target.value })}
                  aria-invalid={Boolean(errors.payTo)}
                  aria-describedby={errors.payTo ? 'ved-payTo-error' : undefined}
                  className="tabular-nums"
                />
              </div>
            </div>
            {err('payFrom')}
            {err('payTo')}
            <p id="ved-pay-hint" className="text-[13px] text-white/55">
              В данных компании: {payText(v.builtin)}
              {v.payNote ? `, ${v.payNote}` : ''}.
            </p>
            <label className="flex cursor-pointer items-start gap-3 text-[15px]">
              <input type="checkbox" checked={d.estimate} onChange={(e) => set({ estimate: e.target.checked })} className={`${check} mt-1`} />
              <span>
                Ориентир
                <span className="block text-[13px] text-white/55">{nb('Сумма ещё не утверждена: на сайте и в боте рядом с ней будет «ориентир», точную назовут на собеседовании.')}</span>
              </span>
            </label>
          </fieldset>
        )}

        <label className="flex cursor-pointer items-start gap-3 text-[15px]">
          <input type="checkbox" checked={d.hot} onChange={(e) => set({ hot: e.target.checked })} className={`${check} mt-1`} />
          <span>
            Срочный набор
            <span className="block text-[13px] text-white/55">{nb('Пометка у вакансии на сайте. Ставь, только если отдел правда ждёт людей сейчас.')}</span>
          </span>
        </label>

        <div>
          <HrLabel htmlFor="ved-period">Период</HrLabel>
          <HrInput
            id="ved-period"
            value={d.period}
            maxLength={120}
            onChange={(e) => set({ period: e.target.value })}
            aria-invalid={Boolean(errors.period)}
            aria-describedby={errors.period ? 'ved-period-error' : undefined}
          />
          {err('period')}
          <p className="mt-2 text-[13px] text-white/55">В данных компании: «{v.builtin.period}».</p>
        </div>

        {v.basis && (
          <div className="flex flex-col gap-1 bg-white/[0.04] p-3 text-[13px] leading-snug">
            <p className="text-white/70">{nb(`Источник: ${v.basis.source}`)}</p>
            {v.basis.team && <p className="text-periwinkle">{nb(`Предложение команды: ${v.basis.team}. Стоит проверить с руководителем отдела.`)}</p>}
          </div>
        )}

        {errors.form && <Notice tone="error">{errors.form}</Notice>}
        <div className="flex flex-wrap gap-3">
          <button type="submit" disabled={busy} className={hrBtn.red}>
            {busy ? 'Сохраняем' : 'Сохранить'}
          </button>
          {v.overridden && (
            <button type="button" disabled={busy} onClick={() => void reset()} className={hrBtn.ghost}>
              Как в данных компании
            </button>
          )}
          <button type="button" onClick={onClose} className={`${hrBtn.small} text-white/70 hover:text-white`}>
            Отмена
          </button>
        </div>
      </form>
    </Dialog>
  )
}
