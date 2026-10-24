// Сборка заявки (shared/applicationInput.ts): форма на сайте, бот и хранилище в памяти получают одну и ту же заявку.
// Запуск: pnpm test core-input (нужен PostgreSQL, база создаётся и удаляется сама)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CONSENT_VERSION, type Application, type ApplicationInput } from '../../shared/applications'
import { ConsentRequiredError, consentError, normalizeApplicationInput, publicApplication, REF_CODE_RE } from '../../shared/applicationInput'
import { normalizePhone, phoneKey } from '../../shared/phone'
import { createApp } from '../../server/app'
import type { Registry } from '../../server/channels/registry'
import { normalizeApplication, PostgresStorage } from '../../server/db'
import { memoryStorage } from '../../server/dialog/storage'
import { serverSettled, withTestDb } from './_db'

const noBots: Registry = { get: () => undefined, active: () => [], failed: () => [], start: () => {} }

/** Дата рождения 20 лет назад от текущего момента — так, как её вводят в форме: ДД.ММ.ГГГГ */
const birthInput = (() => {
  const [y, m, d] = new Date(Date.now() - 20 * 365.25 * 864e5).toISOString().slice(0, 10).split('-')
  return `${d}.${m}.${y}`
})()

/** Сырой ввод «как пришло»: пробелы, телефон с восьмёркой, лишние месяцы, неизвестные значения анкеты */
const raw = (phone: string): Partial<ApplicationInput> & Record<string, unknown> => ({
  name: '  Аня  ',
  phone,
  contact: '',
  school: ' МГУПП ',
  course: '3 курс',
  department: 'production',
  vacancyId: 'bottling-operator',
  format: 'Сезонная работа',
  months: [6, 7, 7.5, 13, 8],
  comment: ' Хочу в ночные ',
  friend: ' Оля ',
  game: { quizResult: 'production', conveyorBest: 12.6, activities: 9 },
  source: 'fair-mgupp',
  lastName: ' Иванова ',
  adult: true,
  citizenship: 'ru',
  medBook: 'maybe' as never,
  shifts: 'any',
  portfolio: 'behance.net/anya',
  practiceSchool: true,
  wantsToStay: true,
  // Поля кейса: для заявки с сайта обязательны
  birthDate: ` ${birthInput} `,
  startReady: 'month',
  startMonth: 7,
  consent: true,
  consentVersion: CONSENT_VERSION,
  website: '',
})

/** Поля заявки, которые зависят только от ввода: без номера, времени, токена, канала и источника согласия */
const comparable = (a: Partial<Application>) => ({
  name: a.name,
  phone: a.phone,
  contact: a.contact,
  school: a.school,
  course: a.course,
  department: a.department,
  vacancyId: a.vacancyId,
  format: a.format,
  months: a.months,
  comment: a.comment,
  friend: a.friend,
  game: a.game,
  source: a.source,
  lastName: a.lastName,
  middleName: a.middleName ?? '',
  adult: a.adult,
  citizenship: a.citizenship,
  medBook: a.medBook,
  shifts: a.shifts,
  portfolio: a.portfolio,
  resumeUrl: a.resumeUrl ?? '',
  consentVersion: a.consentVersion,
  practiceSchool: a.practiceSchool,
  wantsToStay: a.wantsToStay,
  birthDate: a.birthDate,
  startReady: a.startReady,
  startMonth: a.startMonth,
  notStudying: a.notStudying ?? false,
})

test('телефон приводится к +7XXXXXXXXXX из любой привычной записи', () => {
  for (const v of ['8 (916) 123-45-67', '+7 916 123 45 67', '9161234567', '7-916-123-45-67', ' +7(916)1234567 ']) assert.equal(normalizePhone(v), '+79161234567', v)
  assert.equal(normalizePhone('+375 29 123-45-67'), '+375291234567')
  assert.equal(normalizePhone('12-34'), '12-34', 'нераспознанный номер не теряется')
  assert.equal(phoneKey('+79161234567'), phoneKey('8 916 123-45-67'))
  assert.equal(normalizeApplicationInput({ phone: '8 916 123 45 67' }).phone, '+79161234567')
})

test('normalizeApplicationInput: новые поля, значения по умолчанию, одинаковый результат на одинаковый ввод', () => {
  const a = normalizeApplicationInput(raw('8 (916) 123-45-67'))
  assert.deepEqual(a, normalizeApplicationInput(raw('8 (916) 123-45-67')))
  assert.equal(a.name, 'Аня')
  assert.deepEqual(a.months, [6, 7, 8])
  assert.deepEqual(a.game, { quizResult: 'production', conveyorBest: 13, activities: 4 })
  assert.equal(a.medBook, '', 'неизвестное значение анкеты отброшено')
  assert.equal(a.portfolio, 'https://behance.net/anya')
  assert.equal(a.consent, true)
  assert.equal(a.consentVersion, CONSENT_VERSION)
  assert.equal(a.consentSource, 'site_form', 'источник по каналу, если не назван')
  assert.equal(a.practiceSchool, true)
  assert.equal(a.wantsToStay, true)
  assert.equal(a.refCode, null)
  assert.equal(a.website, '')

  // Пустой ввод: всё на месте, согласия нет
  const empty = normalizeApplicationInput({})
  assert.equal(empty.channel, 'web')
  assert.equal(empty.consent, false)
  assert.equal(empty.consentSource, 'none')
  assert.equal(empty.consentVersion, '')
  assert.equal(empty.practiceSchool, false)
  assert.equal(empty.wantsToStay, false)
  assert.equal(empty.refCode, null)

  // Источник согласия: бот называет свой, у Telegram и MAX — по каналу; без отметки согласия — none
  assert.equal(normalizeApplicationInput({ channel: 'web', consent: true, consentSource: 'site_chat' }).consentSource, 'site_chat')
  assert.equal(normalizeApplicationInput({ channel: 'telegram', consent: true }).consentSource, 'telegram')
  assert.equal(normalizeApplicationInput({ channel: 'max', consent: true }).consentSource, 'max')
  assert.equal(normalizeApplicationInput({ channel: 'max', consent: 'yes' as never, consentSource: 'max' }).consentSource, 'none')
  assert.equal(normalizeApplicationInput({ consent: true, consentSource: 'email' as never }).consentSource, 'site_form')

  // Код приглашения: алфавит бота, регистр не важен, остальное отбрасывается
  assert.equal(normalizeApplicationInput({ refCode: ' AbC234 ' }).refCode, 'abc234')
  for (const bad of ['abc23', 'abc2345', 'abc 23', 'abc10x', 'абв234', 42]) assert.equal(normalizeApplicationInput({ refCode: bad as never }).refCode, null, String(bad))
  assert.ok(REF_CODE_RE.test('kvas29'))
})

test('consentError: отметка, версия текста и источник, где кандидат дал согласие сам', () => {
  const ok = { consent: true, consentVersion: CONSENT_VERSION, consentSource: 'site_form' as const }
  assert.equal(consentError(ok), null)
  for (const source of ['site_chat', 'telegram', 'max'] as const) assert.equal(consentError({ ...ok, consentSource: source }), null)
  assert.match(consentError({ ...ok, consent: false }) ?? '', /Нужно согласие/)
  assert.match(consentError({ ...ok, consent: undefined }) ?? '', /Нужно согласие/)
  assert.match(consentError({ ...ok, consentVersion: '0' }) ?? '', /Текст согласия обновился/)
  assert.match(consentError({ ...ok, consentVersion: '' }) ?? '', /Текст согласия обновился/)
  for (const source of ['hr_verbal', 'job_board', 'none'] as const) assert.match(consentError({ ...ok, consentSource: source }) ?? '', /Нужно согласие/, source)
})

test('publicApplication: без полей HR и без пустого кода приглашения', () => {
  const app = { id: 'X', createdAt: '', name: 'Аня', status: 'new', statusUpdatedAt: '', notes: 'заметка', channelUserId: '42', refCode: null } as unknown as Application
  const out = publicApplication(app) as Record<string, unknown>
  for (const k of ['status', 'statusUpdatedAt', 'notes', 'channelUserId', 'refCode']) assert.ok(!(k in out), k)
  assert.equal((publicApplication({ ...app, refCode: 'abc234' }) as Record<string, unknown>).refCode, 'abc234')
})

test('форма и бот: одинаковый ввод — одинаковая заявка (кроме канала)', async () => {
  await withTestDb('core-input', async (sql) => {
    const storage = new PostgresStorage(sql)
    const app = await createApp({ storage, engine: null, bots: noBots, hrToken: '', env: { NODE_ENV: 'test' } })
    await serverSettled(sql)

    // Форма: тот же ввод через POST /api/applications
    const res = await app.request('/api/applications', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(raw('8 (916) 123-45-67')) })
    assert.equal(res.status, 201, await res.clone().text())
    const fromForm = (await res.json()) as Application
    assert.equal(fromForm.phone, '+79161234567')

    // Бот: сценарий заявки передаёт ввод в storage.saveApplication — тот же сырой ввод, канал Telegram.
    // Телефон другой записью того же номера: повтор с сайта здесь не проверяется, это делает маршрут заявок
    const fromBot = await storage.saveApplication({ ...raw('+7 916 123 45 67'), channel: 'telegram', channelUserId: '777', consentSource: 'telegram' } as ApplicationInput)

    const expected = comparable(normalizeApplicationInput(raw('8 (916) 123-45-67')))
    assert.deepEqual(comparable(fromForm), expected, 'форма')
    assert.deepEqual(comparable(fromBot), expected, 'бот (PostgreSQL)')

    // В базе то же, что вернул ответ, и источники согласия по месту
    const rows = await sql<{ id: string; channel: string; phone: string; consent_source: string }[]>`select id, channel, phone, consent_source from applications order by created_at`
    assert.deepEqual(
      rows.map((r) => [r.channel, r.phone, r.consent_source]),
      [
        ['web', '+79161234567', 'site_form'],
        ['telegram', '+79161234567', 'telegram'],
      ],
    )

    // Старое имя для сервера — та же функция
    assert.equal(normalizeApplication, normalizeApplicationInput)
  })
})

test('хранилище в памяти: тот же ввод — та же заявка', async () => {
  // Симулятор и проверки сценариев бота должны видеть ту же заявку, что PostgreSQL
  const mem = memoryStorage()
  const fromMemory = await mem.saveApplication({ ...raw('9161234567'), channel: 'max', channelUserId: '42', consentSource: 'max' } as ApplicationInput)
  assert.deepEqual(comparable(fromMemory), comparable(normalizeApplicationInput(raw('8 (916) 123-45-67'))))
  assert.equal(fromMemory.consentSource, 'max')
})

test('хранилище в памяти: без согласия заявку не сохраняет, как PostgreSQL', async () => {
  const mem = memoryStorage()
  await assert.rejects(mem.saveApplication({ ...raw('9161234567'), consent: false, channel: 'max', channelUserId: '43' } as ApplicationInput), ConsentRequiredError)
  await assert.rejects(mem.saveApplication({ ...raw('9161234567'), consentVersion: '0', channel: 'max', channelUserId: '44' } as ApplicationInput), ConsentRequiredError)
})
