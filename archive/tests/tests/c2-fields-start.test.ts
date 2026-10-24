// c2-fields-2: когда кандидат может выйти — startReady и startMonth. Варианты и подписи, нормализация,
// проверка заявки, запись и чтение в PostgreSQL и в хранилище в памяти, ограничения базы.
// Запуск: pnpm test c2-fields-start (нужен PostgreSQL, база создаётся и удаляется сама)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CONSENT_VERSION,
  checkApplication,
  isStartReady,
  startMonthOptions,
  startReadyLabel,
  startReadyOptions,
  type ApplicationInput,
} from '../../shared/applications'
import { normalizeApplicationInput } from '../../shared/applicationInput'
import { caseFieldLabels, caseFieldText } from '../../shared/hr'
import { PostgresStorage } from '../../server/db'
import { WorkflowRepo } from '../../server/db/workflow'
import { memoryStorage } from '../../server/dialog/storage'
import { withTestDb } from './_db'

const birthDate = new Date(Date.now() - 20 * 365.25 * 864e5).toISOString().slice(0, 10)
const bot = (extra: Partial<ApplicationInput>): ApplicationInput =>
  ({ name: 'Аня', lastName: 'Иванова', phone: `+7900${Math.floor(1e6 + Math.random() * 8e6)}`, channel: 'telegram', channelUserId: String(Math.random()), birthDate, school: 'МГУПП', consent: true, consentVersion: CONSENT_VERSION, ...extra }) as ApplicationInput

test('варианты и подписи: «Сразу», «Через 1–2 недели», «После сессии», «С определённого месяца» и «С июля»', () => {
  assert.deepEqual(
    startReadyOptions.map((o) => [o.id, o.label]),
    [
      ['now', 'Сразу'],
      ['two_weeks', 'Через 1–2 недели'],
      ['after_session', 'После сессии'],
      ['month', 'С определённого месяца'],
    ],
  )
  assert.equal(startMonthOptions.length, 12)
  assert.deepEqual(startMonthOptions.slice(5, 8), [
    { id: 6, label: 'Июнь' },
    { id: 7, label: 'Июль' },
    { id: 8, label: 'Август' },
  ])
  assert.equal(startReadyLabel('month', 7), 'С июля')
  assert.equal(startReadyLabel('month', 5), 'С мая')
  assert.equal(startReadyLabel('month', 9), 'С сентября')
  assert.equal(startReadyLabel('month', null), 'С определённого месяца')
  assert.equal(startReadyLabel('month', 13), 'С определённого месяца')
  assert.equal(startReadyLabel('after_session', 7), 'После сессии', 'месяц без «С определённого месяца» не показываем')
  assert.equal(startReadyLabel(''), '')
  assert.equal(startReadyLabel('soon'), '')
  assert.ok(isStartReady('two_weeks') && !isStartReady('') && !isStartReady('soon'))
  // Тексты — без «!» и многоточий
  for (const o of [...startReadyOptions, ...startMonthOptions]) assert.ok(!/!|\.\.\.|…/.test(o.label), o.label)
  // Подпись в HR — та же
  assert.equal(caseFieldLabels.startReady, 'Когда может выйти')
  assert.equal(caseFieldText({ startReady: 'month', startMonth: 8, school: '', birthDate: '' }, 'startReady'), 'С августа')
})

test('нормализация: неизвестное отбрасывается, месяц — только при «С определённого месяца», строка «7» читается', () => {
  assert.equal(normalizeApplicationInput({ startReady: 'now', startMonth: 7 }).startMonth, null)
  assert.equal(normalizeApplicationInput({ startReady: 'now' }).startReady, 'now')
  assert.equal(normalizeApplicationInput({ startReady: 'month', startMonth: 7 }).startMonth, 7)
  assert.equal(normalizeApplicationInput({ startReady: 'month', startMonth: '7' as never }).startMonth, 7)
  for (const bad of [0, 13, 6.5, 'июль', null]) assert.equal(normalizeApplicationInput({ startReady: 'month', startMonth: bad as never }).startMonth, null, String(bad))
  assert.equal(normalizeApplicationInput({ startReady: 'soon' as never }).startReady, '')
  assert.equal(normalizeApplicationInput({}).startReady, '')
  assert.equal(normalizeApplicationInput({}).startMonth, null)
})

test('проверка заявки кандидата: готовность обязательна, при «С определённого месяца» — и месяц', () => {
  const base = { name: 'Аня', lastName: 'Иванова', phone: '+79161234567', birthDate, school: 'МГУПП' }
  assert.equal(checkApplication({ ...base }, { candidate: true }).codes.startReady, 'required')
  assert.equal(checkApplication({ ...base, startReady: 'soon' as never }, { candidate: true }).codes.startReady, 'required')
  assert.deepEqual(checkApplication({ ...base, startReady: 'after_session' }, { candidate: true }).errors, {})
  const noMonth = checkApplication({ ...base, startReady: 'month' }, { candidate: true })
  assert.equal(noMonth.codes.startMonth, 'required')
  assert.match(noMonth.errors.startMonth, /^Выбери месяц/)
  assert.deepEqual(checkApplication({ ...base, startReady: 'month', startMonth: 7 }, { candidate: true }).errors, {})
  // HR и импорт: поле необязательно
  assert.deepEqual(checkApplication({ name: 'Аня', phone: '+79161234567' }).errors, {})
})

test('PostgreSQL и память: готовность и месяц записываются и читаются; база не принимает неизвестное', async () => {
  await withTestDb('c2-start', async (sql) => {
    const storage = new PostgresStorage(sql)
    const repo = new WorkflowRepo(sql)
    const month = await storage.saveApplication(bot({ startReady: 'month', startMonth: 7 }))
    const now = await storage.saveApplication(bot({ startReady: 'now', startMonth: 7 }))
    assert.equal(month.startReady, 'month')
    assert.equal(month.startMonth, 7)
    assert.equal(now.startMonth, null, 'месяц без «С определённого месяца» не записывается')
    const [row] = await sql<{ start_ready: string; start_month: number | null }[]>`select start_ready, start_month from applications where id = ${month.id}`
    assert.deepEqual({ ...row }, { start_ready: 'month', start_month: 7 })
    const hr = (await repo.get(month.id))!
    assert.equal(hr.startReady, 'month')
    assert.equal(hr.startMonth, 7)
    assert.equal(startReadyLabel(hr.startReady, hr.startMonth), 'С июля')

    // Ограничения базы: неизвестная готовность, месяц вне 1–12, месяц без «С определённого месяца»
    const bad = (cols: Record<string, unknown>) => sql`insert into applications ${sql({ id: `C2S${Math.floor(Math.random() * 1e6)}`, name: 'Проверка', ...cols })}`
    await assert.rejects(bad({ start_ready: 'soon' }), (e: { code?: string }) => e.code === '23514')
    await assert.rejects(bad({ start_ready: 'month', start_month: 13 }), (e: { code?: string }) => e.code === '23514')
    await assert.rejects(bad({ start_ready: 'now', start_month: 7 }), (e: { code?: string }) => e.code === '23514')
    await bad({ start_ready: 'month', start_month: 12 })
    await bad({})

    // HR меняет готовность: месяц сбрасывается, когда он не нужен
    await repo.setProfile(month.id, { startReady: 'two_weeks' }, { id: 0, name: 'Система' } as never)
    const changed = (await repo.get(month.id))!
    assert.equal(changed.startReady, 'two_weeks')
    assert.equal(changed.startMonth, null)
    await repo.setProfile(month.id, { startReady: 'month', startMonth: 9 }, { id: 0, name: 'Система' } as never)
    assert.equal(startReadyLabel((await repo.get(month.id))!.startReady, (await repo.get(month.id))!.startMonth), 'С сентября')
  })

  // Хранилище в памяти — то же самое
  const mem = memoryStorage()
  const fromMemory = await mem.saveApplication(bot({ startReady: 'month', startMonth: 8, channel: 'max', channelUserId: '77' }))
  assert.equal(fromMemory.startReady, 'month')
  assert.equal(fromMemory.startMonth, 8)
  const latest = (await mem.latestApplicationFor!('max', '77'))!
  assert.equal(latest.startReady, 'month')
  assert.equal(latest.startMonth, 8)
})
