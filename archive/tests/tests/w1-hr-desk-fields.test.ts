// HR-панель, пакет hr-desk: поля заявки для панели (оформление, итог сезона, резерв, спам, явка), вкладки
// второй волны, фильтры «Задания» и «Итог не отмечен», раздача поровну, счёт обзвона.
// Запуск: pnpm test w1-hr-desk-fields (нужен PostgreSQL, база создаётся и удаляется сама)

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { HrApplication } from '../../shared/applications'
import {
  applyFilter,
  attendancePending,
  callChanged,
  callStats,
  evenSplit,
  filterToParams,
  forgetCall,
  nextCall,
  paramsToFilter,
  recordCall,
  skipCall,
  startCall,
  taskFilterOf,
} from '../../shared/hrFilter'
import { taskBucketOf, tasksHiring } from '../../shared/hr'
import { normalizeApplication } from '../../server/db'
import { WorkflowRepo } from '../../server/db/workflow'
import { withTestDb } from './_db'

const HOUR = 3600e3

test('toHr отдаёт поля оформления, итога сезона, резерва, спама и явки', async () => {
  await withTestDb('hr-desk-fields', async (sql) => {
    const workflow = new WorkflowRepo(sql)
    const bare = await workflow.createManual(normalizeApplication({ name: 'Пустая', phone: '+79001110000', source: 'phone' }), { id: 0, name: 'Система' } as never, 'проверка')
    assert.equal(bare.suspectedSpam, false)
    assert.equal(bare.onboardingAt, null)
    assert.equal(bare.firstShiftAt, null)
    assert.equal(bare.shiftKind, '')
    assert.equal(bare.onboardingNote, '')
    assert.equal(bare.seasonOutcome, '')
    assert.equal(bare.seasonLeaveReason, '')
    assert.equal(bare.reserve, false)
    assert.equal(bare.botChannel, null)
    assert.equal(bare.interview, null)

    const app = await workflow.createManual(normalizeApplication({ name: 'Полная', phone: '+79001110001', source: 'phone' }), { id: 0, name: 'Система' } as never, 'проверка')
    const onboarding = new Date(Date.now() + 2 * 24 * HOUR)
    const shift = new Date(Date.now() + 5 * 24 * HOUR)
    await sql`
      update applications set status = 'started', suspected_spam = true, onboarding_at = ${onboarding}, first_shift_at = ${shift}, shift_kind = 'night',
        onboarding_note = 'медкомиссия утром', season_outcome = 'left', season_leave_reason = 'personal', reserve = true,
        bot_channel = 'telegram', bot_user_id = '4242', bot_link_hash = 'секрет'
      where id = ${app.id}`
    const past = new Date(Date.now() - 3 * HOUR)
    await sql`insert into interviews (application_id, starts_at, address, bring, attended, attended_at, self_booked)
              values (${app.id}, ${past}, 'Москва, ул. Рябиновая, 44', 'паспорт', 'no', now(), true)`
    const a = (await workflow.get(app.id))!
    assert.equal(a.suspectedSpam, true)
    assert.equal(a.onboardingAt, onboarding.toISOString())
    assert.equal(a.firstShiftAt, shift.toISOString())
    assert.equal(a.shiftKind, 'night')
    assert.equal(a.onboardingNote, 'медкомиссия утром')
    assert.equal(a.seasonOutcome, 'left')
    assert.equal(a.seasonLeaveReason, 'personal')
    assert.equal(a.reserve, true)
    assert.equal(a.botChannel, 'telegram')
    assert.equal(a.botUserId, '4242')
    assert.ok(!JSON.stringify(a).includes('секрет'), 'хеш ссылки на бота из базы не выходит')
    assert.equal(a.interview?.attended, 'no')
    assert.ok(a.interview?.attendedAt)
    assert.equal(a.interview?.selfBooked, true)
  })
})

// Вкладки читаем как текст: их модули тянут src/lib/api с import.meta.env и в node не загружаются
test('вкладки второй волны готовы и подключены в панели', () => {
  const src = (f: string) => readFileSync(join(import.meta.dirname, '..', '..', f), 'utf8')
  const hr = src('src/pages/Hr.tsx')
  for (const [view, id, label] of [
    ['SourcesView', 'sources', 'Источники'],
    ['FocusView', 'focus', 'Фокус-группа'],
    ['BotsView', 'bots', 'Боты'],
    ['BroadcastView', 'broadcast', 'Рассылка'],
  ]) {
    assert.match(src(`src/components/hr/${view}.tsx`), /export const ready(: boolean)? = true/, `«${label}» готова`)
    assert.ok(hr.includes(`id: '${id}' as const, label: '${label}'`) && hr.includes(`tab === '${id}'`), `«${label}» подключена в src/pages/Hr.tsx`)
  }
})

/** Заявка для проверок фильтра без базы */
const make = (patch: Partial<HrApplication> = {}): HrApplication =>
  ({
    id: `A${Math.random().toString(36).slice(2, 9).toUpperCase()}`,
    createdAt: new Date().toISOString(),
    name: 'Проверка',
    phone: '+79000000000',
    contact: '',
    school: '',
    course: '',
    department: '',
    vacancyId: '',
    format: '',
    months: [],
    comment: '',
    game: { quizResult: null, conveyorBest: 0, activities: 0 },
    source: null,
    status: 'new',
    reached: [],
    duplicateOf: null,
    duplicates: 0,
    interview: null,
    assigneeId: null,
    ...patch,
  }) as HrApplication

test('фильтр «Задания»: 0, 1–3, 4 из 4 — в адресе, в отборе и в выгрузке, как строки «Задания и наём»', () => {
  const list = [0, 1, 3, 4, 7].map((n) => make({ channel: 'web', game: { quizResult: null, conveyorBest: 0, activities: n } }))
  const manual = make({ channel: 'hr' })
  const all = [...list, manual]
  assert.deepEqual(list.map(taskFilterOf), ['none', 'some', 'some', 'all', 'all'], 'больше четырёх — как 4 из 4')
  assert.equal(taskFilterOf(manual), null, 'добавленные HR — отдельной строкой, ни в один из трёх')
  for (const [bucket, count] of [['none', 1], ['some', 2], ['all', 2]] as const) {
    const f = paramsToFilter(new URLSearchParams(`tasks=${bucket}`))
    assert.equal(f.tasks, bucket)
    assert.equal(filterToParams(f).get('tasks'), bucket, 'фильтр возвращается в адрес как был')
    assert.equal(applyFilter(all, f).length, count, `задания ${bucket}`)
    // Число в списке совпадает со строкой блока «Задания и наём» в «Воронке»
    assert.equal(tasksHiring(all).rows.find((r) => r.bucket === bucket)?.applications, count, `«Задания и наём», строка ${bucket}`)
  }
  assert.deepEqual(all.map((a) => taskFilterOf(a) ?? 'hr'), all.map(taskBucketOf), 'те же строки, что в «Воронке»')
  for (const [old, now] of [['0', 'none'], ['1-3', 'some'], ['4', 'all']] as const)
    assert.equal(paramsToFilter(new URLSearchParams(`tasks=${old}`)).tasks, now, `старый адрес tasks=${old} открывается`)
  for (const bad of ['5', 'constructor', '__proto__', 'hr'])
    assert.equal(paramsToFilter(new URLSearchParams(`tasks=${bad}`)).tasks, undefined, `чужое значение «${bad}» отбрасывается`)
})

test('«Итог не отмечен»: прошедшее собеседование без явки и неявки', () => {
  const now = Date.now()
  const slot = (hoursFromNow: number, attended: '' | 'yes' | 'no' = '') => ({
    id: 1,
    startsAt: new Date(now + hoursFromNow * HOUR).toISOString(),
    address: 'Москва, ул. Рябиновая, 44',
    bring: '',
    attended,
    attendedAt: null,
    selfBooked: false,
  })
  const pending = make({ status: 'interview', interview: slot(-2) })
  const future = make({ status: 'interview', interview: slot(2) })
  const marked = make({ status: 'interview', interview: slot(-2, 'yes') })
  const hired = make({ status: 'hired', interview: slot(-2) })
  const noSlot = make({ status: 'interview' })
  const list = [pending, future, marked, hired, noSlot]
  assert.deepEqual(
    list.map((a) => attendancePending(a, now)),
    [true, false, false, false, false],
  )
  const f = paramsToFilter(new URLSearchParams('unmarked=1'))
  assert.equal(f.unmarked, true)
  assert.deepEqual(
    applyFilter(list, f, { now }).map((a) => a.id),
    [pending.id],
  )
})

test('поровну: 300 заявок на троих — по 100, порядок списка сохраняется', () => {
  const ids = Array.from({ length: 300 }, (_, i) => `A${i}`)
  const split = evenSplit(ids, [11, 22, 33])
  assert.deepEqual([...split.values()].map((l) => l.length), [100, 100, 100])
  assert.deepEqual(split.get(11)!.slice(0, 2), ['A0', 'A3'])
  const uneven = evenSplit(ids.slice(0, 7), [1, 2, 3])
  assert.deepEqual([...uneven.values()].map((l) => l.length), [3, 2, 2], 'разница не больше одной')
  assert.equal(evenSplit(ids, []).size, 0)
})

test('обзвон: список при старте, «12 из 47», повторный ответ по заявке не считается дважды', () => {
  const ids = Array.from({ length: 47 }, (_, i) => `B${i}`)
  let run = startCall([...ids, 'B0'])
  assert.equal(run.ids.length, 47, 'повторы в списке убраны')
  for (let i = 0; i < 11; i++) run = nextCall(run)!
  assert.deepEqual(callStats(run), { position: 12, total: 47, reached: 0, missed: 0, skipped: 0 })
  run = recordCall(run, 'B11', 'missed')
  run = recordCall(run, 'B11', 'reached')
  run = recordCall(run, 'B10', 'missed')
  assert.deepEqual(callStats(run), { position: 12, total: 47, reached: 1, missed: 1, skipped: 0 })
  assert.deepEqual(callStats(forgetCall(run, 'B10')), { position: 12, total: 47, reached: 1, missed: 0, skipped: 0 }, '«Отменить» убирает итог звонка')
  assert.equal(forgetCall(run, 'B30'), run, 'без итога — без изменений')
  let end = run
  while (nextCall(end)) end = nextCall(end)!
  assert.equal(callStats(end).position, 47)
  assert.equal(nextCall(end), null, 'после последней — конец обзвона')
})

test('обзвон пропускает заявки, которые изменили после старта', () => {
  const apps = Array.from({ length: 5 }, (_, i) => make({ id: `C${i}`, status: 'new', noAnswerCount: 0 }))
  let run = startCall(
    apps.map((a) => a.id),
    apps,
  )
  assert.equal(Object.keys(run.marks ?? {}).length, 5, 'отпечаток каждой заявки при старте')
  // Коллега дозвонился до C1, у C2 отметили недозвон, C3 обезличили; C4 не тронут
  const now = new Map(apps.map((a) => [a.id, { ...a }]))
  now.get('C1')!.status = 'contacted'
  now.get('C2')!.noAnswerCount = 1
  now.get('C3')!.anonymizedAt = new Date().toISOString()
  const changed = (id: string) => callChanged(run, id, now.get(id))
  assert.deepEqual(apps.map((a) => changed(a.id)), [false, true, true, true, false])
  run = nextCall(run, changed)!
  assert.equal(run.ids[run.pos], 'C4', 'три изменённые пропущены')
  assert.deepEqual(callStats(run), { position: 5, total: 5, reached: 0, missed: 0, skipped: 3 })
  assert.equal(nextCall(run, changed), null)
  assert.equal(callChanged(run, 'C1', undefined), true, 'заявка пропала из списка — пропускаем')
  assert.equal(callChanged({ ids: ['X'], pos: 0, outcomes: {} }, 'X', now.get('C1')), false, 'обзвон без отпечатков (старая вкладка) ничего не пропускает')

  // Текущую заявку изменили (видно по свежей карточке): пропуск и переход
  const fresh = startCall(['D1', 'D2'], [make({ id: 'D1' }), make({ id: 'D2' })])
  const step = skipCall(fresh)
  assert.equal(step.done, false)
  assert.equal(step.run.ids[step.run.pos], 'D2')
  assert.equal(callStats(step.run).skipped, 1)
  const last = skipCall(step.run)
  assert.equal(last.done, true, 'пропустили последнюю — обзвон закончен')
  assert.equal(callStats(last.run).skipped, 2)
})
