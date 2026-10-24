// Реестр меток и расходы (w2-src-1, w2-src-4, w2-src-c1) на настоящем сервере и своей базе:
// администратор создаёт «Ярмарка МИСИС» с меткой fair-misis — название видно через sourceNames и describeSource
// (так его показывают «Воронка», карточка и список), роль hr реестр и расходы только видит (403 на изменения),
// незнакомая метка из заявок получает название и уходит из списка, sourceCosts считает расход за пересекающийся период.
// Запуск: pnpm test w2-hr-sources-registry (нужен PostgreSQL, база создаётся и удаляется сама)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describeSource, sourceName } from '../../shared/hr'
import {
  checkCost,
  checkSource,
  costPeriodLabel,
  kindByCode,
  normalizeSourceCode,
  parseDay,
  sourceCodeProblem,
  sourceKinds,
  sourceLinks,
  suggestSourceCode,
  summarizeKinds,
  type SourceCost,
  type SourceEntry,
  type SourcesPayload,
} from '../../shared/sources'
import { createApp } from '../../server/app'
import { hashPassword } from '../../server/auth/password'
import type { Registry } from '../../server/channels/registry'
import { PostgresStorage, type Sql } from '../../server/db'
import { funnelReport } from '../../server/db/funnel'
import { HrRepo } from '../../server/db/hr'
import { listSources, seedDemoSources, sourceCosts, sourceNames } from '../../server/db/sources'
import type { RateRule } from '../../server/middleware/rate-limit'
import { serverSettled, withTestDb } from './_db'

const password = 'проверка-пароля-1'
const bots: Registry = { get: () => undefined, active: () => ['telegram'], failed: () => [], start: () => {} }
const rules: RateRule[] = [{ name: 'api', burst: 100000, perMinute: 100000, match: (_m, p) => p.startsWith('/api/') }]
const DAY = 24 * 60 * 60 * 1000

/** День по Москве со сдвигом от текущего момента: YYYY-MM-DD */
const day = (offset: number) => new Date(Date.now() + offset * DAY).toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' })
/** Полночь этого дня по Москве */
const midnight = (offset: number) => new Date(`${day(offset)}T00:00:00+03:00`)

async function setup(sql: Sql, env: Record<string, string> = {}) {
  const storage = new PostgresStorage(sql)
  const repo = new HrRepo(sql)
  const hash = await hashPassword(password)
  await repo.createUser({ email: 'admin@src.test', name: 'Админ', role: 'admin', passwordHash: hash })
  await repo.createUser({ email: 'anna@src.test', name: 'Анна', role: 'hr', passwordHash: hash })
  const app = await createApp({ storage, engine: null, bots, hrToken: '', env: { NODE_ENV: 'test', SITE_URL: 'https://season.example.ru/', ...env }, rateRules: rules })
  await serverSettled(sql)
  const login = async (email: string) => {
    const res = await app.request('/api/hr/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]
    assert.ok(cookie, `вход ${email}`)
    return async <T = Record<string, unknown>>(method: string, path: string, body?: unknown) => {
      const r = await app.request(path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { cookie, 'content-type': 'application/json', 'x-hr-request': '1' } })
      return { status: r.status, body: (await r.json()) as T }
    }
  }
  return { app, admin: await login('admin@src.test'), hr: await login('anna@src.test') }
}

let n = 0
async function application(sql: Sql, source: string | null, opts: { duplicateOf?: string; status?: string } = {}) {
  const id = `src-${++n}`
  await sql`
    insert into applications (id, created_at, channel, name, phone, game, source, status, status_updated_at, consent_at, consent_version, consent_source, duplicate_of)
    values (${id}, now(), 'web', ${'Кандидат ' + n}, '', ${sql.json({ quizResult: null, conveyorBest: 0, activities: 0 })}, ${source},
            ${opts.status ?? 'new'}, now(), now(), '1', 'site_form', ${opts.duplicateOf ?? null})`
  return id
}

test('метка: вид, занятые коды, подсказка по названию и тип по приставке', () => {
  assert.equal(normalizeSourceCode('  Ярмарка МИСИС '), 'yarmarka-misis')
  assert.equal(normalizeSourceCode('Fair__MISIS!!'), 'fair-misis')
  assert.equal(normalizeSourceCode('a'.repeat(39) + '-bbb'), 'a'.repeat(39))
  assert.equal(suggestSourceCode('fair', 'Ярмарка МИСИС'), 'fair-misis')
  assert.equal(suggestSourceCode('excursion', 'Экскурсия на производство для МГУПП, весна'), 'tour-mgupp-vesna')
  assert.equal(suggestSourceCode('eng_class', 'Инженерный класс школы 1580'), 'class-1580')
  assert.equal(suggestSourceCode('social', 'Telegram-канал студсовета'), 'tg-studsoveta')
  assert.equal(suggestSourceCode('social', 'Пост ВКонтакте МГУПП'), 'vk-mgupp')
  assert.equal(suggestSourceCode('social', 'Канал в MAX'), '', 'без площадки метку не придумываем')
  assert.ok(suggestSourceCode('school', 'Московский государственный университет пищевых производств, технологический факультет').length <= 40)
  assert.equal(sourceCodeProblem('fair-misis'), null)
  assert.ok(sourceCodeProblem(''))
  assert.ok(sourceCodeProblem('Fair-Misis'), 'только строчные')
  assert.ok(sourceCodeProblem('fair_misis'), 'без подчёркивания')
  assert.ok(sourceCodeProblem('-fair'), 'без дефиса в начале')
  assert.ok(sourceCodeProblem('a'.repeat(41)), 'не длиннее 40')
  for (const reserved of ['friend', 'friend-abc234', 'share', 'remind', 'remind-fair']) assert.ok(sourceCodeProblem(reserved), reserved)
  assert.equal(kindByCode('fair-misis'), 'fair')
  assert.equal(kindByCode('tour-mgupp'), 'excursion')
  assert.equal(kindByCode('tg-studsovet'), 'social')
  assert.equal(kindByCode('qr-stend'), 'other')
  // Типы для всех инициатив компании из кейса и концепции
  const labels = sourceKinds.map((k) => k.label).join(' | ')
  for (const word of ['Экскурсия', 'Музей', 'Инженерный класс', 'Вуз или колледж', 'Ярмарка', 'hh.ru', 'Соцсети', 'Друг']) assert.ok(labels.includes(word), word)
})

test('проверка полей метки и расхода, срок расхода словами', () => {
  const ok = checkSource({ code: 'fair-misis', name: '  Ярмарка   МИСИС ', kind: 'fair', note: '' })
  assert.deepEqual(ok.errors, {})
  assert.equal(ok.value.name, 'Ярмарка МИСИС')
  const bad = checkSource({ code: 'Fair', name: '', kind: 'beer' })
  assert.ok(bad.errors.code && bad.errors.name && bad.errors.kind)
  assert.deepEqual(checkSource({ code: 'walk_in', name: 'Визит', kind: 'own' }, { codeLocked: true }).errors, {})

  assert.equal(checkCost({ code: 'vk', amount: '15 000 ₽' }).value.amount, 15000)
  assert.ok(checkCost({ code: 'vk', amount: '15,5' }).errors.amount)
  assert.ok(checkCost({ code: 'vk', amount: '0' }).errors.amount)
  assert.ok(checkCost({ code: 'vk', amount: '1000000000' }).errors.amount)
  assert.ok(checkCost({ code: '', amount: 100 }).errors.code)
  const from = day(-10)
  const to = day(-3)
  const [y, m, d] = from.split('-')
  assert.equal(parseDay(`${d}.${m}.${y}`), from, 'ДД.ММ.ГГГГ руками')
  assert.equal(parseDay(`${y}-02-30`), null, 'невозможный день')
  assert.ok(checkCost({ code: 'vk', amount: 100, from: to, to: from }).errors.to, 'конец раньше начала')
  assert.deepEqual(checkCost({ code: 'vk', amount: 100, from, to: '' }).errors, {}, 'одна граница срока')
  assert.equal(costPeriodLabel({ from: null, to: null }), 'без срока')
  assert.equal(costPeriodLabel({ from, to: from }), `${d}.${m}.${y}`)
  assert.match(costPeriodLabel({ from, to }), /^\d\d\.\d\d\.\d{4} — \d\d\.\d\d\.\d{4}$/)
})

test('ссылки: сайт с меткой, боты — только при известном имени, без заглушек', () => {
  const none = sourceLinks('fair-misis', { url: 'https://season.example.ru/', bots: { telegram: null, max: null } })
  assert.deepEqual(none, { site: 'https://season.example.ru/?src=fair-misis', telegram: null, max: null })
  const both = sourceLinks('fair-misis', { url: 'https://season.example.ru', bots: { telegram: 'ochakovo_bot', max: 'ochakovo' } })
  assert.equal(both.telegram, 'https://t.me/ochakovo_bot?start=fair-misis')
  assert.equal(both.max, 'https://max.ru/ochakovo?start=fair-misis')
})

test('«Ярмарка МИСИС»: администратор создаёт, название видно везде, роль hr не правит', async () => {
  await withTestDb('w2-hr-sources-reg', async (sql) => {
    const { admin, hr } = await setup(sql, { TELEGRAM_BOT_USERNAME: 'ochakovo_season_bot' })
    // Заявки с меткой ещё до реестра: метка незнакомая, панель подписывает её разбором приставки
    await application(sql, 'fair-misis')
    const dupOf = await application(sql, 'fair-misis')
    await application(sql, 'fair-misis', { duplicateOf: dupOf })
    await application(sql, 'qr-stend')
    await application(sql, 'friend-abc234')
    await sql`insert into funnel_events (created_at, visitor, type, source) values (now(), 'v1', 'visit', 'qr-stend'), (now(), 'v2', 'visit', 'qr-stend')`

    const before = await hr<SourcesPayload>('GET', '/api/hr/sources')
    assert.equal(before.status, 200)
    assert.equal(before.body.canEdit, false, 'роль hr только смотрит')
    assert.deepEqual(before.body.site, { url: 'https://season.example.ru', bots: { telegram: 'ochakovo_season_bot', max: null }, active: { telegram: true, max: false } })
    assert.ok(before.body.sources.some((s) => s.code === 'fair-mgupp' && s.builtin), 'начальные данные — прежний словарь')
    assert.ok(before.body.sources.some((s) => s.code === 'walk_in' && s.kind === 'own'))
    const unknown = Object.fromEntries(before.body.unknown.map((u) => [u.code, u]))
    assert.equal(unknown['fair-misis']?.applications, 2, 'дубль не считается')
    assert.equal(unknown['fair-misis']?.guess, 'Ярмарка · misis')
    assert.equal(unknown['qr-stend']?.visitors, 2)
    assert.equal(unknown['friend-abc234'], undefined, 'приглашения друзей — не метки площадок')

    // Роль hr: 403 на любое изменение
    const draft = { code: 'fair-misis', name: 'Ярмарка МИСИС', kind: 'fair', note: 'Стенд у главного входа' }
    assert.equal((await hr('POST', '/api/hr/sources', draft)).status, 403)
    assert.equal((await hr('PATCH', '/api/hr/sources/fair-mgupp', { name: 'Другое' })).status, 403)
    assert.equal((await hr('DELETE', '/api/hr/sources/fair-mgupp')).status, 403)
    assert.equal((await hr('POST', '/api/hr/sources/fair-mgupp/costs', { amount: 1000 })).status, 403)

    // Администратор: «Дать название» незнакомой метке
    const created = await admin<{ source: SourceEntry }>('POST', '/api/hr/sources', draft)
    assert.equal(created.status, 201)
    assert.equal(created.body.source.name, 'Ярмарка МИСИС')
    assert.equal(created.body.source.applications, 2)
    assert.equal(created.body.source.updatedBy, 'Админ')
    assert.equal((await admin('POST', '/api/hr/sources', draft)).status, 409, 'дубль метки')
    assert.equal((await admin('POST', '/api/hr/sources', { ...draft, code: 'fair-Misis' })).status, 422)
    assert.equal((await admin('POST', '/api/hr/sources', { ...draft, code: 'friend-zzz' })).status, 422, 'занятая метка')
    assert.equal((await admin('POST', '/api/hr/sources', { ...draft, code: 'fair-misis-2', kind: 'pub' })).status, 422, 'неизвестный тип')

    const after = await hr<SourcesPayload>('GET', '/api/hr/sources')
    assert.ok(!after.body.unknown.some((u) => u.code === 'fair-misis'), 'названная метка ушла из незнакомых')
    assert.ok(after.body.unknown.some((u) => u.code === 'qr-stend'))

    // Название из реестра — то, что показывают «Воронка», карточка и список: sourceName(src, names)
    const names = await sourceNames(sql)
    assert.equal(sourceName('fair-misis', names), 'Ярмарка МИСИС')
    assert.equal(describeSource('fair-misis', names).kind, 'registry')
    assert.equal(sourceName('fair-misis'), 'Ярмарка · misis', 'без реестра — прежний разбор')

    // Правка: название и тип меняются, метка — нет
    const edited = await admin<{ source: SourceEntry }>('PATCH', '/api/hr/sources/fair-misis', { name: 'Ярмарка НИТУ МИСИС', code: 'other-code' })
    assert.equal(edited.status, 200)
    assert.equal(edited.body.source.code, 'fair-misis')
    assert.equal(edited.body.source.name, 'Ярмарка НИТУ МИСИС')
    assert.equal(edited.body.source.kind, 'fair')
    assert.equal((await admin('PATCH', '/api/hr/sources/fair-misis', { name: '' })).status, 422)
    assert.equal((await admin('PATCH', '/api/hr/sources/nope', { name: 'X' })).status, 404)

    // Удаление: встроенную нельзя, с расходом — нельзя, свою без расхода — можно
    assert.deepEqual((await admin('DELETE', '/api/hr/sources/fair-mgupp')).body, { error: 'builtin' })
    const cost = await admin<{ cost: SourceCost }>('POST', '/api/hr/sources/fair-misis/costs', { amount: '25 000', comment: 'Стенд', from: day(-12), to: day(-11) })
    assert.equal(cost.status, 201)
    assert.equal(cost.body.cost.amount, 25000)
    assert.equal(cost.body.cost.authorName, 'Админ')
    assert.equal(cost.body.cost.from, day(-12))
    assert.equal((await admin('POST', '/api/hr/sources/fair-misis/costs', { amount: 'много' })).status, 422)
    assert.equal((await admin('POST', '/api/hr/sources/nope/costs', { amount: 100 })).status, 404)
    assert.deepEqual((await admin('DELETE', '/api/hr/sources/fair-misis')).body, { error: 'has_costs' })
    assert.equal((await hr('DELETE', `/api/hr/source-costs/${cost.body.cost.id}`)).status, 403, 'роль hr не удаляет расход')
    const seen = await hr<SourcesPayload>('GET', '/api/hr/sources')
    assert.equal(seen.body.costs.length, 1, 'роль hr видит расходы')
    assert.equal((await admin('DELETE', `/api/hr/source-costs/${cost.body.cost.id}`)).status, 200)
    assert.equal((await admin('DELETE', `/api/hr/source-costs/${cost.body.cost.id}`)).status, 404)
    assert.equal((await admin('POST', '/api/hr/sources', { code: 'tour-test', name: 'Экскурсия', kind: 'excursion' })).status, 201)
    assert.equal((await admin('DELETE', '/api/hr/sources/tour-test')).status, 200)

    // Сводка по типам: одна система для всех инициатив
    const final = await admin<SourcesPayload>('GET', '/api/hr/sources')
    assert.equal(final.body.canEdit, true)
    const fair = summarizeKinds(final.body.sources, final.body.costs).find((k) => k.kind.id === 'fair')
    assert.ok(fair && fair.codes >= 4 && fair.applications === 2)
  })
})

test('sourceCosts: расход за пересекающийся период целиком, без срока — всегда, «Воронка» берёт его сама', async () => {
  await withTestDb('w2-hr-sources-cost', async (sql) => {
    await sql`insert into hr_sources (code, name, kind) values ('fair-misis', 'Ярмарка МИСИС', 'fair'), ('tour-mgupp', 'Экскурсия МГУПП', 'excursion')`
    const add = (code: string, amount: number, from: string | null, to: string | null) =>
      sql`insert into source_costs (code, amount, period_from, period_to) values (${code}, ${amount}, ${from}, ${to})`
    await add('fair-misis', 30000, day(-12), day(-11)) // ярмарка два дня
    await add('fair-misis', 5000, day(-40), day(-35)) // давняя печать
    await add('vk', 20000, day(-30), day(-1)) // реклама месяц
    await add('tour-mgupp', 4000, null, null) // без срока
    await add('vk', 1000, day(-5), null) // с одной границей — открыт в будущее

    // Последняя неделя: ярмарки там нет, реклама пересекается — вся сумма, без деления по дням
    assert.deepEqual(await sourceCosts(sql, midnight(-7), midnight(1)), { vk: 21000, 'tour-mgupp': 4000 })
    // Две недели: ярмарка попала
    assert.deepEqual(await sourceCosts(sql, midnight(-14), midnight(1)), { 'fair-misis': 30000, vk: 21000, 'tour-mgupp': 4000 })
    // Граница: период кончается в полночь первого дня ярмарки — не пересекается; начинается в полночь после последнего — тоже
    assert.equal((await sourceCosts(sql, midnight(-20), midnight(-12)))['fair-misis'], undefined)
    assert.equal((await sourceCosts(sql, midnight(-10), midnight(-9)))['fair-misis'], undefined)
    assert.equal((await sourceCosts(sql, midnight(-11), midnight(-10)))['fair-misis'], 30000, 'последний день срока входит')
    // Задолго до всего — только расход без срока
    assert.deepEqual(await sourceCosts(sql, midnight(-200), midnight(-100)), { 'tour-mgupp': 4000 })

    // «Воронка» (server/db/funnel.ts) находит sourceCosts сама — расход в строке метки
    const report = await funnelReport(sql, midnight(-14), midnight(1), [])
    assert.equal(report.costsKnown, true)
    assert.equal(report.rows.find((r) => r.source === 'fair-misis')?.cost, 30000)
  })
})

test('демо-данные: названия меткам демо-заявок и расходы, повтор не множит строки', async () => {
  await withTestDb('w2-hr-sources-demo', async (sql) => {
    await sql`insert into source_costs (code, amount, comment) values ('vk', 12345, 'Настоящий расход')`
    await seedDemoSources(sql, ['fair-misis', 'vk', 'friend-abc234', 'Bad Code'])
    await seedDemoSources(sql, ['fair-misis', 'vk'])
    const list = await listSources(sql)
    assert.equal(list.find((s) => s.code === 'fair-misis')?.name, 'Ярмарка МИСИС')
    assert.ok(list.some((s) => s.kind === 'excursion') && list.some((s) => s.kind === 'museum') && list.some((s) => s.kind === 'school'))
    assert.ok(!list.some((s) => s.code.startsWith('friend')), 'приглашения не попадают в реестр')
    const costs = await sql<{ demo: boolean; amount: number }[]>`select demo, amount from source_costs`
    assert.equal(costs.filter((c) => !c.demo).length, 1, 'настоящий расход не тронут')
    assert.equal(costs.filter((c) => c.demo).length, 5, 'демо-расходы заменились, а не удвоились')
    const week = await sourceCosts(sql, midnight(-14), midnight(1))
    assert.ok(week['fair-misis'] > 0)
  })
})
