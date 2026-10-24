// «Воронка» до конца сезона (w2-hi-2) и цифры кейса рядом с цифрами компании (w2-hi-c2): «Отработали сезон» и «В штате
// или резерве» с долей от вышедших и по меткам, причины ухода, явка по прошедшим собеседованиям с отметкой, приглашения
// друзей (кто позвал, кого, вышел ли на смену), расход, «₽ за заявку», «₽ за выход на смену» и «Итого» — в отчёте,
// на листе «Воронка» и «Недели». Без реестра меток колонок расхода нет.
// Запуск: pnpm test w2-hr-insights (нужен PostgreSQL, база создаётся и удаляется сама)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { companyBaseline } from '../../shared/hr'
import { DEMO_ADMIN } from '../../server/auth/bootstrap'
import { createApp } from '../../server/app'
import type { Registry } from '../../server/channels/registry'
import { PostgresStorage, type Sql } from '../../server/db'
import { funnelReport, type SourceCosts } from '../../server/db/funnel'
import { WorkflowRepo } from '../../server/db/workflow'
import { buildWorkbook } from '../../server/export/xlsx'
import { unzip } from '../../server/export/xlsxWriter'
import { serverSettled, withTestDb } from './_db'

const HOUR = 3600e3
const DAY = 24 * HOUR
const noBots: Registry = { get: () => undefined, active: () => [], failed: () => [], start: () => {} }

type Seed = {
  id: string
  ago: number
  source?: string | null
  status?: string
  /** Этапы, которые заявка прошла после «Новая» */
  reached?: string[]
  outcome?: '' | 'completed' | 'left'
  leaveReason?: string
  reserve?: boolean
  interview?: { ago: number; attended: '' | 'yes' | 'no' }
  refCode?: string
  lastName?: string
  /** Возраст: дата рождения — ровно столько лет назад минус неделя */
  age?: number
}

const birthFor = (age: number) => {
  const d = new Date(Date.now() - 7 * DAY)
  d.setUTCFullYear(d.getUTCFullYear() - age)
  return d.toISOString().slice(0, 10)
}

async function insert(sql: Sql, s: Seed) {
  const created = Date.now() - s.ago
  const status = s.status ?? 'new'
  await sql`
    insert into applications (id, created_at, channel, name, last_name, phone, game, source, status, status_updated_at, vacancy_id, months,
                              ref_code, consent_at, consent_version, consent_source, season_outcome, season_leave_reason, reserve, birth_date)
    values (${s.id}, ${new Date(created)}, 'web', ${'Имя ' + s.id}, ${s.lastName ?? ''}, '', ${sql.json({ quizResult: null, conveyorBest: 0, activities: 1 })},
            ${s.source ?? null}, ${status}, ${new Date(created)}, 'bottling-operator', ${sql.json([6, 7])}, ${s.refCode ?? null},
            ${new Date(created)}, '1', 'site_form', ${s.outcome ?? ''}, ${s.leaveReason ?? ''}, ${s.reserve ?? false}, ${s.age ? birthFor(s.age) : null})`
  let prev = 'new'
  await sql`insert into application_history (application_id, created_at, user_name, to_status) values (${s.id}, ${new Date(created)}, 'Кандидат', 'new')`
  for (const [i, to] of (s.reached ?? []).entries()) {
    await sql`insert into application_history (application_id, created_at, user_name, from_status, to_status)
              values (${s.id}, ${new Date(created + (i + 1) * HOUR)}, 'HR', ${prev}, ${to})`
    prev = to
  }
  if (s.interview) await sql`insert into interviews (application_id, starts_at, attended) values (${s.id}, ${new Date(Date.now() - s.interview.ago)}, ${s.interview.attended})`
}

const toStart = ['contacted', 'interview', 'hired', 'started']

/**
 * Три вышедших на смену из ВКонтакте: двое отработали сезон (у одного — резерв), один ушёл: дорога.
 * Два вышедших с ярмарки МГУПП — расход 30 000 ₽. Приглашённая с сайта по коду B1 вышла на смену
 */
const seeds: Seed[] = [
  { id: 'V1', ago: 20 * DAY, source: 'vk-target', status: 'started', reached: toStart, outcome: 'completed', reserve: true, age: 19, interview: { ago: 18 * DAY, attended: 'yes' } },
  { id: 'V2', ago: 19 * DAY, source: 'vk-target', status: 'started', reached: toStart, outcome: 'completed', age: 21, interview: { ago: 17 * DAY, attended: 'yes' } },
  { id: 'V3', ago: 18 * DAY, source: 'vk-target', status: 'started', reached: toStart, outcome: 'left', leaveReason: 'commute', age: 23 },
  { id: 'V4', ago: 3 * DAY, source: 'vk-target' },
  { id: 'F1', ago: 16 * DAY, source: 'fair-mgupp', status: 'started', reached: toStart, age: 20, refCode: 'abc234', lastName: 'Ковалёва', interview: { ago: 14 * DAY, attended: 'yes' } },
  { id: 'F2', ago: 15 * DAY, source: 'fair-mgupp', status: 'started', reached: toStart },
  { id: 'F3', ago: 6 * DAY, source: 'fair-mgupp', status: 'declined', reached: ['contacted', 'interview', 'declined'], interview: { ago: 4 * DAY, attended: 'no' } },
  // Собеседование прошло, явку не отметили; ещё одно — впереди: в явку не входят
  { id: 'D1', ago: 5 * DAY, status: 'interview', reached: ['contacted', 'interview'], interview: { ago: 2 * DAY, attended: '' } },
  { id: 'D2', ago: 2 * DAY, status: 'interview', reached: ['contacted', 'interview'], interview: { ago: -2 * DAY, attended: '' } },
  // Пришла по ссылке F1 и вышла на смену; второй — по старой ссылке без кода
  { id: 'R1', ago: 10 * DAY, source: 'friend-abc234', status: 'started', reached: toStart, lastName: 'Орлова', age: 18 },
  { id: 'R2', ago: 9 * DAY, source: 'share', status: 'contacted', reached: ['contacted'] },
]

/** Расходы по меткам: одна запись — один момент оплаты. За любой период — сумма записей в нём, как у реестра */
const ledger = [
  { source: 'fair-mgupp', at: Date.now() - 16 * DAY, rub: 30000 },
  // Метка с расходом, но без заходов и заявок: её строка всё равно попадает в «Итого»
  { source: 'tg-ads', at: Date.now() - 12 * DAY, rub: 5000 },
]
const fakeCosts: SourceCosts = async (_sql, from, to) => {
  const out: Record<string, number> = {}
  for (const e of ledger) if (e.at >= from.getTime() && e.at < to.getTime()) out[e.source] = (out[e.source] ?? 0) + e.rub
  return out
}

/** Листы книги: имя → строки ячеек */
function readBook(file: Buffer) {
  const files = unzip(file)
  const text = (name: string) => files.get(name)?.toString('utf8') ?? ''
  const strings = [...text('xl/sharedStrings.xml').matchAll(/<si><t[^>]*>([\s\S]*?)<\/t><\/si>/g)].map((m) =>
    m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'),
  )
  const names = [...text('xl/workbook.xml').matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1])
  const sheets = new Map<string, (string | number | null)[][]>()
  names.forEach((name, i) => {
    const xml = text(`xl/worksheets/sheet${i + 1}.xml`)
    sheets.set(
      name,
      [...xml.matchAll(/<row r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)].map((r) => {
        const out: (string | number | null)[] = []
        for (const c of r[2].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>(?:<v>([^<]*)<\/v>)?<\/c>)/g)) {
          const col = [...c[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1
          out[col] = c[3] === undefined ? null : /t="s"/.test(c[2]) ? strings[Number(c[3])] : Number(c[3])
        }
        return out
      }),
    )
  })
  return { names, sheets }
}

test('воронка до конца сезона: итог сезона, уходы, явка, приглашения, расход, цифры кейса; Excel совпадает', async () => {
  await withTestDb('w2hri_funnel', async (sql) => {
    for (const s of seeds) await insert(sql, s)
    // Посетители сайта: 40 заходов с меткой ВКонтакте, 20 — с ярмарки
    for (let i = 0; i < 40; i++) await sql`insert into funnel_events (created_at, visitor, type, source) values (${new Date(Date.now() - 19 * DAY)}, ${'vk' + i}, 'visit', 'vk-target')`
    for (let i = 0; i < 20; i++) await sql`insert into funnel_events (created_at, visitor, type, source) values (${new Date(Date.now() - 15 * DAY)}, ${'f' + i}, 'visit', 'fair-mgupp')`

    const apps = await new WorkflowRepo(sql).list()
    const now = Date.now()
    const from = new Date(now - 30 * DAY)
    const to = new Date(now)
    const report = await funnelReport(sql, from, to, apps, now, { costs: fakeCosts })
    const row = (source: string) => report.rows.find((r) => r.source === source)!

    // «Отработали сезон» и «В штате или резерве» — по меткам, доля — от вышедших
    const vk = row('vk-target')
    assert.equal(vk.started, 3)
    assert.equal(vk.completed, 2)
    assert.equal(vk.stayed, 1)
    assert.equal(Math.round((vk.completed! / vk.started) * 100), 67, 'двое из трёх вышедших отработали сезон — 67 %')

    // Расход: 30 000 ₽ и два выхода — 15 000 ₽ за выход; метка без заявок — тоже строка
    const fair = row('fair-mgupp')
    assert.equal(fair.cost, 30000)
    assert.equal(fair.started, 2)
    assert.equal(fair.cost! / fair.started, 15000)
    assert.equal(fair.cost! / fair.applications, 10000, '₽ за заявку')
    assert.equal(row('tg-ads').cost, 5000)
    assert.equal(row('tg-ads').applications, 0)
    assert.equal(vk.cost, 0, 'у метки без расхода — 0, панель покажет «—»')
    assert.equal(report.costsKnown, true)
    assert.equal(report.rows.reduce((n, r) => n + (r.cost ?? 0), 0), 35000, '«Итого» расхода')

    // Причины ухода — рядом с причинами отказа
    assert.deepEqual(report.leaves, [{ reason: 'commute', label: 'Дорога', count: 1 }])

    // Явка: прошедшие собеседования с отметкой — V1, V2, F1 пришли, F3 нет; D1 без отметки; D2 ещё впереди
    assert.deepEqual(report.attendance, { came: 3, marked: 4, unmarked: 1 })

    // Приглашения: кто позвал, кого, дошли ли до смены. Дошедшие — первыми
    assert.equal(report.invites.length, 2)
    assert.deepEqual(report.invites[0], { id: 'R1', source: 'friend-abc234', inviter: 'Имя F1', invited: 'Имя R1 Орлова', status: 'started', started: true })
    assert.equal(report.invites[1].inviter, '', 'по старой ссылке пригласившего не найти')
    assert.equal(report.invites[1].started, false)

    // Цифры кейса по данным панели
    const m = report.caseMetrics
    assert.equal(m.visitors, 60)
    assert.equal(m.hired, 6)
    assert.equal(m.hireRate, 6 / 60)
    assert.deepEqual([m.completed, m.left], [2, 1])
    assert.equal(Math.round(m.dropout! * 100), 33)
    assert.equal(m.withAge, 5, 'у принятых с датой рождения: V1, V2, V3, F1, R1')
    assert.equal(m.averageAge, (19 + 21 + 23 + 20 + 18) / 5)
    assert.equal(companyBaseline.hireRate, 0.0002)
    assert.equal(companyBaseline.probationDropout, 0.38)
    assert.equal(companyBaseline.averageAge, 52)

    // Недели: итог сезона и расход сходятся с периодом
    const sum = (k: 'completed' | 'stayed' | 'cost') => report.weeks.reduce((n, w) => n + (w[k] ?? 0), 0)
    assert.equal(sum('completed'), 2 + 0)
    assert.equal(sum('stayed'), 1)
    assert.equal(sum('cost'), 35000, 'расход недель — тот же, что за период')

    // Excel: те же числа на листе «Воронка» и «Недели»
    const { sheets } = readBook(await buildWorkbook([], [], { title: 'Воронка за 30 дней', ...report }))
    const funnel = sheets.get('Воронка')!
    const head = funnel[2] as string[]
    const col = (label: string) => head.indexOf(label)
    for (const label of ['Отработали сезон', 'Отработали, % от вышедших', 'В штате или резерве', 'Расход, ₽', '₽ за заявку', '₽ за выход на смену'])
      assert.ok(col(label) > 0, `колонка «${label}»`)
    assert.ok(col('Отработали сезон') > col('Вышли на смену'), 'итог сезона — после «Вышли на смену»')
    const vkLine = funnel.find((r) => r[0] === 'ВКонтакте · target')!
    assert.equal(vkLine[col('Отработали сезон')], 2)
    assert.equal(Math.round((vkLine[col('Отработали, % от вышедших')] as number) * 100), 67)
    assert.equal(vkLine[col('В штате или резерве')], 1)
    assert.equal(vkLine[col('₽ за выход на смену')], null, 'без расхода — пусто')
    const fairLine = funnel.find((r) => r[0] === 'Ярмарка МГУПП')!
    assert.equal(fairLine[col('Расход, ₽')], 30000)
    assert.equal(fairLine[col('₽ за выход на смену')], 15000)
    assert.equal(fairLine[col('₽ за заявку')], 10000)
    const total = funnel.find((r) => r[0] === 'Итого')!
    assert.equal(total[col('Расход, ₽')], 35000)
    assert.equal(total[col('Отработали сезон')], 3 - 1, 'итог по всем меткам')
    assert.equal(total[col('Вышли на смену')], 6)
    const cells = funnel.flat().filter((v): v is string => typeof v === 'string')
    for (const label of ['Явка на собеседование', 'Почему отказ', 'Почему ушли до конца сезона', 'Дорога', 'Приглашения друзей', 'Сравнение с цифрами компании', 'Конверсия в найм', 'Средний возраст принятых'])
      assert.ok(cells.includes(label), `на листе «${label}»`)
    const attendance = funnel[funnel.findIndex((r) => r[0] === 'Явка на собеседование') + 2]
    assert.deepEqual(attendance.slice(0, 4), [3, 4, 0.75, 1])
    const invite = funnel.find((r) => r[2] === 'R1')!
    assert.deepEqual(invite.slice(0, 5), ['Имя F1', 'Имя R1 Орлова', 'R1', 'На смене', 'Да'])
    const age = funnel.find((r) => r[0] === 'Средний возраст принятых')!
    assert.deepEqual(age.slice(1, 3), [20.2, 52])
    const hire = funnel.find((r) => r[0] === 'Конверсия в найм')!
    assert.deepEqual(hire.slice(1, 3), ['10%', '0,02%'])

    const weeks = sheets.get('Недели')!
    const wHead = weeks[2] as string[]
    assert.ok(wHead.includes('Отработали сезон') && wHead.includes('Расход, ₽') && wHead.includes('₽ за выход на смену'))
    assert.deepEqual(wHead.slice(-2), ['Мест в плане сезона', 'Закрыто мест к концу недели'], 'план — по-прежнему в конце')
    const wTotal = weeks.at(-1)!
    assert.equal(wTotal[0], 'Итого')
    assert.equal(wTotal[wHead.indexOf('Расход, ₽')], 35000)
    assert.equal(wTotal[wHead.indexOf('Отработали сезон')], 2)
  })
})

test('период без расхода — «—», без реестра меток — без колонок расхода; ответ API с новыми разделами', async () => {
  await withTestDb('w2hri_nocost', async (sql) => {
    const storage = new PostgresStorage(sql)
    const app = await createApp({ storage, engine: null, bots: noBots, hrToken: '', env: { NODE_ENV: 'test' } })
    await serverSettled(sql)
    for (const s of seeds) await insert(sql, s)
    const apps = await new WorkflowRepo(sql).list()
    const now = Date.now()

    // Реестр есть, но за последние 5 дней расходов нет: колонки на месте, «₽ за выход» пусто
    const recent = await funnelReport(sql, new Date(now - 5 * DAY), new Date(now), apps, now, { costs: fakeCosts })
    assert.equal(recent.costsKnown, true)
    for (const r of recent.rows) assert.equal(r.cost, 0)
    const { sheets } = readBook(await buildWorkbook([], [], { title: 'Воронка', ...recent }))
    const head = sheets.get('Воронка')![2] as string[]
    const total = sheets.get('Воронка')!.find((r) => r[0] === 'Итого')!
    assert.equal(total[head.indexOf('₽ за выход на смену')], null)
    assert.equal(total[head.indexOf('₽ за заявку')], null)

    // Реестра нет: колонок расхода нет ни в отчёте, ни в Excel
    const none = await funnelReport(sql, new Date(now - 30 * DAY), new Date(now), apps, now, { costs: null })
    assert.equal(none.costsKnown, false)
    for (const r of none.rows) assert.ok(!('cost' in r))
    assert.ok(none.weeks.every((w) => w.cost === null))
    const book = readBook(await buildWorkbook([], [], { title: 'Воронка', ...none }))
    assert.ok(!(book.sheets.get('Воронка')![2] as string[]).includes('Расход, ₽'))
    assert.ok(!(book.sheets.get('Недели')![2] as string[]).includes('Расход, ₽'))

    // Выгрузка по фильтру: итог сезона, уходы и явка — по выгруженным заявкам
    const started = apps.filter((a) => a.source === 'vk-target')
    const filtered = readBook(
      await buildWorkbook(started, [], {
        title: 'Воронка по выгруженным заявкам: 4',
        rows: [{ source: 'vk-target', visitors: 0, tasks: 0, applyOpen: 0, applications: 4, interview: 3, hired: 3, started: 3 }],
        applicationsOnly: true,
      }),
    ).sheets.get('Воронка')!
    const fHead = filtered[2] as string[]
    const vk = filtered.find((r) => r[0] === 'ВКонтакте · target')!
    assert.equal(vk[fHead.indexOf('Отработали сезон')], 2)
    assert.equal(vk[fHead.indexOf('В штате или резерве')], 1)
    assert.ok(filtered.some((r) => r[0] === 'Дорога'), 'причина ухода')
    assert.deepEqual(filtered.find((r) => r[0] === 'Конверсия в найм')!.slice(1, 3), ['—', '0,02%'], 'без посещений конверсию не считаем')

    // API: новые разделы в ответе; без модуля реестра — без расходов
    const login = await app.request('/api/hr/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: DEMO_ADMIN.email, password: DEMO_ADMIN.password }),
    })
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
    const body = (await (await app.request('/api/hr/funnel', { headers: { cookie } })).json()) as Record<string, unknown>
    for (const k of ['leaves', 'attendance', 'invites', 'costsKnown', 'caseMetrics', 'rows', 'weeks', 'referrers']) assert.ok(k in body, `в ответе есть ${k}`)
    assert.deepEqual(body.attendance, { came: 3, marked: 4, unmarked: 1 })
  })
})
