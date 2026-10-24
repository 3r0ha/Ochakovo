import type { Attendance, HrApplication } from '@shared/applications'
import { evenSplit } from '@shared/hrFilter'
import type { ImportRow } from '@shared/hrImport'
import {
  ApiUnavailable,
  bulkAction,
  demoLocal,
  HrUnauthorized,
  listApplications,
  request,
  undoActions,
  type ApplicationDetails,
  type BulkBody,
  type BulkResult,
  type ImportReport,
  type NotifyPlan,
} from '../api'

// Вызовы API для списка заявок, карточки, графика и обзвона (пакет hr-desk).

/** Сжатая обезличенная заявка: время заявки и дальний этап (0 — заявка, 1 — собеседование, 2 — к оформлению, 3 — на смене) */
export type ErasedStage = [createdAt: string, stage: 0 | 1 | 2 | 3]

export type DeskList = { rows: HrApplication[]; erased: ErasedStage[]; etag: string | null }

/**
 * Список для панели с проверкой «изменилось ли»: сервер отвечает 304 без тела, если версия та же.
 * null — ничего не поменялось. В демо-режиме без сервера — заявки этого браузера
 */
export async function loadDesk(etag: string | null): Promise<DeskList | null> {
  if (demoLocal) return { rows: await listApplications(), erased: [], etag: null }
  let res: Response
  try {
    res = await fetch('/api/hr/desk', { credentials: 'same-origin', cache: 'no-store', headers: etag ? { 'if-none-match': etag } : {} })
  } catch {
    throw new ApiUnavailable()
  }
  if (res.status === 304) return null
  if (res.status === 401) throw new HrUnauthorized()
  if (!res.ok || !res.headers.get('content-type')?.includes('application/json')) throw new ApiUnavailable()
  const data = (await res.json()) as { rows: HrApplication[]; erased: ErasedStage[] }
  return { rows: data.rows, erased: data.erased ?? [], etag: res.headers.get('etag') }
}

export type ChangeResult = ApplicationDetails & { historyId: number | null; notify: NotifyPlan | null }

/** Итог собеседования. yes — явка, статус прежний; no — отказ «Неявка на собеседование». notify — написать кандидату об отказе */
export function markAttendance(id: string, attended: Exclude<Attendance, ''>, opts: { notify?: boolean } = {}) {
  return request<ChangeResult>(`/api/hr/applications/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    hr: true,
    body: JSON.stringify({ attendance: attended, notify: opts.notify === true }),
  })
}

/**
 * Массовое действие с фамилиями, дописанными в окне приглашения, и подтверждением «согласия нет».
 * season — итог сезона и резерв у «На смене» (пакет hr-pipeline)
 */
export type DeskBulkBody =
  | (BulkBody & { lastNames?: Record<string, string>; allowNoConsent?: boolean })
  | { action: 'season'; season: { seasonOutcome?: string; seasonLeaveReason?: string; reserve?: boolean } }

/** Сервер берёт не больше 500 заявок за раз: «выбрать все найденные» может дать тысячи */
export const BULK_CHUNK = 500

const emptyResult = (): BulkResult => ({ done: [], failed: [], calls: [], applications: [] })

function mergeResults(into: BulkResult, r: BulkResult) {
  into.done.push(...r.done)
  into.failed.push(...r.failed)
  into.calls.push(...r.calls)
  into.applications.push(...r.applications)
  return into
}

/** Массовое действие порциями по 500. «Разложить по норме» — у каждой порции свои слоты */
export async function bulkChunked(ids: string[], body: DeskBulkBody): Promise<BulkResult> {
  const out = emptyResult()
  for (let i = 0; i < ids.length; i += BULK_CHUNK) {
    const part = ids.slice(i, i + BULK_CHUNK)
    const own = new Set(part)
    let chunkBody: DeskBulkBody = body
    if (body.action === 'status') {
      chunkBody = {
        ...body,
        ...(body.spread ? { spread: { ...body.spread, slots: body.spread.slots.filter((s) => own.has(s.id)) } } : {}),
        ...(body.lastNames ? { lastNames: Object.fromEntries(Object.entries(body.lastNames).filter(([id]) => own.has(id))) } : {}),
      }
    }
    mergeResults(out, await bulkAction(part, chunkBody as BulkBody))
  }
  return out
}

/**
 * «Назначить → поровну между…»: заявки по очереди раздаются выбранным сотрудникам (evenSplit),
 * 300 на троих — по 100. Порядок — как в списке
 */
export async function distribute(ids: string[], assignees: number[]): Promise<BulkResult & { split: Map<number, number> }> {
  const groups = evenSplit(ids, assignees)
  const out = emptyResult()
  for (const [assigneeId, part] of groups) if (part.length) mergeResults(out, await bulkChunked(part, { action: 'assign', assigneeId }))
  return { ...out, split: new Map([...groups].map(([id, list]) => [id, list.length])) }
}

/** Отменить действия порциями: сервер принимает до 500 записей истории за раз */
export async function undoAll(historyIds: number[]) {
  const results: Awaited<ReturnType<typeof undoActions>>['results'] = []
  for (let i = 0; i < historyIds.length; i += BULK_CHUNK) results.push(...(await undoActions(historyIds.slice(i, i + BULK_CHUNK))).results)
  return results
}

/** Кто ведёт заявки из файла: я, никто или поровну между сотрудниками */
export type ImportAssign = { assign: 'me' } | { assign: 'none' } | { assign: 'even'; assignees: number[] }

/** Импорт: все строки файла, как commitImport, и выбор ответственного */
export function commitImportAssigned(
  rows: ImportRow[],
  source: string,
  skipDuplicates: boolean,
  extra: { vacancyMap?: Record<string, string>; skipped?: { line: number; reason: string }[]; defaultMonths?: number[] | 'vacancy'; consentBasis?: string },
  assign: ImportAssign,
) {
  return request<ImportReport>('/api/hr/import/commit', { method: 'POST', hr: true, body: JSON.stringify({ rows, source, skipDuplicates, ...extra, ...assign }) })
}
