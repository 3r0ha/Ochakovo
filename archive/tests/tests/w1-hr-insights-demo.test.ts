// Демо-база для показа: «Демо-данные» и «Очистить базу» на временной базе.
// Новые заявки — за последние 2–20 часов, просроченных 1–2, три прошедших собеседования без отметки явки,
// у каждой заявки с сайта есть посетитель с заданиями и заявкой, вопросы к Квасычу без ответа, без следов проверок.
// Запуск: pnpm test w1-hr-insights (нужен PostgreSQL, база создаётся и удаляется сама)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { REF_CODE_RE } from '../../shared/applicationInput'
import { slaBreached, SLA_HOURS } from '../../shared/hrFilter'
import { demoApplications, demoTaskList } from '../../shared/demo'
import { clearAll, seedDemo } from '../../server/db/demo'
import { HrRepo } from '../../server/db/hr'
import { WorkflowRepo } from '../../server/db/workflow'
import { withTestDb } from './_db'

const HOUR = 3600e3

test('демо-заявки для режима без сервера: задания сходятся со снимком игры', () => {
  for (const a of demoApplications(200)) {
    const tasks = demoTaskList(a.game)
    assert.equal(tasks.length, a.game.activities, 'список заданий по числу')
    assert.equal(tasks.includes('quiz'), Boolean(a.game.quizResult))
    assert.equal(tasks.includes('game'), a.game.conveyorBest > 0)
  }
  const full = demoApplications(400).filter((a) => a.game.activities === 4).length / 400
  assert.ok(full > 0.15 && full < 0.5, `доля «4 из 4» правдоподобна: ${full}`)
})

test('«Демо-данные» и «Очистить базу»', async () => {
  await withTestDb('w1hri_demo', async (sql) => {
    await sql`insert into hr_users (email, name, role, password_hash) values
      ('olga@ochakovo.local', 'Ольга Смирнова', 'admin', 'x'), ('jury@check.local', 'Жюри', 'hr', 'x'), ('probe@check.local', 'probe', 'hr', 'x')`
    // Следы проверок на стенде: пользователь бота, вопрос и событие от probe и jury
    await sql`insert into bot_users (channel, user_id, first_name, source) values ('telegram', 'probe-1', 'probe', 'jury')`
    await sql`insert into sessions (channel, user_id, data) values ('telegram', 'probe-1', '{}')`
    await sql`insert into kb_gaps (channel, topic, question) values ('web', 'test', 'probe question')`
    await sql`insert into funnel_events (visitor, type, source) values ('probe', 'visit', 'test')`

    const before = await clearAll(sql)
    assert.equal(before, 0)
    for (const table of ['bot_users', 'sessions', 'kb_gaps', 'funnel_events']) {
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)}`
      assert.equal(n, 0, `«Очистить базу» удаляет ${table}`)
    }

    const added = await seedDemo(sql, 24)
    assert.equal(added, 26, '24 заявки и два дубля')
    const apps = await new WorkflowRepo(sql).list()
    const now = Date.now()
    assert.equal(apps.length, 26)

    // Новые: свежие — за 2–20 часов, просроченных одна или две
    const fresh = apps.filter((a) => a.status === 'new')
    const overdue = fresh.filter((a) => slaBreached(a, now))
    assert.ok(overdue.length >= 1 && overdue.length <= 2, `просроченных ${overdue.length}`)
    for (const a of fresh.filter((x) => !slaBreached(x, now))) {
      const h = (now - new Date(a.createdAt).getTime()) / HOUR
      assert.ok(h >= 2 - 0.01 && h <= 20 + 0.01, `новая заявка ${h.toFixed(1)} ч назад`)
    }
    for (const a of overdue) assert.ok((now - new Date(a.createdAt).getTime()) / HOUR > SLA_HOURS)

    // Три прошедших собеседования без отметки явки, у остальных прошедших отметка есть
    const past = apps.filter((a) => a.interview && new Date(a.interview.startsAt).getTime() < now)
    assert.equal(past.filter((a) => a.interview!.attended === '').length, 3, 'прошедших собеседований без отметки — три')
    for (const a of past.filter((x) => x.interview!.attended !== '')) assert.ok(['hired', 'started', 'declined'].includes(a.status), a.status)
    assert.ok(apps.some((a) => a.interview?.attended === 'no' && a.declineReason === 'no_show'), 'есть неявка')
    for (const a of apps.filter((x) => x.status === 'interview' && x.interview && new Date(x.interview.startsAt).getTime() > now))
      assert.equal(a.interview!.attended, '', 'будущие собеседования не отмечены')
    // Собеседования — в будни
    for (const a of apps.filter((x) => x.interview)) {
      const day = new Date(new Date(a.interview!.startsAt).getTime() + 3 * HOUR).getUTCDay()
      assert.ok(day >= 1 && day <= 5, 'собеседование в будний день')
    }

    // История не опережает заявку и не уходит в будущее
    const history = await sql<{ application_id: string; created_at: Date }[]>`select application_id, created_at from application_history`
    for (const h of history) {
      const app = apps.find((a) => a.id === h.application_id)!
      assert.ok(h.created_at.getTime() >= new Date(app.createdAt).getTime() - 1000, 'история после заявки')
      assert.ok(h.created_at.getTime() <= now + 1000, 'история не в будущем')
    }

    // Добавленные HR: отклик с hh.ru и звонок
    const manual = apps.filter((a) => a.channel === 'hr')
    assert.deepEqual(manual.map((a) => a.source).sort(), ['hh', 'phone'])
    for (const a of manual) assert.equal(a.game.activities, 0)

    // Посетитель сайта с заданиями и заявкой у каждой заявки с сайта
    const events = await sql<{ visitor: string; type: string; task: string | null; created_at: Date; source: string | null }[]>`select visitor, type, task, created_at, source from funnel_events`
    const web = apps.filter((a) => a.channel === 'web')
    for (const a of web) {
      const created = new Date(a.createdAt).getTime()
      const applied = events.find((e) => e.type === 'application' && Math.abs(e.created_at.getTime() - created) < 1000 && e.source === a.source)
      assert.ok(applied, `у заявки ${a.id} есть событие «заявка»`)
      const own = events.filter((e) => e.visitor === applied.visitor)
      assert.ok(own.some((e) => e.type === 'visit'), 'визит')
      assert.equal(own.filter((e) => e.type === 'task_done').length, a.game.activities ?? 0, 'задания посетителя — как в заявке')
      for (const e of own) assert.ok(e.created_at.getTime() <= created + 1000, 'события до заявки')
    }

    // Приглашения: двое из бота, одна пара с сайта по коду браузера
    const codes = apps.filter((a) => a.source?.startsWith('friend-')).map((a) => a.source!.slice('friend-'.length))
    assert.ok(codes.length >= 3)
    for (const c of codes) assert.match(c, REF_CODE_RE)
    const names = await new HrRepo(sql).referrerNames([...new Set(codes)])
    assert.equal(Object.keys(names).length, new Set(codes).size, 'у каждого кода есть имя пригласившего')
    assert.ok(apps.some((a) => a.refCode && codes.includes(a.refCode)), 'пара с сайта')

    // Согласие: у всех есть основание и версия
    const consent = await sql<{ consent_source: string; consent_at: Date | null; channel: string }[]>`select consent_source, consent_at, channel from applications`
    for (const c of consent) {
      assert.notEqual(c.consent_source, 'none')
      assert.ok(c.consent_at)
    }

    // Вопросы к Квасычу без ответа, с темами
    const gaps = await sql<{ topic: string; question: string; resolved: boolean; created_at: Date }[]>`select topic, question, resolved, created_at from kb_gaps`
    assert.ok(gaps.length >= 8, `вопросов ${gaps.length}`)
    // Темы, ответ на которые есть в «Справочнике студента» и «Описании практики», — не «вопросы без ответа»
    const answered = ['стоимость общежития', 'оплата медкнижки', 'премии и переработки', 'скидки сотрудникам', 'отпуск и отгулы', 'работа после сезона']
    const topics = new Map<string, number>()
    for (const g of gaps) {
      assert.equal(g.resolved, false)
      assert.ok(g.topic && g.topic !== 'другое', `тема у «${g.question}»`)
      assert.ok(!answered.includes(g.topic), `«${g.question}»: ответ есть в материалах компании`)
      assert.ok(!/!|\d{4}|\d{1,2}\.\d{2}/.test(g.question), 'без восклицаний и дат')
      const hour = new Date(g.created_at.getTime() + 3 * HOUR).getUTCHours()
      assert.ok(hour >= 8 && hour <= 23, `вопрос задан днём или вечером по Москве: ${hour} ч`)
      assert.ok(g.created_at.getTime() < now, 'вопрос в прошлом')
      topics.set(g.topic, (topics.get(g.topic) ?? 0) + 1)
    }
    assert.ok([...topics.values()].some((n) => n >= 2), 'одна тема разными словами — видно, что сводка собирает их в строку')

    // Ни следа проверок: имена, ники, источники, аудитория ботов, ответственные
    const dump = JSON.stringify([
      apps.map((a) => [a.name, a.lastName, a.contact, a.source, a.school, a.assigneeName]),
      await sql`select * from bot_users`,
      await sql`select * from sessions`,
      gaps,
    ])
    for (const word of ['probe', 'test', 'jury', 'Жюри']) assert.ok(!dump.toLowerCase().includes(word.toLowerCase()), `в демо нет «${word}»`)

    // «Очистить базу» убирает всё, что добавили демо-данные, сотрудников оставляет
    const deleted = await clearAll(sql)
    assert.equal(deleted, 26)
    for (const table of ['applications', 'application_history', 'interviews', 'bot_users', 'sessions', 'kb_gaps', 'funnel_events']) {
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)}`
      assert.equal(n, 0, `после очистки пусто: ${table}`)
    }
    const [{ staff }] = await sql<{ staff: number }[]>`select count(*)::int as staff from hr_users`
    assert.equal(staff, 3, 'сотрудники остаются')
  })
})
