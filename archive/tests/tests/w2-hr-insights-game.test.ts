// События игры в «Воронке» (w2-hi-4): «Нажали «Играть»», «Поделились» по видам, «Пришли по ссылке → заявки».
// При событиях в базе строки считаются, без них блок скрыт — и в отчёте, и на листе «Воронка».
// Запуск: pnpm test w2-hr-insights (нужен PostgreSQL, база создаётся и удаляется сама)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Sql } from '../../server/db'
import { seedDemo } from '../../server/db/demo'
import { funnelReport } from '../../server/db/funnel'
import { WorkflowRepo } from '../../server/db/workflow'
import { buildWorkbook } from '../../server/export/xlsx'
import { unzip } from '../../server/export/xlsxWriter'
import { withTestDb } from './_db'

const DAY = 864e5

const event = (sql: Sql, ago: number, visitor: string, type: string, source: string | null = null, task: string | null = null) =>
  sql`insert into funnel_events (created_at, visitor, type, task, source) values (${new Date(Date.now() - ago)}, ${visitor}, ${type}, ${task}, ${source})`

const sheetStrings = async (report: Awaited<ReturnType<typeof funnelReport>>) => {
  const files = unzip(await buildWorkbook([], [], { title: 'Воронка', ...report }))
  return [...files.get('xl/sharedStrings.xml')!.toString('utf8').matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => m[1])
}

test('игра и «поделиться»: считаются по событиям, без событий блока нет', async () => {
  await withTestDb('w2hri_game', async (sql) => {
    const now = Date.now()
    const period = [new Date(now - 30 * DAY), new Date(now)] as const

    // Без событий игры — блока нет
    await event(sql, 2 * DAY, 'v0', 'visit')
    let report = await funnelReport(sql, ...period, [], now, { costs: null })
    assert.equal(report.game, null)
    assert.ok(!(await sheetStrings(report)).includes('Нажали «Играть»'))

    // Трое нажали «Играть» (один — дважды), двое поделились результатом, один — приглашением
    for (const [v, ago] of [['g1', 3], ['g2', 2], ['g3', 1], ['g1', 1]] as const) await event(sql, ago * DAY, v, 'game_start')
    await event(sql, 2 * DAY, 'g1', 'share', null, 'game')
    await event(sql, 1 * DAY, 'g2', 'share', null, 'game')
    await event(sql, 1 * DAY, 'g3', 'share', null, 'invite')
    // По ссылке друга пришли двое, один отправил заявку; заход без метки друга не считается
    await event(sql, 1 * DAY, 'f1', 'visit', 'friend-abc234')
    await event(sql, 1 * DAY - 600e3, 'f1', 'application', 'friend-abc234')
    await event(sql, 1 * DAY, 'f2', 'visit', 'friend-abc234')
    await event(sql, 1 * DAY, 'x1', 'visit', 'fair-mgupp')
    await event(sql, 1 * DAY - 600e3, 'x1', 'application', 'fair-mgupp')
    // Событие до периода не считается
    await event(sql, 40 * DAY, 'old', 'game_start')

    report = await funnelReport(sql, ...period, [], now, { costs: null })
    assert.deepEqual(report.game, { started: 3, shared: 3, sharedBy: { game: 2, invite: 1 }, cameByLink: 2, applied: 1 })
    const strings = await sheetStrings(report)
    for (const s of ['Игра и «поделиться»', 'Нажали «Играть»', 'Поделились', 'Пришли по ссылке друга', 'Из них оставили заявку', 'результатом игры: 2, приглашением: 1'])
      assert.ok(strings.includes(s), `на листе «${s}»`)
  })
})

test('«Демо-данные»: события игры и «поделиться» есть, если база их принимает', async () => {
  await withTestDb('w2hri_game_demo', async (sql) => {
    await sql`insert into hr_users (email, name, role, password_hash) values ('olga@ochakovo.local', 'Ольга Смирнова', 'admin', 'x')`
    await seedDemo(sql, 24)
    const [accepts] = await sql`select 1 from pg_constraint where conname = 'funnel_events_type_check' and pg_get_constraintdef(oid) like '%game_start%'`
    const now = Date.now()
    const report = await funnelReport(sql, new Date(now - 30 * DAY), new Date(now), await new WorkflowRepo(sql).list(), now, { costs: null })
    if (!accepts) return assert.equal(report.game, null)
    assert.ok(report.game && report.game.started > 0, 'нажали «Играть»')
    assert.ok(report.game.shared > 0 && (report.game.sharedBy.invite ?? 0) >= 1, 'поделились, в том числе приглашением')
    assert.ok(report.game.cameByLink > 0 && report.game.applied > 0, 'пришли по ссылке и оставили заявку')
    // События игры не ломают «Задания и наём»: у посетителя с заявкой заданий столько же, сколько в заявке
    const events = await sql<{ visitor: string; type: string }[]>`select visitor, type from funnel_events where type = 'game_start'`
    const tasks = await sql<{ visitor: string }[]>`select visitor from funnel_events where type = 'task_done' and task = 'game'`
    for (const e of events) assert.ok(tasks.some((t) => t.visitor === e.visitor), '«Играть» — у тех, кто прошёл «Поймай брак»')
  })
})
