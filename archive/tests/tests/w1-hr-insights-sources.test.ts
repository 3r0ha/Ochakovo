// «Воронка» без базы: названия источников, строки листа «Воронка», «Задания и наём», недели и медиана.
// Запуск: pnpm test w1-hr-insights

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyHrFields, type HrApplication } from '../../shared/applications'
import { describeSource, sourceName, taskBucketOf, tasksHiring, weekLabel } from '../../shared/hr'
import { applyFilter, stageCounts } from '../../shared/hrFilter'
import { median, weekBounds, weekStart, type FunnelRow } from '../../server/db/funnel'
import { funnelSourceLines } from '../../server/export/xlsx'

const DAY = 864e5

test('метки с приставкой площадки читаются по-русски, словарь и реестр важнее', () => {
  assert.equal(sourceName('fair-misis'), 'Ярмарка · misis')
  assert.equal(sourceName('vk-target'), 'ВКонтакте · target')
  assert.equal(sourceName('tg-studsovet'), 'Telegram · studsovet')
  assert.equal(sourceName('max-mgupp'), 'MAX · mgupp')
  assert.equal(sourceName('fair-mgupp'), 'Ярмарка МГУПП', 'встроенный словарь важнее разбора')
  assert.equal(sourceName('fair'), 'Ярмарка вакансий', 'ручной источник «Ярмарка вакансий»')
  assert.equal(sourceName('fair-misis', { 'fair-misis': 'Ярмарка НИТУ МИСИС' }), 'Ярмарка НИТУ МИСИС', 'название из реестра важнее')
  assert.equal(sourceName('telegram'), 'Telegram')
  assert.equal(sourceName(null), 'Прямой заход')
  assert.equal(describeSource('fair-').kind, 'unknown', 'одна приставка без площадки — незнакомая метка')
  assert.equal(describeSource('qr-stend').kind, 'unknown')
  assert.equal(describeSource('fair-misis').kind, 'prefix')
})

test('приглашения: с кодом и старые friend и share без кода', () => {
  assert.equal(describeSource('friend-abc234').kind, 'friend')
  for (const s of ['friend', 'share']) {
    const d = describeSource(s)
    assert.equal(d.kind, 'friend_legacy', s)
    assert.match(d.label, /без кода/, s)
  }
})

const row = (source: string, applications = 1, visitors = 3): FunnelRow => ({ source, visitors, tasks: 1, applyOpen: 0, applications, interview: 0, hired: 0, started: 0 })

test('лист «Воронка»: приглашения одной строкой, сырых меток нет, незнакомая подписана', () => {
  const lines = funnelSourceLines([row('fair-misis'), row('friend-abc234', 2), row('share'), row('friend'), row(''), row('telegram'), row('qr-stend')])
  const labels = lines.map((l) => l.label)
  assert.deepEqual(labels, ['Ярмарка · misis', 'Прямой заход на сайт', 'Telegram', 'Метка без названия: qr-stend', 'Приглашения друзей'])
  const friends = lines.find((l) => l.label === 'Приглашения друзей')!
  assert.equal(friends.row.applications, 4, 'старые friend и share тоже в «Приглашениях друзей»')
  assert.equal(lines.find((l) => l.unknown)?.label, 'Метка без названия: qr-stend')
  for (const raw of ['fair-misis', 'friend-abc234', 'share']) assert.ok(!labels.some((l) => l.includes(raw)), `нет сырой метки ${raw}`)
  // Метка из реестра «Источники» — под своим названием, как в «Воронке» панели
  const named = funnelSourceLines([row('qr-stend')], { 'qr-stend': 'Стенд на проходной' })
  assert.deepEqual(named.map((l) => [l.label, l.unknown]), [['Стенд на проходной', false]])
})

const app = (over: Partial<HrApplication>): HrApplication => ({
  id: Math.random().toString(36).slice(2, 10).toUpperCase(),
  createdAt: new Date().toISOString(),
  channel: 'web',
  name: 'Проверка',
  phone: '',
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

test('«Задания и наём»: строки 0, 1–3, 4 из 4, добавлены HR; сумма — плитка «Заявка»', () => {
  const apps = [
    app({ game: { quizResult: null, conveyorBest: 0, activities: 0 } }),
    app({ game: { quizResult: null, conveyorBest: 90, activities: 2 }, status: 'interview', reached: ['new', 'contacted', 'interview'] }),
    app({ game: { quizResult: null, conveyorBest: 90, activities: 4 }, status: 'started', reached: ['new', 'interview', 'hired', 'started'] }),
    app({ game: { quizResult: null, conveyorBest: 90, activities: 4 }, status: 'declined', declineReason: 'no_show', reached: ['new', 'interview', 'declined'] }),
    app({
      game: { quizResult: null, conveyorBest: 0, activities: 3 },
      status: 'interview',
      reached: ['new', 'interview'],
      interview: { id: 1, startsAt: new Date(Date.now() - DAY).toISOString(), address: '', bring: '', attended: 'no', attendedAt: null, selfBooked: false },
    }),
    app({ channel: 'hr', source: 'hh', status: 'contacted', reached: ['new', 'contacted'] }),
    app({ duplicateOf: 'X', game: { quizResult: null, conveyorBest: 0, activities: 4 } }),
  ]
  assert.equal(taskBucketOf(apps[5]), 'hr')
  const r = tasksHiring(apps)
  const by = Object.fromEntries(r.rows.map((x) => [x.bucket, x]))
  assert.deepEqual(r.rows.map((x) => x.bucket), ['none', 'some', 'all', 'hr'])
  assert.equal(by.none.applications, 1)
  assert.equal(by.some.applications, 2)
  assert.equal(by.all.applications, 2, 'дубль не считается')
  assert.equal(by.hr.applications, 1)
  assert.equal(by.all.noShow, 1, 'отказ «Неявка на собеседование»')
  assert.equal(by.some.noShow, 1, 'отметка «Неявка» у слота')
  assert.equal(by.all.started, 1)
  assert.equal(r.fullShare, 2 / 5, 'доля 4/4 — среди заявок кандидатов, без добавленных HR')
  const tile = stageCounts(applyFilter(apps, {}))
  assert.equal(r.rows.reduce((n, x) => n + x.applications, 0), tile.applications, 'сумма строк равна плитке «Заявка»')
  assert.equal(r.rows.reduce((n, x) => n + x.started, 0), tile.started)
  assert.equal(tasksHiring([app({ channel: 'hr' })]).fullShare, null, 'без заявок кандидатов доли нет')
})

test('недели: с понедельника по Москве, крайние обрезаны периодом, подпись без года', () => {
  const now = new Date()
  const start = weekStart(now)
  const msk = new Date(start.getTime() + 3 * 3600e3)
  assert.equal(msk.getUTCDay(), 1, 'понедельник')
  assert.equal(msk.getUTCHours(), 0, 'полночь по Москве')
  assert.ok(start <= now && now.getTime() - start.getTime() < 7 * DAY)

  const from = new Date(now.getTime() - 30 * DAY)
  const weeks = weekBounds(from, now)
  assert.equal(weeks[0].start.getTime(), from.getTime(), 'первая неделя начинается с начала периода')
  assert.equal(weeks.at(-1)!.end.getTime(), now.getTime(), 'последняя кончается концом периода')
  for (let i = 1; i < weeks.length; i++) assert.equal(weeks[i].start.getTime(), weeks[i - 1].end.getTime(), 'недели идут встык')
  assert.ok(weeks.length >= 5 && weeks.length <= 6)

  const label = weekLabel(weeks[1].start.toISOString(), weeks[1].end.toISOString())
  assert.match(label, /^\d{1,2}( [а-я]{3,4})?(–| – )\d{1,2} [а-я]{3,4}$/, label)
  assert.ok(!/\d{4}/.test(label), 'без года')
})

test('медиана как в PostgreSQL', () => {
  assert.equal(median([]), null)
  assert.equal(median([5]), 5)
  assert.equal(median([4, 1, 3]), 3)
  assert.equal(median([1, 2, 3, 10]), 2.5)
})
