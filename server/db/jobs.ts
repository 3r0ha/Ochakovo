import type postgres from 'postgres'
import type { Sql } from './index'

// Очередь задач сервера в PostgreSQL: уведомления с задержкой на отмену, напоминания о собеседовании и первой смене.
// Одну задачу не поставить дважды (dedupe_key), одну и ту же не взять в работу двумя процессами (skip locked).

/**
 * notify — сообщение кандидату, reminder — напоминание о собеседовании, shift_reminder — о первой смене,
 * checkin — вопрос новичку «Как дела на смене» (server/adaptation)
 */
export type JobKind = 'notify' | 'reminder' | 'shift_reminder' | 'checkin'

export type Job = {
  id: number
  kind: JobKind
  runAt: Date
  payload: Record<string, unknown>
  attempts: number
}

type JobRow = { id: string; kind: JobKind; run_at: Date; payload: Record<string, unknown>; attempts: number }

const toJob = (r: JobRow): Job => ({ id: Number(r.id), kind: r.kind, runAt: r.run_at, payload: r.payload, attempts: r.attempts })

/** Сколько раз пробовать задачу, прежде чем считать её проваленной */
export const MAX_ATTEMPTS = 3

export class JobsRepo {
  constructor(private sql: Sql) {}

  /** Поставить задачу. С тем же dedupe_key вторая не создаётся — вернётся null */
  async enqueue(kind: JobKind, runAt: Date, payload: Record<string, unknown>, dedupeKey?: string) {
    const [row] = await this.sql<{ id: string }[]>`
      insert into jobs (kind, run_at, payload, dedupe_key)
      values (${kind}, ${runAt}, ${this.sql.json(payload as postgres.JSONValue)}, ${dedupeKey ?? null})
      on conflict (dedupe_key) do nothing
      returning id`
    return row ? Number(row.id) : null
  }

  /** Отменить ещё не выполненную задачу */
  async cancel(dedupeKey: string) {
    const rows = await this.sql`update jobs set status = 'cancelled', done_at = now() where dedupe_key = ${dedupeKey} and status = 'pending' returning id`
    return rows.length > 0
  }

  /** Вернуть в очередь отменённую задачу — когда отменили саму отмену */
  async revive(dedupeKey: string, runAt: Date) {
    const rows = await this.sql`
      update jobs set status = 'pending', run_at = ${runAt}, done_at = null, locked_at = null
      where dedupe_key = ${dedupeKey} and status = 'cancelled' returning id`
    return rows.length > 0
  }

  /** Отменить все ожидающие задачи по условию на payload, например все напоминания заявки */
  async cancelWhere(kind: JobKind, key: string, value: string) {
    await this.sql`update jobs set status = 'cancelled', done_at = now() where kind = ${kind} and status = 'pending' and payload ->> ${key} = ${value}`
  }

  /** Забрать созревшие задачи. Зависшие дольше 5 минут возвращаются в очередь */
  async claim(limit = 20): Promise<Job[]> {
    await this.sql`
      update jobs set status = 'pending', locked_at = null
      where status = 'running' and locked_at < now() - interval '5 minutes'`
    const rows = await this.sql<JobRow[]>`
      update jobs set status = 'running', locked_at = now(), attempts = attempts + 1
      where id in (
        select id from jobs where status = 'pending' and run_at <= now()
        order by run_at limit ${limit}
        for update skip locked
      )
      returning id, kind, run_at, payload, attempts`
    return rows.map(toJob)
  }

  async finish(id: number, status: 'done' | 'skipped' | 'cancelled', note = '') {
    await this.sql`update jobs set status = ${status}, last_error = ${note.slice(0, 500)}, done_at = now(), locked_at = null where id = ${id}`
  }

  /** Ошибка: повтор через минуту, после MAX_ATTEMPTS — провал */
  async fail(job: Job, error: string) {
    const final = job.attempts >= MAX_ATTEMPTS
    await this.sql`
      update jobs set status = ${final ? 'failed' : 'pending'}, last_error = ${error.slice(0, 500)}, locked_at = null,
        run_at = ${final ? job.runAt : new Date(Date.now() + 60_000 * job.attempts)}, done_at = ${final ? new Date() : null}
      where id = ${job.id}`
    return final
  }

  async status(dedupeKey: string) {
    const [row] = await this.sql<{ status: string; run_at: Date }[]>`select status, run_at from jobs where dedupe_key = ${dedupeKey}`
    return row ?? null
  }
}
