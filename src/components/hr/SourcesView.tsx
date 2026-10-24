import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { describeSource } from '@shared/hr'
import { encodeQr, qrSvg, QR_QUIET, type QrCode } from '@shared/qr'
import {
  costPeriodLabel,
  kindByCode,
  normalizeSourceCode,
  shortLink,
  sourceKindLabel,
  sourceKinds,
  sourceLinks,
  suggestSourceCode,
  summarizeKinds,
  type SourceCost,
  type SourceDraft,
  type SourceEntry,
  type SourceKindId,
  type SourcesPayload,
  type SourcesSite,
  type UnknownSource,
} from '@shared/sources'
import { ApiError, ApiValidationError, type HrUser } from '../../lib/api'
import { addCost, createSource, deleteCost, deleteSource, updateSource } from '../../lib/hr/sources'
import { nb } from '../../lib/typo'
import { QrImage } from '../../pages/HrFlyer'
import { saveBlob } from './download'
import { formatDate, plural } from './hrUtils'
import { Dialog } from './overlay'
import { loadSources, useSources } from './sourcesCache'
import { useToast } from './toasts'
import { chip, DisabledHint, Empty, HrInput, HrLabel, HrSelect, HrTextArea, hrBtn, Notice, pageTitle, RuDate } from './ui'

// Вкладка «Источники»: реестр меток с названиями, ссылки и QR на каждую метку, плакат A3 и листовка A5,
// метки без названия из заявок и визитов, расходы по меткам. Смотрят все сотрудники, правит администратор.

export const ready: boolean = true

const ghost = hrBtn.smallGhost
/** Действие в строке списка — текстом: двадцать одинаковых кнопок подряд превращают список в шум */
const rowAction = hrBtn.text
const sectionTitle = 'font-display text-[28px] leading-none font-black uppercase'

/** 15000 → «15 000 ₽» без переноса внутри суммы */
const rub = (n: number) => `${n.toLocaleString('ru-RU').replace(/\s/g, '\u00a0')}\u00a0₽`

/** Первая ошибка ответа сервера — человеческим текстом */
function errorText(e: unknown): string {
  if (e instanceof ApiValidationError) return Object.values(e.errors)[0] ?? 'Проверь поля'
  if (e instanceof ApiError && e.status === 403) return 'Править может только администратор'
  if (e instanceof ApiError && e.data.error === 'has_costs') return 'По метке записаны расходы. Сначала удали их'
  if (e instanceof ApiError && e.data.error === 'builtin') return 'Это встроенная метка, её не удалить'
  if (e instanceof ApiError && typeof e.data.errors === 'object' && e.data.errors) return Object.values(e.data.errors as Record<string, string>)[0]
  return 'Не получилось. Проверь связь и попробуй ещё раз'
}

export function SourcesView({ user }: { user: HrUser }) {
  const data = useSources()
  const [failed, setFailed] = useState(false)
  const [kind, setKind] = useState<SourceKindId | 'all'>('all')
  const [query, setQuery] = useState('')
  const [qrFor, setQrFor] = useState<SourceEntry | null>(null)
  const [editing, setEditing] = useState<SourceEntry | null>(null)
  const [naming, setNaming] = useState<UnknownSource | null>(null)

  useEffect(() => {
    void loadSources(true).then((p) => setFailed(!p))
  }, [])

  const canEdit = Boolean(data?.canEdit) && user.role === 'admin'
  const reload = () => loadSources(true)

  if (!data) {
    return (
      <section aria-labelledby="sources-title">
        <h1 id="sources-title" className={pageTitle}>
          Источники
        </h1>
        <div className="mt-6">{failed ? <Notice tone="error">Реестр меток не загрузился. Обнови страницу.</Notice> : <p className="text-white/60">Загружаем метки</p>}</div>
      </section>
    )
  }

  const visible = data.sources.filter((s) => {
    if (kind !== 'all' && s.kind !== kind) return false
    const q = query.trim().toLowerCase()
    return !q || s.name.toLowerCase().includes(q) || s.code.includes(q)
  })
  const kindsInUse = sourceKinds.filter((k) => data.sources.some((s) => s.kind === k.id))

  return (
    <section aria-labelledby="sources-title">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 id="sources-title" className={pageTitle}>
            Источники
          </h1>
          <p className="mt-3 max-w-2xl text-[15px] leading-snug text-white/65">
            {nb(
              'Метка в ссылке и QR показывает, откуда пришёл кандидат. Экскурсии, музей, инженерные классы, вузы, ярмарки, работные сайты и соцсети сходятся в одну воронку.',
            )}
          </p>
        </div>
      </div>

      <div className="mt-10 grid gap-14 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] xl:gap-16">
        <div className="min-w-0">
          <KindTable data={data} />
          <div className="mt-14 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <h2 className={sectionTitle}>Метки</h2>
            <label className="block w-full sm:w-64">
              <span className="sr-only">Найти метку</span>
              <HrInput type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Название или метка" />
            </label>
          </div>
          <div className="-mx-4 mt-5 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0" role="group" aria-label="Тип точки">
            <button type="button" className={`${chip(kind === 'all')} shrink-0`} aria-pressed={kind === 'all'} onClick={() => setKind('all')}>
              Все · {data.sources.length}
            </button>
            {kindsInUse.map((k) => (
              <button key={k.id} type="button" className={`${chip(kind === k.id)} shrink-0`} aria-pressed={kind === k.id} onClick={() => setKind(k.id)}>
                {k.label} · {data.sources.filter((s) => s.kind === k.id).length}
              </button>
            ))}
          </div>
          <ul className="mt-6 border-t border-white/15">
            {visible.map((s) => (
              <SourceRow key={s.code} source={s} canEdit={canEdit} onQr={() => setQrFor(s)} onEdit={() => setEditing(s)} />
            ))}
          </ul>
          {!visible.length && (
            <Empty title="Ничего не нашлось" action={query || kind !== 'all' ? { label: 'Показать все метки', onClick: () => (setQuery(''), setKind('all')) } : undefined}>
              Поищи по-другому: по названию или по самой метке.
            </Empty>
          )}
        </div>

        <div className="min-w-0 xl:sticky xl:top-20 xl:self-start">
          {canEdit ? (
            <div>
              <h2 className={sectionTitle}>Новая метка</h2>
              <p className="mt-3 text-[14px] leading-snug text-white/55">
                {nb('Своя метка на каждую точку: ярмарку, экскурсию, вуз, пост. Тогда «Воронка» покажет, что из этого приводит людей.')}
              </p>
              <SourceForm site={data.site} taken={data.sources} onSaved={reload} />
            </div>
          ) : (
            <Notice>{nb('Метки и расходы правит администратор. За новой меткой для ярмарки, экскурсии или поста обращайся к нему. Ссылки, QR, плакат и листовка доступны всем.')}</Notice>
          )}
        </div>
      </div>

      <UnknownSection list={data.unknown} canEdit={canEdit} onName={setNaming} />

      <CostsSection data={data} canEdit={canEdit} onChanged={reload} />

      <QrDialog source={qrFor} site={data.site} onClose={() => setQrFor(null)} />

      <Dialog open={Boolean(editing)} title={editing ? editing.name : 'Метка'} onClose={() => setEditing(null)}>
        {editing && (
          <EditForm
            source={editing}
            onDone={async () => {
              setEditing(null)
              await reload()
            }}
          />
        )}
      </Dialog>

      <Dialog open={Boolean(naming)} title="Дать название" onClose={() => setNaming(null)}>
        {naming && (
          <SourceForm
            site={data.site}
            taken={data.sources}
            fixedCode={naming.code}
            initialKind={kindByCode(naming.code)}
            onSaved={async () => {
              setNaming(null)
              await reload()
            }}
          />
        )}
      </Dialog>
    </section>
  )
}

// ── Сводка по типам ──────────────────────────────────────────────────────────

/** Все точки контакта одной таблицей: сколько меток, заявок и потрачено по каждому типу за всё время */
function KindTable({ data }: { data: SourcesPayload }) {
  const rows = summarizeKinds(data.sources, data.costs)
  const total = rows.reduce((acc, r) => ({ codes: acc.codes + r.codes, applications: acc.applications + r.applications, cost: acc.cost + r.cost }), { codes: 0, applications: 0, cost: 0 })
  const cell = 'py-2.5 pr-4 text-right whitespace-nowrap tabular-nums'
  const last = 'py-2.5 text-right whitespace-nowrap tabular-nums'
  return (
    <div>
      <h2 className={sectionTitle}>Точки контакта</h2>
      <p className="mt-3 text-[14px] text-white/55">{nb('Заявки и расходы за всё время. По периодам их видно в «Воронке».')}</p>
      <div className="mt-5">
        <table className="w-full border-t border-white/15 text-[15px]">
          <thead>
            <tr className="border-b border-white/30 text-left text-[12px] tracking-[0.06em] text-white/65 uppercase">
              <th scope="col" className="py-2 pr-4 font-normal">
                Тип
              </th>
              <th scope="col" className="hidden py-2 pr-4 text-right font-normal sm:table-cell">
                Меток
              </th>
              <th scope="col" className="py-2 pr-4 text-right font-normal">
                Заявок
              </th>
              <th scope="col" className="py-2 text-right font-normal">
                Расход
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.kind.id} className="border-b border-white/10">
                <th scope="row" className="py-2.5 pr-4 text-left font-normal">
                  {r.kind.label}
                </th>
                <td className={`${cell} hidden sm:table-cell`}>{r.codes}</td>
                <td className={cell}>{r.applications}</td>
                <td className={last}>{r.cost ? rub(r.cost) : '—'}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-medium">
              <th scope="row" className="py-2.5 pr-4 text-left">
                Итого
              </th>
              <td className={`${cell} hidden sm:table-cell`}>{total.codes}</td>
              <td className={cell}>{total.applications}</td>
              <td className={last}>{total.cost ? rub(total.cost) : '—'}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}

// ── Строка метки ─────────────────────────────────────────────────────────────

function SourceRow({ source: s, canEdit, onQr, onEdit }: { source: SourceEntry; canEdit: boolean; onQr: () => void; onEdit: () => void }) {
  return (
    <li className="flex flex-col gap-3 border-b border-white/15 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <p className="text-[17px] font-medium break-words">{s.name}</p>
        <p className="mt-0.5 text-[14px] break-all text-white/55">
          <span className="text-white/80">{s.code}</span> · {sourceKindLabel(s.kind)}
          {s.builtin ? ' · встроенная' : ''}
        </p>
        {s.note && <p className="mt-1 text-[14px] break-words text-white/55">{s.note}</p>}
        <p className="mt-1 text-[13px] text-white/60">{s.applications ? plural(s.applications, 'заявка', 'заявки', 'заявок') : 'Заявок пока нет'}</p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-x-5 self-start">
        <button type="button" onClick={onQr} className={rowAction}>
          QR и ссылки
        </button>
        {canEdit && (
          <button type="button" onClick={onEdit} className={rowAction} aria-label={`Править: ${s.name}`}>
            Править
          </button>
        )}
      </div>
    </li>
  )
}

// ── Новая метка и «Дать название» ───────────────────────────────────────────

function FieldError({ id, text }: { id: string; text?: string }) {
  return text ? (
    <p id={id} className="mt-1.5 text-[14px] text-brand-bright">
      {text}
    </p>
  ) : null
}

function SourceForm({
  site,
  taken,
  fixedCode,
  initialKind = 'fair',
  onSaved,
}: {
  site: SourcesSite
  taken: SourceEntry[]
  /** «Дать название» незнакомой метке: метка уже есть в заявках, менять её нельзя */
  fixedCode?: string
  initialKind?: SourceKindId
  onSaved: () => void | Promise<unknown>
}) {
  const id = useId()
  const toast = useToast()
  const [kind, setKind] = useState<SourceKindId>(initialKind)
  const [name, setName] = useState('')
  const [code, setCode] = useState(fixedCode ?? '')
  const [codeTouched, setCodeTouched] = useState(Boolean(fixedCode))
  const [note, setNote] = useState('')
  const [errors, setErrors] = useState<Partial<Record<keyof SourceDraft, string>>>({})
  const [busy, setBusy] = useState(false)

  // Пока метку не правили руками, она следует за типом и названием
  const shownCode = codeTouched ? code : suggestSourceCode(kind, name)
  const duplicate = !fixedCode && taken.some((s) => s.code === shownCode)
  const meta = sourceKinds.find((k) => k.id === kind)!

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (duplicate) {
      setErrors({ code: 'Такая метка уже есть в реестре' })
      return
    }
    setBusy(true)
    setErrors({})
    try {
      const { source } = await createSource({ code: shownCode, name, kind, note })
      toast({ text: `Метка ${source.code} добавлена`, detail: `В «Воронке» и карточках она будет называться «${source.name}».` })
      setName('')
      setNote('')
      setCode('')
      setCodeTouched(Boolean(fixedCode))
      await onSaved()
    } catch (err) {
      if (err instanceof ApiValidationError) setErrors(err.errors)
      else if (err instanceof ApiError && err.status === 409) setErrors({ code: 'Такая метка уже есть в реестре' })
      else toast({ text: 'Метка не сохранилась', detail: errorText(err), tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="mt-6 grid gap-5" noValidate>
      {fixedCode && (
        <p className="text-[15px] leading-snug text-white/70">
          {nb('Метка')} <span className="font-medium text-white">{fixedCode}</span>{' '}
          {nb('уже есть в заявках или визитах. Название появится в «Воронке», карточках и списке, а метка уйдёт из «Меток без названия».')}
        </p>
      )}
      <div>
        <HrLabel htmlFor={`${id}-kind`}>Тип точки</HrLabel>
        <HrSelect id={`${id}-kind`} value={kind} onChange={(e) => setKind(e.target.value as SourceKindId)}>
          {sourceKinds.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
            </option>
          ))}
        </HrSelect>
        <p className="mt-1.5 text-[13px] text-white/60">{nb(meta.hint)}</p>
      </div>
      <div>
        <HrLabel htmlFor={`${id}-name`}>Название</HrLabel>
        <HrInput
          id={`${id}-name`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={kind === 'fair' ? 'Например: Ярмарка МИСИС' : kind === 'excursion' ? 'Например: Экскурсия МГУПП, весна' : 'Как назвать в «Воронке»'}
          maxLength={80}
          aria-invalid={Boolean(errors.name)}
          aria-describedby={errors.name ? `${id}-name-error` : undefined}
          required
        />
        <FieldError id={`${id}-name-error`} text={errors.name} />
      </div>
      {!fixedCode && (
        <div>
          <HrLabel htmlFor={`${id}-code`}>Метка</HrLabel>
          <HrInput
            id={`${id}-code`}
            value={shownCode}
            onChange={(e) => {
              setCodeTouched(true)
              setCode(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40))
            }}
            onBlur={() => codeTouched && setCode((c) => normalizeSourceCode(c))}
            placeholder={`Например: ${meta.prefix || 'qr-'}mgupp`}
            spellCheck={false}
            autoCapitalize="off"
            aria-invalid={Boolean(errors.code) || duplicate}
            aria-describedby={`${id}-code-help`}
            required
          />
          <p id={`${id}-code-help`} className="mt-1.5 text-[13px] text-white/60">
            {nb('Латиница, цифры и дефис, до 40 знаков. После печати QR метку не меняют.')}
          </p>
          <FieldError id={`${id}-code-error`} text={duplicate ? 'Такая метка уже есть в реестре' : errors.code} />
          {shownCode && !duplicate && !errors.code && <p className="mt-2 text-[14px] break-all text-white/70">{shortLink(sourceLinks(shownCode, site).site)}</p>}
        </div>
      )}
      <div>
        <HrLabel htmlFor={`${id}-note`}>Заметка</HrLabel>
        <HrTextArea id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={300} placeholder="Где стоит QR, кто отвечает" />
        <FieldError id={`${id}-note-error`} text={errors.note} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={hrBtn.red} disabled={busy || !name.trim() || !shownCode}>
          {fixedCode ? 'Сохранить название' : 'Добавить метку'}
        </button>
        {!name.trim() && <DisabledHint>Впиши название</DisabledHint>}
      </div>
    </form>
  )
}

// ── Правка ──────────────────────────────────────────────────────────────────

function EditForm({ source, onDone }: { source: SourceEntry; onDone: () => void | Promise<unknown> }) {
  const id = useId()
  const toast = useToast()
  const [name, setName] = useState(source.name)
  const [kind, setKind] = useState<SourceKindId>(source.kind)
  const [note, setNote] = useState(source.note)
  const [errors, setErrors] = useState<Partial<Record<keyof SourceDraft, string>>>({})
  const [busy, setBusy] = useState(false)

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await updateSource(source.code, { name, kind, note })
      toast({ text: 'Метка сохранена' })
      await onDone()
    } catch (err) {
      if (err instanceof ApiValidationError) setErrors(err.errors)
      else toast({ text: 'Не сохранилось', detail: errorText(err), tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!window.confirm(`Убрать метку ${source.code} из реестра? Заявки останутся, вместо названия будет код.`)) return
    setBusy(true)
    try {
      await deleteSource(source.code)
      toast({ text: `Метка ${source.code} убрана из реестра` })
      await onDone()
    } catch (err) {
      toast({ text: 'Не удалилось', detail: errorText(err), tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={save} className="grid gap-5" noValidate>
      <p className="text-[15px] text-white/70">
        {nb('Метка')} <span className="font-medium text-white">{source.code}</span> {nb('не меняется: она уже в ссылках и напечатанных QR.')}
      </p>
      <div>
        <HrLabel htmlFor={`${id}-name`}>Название</HrLabel>
        <HrInput id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} aria-invalid={Boolean(errors.name)} />
        <FieldError id={`${id}-name-error`} text={errors.name} />
      </div>
      <div>
        <HrLabel htmlFor={`${id}-kind`}>Тип точки</HrLabel>
        <HrSelect id={`${id}-kind`} value={kind} onChange={(e) => setKind(e.target.value as SourceKindId)}>
          {sourceKinds.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
            </option>
          ))}
        </HrSelect>
      </div>
      <div>
        <HrLabel htmlFor={`${id}-note`}>Заметка</HrLabel>
        <HrTextArea id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={300} />
        <FieldError id={`${id}-note-error`} text={errors.note} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button type="submit" className={hrBtn.red} disabled={busy || !name.trim()}>
          Сохранить
        </button>
        {!source.builtin && (
          <button type="button" onClick={() => void remove()} disabled={busy} className={`${hrBtn.small} text-brand-bright ring-1 ring-brand/60 ring-inset hover:ring-brand`}>
            Убрать из реестра
          </button>
        )}
      </div>
    </form>
  )
}

// ── QR и ссылки ─────────────────────────────────────────────────────────────

type Target = 'site' | 'telegram' | 'max'

/** PNG 1024 × 1024: модуль — целое число пикселей, код по центру, свободное поле не меньше 4 модулей */
function savePng(qr: QrCode, name: string) {
  const SIZE = 1024
  const scale = Math.floor(SIZE / (qr.size + QR_QUIET * 2))
  const offset = Math.floor((SIZE - scale * qr.size) / 2)
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, SIZE, SIZE)
  ctx.fillStyle = '#000'
  qr.modules.forEach((row, y) => row.forEach((dark, x) => dark && ctx.fillRect(offset + x * scale, offset + y * scale, scale, scale)))
  canvas.toBlob((blob) => blob && saveBlob(blob, name), 'image/png')
}

function QrDialog({ source, site, onClose }: { source: SourceEntry | null; site: SourcesSite; onClose: () => void }) {
  const toast = useToast()
  const [target, setTarget] = useState<Target>('site')
  useEffect(() => setTarget('site'), [source?.code])
  const links = source ? sourceLinks(source.code, site) : null
  const url = links ? (links[target] ?? links.site) : ''
  const qr = useMemo(() => (url ? encodeQr(url) : null), [url])

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast({ text: 'Ссылка скопирована' })
    } catch {
      toast({ text: 'Не скопировалось', detail: 'Выдели ссылку и скопируй вручную.', tone: 'error' })
    }
  }

  const file = source ? `qr-${source.code}${target === 'site' ? '' : `-${target}`}` : 'qr'
  const targets: { id: Target; label: string; url: string | null; missing: string; inactive: boolean }[] = links
    ? [
        { id: 'site', label: 'Сайт', url: links.site, missing: '', inactive: false },
        { id: 'telegram', label: 'Бот в Telegram', url: links.telegram, missing: 'Имя бота в Telegram не задано в настройках сервера, поэтому ссылки нет.', inactive: !site.active.telegram },
        { id: 'max', label: 'Бот в MAX', url: links.max, missing: 'Имя бота в MAX не задано в настройках сервера, поэтому ссылки нет.', inactive: !site.active.max },
      ]
    : []
  const poster = (format: 'a3' | 'a5') => `/hr/poster?src=${encodeURIComponent(source?.code ?? '')}${format === 'a5' ? '&format=a5' : ''}`

  return (
    <Dialog open={Boolean(source)} title={source?.name ?? 'QR'} onClose={onClose} wide>
      {source && links && qr && (
        <div className="grid gap-6 md:grid-cols-[220px_minmax(0,1fr)] md:gap-8">
          <div>
            <QrImage qr={qr} title={`QR: ${shortLink(url)}`} className="w-full max-w-[260px]" />
            <p className="mt-2 text-[13px] text-white/60">
              {nb(`Версия ${qr.version}, коррекция M. Печатай не меньше 3\u00a0×\u00a03\u00a0см.`)}
            </p>
          </div>
          <div className="min-w-0">
            {targets.filter((t) => t.url).length > 1 && (
              <>
                <p className="font-display text-[15px] font-extrabold tracking-[0.06em] text-white/60 uppercase">Куда ведёт QR</p>
                <div className="mt-2 mb-5 flex flex-wrap gap-2" role="group" aria-label="Куда ведёт QR">
                  {targets
                    .filter((t) => t.url)
                    .map((t) => (
                      <button key={t.id} type="button" className={chip(target === t.id)} aria-pressed={target === t.id} onClick={() => setTarget(t.id)}>
                        {t.label}
                      </button>
                    ))}
                </div>
              </>
            )}
            <ul className="grid gap-3">
              {targets.map((t) => (
                <li key={t.id} className="text-[14px]">
                  <span className="text-white/60">{t.label}</span>
                  {t.url ? (
                    <div className="mt-0.5 flex items-start justify-between gap-3">
                      <a href={t.url} target="_blank" rel="noreferrer" className="min-w-0 break-all text-white underline-offset-4 hover:underline">
                        {t.url}
                      </a>
                      <button type="button" className={`${ghost} shrink-0`} onClick={() => void copy(t.url!)} aria-label={`Скопировать ссылку: ${t.label}`}>
                        Копировать
                      </button>
                    </div>
                  ) : (
                    <p className="mt-0.5 text-white/55">{nb(t.missing)}</p>
                  )}
                  {t.url && t.inactive && <p className="mt-1 text-[13px] text-periwinkle">{nb('Бот сейчас не запущен на сервере. Проверь ссылку перед печатью.')}</p>}
                </li>
              ))}
            </ul>
            <div className="mt-6 flex flex-wrap gap-2">
              <button type="button" className={hrBtn.smallRed} onClick={() => saveBlob(new Blob([qrSvg(qr, { size: '30mm', title: shortLink(url) })], { type: 'image/svg+xml' }), `${file}.svg`)}>
                SVG для печати
              </button>
              <button type="button" className={ghost} onClick={() => savePng(qr, `${file}.png`)}>
                PNG 1024 px
              </button>
            </div>
            <div className="mt-6 border-t border-white/15 pt-5">
              <p className="text-[14px] text-white/60">{nb('На плакате и листовке будет QR на сайт с этой меткой. Печать из браузера: в PDF или на принтер.')}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <a href={poster('a3')} target="_blank" rel="noreferrer" className={ghost}>
                  Плакат A3
                </a>
                <a href={poster('a5')} target="_blank" rel="noreferrer" className={ghost}>
                  Листовка A5
                </a>
              </div>
            </div>
          </div>
        </div>
      )}
    </Dialog>
  )
}

// ── Метки без названия ──────────────────────────────────────────────────────

function UnknownSection({ list, canEdit, onName }: { list: UnknownSource[]; canEdit: boolean; onName: (u: UnknownSource) => void }) {
  return (
    <div className="mt-16">
      <h2 className={sectionTitle}>Метки без названия</h2>
      <p className="mt-3 max-w-2xl text-[14px] leading-snug text-white/55">
        {nb('Встречаются в заявках, на сайте или в ботах, а в реестре их нет. Пока у метки нет названия, «Воронка» подсвечивает её и показывает код.')}
      </p>
      {list.length ? (
        <ul className="mt-6 border-t border-white/15">
          {list.map((u) => (
            <li key={u.code} className="flex flex-col gap-3 border-b border-white/15 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
              <div className="min-w-0">
                <p className="text-[17px] font-medium break-all">{u.code}</p>
                <p className="mt-0.5 text-[14px] text-white/55">
                  {u.guess !== u.code ? `Сейчас подписана «${u.guess}» · ` : ''}
                  {plural(u.applications, 'заявка', 'заявки', 'заявок')} · {plural(u.visitors, 'человек', 'человека', 'человек')} {nb('на сайте и в ботах')} ·{' '}
                  {nb(`последний раз ${formatDate(u.lastSeen)}`)}
                </p>
              </div>
              {canEdit && (
                <button type="button" className={`${rowAction} self-start sm:self-auto`} onClick={() => onName(u)} aria-label={`Дать название метке ${u.code}`}>
                  Дать название
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <Empty title="Все метки названы">{nb('Новые появятся здесь, как только кто-то придёт по ссылке с меткой, которой нет в реестре.')}</Empty>
      )}
    </div>
  )
}

// ── Расходы ─────────────────────────────────────────────────────────────────

function CostsSection({ data, canEdit, onChanged }: { data: SourcesPayload; canEdit: boolean; onChanged: () => Promise<unknown> }) {
  const toast = useToast()
  const names = Object.fromEntries(data.sources.map((s) => [s.code, s.name]))
  const total = data.costs.reduce((n, c) => n + c.amount, 0)

  const remove = async (c: SourceCost) => {
    if (!window.confirm(`Удалить расход ${rub(c.amount)} по метке ${c.code}?`)) return
    try {
      await deleteCost(c.id)
      toast({ text: 'Расход удалён' })
      await onChanged()
    } catch (err) {
      toast({ text: 'Не удалилось', detail: errorText(err), tone: 'error' })
    }
  }

  return (
    <div className="mt-16 grid gap-14 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] xl:gap-16">
      <div className="min-w-0">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className={sectionTitle}>Расходы</h2>
          {total > 0 && <p className="text-[15px] text-white/70 tabular-nums">Всего {rub(total)}</p>}
        </div>
        <p className="mt-3 max-w-2xl text-[14px] leading-snug text-white/55">
          {nb(
            'Сколько потратили на стенд, печать и рекламу по каждой метке. В «Воронке» расход попадает в период целиком, если его срок с периодом пересекается. Расход без срока учитывается в любом периоде.',
          )}
        </p>
        {data.costs.length ? (
          <ul className="mt-6 border-t border-white/15">
            {data.costs.map((c) => (
              <li key={c.id} className="flex flex-col gap-2 border-b border-white/15 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
                <div className="min-w-0">
                  <p className="text-[17px] font-medium tabular-nums">{rub(c.amount)}</p>
                  <p className="mt-0.5 text-[14px] break-words text-white/70">
                    {describeSource(c.code, names).label} · <span className="text-white/55">{c.code}</span>
                  </p>
                  <p className="mt-0.5 text-[14px] break-words text-white/55">
                    {costPeriodLabel(c)}
                    {c.comment ? ` · ${c.comment}` : ''}
                    {c.demo ? ' · демо-данные' : c.authorName ? ` · ${c.authorName}` : ''}
                  </p>
                </div>
                {canEdit && (
                  <button type="button" className={`${rowAction} self-start`} onClick={() => void remove(c)} aria-label={`Удалить расход ${rub(c.amount)}, ${c.code}`}>
                    Удалить
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="Расходов нет">{canEdit ? nb('Запиши первый расход справа: сколько стоил стенд или печать.') : nb('Расходы записывает администратор.')}</Empty>
        )}
      </div>
      <div className="min-w-0">{canEdit && <CostForm sources={data.sources} onSaved={onChanged} />}</div>
    </div>
  )
}

function CostForm({ sources, onSaved }: { sources: SourceEntry[]; onSaved: () => Promise<unknown> }) {
  const id = useId()
  const toast = useToast()
  const options = sources.filter((s) => s.kind !== 'own')
  const [code, setCode] = useState('')
  const [amount, setAmount] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [comment, setComment] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!code) {
      setErrors({ code: 'Выбери метку' })
      return
    }
    setBusy(true)
    setErrors({})
    try {
      await addCost(code, { amount, comment, from, to })
      toast({ text: 'Расход записан', detail: 'Он уже в «Воронке» за подходящие периоды.' })
      setAmount('')
      setComment('')
      setFrom('')
      setTo('')
      await onSaved()
    } catch (err) {
      if (err instanceof ApiValidationError) setErrors(err.errors)
      else toast({ text: 'Расход не записан', detail: errorText(err), tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const field = (name: string, label: string, control: ReactNode) => (
    <div>
      <HrLabel htmlFor={`${id}-${name}`}>{label}</HrLabel>
      {control}
      <FieldError id={`${id}-${name}-error`} text={errors[name]} />
    </div>
  )

  return (
    <form onSubmit={submit} className="grid gap-5" noValidate>
      <h2 className={sectionTitle}>Новый расход</h2>
      {field(
        'code',
        'Метка',
        <HrSelect id={`${id}-code`} value={code} onChange={(e) => setCode(e.target.value)} aria-invalid={Boolean(errors.code)}>
          <option value="">Выбери метку</option>
          {sourceKinds
            .filter((k) => options.some((s) => s.kind === k.id))
            .map((k) => (
              <optgroup key={k.id} label={k.label}>
                {options
                  .filter((s) => s.kind === k.id)
                  .map((s) => (
                    <option key={s.code} value={s.code}>
                      {s.name} · {s.code}
                    </option>
                  ))}
              </optgroup>
            ))}
        </HrSelect>,
      )}
      {field(
        'amount',
        'Сумма, ₽',
        <HrInput id={`${id}-amount`} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="numeric" placeholder="15 000" aria-invalid={Boolean(errors.amount)} />,
      )}
      <div className="grid grid-cols-2 gap-4">
        {field('from', 'С', <><HrInput id={`${id}-from`} type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-invalid={Boolean(errors.from)} /><RuDate value={from} className="mt-1 block" /></>)}
        {field('to', 'По', <><HrInput id={`${id}-to`} type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-invalid={Boolean(errors.to)} /><RuDate value={to} className="mt-1 block" /></>)}
      </div>
      <p className="-mt-2 text-[13px] text-white/60">{nb('Срок можно не указывать: тогда расход идёт в любой период «Воронки».')}</p>
      {field(
        'comment',
        'Комментарий',
        <HrInput id={`${id}-comment`} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={200} placeholder="Стенд и печать листовок" />,
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={hrBtn.red} disabled={busy || !amount.trim()}>
          Записать расход
        </button>
        {!amount.trim() && <DisabledHint>Впиши сумму</DisabledHint>}
      </div>
    </form>
  )
}
