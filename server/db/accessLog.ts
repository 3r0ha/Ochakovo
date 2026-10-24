import type { Sql } from './index'

// Журнал выгрузок и чтения данных (таблица access_log, миграция 020): кто, с какой ролью и что забрал —
// файл из панели, выгрузка на Яндекс Диск, чтение служебным токеном. Номера заявок — чтобы ответить кандидату,
// кому и когда ушли его данные; самих данных в журнале нет. Здесь же — сводка для /api/health.

/** Что сделали: export — файл из панели, disk — выгрузка на Яндекс Диск, token_read — чтение служебным токеном */
export type AccessAction = 'export' | 'disk' | 'token_read'

export type AccessEntry = {
  /** Сотрудник панели; для расписания и служебного токена — null и подпись в who */
  user?: { id: number; name: string; role: string } | null
  /** Кто, если это не сотрудник: «Выгрузка на Яндекс Диск», «Служебный токен» */
  who?: string
  action: AccessAction
  /** xlsx, csv, csv1c, json */
  format?: string
  rows: number
  /** Отбор из панели как строка запроса (?status=new&source=…), без личных данных */
  filter?: string
  applicationIds?: string[]
}

/** Сколько номеров заявок хранить в одной записи: выгрузка всего списка — тысячи строк */
export const ACCESS_MAX_IDS = 10_000

/** Записать выгрузку. Журнал не должен ронять саму выгрузку: ошибку записи вызывающий может проглотить */
export async function logAccess(sql: Sql, e: AccessEntry): Promise<void> {
  const ids = (e.applicationIds ?? []).filter((id) => typeof id === 'string' && id.length <= 32).slice(0, ACCESS_MAX_IDS)
  await sql`
    insert into access_log (user_id, user_name, role, action, format, rows, filter, application_ids)
    values (${e.user && e.user.id > 0 ? e.user.id : null}, ${(e.user?.name ?? e.who ?? '').slice(0, 120)}, ${(e.user?.role ?? '').slice(0, 20)},
            ${e.action}, ${(e.format ?? '').slice(0, 20)}, ${Math.max(0, Math.round(e.rows))}, ${(e.filter ?? '').slice(0, 500)}, ${ids})`
}

export type AccessRow = {
  id: number
  createdAt: string
  userName: string
  role: string
  action: AccessAction
  format: string
  rows: number
  filter: string
  /** Сколько номеров заявок в записи; сами номера — по applicationId */
  applications: number
}

/** Последние записи журнала; applicationId — только те, где была эта заявка */
export async function accessLog(sql: Sql, opts: { limit?: number; applicationId?: string } = {}): Promise<AccessRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
  const rows = await sql<
    { id: string; created_at: Date; user_name: string; role: string; action: AccessAction; format: string; rows: number; filter: string; n: number }[]
  >`
    select id, created_at, user_name, role, action, format, rows, filter, cardinality(application_ids) as n
    from access_log
    where ${opts.applicationId ? sql`application_ids @> array[${opts.applicationId}]::text[]` : sql`true`}
    order by created_at desc, id desc limit ${limit}`
  return rows.map((r) => ({
    id: Number(r.id),
    createdAt: r.created_at.toISOString(),
    userName: r.user_name,
    role: r.role,
    action: r.action,
    format: r.format,
    rows: r.rows,
    filter: r.filter,
    applications: r.n,
  }))
}

/**
 * Состояние для /api/health и раздела «Состояние»: только время и числа, без текстов ошибок и адресов.
 * failed24h — задачи очереди, которые за сутки исчерпали попытки; stuck — созревшие больше 10 минут назад и не взятые;
 * disk — последняя выгрузка на Яндекс Диск и была ли ошибка; retention — последний проход срока хранения;
 * botsLastSeen — последнее сообщение от людей в каждом боте; lastExport — последняя выгрузка из журнала
 */
export async function opsState(sql: Sql) {
  const [jobs] = await sql<{ failed24h: number; stuck: number }[]>`
    select count(*) filter (where status = 'failed' and done_at > now() - interval '24 hours')::int as failed24h,
           count(*) filter (where status = 'pending' and run_at < now() - interval '10 minutes')::int as stuck
    from jobs where status in ('failed', 'pending')`
  const states = await sql<{ key: string; data: Record<string, unknown> }[]>`
    select key, data from integration_state where key in ('yandex_disk', 'retention')`
  const state = (key: string) => states.find((s) => s.key === key)?.data ?? {}
  const disk = state('yandex_disk')
  const retention = state('retention')
  const bots = await sql<{ channel: string; at: Date }[]>`
    select channel, max(last_seen_at) as at from bot_users where channel in ('telegram', 'max') and not erased group by channel`
  const [last] = await sql<{ created_at: Date; action: string }[]>`select created_at, action from access_log order by created_at desc, id desc limit 1`
  const iso = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null)
  return {
    jobs: { failed24h: jobs?.failed24h ?? 0, stuck: jobs?.stuck ?? 0 },
    disk: { lastOkAt: iso(disk.lastOkAt), lastAttemptAt: iso(disk.lastAttemptAt), failing: Boolean(disk.lastError) },
    retention: { lastRunAt: iso(retention.lastRunAt) },
    botsLastSeen: Object.fromEntries(['telegram', 'max'].map((c) => [c, bots.find((b) => b.channel === c)?.at.toISOString() ?? null])) as Record<'telegram' | 'max', string | null>,
    lastExport: last ? { at: last.created_at.toISOString(), action: last.action } : null,
  }
}

export type OpsState = Awaited<ReturnType<typeof opsState>>
