import { useMemo, useState } from 'react'
import { manualConsents, type HrApplication, type ManualConsent } from '@shared/applications'
import { ageOn, ageWords } from '@shared/birthDate'
import { vacancies } from '@shared/content/vacancies'
import { SourceOptions } from './SourceOptions'
import { dedupeKeys, fileDuplicates, IMPORT_MAX_BYTES, importFields, mapRow, matchVacancy, vacancyKey, vacancyMonths, type ImportMapping } from '@shared/hrImport'
import { seasonMonths } from '../../lib/season'
import { getVacancyMap, parseImportFile, type HrUser, type ImportReport, type ParsedTable, type Staff } from '../../lib/api'
import { commitImportAssigned, type ImportAssign } from '../../lib/hr/desk'
import { formatPhone, monthsRange, vacancyTitle } from './hrUtils'
import { Dialog } from './overlay'
import { chip, HrLabel, HrSelect, hrBtn, Notice } from './ui'

/**
 * Импорт кандидатов из файла: выгрузка откликов с hh.ru (.xlsx или .csv) или любая таблица с похожими колонками.
 * Шаги: файл → сопоставление колонок и вакансий, предпросмотр → отчёт. Номера строк — как в файле.
 */
export function ImportDialog({
  open,
  apps,
  me,
  staff,
  onClose,
  onImported,
}: {
  open: boolean
  apps: HrApplication[]
  me: HrUser
  staff: Staff[]
  onClose: () => void
  onImported: () => void
}) {
  const [table, setTable] = useState<(ParsedTable & { file: string }) | null>(null)
  const [mapping, setMapping] = useState<ImportMapping>({})
  const [vacancyMap, setVacancyMap] = useState<Record<string, string>>({})
  const [source, setSource] = useState('hh')
  const [skipDuplicates, setSkipDuplicates] = useState(true)
  // Месяцы для строк без месяцев в файле: по сроку вакансии на сайте или выбранные HR
  const [defaultMonths, setDefaultMonths] = useState<'vacancy' | number[]>('vacancy')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<ImportReport | null>(null)
  // Кто ведёт новые заявки: я, никто или поровну между отмеченными сотрудниками
  const [assignMode, setAssignMode] = useState<ImportAssign['assign']>('me')
  const [assignees, setAssignees] = useState<number[] | null>(null)
  // Основание для обработки данных у всех строк файла: выбрать нужно явно
  const [consentBasis, setConsentBasis] = useState<ManualConsent | ''>('')
  const evenList = assignees ?? staff.map((s) => s.id)
  const assign: ImportAssign = assignMode === 'even' ? { assign: 'even', assignees: staff.map((s) => s.id).filter((id) => evenList.includes(id)) } : { assign: assignMode }

  const reset = () => {
    setTable(null)
    setMapping({})
    setReport(null)
    setError('')
  }
  const close = () => {
    if (report) onImported()
    reset()
    onClose()
  }

  const pick = async (file: File | undefined) => {
    if (!file) return
    setError('')
    if (file.size > IMPORT_MAX_BYTES) return setError('Файл больше 5 МБ. Раздели выгрузку на части')
    setBusy(true)
    try {
      const [t, saved] = await Promise.all([parseImportFile(file), getVacancyMap().catch(() => ({}))])
      setTable({ ...t, file: file.name })
      setMapping(t.mapping)
      setVacancyMap(saved)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // Строки по текущему сопоставлению, дубли с базой (телефон, почта, резюме) и внутри файла
  const parsed = useMemo(() => {
    if (!table) return null
    const rows = table.rows.map((cells, i) => mapRow(cells, mapping, table.lines[i], vacancyMap))
    const existing = new Map<string, HrApplication>()
    for (const a of apps) if (!a.duplicateOf && !a.anonymizedAt) for (const k of dedupeKeys(a)) existing.set(k, a)
    const repeats = fileDuplicates(rows)
    const marks = rows.map((r) => ({ db: dedupeKeys(r).map((k) => existing.get(k)).find(Boolean), repeat: repeats.get(r.line) ?? null }))
    const ok = rows.filter((r) => !r.problems.length)
    const dups = marks.filter((m, i) => !rows[i].problems.length && (m.db || m.repeat)).length
    const titles = [...new Set(rows.map((r) => r.vacancyTitle).filter(Boolean))]
    const months = rows.map((r) => (r.months.length ? r.months : defaultMonths === 'vacancy' ? vacancyMonths(r.vacancyId) : defaultMonths))
    const withoutMonths = ok.filter((r) => !r.months.length).length
    return { rows, marks, ok: ok.length, invalid: rows.length - ok.length, dups, titles, months, withoutMonths }
  }, [table, mapping, apps, vacancyMap, defaultMonths])

  const run = async () => {
    if (!parsed || !table) return
    setBusy(true)
    setError('')
    try {
      // Запоминаем сопоставления вакансий, которые HR видел в предпросмотре
      const titlesMap = Object.fromEntries(parsed.titles.map((t) => [vacancyKey(t), vacancyMap[vacancyKey(t)] ?? (matchVacancy(t) || 'none')]))
      setReport(await commitImportAssigned(parsed.rows, source, skipDuplicates, { vacancyMap: titlesMap, skipped: table.skipped, defaultMonths, consentBasis: consentBasis || undefined }, assign))
    } catch (e) {
      setError((e as Error).message || 'Импорт не получился')
    } finally {
      setBusy(false)
    }
  }

  const colOptions = table?.headers.map((h, i) => ({ i, label: h || `Колонка ${i + 1}` })) ?? []
  const willImport = parsed ? parsed.ok - (skipDuplicates ? parsed.dups : 0) : 0

  return (
    <Dialog open={open} title={report ? 'Импорт готов' : 'Импорт кандидатов'} onClose={close} wide>
      {report ? (
        <div className="flex flex-col gap-4 text-[15px]">
          <p role="status">
            Добавлено: <b>{report.created.length}</b>. Пропущено дублей: {report.duplicates.length}. С ошибками: {report.invalid.length}.
            {report.skipped.length ? ` Пропущено служебных строк: ${report.skipped.length}.` : ''}
          </p>
          <ReportList title="Не загружены из-за ошибок" items={report.invalid.map((d) => `Строка ${d.line}: ${d.problems.join(', ')}`)} open />
          <ReportList title="Дубли: уже есть в базе или повторяются в файле" items={report.duplicates.map((d) => `Строка ${d.line}: ${d.name}, заявка ${d.existingId} (${d.by})`)} />
          <ReportList title="Загружены с замечаниями" items={report.warnings.map((d) => `Строка ${d.line}: ${d.warnings.join(', ')}`)} />
          <ReportList title="Служебные строки" items={report.skipped.map((d) => `Строка ${d.line}: ${d.reason}`)} />
          <p className="text-[14px] text-white/60">
            Новые заявки стоят в статусе «Новая»
            {assign.assign === 'me' ? ', ответственный ты' : assign.assign === 'none' ? ', без ответственного' : `, поровну между ${assign.assignees.length} сотрудниками`}. В истории записано, из какого файла они пришли.
          </p>
          <button onClick={close} className={`${hrBtn.red} w-fit`}>
            Готово
          </button>
        </div>
      ) : !table ? (
        <div className="flex flex-col gap-5">
          <p className="text-[15px] leading-snug text-white/70">
            Подойдёт выгрузка откликов с&nbsp;hh.ru в&nbsp;Excel или CSV, а&nbsp;также любая таблица с&nbsp;ФИО и&nbsp;телефоном или почтой. До&nbsp;5&nbsp;МБ. Колонки узнаем по
            заголовкам, сопоставление можно поправить.
          </p>
          <div>
            <HrLabel htmlFor="import-source">Откуда кандидаты</HrLabel>
            <HrSelect id="import-source" value={source} onChange={(e) => setSource(e.target.value)}>
              <SourceOptions />
            </HrSelect>
          </div>
          {/* Поле выбора файла скрыто, но фокус на нём виден на кнопке */}
          <label className={`${hrBtn.red} w-fit cursor-pointer focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-brand-bright`}>
            {busy ? 'Читаем файл' : 'Выбрать файл'}
            <input type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" onChange={(e) => void pick(e.target.files?.[0])} />
          </label>
          {error && <Notice tone="error">{error}</Notice>}
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <p className="text-[14px] text-white/65">
            {table.file}: строк с данными {table.rows.length}
            {table.skipped.length ? `, служебных ${table.skipped.length}` : ''}. Проверь, какая колонка за что отвечает.
          </p>
          <div className="grid gap-x-5 gap-y-3 sm:grid-cols-2">
            {importFields.map((f) => (
              <label key={f.id} className="flex min-w-0 flex-col text-[13px] text-white/65">
                {f.label}
                <select
                  value={mapping[f.id] ?? ''}
                  onChange={(e) => setMapping((m) => ({ ...m, [f.id]: e.target.value === '' ? undefined : Number(e.target.value) }))}
                  className="h-9 w-full min-w-0 cursor-pointer border-b border-white/25 bg-coal pr-5 text-[15px] text-white"
                >
                  <option value="">не загружать</option>
                  {colOptions.map((c) => (
                    <option key={c.i} value={c.i}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          {parsed && parsed.titles.length > 0 && (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-[14px] text-white/80">Вакансии из файла → наши. Сопоставление запомним для следующих импортов</legend>
              {parsed.titles.map((t) => {
                const key = vacancyKey(t)
                const value = vacancyMap[key] ?? (matchVacancy(t) || 'none')
                return (
                  <label key={key} className="grid grid-cols-[minmax(0,1fr)] gap-1 text-[14px] sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:items-center sm:gap-4">
                    <span className="break-words text-white/80">{t}</span>
                    <select
                      value={value}
                      onChange={(e) => setVacancyMap((m) => ({ ...m, [key]: e.target.value }))}
                      className="h-9 w-full min-w-0 cursor-pointer border-b border-white/25 bg-coal pr-5 text-[15px] text-white"
                    >
                      <option value="none">не сопоставлять (в комментарий)</option>
                      {vacancies.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.title}
                        </option>
                      ))}
                    </select>
                  </label>
                )
              })}
            </fieldset>
          )}

          {parsed && parsed.withoutMonths > 0 && (
            <fieldset className="flex flex-col gap-2 text-[15px]">
              <legend className="mb-1 text-[14px] text-white/80">
                Без месяцев работы: {parsed.withoutMonths}. По месяцам кандидат попадает в план найма
              </legend>
              <label className="inline-flex cursor-pointer items-center gap-2.5">
                <input type="radio" name="import-months" checked={defaultMonths === 'vacancy'} onChange={() => setDefaultMonths('vacancy')} className="size-4 accent-[var(--color-brand)]" />
                По сроку вакансии на сайте, например «Июнь–август»
              </label>
              <label className="inline-flex cursor-pointer items-center gap-2.5">
                <input
                  type="radio"
                  name="import-months"
                  checked={defaultMonths !== 'vacancy'}
                  onChange={() => setDefaultMonths([6, 7, 8])}
                  className="size-4 accent-[var(--color-brand)]"
                />
                Одни и те же месяцы для всех
              </label>
              {defaultMonths !== 'vacancy' && (
                <div className="flex flex-wrap gap-2 pl-6" role="group" aria-label="Месяцы для всех без месяцев в файле">
                  {seasonMonths.map((m) => {
                    const on = defaultMonths.includes(m.value)
                    return (
                      <button
                        key={m.value}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setDefaultMonths(on ? defaultMonths.filter((x) => x !== m.value) : [...defaultMonths, m.value].sort((a, b) => a - b))}
                        className={chip(on)}
                      >
                        {m.label}
                      </button>
                    )
                  })}
                </div>
              )}
            </fieldset>
          )}

          {parsed && (
            <>
              <p className="text-[15px]" role="status">
                Готово к импорту: {parsed.ok}. Уже есть в базе или повторяются в файле: {parsed.dups}. С ошибками: {parsed.invalid}.
              </p>
              <div className="-mx-5 overflow-x-auto px-5 md:mx-0 md:px-0" tabIndex={0} role="region" aria-label="Предпросмотр импорта, прокручивается по горизонтали">
                <table className="w-full min-w-[640px] border-collapse text-left text-[13px]">
                  <caption className="mb-2 text-left text-[13px] text-white/65">
                    Первые строки файла: кто это, контакты, вакансия и результат проверки. Номер совпадает со строкой в файле
                  </caption>
                  <thead>
                    <tr className="border-b border-white/30 text-[12px] tracking-[0.06em] text-white/60 uppercase">
                      <th className="py-2 pr-3 font-semibold">Строка</th>
                      <th className="py-2 pr-3 font-semibold">Кандидат</th>
                      <th className="py-2 pr-3 font-semibold">Телефон, почта</th>
                      <th className="py-2 pr-3 font-semibold">Вакансия, месяцы</th>
                      <th className="py-2 font-semibold">Проверка</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.rows.slice(0, 10).map((r, i) => {
                      const m = parsed.marks[i]
                      return (
                        <tr key={r.line} className="border-b border-white/10 align-top">
                          <td className="py-2 pr-3 text-white/60 tabular-nums">{r.line}</td>
                          <td className="py-2 pr-3 break-words">
                            {[r.lastName, r.name, r.middleName].filter(Boolean).join(' ') || 'без имени'}
                            {(r.birthDate || r.school) && (
                              <span className="block text-white/60">
                                {[r.birthDate ? ageWords(ageOn(r.birthDate) ?? 0) : '', r.school].filter(Boolean).join(' · ')}
                              </span>
                            )}
                          </td>
                          <td className="py-2 pr-3 break-words tabular-nums">
                            {r.phone && <span className="whitespace-nowrap">{formatPhone(r.phone)}</span>}
                            {r.phone && r.email ? ', ' : ''}
                            {r.email}
                            {!r.phone && !r.email && 'нет'}
                          </td>
                          <td className="py-2 pr-3 break-words">
                            {r.vacancyId ? vacancyTitle(r.vacancyId) : r.vacancyTitle || 'не указана'}
                            <span className="block text-white/60">
                              {parsed.months[i].length ? monthsRange(parsed.months[i]) : 'месяцы не указаны'}
                              {r.months.length || !parsed.months[i].length ? '' : ', по умолчанию'}
                            </span>
                          </td>
                          <td className={`py-2 break-words ${r.problems.length ? 'text-brand-bright' : m.db || m.repeat ? 'text-periwinkle' : 'text-white/70'}`}>
                            {r.problems.length
                              ? r.problems.join(', ')
                              : m.db
                                ? `уже есть: ${[m.db.lastName, m.db.name].filter(Boolean).join(' ')}`
                                : m.repeat
                                  ? `повтор строки ${m.repeat}`
                                  : r.warnings.length
                                    ? `новый; ${r.warnings.join(', ')}`
                                    : 'новый'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {parsed.rows.length > 10 && <p className="text-[13px] text-white/60">Показаны первые 10 строк из {parsed.rows.length}. Все ошибки будут в отчёте.</p>}
              <label className="inline-flex cursor-pointer items-center gap-2.5 text-[15px] text-white/80">
                <input type="checkbox" checked={skipDuplicates} onChange={(e) => setSkipDuplicates(e.target.checked)} className="size-4 accent-[var(--color-brand)]" />
                Не добавлять тех, кто уже есть в базе: совпал телефон, почта или резюме
              </label>
              <fieldset className="flex flex-col gap-2 text-[15px]">
                <legend className="mb-1 text-[14px] text-white/80">Основание для обработки данных (одно для всех строк файла)</legend>
                {manualConsents.map((c) => (
                  <label key={c.id} className="flex cursor-pointer items-start gap-2.5">
                    <input type="radio" name="import-consent" checked={consentBasis === c.id} onChange={() => setConsentBasis(c.id)} className="mt-1 size-4 shrink-0 accent-[var(--color-brand)]" />
                    <span>
                      {c.label}
                      <span className="block text-[13px] text-white/55">{c.hint}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <fieldset className="flex flex-col gap-2 text-[15px]">
                <legend className="mb-1 text-[14px] text-white/80">Кто ведёт новые заявки</legend>
                {(
                  [
                    ['me', `Я (${me.name})`],
                    ['none', 'Без ответственного'],
                    ...(staff.length > 1 ? [['even', 'Поровну между сотрудниками']] : []),
                  ] as [ImportAssign['assign'], string][]
                ).map(([id, label]) => (
                  <label key={id} className="inline-flex cursor-pointer items-center gap-2.5">
                    <input type="radio" name="import-assign" checked={assignMode === id} onChange={() => setAssignMode(id)} className="size-4 accent-[var(--color-brand)]" />
                    {label}
                  </label>
                ))}
                {assignMode === 'even' && (
                  <div className="flex flex-wrap gap-2 pl-6" role="group" aria-label="Между кем раздать">
                    {staff.map((s) => {
                      const on = evenList.includes(s.id)
                      return (
                        <button
                          key={s.id}
                          type="button"
                          aria-pressed={on}
                          onClick={() => setAssignees(on ? evenList.filter((x) => x !== s.id) : [...evenList, s.id])}
                          className={chip(on)}
                        >
                          {s.name}
                        </button>
                      )
                    })}
                  </div>
                )}
              </fieldset>
            </>
          )}
          {error && <Notice tone="error">{error}</Notice>}
          <div className="flex flex-wrap gap-3">
            <button onClick={() => void run()} disabled={busy || !willImport || !consentBasis || (assign.assign === 'even' && !assign.assignees.length)} className={hrBtn.red}>
              {busy ? 'Импортируем' : !consentBasis ? 'Выбери основание' : `Импортировать: ${Math.max(0, willImport)}`}
            </button>
            <button onClick={reset} className={hrBtn.ghost}>
              Другой файл
            </button>
          </div>
        </div>
      )}
    </Dialog>
  )
}

function ReportList({ title, items, open }: { title: string; items: string[]; open?: boolean }) {
  if (!items.length) return null
  return (
    <details open={open}>
      <summary className="cursor-pointer text-white/80">
        {title}: {items.length}
      </summary>
      <ul className="mt-2 flex flex-col gap-1 text-[14px] text-white/75">
        {items.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </details>
  )
}
