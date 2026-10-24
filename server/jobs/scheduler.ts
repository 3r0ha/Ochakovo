import { deliverCheckin } from '../adaptation'
import type { Registry } from '../channels/registry'
import type { Sql } from '../db'
import { HrRepo } from '../db/hr'
import { JobsRepo, type Job } from '../db/jobs'
import { WorkflowRepo } from '../db/workflow'
import { syncIfDue } from '../integrations/sync'
import { deliverNotification, deliverReminder, deliverShiftReminder, notificationFailed, type NotifyDeps } from '../notify'
import { retentionIfDue } from '../retention'
import { smsFromEnv } from '../sms'

// Планировщик в процессе сервера: раз в несколько секунд берёт созревшие задачи из таблицы jobs
// (уведомления, напоминания о собеседовании и первой смене, вопросы новичкам «Как дела на смене»)
// и по расписанию выгружает заявки на Яндекс Диск.
// Несколько процессов не возьмут одну задачу дважды: выборка идёт через FOR UPDATE SKIP LOCKED.

/** Зависимости задач очереди: уведомления и база — вопросам «Как дела на смене» */
export type JobDeps = NotifyDeps & { sql: Sql }

export function hrDeps(sql: Sql, bots: Registry, env: NodeJS.ProcessEnv = process.env): JobDeps {
  return { repo: new HrRepo(sql), workflow: new WorkflowRepo(sql), jobs: new JobsRepo(sql), bots, sms: smsFromEnv(env), sql }
}

async function runJob(deps: JobDeps, job: Job) {
  if (job.kind === 'notify') return deliverNotification(deps, job)
  if (job.kind === 'reminder') return deliverReminder(deps, job)
  if (job.kind === 'shift_reminder') return deliverShiftReminder(deps, job)
  if (job.kind === 'checkin') return deliverCheckin(deps, job)
  return 'skipped' as const
}

/** Выполнить созревшие задачи. Возвращает, сколько обработано */
export async function runDueJobs(deps: JobDeps, limit = 20) {
  const jobs = await deps.jobs.claim(limit)
  for (const job of jobs) {
    try {
      const status = await runJob(deps, job)
      await deps.jobs.finish(job.id, status)
    } catch (e) {
      const final = await deps.jobs.fail(job, (e as Error).message)
      if (final) await notificationFailed(deps, job, (e as Error).message)
      console.error(`[jobs] ${job.kind} #${job.id}: ${(e as Error).message}${final ? ' — больше не повторяем' : ' — повторим'}`)
    }
  }
  return jobs.length
}

/** Запустить планировщик. Останавливается по signal */
export function startScheduler(opts: { sql: Sql; bots: Registry; signal: AbortSignal; tickMs?: number; env?: NodeJS.ProcessEnv }) {
  const deps = hrDeps(opts.sql, opts.bots, opts.env)
  const env = opts.env ?? process.env
  let busy = false
  const tick = async () => {
    if (busy || opts.signal.aborted) return
    busy = true
    try {
      while ((await runDueJobs(deps)) > 0 && !opts.signal.aborted) {
        // разбираем очередь, пока есть созревшие задачи
      }
      // Сначала срок хранения, потом выгрузка на Диск: в файл не попадёт то, что пора удалить
      await retentionIfDue({ sql: opts.sql, repo: deps.repo, env })
      await syncIfDue({ sql: opts.sql, repo: deps.repo, workflow: deps.workflow, env })
    } catch (e) {
      console.error('[jobs] ошибка планировщика:', (e as Error).message)
    } finally {
      busy = false
    }
  }
  const timer = setInterval(() => void tick(), opts.tickMs ?? 5000)
  timer.unref()
  opts.signal.addEventListener('abort', () => clearInterval(timer))
  void tick()
}
