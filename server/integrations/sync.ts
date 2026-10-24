import { pickColumns } from '@shared/hr'
import { planProgress, seasonOf } from '@shared/hrPlan'
import type { Sql } from '../db'
import { logAccess } from '../db/accessLog'
import { sourceNames } from '../db/sources'
import type { HrRepo } from '../db/hr'
import type { WorkflowRepo } from '../db/workflow'
import { buildWorkbook } from '../export/xlsx'
import { retentionCutoff, retentionMonths } from '../retention'
import { DiskError, joinDiskPath, YandexDisk, type DiskConfig } from './yandexDisk'

// Выгрузка заявок на Яндекс Диск компании: один файл «Заявки.xlsx» с перезаписью,
// по желанию — ежедневные копии в «Архив». По кнопке из панели и по расписанию.

export const DISK_KEY = 'yandex_disk'

/**
 * Колонки, которых нет в копиях «Архив»: ФИО, контакты, дата рождения, учёба и свободный текст, где бывают
 * телефоны и имена, а также имена сотрудников. «Заявки.xlsx» — рабочий файл отдела, он перезаписывается каждый раз,
 * а копии по дням лежат долго — в них только номер заявки, вакансия, статусы, даты и категории анкеты.
 * Старые копии не переписываем: их удаляет pruneSnapshots по сроку хранения
 */
export const ARCHIVE_SKIP = new Set([
  'lastName', 'name', 'middleName', 'phone', 'contact', 'birthDate', 'school', 'friend', 'portfolio', 'resume', 'comment', 'notes',
  'interviewAddress', 'assignee', 'consentBy', 'mentorName',
])

/** Колонки копии в «Архив» — все колонки выгрузки без личных */
export const archiveColumns = () => pickColumns().filter((c) => !ARCHIVE_SKIP.has(c.key))
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export type DiskState = {
  lastAttemptAt?: string
  lastOkAt?: string
  lastError?: string
  lastRows?: number
  lastBytes?: number
  lastPath?: string
  /** Сохранять ли копии по дням в «Архив» */
  snapshots?: boolean
  /** Токены после обновления по refresh_token */
  accessToken?: string
  refreshToken?: string
  tokenExpiresAt?: string
}

export const diskRoot = (env: NodeJS.ProcessEnv) => env.YANDEX_DISK_ROOT?.trim() || 'disk:/Очаково HR'

/** Раз в сколько минут выгружать; 0 — только по кнопке */
export function syncInterval(env: NodeJS.ProcessEnv) {
  const v = Number(env.YANDEX_DISK_SYNC_MINUTES)
  return Number.isFinite(v) && v >= 0 ? v : 60
}

export function diskConfigured(env: NodeJS.ProcessEnv) {
  return Boolean(env.YANDEX_DISK_TOKEN?.trim() || (env.YANDEX_DISK_REFRESH_TOKEN?.trim() && env.YANDEX_CLIENT_ID?.trim() && env.YANDEX_CLIENT_SECRET?.trim()))
}

/** Клиент Диска: токен из базы (если его уже обновляли) или из переменных окружения */
export function diskClient(env: NodeJS.ProcessEnv, state: DiskState, repo: HrRepo, extra: Partial<DiskConfig> = {}) {
  return new YandexDisk({
    token: state.accessToken || env.YANDEX_DISK_TOKEN?.trim() || undefined,
    refreshToken: state.refreshToken || env.YANDEX_DISK_REFRESH_TOKEN?.trim() || undefined,
    clientId: env.YANDEX_CLIENT_ID?.trim() || undefined,
    clientSecret: env.YANDEX_CLIENT_SECRET?.trim() || undefined,
    onTokens: (t) => repo.patchIntegration(DISK_KEY, { accessToken: t.accessToken, refreshToken: t.refreshToken, tokenExpiresAt: t.expiresAt }),
    ...extra,
  })
}

type SyncDeps = {
  sql: Sql
  repo: HrRepo
  workflow: WorkflowRepo
  env: NodeJS.ProcessEnv
  disk?: Partial<DiskConfig>
  /** Кто нажал «Выгрузить сейчас» — в журнал выгрузок; без него — выгрузка по расписанию */
  by?: { id: number; name: string; role: string } | null
}

export type SyncResult = { ok: true; path: string; rows: number; bytes: number } | { ok: false; error: string; busy?: boolean }

/** Выгрузить сейчас. Два процесса одновременно не выгружают: держим рекомендательную блокировку в базе */
export async function syncNow(deps: SyncDeps): Promise<SyncResult> {
  if (!diskConfigured(deps.env) && !deps.disk) return { ok: false, error: 'Яндекс Диск не подключён: задай YANDEX_DISK_TOKEN' }
  const reserved = await deps.sql.reserve()
  try {
    const [{ locked }] = await reserved<{ locked: boolean }[]>`select pg_try_advisory_lock(hashtext('ochakovo:yandex-disk-sync')) as locked`
    if (!locked) return { ok: false, error: 'Выгрузка уже идёт', busy: true }
    try {
      const state = (await deps.repo.integration<DiskState>(DISK_KEY)) as DiskState
      await deps.repo.patchIntegration(DISK_KEY, { lastAttemptAt: new Date().toISOString() })
      const apps = (await deps.workflow.list()).filter((a) => !a.duplicateOf)
      // Весь отчёт целиком, как в выгрузке из панели: источники, «Задания и наём», лист «Недели» и план найма
      const report = await deps.repo.funnel(new Date(0), new Date(), apps)
      const season = seasonOf(Date.now())
      const plan = { season, cells: planProgress(await deps.repo.plan(season), apps, season) }
      const funnel = { title: 'Воронка за всё время', ...report, names: await sourceNames(deps.sql) }
      const file = await buildWorkbook(apps, pickColumns(), funnel, plan)

      const root = diskRoot(deps.env)
      const disk = diskClient(deps.env, state, deps.repo, deps.disk)
      const path = joinDiskPath(root, 'Заявки.xlsx')
      await disk.upload(path, file, XLSX)
      if (state.snapshots) {
        const day = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10)
        const archive = await buildWorkbook(apps, archiveColumns(), funnel, plan)
        await disk.upload(joinDiskPath(root, 'Архив', `Заявки ${day}.xlsx`), archive, XLSX)
      }
      // Копии в «Архиве» старше срока хранения удаляем: в них персональные данные
      await pruneSnapshots(disk, root, retentionCutoff(new Date(), retentionMonths(deps.env)))
      await deps.repo.patchIntegration(DISK_KEY, { lastOkAt: new Date().toISOString(), lastError: '', lastRows: apps.length, lastBytes: file.length, lastPath: path })
      // Журнал выгрузок: кто и какие заявки отправил на Диск (server/db/accessLog.ts). Ошибка журнала выгрузку не отменяет
      await logAccess(deps.sql, {
        user: deps.by ?? null,
        who: 'Выгрузка на Яндекс Диск по расписанию',
        action: 'disk',
        format: 'xlsx',
        rows: apps.length,
        applicationIds: apps.map((a) => a.id),
      }).catch((e) => console.error('[yandex-disk] журнал выгрузок:', (e as Error).message))
      return { ok: true, path, rows: apps.length, bytes: file.length }
    } catch (e) {
      const error = e instanceof DiskError ? e.message : `Не удалось выгрузить: ${(e as Error).message}`
      await deps.repo.patchIntegration(DISK_KEY, { lastError: error })
      console.error('[yandex-disk]', error)
      return { ok: false, error }
    } finally {
      await reserved`select pg_advisory_unlock(hashtext('ochakovo:yandex-disk-sync'))`
    }
  } finally {
    reserved.release()
  }
}

/** Удалить копии «Заявки ГГГГ-ММ-ДД.xlsx» в «Архиве», которые старше границы срока хранения */
export async function pruneSnapshots(disk: YandexDisk, root: string, cutoff: Date) {
  const files = await disk.list(joinDiskPath(root, 'Архив'))
  let removed = 0
  for (const f of files) {
    const day = /^Заявки (\d{4}-\d{2}-\d{2})\.xlsx$/.exec(f.name)?.[1]
    if (day && Date.parse(`${day}T00:00:00+03:00`) < cutoff.getTime()) {
      await disk.remove(f.path)
      removed++
    }
  }
  return removed
}

/** Выгрузка по расписанию: если подключено и с прошлой попытки прошло больше интервала */
export async function syncIfDue(deps: SyncDeps) {
  const minutes = syncInterval(deps.env)
  if (!minutes || !diskConfigured(deps.env)) return null
  const state = (await deps.repo.integration<DiskState>(DISK_KEY)) as DiskState
  const last = state.lastAttemptAt ? new Date(state.lastAttemptAt).getTime() : 0
  if (Date.now() - last < minutes * 60_000) return null
  return syncNow(deps)
}

/** Для раздела «Интеграции»: без токенов */
export async function diskStatus(repo: HrRepo, env: NodeJS.ProcessEnv) {
  const s = (await repo.integration<DiskState>(DISK_KEY)) as DiskState
  return {
    configured: diskConfigured(env),
    canRefresh: Boolean((s.refreshToken || env.YANDEX_DISK_REFRESH_TOKEN) && env.YANDEX_CLIENT_ID && env.YANDEX_CLIENT_SECRET),
    root: diskRoot(env),
    intervalMinutes: syncInterval(env),
    snapshots: Boolean(s.snapshots),
    lastAttemptAt: s.lastAttemptAt ?? null,
    lastOkAt: s.lastOkAt ?? null,
    lastError: s.lastError || null,
    lastRows: s.lastRows ?? null,
    lastBytes: s.lastBytes ?? null,
    lastPath: s.lastPath ?? null,
  }
}
