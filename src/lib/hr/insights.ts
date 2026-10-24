import type { ApplicationStatus } from '@shared/applications'
import type { CaseMetrics, TaskBucket, TaskId } from '@shared/hr'
import { request } from '../api'

// «Воронка» HR-панели: тот же отчёт, что считает server/db/funnel.ts (типы повторены: сайт не тянет серверный код)

export type FunnelRow = {
  /** Ключ источника: метка, канал бота или '' — прямой заход */
  source: string
  visitors: number
  tasks: number
  applyOpen: number
  applications: number
  interview: number
  hired: number
  started: number
  /** Из вышедших на смену: «Сезон отработан» и «Звать в штат / резерв» */
  completed?: number
  stayed?: number
  /** Расход по метке за период, ₽; нет — реестра меток с расходами нет */
  cost?: number
}

export type TasksHiringRow = { bucket: TaskBucket; applications: number; interview: number; noShow: number; hired: number; started: number }

/** Посетители сайта, прошедшие задание, и сколько из них оставили заявку; none — без заданий */
export type TaskLeadRow = { task: TaskId | 'none'; visitors: number; applied: number }

export type WeekRow = {
  start: string
  end: string
  applications: number
  interview: number
  hired: number
  started: number
  firstResponseHours: number | null
  answered24h: number | null
  declined: number
  declines: Record<string, number>
  planTarget: number | null
  planDone: number | null
  completed?: number
  stayed?: number
  /** Расход по всем меткам за неделю, ₽; null — реестра меток с расходами нет */
  cost?: number | null
}

export type ReasonCount = { reason: string; label: string; count: number }

/** Приглашение друга: кто позвал ('' — не найти), кого и дошёл ли приглашённый до смены */
export type InviteRow = { id: string; source: string; inviter: string; invited: string; status: ApplicationStatus; started: boolean }

export type FunnelReport = {
  from: string
  to: string
  rows: FunnelRow[]
  /** Имена пригласивших по кодам friend-<код> */
  referrers: Record<string, string>
  declines: ReasonCount[]
  /** Почему ушли до конца сезона */
  leaves: ReasonCount[]
  /** Явка: пришли, прошедших собеседований с отметкой и без неё */
  attendance: { came: number; marked: number; unmarked: number }
  invites: InviteRow[]
  /** Есть реестр меток с расходами: показывать колонки расхода */
  costsKnown: boolean
  /** Цифры кейса по данным панели — рядом с companyBaseline */
  caseMetrics: CaseMetrics
  /** Игра и «поделиться» на сайте; null — таких событий за период нет */
  game: { started: number; shared: number; sharedBy: Record<string, number>; cameByLink: number; applied: number } | null
  firstResponseHours: number | null
  answered24h: number | null
  tasks: { rows: TasksHiringRow[]; fullShare: number | null; target: number; leads: TaskLeadRow[] }
  weeks: WeekRow[]
}

/** Отчёт за период: даты YYYY-MM-DD по Москве, обе включительно. Без дат — последние 30 дней */
export function getFunnel(from?: string, to?: string) {
  const q = new URLSearchParams()
  if (from) q.set('from', from)
  if (to) q.set('to', to)
  return request<FunnelReport>(`/api/hr/funnel?${q}`, { hr: true })
}
