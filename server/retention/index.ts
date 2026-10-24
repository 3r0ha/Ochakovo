import type { Sql } from '../db'
import type { HrRepo, HrUser } from '../db/hr'

// Срок хранения персональных данных (152-ФЗ). Обещание на странице «Политика обработки данных»:
// заявку храним в течение сезона и ещё 12 месяцев, потом удаляем; шаг диалога с ботом — пока человек
// пользуется ботом. Здесь это исполняется:
// — заявки без изменений статуса дольше RETENTION_MONTHS обезличиваются: стираются имя, фамилия, телефон,
//   контакты, дата рождения, учёба, друг, портфолио, комментарии, заметки и тексты сообщений, привязка к боту,
//   адрес и «что взять» у собеседования. Остаются вакансия, месяцы, источник, статусы, даты и категории анкеты —
//   воронка не ломается;
// — аудитория ботов: строка человека (канал и id в мессенджере, имя, ник, подписка) удаляется, если он не заходил
//   дольше срока; на её место встаёт обезличенная строка-счётчик (eraseBotUsers) — отчёты не меняются задним числом;
//   сессии диалогов удаляются;
// — вопросы к помощнику старше срока удаляются: в тексте вопроса могут оказаться личные данные.
// Раз в сутки из планировщика, пачками, под рекомендательной блокировкой; повторный запуск ничего не портит.
//
// По запросу: HR в карточке (eraseOnRequest), сам кандидат — «Отозвать согласие» на сайте (server/candidate/rights.ts)
// и «Удалить мои данные» в боте (eraseBotUser). В журнале удаления видно, кто попросил: auto, request или candidate.

const LOCK = 'ochakovo:retention'
const BATCH = 200
const STATE = 'retention'

export function retentionMonths(env: NodeJS.ProcessEnv = process.env) {
  const v = Number(env.RETENTION_MONTHS)
  return Number.isInteger(v) && v >= 1 && v <= 120 ? v : 12
}

/** Граница: всё, что не менялось раньше этого момента, — старше срока */
export function retentionCutoff(now: Date, months: number) {
  const d = new Date(now)
  d.setUTCMonth(d.getUTCMonth() - months)
  return d
}

type Scope = 'applications' | 'bot_users' | 'sessions' | 'kb_gaps'
/** auto — истёк срок, request — HR по запросу кандидата, candidate — сам кандидат на сайте или в боте */
export type RetentionKind = 'auto' | 'request' | 'candidate'

/** Кто попросил удалить, если это не сотрудник: имя для журнала */
export const CANDIDATE = 'Кандидат'

async function log(
  sql: Sql,
  e: { kind: RetentionKind; scope: Scope; count: number; by?: HrUser | null; who?: string; reason: string; applicationId?: string },
) {
  const name = e.by?.name ?? e.who ?? (e.kind === 'candidate' ? CANDIDATE : 'автоматически')
  await sql`
    insert into retention_log (kind, scope, count, user_id, user_name, reason, application_id)
    values (${e.kind}, ${e.scope}, ${e.count}, ${e.by && e.by.id > 0 ? e.by.id : null}, ${name}, ${e.reason.slice(0, 300)},
            ${e.applicationId ?? null})`
}

/**
 * Обезличить заявки по списку id. Возвращает, сколько обезличено (уже обезличенные не считаются).
 * reason в заявке — только retention или request: по ней HR видит «удалено по сроку» или «по запросу кандидата»
 */
export async function wipeApplications(sql: Sql, ids: string[], reason: 'retention' | 'request') {
  if (!ids.length) return 0
  return sql.begin(async (tx) => {
    // Дата рождения — личные данные; привязка к боту — id человека в мессенджере, ссылка привязки гаснет.
    // Токен статуса стирается: «Моя заявка», отзыв согласия и ссылка на бота по нему больше не работают
    const rows = await tx<{ id: string }[]>`
      update applications set
        name = '', last_name = '', middle_name = '', phone = '', contact = '', school = '', friend = '', portfolio = '', resume_url = '',
        comment = '', notes = '', birth_date = null,
        callback_note = '', callback_at = null, channel_user_id = null, status_token_hash = null,
        bot_channel = null, bot_user_id = null, bot_link_hash = null, bot_link_expires_at = null,
        anonymized_at = now(), anonymized_reason = ${reason}
      where id = any(${ids}) and anonymized_at is null
      returning id`
    const done = rows.map((r) => r.id)
    if (!done.length) return 0
    // Комментарии HR и тексты сообщений могут содержать имя и телефон; «кто вёл» и «склеена с …» — нет
    await tx`
      update application_history set comment = '', notify_detail = ''
      where application_id = any(${done}) and kind not in ('assign', 'merge')`
    await tx`update interviews set address = '', bring = '' where application_id = any(${done})`
    // В задачах очереди — готовые тексты сообщений с именем: письма, SMS, напоминания этой заявке больше не уйдут
    await tx`delete from jobs where payload ->> 'applicationId' = any(${done})`
    return done.length
  })
}

type BotUserKey = readonly [channel: string, userId: string]

/** Чаты, к которым привязаны заявки с сайта (bot_channel и bot_user_id) */
async function botLinksOf(sql: Sql, ids: string[]): Promise<BotUserKey[]> {
  if (!ids.length) return []
  const rows = await sql<{ bot_channel: string; bot_user_id: string }[]>`
    select distinct bot_channel, bot_user_id from applications where id = any(${ids}) and bot_user_id is not null and bot_channel is not null`
  return rows.map((r) => [r.bot_channel, r.bot_user_id] as const)
}

/**
 * Удалить строки аудитории ботов этих людей целиком: канал и id в мессенджере, имя, ник, подписку «Напомнить о наборе».
 * Вместо каждой — обезличенная строка-счётчик (erased): тот же канал и метка источника, час прихода, день последнего
 * визита и случайный id. Так «Пришли» в воронке и аудитория по каналам за прошлые периоды не меняются.
 * Заодно удаляются диалоги с ботом и гаснет привязка заявок с сайта к этому чату. Повторный вызов ничего не портит
 */
export async function eraseBotUsers(sql: Sql, pairs: BotUserKey[]): Promise<{ botUsers: number; sessions: number }> {
  const uniq = [...new Map(pairs.filter(([c, u]) => c && u).map((p) => [`${p[0]}\u0000${p[1]}`, p])).values()]
  if (!uniq.length) return { botUsers: 0, sessions: 0 }
  const channels = uniq.map((p) => p[0])
  const users = uniq.map((p) => p[1])
  return sql.begin(async (tx) => {
    const gone = await tx`
      with gone as (
        delete from bot_users
        where (channel, user_id) in (select * from unnest(${channels}::text[], ${users}::text[])) and not erased
        returning channel, source, created_at, last_seen_at
      )
      insert into bot_users (channel, user_id, source, created_at, last_seen_at, erased)
      select channel, 'erased:' || gen_random_uuid(), source, date_trunc('hour', created_at), date_trunc('day', last_seen_at), true from gone
      returning 1`
    const sessions = await tx`delete from sessions where (channel, user_id) in (select * from unnest(${channels}::text[], ${users}::text[])) returning 1`
    await tx`
      update applications set bot_channel = null, bot_user_id = null, bot_link_hash = null, bot_link_expires_at = null
      where bot_user_id is not null and (bot_channel, bot_user_id) in (select * from unnest(${channels}::text[], ${users}::text[]))`
    return { botUsers: gone.length, sessions: sessions.length }
  })
}

/**
 * «Удалить мои данные» в боте (w2-bot): строка аудитории этого чата, диалог и привязка заявок с сайта к нему.
 * Сами заявки обезличивает вызывающий (eraseOnRequest) — у них своя запись в журнале.
 * По умолчанию в журнале — «кандидат» (kind candidate); HR передаёт by и kind request
 */
export async function eraseBotUser(
  sql: Sql,
  channel: string,
  userId: string,
  opts: { kind?: RetentionKind; by?: HrUser | null; reason?: string; applicationId?: string } = {},
) {
  const result = await eraseBotUsers(sql, [[channel, userId]])
  const kind = opts.kind ?? 'candidate'
  const reason = opts.reason ?? 'кандидат удалил свои данные в боте'
  if (result.botUsers) await log(sql, { kind, scope: 'bot_users', count: result.botUsers, by: opts.by, reason, applicationId: opts.applicationId })
  if (result.sessions) await log(sql, { kind, scope: 'sessions', count: result.sessions, by: opts.by, reason, applicationId: opts.applicationId })
  return result
}

export type RetentionResult = { applications: number; botUsers: number; sessions: number; kbGaps: number } | { busy: true }

/** Обезличить всё, что старше срока. now — для проверок с подставными часами */
export async function runRetention(opts: { sql: Sql; env?: NodeJS.ProcessEnv; now?: Date; by?: HrUser | null }): Promise<RetentionResult> {
  const { sql } = opts
  const months = retentionMonths(opts.env)
  const cutoff = retentionCutoff(opts.now ?? new Date(), months)
  const reserved = await sql.reserve()
  try {
    const [{ locked }] = await reserved<{ locked: boolean }[]>`select pg_try_advisory_lock(hashtext(${LOCK})) as locked`
    if (!locked) return { busy: true }
    try {
      let applications = 0
      for (;;) {
        const ids = (await sql<{ id: string }[]>`
          select id from applications where anonymized_at is null and status_updated_at < ${cutoff} order by status_updated_at limit ${BATCH}`).map((r) => r.id)
        if (!ids.length) break
        applications += await wipeApplications(sql, ids, 'retention')
        if (ids.length < BATCH) break
      }

      // Аудитория ботов: кто не заходил дольше срока — строка удаляется, на её место встаёт обезличенный счётчик
      let botUsers = 0
      let sessions = 0
      for (;;) {
        const rows = await sql<{ channel: string; user_id: string }[]>`
          select channel, user_id from bot_users where last_seen_at < ${cutoff} and not erased limit ${BATCH * 5}`
        if (!rows.length) break
        const erased = await eraseBotUsers(sql, rows.map((r) => [r.channel, r.user_id] as const))
        botUsers += erased.botUsers
        sessions += erased.sessions
        if (rows.length < BATCH * 5) break
      }

      for (;;) {
        const rows = await sql`
          delete from sessions where (channel, user_id) in (select channel, user_id from sessions where updated_at < ${cutoff} limit ${BATCH * 5})
          returning 1`
        sessions += rows.length
        if (rows.length < BATCH * 5) break
      }

      const gaps = await sql`delete from kb_gaps where created_at < ${cutoff} returning 1`
      const kbGaps = gaps.length
      // Журнал выгрузок держим столько же, сколько заявки: в нём номера заявок, личных данных нет
      await sql`delete from access_log where created_at < ${cutoff}`

      const reason = `истёк срок хранения: ${months} мес.`
      for (const [scope, count] of [['applications', applications], ['bot_users', botUsers], ['sessions', sessions], ['kb_gaps', kbGaps]] as const)
        if (count) await log(sql, { kind: 'auto', scope, count, by: opts.by ?? null, reason })
      return { applications, botUsers, sessions, kbGaps }
    } finally {
      await reserved`select pg_advisory_unlock(hashtext(${LOCK}))`
    }
  } finally {
    reserved.release()
  }
}

export type ErasePreview = {
  applications: { id: string; name: string; status: string; createdAt: string; why: string }[]
  /** Пользователи ботов этого человека: имя и ник сотрём, диалог удалим */
  botUsers: { channel: string; userId: string; label: string }[]
}

/**
 * Что сотрёт «Удалить по запросу»: эта заявка, склеенные с ней дубли, другие заявки того же человека
 * (тот же телефон, почта, резюме hh.ru или пользователь бота) и их дубли, данные бота. Только ещё не обезличенное
 */
export async function erasePreview(sql: Sql, applicationId: string): Promise<ErasePreview | null> {
  const [main] = await sql<{ id: string; phone_norm: string | null; contact: string; resume_url: string; channel: string; channel_user_id: string | null; anonymized_at: Date | null }[]>`
    select id, phone_norm, contact, resume_url, channel, channel_user_id, anonymized_at from applications where id = ${applicationId}`
  if (!main) return null
  const email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(main.contact.trim()) ? main.contact.trim().toLowerCase() : ''
  const phone = main.phone_norm && main.phone_norm.length >= 10 ? main.phone_norm : ''
  const rows = await sql<{ id: string; name: string; last_name: string; status: string; created_at: Date; channel: string; channel_user_id: string | null; why: string }[]>`
    with person as (
      select id from applications
      where id = ${main.id}
         or (${phone !== ''} and phone_norm = ${phone})
         or (${email !== ''} and lower(trim(contact)) = ${email})
         or (${main.resume_url !== ''} and resume_url = ${main.resume_url})
         or (${main.channel_user_id !== null} and channel = ${main.channel} and channel_user_id = ${main.channel_user_id ?? ''})
    )
    select a.id, a.name, a.last_name, a.status, a.created_at, a.channel, a.channel_user_id,
      case when a.id = ${main.id} then 'эта заявка'
           when a.duplicate_of = ${main.id} then 'склеенный дубль'
           when a.duplicate_of is not null then 'дубль заявки ' || a.duplicate_of
           when ${phone !== ''} and a.phone_norm = ${phone} then 'тот же телефон'
           when ${email !== ''} and lower(trim(a.contact)) = ${email} then 'та же почта'
           when ${main.resume_url !== ''} and a.resume_url = ${main.resume_url} then 'то же резюме hh.ru'
           else 'тот же пользователь бота' end as why
    from applications a
    where a.anonymized_at is null
      and (a.id in (select id from person) or a.duplicate_of in (select id from person) or a.duplicate_of = ${main.id})
    order by (a.id = ${main.id}) desc, a.created_at desc
    limit 100`
  const pairs = [...new Map(rows.filter((r) => r.channel_user_id && r.channel !== 'web' && r.channel !== 'hr').map((r) => [`${r.channel}:${r.channel_user_id}`, [r.channel, r.channel_user_id!] as const])).values()]
  if (main.channel_user_id && !pairs.some(([c, u]) => c === main.channel && u === main.channel_user_id)) pairs.push([main.channel, main.channel_user_id])
  // Заявки с сайта, привязанные к чату ссылкой start=app_<токен>: тот же человек в боте
  for (const p of await botLinksOf(sql, rows.map((r) => r.id))) if (!pairs.some(([c, u]) => c === p[0] && u === p[1])) pairs.push(p)
  const users = pairs.length
    ? await sql<{ channel: string; user_id: string; first_name: string | null; username: string | null; has_session: boolean }[]>`
        select b.channel, b.user_id, b.first_name, b.username,
          exists (select 1 from sessions s where s.channel = b.channel and s.user_id = b.user_id) as has_session
        from bot_users b
        where (b.channel, b.user_id) in (select * from unnest(${pairs.map((p) => p[0])}::text[], ${pairs.map((p) => p[1])}::text[]))`
    : []
  const botName = (c: string) => (c === 'max' ? 'MAX' : 'Telegram')
  return {
    applications: rows.map((r) => ({
      id: r.id,
      name: [r.last_name, r.name].filter(Boolean).join(' '),
      status: r.status,
      createdAt: r.created_at.toISOString(),
      why: r.why,
    })),
    botUsers: users
      .filter((u) => u.first_name || u.username || u.has_session)
      .map((u) => ({
        channel: u.channel,
        userId: u.user_id,
        label: [`${botName(u.channel)}:`, u.first_name, u.username ? `@${u.username}` : '', u.has_session ? '· диалог с ботом' : ''].filter(Boolean).join(' '),
      })),
  }
}

/**
 * «Удалить по запросу кандидата»: сразу, с обязательной причиной. ids — заявки, которые HR подтвердил в списке
 * (из erasePreview; эта заявка — всегда). Данные бота этого человека стираются вместе с заявками
 */
export async function eraseOnRequest(sql: Sql, applicationId: string, by: HrUser, reason: string, confirmed?: string[]) {
  const preview = await erasePreview(sql, applicationId)
  if (!preview) return null
  const known = new Set(preview.applications.map((a) => a.id))
  const ids = confirmed ? [applicationId, ...confirmed.filter((id) => known.has(id))] : [...known]
  // Пользователи ботов — только тех заявок, что стираем: заявки из бота и заявки с сайта, привязанные к чату
  const unique = [...new Set(ids)]
  const pairs: BotUserKey[] = unique.length
    ? [
        ...(
          await sql<{ channel: string; channel_user_id: string }[]>`
            select distinct channel, channel_user_id from applications where id = any(${unique}) and channel_user_id is not null and channel in ('telegram', 'max')`
        ).map((r) => [r.channel, r.channel_user_id] as const),
        ...(await botLinksOf(sql, unique)),
      ]
    : []
  const count = await wipeApplications(sql, unique, 'request')
  // Строки аудитории этих людей удаляются целиком, счётчики остаются обезличенными (eraseBotUsers)
  const { botUsers, sessions } = await eraseBotUsers(sql, pairs)
  if (count) await log(sql, { kind: 'request', scope: 'applications', count, by, reason, applicationId })
  if (botUsers) await log(sql, { kind: 'request', scope: 'bot_users', count: botUsers, by, reason, applicationId })
  if (sessions) await log(sql, { kind: 'request', scope: 'sessions', count: sessions, by, reason, applicationId })
  return { applications: count, botUsers, sessions }
}

/**
 * Кандидат сам отозвал согласие («Моя заявка» на сайте): заявка обезличивается сразу, задачи очереди снимаются,
 * токен статуса и привязка к боту стираются. В журнале удаления — «кандидат» (kind candidate).
 * Только эта заявка: ключ из браузера подтверждает её одну. 0 — уже обезличена
 */
export async function eraseByCandidate(sql: Sql, applicationId: string, reason: string) {
  const count = await wipeApplications(sql, [applicationId], 'request')
  if (count) await log(sql, { kind: 'candidate', scope: 'applications', count, reason, applicationId })
  return count
}

/** Раз в сутки — из планировщика */
export async function retentionIfDue(opts: { sql: Sql; repo: HrRepo; env?: NodeJS.ProcessEnv; now?: Date }) {
  const now = opts.now ?? new Date()
  const state = await opts.repo.integration<{ lastRunAt?: string }>(STATE)
  if (state.lastRunAt && now.getTime() - Date.parse(state.lastRunAt) < 24 * 3600e3) return null
  const result = await runRetention(opts)
  if (!('busy' in result)) await opts.repo.patchIntegration(STATE, { lastRunAt: now.toISOString(), last: result })
  return result
}

export type RetentionEntry = { id: number; createdAt: string; kind: RetentionKind; scope: Scope; count: number; userName: string; reason: string; applicationId: string | null }

export async function retentionLog(sql: Sql, limit = 100): Promise<RetentionEntry[]> {
  const rows = await sql<{ id: string; created_at: Date; kind: RetentionKind; scope: Scope; count: number; user_name: string; reason: string; application_id: string | null }[]>`
    select * from retention_log order by created_at desc, id desc limit ${limit}`
  return rows.map((r) => ({
    id: Number(r.id),
    createdAt: r.created_at.toISOString(),
    kind: r.kind,
    scope: r.scope,
    count: r.count,
    userName: r.user_name,
    reason: r.reason,
    applicationId: r.application_id,
  }))
}
