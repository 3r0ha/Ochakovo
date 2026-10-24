import { departments, type DepartmentId } from '@shared/content/departments'
import { paidPracticeInfo } from '@shared/content/practice'
import { formatRub } from '@shared/content/vacancies'
import type { Sql } from '../db'
import type { OutMessage } from '../dialog/types'
import { btn } from '../dialog/ui'
import { MaxApiError } from './max'
import type { Registry } from './registry'
import { sleep, type Logger } from './render'
import { TelegramApiError } from './telegram'

// Рассылка подписавшимся на «Напомнить о наборе» (подписка — server/dialog/flows/remind.ts, миграция 018).
// Только Telegram и MAX: в чате на сайте подписки нет. Только тем, кто подписался и не нажал «Не присылать».
// Не чаще раза в неделю на человека (bot_users.last_broadcast_at). В каждом сообщении — кнопка «Не присылать».
// Отправка пачками через адаптеры: не больше BATCH сообщений в секунду на оба мессенджера — в пределах лимитов
// Telegram (около 30 сообщений в секунду разным людям) и MAX (30 запросов в секунду).
// Журнал — таблица broadcasts (миграция 019): сколько доставлено, сколько заблокировали бота, сколько отписались.

export type RecruitState = 'closed' | 'open'
export type BroadcastKind = 'open' | 'deadline'
export type BroadcastSegment = 'all' | 'dept' | 'tasks'
export type BroadcastChannel = 'telegram' | 'max'

export const broadcastChannels: BroadcastChannel[] = ['telegram', 'max']
export const broadcastKinds: BroadcastKind[] = ['open', 'deadline']
export const broadcastSegments: BroadcastSegment[] = ['all', 'dept', 'tasks']

/** Не чаще раза в столько дней на человека */
export const BROADCAST_EVERY_DAYS = 7
/** «До конца приёма» отправляется, когда до конца срока осталось столько дней или меньше */
export const DEADLINE_DAYS = 7
/** Сколько сообщений уходит за секунду */
export const BATCH = 20
/** Сколько ждать ответа мессенджера на одно сообщение */
const SEND_TIMEOUT_MS = 20_000

export const OFF_LABEL = 'Не присылать'

export type Recruit = {
  state: RecruitState
  /** Срок окончания приёма, ГГГГ-ММ-ДД; null — срок не задан */
  endsOn: string | null
  /** Сколько дней до конца приёма по Москве; null — срока нет */
  daysLeft: number | null
  updatedAt: string | null
  updatedBy: string
}

export async function getRecruit(sql: Sql): Promise<Recruit> {
  const [r] = await sql<{ state: RecruitState; ends_on: string | null; days_left: number | null; updated_at: Date | null; updated_by: string }[]>`
    select state, to_char(ends_on, 'YYYY-MM-DD') as ends_on,
           (ends_on - (now() at time zone 'Europe/Moscow')::date)::int as days_left, updated_at, updated_by
    from recruit_state where id = 1`
  if (!r) return { state: 'closed', endsOn: null, daysLeft: null, updatedAt: null, updatedBy: '' }
  return { state: r.state, endsOn: r.ends_on, daysLeft: r.days_left, updatedAt: r.updated_at?.toISOString() ?? null, updatedBy: r.updated_by }
}

/** Проверка нового состояния набора. Срок — ГГГГ-ММ-ДД, не раньше сегодняшнего дня по Москве и не дальше года */
export function recruitProblem(input: { state?: unknown; endsOn?: unknown }, todayMsk: string): string | null {
  if (input.state !== 'open' && input.state !== 'closed') return 'Выбери: набор открыт или закрыт'
  if (input.endsOn === null || input.endsOn === undefined || input.endsOn === '') return null
  if (typeof input.endsOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.endsOn)) return 'Срок окончания нужно выбрать в календаре'
  const d = new Date(`${input.endsOn}T00:00:00Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== input.endsOn) return 'Такой даты нет'
  const days = Math.round((d.getTime() - new Date(`${todayMsk}T00:00:00Z`).getTime()) / 864e5)
  if (days < 0) return 'Срок окончания уже прошёл'
  if (days > 366) return 'Срок окончания можно поставить не дальше чем через год'
  return null
}

/** Сегодняшний день по Москве, ГГГГ-ММ-ДД */
export const todayMsk = (now = new Date()) => new Date(now.getTime() + 3 * 3600e3).toISOString().slice(0, 10)

export async function setRecruit(sql: Sql, input: { state: RecruitState; endsOn: string | null }, by: string): Promise<Recruit> {
  await sql`
    insert into recruit_state (id, state, ends_on, updated_at, updated_by)
    values (1, ${input.state}, ${input.endsOn}, now(), ${by})
    on conflict (id) do update set state = excluded.state, ends_on = excluded.ends_on, updated_at = now(), updated_by = excluded.updated_by`
  return getRecruit(sql)
}

/** Какие сообщения можно отправить сейчас и почему нельзя остальные */
export function kindsAvailable(r: Recruit): Record<BroadcastKind, string | null> {
  if (r.state === 'closed') {
    const closed = 'Набор закрыт. Рассылка откроется вместе с набором.'
    return { open: closed, deadline: closed }
  }
  if (r.daysLeft !== null && r.daysLeft < 0) {
    const over = 'Срок приёма прошёл: обнови срок или закрой набор.'
    return { open: over, deadline: over }
  }
  return {
    open: null,
    deadline:
      r.daysLeft === null
        ? 'Срок окончания приёма не задан.'
        : r.daysLeft > DEADLINE_DAYS
          ? `До конца приёма больше недели. Сообщение можно отправить за ${DEADLINE_DAYS} дней до срока.`
          : null,
  }
}

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10
  const m100 = n % 100
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)

const listRu = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} и ${items.at(-1)}`)

/** Заголовок сообщения о сроке: «До конца приёма заявок осталась неделя», «осталось 3 дня», «Сегодня последний день приёма заявок» */
export function deadlineTitle(daysLeft: number) {
  if (daysLeft <= 0) return 'Сегодня последний день приёма заявок'
  if (daysLeft === 7) return 'До конца приёма заявок осталась неделя'
  if (daysLeft === 1) return 'До конца приёма заявок остался один день'
  return `До конца приёма заявок ${plural(daysLeft, 'остался', 'осталось', 'осталось')} ${daysLeft} ${plural(daysLeft, 'день', 'дня', 'дней')}`
}

/**
 * Сообщение рассылки. Без дат: сообщение читают и через день, и через неделю, а сроки называются словами.
 * Кнопки — откликнуться, оплачиваемая практика и «Не присылать» (rm:off из сценария подписки)
 */
export function broadcastMessage(kind: BroadcastKind, opts: { dept?: string | null; daysLeft?: number | null } = {}): OutMessage {
  const units = listRu(paidPracticeInfo.units.map(lower))
  const title = kind === 'open' ? 'Открыт набор на сезон в «Очаково»' : deadlineTitle(opts.daysLeft ?? DEADLINE_DAYS)
  const dept = opts.dept && departments[opts.dept as DepartmentId]
  const lines = [
    `**${title}**`,
    `На оплачиваемой практике платят от ${paidPracticeInfo.payFrom.toLocaleString('ru-RU')} до ${formatRub(paidPracticeInfo.payTo)} в месяц до вычета налога. Отделы: ${units}. К каждому новичку прикрепляют наставника.`,
    ...(dept ? [`Направление «${dept.name}»: ${listRu(dept.tasks.map(lower))}.`] : []),
    'Заявку можно оставить прямо здесь, в боте, это займёт пару минут.',
    `Напоминание о наборе приходит не чаще раза в неделю. Чтобы отписаться, нажми «${OFF_LABEL}».`,
  ]
  return {
    text: lines.join('\n\n'),
    buttons: [[btn('Откликнуться', 'm:apply'), btn('Практика', 'm:prac')], [btn(OFF_LABEL, 'rm:off')]],
  }
}

// ── Кому отправлять ──────────────────────────────────────────────────────

export type Recipient = { channel: BroadcastChannel; userId: string; recent: boolean }

export type Audience = {
  /** Подписаны и подходят под сегмент */
  total: number
  /** Уйдёт сейчас: не получали рассылку неделю и бот мессенджера подключён */
  ready: number
  /** Получали рассылку меньше недели назад */
  recent: number
  /** Бот их мессенджера не подключён */
  offline: number
  byChannel: Record<BroadcastChannel, number>
}

/** Каналы, через которые можно отправить: адаптер поднят и умеет писать первым */
export const sendableChannels = (bots: Registry): BroadcastChannel[] =>
  broadcastChannels.filter((c) => Boolean(bots.get(c)?.adapter.sendTo))

export type SegmentQuery = { segment: BroadcastSegment; dept?: string | null }

/**
 * Подписчики сегмента: подписаны («Напомнить о наборе») и не нажали «Не присылать», не заблокировали бота
 * (или вернулись в него после блокировки). По направлению — подписанные на него и на любое направление.
 * «Прошли задания без заявки» — хотя бы одно задание «Смены» в боте и ни одной действующей заявки из этого чата
 */
export async function recipients(sql: Sql, q: SegmentQuery): Promise<Recipient[]> {
  const dept = q.segment === 'dept' ? (q.dept ?? '') : null
  const tasks = q.segment === 'tasks'
  const rows = await sql<{ channel: BroadcastChannel; user_id: string; recent: boolean }[]>`
    select b.channel, b.user_id,
           coalesce(b.last_broadcast_at > now() - make_interval(days => ${BROADCAST_EVERY_DAYS}), false) as recent
    from bot_users b
    where b.channel in ('telegram', 'max')
      and not b.erased
      and b.remind_at is not null and b.remind_off_at is null
      and (b.blocked_at is null or b.blocked_at < b.last_seen_at)
      and (${dept}::text is null or b.remind_dept is null or b.remind_dept in (${dept ?? ''}, 'any'))
      and (not ${tasks}::boolean or (
        exists (
          select 1 from sessions s, jsonb_each(coalesce(s.data -> 'progress', '{}'::jsonb)) p
          where s.channel = b.channel and s.user_id = b.user_id
            and p.key in ('game', 'money', 'quiz', 'myth') and p.value not in ('false'::jsonb, 'null'::jsonb))
        and not exists (
          select 1 from applications a
          where a.anonymized_at is null
            and ((a.channel = b.channel and a.channel_user_id = b.user_id) or (a.bot_channel = b.channel and a.bot_user_id = b.user_id)))))
    order by b.remind_at`
  return rows.map((r) => ({ channel: r.channel, userId: r.user_id, recent: r.recent }))
}

export function audienceOf(list: Recipient[], online: BroadcastChannel[]): Audience {
  const byChannel: Record<BroadcastChannel, number> = { telegram: 0, max: 0 }
  let ready = 0
  let recent = 0
  let offline = 0
  for (const r of list) {
    byChannel[r.channel]++
    if (!online.includes(r.channel)) offline++
    else if (r.recent) recent++
    else ready++
  }
  return { total: list.length, ready, recent, offline, byChannel }
}

/** Подписчики по каналам и направлениям — сводка над формой рассылки */
export async function subscribers(sql: Sql) {
  const rows = await sql<{ channel: BroadcastChannel; dept: string; n: number }[]>`
    select channel, coalesce(remind_dept, 'any') as dept, count(*)::int as n
    from bot_users
    where channel in ('telegram', 'max') and not erased and remind_at is not null and remind_off_at is null
    group by 1, 2`
  const byChannel: Record<BroadcastChannel, number> = { telegram: 0, max: 0 }
  const byDept: Record<string, number> = {}
  for (const r of rows) {
    byChannel[r.channel] += r.n
    byDept[r.dept] = (byDept[r.dept] ?? 0) + r.n
  }
  return { total: byChannel.telegram + byChannel.max, byChannel, byDept }
}

// ── Журнал ───────────────────────────────────────────────────────────────

export type BroadcastStatus = 'sending' | 'done' | 'interrupted'

export type BroadcastEntry = {
  id: number
  createdAt: string
  finishedAt: string | null
  userName: string
  kind: BroadcastKind
  segment: BroadcastSegment
  dept: string | null
  text: string
  status: BroadcastStatus
  recipients: number
  delivered: number
  blocked: number
  failed: number
  skippedRecent: number
  skippedOffline: number
  /** Нажали «Не присылать» после этой рассылки */
  unsubscribed: number
}

type BroadcastRow = {
  id: string
  created_at: Date
  finished_at: Date | null
  user_name: string
  kind: BroadcastKind
  segment: BroadcastSegment
  dept: string | null
  text: string
  status: BroadcastStatus
  recipients: number
  delivered: number
  blocked: number
  failed: number
  skipped_recent: number
  skipped_offline: number
  unsubscribed: number
}

const toEntry = (r: BroadcastRow): BroadcastEntry => ({
  id: Number(r.id),
  createdAt: r.created_at.toISOString(),
  finishedAt: r.finished_at?.toISOString() ?? null,
  userName: r.user_name,
  kind: r.kind,
  segment: r.segment,
  dept: r.dept,
  text: r.text,
  status: r.status,
  recipients: r.recipients,
  delivered: r.delivered,
  blocked: r.blocked,
  failed: r.failed,
  skippedRecent: r.skipped_recent,
  skippedOffline: r.skipped_offline,
  unsubscribed: r.unsubscribed,
})

/** Рассылки, которые отправляет этот процесс. Остальные «отправляются» только в журнале — сервер перезапускался */
const running = new Map<number, Promise<void>>()

/** Рассылка, прерванная перезапуском сервера, больше не держит место «одна за раз» */
async function closeStale(sql: Sql) {
  await sql`
    update broadcasts set status = 'interrupted', finished_at = now()
    where status = 'sending' and not (id = any(${[...running.keys()]}::bigint[]))`
}

export async function listBroadcasts(sql: Sql, limit = 50): Promise<BroadcastEntry[]> {
  await closeStale(sql)
  const rows = await sql<BroadcastRow[]>`
    select b.*,
           (select count(*)::int from bot_users u where u.last_broadcast_id = b.id and u.remind_off_at >= b.created_at) as unsubscribed
    from broadcasts b order by b.created_at desc, b.id desc limit ${limit}`
  return rows.map(toEntry)
}

export async function getBroadcast(sql: Sql, id: number): Promise<BroadcastEntry | null> {
  const [row] = await sql<BroadcastRow[]>`
    select b.*,
           (select count(*)::int from bot_users u where u.last_broadcast_id = b.id and u.remind_off_at >= b.created_at) as unsubscribed
    from broadcasts b where b.id = ${id}`
  return row ? toEntry(row) : null
}

/** Дождаться конца рассылки этого процесса — для проверок */
export const broadcastDone = (id: number) => running.get(id) ?? Promise.resolve()

// ── Отправка ─────────────────────────────────────────────────────────────

/** Ошибка доставки: blocked — человек заблокировал бота (403), failed — остальное */
export function deliveryProblem(e: unknown): 'blocked' | 'failed' {
  if (e instanceof TelegramApiError) return e.code === 403 ? 'blocked' : 'failed'
  if (e instanceof MaxApiError) return e.status === 403 || /denied|blocked|forbidden/i.test(e.code ?? '') ? 'blocked' : 'failed'
  return 'failed'
}

export type BroadcastRequest = SegmentQuery & { kind: BroadcastKind; user: { id: number | null; name: string } }

export type StartResult =
  | { ok: true; broadcast: BroadcastEntry; audience: Audience }
  | { ok: false; error: 'kind_unavailable' | 'nobody' | 'busy' | 'bad_dept'; message: string; audience?: Audience }

export type BroadcastDeps = {
  sql: Sql
  bots: Registry
  log?: Logger
  /** Сообщений за одну пачку и пауза между пачками — подменяются в проверках */
  batch?: number
  pauseMs?: number
}

/** Проверить и запустить рассылку. Отправка идёт в фоне; журнал обновляется после каждой пачки */
export async function startBroadcast(deps: BroadcastDeps, req: BroadcastRequest): Promise<StartResult> {
  const { sql, bots } = deps
  await closeStale(sql)
  if (req.segment === 'dept' && !departments[req.dept as DepartmentId]) return { ok: false, error: 'bad_dept', message: 'Выбери направление' }
  const recruit = await getRecruit(sql)
  const why = kindsAvailable(recruit)[req.kind]
  if (why) return { ok: false, error: 'kind_unavailable', message: why }

  const online = sendableChannels(bots)
  const list = await recipients(sql, req)
  const audience = audienceOf(list, online)
  if (!audience.ready) {
    const message = !audience.total
      ? 'В этом сегменте нет подписчиков.'
      : audience.recent && !audience.offline
        ? 'Все подписчики этого сегмента получали рассылку меньше недели назад.'
        : 'Некому отправить: боты подписчиков этого сегмента не подключены или рассылка была меньше недели назад.'
    return { ok: false, error: 'nobody', message, audience }
  }

  const message = broadcastMessage(req.kind, { dept: req.segment === 'dept' ? req.dept : null, daysLeft: recruit.daysLeft })
  let id: number
  try {
    const [row] = await sql<{ id: string }[]>`
      insert into broadcasts (user_id, user_name, kind, segment, dept, text, recipients, skipped_recent, skipped_offline)
      values (${req.user.id}, ${req.user.name}, ${req.kind}, ${req.segment}, ${req.segment === 'dept' ? (req.dept ?? null) : null}, ${message.text},
              ${audience.total}, ${audience.recent}, ${audience.offline})
      returning id`
    id = Number(row.id)
  } catch (e) {
    if ((e as { code?: string }).code === '23505') return { ok: false, error: 'busy', message: 'Предыдущая рассылка ещё отправляется.', audience }
    throw e
  }

  const queue = list.filter((r) => online.includes(r.channel) && !r.recent)
  const job = send(deps, id, queue, message).catch((e) => (deps.log ?? console).error(`[broadcast] рассылка ${id}: ${(e as Error).message}`))
  running.set(
    id,
    job.finally(() => running.delete(id)),
  )
  return { ok: true, broadcast: (await getBroadcast(sql, id))!, audience }
}

const withTimeout = <T>(work: Promise<T>, ms: number) =>
  Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref())])

async function send(deps: BroadcastDeps, id: number, queue: Recipient[], message: OutMessage) {
  const { sql, bots } = deps
  const log = deps.log ?? console
  const batch = deps.batch ?? BATCH
  const pauseMs = deps.pauseMs ?? 1000
  const count = { delivered: 0, blocked: 0, failed: 0, skipped: 0 }

  const one = async (r: Recipient) => {
    // Место в «раз в неделю» занимаем до отправки: два запуска одной рассылки не напишут человеку дважды
    const [claim] = await sql<{ prev_at: Date | null; prev_id: string | null }[]>`
      with prev as (select last_broadcast_at, last_broadcast_id from bot_users where channel = ${r.channel} and user_id = ${r.userId})
      update bot_users b set last_broadcast_at = now(), last_broadcast_id = ${id}
      from prev
      where b.channel = ${r.channel} and b.user_id = ${r.userId}
        and not b.erased and b.remind_at is not null and b.remind_off_at is null
        and (b.last_broadcast_at is null or b.last_broadcast_at <= now() - make_interval(days => ${BROADCAST_EVERY_DAYS}))
      returning prev.last_broadcast_at as prev_at, prev.last_broadcast_id as prev_id`
    if (!claim) {
      count.skipped++
      return
    }
    const adapter = bots.get(r.channel)?.adapter
    try {
      if (!adapter?.sendTo) throw new Error('бот не подключён')
      await withTimeout(adapter.sendTo(r.userId, [message]), SEND_TIMEOUT_MS)
      count.delivered++
    } catch (e) {
      const problem = deliveryProblem(e)
      count[problem]++
      // Не доставлено — неделя не считается; заблокировавшему больше не пишем, пока он не вернётся в бота
      await sql`
        update bot_users set last_broadcast_at = ${claim.prev_at}, last_broadcast_id = ${claim.prev_id},
                             blocked_at = ${problem === 'blocked' ? sql`now()` : sql`blocked_at`}
        where channel = ${r.channel} and user_id = ${r.userId}`
      if (problem === 'failed') log.warn(`[broadcast] рассылка ${id}, ${r.channel}: ${(e as Error).message}`)
    }
  }

  for (let i = 0; i < queue.length; i += batch) {
    const started = Date.now()
    await Promise.all(queue.slice(i, i + batch).map(one))
    await sql`update broadcasts set delivered = ${count.delivered}, blocked = ${count.blocked}, failed = ${count.failed} where id = ${id}`
    const left = pauseMs - (Date.now() - started)
    if (i + batch < queue.length && left > 0) await sleep(left)
  }
  await sql`
    update broadcasts set status = 'done', finished_at = now(), delivered = ${count.delivered}, blocked = ${count.blocked},
                          failed = ${count.failed}, skipped_recent = skipped_recent + ${count.skipped}
    where id = ${id}`
}
