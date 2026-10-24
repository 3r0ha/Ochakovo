import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { refreshHrAnswers, setHrAnswerSource } from '../assistant/hrAnswers'
import { checkKbAnswer, createKbAnswer, enabledKbAnswers, getKbAnswer, listKbAnswers, resolveAnsweredGaps, updateKbAnswer } from '../assistant/kbAnswers'
import { requireHr } from '../auth/session'
import type { ApiDeps } from './index'

// Ответы HR на «Вопросы к Квасычу». HR отвечает на вопрос, на который в данных не было ответа, — и Квасыч дальше
// отвечает этим текстом на тот же вопрос и похожие формулировки, без перезапуска. Ответ можно выключить и поправить.
//   GET   /api/hr/kb-answers          — все ответы, включённые первыми
//   POST  /api/hr/kb-answers/check    — проверить текст до сохранения: ошибки, подсказки, текст после очистки
//   POST  /api/hr/kb-answers          — {gapId?, question, answer, variants[]} → 201; вопрос помечается «Разобрано»
//   PATCH /api/hr/kb-answers/:id      — {question?, answer?, variants?, enabled?}
// 422 — {error:'validation', errors, hints, cleaned}. Доступ — requireHr на каждом маршруте.

export function routes({ storage, repo }: ApiDeps): Hono {
  const app = new Hono()
  const sql = storage.sql
  const hr = requireHr(repo)
  const json = bodyLimit({ maxSize: 16 * 1024 })

  // Маленький индекс ответов HR для Квасыча — из этой базы
  setHrAnswerSource(() => enabledKbAnswers(sql))
  /** После правки: Квасыч сразу отвечает новым текстом, похожие открытые вопросы закрываются */
  const apply = async (answerId: number) => {
    await refreshHrAnswers()
    return resolveAnsweredGaps(sql, answerId)
  }

  app.get('/api/hr/kb-answers', hr, async (c) => c.json(await listKbAnswers(sql)))

  app.post('/api/hr/kb-answers/check', hr, json, async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    return c.json(checkKbAnswer(body ?? {}))
  })

  app.post('/api/hr/kb-answers', hr, json, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { gapId?: unknown; question?: unknown; answer?: unknown; variants?: unknown } | null
    if (!body) return c.json({ error: 'invalid_json' }, 400)
    const check = checkKbAnswer(body)
    if (Object.keys(check.errors).length) return c.json({ error: 'validation', ...check }, 422)
    const user = c.get('hrUser')
    const gapId = Number.isInteger(body.gapId) ? (body.gapId as number) : null
    const answer = await createKbAnswer(sql, check.cleaned, { gapId, author: { id: user.id, name: user.name } })
    const resolved = await apply(answer.id)
    return c.json({ answer, hints: check.hints, resolved }, 201)
  })

  app.patch('/api/hr/kb-answers/:id', hr, json, async (c) => {
    const id = Number(c.req.param('id'))
    const current = Number.isInteger(id) ? await getKbAnswer(sql, id) : null
    if (!current) return c.json({ error: 'not_found' }, 404)
    const body = (await c.req.json().catch(() => null)) as { question?: unknown; answer?: unknown; variants?: unknown; enabled?: unknown } | null
    if (!body) return c.json({ error: 'invalid_json' }, 400)
    const texts = 'question' in body || 'answer' in body || 'variants' in body
    const check = checkKbAnswer({
      question: 'question' in body ? body.question : current.question,
      answer: 'answer' in body ? body.answer : current.answer,
      variants: 'variants' in body ? body.variants : current.variants,
    })
    if (texts && Object.keys(check.errors).length) return c.json({ error: 'validation', ...check }, 422)
    const answer = await updateKbAnswer(sql, id, {
      ...(texts ? check.cleaned : {}),
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
    })
    if (!answer) return c.json({ error: 'not_found' }, 404)
    const resolved = answer.enabled ? await apply(answer.id) : (await refreshHrAnswers(), 0)
    return c.json({ answer, hints: texts ? check.hints : [], resolved })
  })

  return app
}
