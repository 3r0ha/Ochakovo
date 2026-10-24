import type { SourceCost, SourceDraft, SourceEntry, SourcesPayload } from '@shared/sources'
import { request } from '../api'

// Вызовы API реестра меток и расходов (пакет hr-sources). Сервер — server/api/hr-sources.ts.
// Смотрят все сотрудники HR, правит администратор: у роли hr изменения получают 403.

export const getSources = () => request<SourcesPayload>('/api/hr/sources')

export const createSource = (draft: SourceDraft) =>
  request<{ source: SourceEntry }>('/api/hr/sources', { method: 'POST', hr: true, body: JSON.stringify(draft) })

export const updateSource = (code: string, patch: Partial<Omit<SourceDraft, 'code'>>) =>
  request<{ source: SourceEntry }>(`/api/hr/sources/${encodeURIComponent(code)}`, { method: 'PATCH', hr: true, body: JSON.stringify(patch) })

export const deleteSource = (code: string) => request<{ ok: true }>(`/api/hr/sources/${encodeURIComponent(code)}`, { method: 'DELETE', hr: true })

export const addCost = (code: string, cost: { amount: string; comment: string; from: string; to: string }) =>
  request<{ cost: SourceCost }>(`/api/hr/sources/${encodeURIComponent(code)}/costs`, { method: 'POST', hr: true, body: JSON.stringify(cost) })

export const deleteCost = (id: number) => request<{ ok: true }>(`/api/hr/source-costs/${id}`, { method: 'DELETE', hr: true })
