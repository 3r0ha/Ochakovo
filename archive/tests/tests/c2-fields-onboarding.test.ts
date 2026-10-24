// c2-fields-4: оформление практиканта — наставник (mentorName) и отметки документов по практике (practiceDocs).
// Плюс миграция 021: применяется с нуля и на базу со старыми заявками, ограничения, перевод в HrApplication,
// правка через HR-панель с историей, склейка дублей, хранилище в памяти.
// Запуск: pnpm test c2-fields-onboarding (нужен PostgreSQL, база создаётся и удаляется сама)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CONSENT_VERSION,
  emptyHrFields,
  normalizePracticeDocs,
  practiceDocOptions,
  practiceDocsLabel,
  type ApplicationInput,
  type HrApplication,
} from '../../shared/applications'
import { caseFieldLabels, caseFieldText } from '../../shared/hr'
import { createApp } from '../../server/app'
import { hashPassword } from '../../server/auth/password'
import type { Registry } from '../../server/channels/registry'
import { migrate, PostgresStorage, type Sql } from '../../server/db'
import { HrRepo } from '../../server/db/hr'
import { WorkflowRepo } from '../../server/db/workflow'
import { memoryStorage } from '../../server/dialog/storage'
import type { RateRule } from '../../server/middleware/rate-limit'
import { serverSettled, withTestDb } from './_db'

const noBots: Registry = { get: () => undefined, active: () => [], failed: () => [], start: () => {} }
const rules: RateRule[] = [{ name: 'api', burst: 100000, perMinute: 100000, match: (_m, p) => p.startsWith('/api/') }]
const system = { id: 0, name: 'Система' } as never

const columns = async (sql: Sql) =>
  new Map(
    (
      await sql<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]>`
        select column_name, data_type, is_nullable, column_default from information_schema.columns
        where table_name = 'applications' and column_name in ('birth_date', 'start_ready', 'start_month', 'not_studying', 'mentor_name', 'practice_docs')`
    ).map((c) => [c.column_name, c]),
  )

test('документы по практике: четыре по справочнику студента, подписи, порядок, неизвестные отбрасываются', () => {
  assert.deepEqual(
    practiceDocOptions.map((o) => [o.id, o.label]),
    [
      ['contract', 'Договор с вузом или колледжем'],
      ['order', 'Приказ о практике'],
      ['diary', 'Дневник или отчёт по практике'],
      ['reference', 'Характеристика'],
    ],
  )
  assert.deepEqual(normalizePracticeDocs(['reference', 'contract', 'contract', 'passport', 42]), ['contract', 'reference'])
  assert.deepEqual(normalizePracticeDocs('contract'), [])
  assert.deepEqual(normalizePracticeDocs(null), [])
  assert.equal(practiceDocsLabel(['order', 'contract']), 'Договор, приказ')
  assert.equal(practiceDocsLabel([]), '')
  assert.equal(practiceDocsLabel(practiceDocOptions.map((o) => o.id)), 'Договор, приказ, дневник, характеристика')
  for (const o of practiceDocOptions) assert.ok(!/!|\.\.\.|…/.test(o.label + o.hint), o.label)
  // Пустые поля HR без сервера и подписи для карточки и выгрузок
  assert.equal(emptyHrFields().mentorName, '')
  assert.deepEqual(emptyHrFields().practiceDocs, [])
  assert.equal(caseFieldLabels.mentorName, 'Наставник')
  assert.equal(caseFieldLabels.practiceDocs, 'Документы по практике')
  assert.equal(caseFieldText({ school: '', mentorName: 'Ольга Петрова', practiceDocs: ['diary'] }, 'mentorName'), 'Ольга Петрова')
  assert.equal(caseFieldText({ school: '', practiceDocs: ['diary'] }, 'practiceDocs'), 'Дневник')
})

test('021 с нуля: колонки, значения по умолчанию, ограничения', async () => {
  await withTestDb('c2-m021', async (sql) => {
    const cols = await columns(sql)
    assert.equal(cols.size, 6, [...cols.keys()].join())
    assert.equal(cols.get('birth_date')?.data_type, 'date')
    assert.equal(cols.get('birth_date')?.is_nullable, 'YES')
    assert.equal(cols.get('practice_docs')?.data_type, 'ARRAY')
    for (const c of ['start_ready', 'not_studying', 'mentor_name', 'practice_docs']) assert.equal(cols.get(c)?.is_nullable, 'NO', c)
    const [{ applied }] = await sql<{ applied: boolean }[]>`select exists (select 1 from schema_migrations where name = '021_case_fields.sql') as applied`
    assert.ok(applied)

    const add = (id: string, extra: Record<string, unknown> = {}) => sql`insert into applications ${sql({ id, name: 'Проверка', ...extra })}`
    await add('C2M1')
    const [row] = await sql<{ birth_date: Date | null; start_ready: string; start_month: number | null; not_studying: boolean; mentor_name: string; practice_docs: string[] }[]>`
      select birth_date, start_ready, start_month, not_studying, mentor_name, practice_docs from applications where id = 'C2M1'`
    assert.deepEqual({ ...row }, { birth_date: null, start_ready: '', start_month: null, not_studying: false, mentor_name: '', practice_docs: [] })
    await assert.rejects(sql`update applications set practice_docs = array['contract', 'passport'] where id = 'C2M1'`, (e: { code?: string }) => e.code === '23514', 'неизвестный документ')
    await sql`update applications set practice_docs = array['contract', 'order', 'diary', 'reference'] where id = 'C2M1'`
    await assert.rejects(sql`insert into applications (id, name, birth_date) values ('C2M2', 'Проверка', ${'вчера'}::text::date)`, (e: { code?: string }) => e.code === '22007', 'не дата')
  })
})

test('021 на базе со старыми заявками: строки на месте, новые поля пустые, HrApplication их содержит', async () => {
  await withTestDb(
    'c2-m021-old',
    async (sql) => {
      await sql`insert into applications (id, channel, name, school, adult) values ('C2OLDWEB', 'web', 'Старая', 'МГУПП', true), ('C2OLDHR', 'hr', 'Старая HR', '', null)`
      await migrate(sql, { quiet: true })
      assert.equal((await columns(sql)).size, 6)
      const repo = new WorkflowRepo(sql)
      const web = (await repo.get('C2OLDWEB'))!
      assert.equal(web.school, 'МГУПП')
      assert.equal(web.adult, true)
      assert.equal(web.birthDate, '')
      assert.equal(web.startReady, '')
      assert.equal(web.startMonth, null)
      assert.equal(web.notStudying, false)
      assert.equal(web.mentorName, '')
      assert.deepEqual(web.practiceDocs, [])
      assert.equal((await repo.get('C2OLDHR'))!.adult, null)
      // Повторный запуск миграций ничего не ломает
      await migrate(sql, { quiet: true })
    },
    { migrate: 12 },
  )
})

test('HR-панель: наставник и документы через анкету — с историей; склейка дублей; хранилище в памяти', async () => {
  await withTestDb('c2-onboarding', async (sql) => {
    const storage = new PostgresStorage(sql)
    const repo = new HrRepo(sql)
    const workflow = new WorkflowRepo(sql)
    const password = 'проверка-пароля-1'
    const admin = await repo.createUser({ email: 'admin@c2.test', name: 'Админ', role: 'admin', passwordHash: await hashPassword(password) })
    const app = await createApp({ storage, engine: null, bots: noBots, hrToken: '', env: { NODE_ENV: 'test' }, rateRules: rules })
    await serverSettled(sql)
    const login = await app.request('/api/hr/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: admin.email, password }) })
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
    assert.ok(cookie, 'вход администратора')
    const patch = async (id: string, body: unknown) => {
      const res = await app.request(`/api/hr/applications/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
        headers: { cookie, 'content-type': 'application/json', 'x-hr-request': '1' },
      })
      assert.equal(res.status, 200, await res.clone().text())
      return (await res.json()) as { application: HrApplication; history: { kind: string; comment: string }[] }
    }

    const birthDate = new Date(Date.now() - 20 * 365.25 * 864e5).toISOString().slice(0, 10)
    const input = (extra: Partial<ApplicationInput> = {}) =>
      ({ name: 'Анна', lastName: 'Иванова', phone: '+79035556677', birthDate, school: 'МГУПП', startReady: 'now', practiceSchool: true, consent: true, consentVersion: CONSENT_VERSION, ...extra }) as ApplicationInput
    const a = await storage.saveApplication(input())

    const mentor = await patch(a.id, { profile: { mentorName: '  Ольга Петрова  ' } })
    assert.equal(mentor.application.mentorName, 'Ольга Петрова')
    assert.equal(mentor.history.at(-1)?.kind, 'profile')
    assert.equal(mentor.history.at(-1)?.comment, 'Наставник: Ольга Петрова')

    const docs = await patch(a.id, { profile: { practiceDocs: ['order', 'contract', 'passport'] } })
    assert.deepEqual(docs.application.practiceDocs, ['contract', 'order'])
    assert.equal(docs.history.at(-1)?.comment, 'Документы по практике: договор, приказ')
    assert.equal(docs.application.mentorName, 'Ольга Петрова', 'другие поля анкеты не тронуты')
    assert.equal(docs.application.birthDate, birthDate)
    assert.equal(docs.application.startReady, 'now')

    // Дата рождения с опечаткой — 422 bad_birth_date, сохранённая дата не меняется
    const typo = await app.request(`/api/hr/applications/${a.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ profile: { birthDate: '31.02.1' } }),
      headers: { cookie, 'content-type': 'application/json', 'x-hr-request': '1' },
    })
    assert.equal(typo.status, 422)
    assert.equal(((await typo.json()) as { codes?: Record<string, string> }).codes?.birthDate, 'bad_birth_date')
    assert.equal((await workflow.get(a.id))?.birthDate, birthDate)
    const cleared = await patch(a.id, { profile: { mentorName: '', practiceDocs: [] } })
    assert.equal(cleared.application.mentorName, '')
    assert.deepEqual(cleared.application.practiceDocs, [])
    assert.equal(cleared.history.at(-1)?.comment, 'Анкета дополнена')
    await patch(a.id, { profile: { mentorName: 'Ольга Петрова', practiceDocs: ['contract'] } })

    // Склейка: пустые поля основной заявки дополняются из дубля, отметки документов объединяются
    const dup = await storage.saveApplication(input({ startReady: 'month', startMonth: 7, notStudying: true, school: '' }))
    await sql`update applications set practice_docs = array['diary'], mentor_name = 'Другой наставник', birth_date = null, start_ready = '' where id = ${a.id}`
    const merged = await workflow.merge(a.id, dup.id, system)
    assert.ok(!('error' in merged), JSON.stringify(merged))
    const p = (merged as { application: HrApplication }).application
    assert.deepEqual(p.practiceDocs, ['diary'], 'у дубля документов нет — остаются свои')
    assert.equal(p.mentorName, 'Другой наставник')
    assert.equal(p.birthDate, birthDate, 'дата рождения из дубля')
    assert.equal(p.startReady, 'month')
    assert.equal(p.startMonth, 7)
    assert.equal(p.notStudying, true)
  })

  // Хранилище в памяти: у заявки есть пустые поля оформления
  const mem = memoryStorage()
  await mem.saveApplication({ name: 'Анна', phone: '+79035556677', channel: 'telegram', channelUserId: '9', consent: true, consentVersion: CONSENT_VERSION } as ApplicationInput)
  const latest = (await mem.latestApplicationFor!('telegram', '9'))!
  assert.equal(latest.mentorName, '')
  assert.deepEqual(latest.practiceDocs, [])
})
