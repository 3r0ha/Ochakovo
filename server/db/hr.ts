import type postgres from 'postgres'
import { isStatus, templateKeys, type Application, type ApplicationStatus, type HrApplication, type TemplateKey } from '@shared/applications'
import { isEmptyFilter, type HrFilter } from '@shared/hrFilter'
import { defaultWorkSettings, workSettingsProblem, type WorkSettings } from '@shared/workdays'
import type { PlanEntry } from '@shared/hrPlan'
import { funnelReport, referrerNames as findReferrerNames, type FunnelEventType, type FunnelReport } from './funnel'
import type { Sql } from './index'

// Данные отдела персонала: сотрудники, сессии, тексты уведомлений, сохранённые виды,
// состояние интеграций и анонимная воронка сайта. Работа с заявками — в workflow.ts.

export type HrRole = 'hr' | 'admin'

export type HrUser = {
  id: number
  email: string
  name: string
  role: HrRole
  disabled: boolean
  createdAt: string
  lastLoginAt: string | null
}

type UserRow = {
  id: string
  email: string
  name: string
  role: HrRole
  password_hash: string
  disabled: boolean
  created_at: Date
  last_login_at: Date | null
}

const toUser = (r: UserRow): HrUser => ({
  id: Number(r.id),
  email: r.email,
  name: r.name,
  role: r.role,
  disabled: r.disabled,
  createdAt: r.created_at.toISOString(),
  lastLoginAt: r.last_login_at?.toISOString() ?? null,
})

export type Referrer = {
  code: string
  /** Канал пригласившего; null — код не нашёлся (сессию удалили или ссылку набрали вручную) */
  channel: string | null
  name: string | null
  username: string | null
  /** Заявка самого пригласившего, если он её подал */
  applicationId: string | null
}

export type NotifyTemplate = { key: TemplateKey; text: string; enabled: boolean; updatedAt: string }

export type SavedView = { id: number; name: string; filter: HrFilter }

// Воронка живёт в funnel.ts: типы реэкспортируются отсюда для прежних импортов
export type { FunnelEventType, FunnelReport, FunnelRow, FunnelTasks, TaskLeadRow, WeekRow } from './funnel'

export class HrRepo {
  constructor(private sql: Sql) {}

  // ── Сотрудники ──────────────────────────────────────────────────────

  async userByEmail(email: string) {
    const [row] = await this.sql<UserRow[]>`select * from hr_users where lower(email) = lower(${email.trim()})`
    return row ? { user: toUser(row), passwordHash: row.password_hash } : null
  }

  async listUsers(): Promise<HrUser[]> {
    const rows = await this.sql<UserRow[]>`select * from hr_users order by disabled, created_at`
    return rows.map(toUser)
  }

  async countUsers(): Promise<number> {
    const [row] = await this.sql<{ n: number }[]>`select count(*)::int as n from hr_users`
    return row.n
  }

  async countActiveAdmins(): Promise<number> {
    const [row] = await this.sql<{ n: number }[]>`select count(*)::int as n from hr_users where role = 'admin' and not disabled`
    return row.n
  }

  async createUser(u: { email: string; name: string; role: HrRole; passwordHash: string }): Promise<HrUser> {
    const [row] = await this.sql<UserRow[]>`
      insert into hr_users (email, name, role, password_hash)
      values (${u.email.trim().toLowerCase()}, ${u.name.trim()}, ${u.role}, ${u.passwordHash})
      returning *`
    return toUser(row)
  }

  async updateUser(id: number, patch: { name?: string; role?: HrRole; disabled?: boolean; passwordHash?: string }): Promise<HrUser | null> {
    const [row] = await this.sql<UserRow[]>`
      update hr_users set
        name = coalesce(${patch.name ?? null}, name),
        role = coalesce(${patch.role ?? null}, role),
        disabled = coalesce(${patch.disabled ?? null}, disabled),
        password_hash = coalesce(${patch.passwordHash ?? null}, password_hash)
      where id = ${id}
      returning *`
    if (row && (patch.disabled || patch.passwordHash)) await this.sql`delete from hr_sessions where user_id = ${id}`
    return row ? toUser(row) : null
  }

  async touchLogin(id: number) {
    await this.sql`update hr_users set last_login_at = now() where id = ${id}`
  }

  // ── Сессии ──────────────────────────────────────────────────────────

  async createSession(id: string, userId: number, ttlMs: number) {
    await this.sql`insert into hr_sessions (id, user_id, expires_at) values (${id}, ${userId}, ${new Date(Date.now() + ttlMs)})`
    // Заодно чистим просроченные — их немного, отдельная задача не нужна
    await this.sql`delete from hr_sessions where expires_at < now()`
  }

  /** Пользователь по сессии; продлевает сессию, если прошла половина срока */
  async sessionUser(id: string, ttlMs: number): Promise<HrUser | null> {
    const [row] = await this.sql<(UserRow & { expires_at: Date })[]>`
      select u.*, s.expires_at from hr_sessions s join hr_users u on u.id = s.user_id
      where s.id = ${id} and s.expires_at > now() and not u.disabled`
    if (!row) return null
    if (row.expires_at.getTime() - Date.now() < ttlMs / 2) {
      await this.sql`update hr_sessions set expires_at = ${new Date(Date.now() + ttlMs)} where id = ${id}`
    }
    return toUser(row)
  }

  async deleteSession(id: string) {
    await this.sql`delete from hr_sessions where id = ${id}`
  }

  // ── Приглашения ─────────────────────────────────────────────────────

  /**
   * Приглашения «Позвать друга». У пригласившего есть личный код: на сайте — refCode заявки, в боте — код в сессии.
   * У приглашённого источник — friend-<код>. Для карточки кандидата: кто его позвал и кого позвал он сам.
   * Свой же код не засчитывается: заявка, пришедшая по собственной ссылке, приглашением не считается
   */
  async referrals(app: Application & Partial<Pick<HrApplication, 'botChannel' | 'botUserId'>>): Promise<{ invitedBy: Referrer | null; invited: { id: string; name: string; status: ApplicationStatus }[] }> {
    const code = app.source?.startsWith('friend-') ? app.source.slice('friend-'.length) : null
    let invitedBy: Referrer | null = null
    if (code && code !== app.refCode) {
      // Сначала заявка с сайта с этим кодом, потом бот: у кого в сессии этот код
      const [site] = await this.sql<{ id: string; name: string; last_name: string; channel: string }[]>`
        select id, name, last_name, channel from applications
        where ref_code = ${code} and id <> ${app.id} and anonymized_at is null and duplicate_of is null limit 1`
      if (site) {
        invitedBy = { code, channel: site.channel, name: [site.last_name, site.name].filter(Boolean).join(' '), username: null, applicationId: site.id }
      } else {
        const [row] = await this.sql<{ channel: string; user_id: string; first_name: string | null; username: string | null; app_id: string | null; app_name: string | null }[]>`
          select s.channel, s.user_id, b.first_name, b.username, a.id as app_id, a.name as app_name
          from sessions s
          left join bot_users b on b.channel = s.channel and b.user_id = s.user_id
          left join lateral (
            select id, name from applications
            where ((channel = s.channel and channel_user_id = s.user_id) or (bot_channel = s.channel and bot_user_id = s.user_id))
              and anonymized_at is null and duplicate_of is null
            order by created_at desc limit 1
          ) a on true
          where s.data -> 'data' ->> 'ref' = ${code}
          limit 1`
        const own = row && ((app.channel === row.channel && app.channelUserId === row.user_id) || row.app_id === app.id)
        invitedBy = own
          ? null
          : row
            ? { code, channel: row.channel, name: row.app_name ?? row.first_name ?? null, username: row.username, applicationId: row.app_id }
            : { code, channel: null, name: null, username: null, applicationId: null }
      }
    }

    // Коды самого кандидата: с сайта и из бота (заявка из бота или привязанная к нему)
    const codes = new Set<string>()
    if (app.refCode) codes.add(app.refCode)
    const chat = app.channel && app.channel !== 'web' && app.channel !== 'hr' && app.channelUserId ? { channel: app.channel, userId: app.channelUserId } : null
    const linked = app.botChannel && app.botUserId ? { channel: app.botChannel, userId: app.botUserId } : null
    for (const c of [chat, linked]) {
      if (!c) continue
      const [session] = await this.sql<{ ref: string | null }[]>`
        select data -> 'data' ->> 'ref' as ref from sessions where channel = ${c.channel} and user_id = ${c.userId}`
      if (session?.ref) codes.add(session.ref)
    }
    let invited: { id: string; name: string; status: ApplicationStatus }[] = []
    if (codes.size) {
      const rows = await this.sql<{ id: string; name: string; last_name: string; status: string }[]>`
        select id, name, last_name, status from applications
        where source = any(${[...codes].map((c) => `friend-${c}`)}) and id <> ${app.id} and anonymized_at is null and duplicate_of is null
        order by created_at`
      // Как в списке заявок: фамилия, потом имя
      invited = rows.map((r) => ({ id: r.id, name: [r.last_name, r.name].filter(Boolean).join(' '), status: isStatus(r.status) ? r.status : 'new' }))
    }
    return { invitedBy, invited }
  }

  // ── Тексты уведомлений ──────────────────────────────────────────────

  async templates(): Promise<NotifyTemplate[]> {
    const rows = await this.sql<{ status: string; text: string; enabled: boolean; updated_at: Date }[]>`select * from notify_templates`
    const order = templateKeys.map((t) => t.id as string)
    return rows
      .filter((r) => order.includes(r.status))
      .sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status))
      .map((r) => ({ key: r.status as TemplateKey, text: r.text, enabled: r.enabled, updatedAt: r.updated_at.toISOString() }))
  }

  async template(key: TemplateKey): Promise<NotifyTemplate | null> {
    return (await this.templates()).find((t) => t.key === key) ?? null
  }

  async updateTemplate(key: TemplateKey, patch: { text?: string; enabled?: boolean }) {
    const [row] = await this.sql<{ status: string }[]>`
      update notify_templates set
        text = coalesce(${patch.text ?? null}, text),
        enabled = coalesce(${patch.enabled ?? null}, enabled),
        updated_at = now()
      where status = ${key}
      returning status`
    return Boolean(row)
  }

  // ── Сохранённые виды ────────────────────────────────────────────────

  async views(userId: number): Promise<SavedView[]> {
    const rows = await this.sql<{ id: string; name: string; filter: HrFilter }[]>`
      select id, name, filter from hr_views where user_id = ${userId} order by created_at`
    return rows.map((r) => ({ id: Number(r.id), name: r.name, filter: r.filter }))
  }

  async createView(userId: number, name: string, filter: HrFilter): Promise<SavedView | null> {
    if (isEmptyFilter(filter)) return null
    const [{ n }] = await this.sql<{ n: number }[]>`select count(*)::int as n from hr_views where user_id = ${userId}`
    if (n >= 20) return null
    const [row] = await this.sql<{ id: string }[]>`
      insert into hr_views (user_id, name, filter) values (${userId}, ${name.slice(0, 60)}, ${this.sql.json(filter as postgres.JSONValue)}) returning id`
    return { id: Number(row.id), name: name.slice(0, 60), filter }
  }

  async deleteView(userId: number, id: number) {
    const rows = await this.sql`delete from hr_views where id = ${id} and user_id = ${userId} returning id`
    return rows.length > 0
  }

  /** Сотрудники для выбора ответственного: только активные, без почт */
  async staff() {
    const rows = await this.sql<{ id: string; name: string }[]>`select id, name from hr_users where not disabled order by name`
    return rows.map((r) => ({ id: Number(r.id), name: r.name }))
  }

  // ── Интеграции ──────────────────────────────────────────────────────

  async integration<T extends Record<string, unknown>>(key: string): Promise<Partial<T>> {
    const [row] = await this.sql<{ data: T }[]>`select data from integration_state where key = ${key}`
    return row?.data ?? {}
  }

  /** Дописать поля состояния интеграции (без перезаписи остальных) */
  async patchIntegration(key: string, patch: Record<string, unknown>) {
    await this.sql`
      insert into integration_state (key, data) values (${key}, ${this.sql.json(patch as postgres.JSONValue)})
      on conflict (key) do update set data = integration_state.data || excluded.data, updated_at = now()`
  }

  /** План найма на сезон */
  async plan(season: number): Promise<PlanEntry[]> {
    const rows = await this.sql<{ vacancy_id: string; month: number; target: number }[]>`
      select vacancy_id, month, target from hiring_plan where season = ${season} and target > 0 order by vacancy_id, month`
    return rows.map((r) => ({ vacancyId: r.vacancy_id, month: r.month, target: r.target }))
  }

  /** Сохранить клетки плана: 0 — убрать клетку */
  async savePlan(season: number, entries: PlanEntry[]) {
    await this.sql.begin(async (tx) => {
      for (const e of entries) {
        if (e.target > 0)
          await tx`
            insert into hiring_plan (season, vacancy_id, month, target) values (${season}, ${e.vacancyId}, ${e.month}, ${e.target})
            on conflict (season, vacancy_id, month) do update set target = excluded.target, updated_at = now()`
        else await tx`delete from hiring_plan where season = ${season} and vacancy_id = ${e.vacancyId} and month = ${e.month}`
      }
    })
    return this.plan(season)
  }

  /** Рабочее время отдела и вместимость собеседований — настраивает администратор */
  async workSettings(): Promise<WorkSettings> {
    const saved = await this.integration<WorkSettings>('hr_settings')
    const merged = { ...defaultWorkSettings, ...saved }
    return workSettingsProblem(merged) ? defaultWorkSettings : merged
  }

  async saveWorkSettings(s: WorkSettings) {
    const days = (list: string[] | undefined) => [...new Set(list ?? [])].sort()
    await this.patchIntegration('hr_settings', {
      days: [...new Set(s.days)].sort(),
      start: s.start,
      end: s.end,
      slotCapacity: s.slotCapacity,
      extraOff: days(s.extraOff),
      extraWork: days(s.extraWork),
    })
    return this.workSettings()
  }

  /** Вопрос без ответа разобран: ответ добавили в базу знаний или вопрос не по делу */
  async resolveGap(id: number) {
    const rows = await this.sql`update kb_gaps set resolved = true where id = ${id} returning id`
    return rows.length > 0
  }

  // ── Воронка ─────────────────────────────────────────────────────────

  /** Событие сайта. Повторные визиты и открытия формы в течение 30 минут не дублируем */
  async addEvent(e: { visitor: string; type: FunnelEventType; task?: string | null; source?: string | null; channel?: string }) {
    const channel = e.channel ?? 'web'
    if (e.type === 'visit' || e.type === 'apply_open') {
      const [recent] = await this.sql`
        select 1 from funnel_events
        where visitor = ${e.visitor} and type = ${e.type} and created_at > now() - interval '30 minutes' limit 1`
      if (recent) return false
    }
    const rows = await this.sql`
      insert into funnel_events (visitor, channel, type, task, source)
      values (${e.visitor}, ${channel}, ${e.type}, ${e.task ?? null}, ${e.source ?? null})
      on conflict do nothing
      returning id`
    return rows.length > 0
  }

  /** Воронка по источникам, «Задания и наём» и недели за период — расчёты в funnel.ts */
  async funnel(from: Date, to: Date, apps: HrApplication[]): Promise<FunnelReport> {
    return funnelReport(this.sql, from, to, apps)
  }

  /** Имена пригласивших по кодам — для расшифровки строки «Приглашения друзей» в воронке */
  async referrerNames(codes: string[]): Promise<Record<string, string>> {
    return findReferrerNames(this.sql, codes)
  }
}
