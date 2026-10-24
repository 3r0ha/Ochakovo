// w2-hp-c2 и w2-hp-1, w2-hp-2, w2-hp-7: оформление после «Берём». Наставник и документы по практике,
// дата первой смены с напоминанием накануне (в бот, без бота — задача HR), при смене даты старое не уходит,
// «Неявка на первую смену», «Как подготовиться» и первая смена глазами кандидата, план найма по месяцу первой смены,
// сообщения заявке с сайта, привязанной к боту, и склейка дублей без потери привязки.
// Запуск: pnpm test w2-hr-pipeline-onboarding (нужен PostgreSQL, база создаётся и удаляется сама)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CONSENT_VERSION, declineReasonLabel, templateKeys, type HrApplication } from '../../shared/applications'
import { candidateStatus, firstShiftOf, prepareOf } from '../../shared/candidateStatus'
import { planProgress, seasonOf } from '../../shared/hrPlan'
import { defaultWorkSettings, mskParts, workdayAfter } from '../../shared/workdays'
import { createApp } from '../../server/app'
import { hashPassword } from '../../server/auth/password'
import type { Adapter, Registry } from '../../server/channels/registry'
import { normalizeApplication, PostgresStorage, type Sql } from '../../server/db'
import { HrRepo } from '../../server/db/hr'
import { REMIND_SHIFT_NOTE } from '../../server/db/workflow'
import type { OutMessage } from '../../server/dialog/types'
import { hrDeps, runDueJobs } from '../../server/jobs/scheduler'
import type { RateRule } from '../../server/middleware/rate-limit'
import { shiftReminderKey } from '../../server/notify'
import { serverSettled, withTestDb } from './_db'

process.env.HR_NOTIFY_DELAY_SECONDS = '0'

const password = 'проверка-пароля-1'
const rules: RateRule[] = [{ name: 'api', burst: 100000, perMinute: 100000, match: (_m, p) => p.startsWith('/api/') }]

type Details = { application: HrApplication; history: { kind: string; comment: string; notify: string | null; notifyDetail: string }[]; historyId: number | null; notify: { notify: string; detail: string } | null }

async function setup(sql: Sql) {
  const sent: { userId: string; messages: OutMessage[] }[] = []
  const fakeTelegram = { startPolling: async () => {}, handleWebhook: async () => {}, sendTo: async (userId: string, messages: OutMessage[]) => void sent.push({ userId, messages }) } as unknown as Adapter
  const bots: Registry = {
    get: (channel) => (channel === 'telegram' ? { adapter: fakeTelegram, secret: undefined } : undefined),
    active: () => ['telegram'],
    failed: () => [],
    start: () => {},
  }
  const storage = new PostgresStorage(sql)
  const repo = new HrRepo(sql)
  const admin = await repo.createUser({ email: 'admin@onboarding.test', name: 'Админ', role: 'admin', passwordHash: await hashPassword(password) })
  const app = await createApp({ storage, engine: null, bots, hrToken: '', env: { NODE_ENV: 'test', SITE_URL: 'https://season.example.ru' }, rateRules: rules })
  await serverSettled(sql)
  const login = await app.request('/api/hr/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: admin.email, password }) })
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { cookie, 'content-type': 'application/json', 'x-hr-request': '1' } })
  const patch = async (id: string, body: unknown) => {
    const res = await call('PATCH', `/api/hr/applications/${id}`, body)
    return { status: res.status, body: (await res.json()) as Details & { error?: string; message?: string } }
  }
  const details = async (id: string) => (await (await call('GET', `/api/hr/applications/${id}`)).json()) as Details
  let n = 0
  const candidate = (extra: Record<string, unknown> = {}) =>
    storage.saveApplication(normalizeApplication({ name: `Кандидат ${++n}`, phone: `+7903${String(2_000_000 + n).padStart(7, '0')}`, consent: true, consentVersion: CONSENT_VERSION, ...extra }))
  /** Довести заявку до «К оформлению» */
  const hire = async (id: string) => {
    assert.equal((await patch(id, { status: 'interview', withoutSlot: true })).status, 200)
    assert.equal((await patch(id, { status: 'hired' })).status, 200)
  }
  const deps = hrDeps(sql, bots, {})
  const runJobs = async () => {
    await sql`update jobs set run_at = now() where status = 'pending'`
    return runDueJobs(deps, 100)
  }
  return { storage, call, patch, details, candidate, hire, runJobs, sent, admin }
}

/** Рабочий день через n дней, 8:00 по Москве — начало дневной смены */
const shiftDay = (n: number) => new Date(`${mskParts(workdayAfter(n, 10, Date.now(), defaultWorkSettings)).day}T08:00:00+03:00`).toISOString()

test('контракты: шаблоны первой смены и причина «Неявка на первую смену»', () => {
  assert.ok(templateKeys.some((t) => t.id === 'shift_reminder'))
  assert.ok(templateKeys.some((t) => t.id === 'sms_shift_reminder'))
  assert.equal(declineReasonLabel('no_show_shift'), 'Неявка на первую смену')
  for (const t of templateKeys) assert.ok(!/!|…/.test(t.label + t.hint), t.label)
})

test('первая смена и «Как подготовиться» глазами кандидата', () => {
  const base = { id: 'X1', statusUpdatedAt: new Date().toISOString(), createdAt: new Date().toISOString(), vacancyId: 'bottling-operator', interview: null, reached: [] }
  // Дата от HR
  const at = new Date(shiftDay(5))
  const dated = firstShiftOf({ status: 'hired', firstShiftAt: at.toISOString(), shiftKind: 'day' })!
  assert.equal(dated.at, at.toISOString())
  assert.match(dated.text, /, с 8:00, дневная смена$/)
  assert.ok(dated.text.includes(at.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long' })))
  // Без даты — по месяцам из заявки, а «С определённого месяца» важнее
  assert.deepEqual(firstShiftOf({ status: 'contacted', months: [8, 7] }), { at: null, text: 'не раньше июля' })
  assert.deepEqual(firstShiftOf({ status: 'contacted', months: [6, 7], startReady: 'month', startMonth: 8 }), { at: null, text: 'не раньше августа' })
  assert.equal(firstShiftOf({ status: 'new' })!.text, 'срок обсудят на собеседовании')
  assert.equal(firstShiftOf({ status: 'hired' })!.text, 'дату назовёт HR')
  assert.deepEqual(firstShiftOf({ status: 'started', months: [7] }), { at: null, text: 'уже позади' }, 'на смене без даты — не «не раньше июля»')
  assert.equal(firstShiftOf({ status: 'declined', months: [7] }), null)

  // «Как подготовиться»: нет при «Новой», есть при «Собеседовании» и «К оформлению»
  assert.equal(candidateStatus({ ...base, status: 'new' }).prepare, null)
  const interview = candidateStatus({ ...base, status: 'interview', months: [7, 8] })
  assert.ok(interview.prepare)
  assert.ok(interview.prepare.items.some((i) => i.includes('паспорт, СНИЛС') && i.includes('Точный список назовёт HR')))
  assert.equal(interview.firstShift?.text, 'не раньше июля')
  const hired = candidateStatus({ ...base, status: 'hired' })
  assert.ok(hired.prepare?.items[0].includes('медосмотр за счёт компании'))
  // Медкнижка — только у вакансий рядом с продуктом; оператор розлива — да, практика в офисе — нет
  assert.ok(prepareOf({ status: 'interview', vacancyId: 'bottling-operator' })!.items.some((i) => i.includes('медицинская книжка')))
  assert.ok(!prepareOf({ status: 'interview', vacancyId: 'marketing-intern' })!.items.some((i) => i.includes('медицинская книжка')))
  // Иностранцу — что HR скажет про документы; практике от вуза — Учебный центр, кабинет 525
  assert.ok(prepareOf({ status: 'hired', vacancyId: 'store-worker', citizenship: 'eaeu' })!.items.some((i) => i.includes('HR скажет')))
  assert.ok(prepareOf({ status: 'hired', vacancyId: 'store-worker', practiceSchool: true })!.items.some((i) => i.includes('кабинет 525')))
  assert.ok(!prepareOf({ status: 'hired', vacancyId: 'store-worker' })!.items.some((i) => i.includes('кабинет 525')))
  for (const s of [interview, hired]) for (const i of s.prepare!.items) assert.ok(!/!|…|не\s+\S+,\s+а\s/.test(i), i)
})

test('наставник и документы по практике: в карточке, с историей; первая смена с напоминанием накануне в бот', async () => {
  await withTestDb('w2hp-onboard', async (sql) => {
    const { patch, details, candidate, hire, runJobs, sent } = await setup(sql)
    const a = await candidate({ channel: 'telegram', channelUserId: 'tg-100', consentSource: 'telegram', vacancyId: 'lab-chemist', practiceSchool: true })
    await hire(a.id)

    const mentor = await patch(a.id, { profile: { mentorName: 'Ольга Петрова', practiceDocs: ['contract', 'order'] } })
    assert.equal(mentor.status, 200)
    assert.equal(mentor.body.application.mentorName, 'Ольга Петрова')
    assert.deepEqual(mentor.body.application.practiceDocs, ['contract', 'order'])
    const docs = await patch(a.id, { profile: { practiceDocs: ['contract', 'order', 'diary'] } })
    assert.equal(docs.body.history.at(-1)?.comment, 'Документы по практике: договор, приказ, дневник')

    const first = shiftDay(4)
    const set = await patch(a.id, { onboarding: { onboardingAt: shiftDay(2), firstShiftAt: first, shiftKind: 'day', onboardingNote: 'Медкомиссия в 9:00' } })
    assert.equal(set.status, 200, JSON.stringify(set.body).slice(0, 200))
    assert.equal(set.body.application.firstShiftAt, first)
    assert.equal(set.body.application.shiftKind, 'day')
    assert.equal(set.body.application.onboardingNote, 'Медкомиссия в 9:00')
    const log = set.body.history.at(-1)!
    assert.equal(log.kind, 'onboarding')
    assert.match(log.comment, /^Первая смена: .+, с 8:00, дневная смена$/)
    const [job] = await sql<{ dedupe_key: string; status: string }[]>`select dedupe_key, status from jobs where kind = 'shift_reminder'`
    assert.equal(job.dedupe_key, shiftReminderKey(a.id, first))
    assert.equal(job.status, 'pending')

    // Дату перенесли — старое напоминание отменено, новое в очереди
    const moved = shiftDay(6)
    await patch(a.id, { onboarding: { firstShiftAt: moved } })
    const jobs = await sql<{ dedupe_key: string; status: string }[]>`select dedupe_key, status from jobs where kind = 'shift_reminder' order by id`
    assert.deepEqual(jobs.map((j) => j.status), ['cancelled', 'pending'])
    assert.equal(jobs[1].dedupe_key, shiftReminderKey(a.id, moved))

    // Накануне: напоминание уходит в бот, в истории видна отправка
    sent.length = 0
    await runJobs()
    const reminder = sent.find((s) => s.userId === 'tg-100' && s.messages[0].text.includes('первая смена'))
    assert.ok(reminder, 'напоминание ушло в Telegram')
    assert.ok(reminder.messages[0].text.includes('Рябиновая, 44'))
    assert.ok(reminder.messages[0].text.includes('8 800 100-77-77'), 'телефон отдела подбора — из справочника студента')
    const history = (await details(a.id)).history
    const entry = history.find((h) => h.comment === 'Напоминание о первой смене')
    assert.equal(entry?.notify, 'sent')
  })
})

test('напоминание не уходит, если статус или дата сменились; без бота — задача HR «Напомнить о первой смене»; неявка на смену', async () => {
  await withTestDb('w2hp-shift-guard', async (sql) => {
    const { patch, candidate, hire, runJobs, sent } = await setup(sql)
    const a = await candidate({ channel: 'telegram', channelUserId: 'tg-200', consentSource: 'telegram' })
    await hire(a.id)
    await patch(a.id, { onboarding: { firstShiftAt: shiftDay(4), shiftKind: 'night' } })
    // Не пришёл на первую смену — отказ с причиной; напоминание отменяется
    const noShow = await patch(a.id, { status: 'declined', declineReason: 'no_show_shift' })
    assert.equal(noShow.body.application.declineReason, 'no_show_shift')
    const [job] = await sql<{ status: string }[]>`select status from jobs where kind = 'shift_reminder'`
    assert.equal(job.status, 'cancelled', 'ушёл со статуса — задача снята')
    // Даже если задачу вернули в очередь вручную, проверка перед отправкой не пустит
    await sql`update jobs set status = 'pending' where kind = 'shift_reminder'`
    sent.length = 0
    await runJobs()
    assert.equal(sent.filter((s) => s.userId === 'tg-200' && s.messages[0].text.includes('первая смена')).length, 0, 'отказ — напоминания нет')
    const [done] = await sql<{ status: string }[]>`select status from jobs where kind = 'shift_reminder'`
    assert.equal(done.status, 'cancelled')

    // Заявка с сайта без бота и без SMS: задача HR на предыдущий рабочий день
    const web = await candidate()
    await hire(web.id)
    const set = await patch(web.id, { onboarding: { firstShiftAt: shiftDay(5) } })
    assert.equal(set.body.application.callbackNote, REMIND_SHIFT_NOTE)
    assert.ok(set.body.application.callbackAt)
    assert.ok(new Date(set.body.application.callbackAt!).getTime() < new Date(shiftDay(5)).getTime())
    assert.equal((await sql`select 1 from jobs where kind = 'shift_reminder' and payload ->> 'applicationId' = ${web.id}`).length, 0)

    // Опечатка в дате — 422
    const bad = await patch(web.id, { onboarding: { firstShiftAt: 'завтра' } })
    assert.equal(bad.status, 422)
    const far = await patch(web.id, { onboarding: { firstShiftAt: new Date(Date.now() + 500 * 864e5).toISOString() } })
    assert.equal(far.status, 422)
  })
})

test('заявка с сайта, привязанная к боту: сообщения HR уходят в бот, склейка дублей привязку не теряет', async () => {
  await withTestDb('w2hp-linked', async (sql) => {
    const { patch, candidate, call, runJobs, sent } = await setup(sql)
    const web = await candidate({ phone: '+79035550001' })
    await sql`update applications set bot_channel = 'telegram', bot_user_id = 'tg-linked' where id = ${web.id}`
    const invite = await patch(web.id, { status: 'interview', withoutSlot: true })
    assert.equal(invite.body.notify?.notify, 'queued', 'в очередь бота, а не звонок')
    assert.match(invite.body.notify!.detail, /Telegram/)
    sent.length = 0
    await runJobs()
    assert.ok(sent.some((s) => s.userId === 'tg-linked'))

    // Дубль с тем же телефоном без привязки — основная: склеиваем, привязка переходит
    const dup = await candidate({ phone: '+79035550001' })
    const merged = await call('POST', `/api/hr/applications/${web.id}/merge`, { into: dup.id })
    assert.equal(merged.status, 200)
    const main = ((await merged.json()) as { application: HrApplication }).application
    assert.equal(main.id, dup.id)
    assert.equal(main.botChannel, 'telegram')
    assert.equal(main.botUserId, 'tg-linked')
    assert.equal(main.channel, 'web', 'канал заявки не меняется')
  })
})

test('план найма: с датой первой смены человек закрывает только её месяц, без даты — месяцы из заявки', () => {
  const season = seasonOf(Date.now())
  const created = new Date().toISOString()
  const july = `${season}-07-15T05:00:00.000Z`
  const base = { duplicateOf: null, anonymizedAt: null, createdAt: created, vacancyId: 'bottling-operator', status: 'hired', reached: ['hired'] } as unknown as HrApplication
  const withShift = { ...base, id: 'A', months: [3, 4, 5, 6, 7], firstShiftAt: july } as HrApplication
  const noShift = { ...base, id: 'B', months: [3, 7], firstShiftAt: null } as HrApplication
  const cells = planProgress(
    [
      { vacancyId: 'bottling-operator', month: 3, target: 5 },
      { vacancyId: 'bottling-operator', month: 7, target: 5 },
    ],
    [withShift, noShift],
    season,
  )
  assert.equal(cells.find((c) => c.month === 3)!.hired, 1, 'март закрывает только тот, у кого нет даты')
  assert.equal(cells.find((c) => c.month === 7)!.hired, 2)
  assert.equal(mskParts(new Date(july)).day.slice(5, 7), '07')
})
