import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { allVacancies, builtinEditable, editableOf, vacancyBasis, vacancyById, type VacancyOverride } from '@shared/content/vacancies'
import { requireHr } from '../auth/session'
import { applyOnStart, editableFromBody, VacancyStore } from '../content/vacancies'
import type { ApiDeps } from './index'

// Правки вакансий без программиста (раздел «Вакансии» у администратора).
//   GET    /api/vacancy-overrides            — открыто: правки для сайта {overrides}, без имён сотрудников
//   GET    /api/hr/content/vacancies         — все вакансии: как в данных компании, как сейчас, кто и когда правил, источник
//   PUT    /api/hr/content/vacancies/:id     — {open, pay: {from, to?, estimate?} | null, hot, period}; 422 {errors} по формату
//   DELETE /api/hr/content/vacancies/:id     — вернуть как в данных компании
//   GET    /api/hr/content/history           — история правок: ?vacancy=&limit=
// Правка сразу видна на сайте, в боте и у Квасыча: объекты вакансий общие, база знаний пересобирается.
// Доступ к правкам — только администратор, requireHr на каждом маршруте.

export function routes({ storage, repo }: ApiDeps): Hono {
  const app = new Hono()
  const store = new VacancyStore(storage.sql)
  const admin = requireHr(repo, ['admin'])
  const json = bodyLimit({ maxSize: 8 * 1024 })

  // Сохранённые правки — сразу при старте сервера
  void applyOnStart(store)

  app.get('/api/vacancy-overrides', async (c) => {
    const list = (await store.list()).map(({ vacancyId, open, pay, hot, period }): VacancyOverride => ({ vacancyId, open, pay, hot, period }))
    return c.json({ overrides: list }, 200, { 'cache-control': 'public, max-age=30' })
  })

  app.get('/api/hr/content/vacancies', admin, async (c) => {
    const saved = new Map((await store.list()).map((o) => [o.vacancyId, o]))
    return c.json({
      vacancies: allVacancies.map((v) => {
        const o = saved.get(v.id)
        return {
          id: v.id,
          title: v.title,
          format: v.format,
          unit: v.unit ?? null,
          department: v.department,
          schedule: v.schedule,
          payNote: v.payNote ?? null,
          builtin: builtinEditable(v.id),
          current: editableOf(v),
          overridden: Boolean(o),
          updatedAt: o?.updatedAt ?? null,
          updatedBy: o?.updatedBy ?? null,
          basis: vacancyBasis[v.id] ?? null,
        }
      }),
      history: await store.history({ limit: 30 }),
    })
  })

  app.put('/api/hr/content/vacancies/:id', admin, json, async (c) => {
    const id = c.req.param('id')
    if (!vacancyById(id)) return c.json({ error: 'not_found' }, 404)
    const next = editableFromBody(await c.req.json().catch(() => null))
    if (!next) return c.json({ error: 'invalid' }, 400)
    const r = await store.save(id, next, c.get('hrUser'))
    if (!r.ok) return c.json({ error: 'validation', errors: r.errors, message: Object.values(r.errors)[0] }, 422)
    const v = vacancyById(id)!
    return c.json({ changed: r.changed, current: editableOf(v), history: await store.history({ limit: 30 }) })
  })

  app.delete('/api/hr/content/vacancies/:id', admin, async (c) => {
    const id = c.req.param('id')
    if (!vacancyById(id)) return c.json({ error: 'not_found' }, 404)
    await store.reset(id, c.get('hrUser'))
    return c.json({ current: editableOf(vacancyById(id)!), history: await store.history({ limit: 30 }) })
  })

  app.get('/api/hr/content/history', admin, async (c) =>
    c.json(await store.history({ vacancyId: c.req.query('vacancy') || undefined, limit: Number(c.req.query('limit')) || 50 })),
  )

  return app
}
