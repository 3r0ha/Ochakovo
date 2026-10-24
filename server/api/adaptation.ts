import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { CHECKIN_CALL_TEXT, checkinHardReply, isCheckinAnswer, isCheckinReason, isCheckinStep } from '@shared/adaptation'
import { adaptationDeps, answerCheckin, checkinView, requestCall } from '../adaptation'
import { tokenMatches } from '../candidate/status'
import type { ApiDeps } from './index'

// «Как дела на смене» для страницы «Моя заявка» (shared/adaptation.ts, server/adaptation).
// Кандидат (заголовок x-status-token, как у статуса; чужой ключ и удалённая заявка — одинаково 404):
//   GET  /api/applications/:id/checkin        {step, question, last, call} — вопрос, который ждёт ответа, и последний ответ
//   POST /api/applications/:id/checkin        {step, answer, reason?} → {reply} — ответ; «Тяжело» с причиной — задача HR
//   POST /api/applications/:id/checkin/call   «Пусть HR позвонит» → {reply, repeated}
// Ответ со слов кандидата при звонке HR отмечает в карточке: PATCH /api/hr/applications/:id {checkin}.

const CLOSED = 'Вопросы о первых неделях уже не актуальны.'

export function routes({ storage }: ApiDeps): Hono {
  const app = new Hono()
  const json = bodyLimit({ maxSize: 4 * 1024 })
  const deps = adaptationDeps(storage)!

  const candidate = async (c: Context) => {
    c.header('cache-control', 'no-store')
    const id = c.req.param('id') ?? ''
    return (await tokenMatches(storage.sql, id, c.req.header('x-status-token') ?? '')) ? id : null
  }
  const gone = (c: Context) => c.json({ error: 'not_found' }, 404)

  app.get('/api/applications/:id/checkin', async (c) => {
    const id = await candidate(c)
    const a = id ? await deps.workflow.get(id) : null
    return a ? c.json(checkinView(a)) : gone(c)
  })

  app.post('/api/applications/:id/checkin', json, async (c) => {
    const id = await candidate(c)
    if (!id) return gone(c)
    const body = (await c.req.json().catch(() => null)) as { step?: unknown; answer?: unknown; reason?: unknown } | null
    const { step, answer, reason } = body ?? {}
    if (!isCheckinStep(step) || !isCheckinAnswer(answer) || (reason !== undefined && reason !== '' && !isCheckinReason(reason)))
      return c.json({ error: 'invalid', message: 'Выбери ответ из списка' }, 422)
    const r = await answerCheckin(deps, id, step, answer, answer === 'hard' && isCheckinReason(reason) ? reason : '', 'site')
    if (!r.ok) return c.json({ error: r.error, message: CLOSED }, r.error === 'not_found' ? 404 : 410)
    const reply = answer === 'hard' ? (isCheckinReason(reason) ? checkinHardReply(reason) : CHECKIN_CALL_TEXT) : ''
    return c.json({ reply, view: checkinView((await deps.workflow.get(id))!) })
  })

  app.post('/api/applications/:id/checkin/call', async (c) => {
    const id = await candidate(c)
    if (!id) return gone(c)
    const r = await requestCall(deps, id)
    if (!r.ok) return c.json({ error: r.error, message: CLOSED }, r.error === 'not_found' ? 404 : 410)
    return c.json({ reply: r.repeated ? 'Просьба уже у отдела персонала: тебе позвонят в рабочее время.' : CHECKIN_CALL_TEXT, repeated: r.repeated })
  })

  return app
}
