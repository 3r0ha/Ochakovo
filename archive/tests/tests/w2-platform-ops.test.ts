// Эксплуатация и скорость (w2-pl-6, w2-pl-7, w2-pl-8): новые события воронки по белому списку, журнал выгрузок,
// расширенный /api/health, modulepreload чанков страниц по манифесту сборки, docker-smoke в CI.
// Время — от текущего момента. Запуск: pnpm test w2-platform-ops (нужен PostgreSQL, база создаётся и удаляется сама)

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { CONSENT_VERSION } from '../../shared/applications'
import { normalizeApplicationInput } from '../../shared/applicationInput'
import { createApp, pagePreloads, renderPage } from '../../server/app'
import type { Registry } from '../../server/channels/registry'
import { PostgresStorage } from '../../server/db'
import { accessLog, logAccess } from '../../server/db/accessLog'
import { HrRepo } from '../../server/db/hr'
import { WorkflowRepo } from '../../server/db/workflow'
import { syncNow } from '../../server/integrations/sync'
import { withTestDb } from './_db'

const registry: Registry = { get: () => undefined, active: () => [], failed: () => [], start: () => {} }

test('события воронки: game_start и share с видом, без очков; неизвестное — 400', async () => {
  await withTestDb('w2-platform-events', async (sql) => {
    await new HrRepo(sql).createUser({ email: 'events@ochakovo.test', name: 'Проверка', role: 'admin', passwordHash: 'x' })
    const app = await createApp({ storage: new PostgresStorage(sql), engine: null, bots: registry, hrToken: '', env: { NODE_ENV: 'test' } })
    const send = (body: Record<string, unknown>) =>
      app.request('/api/events', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ visitor: 'visitor-0001', ...body }) })
    assert.equal((await send({ type: 'game_start', score: 1200, accuracy: 0.97, phone: '+79160000000' })).status, 204, '«Играть» без вида — «Поймай брак»')
    assert.equal((await send({ type: 'game_start', kind: 'money' })).status, 204)
    assert.equal((await send({ type: 'share', kind: 'invite', source: 'fair-mgupp' })).status, 204)
    assert.equal((await send({ type: 'share', kind: 'game', score: 31 })).status, 204)
    assert.equal((await send({ type: 'share' })).status, 400, 'поделиться без вида — нельзя')
    assert.equal((await send({ type: 'share', kind: 'score' })).status, 400, 'вид не из списка')
    assert.equal((await send({ type: 'score', kind: 'game' })).status, 400, 'неизвестный тип')
    assert.equal((await send({ type: 'task_done', task: 'casino' })).status, 400)
    assert.equal((await send({ type: 'task_done', task: 'quiz' })).status, 204, 'прежние события работают')
    const rows = await sql<{ type: string; task: string | null; source: string | null }[]>`select type, task, source from funnel_events order by id`
    assert.deepEqual([...rows].map((r) => ({ ...r })), [
      { type: 'game_start', task: 'game', source: null },
      { type: 'game_start', task: 'money', source: null },
      { type: 'share', task: 'invite', source: 'fair-mgupp' },
      { type: 'share', task: 'game', source: null },
      { type: 'task_done', task: 'quiz', source: null },
    ])
    const columns = (await sql<{ column_name: string }[]>`select column_name from information_schema.columns where table_name = 'funnel_events'`).map((c) => c.column_name)
    assert.deepEqual(columns.sort(), ['channel', 'created_at', 'id', 'source', 'task', 'type', 'visitor'], 'очкам и телефону негде лечь')
    await assert.rejects(sql`insert into funnel_events (visitor, type) values ('v', 'score')`, /funnel_events_type_check/, 'база тоже держит белый список')
    await new Promise((r) => setTimeout(r, 50))
  })
})

test('журнал выгрузок и /api/health: неудачные задачи, Диск, срок хранения, боты — без текстов ошибок', async () => {
  await withTestDb('w2-platform-ops', async (sql) => {
    const repo = new HrRepo(sql)
    const hr = await repo.createUser({ email: 'ops@ochakovo.test', name: 'Ольга', role: 'admin', passwordHash: 'x' })
    const app = await createApp({ storage: new PostgresStorage(sql), engine: null, bots: registry, hrToken: '', env: { NODE_ENV: 'test' } })

    // Задача, которая три раза не дошла, и задача, застрявшая в очереди
    await sql`insert into jobs (kind, run_at, payload, status, attempts, last_error, done_at) values ('notify', now() - interval '1 hour', '{}', 'failed', 3, 'бот заблокирован', now() - interval '5 minutes')`
    await sql`insert into jobs (kind, run_at, payload, status, attempts, done_at) values ('notify', now() - interval '3 days', '{}', 'failed', 3, now() - interval '3 days')`
    await sql`insert into jobs (kind, run_at, payload) values ('reminder', now() - interval '1 hour', '{}')`
    await sql`insert into bot_users (channel, user_id, last_seen_at) values ('telegram', '42', now() - interval '2 minutes')`
    await repo.patchIntegration('yandex_disk', { lastAttemptAt: new Date().toISOString(), lastError: 'Токен Яндекс Диска не подходит, обновите YANDEX_DISK_TOKEN' })
    await repo.patchIntegration('retention', { lastRunAt: new Date(Date.now() - 3600e3).toISOString() })

    const res = await app.request('/api/health')
    const text = await res.text()
    const body = JSON.parse(text) as { ops: { jobs: { failed24h: number; stuck: number }; disk: { failing: boolean; lastOkAt: string | null; lastAttemptAt: string | null }; retention: { lastRunAt: string | null }; botsLastSeen: { telegram: string | null; max: string | null }; lastExport: unknown } }
    assert.equal(body.ops.jobs.failed24h, 1, 'неудача за сутки видна, трёхдневная — нет')
    assert.equal(body.ops.jobs.stuck, 1, 'созревшая задача, которую никто не взял')
    assert.ok(body.ops.disk.lastAttemptAt, 'попытка выгрузки видна')
    assert.deepEqual({ ...body.ops.disk, lastAttemptAt: null }, { lastOkAt: null, lastAttemptAt: null, failing: true })
    assert.ok(body.ops.retention.lastRunAt)
    assert.ok(body.ops.botsLastSeen.telegram && body.ops.botsLastSeen.max === null)
    assert.equal(body.ops.lastExport, null)
    assert.doesNotMatch(text, /token|password|postgres:\/\/|key|заблокирован/i, 'ни текстов ошибок, ни секретов')

    // Журнал выгрузок: выгрузка из панели (её пишет server/api/hr.ts) и выгрузка на Диск по расписанию
    await logAccess(sql, { user: { id: hr.id, name: hr.name, role: hr.role }, action: 'export', format: 'csv1c', rows: 2, filter: 'status=hired', applicationIds: ['AAAA1111', 'BBBB2222'] })
    const workflow = new WorkflowRepo(sql)
    const created = await new PostgresStorage(sql).saveApplication(
      normalizeApplicationInput({ name: 'Ксения', phone: '+7 916 111-22-33', months: [7], consent: true, consentVersion: CONSENT_VERSION, consentSource: 'site_form', game: { quizResult: null, conveyorBest: 0 } }),
    )
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/resources/upload')) return Response.json({ href: 'https://disk.test/put', method: 'PUT' })
      if (url.pathname === '/put') return new Response(null, { status: 201 })
      if (url.pathname.endsWith('/resources') && (init?.method ?? 'GET') === 'GET') return new Response(null, { status: 404 })
      return new Response(null, { status: 201 })
    }) as typeof fetch
    const r = await syncNow({ sql, repo, workflow, env: { YANDEX_DISK_TOKEN: 'x' }, disk: { apiBase: 'https://disk.test/v1/disk', fetch: fakeFetch } })
    assert.ok(r.ok, JSON.stringify(r))
    const all = await accessLog(sql)
    assert.deepEqual(
      all.map((e) => ({ action: e.action, userName: e.userName, role: e.role, format: e.format, rows: e.rows, applications: e.applications })),
      [
        { action: 'disk', userName: 'Выгрузка на Яндекс Диск по расписанию', role: '', format: 'xlsx', rows: 1, applications: 1 },
        { action: 'export', userName: 'Ольга', role: 'admin', format: 'csv1c', rows: 2, applications: 2 },
      ],
    )
    assert.deepEqual((await accessLog(sql, { applicationId: created.id })).map((e) => e.action), ['disk'], 'по номеру заявки — кому ушли её данные')
    assert.deepEqual((await accessLog(sql, { applicationId: 'BBBB2222' })).map((e) => e.action), ['export'])
    const [raw] = await sql<Record<string, unknown>[]>`select * from access_log where action = 'disk'`
    assert.doesNotMatch(JSON.stringify(raw), /Ксения|9161112233/, 'в журнале нет личных данных')

    // Новая сводка — после 30 секунд кэша; свежее приложение видит выгрузку сразу
    const fresh = await createApp({ storage: new PostgresStorage(sql), engine: null, bots: registry, hrToken: '', env: { NODE_ENV: 'test' } })
    const after = (await (await fresh.request('/api/health')).json()) as typeof body
    assert.equal((after.ops.lastExport as { action: string }).action, 'disk')
    assert.ok(after.ops.disk.lastOkAt && after.ops.disk.failing === false, 'успешная выгрузка снимает ошибку')
    await new Promise((r) => setTimeout(r, 50))
  })
})

test('modulepreload: чанк страницы и его зависимости, кроме того, что уже грузит index.html', () => {
  const manifest = {
    'index.html': { file: 'assets/index-1.js', imports: ['_vendor-react.js', '_api.js'] },
    '_vendor-react.js': { file: 'assets/vendor-react-1.js' },
    '_api.js': { file: 'assets/api-1.js', imports: ['_vendor-react.js'] },
    '_applyText.js': { file: 'assets/applyText-1.js', imports: ['_api.js'] },
    'src/pages/Apply.tsx': { file: 'assets/Apply-1.js', imports: ['_vendor-react.js', 'index.html', '_applyText.js'] },
    'src/pages/Vacancies.tsx': { file: 'assets/Vacancies-1.js', imports: ['index.html'] },
  }
  const map = pagePreloads(manifest)
  assert.deepEqual(map['/apply'], ['/assets/Apply-1.js', '/assets/applyText-1.js'])
  assert.deepEqual(map['/vacancies'], ['/assets/Vacancies-1.js'])
  assert.equal(map['/game'], undefined, 'нет в манифесте — нет предзагрузки')
  const template = readFileSync('index.html', 'utf8')
  const html = renderPage(template, '/apply', 'https://season.example.ru', {}, null, map['/apply'])
  assert.equal([...html.matchAll(/rel="modulepreload"/g)].length, 2)
  assert.match(html, /<link rel="modulepreload" crossorigin href="\/assets\/Apply-1\.js">/)
  assert.doesNotMatch(renderPage(template, '/', 'https://season.example.ru'), /modulepreload/)
})

test('CI: в задании docker образ запускается — готовность, страница, ролик с 206, одна копия роликов', () => {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8')
  const docker = ci.slice(ci.indexOf('\n  docker:'))
  assert.match(docker, /image: postgres:16/)
  assert.match(docker, /load: true/, 'образ доступен для docker run')
  assert.match(docker, /docker run -d --name app/)
  assert.match(docker, /\/api\/health\/ready/)
  assert.match(docker, /-r 0-1 [^\n]*\/video\//)
  assert.match(docker, /test "\$code" = 206/)
  assert.match(docker, /public\/video\/\*\.mp4/)
  assert.match(docker, /docker logs app/)
})
