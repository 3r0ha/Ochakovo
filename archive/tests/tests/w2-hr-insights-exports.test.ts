// Новые поля во всех выгрузках (w2-hi-c1, w2-hi-1): дата рождения, возраст, когда может выйти, учёба, практика от вуза,
// «хочет остаться», согласие (где, версия, когда, кто отметил), оформление, первая смена, наставник, документы по практике,
// итог сезона, причина ухода и резерв. Прежние колонки — на своих местах, новые — в конце; 1С — в Windows-1251.
// Запуск: pnpm test w2-hr-insights (проверка через API — на временной базе PostgreSQL)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyHrFields, type HrApplication } from '../../shared/applications'
import { formatBirthDate } from '../../shared/birthDate'
import { applications1C, applicationsCsv, applicationsJson, exportColumns, oneCColumns, pickColumns } from '../../shared/hr'
import { DEMO_ADMIN } from '../../server/auth/bootstrap'
import { createApp } from '../../server/app'
import type { Registry } from '../../server/channels/registry'
import { PostgresStorage } from '../../server/db'
import { encodeCp1251 } from '../../server/export/cp1251'
import { buildWorkbook } from '../../server/export/xlsx'
import { unzip } from '../../server/export/xlsxWriter'
import { serverSettled, withTestDb } from './_db'

const HOUR = 3600e3
const DAY = 24 * HOUR
const noBots: Registry = { get: () => undefined, active: () => [], failed: () => [], start: () => {} }

/** Колонки выгрузки до второй волны — в этом порядке, ключи для JSON те же */
const oldKeys = [
  'id', 'createdAt', 'status', 'statusUpdatedAt', 'assignee', 'lastName', 'name', 'middleName', 'phone', 'contact', 'adult',
  'citizenship', 'medBook', 'shifts', 'school', 'course', 'department', 'vacancy', 'format', 'months', 'interview',
  'interviewAddress', 'noAnswer', 'callback', 'declineReason', 'source', 'channel', 'tasks', 'friend', 'portfolio', 'resume',
  'comment', 'notes',
]
const newKeys = [
  'birthDate', 'age', 'startReady', 'practiceSchool', 'wantsToStay', 'consentSource', 'consentVersion', 'consentAt', 'consentBy',
  'onboardingAt', 'firstShiftAt', 'shiftKind', 'mentorName', 'practiceDocs', 'seasonOutcome', 'seasonLeaveReason', 'reserve',
  // «Как дела на смене» — ответы новичка на три вопроса
  'checkin_shift1', 'checkin_week1', 'checkin_month1',
]
/** Колонки «Для 1С» до второй волны */
const old1C = [
  'Фамилия', 'Имя', 'Отчество', 'Телефон', 'Электронная почта', 'Мессенджер', 'Должность', 'Подразделение', 'Источник',
  'Дата отклика', 'Состояние', 'Дата собеседования', 'Гражданство', 'Медицинская книжка', 'Учебное заведение', 'Комментарий',
  'Номер заявки',
]

/** День рождения ровно age лет назад минус неделя: возраст — age, по Москве в любое время суток */
function birthDateFor(age: number) {
  const d = new Date(Date.now() - 7 * DAY)
  d.setUTCFullYear(d.getUTCFullYear() - age)
  return d.toISOString().slice(0, 10)
}

const birth = birthDateFor(20)
const firstShift = new Date(Date.now() - 3 * DAY)
firstShift.setUTCHours(17, 0, 0, 0) // 20:00 по Москве — ночная смена

const base = (over: Partial<HrApplication>): HrApplication => ({
  id: 'K7M2PQ9X',
  createdAt: new Date(Date.now() - 20 * DAY).toISOString(),
  channel: 'web',
  name: 'Анна',
  lastName: 'Ковалёва',
  phone: '+79161234567',
  contact: '@anna_k',
  school: '',
  course: '',
  department: 'production',
  vacancyId: 'bottling-operator',
  format: 'Оплачиваемая практика',
  months: [6, 7],
  comment: '',
  game: { quizResult: null, conveyorBest: 0, activities: 2 },
  source: 'fair-mgupp',
  ...emptyHrFields(),
  status: 'started',
  reached: ['new', 'interview', 'hired', 'started'],
  birthDate: birth,
  startReady: 'month',
  startMonth: 7,
  notStudying: true,
  practiceSchool: true,
  wantsToStay: true,
  consentAt: new Date(Date.now() - 20 * DAY).toISOString(),
  consentVersion: '1',
  consentSource: 'site_form',
  onboardingAt: new Date(Date.now() - 5 * DAY).toISOString(),
  firstShiftAt: firstShift.toISOString(),
  shiftKind: 'night',
  mentorName: 'Наталья Белова',
  practiceDocs: ['contract', 'order'],
  seasonOutcome: 'left',
  seasonLeaveReason: 'commute',
  reserve: true,
  ...over,
})

const mskDay = (d: Date) => d.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric' })

/** CSV с BOM и «;» → строки ячеек */
const parseCsv = (csv: string) => csv.replace(/^﻿/, '').split('\r\n').map((l) => l.slice(1, -1).split('";"'))

test('Excel, CSV и JSON: прежние колонки на своих местах, новые — в конце', () => {
  const keys = pickColumns().map((c) => c.key)
  assert.deepEqual(keys.slice(0, oldKeys.length), oldKeys, 'прежние колонки не сдвинулись')
  assert.deepEqual(keys.slice(oldKeys.length), newKeys, 'новые — после прежних')
  assert.deepEqual(pickColumns(['quiz', 'game']).map((c) => c.key).slice(-2), ['quiz', 'game'], 'дополнительные — по запросу, в самом конце')
  const labels = Object.fromEntries(exportColumns.map((c) => [c.key, c.label]))
  assert.equal(labels.school, 'Вуз или колледж', 'подпись учёбы — как в списке и карточке')
  // Ответ на «Как дела на смене»: вариант и причина; нет ответа — пусто
  assert.equal(labels.checkin_week1, 'Как дела: через неделю')
  const at = new Date().toISOString()
  const withCheckins = base({
    checkins: [
      { step: 'shift1', askedAt: at, askedVia: 'bot', answer: 'ok', reason: '', answeredAt: at, answeredVia: 'telegram' },
      { step: 'week1', askedAt: at, askedVia: 'call', answer: 'hard', reason: 'study', answeredAt: at, answeredVia: 'hr' },
      { step: 'month1', askedAt: at, askedVia: 'bot', answer: '', reason: '', answeredAt: null, answeredVia: '' },
    ],
  })
  const value = (key: string) => exportColumns.find((c) => c.key === key)!.value(withCheckins)
  assert.deepEqual([value('checkin_shift1'), value('checkin_week1'), value('checkin_month1')], ['всё нормально', 'тяжело: учёба', ''])
  assert.equal(labels.birthDate, 'Дата рождения')
  assert.equal(labels.startReady, 'Когда может выйти')
})

test('CSV: значения новых полей по-русски, дата рождения ДД.ММ.ГГГГ', () => {
  const [head, row] = parseCsv(applicationsCsv([base({})]))
  const cell = (label: string) => row[head.indexOf(label)]
  assert.equal(cell('Дата рождения'), formatBirthDate(birth))
  assert.equal(cell('Возраст'), '20')
  assert.equal(cell('Когда может выйти'), 'С июля')
  assert.equal(cell('Вуз или колледж'), 'Уже не учится', 'о кандидате — в третьем лице, как в карточке')
  assert.equal(cell('Практика от вуза'), 'Да')
  assert.equal(cell('Хочет остаться'), 'Да')
  assert.equal(cell('Согласие: где'), 'Форма на сайте')
  assert.equal(cell('Согласие: версия'), '1')
  assert.match(cell('Согласие: когда'), /^\d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}$/)
  assert.equal(cell('Первая смена'), `${mskDay(firstShift)}, 20:00`)
  assert.equal(cell('Дневная или ночная'), 'Ночная')
  assert.equal(cell('Наставник'), 'Наталья Белова')
  assert.equal(cell('Документы по практике'), 'Договор, приказ')
  assert.equal(cell('Итог сезона'), 'Уход до конца сезона')
  assert.equal(cell('Причина ухода'), 'Дорога')
  assert.equal(cell('Звать в штат / резерв'), 'Да')
  assert.equal(row.length, head.length)

  // Вуз указан — он и пишется; пустые поля — пустые ячейки
  const [, plain] = parseCsv(applicationsCsv([base({ school: 'МГУПП', notStudying: false, birthDate: '', startReady: '', reserve: false, seasonOutcome: '', seasonLeaveReason: '' })]))
  assert.equal(plain[head.indexOf('Вуз или колледж')], 'МГУПП')
  for (const label of ['Дата рождения', 'Возраст', 'Когда может выйти', 'Итог сезона', 'Звать в штат / резерв']) assert.equal(plain[head.indexOf(label)], '', label)
})

test('обезличенная заявка: вместо даты рождения — пометка, возраста нет', () => {
  const erased = base({ anonymizedAt: new Date().toISOString(), anonymizedReason: 'retention', name: '', lastName: '', phone: '' })
  const [head, row] = parseCsv(applicationsCsv([erased]))
  assert.equal(row[head.indexOf('Дата рождения')], 'удалено по сроку хранения')
  assert.equal(row[head.indexOf('Возраст')], '')
  const [json] = applicationsJson([erased])
  assert.equal(json.birthDate, 'удалено по сроку хранения')
  assert.equal(json.age, null)
  const [h1c, r1c] = applications1C([erased]).trim().split('\r\n').map((l) => l.split(';'))
  assert.equal(r1c[h1c.indexOf('Дата рождения')], '', '1С: в поле даты — пусто, текст 1С не загрузит')
})

test('JSON: дата рождения — YYYY-MM-DD, остальные даты — ISO с временем', () => {
  const [json] = applicationsJson([base({})])
  assert.equal(json.birthDate, birth)
  assert.equal(json.age, 20)
  assert.equal(json.firstShiftAt, firstShift.toISOString())
  assert.equal(json.startReady, 'С июля')
  assert.equal(json.practiceDocs, 'Договор, приказ')
  for (const k of [...oldKeys, ...newKeys]) assert.ok(k in json, `в JSON есть ${k}`)
})

test('Excel: дата рождения — настоящая дата без сдвига часового пояса', async () => {
  const file = await buildWorkbook([base({})], pickColumns())
  const files = unzip(file)
  const sheet = files.get('xl/worksheets/sheet1.xml')!.toString('utf8')
  const strings = [...files.get('xl/sharedStrings.xml')!.toString('utf8').matchAll(/<si><t[^>]*>([\s\S]*?)<\/t><\/si>/g)].map((m) => m[1])
  const col = pickColumns().findIndex((c) => c.key === 'birthDate') + 1
  const letter = String.fromCharCode(64 + Math.floor((col - 1) / 26)).replace('@', '') + String.fromCharCode(65 + ((col - 1) % 26))
  const cell = new RegExp(`<c r="${letter}2" s="(\\d+)"[^>]*><v>([^<]+)</v></c>`).exec(sheet)
  assert.ok(cell, `ячейка ${letter}2`)
  assert.equal(Number(cell[2]), Date.parse(`${birth}T00:00:00Z`) / DAY + 25569, 'серийный номер дня — ровно дата рождения')
  const styles = files.get('xl/styles.xml')!.toString('utf8')
  assert.ok(styles.includes('formatCode="dd.mm.yyyy"'), 'формат — только дата')
  for (const label of ['Дата рождения', 'Возраст', 'Когда может выйти', 'Согласие: где', 'Первая смена', 'Наставник', 'Итог сезона', 'Звать в штат / резерв'])
    assert.ok(strings.includes(label), `в шапке «${label}»`)
})

test('1С: прежние колонки на местах, новые в конце, «Дата приёма» — день первой смены, Windows-1251 без потерь', () => {
  assert.deepEqual(oneCColumns.slice(0, old1C.length).map((c) => c.label), old1C)
  const added = oneCColumns.slice(old1C.length).map((c) => c.label)
  for (const label of ['Дата рождения', 'Когда может выйти', 'Практика от вуза', 'Хочет остаться', 'Согласие на обработку данных', 'Дата согласия', 'Дата оформления', 'Дата приёма', 'Смена', 'Наставник', 'Документы по практике', 'Итог сезона', 'Причина ухода', 'Резерв'])
    assert.ok(added.includes(label), `новая колонка «${label}»`)

  const text = applications1C([base({ startReady: 'two_weeks', startMonth: null, school: 'РХТУ им. Менделеева', notStudying: false })])
  const bytes = encodeCp1251(text)
  const back = new TextDecoder('windows-1251').decode(bytes)
  assert.equal(back, text, 'все символы есть в Windows-1251: «–», «ё», кавычки-ёлочки')
  const [head, row] = text.trim().split('\r\n').map((l) => l.split(';'))
  const cell = (label: string) => row[head.indexOf(label)]
  assert.equal(cell('Дата приёма'), mskDay(firstShift))
  assert.equal(cell('Дата рождения'), formatBirthDate(birth))
  assert.equal(cell('Когда может выйти'), 'Через 1–2 недели')
  assert.equal(cell('Учебное заведение'), 'РХТУ им. Менделеева')
  assert.equal(cell('Смена'), 'Ночная')
  assert.equal(cell('Резерв'), 'Да')
  assert.equal(row.length, head.length)
})

test('выгрузки через API: все четыре формата с новыми колонками, 1С — в Windows-1251', async () => {
  await withTestDb('w2hri_exports', async (sql) => {
    const storage = new PostgresStorage(sql)
    const app = await createApp({ storage, engine: null, bots: noBots, hrToken: '', env: { NODE_ENV: 'test' } })
    await serverSettled(sql)
    await sql`
      insert into applications (id, created_at, channel, name, last_name, phone, contact, school, not_studying, vacancy_id, months, game, source, status,
                                birth_date, start_ready, start_month, practice_school, wants_to_stay, consent_at, consent_version, consent_source,
                                onboarding_at, first_shift_at, shift_kind, mentor_name, practice_docs, season_outcome, reserve)
      values ('APIX0001', ${new Date(Date.now() - 10 * DAY)}, 'web', 'Иван', 'Соколов', '+79161112233', '', '', true, 'bottling-operator',
              ${sql.json([6, 7])}, ${sql.json({ quizResult: null, conveyorBest: 0, activities: 1 })}, 'fair-mgupp', 'started',
              ${birth}, 'month', 7, true, true, ${new Date(Date.now() - 10 * DAY)}, '1', 'site_form',
              ${new Date(Date.now() - 6 * DAY)}, ${firstShift}, 'night', 'Андрей Ершов', ${sql.array(['contract', 'order', 'diary'])}::text[], 'completed', true)`
    const login = await app.request('/api/hr/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: DEMO_ADMIN.email, password: DEMO_ADMIN.password }),
    })
    assert.equal(login.status, 200)
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
    const get = (file: string) => app.request(`/api/hr/export/${file}`, { headers: { cookie } })

    const csv = await get('applications.csv')
    assert.equal(csv.status, 200)
    const [head, row] = parseCsv(await csv.text())
    assert.deepEqual(head.slice(0, 3), ['Номер заявки', 'Дата заявки', 'Статус'])
    assert.equal(row[head.indexOf('Дата рождения')], formatBirthDate(birth))
    assert.equal(row[head.indexOf('Итог сезона')], 'Сезон отработан')
    assert.equal(row[head.indexOf('Документы по практике')], 'Договор, приказ, дневник')

    const json = (await (await get('applications.json')).json()) as Record<string, unknown>[]
    assert.equal(json[0].birthDate, birth)
    assert.equal(json[0].mentorName, 'Андрей Ершов')

    const xlsx = await get('applications.xlsx')
    assert.equal(xlsx.status, 200)
    const strings = unzip(Buffer.from(await xlsx.arrayBuffer())).get('xl/sharedStrings.xml')!.toString('utf8')
    for (const s of ['Дата рождения', 'Андрей Ершов', 'Сезон отработан', 'Отработали сезон']) assert.ok(strings.includes(s), `в книге «${s}»`)

    const oneC = await get('applications.1c.csv')
    assert.match(oneC.headers.get('content-type') ?? '', /windows-1251/)
    const decoded = new TextDecoder('windows-1251').decode(new Uint8Array(await oneC.arrayBuffer()))
    const [h1c, r1c] = decoded.trim().split('\r\n').map((l) => l.split(';'))
    assert.deepEqual(h1c.slice(0, old1C.length), old1C)
    assert.equal(r1c[h1c.indexOf('Дата приёма')], mskDay(firstShift))
    assert.equal(r1c[h1c.indexOf('Учебное заведение')], 'Уже не учится')
    assert.equal(r1c[h1c.indexOf('Наставник')], 'Андрей Ершов')
  })
})
