// c2-fields-3: обязательные поля кейса для новых заявок с сайта и из ботов — фамилия, имя, дата рождения,
// вуз или колледж (или «Уже не учусь»), когда может выйти; отчество — если есть. Ручное добавление в HR и импорт
// эти поля не требуют. Форма, бот и хранилище в памяти получают одну и ту же заявку с новыми полями.
// Запуск: pnpm test c2-fields-required (нужен PostgreSQL, база создаётся и удаляется сама)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CONSENT_VERSION,
  NOT_STUDYING_LABEL,
  caseFieldMessages,
  checkApplication,
  studyLabel,
  validateApplication,
  type Application,
  type ApplicationInput,
  type HrApplication,
} from '../../shared/applications'
import { normalizeApplicationInput, type ApplyError } from '../../shared/applicationInput'
import { birthDateMessages, formatBirthDate } from '../../shared/birthDate'
import { caseFieldLabels, caseFieldText } from '../../shared/hr'
import { mapRow } from '../../shared/hrImport'
import { createApp } from '../../server/app'
import { hashPassword } from '../../server/auth/password'
import type { Registry } from '../../server/channels/registry'
import { PostgresStorage } from '../../server/db'
import { HrRepo } from '../../server/db/hr'
import { WorkflowRepo } from '../../server/db/workflow'
import { memoryStorage } from '../../server/dialog/storage'
import type { RateRule } from '../../server/middleware/rate-limit'
import { serverSettled, withTestDb } from './_db'

const noBots: Registry = { get: () => undefined, active: () => [], failed: () => [], start: () => {} }
const rules: RateRule[] = [{ name: 'api', burst: 100000, perMinute: 100000, match: (_m, p) => p.startsWith('/api/') }]
const isoYearsAgo = (years: number) => new Date(Date.now() - years * 365.25 * 864e5).toISOString().slice(0, 10)
const birthDate = isoYearsAgo(20)
let seq = 0
const phone = () => `+7 902 ${String(1_000_000 + Math.floor(Math.random() * 8_000_000) + seq++).replace(/^(\d{3})(\d{2})(\d{2})$/, '$1-$2-$3')}`

/** Полная заявка кандидата по кейсу: ФИО, контакт, дата рождения, вакансия, готовность выйти, вуз */
const full = (extra: Record<string, unknown> = {}): Partial<ApplicationInput> => ({
  lastName: 'Иванова',
  name: 'Анна',
  middleName: 'Сергеевна',
  phone: phone(),
  birthDate: formatBirthDate(birthDate),
  vacancyId: 'bottling-operator',
  startReady: 'after_session',
  school: 'МГУПП',
  consent: true,
  consentVersion: CONSENT_VERSION,
  ...extra,
})

test('checkApplication: для кандидата обязательны фамилия, имя, дата рождения, учёба, готовность; для HR — нет', () => {
  assert.deepEqual(checkApplication(full(), { candidate: true }), { errors: {}, codes: {} })
  const empty = checkApplication({ phone: '+79161234567' }, { candidate: true })
  assert.deepEqual(Object.keys(empty.errors).sort(), ['birthDate', 'lastName', 'name', 'school', 'startReady'])
  assert.ok(Object.values(empty.codes).every((c) => c === 'required'))
  assert.equal(empty.errors.lastName, caseFieldMessages.lastName)
  assert.equal(empty.errors.school, caseFieldMessages.school)
  assert.equal(empty.errors.startReady, caseFieldMessages.startReady)
  assert.equal(empty.errors.birthDate, birthDateMessages.required)
  // «Уже не учусь» вместо вуза, отчества нет — всё в порядке
  assert.deepEqual(checkApplication(full({ school: '', notStudying: true, middleName: '' }), { candidate: true }).errors, {})
  // Фамилия без букв — как нет фамилии; «Ли» — нормальная фамилия
  assert.equal(checkApplication(full({ lastName: ' — ' }), { candidate: true }).codes.lastName, 'required')
  assert.deepEqual(checkApplication(full({ lastName: 'Ли' }), { candidate: true }).errors, {})
  // Ручное добавление и импорт: только имя и контакт, как раньше
  assert.deepEqual(validateApplication({ name: 'Анна', phone: '+79161234567' }), {})
  assert.deepEqual(validateApplication({ name: 'Анна', contact: '@anna' }), {})
  // Тексты ошибок — прямые, без «!», нейтральный род
  for (const t of Object.values(caseFieldMessages)) assert.ok(!/!|\.\.\.|…|готов[аы]?\b|согласен/.test(t), t)
})

test('импорт из файла: строка без полей кейса проходит проверку', () => {
  const row = mapRow(['Сидорова Анна Петровна', '8 916 123-45-67'], { fullName: 0, phone: 1 }, 2)
  assert.deepEqual(row.problems, [])
  assert.equal(row.lastName, 'Сидорова')
})

test('сайт: без любого поля кейса — 422 с ошибкой и кодом поля, полная заявка — 201, всё записано', async () => {
  await withTestDb('c2-required', async (sql) => {
    const storage = new PostgresStorage(sql)
    const app = await createApp({ storage, engine: null, bots: noBots, hrToken: '', env: { NODE_ENV: 'test' }, rateRules: rules })
    await serverSettled(sql)
    const post = (body: unknown) => app.request('/api/applications', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

    for (const [field, patch] of [
      ['lastName', { lastName: '' }],
      ['name', { name: '' }],
      ['birthDate', { birthDate: '' }],
      ['school', { school: '' }],
      ['startReady', { startReady: '' }],
      ['startMonth', { startReady: 'month' }],
    ] as const) {
      const res = await post(full(patch))
      const body = (await res.json()) as Extract<ApplyError, { error: 'validation' }>
      assert.equal(res.status, 422, field)
      assert.deepEqual(Object.keys(body.errors), [field], `${field}: ошибка только в этом поле`)
      assert.equal(body.codes?.[field], 'required', field)
    }
    // Всё сразу — все ошибки в одном ответе, вместе с согласием
    const all = (await (await post({ phone: phone() })).json()) as Extract<ApplyError, { error: 'validation' }>
    assert.deepEqual(Object.keys(all.errors).sort(), ['birthDate', 'consent', 'lastName', 'name', 'school', 'startReady'])
    assert.equal((await sql`select 1 from applications`).length, 0, 'ничего не записано')

    // Полная заявка: ФИО, контакт, дата рождения, вакансия, готовность, вуз
    const res = await post(full())
    assert.equal(res.status, 201, await res.clone().text())
    const created = (await res.json()) as Application
    assert.equal(created.birthDate, birthDate)
    assert.equal(created.startReady, 'after_session')
    assert.equal(created.notStudying, false)
    const hr = (await new WorkflowRepo(sql).get(created.id))!
    assert.equal(hr.lastName, 'Иванова')
    assert.equal(hr.name, 'Анна')
    assert.equal(hr.middleName, 'Сергеевна')
    assert.equal(hr.birthDate, birthDate)
    assert.equal(hr.adult, true)
    assert.equal(hr.school, 'МГУПП')
    assert.equal(hr.vacancyId, 'bottling-operator')
    assert.equal(caseFieldText(hr, 'startReady'), 'После сессии')
    assert.equal(caseFieldText(hr, 'school'), 'МГУПП')
    assert.equal(caseFieldText(hr, 'birthDate'), formatBirthDate(birthDate))
    assert.match(caseFieldText(hr, 'age'), /^(19|20) лет$/)

    // «Уже не учусь» без вуза и без отчества
    const done = await post(full({ school: '', notStudying: true, middleName: undefined }))
    assert.equal(done.status, 201, await done.clone().text())
    const doneApp = (await new WorkflowRepo(sql).get(((await done.json()) as Application).id))!
    assert.equal(doneApp.notStudying, true)
    assert.equal(doneApp.middleName, '')
    assert.equal(studyLabel(doneApp), NOT_STUDYING_LABEL)
    assert.equal(caseFieldText(doneApp, 'school'), 'Уже не учусь')
    assert.equal(caseFieldLabels.school, 'Вуз или колледж')
  })
})

test('HR: ручное добавление без полей кейса — 201; дата с опечаткой — 422; моложе 18 записывается с adult = false', async () => {
  await withTestDb('c2-required-hr', async (sql) => {
    const storage = new PostgresStorage(sql)
    const repo = new HrRepo(sql)
    const password = 'проверка-пароля-1'
    const admin = await repo.createUser({ email: 'admin@c2.test', name: 'Админ', role: 'admin', passwordHash: await hashPassword(password) })
    const app = await createApp({ storage, engine: null, bots: noBots, hrToken: '', env: { NODE_ENV: 'test' }, rateRules: rules })
    await serverSettled(sql)
    const login = await app.request('/api/hr/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: admin.email, password }) })
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
    assert.ok(cookie, 'вход администратора')
    const add = (body: unknown) =>
      app.request('/api/hr/applications', { method: 'POST', body: JSON.stringify(body), headers: { cookie, 'content-type': 'application/json', 'x-hr-request': '1' } })

    const bare = await add({ name: 'Звонок', phone: phone(), source: 'phone' })
    assert.equal(bare.status, 201, await bare.clone().text())
    const bareApp = ((await bare.json()) as { application: HrApplication }).application
    assert.equal(bareApp.birthDate, '')
    assert.equal(bareApp.startReady, '')
    assert.equal(bareApp.notStudying, false)

    const typo = await add({ name: 'Звонок', phone: phone(), source: 'phone', birthDate: '31.02.2' })
    assert.equal(typo.status, 422)
    assert.ok(((await typo.json()) as { errors: Record<string, string> }).errors.birthDate)

    const young = await add({ name: 'Звонок', phone: phone(), source: 'walk_in', birthDate: formatBirthDate(isoYearsAgo(17)), startReady: 'month', startMonth: 6, notStudying: true })
    assert.equal(young.status, 201, await young.clone().text())
    const youngApp = ((await young.json()) as { application: HrApplication }).application
    assert.equal(youngApp.birthDate, isoYearsAgo(17))
    assert.equal(youngApp.adult, false, 'HR видит, что 18 нет')
    assert.equal(youngApp.startReady, 'month')
    assert.equal(youngApp.startMonth, 6)
    assert.equal(youngApp.notStudying, true)
  })
})

test('бот: та же проверка, что на сайте; форма, бот (PostgreSQL) и память получают одинаковые поля кейса', async () => {
  // Сценарий бота собирает ввод и проверяет его тем же checkApplication с candidate: true
  const botInput = { name: 'Анна', phone: '+79031112233', channel: 'telegram', channelUserId: '501', consent: true, consentVersion: CONSENT_VERSION } as ApplicationInput
  assert.deepEqual(Object.keys(validateApplication(botInput, { candidate: true })).sort(), ['birthDate', 'lastName', 'school', 'startReady'])
  const withFields = { ...botInput, lastName: 'Иванова', birthDate: formatBirthDate(birthDate), school: '', notStudying: true, startReady: 'now' } as ApplicationInput
  assert.deepEqual(validateApplication(withFields, { candidate: true }), {})

  const pick = (a: Partial<Application>) => ({ lastName: a.lastName, birthDate: a.birthDate, adult: a.adult, school: a.school, notStudying: a.notStudying, startReady: a.startReady, startMonth: a.startMonth })
  const expected = pick(normalizeApplicationInput(withFields))
  assert.deepEqual(expected, { lastName: 'Иванова', birthDate, adult: true, school: '', notStudying: true, startReady: 'now', startMonth: null })

  await withTestDb('c2-required-bot', async (sql) => {
    const storage = new PostgresStorage(sql)
    const saved = await storage.saveApplication(withFields)
    assert.deepEqual(pick(saved), expected, 'PostgreSQL: ответ')
    assert.deepEqual(pick((await new WorkflowRepo(sql).get(saved.id))!), expected, 'PostgreSQL: чтение')
    const [row] = await sql<{ birth_date: Date; start_ready: string; not_studying: boolean }[]>`select birth_date, start_ready, not_studying from applications where id = ${saved.id}`
    assert.equal(row.birth_date.toISOString().slice(0, 10), birthDate)
    assert.equal(row.start_ready, 'now')
    assert.equal(row.not_studying, true)
  })

  const mem = memoryStorage()
  const fromMemory = await mem.saveApplication({ ...withFields, channel: 'max', channelUserId: '42' })
  assert.deepEqual(pick(fromMemory), expected, 'память: ответ')
  assert.deepEqual(pick((await mem.latestApplicationFor!('max', '42'))!), expected, 'память: чтение')
})
