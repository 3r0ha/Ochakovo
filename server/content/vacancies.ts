import type postgres from 'postgres'
import {
  applyVacancyOverrides,
  builtinEditable,
  editableOf,
  vacancyById,
  vacancyOverrideProblem,
  type VacancyEditable,
  type VacancyOverride,
} from '@shared/content/vacancies'
import { rebuildKnowledge } from '../assistant/knowledge'
import type { Sql } from '../db'
import type { HrUser } from '../db/hr'

// Правки вакансий из панели администратора: хранение (vacancy_overrides и история, миграция 015) и наложение на данные
// компании в памяти сервера. После наложения сайт (/api/content), бот и Квасыч сразу говорят новое: объекты вакансий
// общие, база знаний пересобирается (rebuildKnowledge). Несколько экземпляров сервера видят правку после перезапуска.

/** Правка с тем, кто и когда её сделал */
export type StoredOverride = VacancyOverride & { updatedAt: string; updatedBy: string }

/** Запись истории: состояние до и после, кто и когда */
export type OverrideHistoryEntry = {
  id: number
  vacancyId: string
  vacancyTitle: string
  createdAt: string
  userName: string
  before: VacancyEditable
  after: VacancyEditable
}

type Row = {
  vacancy_id: string
  open: boolean
  pay_from: number | null
  pay_to: number | null
  pay_estimate: boolean
  hot: boolean
  period: string
  updated_at: Date
  updated_by_name: string
}

const toOverride = (r: Row): StoredOverride => ({
  vacancyId: r.vacancy_id,
  open: r.open,
  pay: r.pay_from === null ? null : { from: r.pay_from, ...(r.pay_to !== null ? { to: r.pay_to } : {}), ...(r.pay_estimate ? { estimate: true } : {}) },
  hot: r.hot,
  period: r.period,
  updatedAt: r.updated_at.toISOString(),
  updatedBy: r.updated_by_name,
})

/** Одинаковы ли два состояния: «Сохранить» без изменений историю не засоряет */
export const sameEditable = (a: VacancyEditable, b: VacancyEditable) =>
  a.open === b.open &&
  a.hot === b.hot &&
  a.period.trim() === b.period.trim() &&
  (a.pay?.from ?? null) === (b.pay?.from ?? null) &&
  (a.pay?.to ?? null) === (b.pay?.to ?? null) &&
  Boolean(a.pay?.estimate) === Boolean(b.pay?.estimate)

/** Правка из тела запроса: только известные поля, суммы — целые рубли */
export function editableFromBody(body: unknown): VacancyEditable | null {
  const b = body as Record<string, unknown> | null
  if (!b || typeof b !== 'object') return null
  const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : typeof v === 'string' && /^\s*\d[\d\s]*\s*$/.test(v) ? Number(v.replace(/\s/g, '')) : undefined)
  const p = b.pay as Record<string, unknown> | null | undefined
  const from = p ? int(p.from) : undefined
  const to = p ? int(p.to) : undefined
  return {
    open: b.open !== false,
    hot: b.hot === true,
    period: typeof b.period === 'string' ? b.period.trim() : '',
    pay: p && from !== undefined ? { from, ...(to !== undefined ? { to } : {}), ...(p.estimate === true ? { estimate: true } : {}) } : null,
  }
}

export class VacancyStore {
  constructor(private sql: Sql) {}

  async list(): Promise<StoredOverride[]> {
    const rows = await this.sql<Row[]>`select * from vacancy_overrides order by vacancy_id`
    // Правка вакансии, которой больше нет в данных компании, не применяется и не показывается
    return rows.map(toOverride).filter((o) => vacancyById(o.vacancyId))
  }

  /**
   * Сохранить правку и сразу наложить. Возвращает ошибки по полям, если правка не подходит к формату вакансии.
   * Правка, совпадающая с данными компании, удаляет строку: вакансия снова «как в данных компании»
   */
  async save(vacancyId: string, next: VacancyEditable, by: HrUser): Promise<{ ok: true; changed: boolean } | { ok: false; errors: Record<string, string> }> {
    const v = vacancyById(vacancyId)
    if (!v) return { ok: false, errors: { form: 'Такой вакансии нет' } }
    const problem = vacancyOverrideProblem(v, next)
    if (problem) return { ok: false, errors: problem as Record<string, string> }
    const before = editableOf(v)
    if (sameEditable(before, next)) return { ok: true, changed: false }
    const base = builtinEditable(vacancyId)!
    await this.sql.begin(async (tx) => {
      if (sameEditable(base, next)) await tx`delete from vacancy_overrides where vacancy_id = ${vacancyId}`
      else
        await tx`
          insert into vacancy_overrides (vacancy_id, open, pay_from, pay_to, pay_estimate, hot, period, updated_at, updated_by, updated_by_name)
          values (${vacancyId}, ${next.open}, ${next.pay?.from ?? null}, ${next.pay?.to ?? null}, ${Boolean(next.pay?.estimate)}, ${next.hot},
                  ${next.period.trim()}, now(), ${by.id > 0 ? by.id : null}, ${by.name})
          on conflict (vacancy_id) do update set
            open = excluded.open, pay_from = excluded.pay_from, pay_to = excluded.pay_to, pay_estimate = excluded.pay_estimate,
            hot = excluded.hot, period = excluded.period, updated_at = now(), updated_by = excluded.updated_by, updated_by_name = excluded.updated_by_name`
      await tx`
        insert into vacancy_override_history (vacancy_id, user_id, user_name, before, after)
        values (${vacancyId}, ${by.id > 0 ? by.id : null}, ${by.name}, ${tx.json(before as unknown as postgres.JSONValue)}, ${tx.json(next as unknown as postgres.JSONValue)})`
    })
    await this.apply()
    return { ok: true, changed: true }
  }

  /** Вернуть как в данных компании: правка удаляется, в истории — запись */
  async reset(vacancyId: string, by: HrUser): Promise<boolean> {
    const v = vacancyById(vacancyId)
    if (!v) return false
    const base = builtinEditable(vacancyId)!
    return (await this.save(vacancyId, base, by)).ok
  }

  async history(opts: { vacancyId?: string; limit?: number } = {}): Promise<OverrideHistoryEntry[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
    const rows = await this.sql<{ id: string; vacancy_id: string; created_at: Date; user_name: string; before: VacancyEditable; after: VacancyEditable }[]>`
      select id, vacancy_id, created_at, user_name, before, after from vacancy_override_history
      where ${opts.vacancyId ? this.sql`vacancy_id = ${opts.vacancyId}` : this.sql`true`}
      order by created_at desc, id desc limit ${limit}`
    return rows.map((r) => ({
      id: Number(r.id),
      vacancyId: r.vacancy_id,
      vacancyTitle: vacancyById(r.vacancy_id)?.title ?? r.vacancy_id,
      createdAt: r.created_at.toISOString(),
      userName: r.user_name,
      before: r.before,
      after: r.after,
    }))
  }

  /**
   * Наложить правки из базы на данные компании в памяти и пересобрать базу знаний Квасыча. Возвращает id правок,
   * которые не подошли к формату вакансии (их пропустили) — например, после того как в данных компании сменился формат
   */
  async apply(): Promise<string[]> {
    const list = await this.list()
    const skipped = applyVacancyOverrides(list)
    rebuildKnowledge()
    if (skipped.length) console.warn(`[content] правки вакансий не подошли к данным и пропущены: ${skipped.join(', ')}`)
    return skipped
  }
}

/** Последнее наложение правок при старте сервера — проверки ждут его, прежде чем смотреть на данные */
let applied: Promise<unknown> = Promise.resolve()
export const vacancyOverridesApplied = () => applied

/** При старте API: наложить сохранённые правки. Ошибку базы пишем в журнал — сайт покажет данные компании */
export function applyOnStart(store: VacancyStore) {
  applied = store.apply().catch((e) => console.error('[content] правки вакансий не загрузились:', (e as Error).message))
  return applied
}
