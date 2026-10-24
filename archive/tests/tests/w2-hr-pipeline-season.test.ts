// w2-hp-3…6: итог сезона и резерв, практика от вуза и «хочет остаться», согласие в HR, пара по приглашению.
// Итог сезона — только у «На смене», при уходе со статуса очищается, отмена возвращает; массово; кандидат отметок не видит.
// Фильтры «Причина отказа», «Практика от вуза», «Хочет остаться», «Формат», «Идут вдвоём», вид «Резерв» — в адресе и выгрузке.
// Свод учебных заведений с нормализацией названий. Согласие: где, версия, когда; без согласия — приглашение только с подтверждением.
// Запуск: pnpm test w2-hr-pipeline-season (нужен PostgreSQL, база создаётся и удаляется сама)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CONSENT_VERSION, type HrApplication } from '../../shared/applications'
import { applyFilter, builtInViews, filterToParams, inReserve, pairIds, paramsToFilter } from '../../shared/hrFilter'
import { schoolKey, schoolSummary, seasonOf } from '../../shared/hrPlan'
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

type Details = {
  application: HrApplication
  history: { id: number; kind: string; comment: string }[]
  historyId: number | null
  invitedBy: { name: string | null; applicationId: string | null } | null
  invited: { id: string; name: string; status: string }[]
}

async function setup(sql: Sql) {
  const storage = new PostgresStorage(sql)
  const repo = new HrRepo(sql)
  const admin = await repo.createUser({ email: 'admin@season.test', name: 'Админ', role: 'admin', passwordHash: await hashPassword(password) })
  const app = await createApp({ storage, engine: null, bots: noBots, hrToken: '', env: { NODE_ENV: 'test', SITE_URL: 'https://season.example.ru' }, rateRules: rules })
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
  const list = async () => (await (await call('GET', '/api/hr/applications')).json()) as HrApplication[]
  let n = 0
  const candidate = (extra: Record<string, unknown> = {}) =>
    storage.saveApplication(normalizeApplication({ name: `Кандидат ${++n}`, phone: `+7904${String(3_000_000 + n).padStart(7, '0')}`, consent: true, consentVersion: CONSENT_VERSION, ...extra }))
  const toStarted = async (id: string) => {
    for (const status of ['interview', 'hired', 'started']) assert.equal((await patch(id, { status, withoutSlot: true })).status, 200, status)
  }
  return { storage, call, patch, details, list, candidate, toStarted }
}

test('итог сезона: только у «На смене», уход — с причиной, при уходе со статуса очищается, отмена возвращает', async () => {
  await withTestDb('w2hp-season', async (sql) => {
    const { patch, candidate, toStarted, call } = await setup(sql)
    const fresh = await candidate()
    const early = await patch(fresh.id, { season: { seasonOutcome: 'completed' } })
    assert.equal(early.status, 422, 'до смены — нельзя')

    const a = await candidate()
    await toStarted(a.id)
    const noReason = await patch(a.id, { season: { seasonOutcome: 'left' } })
    assert.equal(noReason.status, 422, 'уход без причины')
    const left = await patch(a.id, { season: { seasonOutcome: 'left', seasonLeaveReason: 'study', reserve: true } })
    assert.equal(left.status, 200)
    assert.equal(left.body.application.seasonOutcome, 'left')
    assert.equal(left.body.application.seasonLeaveReason, 'study')
    assert.equal(left.body.application.reserve, true)
    assert.equal(left.body.history.at(-1)?.kind, 'season')
    assert.equal(left.body.history.at(-1)?.comment, 'Уход до конца сезона: учёба. Звать в штат или в резерв')
    // «Сезон отработан» — причина ухода снимается
    const done = await patch(a.id, { season: { seasonOutcome: 'completed' } })
    assert.equal(done.body.application.seasonLeaveReason, '')

    // Ушли со статуса «На смене» — итог очищается, отметка резерва остаётся; «Отменить» возвращает итог
    const back = await patch(a.id, { status: 'hired' })
    assert.equal(back.body.application.seasonOutcome, '')
    assert.equal(back.body.application.reserve, true)
    const undo = await call('POST', '/api/hr/undo', { historyIds: [back.body.historyId] })
    const restored = ((await undo.json()) as { results: { application: HrApplication }[] }).results[0].application
    assert.equal(restored.status, 'started')
    assert.equal(restored.seasonOutcome, 'completed')

    // Массово: у «На смене» ставится, остальные — в ошибках с причиной
    const b = await candidate()
    await toStarted(b.id)
    const c = await candidate()
    const bulk = await call('POST', '/api/hr/bulk', { ids: [a.id, b.id, c.id], action: 'season', season: { seasonOutcome: 'completed' } })
    const out = (await bulk.json()) as { done: { id: string }[]; failed: { id: string; error: string }[] }
    assert.deepEqual(out.done.map((d) => d.id).sort(), [a.id, b.id].sort())
    assert.equal(out.failed[0].id, c.id)
    assert.match(out.failed[0].error, /на смене/)
  })
})

test('кандидат отметок итога сезона и резерва не видит: «Моя заявка» и бот прежние', async () => {
  await withTestDb('w2hp-season-candidate', async (sql) => {
    const { patch, candidate, toStarted, storage } = await setup(sql)
    const a = await candidate()
    await toStarted(a.id)
    const before = await storage.statusForToken(a.id, a.statusToken!)
    await patch(a.id, { season: { seasonOutcome: 'left', seasonLeaveReason: 'money', reserve: true } })
    const after = await storage.statusForToken(a.id, a.statusToken!)
    assert.deepEqual(after, before, 'статус для кандидата не изменился')
    const text = JSON.stringify(after)
    for (const word of ['reserve', 'резерв', 'season', 'Деньги', 'Уход']) assert.ok(!text.includes(word), word)
  })
})

test('вид «Резерв» и фильтр «Причина отказа»: в адресе, списке и выгрузке; «Вернуть в работу» без сообщения', async () => {
  await withTestDb('w2hp-reserve', async (sql) => {
    const { patch, candidate, toStarted, list, call } = await setup(sql)
    const noSlots = await candidate()
    await patch(noSlots.id, { status: 'declined', declineReason: 'no_slots' })
    const schedule = await candidate()
    await patch(schedule.id, { status: 'declined', declineReason: 'schedule' })
    const docs = await candidate()
    await patch(docs.id, { status: 'declined', declineReason: 'documents' })
    const stay = await candidate({ wantsToStay: true })
    const marked = await candidate()
    await toStarted(marked.id)
    await patch(marked.id, { season: { reserve: true } })
    const erased = await candidate({ wantsToStay: true })
    await sql`update applications set anonymized_at = now(), anonymized_reason = 'retention' where id = ${erased.id}`
    await candidate()

    const all = await list()
    const reserve = applyFilter(all, { reserve: true }).map((a) => a.id)
    assert.deepEqual(reserve.sort(), [noSlots.id, schedule.id, stay.id, marked.id].sort(), 'без обезличенных, без отказа «документы»')
    assert.ok(builtInViews.some((v) => v.name === 'Резерв' && v.filter.reserve))
    assert.equal(inReserve({ ...all.find((a) => a.id === docs.id)! }), false)

    const f = paramsToFilter(new URLSearchParams('reasons=no_slots,schedule,нет&reserve=1'))
    assert.deepEqual(f, { declineReasons: ['no_slots', 'schedule'], reserve: true })
    assert.equal(filterToParams(f).toString(), 'reasons=no_slots%2Cschedule&reserve=1')
    assert.deepEqual(applyFilter(all, { declineReasons: ['no_slots', 'documents'] }).map((a) => a.id).sort(), [noSlots.id, docs.id].sort())
    const exported = (await (await call('POST', '/api/hr/export', { format: 'json', query: 'reasons=schedule' })).json()) as unknown[]
    assert.equal(exported.length, 1)

    // «Вернуть в работу»: статус «Связались», причина отказа сброшена, сообщения кандидату нет
    const back = await patch(noSlots.id, { status: 'contacted' })
    assert.equal(back.body.application.status, 'contacted')
    assert.equal(back.body.application.declineReason, '')
    assert.equal(back.body.application.reserve, false)
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from jobs where kind = 'notify' and payload ->> 'applicationId' = ${noSlots.id}`
    const declineMessages = (await sql<{ notify: string | null }[]>`select notify from application_history where application_id = ${noSlots.id} and to_status = 'contacted'`)[0]
    assert.equal(declineMessages.notify, null, 'возврат без уведомления')
    assert.ok(n <= 1, 'сообщение было только об отказе')
  })
})

test('практика от вуза, «хочет остаться», формат: фильтры и метки; свод учебных заведений с нормализацией', async () => {
  await withTestDb('w2hp-practice', async (sql) => {
    const { candidate, list, call } = await setup(sql)
    const a = await candidate({ practiceSchool: true, school: 'РХТУ им. Д. И. Менделеева', vacancyId: 'lab-chemist', months: [6, 7] })
    const b = await candidate({ practiceSchool: true, school: '«рхту»', vacancyId: 'bottling-operator', months: [7, 8] })
    await candidate({ school: 'Российский химико-технологический университет имени Менделеева', vacancyId: 'storekeeper', months: [8] })
    const d = await candidate({ practiceSchool: true, school: '', vacancyId: 'marketing-intern' })
    const e = await candidate({ wantsToStay: true, vacancyId: 'store-worker', notStudying: true, months: [6] })
    const all = await list()

    assert.deepEqual(applyFilter(all, { practice: true }).map((x) => x.id).sort(), [a.id, b.id, d.id].sort())
    assert.deepEqual(applyFilter(all, { stay: true }).map((x) => x.id), [e.id])
    assert.deepEqual(applyFilter(all, { format: 'Постоянная работа' }).map((x) => x.id), [e.id], 'формат — по вакансии, если в заявке пусто')
    assert.deepEqual(applyFilter(all, { format: 'Бесплатная практика' }).map((x) => x.id), [d.id])
    const f = paramsToFilter(new URLSearchParams('practice=1&stay=1&format=Оплачиваемая практика'))
    assert.deepEqual(f, { practice: true, stay: true, format: 'Оплачиваемая практика' })
    assert.deepEqual(paramsToFilter(filterToParams(f)), f)
    const exported = (await (await call('POST', '/api/hr/export', { format: 'json', query: 'practice=1' })).json()) as unknown[]
    assert.equal(exported.length, 3)

    assert.equal(schoolKey('РХТУ им. Д. И. Менделеева').title, 'РХТУ им. Менделеева')
    assert.equal(schoolKey('  колледж  № 32 ').key, schoolKey('Колледж № 32').key)
    const rows = schoolSummary(all, seasonOf(Date.now()))
    const rhtu = rows.find((r) => r.title === 'РХТУ им. Менделеева')!
    assert.equal(rhtu.ids.length, 3, 'три написания — один вуз')
    assert.deepEqual(rhtu.months, [6, 7, 8])
    assert.equal(rows.at(-1)!.title, null, '«Учёба не указана» — последней строкой')
    assert.deepEqual(rows.at(-1)!.ids, [d.id])
    assert.ok(!rows.some((r) => r.ids.includes(e.id)), 'постоянная работа без практики в свод не входит')
  })
})

test('согласие в HR: где, версия, когда; без согласия пригласить — только с подтверждением; «получено устно» — с именем', async () => {
  await withTestDb('w2hp-consent', async (sql) => {
    const { patch, candidate, call, details } = await setup(sql)
    const site = await candidate()
    const card = (await details(site.id)).application
    assert.equal(card.consentSource, 'site_form')
    assert.equal(card.consentVersion, CONSENT_VERSION)
    assert.ok(card.consentAt)

    const add = await call('POST', '/api/hr/applications', { name: 'Рекомендация', phone: '+79045550001', source: 'employee', consentBasis: 'none' })
    const manual = ((await add.json()) as { application: HrApplication }).application
    assert.equal(manual.consentSource, 'none')
    const invite = await patch(manual.id, { status: 'interview', withoutSlot: true })
    assert.equal(invite.status, 422)
    assert.equal(invite.body.error, 'no_consent')
    const bulk = await call('POST', '/api/hr/bulk', { ids: [manual.id, site.id], action: 'status', status: 'interview', withoutSlot: true })
    assert.equal(bulk.status, 422)
    assert.deepEqual(((await bulk.json()) as { ids: string[] }).ids, [manual.id])
    // «Связались» без подтверждения можно: запрет только на приглашение
    assert.equal((await patch(manual.id, { status: 'contacted' })).status, 200)
    const confirmed = await patch(manual.id, { status: 'interview', withoutSlot: true, allowNoConsent: true })
    assert.equal(confirmed.status, 200)

    // Согласие получено при звонке — отметка с именем сотрудника и временем
    const other = await call('POST', '/api/hr/applications', { name: 'Устно', phone: '+79045550002', source: 'employee', consentBasis: 'none' })
    const later = ((await other.json()) as { application: HrApplication }).application
    const verbal = await patch(later.id, { consent: 'hr_verbal' })
    assert.equal(verbal.status, 200)
    assert.equal(verbal.body.application.consentSource, 'hr_verbal')
    assert.equal(verbal.body.application.consentBy, 'Админ')
    assert.ok(verbal.body.application.consentAt)
    assert.equal(verbal.body.history.at(-1)?.comment, 'Согласие получено устно')
    assert.equal((await patch(site.id, { consent: 'hr_verbal' })).status, 422, 'согласие с сайта не переписываем')
    // С отметкой в том же запросе пригласить можно сразу
    const third = ((await (await call('POST', '/api/hr/applications', { name: 'Сразу', phone: '+79045550003', source: 'phone', consentBasis: 'none' })).json()) as { application: HrApplication }).application
    assert.equal((await patch(third.id, { consent: 'hr_verbal', status: 'interview', withoutSlot: true })).status, 200)
  })
})

test('пара по приглашению: «По приглашению» и «Приглашённые» в обеих карточках, фильтр «Идут вдвоём», своя ссылка не в счёт', async () => {
  await withTestDb('w2hp-pair', async (sql) => {
    const { candidate, details, list } = await setup(sql)
    const inviter = await candidate({ name: 'Аня', lastName: 'Кузнецова', refCode: 'abc234' })
    const friend = await candidate({ name: 'Борис', source: 'friend-abc234', refCode: 'xyz789' })
    const self = await candidate({ name: 'Свой', source: 'friend-qwe456', refCode: 'qwe456' })
    // Пригласивший из бота: код в сессии, у самого — заявка из бота
    await sql`insert into sessions (channel, user_id, data) values ('telegram', 'tg-ref', ${sql.json({ data: { ref: 'bot777' } })})`
    const botInviter = await candidate({ name: 'Вера', channel: 'telegram', channelUserId: 'tg-ref', consentSource: 'telegram' })
    const botFriend = await candidate({ name: 'Глеб', source: 'friend-bot777' })
    await candidate({ name: 'Одиночка' })

    const friendCard = await details(friend.id)
    assert.equal(friendCard.invitedBy?.applicationId, inviter.id)
    assert.equal(friendCard.invitedBy?.name, 'Кузнецова Аня', 'как в списке: фамилия, имя')
    const inviterCard = await details(inviter.id)
    assert.deepEqual(inviterCard.invited.map((i) => [i.id, i.name, i.status]), [[friend.id, 'Борис', 'new']])
    assert.equal((await details(self.id)).invitedBy, null, 'своя ссылка — не приглашение')
    assert.equal((await details(botFriend.id)).invitedBy?.applicationId, botInviter.id)
    assert.deepEqual((await details(botInviter.id)).invited.map((i) => i.id), [botFriend.id])

    const all = await list()
    assert.deepEqual([...pairIds(all)].sort(), [inviter.id, friend.id, botInviter.id, botFriend.id].sort())
    assert.deepEqual(applyFilter(all, paramsToFilter(new URLSearchParams('pair=1'))).map((a) => a.id).sort(), [inviter.id, friend.id, botInviter.id, botFriend.id].sort())
  })
})
