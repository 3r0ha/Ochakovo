import { useState, type FormEvent } from 'react'
import { manualConsents, startMonthOptions, startReadyOptions, type HrApplication, type ManualConsent, type StartReady } from '@shared/applications'
import { ageOn, ageWords, maskBirthDate, parseBirthDate } from '@shared/birthDate'
import { vacancies } from '@shared/content/vacancies'
import { SourceOptions } from './SourceOptions'
import { ApiValidationError, createCandidate, DuplicatePhone } from '../../lib/api'
import { seasonMonths } from '../../lib/season'
import { Dialog } from './overlay'
import { useToast } from './toasts'
import { chip, HrInput, HrLabel, HrSelect, HrTextArea, hrBtn, Notice } from './ui'

const empty = {
  name: '',
  lastName: '',
  middleName: '',
  phone: '',
  contact: '',
  birthDate: '',
  school: '',
  notStudying: false,
  startReady: '' as StartReady | '',
  startMonth: 6,
  practiceSchool: false,
  vacancyId: '',
  source: 'phone',
  comment: '',
  months: [] as number[],
  /** Основание для обработки данных: выбрать нужно явно */
  consentBasis: '' as ManualConsent | '',
}

type TextField = 'name' | 'lastName' | 'middleName' | 'phone' | 'contact'

/**
 * Добавить кандидата вручную: позвонил в отдел персонала, пришёл на завод, откликнулся на hh.ru, порекомендовали.
 * Поля кейса (дата рождения, учёба, когда может выйти) — по желанию: HR дополнит после звонка. Основание — обязательно
 */
export function AddCandidate({
  open,
  onClose,
  onCreated,
  onOpen,
}: {
  open: boolean
  onClose: () => void
  onCreated: (a: HrApplication) => void
  onOpen: (id: string) => void
}) {
  const toast = useToast()
  const [form, setForm] = useState(empty)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [dup, setDup] = useState<DuplicatePhone | null>(null)
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof typeof empty>(k: K, v: (typeof empty)[K]) => setForm((f) => ({ ...f, [k]: v }))

  const submit = async (e: FormEvent | null, force = false) => {
    e?.preventDefault()
    if (!form.consentBasis) return setErrors({ consentBasis: 'Выбери основание: без него непонятно, можно ли звонить' })
    setBusy(true)
    setErrors({})
    try {
      const { startMonth, startReady, ...rest } = form
      const app = await createCandidate({ ...rest, startReady, ...(startReady === 'month' ? { startMonth } : {}), consentBasis: form.consentBasis, force } as Parameters<typeof createCandidate>[0])
      toast({ text: `Добавлено: ${[app.lastName, app.name].filter(Boolean).join(' ')}`, detail: 'Заявку ведёшь ты. Карточка открыта' })
      setForm(empty)
      setDup(null)
      onClose()
      onCreated(app)
    } catch (err) {
      if (err instanceof DuplicatePhone) setDup(err)
      else if (err instanceof ApiValidationError) setErrors(err.errors)
      else setErrors({ form: 'Нет связи с сервером. Попробуй ещё раз' })
    } finally {
      setBusy(false)
    }
  }

  const field = (k: TextField, label: string, type = 'text', auto = 'off') => (
    <div>
      <HrLabel htmlFor={`add-${k}`}>{label}</HrLabel>
      <HrInput
        id={`add-${k}`}
        type={type}
        autoComplete={auto}
        value={form[k]}
        onChange={(e) => {
          set(k, e.target.value)
          if (k === 'phone') setDup(null)
        }}
        aria-invalid={Boolean(errors[k])}
        aria-describedby={errors[k] ? `add-${k}-error` : undefined}
      />
      {errors[k] && (
        <p id={`add-${k}-error`} className="mt-1 text-[14px] text-brand-bright">
          {errors[k]}
        </p>
      )}
    </div>
  )

  const born = parseBirthDate(form.birthDate)
  const age = born && form.birthDate.length === 10 ? ageOn(born) : null

  return (
    <Dialog open={open} title="Новый кандидат" onClose={onClose} wide>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-5" noValidate>
        <div className="grid gap-5 sm:grid-cols-3">
          {field('lastName', 'Фамилия')}
          {field('name', 'Имя')}
          {field('middleName', 'Отчество, если есть')}
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          {field('phone', 'Телефон', 'tel')}
          {field('contact', 'Почта или ник в мессенджере')}
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <HrLabel htmlFor="add-birth">Дата рождения</HrLabel>
            <div className="flex items-baseline gap-3">
              <HrInput
                id="add-birth"
                inputMode="numeric"
                autoComplete="off"
                placeholder="ДД.ММ.ГГГГ"
                maxLength={10}
                value={form.birthDate}
                onChange={(e) => set('birthDate', maskBirthDate(e.target.value))}
                aria-invalid={Boolean(errors.birthDate)}
                aria-describedby={errors.birthDate ? 'add-birth-error' : 'add-birth-age'}
                className="tabular-nums"
              />
              {age !== null && (
                <span id="add-birth-age" className={`shrink-0 text-[15px] ${age < 18 ? 'font-semibold text-brand-bright' : 'text-white/75'}`}>
                  {age < 18 ? `${ageWords(age)}, нет 18` : ageWords(age)}
                </span>
              )}
            </div>
            {errors.birthDate && (
              <p id="add-birth-error" className="mt-1 text-[14px] text-brand-bright">
                {errors.birthDate}
              </p>
            )}
          </div>
          <div>
            <HrLabel htmlFor="add-start">Когда может выйти</HrLabel>
            <div className="flex gap-3">
              <HrSelect id="add-start" value={form.startReady} onChange={(e) => set('startReady', e.target.value as StartReady | '')}>
                <option value="">не спросили</option>
                {startReadyOptions.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </HrSelect>
              {form.startReady === 'month' && (
                <HrSelect aria-label="С какого месяца" value={form.startMonth} onChange={(e) => set('startMonth', Number(e.target.value))} className="max-w-[150px]">
                  {startMonthOptions.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </HrSelect>
              )}
            </div>
          </div>
        </div>
        <div className="grid items-end gap-5 sm:grid-cols-2">
          <div>
            <HrLabel htmlFor="add-school">Вуз или колледж</HrLabel>
            <HrInput id="add-school" value={form.school} disabled={form.notStudying} onChange={(e) => set('school', e.target.value)} placeholder={form.notStudying ? 'Уже не учится' : ''} />
          </div>
          <div className="flex flex-col gap-2 pb-1 text-[15px] text-white/80">
            <label className="inline-flex cursor-pointer items-center gap-2.5">
              <input type="checkbox" checked={form.notStudying} onChange={(e) => setForm((f) => ({ ...f, notStudying: e.target.checked, school: e.target.checked ? '' : f.school }))} className="size-4 accent-[var(--color-brand)]" />
              Уже не учится
            </label>
            <label className="inline-flex cursor-pointer items-center gap-2.5">
              <input type="checkbox" checked={form.practiceSchool} onChange={(e) => set('practiceSchool', e.target.checked)} className="size-4 accent-[var(--color-brand)]" />
              Нужна практика от вуза
            </label>
          </div>
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <HrLabel htmlFor="add-source">Откуда</HrLabel>
            <HrSelect id="add-source" value={form.source} onChange={(e) => set('source', e.target.value)}>
              <SourceOptions />
            </HrSelect>
          </div>
          <div>
            <HrLabel htmlFor="add-vacancy">Вакансия</HrLabel>
            <HrSelect id="add-vacancy" value={form.vacancyId} onChange={(e) => set('vacancyId', e.target.value)}>
              <option value="">Любая подходящая</option>
              {vacancies.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.title}
                </option>
              ))}
            </HrSelect>
          </div>
        </div>
        <fieldset>
          <legend className="font-display text-[15px] font-extrabold tracking-[0.06em] text-white/60 uppercase">Месяцы работы</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {seasonMonths.map((m) => {
              const on = form.months.includes(m.value)
              return (
                <button
                  key={m.value}
                  type="button"
                  aria-pressed={on}
                  onClick={() => set('months', on ? form.months.filter((x) => x !== m.value) : [...form.months, m.value].sort((a, b) => a - b))}
                  className={chip(on)}
                >
                  {m.label}
                </button>
              )
            })}
          </div>
        </fieldset>
        <fieldset aria-describedby={errors.consentBasis ? 'add-consent-error' : undefined}>
          <legend className="font-display text-[15px] font-extrabold tracking-[0.06em] text-white/60 uppercase">Основание для обработки данных</legend>
          <div className="mt-2 flex flex-col gap-2.5">
            {manualConsents.map((c) => (
              <label key={c.id} className="flex cursor-pointer items-start gap-2.5 text-[15px]">
                <input
                  type="radio"
                  name="add-consent"
                  checked={form.consentBasis === c.id}
                  onChange={() => {
                    set('consentBasis', c.id)
                    setErrors(({ consentBasis: _drop, ...rest }) => rest)
                  }}
                  className="mt-1 size-4 shrink-0 accent-[var(--color-brand)]"
                />
                <span>
                  {c.label}
                  <span className="block text-[13px] text-white/55">{c.hint}</span>
                </span>
              </label>
            ))}
          </div>
          {errors.consentBasis && (
            <p id="add-consent-error" className="mt-2 text-[14px] text-brand-bright" role="alert">
              {errors.consentBasis}
            </p>
          )}
        </fieldset>
        <div>
          <HrLabel htmlFor="add-comment">Комментарий</HrLabel>
          <HrTextArea id="add-comment" rows={2} value={form.comment} onChange={(e) => set('comment', e.target.value)} className="mt-2" placeholder="Например: удобно звонить после 17:00" />
        </div>
        {dup && (
          <div className="border-l-4 border-periwinkle bg-periwinkle/[0.08] p-4" role="alert">
            <p className="text-[15px]">{dup.message}.</p>
            <div className="mt-3 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => {
                  onClose()
                  onOpen(dup.existing.id)
                }}
                className={hrBtn.smallRed}
              >
                Открыть заявку
              </button>
              <button type="button" onClick={() => void submit(null, true)} className={hrBtn.smallGhost}>
                Всё равно добавить
              </button>
            </div>
          </div>
        )}
        {errors.form && <Notice tone="error">{errors.form}</Notice>}
        {errors.source && <Notice tone="error">{errors.source}</Notice>}
        <button type="submit" disabled={busy || !form.name.trim() || (!form.phone.trim() && !form.contact.trim())} className={`${hrBtn.red} w-full sm:w-fit`}>
          {busy ? 'Добавляем' : 'Добавить'}
        </button>
      </form>
    </Dialog>
  )
}
