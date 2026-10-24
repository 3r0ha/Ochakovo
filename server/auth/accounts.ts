import type { HrRole, HrUser } from '../db/hr'
import type { Sql } from '../db'

// Учётные записи сотрудников HR для администратора и для самого сотрудника: временный пароль и обязательная смена,
// своя смена пароля, раздача новых заявок по очереди. Таблицы — миграция 015_admin.sql.
// Вход, сессии и список «кому назначить» остаются в server/db/hr.ts (HrRepo).

/** Сотрудник с полями учётной записи: ждёт ли смены пароля, получает ли заявки по очереди */
export type HrAccount = HrUser & {
  /** Пароль задал администратор: при входе нужно сменить */
  mustChangePassword: boolean
  /** Получает новые заявки, когда включена раздача по очереди. Без отметки администратора — по роли: HR да, администратор нет */
  inQueue: boolean
  /** Когда сотрудник сам сменил пароль; null — не менял */
  passwordChangedAt: string | null
}

/** Раздача новых заявок по очереди: включена ли, кто следующий, сколько сотрудников в очереди */
export type AssignQueue = {
  enabled: boolean
  /** Кто получит следующую заявку; null — в очереди никого */
  next: { id: number; name: string } | null
  /** Активные сотрудники, которые получают заявки по очереди, — в порядке очереди */
  members: { id: number; name: string }[]
  /** Сколько заявок раздано по очереди с последнего включения */
  assigned: number
  updatedAt: string
  /** Кто последним включил или выключил раздачу */
  updatedBy: string
}

type AccountRow = {
  id: string
  email: string
  name: string
  role: HrRole
  disabled: boolean
  created_at: Date
  last_login_at: Date | null
  must_change_password: boolean
  in_queue: boolean
  password_changed_at: Date | null
}

const toAccount = (r: AccountRow): HrAccount => ({
  id: Number(r.id),
  email: r.email,
  name: r.name,
  role: r.role,
  disabled: r.disabled,
  createdAt: r.created_at.toISOString(),
  lastLoginAt: r.last_login_at?.toISOString() ?? null,
  mustChangePassword: r.must_change_password,
  inQueue: r.in_queue,
  passwordChangedAt: r.password_changed_at?.toISOString() ?? null,
})

/** in_queue без отметки — по роли: HR в очереди, администратор нет */
const columns = "id, email, name, role, disabled, created_at, last_login_at, must_change_password, coalesce(in_queue, role = 'hr') as in_queue, password_changed_at"

export class AccountRepo {
  constructor(private sql: Sql) {}

  async list(): Promise<HrAccount[]> {
    const rows = await this.sql.unsafe<AccountRow[]>(`select ${columns} from hr_users order by disabled, created_at, id`)
    return rows.map(toAccount)
  }

  async get(id: number): Promise<HrAccount | null> {
    const [row] = await this.sql.unsafe<AccountRow[]>(`select ${columns} from hr_users where id = $1`, [id])
    return row ? toAccount(row) : null
  }

  async byEmail(email: string): Promise<HrAccount | null> {
    const [row] = await this.sql.unsafe<AccountRow[]>(`select ${columns} from hr_users where lower(email) = lower($1)`, [email.trim()])
    return row ? toAccount(row) : null
  }

  async countActiveAdmins(): Promise<number> {
    const [row] = await this.sql<{ n: number }[]>`select count(*)::int as n from hr_users where role = 'admin' and not disabled`
    return row.n
  }

  /** Новый сотрудник с паролем от администратора: при первом входе пароль нужно сменить */
  async create(u: { email: string; name: string; role: HrRole; passwordHash: string }): Promise<HrAccount> {
    const [row] = await this.sql<{ id: string }[]>`
      insert into hr_users (email, name, role, password_hash, must_change_password)
      values (${u.email.trim().toLowerCase()}, ${u.name.trim()}, ${u.role}, ${u.passwordHash}, true)
      returning id`
    return (await this.get(Number(row.id)))!
  }

  /** Имя, роль, доступ, очередь. Выключенный сотрудник сразу теряет все входы */
  async update(id: number, patch: { name?: string; role?: HrRole; disabled?: boolean; inQueue?: boolean }): Promise<HrAccount | null> {
    const rows = await this.sql`
      update hr_users set
        name = coalesce(${patch.name ?? null}, name),
        role = coalesce(${patch.role ?? null}, role),
        disabled = coalesce(${patch.disabled ?? null}, disabled),
        in_queue = coalesce(${patch.inQueue ?? null}, in_queue)
      where id = ${id}
      returning id`
    if (!rows.length) return null
    if (patch.disabled) await this.sql`delete from hr_sessions where user_id = ${id}`
    return this.get(id)
  }

  /** Сброс пароля администратором: все входы сотрудника закрываются, при следующем входе пароль нужно сменить */
  async resetPassword(id: number, passwordHash: string): Promise<HrAccount | null> {
    const rows = await this.sql`
      update hr_users set password_hash = ${passwordHash}, must_change_password = true where id = ${id} returning id`
    if (!rows.length) return null
    await this.sql`delete from hr_sessions where user_id = ${id}`
    return this.get(id)
  }

  /** Хеш пароля — чтобы проверить текущий перед сменой */
  async passwordHash(id: number): Promise<string | null> {
    const [row] = await this.sql<{ password_hash: string }[]>`select password_hash from hr_users where id = ${id} and not disabled`
    return row?.password_hash ?? null
  }

  /**
   * Сотрудник сам сменил пароль: обязательная смена снята, остальные входы закрыты, текущий остаётся.
   * password_changed_at обновляется — по нему триггер отличает свою смену от сброса администратором
   */
  async changeOwnPassword(id: number, passwordHash: string, keepSession: string | null): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`
        update hr_users set password_hash = ${passwordHash}, must_change_password = false, password_changed_at = now() where id = ${id}`
      await tx`delete from hr_sessions where user_id = ${id} and id is distinct from ${keepSession}`
    })
  }

  /** Нужно ли сменить пароль, прежде чем работать в панели */
  async mustChange(id: number): Promise<boolean> {
    const [row] = await this.sql<{ must: boolean }[]>`select must_change_password as must from hr_users where id = ${id}`
    return row?.must ?? false
  }

  /** Когда закончится сессия: продлевается при работе, но не позже 7 дней от входа */
  async sessionEnds(sessionId: string): Promise<{ expiresAt: string; latestAt: string } | null> {
    const [row] = await this.sql<{ expires_at: Date; latest: Date }[]>`
      select expires_at, created_at + interval '7 days' as latest from hr_sessions where id = ${sessionId}`
    return row ? { expiresAt: row.expires_at.toISOString(), latestAt: row.latest.toISOString() } : null
  }

  // ── Раздача по очереди ──────────────────────────────────────────────

  async queue(): Promise<AssignQueue> {
    const [q] = await this.sql<{ enabled: boolean; last_user_id: string | null; assigned: number; updated_at: Date; updated_by: string }[]>`
      select enabled, last_user_id, assigned, updated_at, updated_by from hr_assign_queue where id = 1`
    const members = (await this.sql<{ id: string; name: string }[]>`
      select id, name from hr_users where not disabled and coalesce(in_queue, role = 'hr') order by id`).map((m) => ({ id: Number(m.id), name: m.name }))
    // Следующий — как в триггере applications_assign_queue: первый по id после последнего получившего, по кругу
    const last = q?.last_user_id ? Number(q.last_user_id) : 0
    const next = members.find((m) => m.id > last) ?? members[0] ?? null
    return {
      enabled: q?.enabled ?? false,
      next,
      members,
      assigned: q?.assigned ?? 0,
      updatedAt: (q?.updated_at ?? new Date()).toISOString(),
      updatedBy: q?.updated_by ?? '',
    }
  }

  /** Включить или выключить раздачу. Включение начинает счёт розданных заново */
  async setQueue(enabled: boolean, by: string): Promise<AssignQueue> {
    await this.sql`
      insert into hr_assign_queue (id, enabled, updated_by) values (1, ${enabled}, ${by})
      on conflict (id) do update set
        enabled = excluded.enabled,
        assigned = case when excluded.enabled and not hr_assign_queue.enabled then 0 else hr_assign_queue.assigned end,
        updated_at = now(),
        updated_by = excluded.updated_by`
    return this.queue()
  }
}
