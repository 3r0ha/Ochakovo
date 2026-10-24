import { describeSource, isAnyReferral } from '@shared/hr'
import { kindByCode, type CostDraft, type SourceCost, type SourceDraft, type SourceEntry, type SourceKindId, type UnknownSource } from '@shared/sources'
import type { Sql } from './index'

// Реестр меток источников и расходы по меткам (миграция 014). Маршруты — server/api/hr-sources.ts.
//   listSources(sql)              — реестр с числом заявок по каждой метке
//   sourceNames(sql)              — { метка: название } для подписей в выгрузках и на сервере
//   unknownSources(sql)           — метки из заявок и визитов, которых нет в реестре
//   sourceCosts(sql, from, to)    — расход по меткам за период для «Воронки» (server/db/funnel.ts)
//   seedDemoSources(sql, codes)   — названия и расходы для «Демо-данных» (server/db/demo.ts)

type SourceRow = {
  code: string
  name: string
  kind: SourceKindId
  note: string
  builtin: boolean
  created_at: Date
  updated_at: Date
  updated_by: string
  applications: number
}

const toEntry = (r: SourceRow): SourceEntry => ({
  code: r.code,
  name: r.name,
  kind: r.kind,
  note: r.note,
  builtin: r.builtin,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
  updatedBy: r.updated_by,
  applications: Number(r.applications ?? 0),
})

type CostRow = {
  id: string
  code: string
  amount: number
  comment: string
  period_from: string | null
  period_to: string | null
  demo: boolean
  created_at: Date
  author_name: string
}

const toCost = (r: CostRow): SourceCost => ({
  id: Number(r.id),
  code: r.code,
  amount: r.amount,
  comment: r.comment,
  from: r.period_from,
  to: r.period_to,
  createdAt: r.created_at.toISOString(),
  authorName: r.author_name,
  demo: r.demo,
})

/** Метка уже есть в реестре */
export class DuplicateSource extends Error {
  constructor(public code: string) {
    super(`метка ${code} уже есть`)
  }
}

/** Реестр целиком: сначала по типу, внутри — по названию. applications — заявки без дублей за всё время */
export async function listSources(sql: Sql): Promise<SourceEntry[]> {
  const rows = await sql<SourceRow[]>`
    select s.code, s.name, s.kind, s.note, s.builtin, s.created_at, s.updated_at, s.updated_by,
           coalesce(a.n, 0)::int as applications
    from hr_sources s
    left join (select source, count(*) as n from applications where duplicate_of is null and source is not null group by source) a
      on a.source = s.code
    order by s.builtin, s.kind, lower(s.name)`
  return rows.map(toEntry)
}

export async function getSource(sql: Sql, code: string): Promise<SourceEntry | null> {
  return (await listSources(sql)).find((s) => s.code === code) ?? null
}

/** Названия из реестра: { метка: название }. Для sourceName(src, names) и describeSource(src, names) из shared/hr.ts */
export async function sourceNames(sql: Sql): Promise<Record<string, string>> {
  const rows = await sql<{ code: string; name: string }[]>`select code, name from hr_sources`
  return Object.fromEntries(rows.map((r) => [r.code, r.name]))
}

export async function createSource(sql: Sql, draft: SourceDraft, by: string): Promise<SourceEntry> {
  const rows = await sql<{ code: string }[]>`
    insert into hr_sources (code, name, kind, note, updated_by)
    values (${draft.code}, ${draft.name}, ${draft.kind}, ${draft.note}, ${by})
    on conflict (code) do nothing
    returning code`
  if (!rows.length) throw new DuplicateSource(draft.code)
  return (await getSource(sql, draft.code))!
}

/** Правка названия, типа и заметки. Метку не меняем: она уже напечатана в QR */
export async function updateSource(sql: Sql, code: string, patch: Partial<Omit<SourceDraft, 'code'>>, by: string): Promise<SourceEntry | null> {
  const rows = await sql`
    update hr_sources set
      name = coalesce(${patch.name ?? null}, name),
      kind = coalesce(${patch.kind ?? null}, kind),
      note = coalesce(${patch.note ?? null}, note),
      updated_at = now(),
      updated_by = ${by}
    where code = ${code}
    returning code`
  return rows.length ? getSource(sql, code) : null
}

/**
 * Удалить метку из реестра. Заявки остаются со своей меткой — без названия панель покажет код.
 * builtin — метка из словаря кода, has_costs — по метке записаны расходы: сначала удалить их
 */
export async function deleteSource(sql: Sql, code: string): Promise<'ok' | 'not_found' | 'builtin' | 'has_costs'> {
  const [row] = await sql<{ builtin: boolean; costs: number }[]>`
    select builtin, (select count(*)::int from source_costs c where c.code = s.code) as costs from hr_sources s where code = ${code}`
  if (!row) return 'not_found'
  if (row.builtin) return 'builtin'
  if (row.costs > 0) return 'has_costs'
  await sql`delete from hr_sources where code = ${code}`
  return 'ok'
}

/**
 * Незнакомые метки: встречаются в заявках, на сайте (визиты) или в ботах, а в реестре их нет.
 * Приглашения друзей (friend-<код>, старые friend и share) — не метки площадок, их не показываем.
 * Сначала — с заявками, потом по числу людей
 */
export async function unknownSources(sql: Sql, limit = 50): Promise<UnknownSource[]> {
  const rows = await sql<{ code: string; applications: number; visitors: number; last_seen: Date }[]>`
    with seen as (
      select source as code, count(*) filter (where duplicate_of is null) as applications, 0::bigint as visitors, max(created_at) as last_seen
      from applications where source is not null and source <> '' group by source
      union all
      select source, 0, count(distinct visitor), max(created_at)
      from funnel_events where type = 'visit' and source is not null and source <> '' group by source
      union all
      select source, 0, count(*), max(created_at)
      from bot_users where source is not null and source <> '' group by source
    )
    select code, sum(applications)::int as applications, sum(visitors)::int as visitors, max(last_seen) as last_seen
    from seen
    where not exists (select 1 from hr_sources s where s.code = seen.code)
    group by code
    order by sum(applications) desc, sum(visitors) desc, max(last_seen) desc
    limit ${limit * 2}`
  return rows
    .filter((r) => !isAnyReferral(r.code))
    .slice(0, limit)
    .map((r) => ({ code: r.code, guess: describeSource(r.code).label, applications: r.applications, visitors: r.visitors, lastSeen: r.last_seen.toISOString() }))
}

// ── Расходы ──────────────────────────────────────────────────────────────────

/** Все расходы: сначала свежие по сроку, без срока — по дате записи */
export async function listCosts(sql: Sql): Promise<SourceCost[]> {
  const rows = await sql<CostRow[]>`
    select id, code, amount, comment, period_from::text as period_from, period_to::text as period_to, demo, created_at, author_name
    from source_costs
    order by coalesce(period_to, period_from, created_at::date) desc, id desc`
  return rows.map(toCost)
}

export async function addCost(sql: Sql, draft: CostDraft, author: { id: number | null; name: string }): Promise<SourceCost> {
  const [row] = await sql<CostRow[]>`
    insert into source_costs (code, amount, comment, period_from, period_to, author_id, author_name)
    values (${draft.code}, ${draft.amount}, ${draft.comment}, ${draft.from}, ${draft.to}, ${author.id || null}, ${author.name})
    returning id, code, amount, comment, period_from::text as period_from, period_to::text as period_to, demo, created_at, author_name`
  return toCost(row)
}

export async function deleteCost(sql: Sql, id: number): Promise<boolean> {
  const rows = await sql`delete from source_costs where id = ${id} returning id`
  return rows.length > 0
}

/**
 * Расход по меткам за период [from, to), ₽ по коду метки — для «Воронки». Берутся расходы, срок которых пересекается
 * с периодом, — целиком, без деления по дням. Срок — дни по Москве включительно; расход без срока — в любом периоде,
 * с одной границей — открыт с другой стороны. Метки без расхода в ответ не попадают
 */
export async function sourceCosts(sql: Sql, from: Date, to: Date): Promise<Record<string, number>> {
  const rows = await sql<{ code: string; total: number }[]>`
    select code, sum(amount)::bigint as total
    from source_costs
    where (period_from is null or (period_from::timestamp at time zone 'Europe/Moscow') < ${to})
      and (period_to is null or ((period_to + 1)::timestamp at time zone 'Europe/Moscow') > ${from})
    group by code`
  return Object.fromEntries(rows.map((r) => [r.code, Number(r.total)]))
}

// ── Демо-данные ──────────────────────────────────────────────────────────────

/** Названия меток демо-заявок, которых нет в словаре кода */
const demoNames: Record<string, { name: string; kind: SourceKindId; note: string }> = {
  'fair-misis': { name: 'Ярмарка МИСИС', kind: 'fair', note: 'Стенд на ярмарке вакансий: плакат A3 и листовки A5' },
  'tour-mgupp': { name: 'Экскурсия МГУПП', kind: 'excursion', note: 'Группа студентов-технологов после экскурсии по заводу' },
  'museum-zal': { name: 'Музей завода', kind: 'museum', note: 'Листовки у выхода из музея' },
  'edu-mgupp': { name: 'Центр карьеры МГУПП', kind: 'school', note: 'Рассылка центра карьеры о практике' },
}

const DAY = 24 * 60 * 60 * 1000

/** День по Москве для смещения в днях от текущего момента: YYYY-MM-DD */
function moscowDay(offsetDays: number, now: number): string {
  return new Date(now + offsetDays * DAY).toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' })
}

/**
 * «Демо-данные» в HR: даём названия меткам демо-заявок, которых нет в реестре, и записываем расходы с пометкой демо.
 * Прежние демо-расходы заменяются, настоящие — не трогаем. Сроки — от текущего момента. Вызывает server/db/demo.ts
 */
export async function seedDemoSources(sql: Sql, codes: string[], now = Date.now()): Promise<number> {
  const wanted = [...new Set([...codes, ...Object.keys(demoNames)])].filter((c) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(c) && !isAnyReferral(c))
  return sql.begin(async (tx) => {
    for (const code of wanted) {
      const known = demoNames[code]
      const label = known?.name ?? describeSource(code).label
      const kind: SourceKindId = known?.kind ?? kindByCode(code)
      await tx`
        insert into hr_sources (code, name, kind, note, updated_by)
        values (${code}, ${label}, ${kind}, ${known?.note ?? ''}, 'Демо-данные')
        on conflict (code) do nothing`
    }
    await tx`delete from source_costs where demo`
    const costs: { code: string; amount: number; comment: string; from: string | null; to: string | null }[] = [
      { code: 'fair-misis', amount: 25000, comment: 'Стенд на ярмарке и печать листовок', from: moscowDay(-12, now), to: moscowDay(-11, now) },
      { code: 'fair-mgupp', amount: 18000, comment: 'Стенд на ярмарке', from: moscowDay(-26, now), to: moscowDay(-26, now) },
      { code: 'fair-mospolytech', amount: 15000, comment: 'Стенд и плакат A3', from: moscowDay(-40, now), to: moscowDay(-39, now) },
      { code: 'vk', amount: 30000, comment: 'Реклама в ВКонтакте', from: moscowDay(-30, now), to: moscowDay(-1, now) },
      { code: 'tour-mgupp', amount: 4000, comment: 'Листовки A5 для экскурсии', from: null, to: null },
    ]
    for (const c of costs) {
      const exists = await tx`select 1 from hr_sources where code = ${c.code}`
      if (!exists.length) continue
      await tx`
        insert into source_costs (code, amount, comment, period_from, period_to, demo, author_name)
        values (${c.code}, ${c.amount}, ${c.comment}, ${c.from}, ${c.to}, true, 'Демо-данные')`
    }
    return wanted.length
  })
}
