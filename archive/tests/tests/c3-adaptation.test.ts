// «Как дела на смене» (shared/adaptation.ts, server/adaptation): вопросы новичку после первой смены, через неделю и через месяц.
// Расписание и окна вопросов, бот на PostgreSQL (вопрос из очереди → «Тяжело» → причина → задача HR), страница «Моя заявка»
// по ключу браузера, отметка со слов кандидата в HR-панели, отмена вопросов после ухода, статистика для «Воронки».
// Время — от текущего момента. Запуск: pnpm test c3-adaptation (часть с PostgreSQL создаёт и удаляет свою базу)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  adaptationStats,
  CHECKIN_CALL_NOTE,
  CHECKIN_CALL_TEXT,
  checkinAnchor,
  checkinAskNote,
  checkinDeadline,
  checkinHardNote,
  checkinHardReply,
  checkinReasons,
  checkinSteps,
  checkinTime,
  dueCheckin,
  hardSignal,
  type Checkin,
} from '../../shared/adaptation'
import { CONSENT_VERSION, emptyHrFields, type HrApplication } from '../../shared/applications'
import { applyFilter, builtInViews, filterToParams, paramsToFilter } from '../../shared/hrFilter'
import { handbookText } from '../../shared/content/handbook'
import { mskAt, mskParts } from '../../shared/workdays'
import { createApp } from '../../server/app'
import { createAssistant } from '../../server/assistant/assistant'
import { hashPassword } from '../../server/auth/password'
import type { Adapter, Registry } from '../../server/channels/registry'
import { normalizeApplication, PostgresStorage } from '../../server/db'
import { HrRepo } from '../../server/db/hr'
import { WorkflowRepo } from '../../server/db/workflow'
import { createEngine } from '../../server/dialog/engine'
import { memoryStorage } from '../../server/dialog/storage'
import type { Button, DialogReply, DialogUser, OutMessage } from '../../server/dialog/types'
import { hrDeps, runDueJobs } from '../../server/jobs/scheduler'
import { offlineProvider } from '../../server/llm/offline'
import type { RateRule } from '../../server/middleware/rate-limit'
import { serverSettled, withTestDb } from './_db'

process.env.HR_NOTIFY_DELAY_SECONDS = '0'

const SITE = 'https://season.example.ru'
const DAY = 864e5
const assistant = createAssistant({ provider: offlineProvider(), log: () => {} })
const birth = (years: number) => new Date(Date.now() - years * 365.25 * DAY).toISOString().slice(0, 10)
const textOf = (r: DialogReply | OutMessage[]) => ('messages' in r ? r.messages : r).map((m) => m.text).join('\n\n')
const buttonsOf = (r: DialogReply | OutMessage[]): Button[] => ('messages' in r ? r.messages : r).flatMap((m) => (m.buttons ?? []).flat())
const actions = (r: DialogReply | OutMessage[]) => buttonsOf(r).flatMap((b) => (b.kind === 'action' ? [b.action] : []))
/** Первая смена в 8:00 по Москве n дней назад */
const shiftDaysAgo = (n: number) => mskAt(mskParts(Date.now() - n * DAY).day, 8).toISOString()

const app = (over: Partial<HrApplication> = {}): HrApplication =>
  ({ id: 'T1', createdAt: new Date().toISOString(), status: 'hired', statusUpdatedAt: new Date().toISOString(), ...emptyHrFields(), ...over }) as HrApplication
const answered = (step: Checkin['step'], answer: Checkin['answer'], reason: Checkin['reason'] = '', at = new Date().toISOString()): Checkin => ({
  step,
  askedAt: at,
  askedVia: 'bot',
  answer,
  reason,
  answeredAt: answer ? at : null,
  answeredVia: answer ? 'telegram' : '',
})

test('расписание: 18:00 по Москве на следующий день, через неделю и через месяц; окна не пересекаются', () => {
  const anchor = '2030-03-04T05:00:00.000Z' // 8:00 по Москве
  const at = (step: Checkin['step']) => checkinTime(anchor, step).toISOString()
  assert.equal(at('shift1'), '2030-03-05T15:00:00.000Z')
  assert.equal(at('week1'), '2030-03-11T15:00:00.000Z')
  assert.equal(at('month1'), '2030-04-03T15:00:00.000Z')
  assert.equal(checkinDeadline(anchor, 'shift1').toISOString(), at('week1'))
  assert.equal(checkinDeadline(anchor, 'week1').toISOString(), at('month1'))
  assert.equal(checkinDeadline(anchor, 'month1').getTime() - checkinTime(anchor, 'month1').getTime(), 14 * DAY)
  // Ночная смена с 20:00: день тот же, вопрос — на следующий день в 18:00
  assert.equal(checkinTime('2030-03-04T17:00:00.000Z', 'shift1').toISOString(), at('shift1'))

  // От чего считать: дата первой смены; без неё у «На смене» — когда отметили «Первая смена отработана»
  assert.equal(checkinAnchor(app({ firstShiftAt: anchor })), anchor)
  assert.equal(checkinAnchor(app({ status: 'hired' })), null)
  assert.equal(checkinAnchor(app({ status: 'started', statusUpdatedAt: anchor })), anchor)
  assert.equal(checkinAnchor(app({ status: 'interview', firstShiftAt: anchor })), null)

  const t = (iso: string) => Date.parse(iso)
  const a = app({ firstShiftAt: anchor })
  assert.equal(dueCheckin(a, t('2030-03-05T14:00:00Z')), null, 'до 18:00 следующего дня — рано')
  assert.equal(dueCheckin(a, t('2030-03-06T10:00:00Z')), 'shift1')
  assert.equal(dueCheckin(a, t('2030-03-12T10:00:00Z')), 'week1', 'после первой недели — уже второй вопрос')
  assert.equal(dueCheckin({ ...a, checkins: [answered('week1', 'ok')] }, t('2030-03-12T10:00:00Z')), null, 'на этот шаг уже ответили')
  assert.equal(dueCheckin({ ...a, seasonOutcome: 'left' }, t('2030-03-12T10:00:00Z')), null, 'ушёл до конца сезона — не спрашиваем')
  assert.equal(dueCheckin(a, t('2030-04-20T10:00:00Z')), null, 'через две недели после последнего вопроса — всё')
})

test('ответы: «Тяжело» — факт из справочника студента и звонок HR; метка в списке; статистика для «Воронки»', () => {
  for (const r of checkinReasons) {
    const reply = checkinHardReply(r.id)
    assert.ok(reply.endsWith(CHECKIN_CALL_TEXT), r.id)
    assert.ok(!/!|\.\.\.|…|не\s+\S+,\s+а\s/.test(reply + r.label), r.id)
  }
  assert.ok(checkinHardReply('study').startsWith(handbookText('exams')))
  assert.ok(checkinHardReply('money').startsWith(handbookText('payday')))
  assert.ok(checkinHardReply('commute').includes('«Озёрная»') && checkinHardReply('commute').includes('3 400 ₽'))
  assert.equal(checkinHardReply('team'), CHECKIN_CALL_TEXT)
  assert.equal(checkinHardNote('week1', 'schedule'), 'Через неделю новичку тяжело: график и ночные смены. Поговорить')
  assert.equal(checkinSteps.length, 3)

  const hard = app({ status: 'started', checkins: [answered('shift1', 'ok', '', '2030-01-01T10:00:00Z'), answered('week1', 'hard', 'money', '2030-01-07T10:00:00Z')] })
  assert.equal(hardSignal(hard)?.reason, 'money')
  assert.equal(hardSignal({ ...hard, seasonOutcome: 'completed' }), null, 'итог сезона отмечен — метки нет')
  assert.equal(hardSignal({ ...hard, checkins: [...hard.checkins, answered('month1', 'ok', '', '2030-01-30T10:00:00Z')] }), null, 'потом стало нормально')

  const stats = adaptationStats([
    { ...hard, seasonOutcome: 'left' },
    app({ status: 'started', seasonOutcome: 'completed', checkins: [answered('shift1', 'ok'), answered('week1', 'question')] }),
    app({ status: 'started', checkins: [answered('shift1', '')] }),
    app({ duplicateOf: 'X', checkins: [answered('shift1', 'hard', 'work')] }),
  ])
  assert.deepEqual(
    stats.steps.map((s) => [s.id, s.asked, s.answered, s.ok, s.question, s.hard]),
    [
      ['shift1', 3, 2, 2, 0, 0],
      ['week1', 2, 2, 0, 1, 1],
      ['month1', 0, 0, 0, 0, 0],
    ],
  )
  assert.deepEqual(stats.reasons, [{ id: 'money', label: 'Деньги', count: 1 }])

  // Фильтр и готовый вид «Тяжело на смене»: только те, кому тяжело сейчас; фильтр живёт в адресе страницы
  const list = [{ ...hard, id: 'H1' }, { ...hard, id: 'H2', seasonOutcome: 'completed' as const }, app({ id: 'OK1', status: 'started', checkins: [answered('shift1', 'ok')] })]
  assert.deepEqual(applyFilter(list, { hardShift: true }).map((a) => a.id), ['H1'])
  const params = filterToParams({ hardShift: true })
  assert.equal(params.get('hard'), '1')
  assert.equal(paramsToFilter(params).hardShift, true)
  assert.ok(builtInViews.some((v) => v.name === 'Тяжело на смене' && v.filter.hardShift))
  assert.deepEqual(stats.afterHard, { left: 1, total: 1 })
  assert.deepEqual(stats.afterOk, { left: 0, total: 1 })
})

test('в памяти (симулятор бота): ответ не сохранить — честно отправляем к HR', async () => {
  const engine = createEngine(memoryStorage(), { siteUrl: SITE, assistant })
  const r = await engine.handle({ channel: 'telegram', id: 'mem-1' }, { type: 'action', action: 'ci:shift1:ok' })
  assert.match(textOf(r), /^Ответ здесь не сохранится\. Расскажи отделу персонала: /)
})

test('PostgreSQL: бот, «Моя заявка», HR-панель и отмена после ухода', async () => {
  await withTestDb('c3-adaptation', async (sql) => {
    // Только вопросы «Как дела на смене»: сообщения о статусе бот шлёт своим порядком
    const sent: { userId: string; messages: OutMessage[] }[] = []
    const adapter = {
      startPolling: async () => {},
      handleWebhook: async () => {},
      sendTo: async (userId: string, messages: OutMessage[]) => void (actions(messages).some((x) => x.startsWith('ci:')) && sent.push({ userId, messages })),
    } as unknown as Adapter
    const bots: Registry = { get: (c) => (c === 'telegram' ? { adapter, secret: undefined } : undefined), active: () => ['telegram'], failed: () => [], start: () => {} }
    const rules: RateRule[] = [{ name: 'api', burst: 100000, perMinute: 100000, match: (_m, p) => p.startsWith('/api/') }]
    const storage = new PostgresStorage(sql)
    const repo = new HrRepo(sql)
    const workflow = new WorkflowRepo(sql)
    await repo.createUser({ email: 'admin@checkin.test', name: 'Админ', role: 'admin', passwordHash: await hashPassword('проверка-пароля-1') })
    const server = await createApp({ storage, engine: null, bots, hrToken: '', env: { NODE_ENV: 'test', SITE_URL: SITE }, rateRules: rules })
    await serverSettled(sql)
    const engine = createEngine(storage, { siteUrl: SITE, assistant })
    const deps = hrDeps(sql, bots, {})
    const login = await server.request('/api/hr/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@checkin.test', password: 'проверка-пароля-1' }) })
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
    const hr = async (id: string, body: unknown) => {
      const res = await server.request(`/api/hr/applications/${id}`, { method: 'PATCH', body: JSON.stringify(body), headers: { cookie, 'content-type': 'application/json', 'x-hr-request': '1' } })
      assert.equal(res.status, 200, await res.clone().text())
    }
    const get = async (id: string) => (await workflow.get(id))!
    const history = async (id: string) => (await sql<{ kind: string; comment: string; user_name: string }[]>`select kind, comment, user_name from application_history where application_id = ${id} order by id`)
    const jobs = (id: string) => sql<{ status: string; run_at: Date; payload: { step: string } }[]>`
      select status, run_at, payload from jobs where kind = 'checkin' and payload ->> 'applicationId' = ${id} order by run_at`
    const input = (extra: Record<string, unknown>) =>
      normalizeApplication({ name: 'Саша', lastName: 'Новикова', phone: '+7 495 300-00-71', birthDate: birth(19), school: 'МГУПП', startReady: 'now', consent: true, consentVersion: CONSENT_VERSION, ...extra })

    // ── Бот: первая смена три дня назад ────────────────────────────────
    const a = await storage.saveApplication(input({ channel: 'telegram', channelUserId: 'tg-701', consentSource: 'telegram' }))
    const u: DialogUser = { channel: 'telegram', id: 'tg-701' }
    await hr(a.id, { status: 'hired' })
    assert.equal((await jobs(a.id)).length, 0, 'без даты первой смены вопросов нет')
    await hr(a.id, { onboarding: { firstShiftAt: shiftDaysAgo(3), shiftKind: 'day' } })
    const planned = await jobs(a.id)
    assert.deepEqual(planned.map((j) => [j.payload.step, j.status]), [
      ['shift1', 'pending'],
      ['week1', 'pending'],
      ['month1', 'pending'],
    ])
    assert.ok(planned[0].run_at.getTime() <= Date.now() + 1000, 'первый вопрос опоздал — уходит сразу')

    await runDueJobs(deps, 100)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].userId, 'tg-701')
    assert.match(textOf(sent[0].messages), /^\*\*Как прошла первая смена\?\*\*\nОтвет увидит отдел персонала/)
    assert.deepEqual(actions(sent[0].messages), ['ci:shift1:ok', 'ci:shift1:question', 'ci:shift1:hard'])
    assert.ok((await history(a.id)).some((h) => h.kind === 'checkin' && h.comment === 'Вопрос в Telegram: «Как прошла первая смена?»'))
    assert.equal((await get(a.id)).checkins[0].askedVia, 'bot')

    // Не ответил сразу — вопрос есть в «Моей заявке» и открывается снова
    const before = await engine.handle(u, { type: 'action', action: 'm:status' })
    assert.ok(buttonsOf(before).some((b) => b.kind === 'action' && b.action === 'ci:shift1:ask' && b.text === 'Как прошла первая смена?'), actions(before).join(' '))
    assert.deepEqual(actions(await engine.handle(u, { type: 'action', action: 'ci:shift1:ask' })), ['ci:shift1:ok', 'ci:shift1:question', 'ci:shift1:hard'])

    // «Тяжело» — сразу задача HR; причина вторым нажатием меняет только текст задачи
    const hard = await engine.handle(u, { type: 'action', action: 'ci:shift1:hard' })
    assert.equal(textOf(hard), '**Что тяжелее всего?**')
    assert.equal(actions(hard).filter((x) => x.startsWith('ci:shift1:r:')).length, checkinReasons.length)
    let saved = await get(a.id)
    assert.equal(saved.callbackNote, checkinHardNote('shift1', ''))
    assert.ok(saved.callbackAt)
    const why = await engine.handle(u, { type: 'action', action: 'ci:shift1:r:study' })
    assert.equal(textOf(why), checkinHardReply('study'))
    saved = await get(a.id)
    assert.equal(saved.callbackNote, 'После первой смены новичку тяжело: учёба. Поговорить')
    assert.deepEqual(saved.checkins.map((c) => [c.step, c.answer, c.reason, c.answeredVia]), [['shift1', 'hard', 'study', 'telegram']])
    assert.equal(hardSignal(saved)?.reason, 'study')
    const h = await history(a.id)
    assert.equal(h.filter((x) => x.kind === 'callback').length, 1, 'вторая задача не появилась')
    assert.ok(h.some((x) => x.user_name === 'Кандидат' && x.comment === 'После первой смены: тяжело — учёба (в Telegram)'))
    // Повтор той же кнопки ничего не дублирует
    await engine.handle(u, { type: 'action', action: 'ci:shift1:r:study' })
    assert.equal((await history(a.id)).length, h.length)

    // «Моя заявка» в боте: «Пусть HR позвонит»; звонок уже стоит — текст задачи не затирается
    const status = await engine.handle(u, { type: 'action', action: 'm:status' })
    assert.ok(actions(status).includes('ci:call'), actions(status).join(' '))
    assert.ok(!actions(status).some((x) => /^ci:\w+:ask$/.test(x)), `на вопрос уже ответили: ${actions(status).join(' ')}`)
    const call = await engine.handle(u, { type: 'action', action: 'ci:call' })
    assert.equal(textOf(call), CHECKIN_CALL_TEXT)
    assert.equal((await get(a.id)).callbackNote, 'После первой смены новичку тяжело: учёба. Поговорить')

    // Ушёл до конца сезона — оставшиеся вопросы не уходят
    await hr(a.id, { status: 'started' })
    await hr(a.id, { season: { seasonOutcome: 'left', seasonLeaveReason: 'study' } })
    await sql`update jobs set run_at = now() where kind = 'checkin' and status = 'pending' and payload ->> 'applicationId' = ${a.id}`
    await runDueJobs(deps, 100)
    assert.equal(sent.length, 1, 'после ухода вопросов нет')
    assert.deepEqual((await jobs(a.id)).map((j) => j.status).filter((s) => s === 'pending'), [])
    assert.match(textOf(await engine.handle(u, { type: 'action', action: 'ci:week1:ok' })), /^Вопросы о первых неделях уже не актуальны/)

    // ── Сайт без бота: первая смена восемь дней назад ──────────────────
    const w = await storage.saveApplication(input({ channel: 'web', phone: '+7 495 300-00-72', consentSource: 'site_form' }))
    const token = w.statusToken!
    await hr(w.id, { status: 'hired' })
    await hr(w.id, { onboarding: { firstShiftAt: shiftDaysAgo(8), shiftKind: 'day' } })
    assert.deepEqual((await jobs(w.id)).filter((j) => j.status === 'pending').map((j) => j.payload.step), ['week1', 'month1'], 'первый вопрос устарел')
    await runDueJobs(deps, 100)
    assert.equal(sent.length, 1, 'бота нет — в бот ничего не ушло')
    assert.equal((await get(w.id)).callbackNote, checkinAskNote('week1'), 'HR спросит при звонке')

    const site = (path: string, init: RequestInit = {}, key = token) =>
      server.request(`/api/applications/${w.id}${path}`, { ...init, headers: { 'x-status-token': key, 'content-type': 'application/json', ...(init.headers ?? {}) } })
    const view = (await (await site('/checkin')).json()) as { step: string; question: string; call: boolean; last: unknown }
    assert.deepEqual(view, { step: 'week1', question: 'Неделя на заводе позади. Как ты?', last: null, call: true })
    assert.equal((await site('/checkin', {}, 'x'.repeat(32))).status, 404)
    assert.equal((await site('/checkin', { method: 'POST', body: JSON.stringify({ step: 'week1', answer: 'maybe' }) })).status, 422)
    const ok = await site('/checkin', { method: 'POST', body: JSON.stringify({ step: 'week1', answer: 'ok' }) })
    assert.equal(ok.status, 200)
    assert.equal(((await ok.json()) as { view: { step: string | null } }).view.step, null)
    saved = await get(w.id)
    assert.equal(saved.callbackAt, null, 'ответ на странице снял задачу спросить при звонке')
    assert.deepEqual(saved.checkins.map((c) => [c.step, c.askedVia, c.answer, c.answeredVia]), [['week1', 'call', 'ok', 'site']])

    const first = (await (await site('/checkin/call', { method: 'POST', body: '{}' })).json()) as { reply: string; repeated: boolean }
    assert.deepEqual(first, { reply: CHECKIN_CALL_TEXT, repeated: false })
    assert.equal((await get(w.id)).callbackNote, CHECKIN_CALL_NOTE)
    assert.equal(((await (await site('/checkin/call', { method: 'POST', body: '{}' })).json()) as { repeated: boolean }).repeated, true)

    // HR отмечает ответ со слов кандидата
    await hr(w.id, { checkin: { step: 'shift1', answer: 'hard', reason: 'commute' } })
    saved = await get(w.id)
    assert.deepEqual(saved.checkins.find((c) => c.step === 'shift1')!.answeredVia, 'hr')
    assert.ok((await history(w.id)).some((x) => x.user_name === 'Админ' && x.comment === 'После первой смены: тяжело — дорога (со слов кандидата)'))
    assert.equal((await get(w.id)).callbackNote, CHECKIN_CALL_NOTE, 'ответ со слов кандидата новую задачу не ставит')
    const bad = await server.request(`/api/hr/applications/${w.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ checkin: { step: 'year1', answer: 'ok' } }),
      headers: { cookie, 'content-type': 'application/json', 'x-hr-request': '1' },
    })
    assert.equal(bad.status, 422)

    // Статистика по базе: две заявки, у одной уход после «Тяжело»
    const stats = adaptationStats(await workflow.list())
    assert.deepEqual(stats.afterHard, { left: 1, total: 1 })
    assert.deepEqual(stats.steps.find((s) => s.id === 'shift1'), { id: 'shift1', label: 'После первой смены', asked: 2, answered: 2, ok: 0, question: 0, hard: 2 })
  })
})
