// «Заявки.xlsx»: лист «Воронка» с названиями источников, «Заданиями и наймом» и «Каким заданием ведёт к заявке»,
// лист «Недели» с итогом, равным сумме недель; тот же файл уходит на Яндекс Диск.
// Запуск: pnpm test w1-hr-insights (проверка выгрузки на Диск — на временной базе PostgreSQL)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyHrFields, type HrApplication } from '../../shared/applications'
import { pickColumns } from '../../shared/hr'
import { HrRepo, type FunnelReport } from '../../server/db/hr'
import { seedDemo } from '../../server/db/demo'
import { WorkflowRepo } from '../../server/db/workflow'
import { buildWorkbook } from '../../server/export/xlsx'
import { unzip } from '../../server/export/xlsxWriter'
import { syncNow } from '../../server/integrations/sync'
import { withTestDb } from './_db'

/** Листы книги: имя → строки ячеек (строки — как текст, числа — числами) */
function readBook(file: Buffer) {
  const files = unzip(file)
  const text = (name: string) => files.get(name)?.toString('utf8') ?? ''
  const strings = [...text('xl/sharedStrings.xml').matchAll(/<si><t[^>]*>([\s\S]*?)<\/t><\/si>/g)].map((m) =>
    m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'),
  )
  const names = [...text('xl/workbook.xml').matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1])
  const sheets = new Map<string, { rows: (string | number | null)[][]; xml: string }>()
  names.forEach((name, i) => {
    const xml = text(`xl/worksheets/sheet${i + 1}.xml`)
    const rows = [...xml.matchAll(/<row r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)].map((r) => {
      const out: (string | number | null)[] = []
      for (const c of r[2].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>(?:<v>([^<]*)<\/v>)?<\/c>)/g)) {
        const col = [...c[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1
        out[col] = c[3] === undefined ? null : /t="s"/.test(c[2]) ? strings[Number(c[3])] : Number(c[3])
      }
      return out
    })
    sheets.set(name, { rows, xml })
  })
  return { names, sheets }
}

const app = (over: Partial<HrApplication>): HrApplication => ({
  id: Math.random().toString(36).slice(2, 10).toUpperCase(),
  createdAt: new Date().toISOString(),
  channel: 'web',
  name: 'Анна',
  phone: '+79161234567',
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
  ...emptyHrFields(),
  status: 'new',
  ...over,
})

const now = Date.now()
const report: FunnelReport = {
  rows: [
    { source: 'fair-misis', visitors: 10, tasks: 6, applyOpen: 3, applications: 2, interview: 1, hired: 1, started: 1 },
    { source: 'friend-abc234', visitors: 3, tasks: 2, applyOpen: 1, applications: 1, interview: 0, hired: 0, started: 0 },
    { source: 'share', visitors: 0, tasks: 0, applyOpen: 0, applications: 1, interview: 0, hired: 0, started: 0 },
    { source: 'qr-stend', visitors: 4, tasks: 1, applyOpen: 0, applications: 0, interview: 0, hired: 0, started: 0 },
    { source: '', visitors: 20, tasks: 5, applyOpen: 2, applications: 1, interview: 1, hired: 0, started: 0 },
  ],
  declines: [{ reason: 'schedule', label: 'Не совпал график', count: 1 }],
  // Разделы второй волны — пустые: эта проверка о первой волне
  leaves: [],
  attendance: { came: 0, marked: 0, unmarked: 0 },
  invites: [],
  costsKnown: false,
  game: null,
  caseMetrics: { visitors: 37, hired: 1, hireRate: 1 / 37, completed: 0, left: 0, dropout: null, withAge: 0, averageAge: null },
  firstResponseHours: 6,
  answered24h: 0.8,
  tasks: {
    rows: [
      { bucket: 'none', applications: 1, interview: 0, noShow: 0, hired: 0, started: 0 },
      { bucket: 'some', applications: 2, interview: 1, noShow: 1, hired: 0, started: 0 },
      { bucket: 'all', applications: 1, interview: 1, noShow: 0, hired: 1, started: 1 },
      { bucket: 'hr', applications: 1, interview: 0, noShow: 0, hired: 0, started: 0 },
    ],
    fullShare: 0.25,
    target: 0.3,
    leads: [
      { task: 'game', visitors: 5, applied: 2 },
      { task: 'money', visitors: 4, applied: 1 },
      { task: 'quiz', visitors: 3, applied: 1 },
      { task: 'myth', visitors: 2, applied: 0 },
      { task: 'none', visitors: 20, applied: 1 },
    ],
  },
  weeks: [
    {
      start: new Date(now - 10 * 864e5).toISOString(),
      end: new Date(now - 5 * 864e5).toISOString(),
      applications: 3,
      interview: 2,
      hired: 1,
      started: 1,
      firstResponseHours: 4,
      answered24h: 1,
      declined: 1,
      declines: { schedule: 1 },
      planTarget: 10,
      planDone: 1,
    },
    {
      start: new Date(now - 5 * 864e5).toISOString(),
      end: new Date(now).toISOString(),
      applications: 2,
      interview: 0,
      hired: 0,
      started: 0,
      firstResponseHours: null,
      answered24h: null,
      declined: 0,
      declines: {},
      planTarget: 10,
      planDone: 1,
    },
  ],
}

test('лист «Воронка»: названия вместо меток, задания и наём, связь заданий с заявкой', async () => {
  const file = await buildWorkbook([app({})], pickColumns(), { title: 'Воронка за всё время', ...report })
  const { names, sheets } = readBook(file)
  assert.deepEqual(names, ['Заявки', 'Воронка', 'Недели'])
  const funnel = sheets.get('Воронка')!
  const cells = funnel.rows.flat().filter((v): v is string => typeof v === 'string')
  for (const label of ['Ярмарка · misis', 'Приглашения друзей', 'Прямой заход на сайт', 'Метка без названия: qr-stend', 'Задания и наём', 'Доля заявок со «Сменой 4/4»', '4 из 4', 'Добавлены HR', 'Неявка', '% до смены', 'Какое задание ведёт к заявке', 'Поймай брак', 'Без заданий'])
    assert.ok(cells.includes(label), `на листе есть «${label}»`)
  for (const raw of ['fair-misis', 'friend-abc234', 'share']) assert.ok(!cells.includes(raw), `нет сырой метки ${raw}`)
  assert.ok(cells.some((c) => c.includes('связь, без доказательства причины')))

  const friends = funnel.rows.find((r) => r[0] === 'Приглашения друзей')!
  assert.equal(friends[3], 2, 'заявка по коду и по старой метке share — в одной строке')
  const total = funnel.rows.find((r) => r[0] === 'Итого')!
  assert.equal(total[3], 5)
  const tasksTotal = funnel.rows.filter((r) => r[0] === 'Итого')[1]
  assert.equal(tasksTotal[1], total[3], '«Задания и наём»: итог равен заявкам воронки')
  const share = funnel.rows.find((r) => r[0] === 'Доля заявок со «Сменой 4/4»')!
  assert.deepEqual(share.slice(1, 4), [0.25, 'цель', 0.3])

  // Автофильтр — только по таблице источников, блоки ниже не прячутся. Колонок 13: вторая волна добавила итог сезона
  const itogo = funnel.rows.findIndex((r) => r[0] === 'Итого') + 1
  assert.match(funnel.xml, new RegExp(`<autoFilter ref="A3:M${itogo}"/>`))
})

test('лист «Недели»: итог — сумма недель, отказы по причинам, план и факт', async () => {
  const file = await buildWorkbook([app({})], pickColumns(), { title: 'Воронка за всё время', ...report })
  const weeks = readBook(file).sheets.get('Недели')!
  const head = weeks.rows[2] as string[]
  assert.deepEqual(head.slice(0, 8), ['Неделя', 'Заявки', 'Первый ответ, ч (медиана)', 'Ответ за 24 ч', 'Собеседование', 'К оформлению', 'На смене', 'Отказы'])
  assert.ok(head.includes('Отказ: Не совпал график'))
  assert.deepEqual(head.slice(-2), ['Мест в плане сезона', 'Закрыто мест к концу недели'])
  const body = weeks.rows.slice(3)
  assert.equal(body.length, 3, 'две недели и итог')
  const total = body.at(-1)!
  assert.equal(total[0], 'Итого')
  for (const col of [1, 4, 5, 6, 7]) assert.equal(total[col], (body[0][col] as number) + (body[1][col] as number), `колонка ${head[col]}`)
  assert.equal(total[2], 6, 'медиана первого ответа — за весь период')
  assert.deepEqual(total.slice(-2), [10, 1], 'план и факт — на конец периода')
  assert.ok(!weeks.rows.flat().some((v) => typeof v === 'string' && /\+7|Анна/.test(v)), 'без личных данных')
})

test('выгрузка по фильтру: задания и наём по выгруженным заявкам, без листа «Недели»', async () => {
  const list = [
    app({ game: { quizResult: null, conveyorBest: 50, activities: 4 }, status: 'started', reached: ['new', 'interview', 'hired', 'started'] }),
    app({ channel: 'hr', source: 'hh' }),
  ]
  const file = await buildWorkbook(list, pickColumns(), {
    title: 'Воронка по выгруженным заявкам: 2',
    rows: [{ source: 'hh', visitors: 0, tasks: 0, applyOpen: 0, applications: 1, interview: 0, hired: 0, started: 0 }],
    applicationsOnly: true,
  })
  const { names, sheets } = readBook(file)
  assert.deepEqual(names, ['Заявки', 'Воронка'])
  const rows = sheets.get('Воронка')!.rows
  assert.equal(rows.find((r) => r[0] === '4 из 4')?.[1], 1)
  assert.equal(rows.find((r) => r[0] === 'Добавлены HR')?.[1], 1)
  assert.ok(!rows.some((r) => r[0] === 'Какое задание ведёт к заявке'), 'события сайта к отобранным заявкам не привязать')
})

test('Яндекс Диск: «Заявки.xlsx» с листами «Воронка» и «Недели»', async () => {
  await withTestDb('w1hri_xlsx', async (sql) => {
    await sql`insert into hr_users (email, name, role, password_hash) values ('olga@ochakovo.local', 'Ольга Смирнова', 'admin', 'x')`
    await seedDemo(sql, 24)
    let uploaded: Buffer | null = null
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/resources/upload')) return Response.json({ href: 'https://disk.test/put', method: 'PUT' })
      if (url.pathname === '/put') {
        uploaded = Buffer.from(init!.body as Uint8Array)
        return new Response(null, { status: 201 })
      }
      if (url.pathname.endsWith('/resources') && (init?.method ?? 'GET') === 'GET') return new Response(null, { status: 404 })
      return new Response(null, { status: 201 })
    }) as typeof fetch
    const repo = new HrRepo(sql)
    const r = await syncNow({ sql, repo, workflow: new WorkflowRepo(sql), env: { YANDEX_DISK_TOKEN: 'x' }, disk: { apiBase: 'https://disk.test/v1/disk', fetch: fakeFetch } })
    assert.ok(r.ok, JSON.stringify(r))
    const book = readBook(uploaded!)
    assert.deepEqual(book.names, ['Заявки', 'Воронка', 'Недели'])
    const weeks = book.sheets.get('Недели')!.rows
    const total = weeks.at(-1)!
    assert.equal(total[0], 'Итого')
    assert.equal(total[1], 26, 'все заявки за всё время — в итоге недель')
    assert.ok(weeks.length - 4 <= 5, 'период «за всё время» начинается с недели первой заявки')
  })
})
