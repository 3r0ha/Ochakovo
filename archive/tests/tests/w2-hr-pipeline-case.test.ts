// w2-hp-c1: поля кейса в HR — дата рождения и возраст, когда может выйти, вуз или колледж.
// Правка в карточке с проверкой даты (опечатка — 422, моложе 18 — сохраняется, но пригласить можно только с подтверждением),
// фильтр «Когда может выйти» в адресе и выгрузке, ручное добавление и импорт с датой рождения и учёбой.
// Запуск: pnpm test w2-hr-pipeline-case (нужен PostgreSQL, база создаётся и удаляется сама)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CONSENT_VERSION, studyLabel, type HrApplication } from '../../shared/applications'
import { ageOn, formatBirthDate, mskToday } from '../../shared/birthDate'
import { caseFieldText } from '../../shared/hr'
import { applyFilter, filterToParams, paramsToFilter } from '../../shared/hrFilter'
import { guessMapping, mapRow } from '../../shared/hrImport'
import { createApp } from '../../server/app'
import { hashPassword } from '../../server/auth/password'
import type { Registry } from '../../server/channels/registry'
import { normalizeApplication, PostgresStorage, type Sql } from '../../server/db'
import { HrRepo } from '../../server/db/hr'
import type { RateRule } from '../../server/middleware/rate-limit'
import { serverSettled, withTestDb } from './_db'

process.env.HR_NOTIFY_DELAY_SECONDS = '0'

const noBots: Registry = { get: () => undefined, active: () => [], failed: () => [], start: () => {} }
const rules: RateRule[] = [{ name: 'api', burst: 100000, perMinute: 100000, match: (_m, p) => p.startsWith('/api/') }]
const password = 'проверка-пароля-1'

/** Дата рождения, по которой сегодня (по Москве) исполнилось years лет и ещё n дней */
const bornYearsAgo = (years: number, days = 10) => {
  const [y, m, d] = mskToday().split('-').map(Number)
  const t = new Date(Date.UTC(y - years, m - 1, d) - days * 864e5)
  return t.toISOString().slice(0, 10)
}

/** Год, который был years лет назад, — для дат с опечаткой: 31 февраля, 13-й месяц, возраст больше 70 */
const yearAgo = (years: number) => Number(mskToday().slice(0, 4)) - years

type Details = { application: HrApplication; history: { kind: string; comment: string }[] }

async function setup(sql: Sql) {
  const storage = new PostgresStorage(sql)
  const repo = new HrRepo(sql)
  const admin = await repo.createUser({ email: 'admin@pipeline.test', name: 'Админ', role: 'admin', passwordHash: await hashPassword(password) })
  const app = await createApp({ storage, engine: null, bots: noBots, hrToken: '', env: { NODE_ENV: 'test', SITE_URL: 'https://season.example.ru' }, rateRules: rules })
  await serverSettled(sql)
  const login = await app.request('/api/hr/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: admin.email, password }) })
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
  assert.ok(cookie, 'вход администратора')
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { cookie, 'content-type': 'application/json', 'x-hr-request': '1' } })
  const patch = async (id: string, body: unknown) => {
    const res = await call('PATCH', `/api/hr/applications/${id}`, body)
    return { status: res.status, body: (await res.json()) as Details & { error?: string; codes?: Record<string, string>; errors?: Record<string, string> } }
  }
  let n = 0
  const candidate = (extra: Record<string, unknown> = {}) =>
    storage.saveApplication(normalizeApplication({ name: `Кандидат ${++n}`, phone: `+7902${String(1_000_000 + n).padStart(7, '0')}`, consent: true, consentVersion: CONSENT_VERSION, ...extra }))
  return { storage, call, patch, candidate, admin }
}

test('карточка: дата рождения с опечаткой — 422 с кодом, сохранённая не меняется; верная — возраст и 18+ по ней', async () => {
  await withTestDb('w2hp-birth', async (sql) => {
    const { patch, candidate } = await setup(sql)
    const adultDate = bornYearsAgo(20)
    const a = await candidate({ birthDate: adultDate, lastName: 'Иванова', school: 'МГУПП', startReady: 'now' })
    assert.equal(a.birthDate, adultDate)

    for (const typo of [`31.02.${yearAgo(20)}`, `12.13.${yearAgo(21)}`, `01.01.${yearAgo(120)}`, 'вчера']) {
      const r = await patch(a.id, { profile: { birthDate: typo } })
      assert.equal(r.status, 422, typo)
      assert.equal(r.body.codes?.birthDate, 'bad_birth_date', typo)
      assert.ok(r.body.errors?.birthDate, typo)
    }
    const [row] = await sql<{ birth_date: Date }[]>`select birth_date from applications where id = ${a.id}`
    assert.equal(row.birth_date.toISOString().slice(0, 10), adultDate, 'опечатка не стёрла дату')

    const other = bornYearsAgo(23)
    const ok = await patch(a.id, { profile: { birthDate: formatBirthDate(other) } })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.application.birthDate, other)
    assert.equal(ok.body.application.adult, true)
    assert.equal(caseFieldText(ok.body.application, 'age'), '23 года')
    assert.equal(caseFieldText(ok.body.application, 'birthDate'), formatBirthDate(other))
    assert.equal(ok.body.history.at(-1)?.kind, 'profile')
  })
})

test('моложе 18 по дате: сохраняется, но «Пригласить» и «Берём» — только с подтверждением; исправленная дата снимает запрет сразу', async () => {
  await withTestDb('w2hp-underage', async (sql) => {
    const { patch, candidate, call } = await setup(sql)
    const a = await candidate({ birthDate: bornYearsAgo(20) })
    const young = bornYearsAgo(17)
    const set = await patch(a.id, { profile: { birthDate: young } })
    assert.equal(set.status, 200, 'моложе 18 HR записывает: видно возраст')
    assert.equal(set.body.application.adult, false)
    assert.equal(caseFieldText(set.body.application, 'age'), '17 лет')

    const invite = await patch(a.id, { status: 'interview', withoutSlot: true })
    assert.equal(invite.status, 422)
    assert.equal(invite.body.error, 'underage')
    const bulk = await call('POST', '/api/hr/bulk', { ids: [a.id], action: 'status', status: 'interview', withoutSlot: true })
    assert.equal(bulk.status, 422, 'массово — тоже')

    // В одном запросе поправили дату и пригласили: проверка смотрит на новую дату
    const fixed = await patch(a.id, { profile: { birthDate: formatBirthDate(bornYearsAgo(19)) }, status: 'interview', withoutSlot: true })
    assert.equal(fixed.status, 200, JSON.stringify(fixed.body).slice(0, 200))
    assert.equal(fixed.body.application.status, 'interview')

    // И наоборот: в запросе дата моложе 18 — пригласить без подтверждения нельзя, даже если раньше было 18+
    const b = await candidate({ birthDate: bornYearsAgo(25) })
    const wrong = await patch(b.id, { profile: { birthDate: young }, status: 'interview', withoutSlot: true })
    assert.equal(wrong.status, 422)
    assert.equal(wrong.body.error, 'underage')
    const confirmed = await patch(b.id, { profile: { birthDate: young }, status: 'interview', withoutSlot: true, allowUnderage: true })
    assert.equal(confirmed.status, 200)
  })
})

test('когда может выйти и учёба: правка в карточке, «С определённого месяца» без месяца — 422', async () => {
  await withTestDb('w2hp-start', async (sql) => {
    const { patch, candidate } = await setup(sql)
    const a = await candidate()
    const noMonth = await patch(a.id, { profile: { startReady: 'month' } })
    assert.equal(noMonth.status, 422)
    assert.equal(noMonth.body.codes?.startMonth, 'required')
    const july = await patch(a.id, { profile: { startReady: 'month', startMonth: 7, school: '  РХТУ им. Менделеева ', notStudying: false } })
    assert.equal(july.status, 200)
    assert.equal(july.body.application.startReady, 'month')
    assert.equal(july.body.application.startMonth, 7)
    assert.equal(caseFieldText(july.body.application, 'startReady'), 'С июля')
    assert.equal(july.body.application.school, 'РХТУ им. Менделеева')
    const after = await patch(a.id, { profile: { startReady: 'after_session', school: '', notStudying: true } })
    assert.equal(after.body.application.startMonth, null, 'месяц сброшен')
    assert.equal(studyLabel(after.body.application), 'Уже не учусь')
  })
})

test('фильтр «Когда может выйти»: в адресе, в списке и в выгрузке', async () => {
  await withTestDb('w2hp-filter', async (sql) => {
    const { call, candidate } = await setup(sql)
    const now = await candidate({ startReady: 'now' })
    await candidate({ startReady: 'after_session' })
    const silent = await candidate()

    const f = paramsToFilter(new URLSearchParams('start=now'))
    assert.deepEqual(f, { startReady: 'now' })
    assert.equal(filterToParams(f).toString(), 'start=now')
    assert.deepEqual(paramsToFilter(new URLSearchParams('start=soon')), {}, 'незнакомое значение — без фильтра')

    const list = (await (await call('GET', '/api/hr/applications')).json()) as HrApplication[]
    assert.deepEqual(applyFilter(list, { startReady: 'now' }).map((a) => a.id), [now.id])
    assert.deepEqual(applyFilter(list, { startReady: 'none' }).map((a) => a.id), [silent.id], '«не ответил»')

    const res = await call('POST', '/api/hr/export', { format: 'json', query: 'start=now' })
    const rows = (await res.json()) as unknown[]
    assert.equal(rows.length, 1)
    assert.ok(JSON.stringify(rows[0]).includes(now.id))
  })
})

test('ручное добавление: поля кейса, основание согласия; дата с опечаткой — 422 с кодом', async () => {
  await withTestDb('w2hp-manual', async (sql) => {
    const { call } = await setup(sql)
    const born = bornYearsAgo(21)
    const res = await call('POST', '/api/hr/applications', {
      name: 'Олег',
      lastName: 'Смирнов',
      middleName: 'Петрович',
      phone: '+79031234567',
      source: 'phone',
      birthDate: formatBirthDate(born),
      school: 'Колледж пищевых технологий',
      startReady: 'two_weeks',
      consentBasis: 'hr_verbal',
    })
    assert.equal(res.status, 201)
    const app = ((await res.json()) as { application: HrApplication }).application
    assert.equal(app.birthDate, born)
    assert.equal(app.adult, true)
    assert.equal(app.middleName, 'Петрович')
    assert.equal(app.school, 'Колледж пищевых технологий')
    assert.equal(app.startReady, 'two_weeks')
    assert.equal(app.consentSource, 'hr_verbal')
    assert.ok(app.consentAt, 'время согласия')
    assert.equal(app.consentBy, 'Админ', 'кто отметил')

    const bare = await call('POST', '/api/hr/applications', { name: 'Без основания', phone: '+79031234568', source: 'employee' })
    assert.equal(bare.status, 201)
    assert.equal(((await bare.json()) as { application: HrApplication }).application.consentSource, 'none', 'без основания — согласия нет')

    const typo = await call('POST', '/api/hr/applications', { name: 'Опечатка', phone: '+79031234569', source: 'phone', birthDate: `30.02.${yearAgo(22)}`, consentBasis: 'none' })
    assert.equal(typo.status, 422)
    const body = (await typo.json()) as { codes: Record<string, string> }
    assert.equal(body.codes.birthDate, 'bad_birth_date')
    const badBasis = await call('POST', '/api/hr/applications', { name: 'Основание', phone: '+79031234570', source: 'phone', consentBasis: 'site_form' })
    assert.equal(badBasis.status, 422, 'согласие «с сайта» сотрудник поставить не может')
  })
})

test('импорт: колонка «Дата рождения» узнаётся, возраст считается по ней, моложе 18 — с замечанием; вуз — в заявку', async () => {
  const headers = ['ФИО', 'Телефон', 'Дата рождения', 'Дата отклика', 'Учебное заведение', 'Возраст']
  const mapping = guessMapping(headers)
  assert.equal(mapping.birthDate, 2, 'дата рождения — своя колонка')
  assert.equal(mapping.date, 3, 'дата отклика — не дата рождения')
  assert.equal(mapping.school, 4)
  const adultBorn = bornYearsAgo(22)
  const row = mapRow(['Петрова Анна Сергеевна', '+7 916 111-22-33', formatBirthDate(adultBorn), '', 'НИТУ МИСИС', '30'], mapping, 2)
  assert.equal(row.birthDate, adultBorn)
  assert.equal(row.adult, true, 'возраст — по дате, колонка «Возраст» не важнее')
  assert.equal(row.school, 'НИТУ МИСИС')
  assert.deepEqual(row.problems, [])
  const young = mapRow(['Сидоров Иван', '+7 916 111-22-34', formatBirthDate(bornYearsAgo(17)), '', '', ''], mapping, 3)
  assert.equal(young.adult, false)
  assert.ok(young.warnings.some((w) => w.startsWith('17 лет')), young.warnings.join())
  const typo = mapRow(['Кузнецов Пётр', '+7 916 111-22-35', `31.02.${yearAgo(22)}`, '', '', ''], mapping, 4)
  assert.equal(typo.birthDate, '')
  assert.ok(typo.warnings.some((w) => w.includes('дата рождения не распознана')))
  assert.deepEqual(typo.problems, [], 'строку всё равно загружаем')
  // Дата из Excel числом
  const serial = String(Math.round(Date.parse(`${adultBorn}T00:00:00Z`) / 864e5 + 25569))
  assert.equal(mapRow(['Орлова Вера', '+7 916 111-22-36', serial, '', '', ''], mapping, 5).birthDate, adultBorn)

  await withTestDb('w2hp-import', async (sql) => {
    const { call } = await setup(sql)
    const res = await call('POST', '/api/hr/import/commit', { rows: [row, young], source: 'hh', skipDuplicates: true, consentBasis: 'job_board' })
    assert.equal(res.status, 200)
    const report = (await res.json()) as { created: { id: string }[] }
    assert.equal(report.created.length, 2)
    const saved = await sql<{ id: string; birth_date: Date; adult: boolean; school: string; consent_source: string; consent_by: string }[]>`
      select id, birth_date, adult, school, consent_source, consent_by from applications where id in ${sql(report.created.map((c) => c.id))} order by name`
    const anna = saved.find((s) => s.school === 'НИТУ МИСИС')!
    assert.equal(anna.birth_date.toISOString().slice(0, 10), adultBorn)
    assert.equal(anna.adult, true)
    assert.equal(anna.consent_source, 'job_board')
    assert.equal(anna.consent_by, 'Админ')
    assert.ok(saved.some((s) => s.adult === false), 'моложе 18 — сохранён с adult = false')
    assert.equal(ageOn(adultBorn), 22)
  })
})
