import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { checkCost, checkSource, siteBase, type SourcesPayload, type SourcesSite } from '@shared/sources'
import { requireHr } from '../auth/session'
import {
  addCost,
  createSource,
  deleteCost,
  deleteSource,
  DuplicateSource,
  getSource,
  listCosts,
  listSources,
  unknownSources,
  updateSource,
} from '../db/sources'
import { botNamesFromEnv } from '../dialog/storage'
import type { ApiDeps } from './index'

// Реестр меток источников и расходы по меткам. Смотрят все сотрудники HR, правит только администратор.
//   GET    /api/hr/sources                 — реестр, незнакомые метки, расходы, адрес сайта и имена ботов для ссылок и QR
//   POST   /api/hr/sources                 — {code, name, kind, note} → 201 {source}; 409 {error:'duplicate'}
//   PATCH  /api/hr/sources/:code           — {name?, kind?, note?}: метку не меняем, она уже в напечатанных QR
//   DELETE /api/hr/sources/:code           — 409 {error:'builtin' | 'has_costs'}
//   POST   /api/hr/sources/:code/costs     — {amount, comment, from?, to?} → 201 {cost}
//   DELETE /api/hr/source-costs/:id
// 422 — {error:'validation', errors}. Роль hr на изменения получает 403 (requireHr с ролью admin).

export function routes({ storage, repo, bots, env }: ApiDeps): Hono {
  const app = new Hono()
  const sql = storage.sql
  const hr = requireHr(repo)
  const admin = requireHr(repo, ['admin'])
  const json = bodyLimit({ maxSize: 8 * 1024 })

  /** Ссылки и QR ведут на публичный адрес сайта: SITE_URL, в разработке — адрес запроса, как в server/app.ts */
  const site = (c: Context): SourcesSite => {
    const names = botNamesFromEnv(env)
    const active = new Set(bots.active())
    return {
      url: siteBase(env.SITE_URL?.trim() || new URL(c.req.url).origin),
      bots: names,
      active: { telegram: active.has('telegram'), max: active.has('max') },
    }
  }

  const body = async (c: Context) => (await c.req.json().catch(() => null)) as Record<string, unknown> | null

  app.get('/api/hr/sources', hr, async (c) => {
    const [sources, unknown, costs] = await Promise.all([listSources(sql), unknownSources(sql), listCosts(sql)])
    const payload: SourcesPayload = { sources, unknown, costs, site: site(c), canEdit: c.get('hrUser').role === 'admin' }
    return c.json(payload, 200, { 'cache-control': 'no-store' })
  })

  app.post('/api/hr/sources', admin, json, async (c) => {
    const raw = await body(c)
    if (!raw) return c.json({ error: 'invalid_json' }, 400)
    const check = checkSource(raw)
    if (Object.keys(check.errors).length) return c.json({ error: 'validation', errors: check.errors }, 422)
    try {
      const source = await createSource(sql, check.value, c.get('hrUser').name)
      return c.json({ source }, 201)
    } catch (e) {
      if (e instanceof DuplicateSource) return c.json({ error: 'duplicate', errors: { code: 'Такая метка уже есть в реестре' } }, 409)
      throw e
    }
  })

  app.patch('/api/hr/sources/:code', admin, json, async (c) => {
    const code = c.req.param('code')
    const current = await getSource(sql, code)
    if (!current) return c.json({ error: 'not_found' }, 404)
    const raw = await body(c)
    if (!raw) return c.json({ error: 'invalid_json' }, 400)
    const check = checkSource(
      { code, name: 'name' in raw ? raw.name : current.name, kind: 'kind' in raw ? raw.kind : current.kind, note: 'note' in raw ? raw.note : current.note },
      { codeLocked: true },
    )
    if (Object.keys(check.errors).length) return c.json({ error: 'validation', errors: check.errors }, 422)
    const source = await updateSource(sql, code, { name: check.value.name, kind: check.value.kind, note: check.value.note }, c.get('hrUser').name)
    return source ? c.json({ source }) : c.json({ error: 'not_found' }, 404)
  })

  app.delete('/api/hr/sources/:code', admin, async (c) => {
    const result = await deleteSource(sql, c.req.param('code'))
    if (result === 'not_found') return c.json({ error: 'not_found' }, 404)
    if (result !== 'ok') return c.json({ error: result }, 409)
    return c.json({ ok: true })
  })

  app.post('/api/hr/sources/:code/costs', admin, json, async (c) => {
    const code = c.req.param('code')
    if (!(await getSource(sql, code))) return c.json({ error: 'not_found' }, 404)
    const raw = await body(c)
    if (!raw) return c.json({ error: 'invalid_json' }, 400)
    const check = checkCost({ ...raw, code })
    if (Object.keys(check.errors).length) return c.json({ error: 'validation', errors: check.errors }, 422)
    const user = c.get('hrUser')
    const cost = await addCost(sql, check.value, { id: user.id, name: user.name })
    return c.json({ cost }, 201)
  })

  app.delete('/api/hr/source-costs/:id', admin, async (c) => {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'not_found' }, 404)
    return (await deleteCost(sql, id)) ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404)
  })

  return app
}
