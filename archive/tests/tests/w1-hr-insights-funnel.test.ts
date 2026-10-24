// «Воронка» на базе: модуль server/db/funnel.ts, прежний ответ GET /api/hr/funnel, «Задания и наём»,
// «Какое задание ведёт к заявке», недели (сумма недель — итог периода), первый ответ без добавленных HR,
// план и факт, имена пригласивших с сайта и из бота.
// Запуск: pnpm test w1-hr-insights (нужен PostgreSQL, база создаётся и удаляется сама)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type postgres from 'postgres'
import { stageCounts } from '../../shared/hrFilter'
import { seasonOf } from '../../shared/hrPlan'
import { DEMO_ADMIN } from '../../server/auth/bootstrap'
import { createApp } from '../../server/app'
import type { Registry } from '../../server/channels/registry'
import { PostgresStorage, type Sql } from '../../server/db'
import { funnelReport, referrerNames } from '../../server/db/funnel'
import { HrRepo } from '../../server/db/hr'
import { WorkflowRepo } from '../../server/db/workflow'
import { serverSettled, withTestDb } from './_db'

const HOUR = 3600e3
const DAY = 24 * HOUR
const noBots: Registry = { get: () => undefined, active: () => [], failed: () => [], start: () => {} }

type Seed = {
  id: string
  ago: number
  channel?: string
  source?: string | null
  tasks?: number
  status?: string
  /** История после «Новая»: статус и через сколько часов после заявки; by — сотрудник */
  steps?: [string, number][]
  declineReason?: string
  refCode?: string
  channelUserId?: string
  duplicateOf?: string
  interview?: { hoursAfter: number; attended: '' | 'yes' | 'no' }
  /** Первую строку истории пишет сотрудник (добавлен HR) */
  byHr?: boolean
}

async function insert(sql: Sql, hrId: number, s: Seed) {
  const created = Date.now() - s.ago
  const steps = s.steps ?? []
  const status = s.status ?? steps.at(-1)?.[0] ?? 'new'
  await sql`
    insert into applications (id, created_at, channel, channel_user_id, name, phone, game, source, status, status_updated_at, decline_reason,
                              vacancy_id, months, ref_code, duplicate_of, consent_at, consent_version, consent_source)
    values (${s.id}, ${new Date(created)}, ${s.channel ?? 'web'}, ${s.channelUserId ?? null}, ${'Имя ' + s.id}, '', ${sql.json({ quizResult: null, conveyorBest: 0, activities: s.tasks ?? 0 })},
            ${s.source ?? null}, ${status}, ${new Date(created)}, ${s.declineReason ?? ''}, 'bottling-operator', ${sql.json([6, 7])}, ${s.refCode ?? null},
            ${s.duplicateOf ?? null}, ${new Date(created)}, '1', 'site_form')`
  await sql`insert into application_history (application_id, created_at, user_id, user_name, from_status, to_status)
            values (${s.id}, ${new Date(created)}, ${s.byHr ? hrId : null}, ${s.byHr ? 'HR' : 'Кандидат'}, null, 'new')`
  let prev = 'new'
  for (const [to, h] of steps) {
    await sql`insert into application_history (application_id, created_at, user_id, user_name, from_status, to_status)
              values (${s.id}, ${new Date(created + h * HOUR)}, ${hrId}, 'HR', ${prev}, ${to})`
    prev = to
  }
  if (s.interview)
    await sql`insert into interviews (application_id, starts_at, attended) values (${s.id}, ${new Date(created + s.interview.hoursAfter * HOUR)}, ${s.interview.attended})`
}

const event = (sql: Sql, ago: number, visitor: string, type: string, task?: string) =>
  sql`insert into funnel_events (created_at, visitor, type, task, source) values (${new Date(Date.now() - ago)}, ${visitor}, ${type}, ${task ?? null}, null)`

test('воронка: модуль, прежний ответ API, задания, недели, первый ответ, план и пригласившие', async () => {
  await withTestDb('w1hri_funnel', async (sql) => {
    const storage = new PostgresStorage(sql)
    const app = await createApp({ storage, engine: null, bots: noBots, hrToken: '', env: { NODE_ENV: 'test' } })
    await serverSettled(sql)
    const [{ id: hrIdRaw }] = await sql<{ id: string }[]>`select id from hr_users limit 1`
    const hrId = Number(hrIdRaw)

    const a1Hired = 3 * 24
    const seeds: Seed[] = [
      // Ответили через 5 часов, дошёл до смены. Его код браузера пригласил A6
      {
        id: 'A1',
        ago: 10 * DAY,
        source: 'fair-misis',
        tasks: 4,
        steps: [['contacted', 5], ['interview', 24], ['hired', a1Hired], ['started', 6 * 24]],
        interview: { hoursAfter: 48, attended: 'yes' },
        refCode: 'abc234',
      },
      // Ответили через 30 часов, на собеседование не пришёл
      { id: 'A2', ago: 9 * DAY, tasks: 2, steps: [['contacted', 30], ['interview', 40], ['declined', 80]], declineReason: 'no_show', interview: { hoursAfter: 72, attended: 'no' } },
      // Из бота, без ответа трое суток
      { id: 'A3', ago: 3 * DAY, channel: 'telegram', source: 'telegram', channelUserId: 'u3' },
      // Свежая: сутки ещё не прошли — в долю ответов за 24 часа не входит
      { id: 'A4', ago: 2 * HOUR, tasks: 1 },
      // Добавил HR: первая строка истории от сотрудника — в первом ответе не считается
      { id: 'A5', ago: 5 * DAY, channel: 'hr', source: 'hh', byHr: true },
      // Пришёл по ссылке A1, без ответа
      { id: 'A6', ago: 4 * DAY, source: 'friend-abc234', tasks: 3 },
      // Дубль — не считается нигде
      { id: 'A7', ago: 9 * DAY - HOUR, duplicateOf: 'A2', tasks: 4 },
    ]
    for (const s of seeds) await insert(sql, hrId, s)

    // Пригласивший из бота: код в сессии, имя — из аудитории
    await sql`insert into bot_users (channel, user_id, first_name, source) values ('telegram', 'u9', 'Саша', 'telegram')`
    await sql`insert into sessions (channel, user_id, data) values ('telegram', 'u9', ${sql.json({ data: { ref: 'bot234' }, progress: {} } as postgres.JSONValue)})`

    // Сайт: v1 прошёл два задания и отправил заявку, v2 — задание без заявки, v3 — только зашёл, v4 — заявка без заданий,
    // v5 прошёл «Правду или миф» до периода, а заявку отправил в периоде
    await event(sql, 5 * DAY, 'v1', 'visit')
    await event(sql, 5 * DAY, 'v1', 'task_done', 'game')
    await event(sql, 5 * DAY, 'v1', 'task_done', 'quiz')
    await event(sql, 5 * DAY, 'v1', 'application')
    await event(sql, 4 * DAY, 'v2', 'visit')
    await event(sql, 4 * DAY, 'v2', 'task_done', 'money')
    await event(sql, 3 * DAY, 'v3', 'visit')
    await event(sql, 2 * DAY, 'v4', 'visit')
    await event(sql, 2 * DAY, 'v4', 'application')
    await event(sql, 40 * DAY, 'v5', 'task_done', 'myth')
    await event(sql, 1 * DAY, 'v5', 'visit')
    await event(sql, 1 * DAY, 'v5', 'application')

    // План сезона, в котором пришла A1: два места на июль
    const a1Created = Date.now() - 10 * DAY
    const season = seasonOf(a1Created)
    await sql`insert into hiring_plan (season, vacancy_id, month, target) values (${season}, 'bottling-operator', 7, 2)`

    const apps = await new WorkflowRepo(sql).list()
    const now = Date.now()
    const from = new Date(now - 30 * DAY)
    const to = new Date(now)
    const report = await funnelReport(sql, from, to, apps)

    // HrRepo.funnel делегирует модулю
    const viaRepo = await new HrRepo(sql).funnel(from, to, apps)
    assert.deepEqual(viaRepo.rows, report.rows)
    assert.deepEqual(viaRepo.declines, report.declines)
    assert.deepEqual(viaRepo.tasks, report.tasks)

    // Строки источников — прежние ключи на месте (вторая волна добавила итог сезона и расход)
    for (const r of report.rows)
      for (const k of ['applications', 'applyOpen', 'hired', 'interview', 'source', 'started', 'tasks', 'visitors']) assert.ok(k in r, `в строке источника есть ${k}`)
    const tiles = stageCounts(apps.filter((a) => new Date(a.createdAt) >= from))
    const sum = (k: 'applications' | 'interview' | 'hired' | 'started') => report.rows.reduce((n, r) => n + r[k], 0)
    assert.equal(sum('applications'), 6, 'без дубля')
    assert.equal(tiles.applications, 6)

    // Первый ответ: A1 — 5 ч, A2 — 30 ч; добавленную HR не считаем
    assert.equal(report.firstResponseHours, 17.5)
    // За 24 часа: A1 да; A2, A3, A6 нет; A4 ещё не дождалась суток
    assert.equal(report.answered24h, 0.25)

    // «Задания и наём»
    const by = Object.fromEntries(report.tasks.rows.map((r) => [r.bucket, r]))
    assert.equal(by.none.applications, 1, 'A3')
    assert.equal(by.some.applications, 3, 'A2, A4, A6')
    assert.equal(by.all.applications, 1, 'A1')
    assert.equal(by.hr.applications, 1, 'A5')
    assert.equal(by.some.noShow, 1, 'A2 — неявка')
    assert.equal(by.all.started, 1)
    assert.equal(report.tasks.rows.reduce((n, r) => n + r.applications, 0), tiles.applications, 'сумма строк равна плитке «Заявка»')
    assert.equal(report.tasks.fullShare, 1 / 5)
    assert.equal(report.tasks.target, 0.3)

    // «Какое задание ведёт к заявке» — только сайт
    const lead = Object.fromEntries(report.tasks.leads.map((l) => [l.task, l]))
    assert.deepEqual(lead.game, { task: 'game', visitors: 1, applied: 1 })
    assert.deepEqual(lead.quiz, { task: 'quiz', visitors: 1, applied: 1 })
    assert.deepEqual(lead.money, { task: 'money', visitors: 1, applied: 0 })
    assert.deepEqual(lead.myth, { task: 'myth', visitors: 1, applied: 1 }, 'задание до периода тоже связано с заявкой в периоде')
    assert.deepEqual(lead.none, { task: 'none', visitors: 2, applied: 1 })

    // Недели: встык, сумма недель — итог периода
    const weeks = report.weeks
    assert.equal(weeks[0].start, from.toISOString())
    assert.equal(weeks.at(-1)!.end, to.toISOString())
    for (const k of ['applications', 'interview', 'hired', 'started'] as const) assert.equal(weeks.reduce((n, w) => n + w[k], 0), sum(k), `недели сходятся с итогом: ${k}`)
    assert.equal(weeks.reduce((n, w) => n + w.declined, 0), report.declines.reduce((n, d) => n + d.count, 0), 'отказы по неделям сходятся')
    assert.equal(weeks.reduce((n, w) => n + (w.declines.no_show ?? 0), 0), 1)
    for (const w of weeks) assert.ok(!JSON.stringify(w).includes('Имя'), 'в неделях нет личных данных')

    // План и факт: место закрыто с недели, когда A1 дошла до «К оформлению»
    const hiredAt = a1Created + a1Hired * HOUR
    for (const w of weeks) {
      const end = new Date(w.end).getTime()
      if (seasonOf(end - 1) !== season) {
        assert.equal(w.planTarget, null, 'у сезона без плана — пусто')
        continue
      }
      assert.equal(w.planTarget, 2)
      assert.equal(w.planDone, end > hiredAt ? 1 : 0, `неделя ${w.start}`)
    }

    // Пригласившие: с сайта — по коду заявки, из бота — по сессии
    assert.deepEqual(await referrerNames(sql, ['abc234', 'bot234', 'none00']), { abc234: 'Имя A1', bot234: 'Саша' })

    // Ответ API — прежние поля и новые разделы
    const login = await app.request('/api/hr/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: DEMO_ADMIN.email, password: DEMO_ADMIN.password }),
    })
    assert.equal(login.status, 200)
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
    const res = await app.request('/api/hr/funnel', { headers: { cookie } })
    assert.equal(res.status, 200)
    const body = (await res.json()) as Record<string, unknown> & { referrers: Record<string, string>; rows: { source: string }[] }
    for (const k of ['from', 'to', 'rows', 'referrers', 'declines', 'firstResponseHours', 'answered24h', 'tasks', 'weeks']) assert.ok(k in body, `в ответе есть ${k}`)
    assert.equal(body.referrers.abc234, 'Имя A1')
    assert.ok(body.rows.some((r) => r.source === 'fair-misis'), 'в ответе API — ключи меток, названия даёт панель')
  })
})
