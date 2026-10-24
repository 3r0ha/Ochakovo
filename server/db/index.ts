import { readdir, readFile } from 'node:fs/promises'
import postgres from 'postgres'
import {
  isConsentSource,
  isStartMonth,
  isStartReady,
  normalizePracticeDocs,
  type Application,
  type ApplicationChannel,
  type ApplicationInput,
  type ApplicationStatus,
  type GameSnapshot,
  type HrApplication,
} from '@shared/applications'
import { ConsentRequiredError, consentError, normalizeApplicationInput, UnderageError } from '@shared/applicationInput'
import { isAdultByBirthDate } from '@shared/birthDate'
import type { DepartmentId } from '@shared/content/departments'
import type { VacancyFormat } from '@shared/content/vacancies'
import type { CandidateStatus } from '@shared/candidateStatus'
import { makeApplicationId } from '@shared/demo'
import type { WorkSettings } from '@shared/workdays'
import { acceptApplication, type IntakeResult } from '../candidate/intake'
import { newStatusToken, statusForToken } from '../candidate/status'
import type { KbGapInput } from '../assistant/types'
import {
  BOT_LINK_TTL_HOURS,
  botLinkHash,
  botLinks,
  botNamesFromEnv,
  emptySession,
  newBotLinkToken,
  sameBotLinkHash,
  sessionToSave,
  type BotLinks,
  type BotNames,
  type Session,
  type Storage,
} from '../dialog/storage'
import type { DialogUser } from '../dialog/types'

export type Sql = postgres.Sql
/** Подключение или открытая транзакция */
export type Tx = postgres.TransactionSql | Sql

export function connect(url: string): Sql {
  return postgres(url, { max: 10, idle_timeout: 30, onnotice: () => {} })
}

const MIGRATIONS = new URL('./migrations/', import.meta.url)

/**
 * Применяет новые server/db/migrations/NNN_*.sql по порядку, каждую — в своей транзакции.
 * until — применить только миграции с номером до этого включительно (проверки переноса данных старых строк),
 * quiet — без строки в журнале на каждую миграцию (временные базы проверок)
 */
export async function migrate(sql: Sql, opts: { until?: number; quiet?: boolean } = {}) {
  await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`
  const applied = new Set((await sql<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name))
  const files = (await readdir(MIGRATIONS)).filter((f) => /^\d+_.*\.sql$/.test(f)).sort()
  for (const file of files) {
    if (opts.until !== undefined && Number.parseInt(file, 10) > opts.until) break
    if (applied.has(file)) continue
    const text = await readFile(new URL(file, MIGRATIONS), 'utf8')
    await sql.begin(async (tx) => {
      await tx.unsafe(text)
      await tx`insert into schema_migrations (name) values (${file})`
    })
    if (!opts.quiet) console.log(`[db] миграция ${file} применена`)
  }
}

type ApplicationRow = {
  id: string
  created_at: Date
  channel: string
  name: string
  phone: string
  contact: string
  school: string
  course: string
  department: string
  vacancy_id: string
  format: string
  months: number[]
  comment: string
  friend: string
  game: GameSnapshot
  source: string | null
  status: string
  status_updated_at: Date
  notes: string
  channel_user_id: string | null
  last_name: string
  adult: boolean | null
  citizenship: string
  med_book: string
  shifts: string
  portfolio: string
  middle_name: string
  resume_url: string
  // 012: согласие, приглашение, практика (кандидатские поля — в toApplication)
  consent_at: Date | null
  consent_version: string
  consent_source: string
  ref_code: string | null
  practice_school: boolean
  wants_to_stay: boolean
  // 012: поля HR — их переводит toHr в server/db/workflow.ts
  suspected_spam: boolean
  onboarding_at: Date | null
  first_shift_at: Date | null
  shift_kind: string
  onboarding_note: string
  season_outcome: string
  season_leave_reason: string
  reserve: boolean
  bot_channel: string | null
  bot_user_id: string | null
  // bot_link_hash и bot_link_expires_at из базы не выходят
  // 021: поля кейса (кандидатские — в toApplication)
  birth_date: Date | string | null
  start_ready: string
  start_month: number | null
  not_studying: boolean
  // 021: наставник и документы по практике — их переводит toHr в server/db/workflow.ts
  mentor_name: string
  practice_docs: string[] | null
}

/**
 * Колонка date: postgres.js отдаёт её объектом Date на полночь UTC, а строкой — если тип переопределён.
 * В заявке — YYYY-MM-DD или пустая строка
 */
export const birthDateOf = (v: Date | string | null | undefined) =>
  v instanceof Date ? (Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10)) : typeof v === 'string' ? v.slice(0, 10) : ''

export const toApplication = (r: ApplicationRow): Application => {
  const birthDate = birthDateOf(r.birth_date)
  return {
    id: r.id,
    createdAt: r.created_at.toISOString(),
    channel: r.channel as ApplicationChannel,
    name: r.name,
    phone: r.phone,
    contact: r.contact,
    school: r.school,
    course: r.course,
    department: r.department as DepartmentId | '',
    vacancyId: r.vacancy_id,
    format: r.format as VacancyFormat | '',
    months: r.months,
    comment: r.comment,
    friend: r.friend,
    game: r.game,
    source: r.source,
    channelUserId: r.channel_user_id ?? undefined,
    status: r.status as ApplicationStatus,
    statusUpdatedAt: r.status_updated_at.toISOString(),
    notes: r.notes,
    lastName: r.last_name ?? '',
    // 18+ по дате рождения — на сегодня: кандидат, которому было 17, со временем становится взрослым. Без даты — отметка как есть
    adult: isAdultByBirthDate(birthDate) ?? r.adult ?? null,
    citizenship: (r.citizenship ?? '') as Application['citizenship'],
    medBook: (r.med_book ?? '') as Application['medBook'],
    shifts: (r.shifts ?? '') as Application['shifts'],
    portfolio: r.portfolio ?? '',
    middleName: r.middle_name ?? '',
    resumeUrl: r.resume_url ?? '',
    consentAt: r.consent_at?.toISOString() ?? null,
    consentVersion: r.consent_version ?? '',
    consentSource: isConsentSource(r.consent_source) ? r.consent_source : 'none',
    refCode: r.ref_code ?? null,
    practiceSchool: r.practice_school ?? false,
    wantsToStay: r.wants_to_stay ?? false,
    birthDate,
    startReady: isStartReady(r.start_ready) ? r.start_ready : '',
    startMonth: r.start_ready === 'month' && isStartMonth(r.start_month) ? r.start_month : null,
    notStudying: r.not_studying ?? false,
  }
}

/** Отметки документов по практике из строки базы */
export const practiceDocsOf = (r: Pick<ApplicationRow, 'practice_docs'>) => normalizePracticeDocs(r.practice_docs ?? [])

export type { ApplicationRow }

// Сборка заявки живёт в shared/applicationInput.ts — одна для формы, ботов и хранилища в памяти
export { normalizeApplicationInput as normalizeApplication, normalizeProfile } from '@shared/applicationInput'

/** Хранилище на PostgreSQL: сессии ботов, аудитория, заявки и запросы HR-панели */
export class PostgresStorage implements Storage {
  constructor(readonly sql: Sql) {}

  async getSession(user: DialogUser): Promise<Session> {
    // Каждое обращение к боту обновляет «последний визит» в аудитории; заодно — подписка «Напомнить о наборе» (018)
    const [who] = await this.sql<{ remind_on: boolean; remind_dept: string | null }[]>`
      insert into bot_users (channel, user_id, first_name, username)
      values (${user.channel}, ${user.id}, ${user.firstName ?? null}, ${user.username ?? null})
      on conflict (channel, user_id) do update
        set last_seen_at = now(),
            first_name = coalesce(excluded.first_name, bot_users.first_name),
            username = coalesce(excluded.username, bot_users.username)
      returning (remind_at is not null and remind_off_at is null) as remind_on, remind_dept`
    const [row] = await this.sql<{ data: Session }[]>`
      select data from sessions where channel = ${user.channel} and user_id = ${user.id}`
    const remind = who?.remind_on ? { dept: who.remind_dept ?? 'any' } : null
    return { ...emptySession(), ...(row?.data ?? {}), remind }
  }

  async saveSession(user: DialogUser, session: Session): Promise<void> {
    await this.sql`
      insert into sessions (channel, user_id, data)
      values (${user.channel}, ${user.id}, ${this.sql.json(sessionToSave(session) as unknown as postgres.JSONValue)})
      on conflict (channel, user_id) do update set data = excluded.data, updated_at = now()`
    if (session.source) {
      await this.sql`
        update bot_users set source = ${session.source}
        where channel = ${user.channel} and user_id = ${user.id} and source is null`
    }
  }

  /**
   * Заявка кандидата: форма на сайте, чат на сайте или бот. Без согласия не сохраняется — ConsentRequiredError.
   * Моложе 18 по дате рождения — тоже не сохраняется: UnderageError (поля проверяет checkApplication до записи, это страховка).
   * Время согласия — время записи. Код приглашения записывается, если он свободен; занятый код заявку не останавливает.
   * Заполненная ловушка формы (website) — заявка сохраняется с пометкой «похоже на спам».
   * tx — транзакция, в которой проверили повтор заявки (server/candidate/intake.ts)
   */
  async saveApplication(input: ApplicationInput, tx: Tx = this.sql): Promise<Application> {
    const a = normalizeApplicationInput(input)
    const problem = consentError(a)
    if (problem) throw new ConsentRequiredError(problem)
    if (isAdultByBirthDate(a.birthDate) === false) throw new UnderageError()
    // Токен для «Моей заявки»: кандидат получает его один раз, в базе — только хеш
    const status = newStatusToken()
    const write = async (t: postgres.TransactionSql) => {
      const insert = (q: postgres.TransactionSql, refCode: string | null) => q<ApplicationRow[]>`
        insert into applications (id, channel, channel_user_id, name, phone, contact, school, course, department, vacancy_id, format, months, comment, friend, game, source,
                                  last_name, adult, citizenship, med_book, shifts, portfolio, middle_name, status_token_hash,
                                  consent_at, consent_version, consent_source, ref_code, practice_school, wants_to_stay, suspected_spam,
                                  birth_date, start_ready, start_month, not_studying)
        values (${makeApplicationId()}, ${a.channel ?? 'web'}, ${a.channelUserId ?? null}, ${a.name}, ${a.phone}, ${a.contact}, ${a.school}, ${a.course},
                ${a.department}, ${a.vacancyId}, ${a.format}, ${q.json(a.months)},
                ${a.comment}, ${a.friend ?? ''}, ${q.json(a.game as unknown as postgres.JSONValue)}, ${a.source},
                ${a.lastName ?? ''}, ${a.adult ?? null}, ${a.citizenship ?? ''}, ${a.medBook ?? ''}, ${a.shifts ?? ''}, ${a.portfolio ?? ''}, ${a.middleName ?? ''}, ${status.hash},
                now(), ${a.consentVersion ?? ''}, ${a.consentSource ?? 'none'}, ${refCode}, ${a.practiceSchool ?? false}, ${a.wantsToStay ?? false}, ${Boolean(a.website)},
                ${a.birthDate || null}, ${a.startReady ?? ''}, ${a.startMonth ?? null}, ${a.notStudying ?? false})
        returning *`
      // Код уже закреплён за другой заявкой (тот же браузер отправил вторую) — эта уходит без кода
      const withCode = async (code: string) => {
        try {
          return await t.savepoint((sp) => insert(sp, code))
        } catch (e) {
          if ((e as { constraint_name?: string }).constraint_name !== 'applications_ref_code_idx') throw e
          return insert(t, null)
        }
      }
      const [row] = a.refCode ? await withCode(a.refCode) : await insert(t, null)
      // Первая строка истории: заявка пришла
      await t`insert into application_history (application_id, user_name, from_status, to_status) values (${row.id}, 'Кандидат', null, 'new')`
      return row
    }
    const row = 'savepoint' in tx ? await write(tx) : ((await tx.begin(write)) as ApplicationRow)
    return { ...toApplication(row), statusToken: status.token }
  }

  /**
   * Заявка из бота — тем же путём, что с сайта (server/candidate/intake.ts): повтор того же телефона или ника за 10 минут
   * и больше трёх заявок с них за час не сохраняются
   */
  async acceptApplication(input: ApplicationInput): Promise<IntakeResult> {
    return acceptApplication(this, input)
  }

  /** Последняя заявка пользователя бота — чтобы бот ответил «что с моей заявкой». Обезличенные не отдаём */
  async latestApplicationFor(channel: string, channelUserId: string): Promise<HrApplication | null> {
    // Заявка из этого чата или заявка с сайта, привязанная к нему ссылкой start=app_<токен>
    const [row] = await this.sql<{ id: string }[]>`
      select id from applications
      where ((channel = ${channel} and channel_user_id = ${channelUserId}) or (bot_channel = ${channel} and bot_user_id = ${channelUserId}))
        and anonymized_at is null
      order by created_at desc limit 1`
    if (!row) return null
    const { WorkflowRepo } = await import('./workflow')
    return new WorkflowRepo(this.sql).get(row.id)
  }

  /**
   * Ссылки «Получать ответы о заявке в Telegram или MAX» для заявки с сайта: start=app_<токен>.
   * Токен одноразовый, живёт BOT_LINK_TTL_HOURS часов, в базе — только SHA-256. Новая ссылка гасит прежнюю.
   * names — подключённые боты (по умолчанию из TELEGRAM_BOT_USERNAME и MAX_BOT_NICK; адаптер проверяет вызывающий).
   * null — заявки нет, она обезличена или ни один бот не подключён
   */
  async createBotLink(appId: string, names: BotNames = botNamesFromEnv()): Promise<BotLinks | null> {
    if (!Object.keys(botLinks(names, '')).length) return null
    const { token, hash } = newBotLinkToken()
    const rows = await this.sql`
      update applications set bot_link_hash = ${hash}, bot_link_expires_at = now() + make_interval(hours => ${BOT_LINK_TTL_HOURS})
      where id = ${appId} and anonymized_at is null
      returning id`
    return rows.length ? botLinks(names, token) : null
  }

  /**
   * Привязка по токену из start=app_<токен>: заявка получает bot_channel и bot_user_id, channel и source не меняются,
   * токен гаснет. Чужой, повторный и просроченный токен — null, без подробностей
   */
  async linkBotApplication(token: string, user: DialogUser): Promise<{ id: string } | null> {
    if (user.channel === 'web') return null
    const hash = botLinkHash(token)
    return this.sql.begin(async (tx) => {
      const [row] = await tx<{ id: string; bot_link_hash: string | null; fresh: boolean }[]>`
        select id, bot_link_hash, (bot_link_expires_at > now()) as fresh from applications
        where bot_link_hash = ${hash} and anonymized_at is null
        for update`
      if (!row || !row.fresh || !sameBotLinkHash(row.bot_link_hash, token)) return null
      await tx`
        update applications set bot_channel = ${user.channel}, bot_user_id = ${user.id}, bot_link_hash = null, bot_link_expires_at = null
        where id = ${row.id}`
      return { id: row.id }
    })
  }

  /** /stop: заявки с сайта больше не привязаны к этому чату */
  async unlinkBot(user: DialogUser): Promise<number> {
    const rows = await this.sql`
      update applications set bot_channel = null, bot_user_id = null
      where bot_channel = ${user.channel} and bot_user_id = ${user.id}
      returning id`
    return rows.length
  }

  /** «Напомнить о наборе» (sub) или «Не присылать» (null). Время подписки — согласие на напоминания, метка — откуда пришёл */
  async setRemind(user: DialogUser, sub: { dept: string; source: string | null } | null): Promise<void> {
    if (sub) {
      await this.sql`
        insert into bot_users (channel, user_id, remind_at, remind_source, remind_dept, remind_off_at)
        values (${user.channel}, ${user.id}, now(), ${sub.source}, ${sub.dept}, null)
        on conflict (channel, user_id) do update
          set remind_at = now(), remind_source = excluded.remind_source, remind_dept = excluded.remind_dept, remind_off_at = null`
      return
    }
    await this.sql`
      update bot_users set remind_off_at = now()
      where channel = ${user.channel} and user_id = ${user.id} and remind_at is not null and remind_off_at is null`
  }

  /**
   * «Удалить мои данные» из бота: заявки этого чата и привязанные к нему с сайта обезличиваются, диалог удаляется,
   * имя, ник и подписка стираются. Строка аудитории остаётся — отчёт по каналам и источникам не меняется.
   * Если в server/retention есть eraseBotUser (w2-platform), стирает он; дальше — то же самое здесь, повтор ничего не портит
   */
  async eraseUser(user: DialogUser): Promise<{ applications: number }> {
    const ids = (
      await this.sql<{ id: string }[]>`
        select id from applications
        where ((channel = ${user.channel} and channel_user_id = ${user.id}) or (bot_channel = ${user.channel} and bot_user_id = ${user.id}))
          and anonymized_at is null`
    ).map((r) => r.id)
    const retention = (await import('../retention')) as Record<string, unknown>
    if (typeof retention.eraseBotUser === 'function') await (retention.eraseBotUser as (sql: Sql, channel: string, id: string) => Promise<unknown>)(this.sql, user.channel, user.id)
    const { eraseOnRequest } = await import('../retention')
    const by = { id: 0, email: '', name: 'Кандидат в боте', role: 'hr' as const, disabled: false, createdAt: new Date().toISOString(), lastLoginAt: null }
    for (const id of ids) await eraseOnRequest(this.sql, id, by, 'Запрос кандидата: «Удалить мои данные» в боте', [])
    await this.sql`update applications set bot_channel = null, bot_user_id = null where id = any(${ids})`
    await this.sql`delete from sessions where channel = ${user.channel} and user_id = ${user.id}`
    await this.sql`
      update bot_users set first_name = null, username = null, remind_at = null, remind_source = null, remind_dept = null, remind_off_at = null
      where channel = ${user.channel} and user_id = ${user.id}`
    return { applications: ids.length }
  }

  /** Статус заявки по номеру и токену — для чата на сайте */
  async statusForToken(id: string, token: string): Promise<CandidateStatus | null> {
    return statusForToken(this.sql, id, token)
  }

  /** Рабочее время и праздники — чтобы статус «не позвонили вовремя» считался по календарю отдела */
  async workSettings(): Promise<WorkSettings> {
    const { HrRepo } = await import('./hr')
    return new HrRepo(this.sql).workSettings()
  }

  async listApplications(): Promise<Application[]> {
    const rows = await this.sql<ApplicationRow[]>`select * from applications order by created_at desc limit 5000`
    return rows.map(toApplication)
  }

  async clearApplications(): Promise<number> {
    const rows = await this.sql`delete from applications returning id`
    return rows.length
  }

  /** Вопрос без ответа от помощника */
  async logGap(gap: KbGapInput): Promise<void> {
    await this.sql`
      insert into kb_gaps (channel, topic, question)
      values (${gap.channel}, ${gap.topic.slice(0, 120)}, ${gap.question.slice(0, 1000)})`
  }

  /** Пробелы базы знаний для HR: последние вопросы и самые частые темы */
  async listGaps(limit = 200) {
    const items = await this.sql<{ id: string; created_at: Date; channel: string; topic: string; question: string }[]>`
      select id, created_at, channel, topic, question from kb_gaps where not resolved order by created_at desc limit ${limit}`
    const topics = await this.sql<{ topic: string; count: number }[]>`
      select topic, count(*)::int as count from kb_gaps where not resolved group by topic order by count desc limit 30`
    return {
      items: items.map((r) => ({ id: Number(r.id), createdAt: r.created_at.toISOString(), channel: r.channel, topic: r.topic, question: r.question })),
      topics,
    }
  }

  /** Аудитория ботов по каналам и источникам — для HR-панели */
  async botAudience() {
    return this.sql<{ channel: string; source: string | null; users: number }[]>`
      select channel, source, count(*)::int as users from bot_users group by channel, source order by users desc`
  }

  async ping() {
    await this.sql`select 1`
  }
}
