// Приём заявок: согласие на сервере, ярмарочные лимиты по человеку, повторы, ловушка, код приглашения, адрес за прокси.
// Запуск: pnpm test w1-platform-core-intake (нужен PostgreSQL, база создаётся и удаляется сама)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { CONSENT_VERSION, type ApplicationInput } from '../../shared/applications'
import { ConsentRequiredError } from '../../shared/applicationInput'
import { createApp } from '../../server/app'
import { PER_HOUR, REPEAT_MINUTES } from '../../server/candidate/intake'
import type { Registry } from '../../server/channels/registry'
import { PostgresStorage, type Sql } from '../../server/db'
import { clientIp, trustedHops } from '../../server/middleware/client-ip'
import { defaultRules, rateLimit } from '../../server/middleware/rate-limit'
import { serverSettled, withTestDb } from './_db'

// Один доверенный прокси: адрес клиента — правый в X-Forwarded-For
process.env.TRUST_PROXY = '1'

const noBots: Registry = { get: () => undefined, active: () => [], failed: () => [], start: () => {} }
let seq = 0
/** Уникальный телефон на каждый вызов: +7 900 XXX-XX-XX */
const phone = () => `+7 900 ${String(1_000_000 + Math.floor(Math.random() * 8_000_000) + seq++).replace(/^(\d{3})(\d{2})(\d{2})$/, '$1-$2-$3')}`
/** Обязательные поля кейса для заявки с сайта: фамилия, дата рождения (20 лет назад от текущего момента), учёба, когда может выйти */
const caseFields = { lastName: 'Проверкина', birthDate: new Date(Date.now() - 20 * 365.25 * 864e5).toISOString().slice(0, 10), school: 'МГУПП', startReady: 'now' }
const form = (extra: Record<string, unknown> = {}) => ({ name: 'Проверка', phone: phone(), ...caseFields, consent: true, consentVersion: CONSENT_VERSION, ...extra })

async function setup(sql: Sql) {
  const storage = new PostgresStorage(sql)
  // Лимиты по умолчанию — как на настоящем сервере
  const app = await createApp({ storage, engine: null, bots: noBots, hrToken: '', env: { NODE_ENV: 'test' } })
  await serverSettled(sql)
  const post = (body: unknown, ip = '203.0.113.10', xff?: string) =>
    app.request('/api/applications', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': xff ?? ip },
      body: JSON.stringify(body),
    })
  return { storage, app, post }
}

const count = async (sql: Sql) => (await sql<{ n: number }[]>`select count(*)::int as n from applications`)[0].n
/** Сдвинуть время заявок с этим телефоном назад: так проверяем окна в 10 минут и в час без ожидания */
const age = (sql: Sql, id: string, minutes: number) => sql`update applications set created_at = now() - make_interval(mins => ${minutes}) where id = ${id}`

test('согласие: без отметки или с неизвестной версией — 422, с ними — время, версия и источник в базе', async () => {
  await withTestDb('core-consent', async (sql) => {
    const { storage, post } = await setup(sql)
    for (const [label, body] of [
      ['без consent', form({ consent: undefined })],
      ['consent: false', form({ consent: false })],
      ['consent: "true" строкой', form({ consent: 'true' })],
      ['неизвестная версия', form({ consentVersion: '0' })],
      ['без версии', form({ consentVersion: undefined })],
    ] as const) {
      const res = await post(body)
      const json = (await res.json()) as { error: string; errors: Record<string, string> }
      assert.equal(res.status, 422, label)
      assert.equal(json.error, 'validation', label)
      assert.ok(json.errors.consent, `${label}: ошибка в поле consent`)
    }
    assert.equal(await count(sql), 0, 'без согласия ничего не записано')

    // Форма сама не выбирает источник: даже присланный «telegram» записывается как форма на сайте
    const res = await post(form({ consentSource: 'telegram' }))
    assert.equal(res.status, 201)
    const { id } = (await res.json()) as { id: string }
    const [row] = await sql<{ consent_at: Date | null; consent_version: string; consent_source: string; channel: string }[]>`
      select consent_at, consent_version, consent_source, channel from applications where id = ${id}`
    assert.ok(row.consent_at && Math.abs(row.consent_at.getTime() - Date.now()) < 60_000, 'время согласия — время заявки')
    assert.equal(row.consent_version, CONSENT_VERSION)
    assert.equal(row.consent_source, 'site_form')
    assert.equal(row.channel, 'web')

    // Бот: без согласия заявка не сохраняется, с согласием — источник канала; чат на сайте — site_chat, канал web
    const bot = { name: 'Бот', phone: phone(), channel: 'telegram', channelUserId: '501' } as ApplicationInput
    await assert.rejects(storage.saveApplication(bot), ConsentRequiredError)
    await assert.rejects(storage.saveApplication({ ...bot, consent: true, consentVersion: '0' }), ConsentRequiredError)
    await assert.rejects(storage.saveApplication({ ...bot, consent: true, consentVersion: CONSENT_VERSION, consentSource: 'hr_verbal' }), ConsentRequiredError)
    const tg = await storage.saveApplication({ ...bot, consent: true, consentVersion: CONSENT_VERSION })
    const chat = await storage.saveApplication({ name: 'Чат', phone: phone(), channel: 'web', consent: true, consentVersion: CONSENT_VERSION, consentSource: 'site_chat' } as ApplicationInput)
    const sources = await sql<{ id: string; channel: string; consent_source: string; consent_version: string; has_time: boolean }[]>`
      select id, channel, consent_source, consent_version, consent_at is not null as has_time from applications where id in ${sql([tg.id, chat.id])} order by name`
    assert.deepEqual(
      sources.map((r) => [r.channel, r.consent_source, r.consent_version, r.has_time]),
      [
        ['telegram', 'telegram', CONSENT_VERSION, true],
        ['web', 'site_chat', CONSENT_VERSION, true],
      ],
    )
    assert.equal(tg.consentSource, 'telegram')
  })
})

test('ярмарка: 30 заявок с одного адреса проходят, повтор — 409 без номера и токена, четвёртая за час — 429', async () => {
  await withTestDb('core-fair', async (sql) => {
    const { post } = await setup(sql)

    // Очередь у стенда: 30 разных людей с одного Wi-Fi подряд — все 201
    const queue = await Promise.all(Array.from({ length: 30 }, () => post(form(), '198.51.100.7')))
    assert.deepEqual(queue.map((r) => r.status), Array(30).fill(201))
    const extra = await post(form(), '198.51.100.7')
    assert.equal(extra.status, 429, '31-я подряд с того же адреса упирается в потолок по IP')
    assert.equal(((await extra.json()) as { error: string }).error, 'rate_limited')
    assert.ok(Number(extra.headers.get('retry-after')) > 0, 'Retry-After у потолка по IP')

    // Повтор того же человека за 10 минут: другой записью номера, с другого адреса — 409 без номера и токена
    const same = phone()
    const first = await post(form({ phone: same }), '198.51.100.20')
    assert.equal(first.status, 201)
    const firstBody = (await first.json()) as { id: string; statusToken: string }
    const digits = same.replace(/\D/g, '')
    const again = await post(form({ phone: `8 (${digits.slice(1, 4)}) ${digits.slice(4, 7)} ${digits.slice(7, 9)} ${digits.slice(9)}` }), '198.51.100.21')
    assert.equal(again.status, 409)
    const againText = await again.text()
    assert.deepEqual(JSON.parse(againText), { error: 'already_applied' })
    assert.ok(!againText.includes(firstBody.id) && !againText.includes(firstBody.statusToken) && !againText.includes(digits.slice(-7)), 'в ответе нет номера заявки, токена и телефона')

    // Ник вместо телефона: тот же ник в другом регистре — тоже повтор
    const nick = await post({ name: 'Ник', contact: '@Kvas_Fan', ...caseFields, consent: true, consentVersion: CONSENT_VERSION }, '198.51.100.22')
    assert.equal(nick.status, 201)
    const nickAgain = await post({ name: 'Ник', contact: '@kvas_fan', ...caseFields, consent: true, consentVersion: CONSENT_VERSION }, '198.51.100.23')
    assert.equal(nickAgain.status, 409)

    // Через 10 минут — можно снова; третья за час — тоже; четвёртая за час — 429 phone_limit с Retry-After
    await age(sql, firstBody.id, 50)
    const second = await post(form({ phone: same }), '198.51.100.24')
    assert.equal(second.status, 201, `через ${REPEAT_MINUTES} минут повтор принимается`)
    await age(sql, ((await second.json()) as { id: string }).id, 30)
    const third = await post(form({ phone: same }), '198.51.100.25')
    assert.equal(third.status, 201)
    await age(sql, ((await third.json()) as { id: string }).id, 15)
    const fourth = await post(form({ phone: same }), '198.51.100.26')
    assert.equal(fourth.status, 429, `больше ${PER_HOUR} заявок за час`)
    const limit = (await fourth.json()) as { error: string; retryAfter: number }
    assert.equal(limit.error, 'phone_limit')
    // Самая ранняя из трёх была 50 минут назад: выйдет из окна часа через 10 минут
    assert.ok(Math.abs(limit.retryAfter - 600) <= 5, `retryAfter ${limit.retryAfter}`)
    assert.equal(fourth.headers.get('retry-after'), String(limit.retryAfter))

    // Два одновременных «Отправить» с одного номера — одна заявка
    const twin = phone()
    const pair = await Promise.all([post(form({ phone: twin }), '198.51.100.30'), post(form({ phone: twin }), '198.51.100.31')])
    assert.deepEqual(pair.map((r) => r.status).sort(), [201, 409])
    const twinDigits = twin.replace(/\D/g, '')
    assert.equal((await sql`select id from applications where phone_norm = ${twinDigits}`).length, 1)
  })
})

test('ловушка website: заявка сохраняется с пометкой «похоже на спам», ответ тот же', async () => {
  await withTestDb('core-trap', async (sql) => {
    const { post } = await setup(sql)
    const bot = await post(form({ website: 'https://spam.example' }))
    const human = await post(form())
    assert.equal(bot.status, 201)
    assert.equal(human.status, 201)
    const botBody = (await bot.json()) as Record<string, unknown>
    assert.ok(botBody.id && botBody.statusToken, 'ответ ловушке ничем не отличается')
    assert.ok(!('suspectedSpam' in botBody) && !('website' in botBody))
    const rows = await sql<{ id: string; suspected_spam: boolean }[]>`select id, suspected_spam from applications`
    const flag = new Map(rows.map((r) => [r.id, r.suspected_spam]))
    assert.equal(flag.get(botBody.id as string), true)
    assert.equal(flag.get(((await human.json()) as { id: string }).id), false)
  })
})

test('код приглашения: записывается уникально, при совпадении заявка принимается без кода', async () => {
  await withTestDb('core-ref', async (sql) => {
    const { post } = await setup(sql)
    const a = await post(form({ refCode: 'kvas29' }))
    const b = await post(form({ refCode: 'KVAS29' }))
    const c = await post(form())
    const d = await post(form({ refCode: 'kvas1' }))
    assert.deepEqual([a.status, b.status, c.status, d.status], [201, 201, 201, 201])
    const [ja, jb, jc, jd] = (await Promise.all([a.json(), b.json(), c.json(), d.json()])) as Record<string, unknown>[]
    assert.equal(ja.refCode, 'kvas29', 'код у первой заявки')
    assert.ok(!('refCode' in jb), 'у второй кода нет: он занят')
    assert.ok(!('refCode' in jc), 'без кода — как раньше')
    assert.ok(!('refCode' in jd), 'неверный код отброшен')
    const rows = await sql<{ id: string; ref_code: string | null }[]>`select id, ref_code from applications`
    const code = new Map(rows.map((r) => [r.id, r.ref_code]))
    assert.equal(code.get(ja.id as string), 'kvas29')
    assert.equal(code.get(jb.id as string), null)
    assert.equal(code.get(jc.id as string), null)
    // История у заявки с занятым кодом записана: транзакция не сломалась на конфликте
    const [history] = await sql<{ n: number }[]>`select count(*)::int as n from application_history where application_id = ${jb.id as string}`
    assert.equal(history.n, 1)
  })
})

test('X-Forwarded-For при TRUST_PROXY=1: подставленный слева адрес не меняет ключ лимита', async () => {
  assert.equal(trustedHops('1'), 1)
  assert.equal(trustedHops('true'), 1, 'true — один прокси, а не «верить всей цепочке»')
  assert.equal(trustedHops('2'), 2)
  assert.equal(trustedHops(''), 0)
  assert.equal(trustedHops('abc'), 0)

  const app = new Hono()
  app.get('/ip', (c) => c.text(clientIp(c)))
  const ip = async (xff: string) => (await app.request('/ip', { headers: { 'x-forwarded-for': xff } })).text()
  assert.equal(await ip('10.1.1.1'), '10.1.1.1')
  assert.equal(await ip('6.6.6.6, 10.1.1.1'), '10.1.1.1')
  assert.equal(await ip('1.1.1.1, 2.2.2.2, 10.1.1.1'), '10.1.1.1')

  // Лимиты по умолчанию: 30 заявок подряд, потом 10 в минуту; подмена левого адреса не даёт новых попыток
  let now = 1_000_000
  const limited = new Hono()
  limited.use('*', rateLimit(defaultRules, () => now))
  limited.post('/api/applications', (c) => c.body(null, 201))
  limited.post('/api/dialog', (c) => c.body(null, 200))
  limited.post('/api/hr/login', (c) => c.body(null, 200))
  const send = (path: string, xff: string) => limited.request(path, { method: 'POST', headers: { 'x-forwarded-for': xff } })
  const statuses = []
  for (let i = 0; i < 31; i++) statuses.push((await send('/api/applications', `9.9.9.${i}, 10.2.2.2`)).status)
  assert.deepEqual(statuses, [...Array(30).fill(201), 429])
  const blocked = await send('/api/applications', '7.7.7.7, 10.2.2.2')
  assert.equal(blocked.status, 429)
  assert.ok(Number(blocked.headers.get('retry-after')) > 0)
  assert.equal((await send('/api/applications', '10.3.3.3')).status, 201, 'другой адрес не страдает')
  now += 6_000
  assert.equal((await send('/api/applications', '10.2.2.2')).status, 201, 'через 6 секунд — ещё одна (10 в минуту)')
  assert.equal((await send('/api/applications', '10.2.2.2')).status, 429)

  // Диалог: потолок 400 в минуту на адрес
  const dialog = []
  for (let i = 0; i < 401; i++) dialog.push((await send('/api/dialog', '10.4.4.4')).status)
  assert.equal(dialog.filter((s) => s === 200).length, 400)
  assert.equal(dialog.at(-1), 429)

  // Вход в HR остаётся строгим: 5 попыток подряд
  const login = []
  for (let i = 0; i < 6; i++) login.push((await send('/api/hr/login', '10.5.5.5')).status)
  assert.deepEqual(login, [200, 200, 200, 200, 200, 429])
})
