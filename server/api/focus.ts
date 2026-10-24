import { randomBytes } from 'node:crypto'
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { getCookie, setCookie } from 'hono/cookie'
import { requireHr } from '../auth/session'
import {
  checkFocusAnswers,
  deleteFocusResponse,
  deleteFocusTag,
  FOCUS_VERSION,
  FocusAlreadyAnswered,
  focusCsv,
  focusQuestions,
  focusResults,
  focusRows,
  hasVoted,
  normalizeFocusTag,
  saveFocusResponse,
  VOTER_TOKEN_RE,
  voterHash,
} from '../db/focus'
import { rateLimit, type RateRule } from '../middleware/rate-limit'
import type { ApiDeps } from './index'

// Фокус-группа за 10 минут: анонимная анкета о концепции «Смена» и результаты для HR (docs/brand/focus-group.md).
//
//   GET    /api/focus                    — анкета и answered: отвечали ли уже с этого устройства
//   POST   /api/focus                    — {s?, answers:{clear, interest, hook, intent, missing?, study}} → 201 {ok}
//                                          409 {error:'already_answered'}; 422 {error:'validation', errors}; 429 {error:'rate_limited', retryAfter}
//   GET    /api/hr/focus                 — счёт по вопросам и меткам, свободные ответы, адрес сайта для ссылки и QR
//   GET    /api/hr/focus/export?s=<метка> — CSV для Excel: все ответы или ответы одной метки (s= — без метки)
//   DELETE /api/hr/focus/responses/:id   — убрать один ответ (администратор)
//   DELETE /api/hr/focus/responses?tag=  — убрать все ответы метки, например пробные (администратор)
//
// Защита от накрутки без личных данных:
//   • cookie устройства (случайная, только для /api/focus) — второй ответ с того же браузера получает 409. В базе — её отпечаток;
//   • лимит по IP в памяти процесса: 30 ответов подряд (группа в аудитории с одним Wi-Fi), дальше 30 в час и не больше 100
//     за сутки. Сам IP нигде не записывается.

export const FOCUS_COOKIE = 'focus_device'
/** Cookie устройства живёт год: столько идёт кампания по меткам */
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60

/** Лимиты по IP. Отдельными правилами: rateLimit берёт первое подходящее, а здесь нужны оба */
export const focusRules: { hour: RateRule; day: RateRule } = {
  hour: { name: 'focus-hour', burst: 30, perMinute: 0.5, match: (m, p) => m === 'POST' && p === '/api/focus' },
  day: { name: 'focus-day', burst: 100, perMinute: 100 / (24 * 60), match: (m, p) => m === 'POST' && p === '/api/focus' },
}

const secure = (c: Context) => process.env.NODE_ENV === 'production' || new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https'

/** Отпечаток cookie устройства из запроса; null — cookie нет или она чужого вида */
function deviceOf(c: Context): string | null {
  const token = getCookie(c, FOCUS_COOKIE)
  return token && VOTER_TOKEN_RE.test(token) ? voterHash(token) : null
}

type Options = {
  /** Лимиты по IP; в проверках — свои */
  rules?: RateRule[]
}

export function routes({ storage, repo, env }: ApiDeps, opts: Options = {}): Hono {
  const app = new Hono()
  const sql = storage.sql
  const hr = requireHr(repo)
  const admin = requireHr(repo, ['admin'])
  // Каждое правило — своё ведро; ответ проходит, только если пропустили все
  const limiters = (opts.rules ?? [focusRules.hour, focusRules.day]).map((rule) => rateLimit([rule]))
  const limit: MiddlewareHandler = async (c, next) => {
    for (const limiter of limiters) {
      let passed = false
      const res = await limiter(c, async () => {
        passed = true
      })
      if (!passed) return res as Response
    }
    await next()
  }

  // ── Анкета ──────────────────────────────────────────────────────────────

  app.get('/api/focus', async (c) => {
    const device = deviceOf(c)
    const answered = device ? await hasVoted(sql, device) : false
    return c.json({ version: FOCUS_VERSION, questions: focusQuestions(), answered }, 200, { 'cache-control': 'no-store' })
  })

  app.post('/api/focus', limit, bodyLimit({ maxSize: 4 * 1024, onError: (c) => c.json({ error: 'too_large' }, 413) }), async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'invalid_json' }, 400)
    // Ловушка для ботов: поле, которого человек не видит. Отвечаем как обычно, но ничего не записываем
    if (typeof body.website === 'string' && body.website.trim()) return c.json({ ok: true }, 201)

    const check = checkFocusAnswers(body.answers)
    if (Object.keys(check.errors).length) return c.json({ error: 'validation', errors: check.errors }, 422)

    let token = getCookie(c, FOCUS_COOKIE)
    const known = Boolean(token && VOTER_TOKEN_RE.test(token))
    if (!known) token = randomBytes(24).toString('base64url')
    try {
      await saveFocusResponse(sql, { tag: normalizeFocusTag(body.s), voter: voterHash(token!), answers: check.value })
    } catch (e) {
      if (e instanceof FocusAlreadyAnswered) return c.json({ error: 'already_answered' }, 409)
      throw e
    }
    if (!known) setCookie(c, FOCUS_COOKIE, token!, { path: '/api/focus', httpOnly: true, sameSite: 'Lax', secure: secure(c), maxAge: COOKIE_MAX_AGE })
    return c.json({ ok: true }, 201)
  })

  // ── HR ──────────────────────────────────────────────────────────────────

  /** Ссылки и QR ведут на публичный адрес сайта: SITE_URL, в разработке — адрес запроса */
  const site = (c: Context) => (env.SITE_URL?.trim() || new URL(c.req.url).origin).replace(/\/+$/, '')

  app.get('/api/hr/focus', hr, async (c) => {
    const results = await focusResults(sql)
    return c.json({ ...results, site: site(c), canDelete: c.get('hrUser').role === 'admin' }, 200, { 'cache-control': 'no-store' })
  })

  app.get('/api/hr/focus/export', hr, async (c) => {
    const raw = c.req.query('s')
    // s нет — все метки; s= (пусто) — только ответы без метки; непохожая метка — файл с одной шапкой
    const tag = raw === undefined ? undefined : raw === '' ? '' : normalizeFocusTag(raw)
    const csv = focusCsv(raw && !tag ? [] : await focusRows(sql, tag))
    const name = tag ? `Фокус-группа ${tag}` : raw === '' ? 'Фокус-группа без метки' : 'Фокус-группа'
    return c.body(csv, 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="ochakovo-focus.csv"; filename*=UTF-8''${encodeURIComponent(`${name}.csv`)}`,
      'cache-control': 'no-store',
    })
  })

  app.delete('/api/hr/focus/responses/:id', admin, async (c) => {
    const id = Number(c.req.param('id'))
    if (!Number.isSafeInteger(id) || id <= 0) return c.json({ error: 'not_found' }, 404)
    return (await deleteFocusResponse(sql, id)) ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404)
  })

  app.delete('/api/hr/focus/responses', admin, async (c) => {
    const raw = c.req.query('tag')
    if (raw === undefined) return c.json({ error: 'validation', errors: { tag: 'Нужна метка: tag=<метка> или tag= для ответов без метки' } }, 422)
    const tag = raw === '' ? '' : normalizeFocusTag(raw)
    if (raw !== '' && !tag) return c.json({ error: 'validation', errors: { tag: 'Такой метки не бывает' } }, 422)
    return c.json({ deleted: await deleteFocusTag(sql, tag) })
  })

  return app
}
