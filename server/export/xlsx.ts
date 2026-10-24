import { adaptationStats, type AdaptationStats } from '@shared/adaptation'
import {
  applicationStatuses,
  declineReasons,
  seasonLeaveReasons,
  statusLabel,
  type ApplicationStatus,
  type HrApplication,
} from '@shared/applications'
import {
  caseMetrics,
  companyBaseline,
  describeSource,
  isAnyReferral,
  seasonCounts,
  taskBuckets,
  taskLabels,
  tasksHiring,
  weekLabel,
  type CaseMetrics,
  type ExportApplication,
  type ExportColumn,
  type TasksHiringRow,
} from '@shared/hr'
import { contacts } from '@shared/content/content'
import { vacancyById } from '@shared/content/vacancies'
import { sourceKey } from '@shared/hrFilter'
import { planTotals, type PlanCell } from '@shared/hrPlan'
import type { Attendance, GameShare, InviteRow, ReasonCount } from '../db/funnel'
import type { FunnelReport, FunnelRow, FunnelTasks, WeekRow } from '../db/hr'
import { writeXlsx, type CellStyle, type SheetRow, type SheetSpec } from './xlsxWriter'

// Выгрузка в Excel: шапка закреплена, автофильтр, ширина колонок, даты — настоящими датами
// по Москве, статусы подсвечены цветом. Второй лист — воронка по источникам до конца сезона, явка, приглашения,
// цифры кейса рядом с цифрами компании; третий — недели. Пишем сами, без пакетов (xlsxWriter).

/** Мягкие заливки статусов: читаются в печати и в тёмной теме Excel */
const statusFill: Record<ApplicationStatus, string> = {
  new: 'FFFFFFFF',
  contacted: 'FFEDEDED',
  interview: 'FFFFF0C2',
  hired: 'FFDDEFD0',
  started: 'FFC4E3AE',
  declined: 'FFF7D3D9',
  no_answer: 'FFE3E3E3',
}
const fillByLabel = new Map(applicationStatuses.map((s) => [s.label, statusFill[s.id]]))

const BRAND = 'FFD50032'
const MSK = 3 * 3600e3

/** Excel не знает часовых поясов: пишем «московское» время как есть */
const excelDate = (d: Date) => new Date(d.getTime() + MSK)

const header: CellStyle = { bold: true, color: 'FFFFFFFF', fill: BRAND, valign: 'center', wrap: true }

/**
 * Лист «Воронка». applicationsOnly — воронка только по выгруженным заявкам: посещения сайта
 * к отобранным заявкам не привязать, поэтому колонок «Пришли» и «Прошли задание» в нём нет.
 * Полная воронка приходит целым отчётом { title, ...report }: новые разделы отчёта (FunnelReport)
 * доходят до листа без правок в server/api/hr.ts
 */
/** names — названия меток из реестра «Источники»: без них метка, заведённая в панели, вышла бы «без названия» */
export type FunnelSheet = { title: string; rows: FunnelRow[]; applicationsOnly?: boolean; names?: Record<string, string> } & Partial<Omit<FunnelReport, 'rows'>>

export async function buildWorkbook(list: ExportApplication[], columns: ExportColumn[], funnel?: FunnelSheet, plan?: { season: number; cells: PlanCell[] }): Promise<Buffer> {
  const rows: SheetRow[] = [{ cells: columns.map((c) => c.label), style: header, height: 32 }]
  for (const a of list) {
    const cells = columns.map((c) => {
      const v = c.value(a)
      // Календарный день (дата рождения) — полночь UTC, без сдвига: иначе день уехал бы на соседний
      return v instanceof Date && c.kind !== 'date' ? excelDate(v) : v
    })
    rows.push({
      cells,
      style: { valign: 'top' },
      cellStyles: columns.map((c, i) => {
        if (c.kind === 'datetime') return { numFmt: 'dd.mm.yyyy hh:mm' }
        if (c.kind === 'date') return { numFmt: 'dd.mm.yyyy' }
        if (c.kind === 'status') {
          const fill = fillByLabel.get(String(cells[i] ?? ''))
          return fill ? { fill } : undefined
        }
        return undefined
      }),
    })
  }
  const sheets: SheetSpec[] = [{ name: 'Заявки', widths: columns.map((c) => c.width), rows, freezeRows: 1, filterRow: 1 }]

  if (funnel) sheets.push(funnelSheetSpec(funnel, list))
  if (funnel?.weeks?.length) sheets.push(weeksSheetSpec(funnel))

  if (plan && plan.cells.length) {
    const head = ['Вакансия', 'Месяц', 'Нужно', 'Приняты', 'Вышли на смену', 'Выполнено']
    const out: SheetRow[] = [{ cells: [`План найма на сезон ${plan.season}`], style: { bold: true, size: 13 } }, { cells: [] }, { cells: head, style: header, height: 32 }]
    for (const c of plan.cells)
      out.push({
        cells: [vacancyById(c.vacancyId)?.title ?? c.vacancyId, monthNames[c.month - 1] ?? String(c.month), c.target, c.hired, c.started, c.target ? Math.min(1, c.hired / c.target) : null],
        cellStyles: [, , , , , { numFmt: '0%', ...(c.hired >= c.target ? { fill: 'FFDDEFD0' } : {}) }],
      })
    const t = planTotals(plan.cells)
    out.push({ cells: ['Итого мест по месяцам', '', t.target, t.hired, t.started, t.target ? t.hired / t.target : null], style: { bold: true }, cellStyles: [, , , , , { numFmt: '0%' }] })
    sheets.push({ name: 'План найма', widths: [34, 14, 10, 10, 16, 12], rows: out, freezeRows: 3, filterRow: 3 })
  }

  return writeXlsx(sheets, { creator: 'Очаково · отдел персонала' })
}

const monthNames = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь']

const funnelKeys = ['visitors', 'tasks', 'applyOpen', 'applications', 'interview', 'hired', 'started'] as const
/** Необязательные счётчики строки: итог сезона и расход. Складываются, только если есть у слагаемых */
const extraKeys = ['completed', 'stayed', 'cost'] as const
const emptyFunnelRow = (source: string): FunnelRow => ({ source, visitors: 0, tasks: 0, applyOpen: 0, applications: 0, interview: 0, hired: 0, started: 0 })
const addFunnelRow = (into: FunnelRow, r: FunnelRow) => {
  for (const k of funnelKeys) into[k] += r[k]
  for (const k of extraKeys) if (r[k] !== undefined) into[k] = (into[k] ?? 0) + r[k]!
}
const share = (part: number, whole: number) => (whole ? part / whole : null)
/** Рубли за заявку или выход: при нуле заявок, выходов или расхода — пусто, как «—» в панели */
const perUnit = (cost: number | undefined, n: number) => (cost && n ? Math.round(cost / n) : null)
const RUB = '#,##0 "₽"'
/** Незнакомая метка: в «Воронке» панели она тоже подсвечена */
const UNKNOWN_FILL = 'FFFFF0C2'

/**
 * Строки источников, как в панели: приглашения друзей (с кодом и старые без кода) — одной строкой,
 * вместо меток — названия, метка без названия подписана и подсвечена
 */
export function funnelSourceLines(rows: FunnelRow[], names?: Record<string, string>): { label: string; row: FunnelRow; unknown: boolean }[] {
  const friends = emptyFunnelRow('friends')
  const out: { label: string; row: FunnelRow; unknown: boolean }[] = []
  for (const r of rows) {
    if (isAnyReferral(r.source)) {
      addFunnelRow(friends, r)
      continue
    }
    const d = describeSource(r.source, names)
    const label = r.source === '' ? 'Прямой заход на сайт' : d.kind === 'unknown' ? `Метка без названия: ${r.source}` : d.label
    out.push({ label, row: r, unknown: d.kind === 'unknown' })
  }
  if (funnelKeys.some((k) => friends[k]) || friends.cost) out.push({ label: 'Приглашения друзей', row: friends, unknown: false })
  return out
}

/** Заявки выгрузки в виде, который понимают общие счётчики: у демо без сервера полей HR нет */
const asHr = (list: ExportApplication[]) =>
  list.map((a) => ({
    ...a,
    status: a.status ?? 'new',
    reached: a.reached ?? [],
    duplicateOf: a.duplicateOf ?? null,
    declineReason: a.declineReason ?? '',
    interview: a.interview ?? null,
    seasonOutcome: a.seasonOutcome ?? '',
    seasonLeaveReason: a.seasonLeaveReason ?? '',
    reserve: a.reserve ?? false,
    anonymizedAt: a.anonymizedAt ?? null,
  })) as HrApplication[]

/** Причины по списку: сколько заявок с каждой, по убыванию; пустая причина — «Причина не указана» */
function reasonCounts(list: { reason: string }[], known: { id: string; label: string }[]): ReasonCount[] {
  return [...known.map((r) => ({ reason: r.id, label: r.label })), { reason: '', label: 'Причина не указана' }]
    .map((r) => ({ ...r, count: list.filter((x) => x.reason === r.reason).length }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count)
}

/**
 * Сводка для выгрузки по фильтру: отказы, уходы, явка и цифры кейса — по выгруженным заявкам.
 * Посещений к ним не привязать, поэтому конверсии в найм нет
 */
function summaryOf(list: HrApplication[], now = Date.now()) {
  const live = list.filter((a) => !a.duplicateOf)
  const past = live.filter((a) => a.interview && new Date(a.interview.startsAt).getTime() <= now)
  return {
    declines: reasonCounts(live.filter((a) => a.status === 'declined').map((a) => ({ reason: a.declineReason })), declineReasons),
    leaves: reasonCounts(
      live.filter((a) => a.status === 'started' && a.seasonOutcome === 'left').map((a) => ({ reason: a.seasonLeaveReason })),
      seasonLeaveReasons,
    ),
    attendance: {
      came: past.filter((a) => a.interview!.attended === 'yes').length,
      marked: past.filter((a) => a.interview!.attended !== '').length,
      unmarked: past.filter((a) => a.interview!.attended === '').length,
    },
    caseMetrics: caseMetrics(live, null, now),
  }
}

/**
 * Лист «Воронка»: источники до конца сезона (с расходом, если есть реестр меток), «Задания и наём», «Какое задание
 * ведёт к заявке», явка и причины отказа и ухода, приглашения друзей и цифры кейса рядом с цифрами компании.
 * Для выгрузки по фильтру всё, кроме посещений, считается по выгруженным заявкам: связи с событиями сайта у них нет
 */
function funnelSheetSpec(funnel: FunnelSheet, list: ExportApplication[]): SheetSpec {
  const full = !funnel.applicationsOnly
  const hrList = asHr(list)
  const costs = full && Boolean(funnel.costsKnown)
  const head = [
    'Источник',
    ...(full ? ['Пришли', 'Прошли задание'] : []),
    'Заявка',
    'Собеседование',
    'Приняты',
    'Вышли на смену',
    'Отработали сезон',
    'Отработали, % от вышедших',
    'В штате или резерве',
    'В штате или резерве, % от вышедших',
    ...(full ? ['Конверсия в заявку', 'Конверсия в смену'] : ['Доля дошедших до смены']),
    ...(costs ? ['Расход, ₽', '₽ за заявку', '₽ за выход на смену'] : []),
  ]
  const out: SheetRow[] = [{ cells: [funnel.title], style: { bold: true, size: 13 } }, { cells: [] }, { cells: head, style: header, height: 46 }]
  // В выгрузке по фильтру строки собирает сервер без итога сезона: досчитываем его по выгруженным заявкам
  const withSeason = (r: FunnelRow): FunnelRow =>
    r.completed !== undefined ? r : { ...r, ...seasonCounts(hrList.filter((a) => sourceKey(a) === r.source)) }
  const line = (label: string, raw: FunnelRow, opts: { bold?: boolean; unknown?: boolean } = {}): SheetRow => {
    const r = withSeason(raw)
    const completed = r.completed ?? 0
    const stayed = r.stayed ?? 0
    const pct = { numFmt: '0%' }
    return {
      cells: [
        label,
        ...(full ? [r.visitors, r.tasks] : []),
        r.applications,
        r.interview,
        r.hired,
        r.started,
        completed,
        share(completed, r.started),
        stayed,
        share(stayed, r.started),
        ...(full ? [share(r.applications, r.visitors), share(r.started, r.visitors)] : [share(r.started, r.applications)]),
        ...(costs ? [r.cost ?? 0, perUnit(r.cost, r.applications), perUnit(r.cost, r.started)] : []),
      ],
      style: opts.bold ? { bold: true } : undefined,
      cellStyles: [
        opts.unknown ? { fill: UNKNOWN_FILL } : undefined,
        ...(full ? [undefined, undefined] : []),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        pct,
        undefined,
        pct,
        ...(full ? [pct, { numFmt: '0.0%' }] : [pct]),
        ...(costs ? [{ numFmt: RUB }, { numFmt: RUB }, { numFmt: RUB }] : []),
      ],
    }
  }
  const total = { ...emptyFunnelRow('total'), completed: 0, stayed: 0, ...(costs ? { cost: 0 } : {}) }
  for (const s of funnelSourceLines(funnel.rows, funnel.names)) {
    const r = withSeason(s.row)
    out.push(line(s.label, r, { unknown: s.unknown }))
    addFunnelRow(total, r)
  }
  out.push(line('Итого', total, { bold: true }))
  const filterLastRow = out.length
  if (costs) out.push({ cells: ['Расход взят из реестра меток за период. Поле «₽ за выход на смену» пустое, пока по метке никто не вышел на смену.'] })

  const tasks: Pick<FunnelTasks, 'rows' | 'fullShare'> & Partial<FunnelTasks> = funnel.tasks ?? tasksHiring(hrList)
  out.push(...tasksBlock(tasks))
  if (full && funnel.tasks?.leads.length) out.push(...leadsBlock(funnel.tasks.leads))

  const summary = full && funnel.attendance ? null : summaryOf(hrList)
  out.push(...attendanceBlock(funnel.attendance ?? summary!.attendance))
  out.push(...reasonsBlock('Почему отказ', funnel.declines ?? summary!.declines, 'Отказов нет'))
  out.push(...reasonsBlock('Почему ушли до конца сезона', funnel.leaves ?? summary!.leaves, 'Ушедших до конца сезона нет'))
  if (full && funnel.game) out.push(...gameBlock(funnel.game))
  if (full && funnel.invites) out.push(...invitesBlock(funnel.invites))
  out.push(...caseBlock(funnel.caseMetrics ?? summary!.caseMetrics))
  out.push(...adaptationBlock(adaptationStats(hrList)))

  return { name: 'Воронка', widths: head.map((_, i) => (i === 0 ? 34 : 14)), rows: out, freezeRows: 3, filterRow: 3, filterLastRow, filterCols: head.length }
}

const blockTitle = (title: string): SheetRow[] => [{ cells: [] }, { cells: [title], style: { bold: true, size: 13 } }]

/** Явка на собеседование: доля пришедших среди прошедших собеседований с отметкой */
function attendanceBlock(a: Attendance): SheetRow[] {
  return [
    ...blockTitle('Явка на собеседование'),
    { cells: ['Пришли на собеседование', 'С отметкой', 'Явка', 'Без отметки'], style: header, height: 32 },
    { cells: [a.came, a.marked, share(a.came, a.marked), a.unmarked], cellStyles: [, , { numFmt: '0%' }] },
    { cells: ['Явка считается как доля пришедших среди прошедших собеседований, у которых отмечено «Явка» или «Неявка».'] },
  ]
}

function reasonsBlock(title: string, list: ReasonCount[], empty: string): SheetRow[] {
  const total = list.reduce((n, r) => n + r.count, 0)
  return [
    ...blockTitle(title),
    ...(list.length
      ? [
          { cells: ['Причина', 'Сколько', 'Доля'], style: header, height: 28 } as SheetRow,
          ...list.map((r) => ({ cells: [r.label, r.count, share(r.count, total)], cellStyles: [, , { numFmt: '0%' }] })),
        ]
      : [{ cells: [empty] }]),
  ]
}

const shareKinds: Record<string, string> = { game: 'результатом игры', money: 'расчётом «Собери лето»', invite: 'приглашением' }

/** Игра и «поделиться» на сайте — строки появляются, только когда такие события есть */
function gameBlock(g: GameShare): SheetRow[] {
  const by = Object.entries(g.sharedBy)
    .filter(([, n]) => n)
    .map(([k, n]) => `${shareKinds[k] ?? 'другое'}: ${n}`)
    .join(', ')
  return [
    ...blockTitle('Игра и «поделиться»'),
    { cells: ['Нажали «Играть»', g.started] },
    { cells: ['Поделились', g.shared, by] },
    { cells: ['Пришли по ссылке друга', g.cameByLink] },
    { cells: ['Из них оставили заявку', g.applied, share(g.applied, g.cameByLink)], cellStyles: [, , { numFmt: '0%' }] },
  ]
}

/** Приглашения друзей: кто позвал, кого и вышел ли приглашённый на смену */
function invitesBlock(list: InviteRow[]): SheetRow[] {
  const started = list.filter((r) => r.started).length
  return [
    ...blockTitle('Приглашения друзей'),
    { cells: [`Приглашённых с заявкой: ${list.length}, дошли до смены: ${started}`] },
    ...(list.length
      ? [
          { cells: ['Кто позвал', 'Кого', 'Номер заявки', 'Статус', 'Дошли до смены'], style: header, height: 28 } as SheetRow,
          ...list.map((r) => ({
            cells: [r.inviter || (r.source.startsWith('friend-') ? 'Пригласивший без заявки' : 'Старая ссылка без кода'), r.invited, r.id, statusLabel(r.status), r.started ? 'Да' : 'Нет'],
          })),
        ]
      : []),
  ]
}

const pctText = (v: number) => `${(v * 100).toFixed(v < 0.01 ? 2 : v < 0.1 ? 1 : 0).replace('.', ',')}%`

/** Цифры кейса по данным панели рядом с цифрами компании из кейса */
function caseBlock(m: CaseMetrics): SheetRow[] {
  const b = companyBaseline
  return [
    ...blockTitle('Сравнение с цифрами компании'),
    { cells: ['Показатель', 'По данным панели', 'По данным компании', 'Как считали'], style: header, height: 28 },
    {
      cells: [
        'Конверсия в найм',
        m.hireRate === null ? '—' : pctText(m.hireRate),
        pctText(b.hireRate),
        m.visitors === null
          ? 'В выгрузке по фильтру посещений нет, поэтому конверсию не посчитать. Компания не указала, от чего считала.'
          : `Панель: приняты ${m.hired} из ${m.visitors} пришедших на сайт и в боты. Компания не указала, от чего считала: сравнение ориентировочное.`,
      ],
    },
    {
      cells: [
        'Ушли до конца сезона',
        m.dropout === null ? '—' : pctText(m.dropout),
        pctText(b.probationDropout),
        `Панель: ушли ${m.left} из ${m.left + m.completed}, у кого отмечен итог сезона. Компания: отсев на испытательном сроке; у студентов его нет.`,
      ],
    },
    {
      cells: [
        'Средний возраст принятых',
        m.averageAge === null ? '—' : m.averageAge,
        b.averageAge,
        `Панель: по ${m.withAge} анкетам с датой рождения. Компания: средний возраст всех сотрудников, за год вырос с ${b.averageAgeYearAgo} до ${b.averageAge} лет.`,
      ],
      cellStyles: [, { numFmt: '0.0' }],
    },
  ]
}

/** «Первые недели на смене»: ответы новичков на «Как дела на смене» и уход до конца сезона после «Тяжело» — как в «Воронке» панели */
function adaptationBlock(st: AdaptationStats): SheetRow[] {
  const asked = st.steps.reduce((n, x) => n + x.asked, 0)
  const outcome = (title: string, o: { left: number; total: number }): SheetRow =>
    o.total ? { cells: [title, o.left, o.total, share(o.left, o.total)], cellStyles: [, , , { numFmt: '0%' }] } : { cells: [title, 'итог сезона ещё не отмечен'] }
  if (!asked) return [...blockTitle('Первые недели на смене'), { cells: ['Новичков ещё не спрашивали: вопросы начинаются после первой смены.'] }]
  return [
    ...blockTitle('Первые недели на смене'),
    { cells: ['Когда', 'Спросили', 'Ответили', 'Всё нормально', 'Есть вопрос', 'Тяжело'], style: header, height: 28 },
    ...st.steps.map((x) => ({ cells: [x.label, x.asked, x.answered, x.ok, x.question, x.hard] })),
    { cells: ['Что тяжелее всего', st.reasons.map((r) => `${r.label.toLowerCase()}: ${r.count}`).join(', ') || '—'] },
    { cells: ['', 'Ушли до конца сезона', 'С итогом сезона', 'Доля'], style: header, height: 28 },
    outcome('После ответа «Тяжело»', st.afterHard),
    outcome('Остальные ответившие', st.afterOk),
    { cells: ['Причину эти цифры не доказывают, зато показывают, кому звонить первым.'] },
  ]
}

/** «Задания и наём»: заявки по числу пройденных заданий — до собеседования, неявки, оформления и смены */
function tasksBlock(tasks: { rows: TasksHiringRow[]; fullShare: number | null; target?: number }): SheetRow[] {
  const sum = (k: keyof Omit<TasksHiringRow, 'bucket'>) => tasks.rows.reduce((n, r) => n + r[k], 0)
  const label = (r: TasksHiringRow) => taskBuckets.find((b) => b.id === r.bucket)?.label ?? r.bucket
  const row = (cells: (string | number)[], applications: number, started: number, bold = false): SheetRow => ({
    cells: [...cells, share(started, applications)],
    style: bold ? { bold: true } : undefined,
    cellStyles: [, , , , , , { numFmt: '0%' }],
  })
  return [
    { cells: [] },
    { cells: ['Задания и наём'], style: { bold: true, size: 13 } },
    {
      cells: ['Доля заявок со «Сменой 4/4»', tasks.fullShare, 'цель', tasks.target ?? null],
      cellStyles: [, { numFmt: '0%', bold: true }, , { numFmt: '0%' }],
    },
    { cells: ['Задания', 'Заявки', 'Собеседование', 'Неявка', 'К оформлению', 'На смене', '% до смены'], style: header, height: 32 },
    ...tasks.rows.map((r) => row([label(r), r.applications, r.interview, r.noShow, r.hired, r.started], r.applications, r.started)),
    row(['Итого', sum('applications'), sum('interview'), sum('noShow'), sum('hired'), sum('started')], sum('applications'), sum('started'), true),
  ]
}

/** «Какое задание ведёт к заявке» — только сайт */
function leadsBlock(leads: FunnelTasks['leads']): SheetRow[] {
  return [
    { cells: [] },
    { cells: ['Какое задание ведёт к заявке'], style: { bold: true, size: 13 } },
    { cells: ['Только сайт. Это связь, без доказательства причины: кто и так собирается работать, охотнее проходит задания.'] },
    { cells: ['Задание', 'Прошли', 'Оставили заявку', 'Доля с заявкой'], style: header, height: 32 },
    ...leads.map((l) => ({
      cells: [l.task === 'none' ? 'Без заданий' : taskLabels[l.task], l.visitors, l.applied, share(l.applied, l.visitors)],
      cellStyles: [, , , { numFmt: '0%' }],
    })),
  ]
}

/**
 * Лист «Недели»: заявки недели и как далеко они дошли, первый ответ, отказы по причинам, итог сезона, расход
 * (если есть реестр меток), план и факт. Без личных данных
 */
function weeksSheetSpec(funnel: FunnelSheet): SheetSpec {
  const weeks = funnel.weeks ?? []
  const reasons = [...declineReasons.map((r) => ({ id: r.id as string, label: r.label })), { id: '', label: 'Причина не указана' }].filter((r) =>
    weeks.some((w) => w.declines[r.id]),
  )
  const costs = weeks.some((w) => w.cost !== undefined && w.cost !== null)
  const head = [
    'Неделя',
    'Заявки',
    'Первый ответ, ч (медиана)',
    'Ответ за 24 ч',
    'Собеседование',
    'К оформлению',
    'На смене',
    'Отказы',
    ...reasons.map((r) => `Отказ: ${r.label}`),
    'Отработали сезон',
    'В штате или резерве',
    ...(costs ? ['Расход, ₽', '₽ за заявку', '₽ за выход на смену'] : []),
    'Мест в плане сезона',
    'Закрыто мест к концу недели',
  ]
  const hours = (h: number | null) => (h === null ? null : Math.round(h * 10) / 10)
  const rub = { numFmt: RUB }
  const styles = [
    undefined,
    undefined,
    { numFmt: '0.0' },
    { numFmt: '0%' },
    ...Array(4 + reasons.length + 2).fill(undefined),
    ...(costs ? [rub, rub, rub] : []),
  ]
  const line = (w: Omit<WeekRow, 'start' | 'end'>, label: string, bold = false): SheetRow => ({
    cells: [
      label,
      w.applications,
      hours(w.firstResponseHours),
      w.answered24h,
      w.interview,
      w.hired,
      w.started,
      w.declined,
      ...reasons.map((r) => w.declines[r.id] ?? 0),
      w.completed ?? 0,
      w.stayed ?? 0,
      ...(costs ? [w.cost ?? 0, perUnit(w.cost ?? 0, w.applications), perUnit(w.cost ?? 0, w.started)] : []),
      w.planTarget,
      w.planDone,
    ],
    style: bold ? { bold: true } : undefined,
    cellStyles: styles,
  })
  const sum = (k: 'applications' | 'interview' | 'hired' | 'started' | 'declined' | 'completed' | 'stayed' | 'cost') => weeks.reduce((n, w) => n + (w[k] ?? 0), 0)
  const last = weeks.at(-1)!
  const total: Omit<WeekRow, 'start' | 'end'> = {
    applications: sum('applications'),
    interview: sum('interview'),
    hired: sum('hired'),
    started: sum('started'),
    firstResponseHours: funnel.firstResponseHours ?? null,
    answered24h: funnel.answered24h ?? null,
    declined: sum('declined'),
    declines: Object.fromEntries(reasons.map((r) => [r.id, weeks.reduce((n, w) => n + (w.declines[r.id] ?? 0), 0)])),
    planTarget: last.planTarget,
    planDone: last.planDone,
    completed: sum('completed'),
    stayed: sum('stayed'),
    cost: costs ? sum('cost') : null,
  }
  const rows: SheetRow[] = [
    { cells: [`Недели · ${funnel.title}`], style: { bold: true, size: 13 } },
    {
      cells: [
        'Заявки, этапы и итог сезона считаются по заявкам, пришедшим за неделю, как плитки над списком. План показывает места плана сезона, закрытые к концу недели, нарастающим итогом.' +
          (costs ? ' Расход считается по всем меткам реестра за неделю.' : ''),
      ],
    },
    { cells: head, style: header, height: 46 },
    ...weeks.map((w) => line(w, weekLabel(w.start, w.end))),
    line(total, 'Итого', true),
  ]
  return { name: 'Недели', widths: head.map((_, i) => (i === 0 ? 20 : 14)), rows, freezeRows: 3 }
}

export type PassItem = { time: string; fullName: string; vacancy: string }

/** «Список на проходную»: собеседования дня — время, ФИО, вакансия. Для охраны, без телефонов */
export function buildPassList(day: string, items: PassItem[]): Buffer {
  const title = `Список на проходную: собеседования ${day.split('-').reverse().join('.')}`
  const rows: SheetRow[] = [
    { cells: [title], style: { bold: true, size: 13 } },
    { cells: [`${contacts.address}. Отдел персонала: ${contacts.phone}, ${contacts.phoneNote}`] },
    { cells: [] },
    { cells: ['№', 'Время', 'ФИО', 'Вакансия', 'Отметка охраны'], style: header, height: 28 },
    ...items.map((it, i) => ({ cells: [i + 1, it.time, it.fullName, it.vacancy, ''] })),
  ]
  return writeXlsx([{ name: 'Проходная', widths: [5, 9, 36, 34, 18], rows, freezeRows: 4 }], { creator: 'Очаково · отдел персонала' })
}
