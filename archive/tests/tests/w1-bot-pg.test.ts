// Заявка из бота и из чата на сайте в PostgreSQL: поля кейса (ФИО, дата рождения, вуз, когда выйти), согласие с версией
// и источником, телефон +7XXXXXXXXXX, практика и «хочу остаться», код приглашения; «Моя заявка» после заявки в чате.
// Дата рождения — от текущего момента. Запуск: pnpm test w1-bot-pg (нужен PostgreSQL)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CONSENT_VERSION, missingProfile } from '../../shared/applications'
import { createAssistant } from '../../server/assistant/assistant'
import { PostgresStorage } from '../../server/db'
import { WorkflowRepo } from '../../server/db/workflow'
import { createEngine } from '../../server/dialog/engine'
import type { DialogEvent, DialogUser, HandleMeta } from '../../server/dialog/types'
import { offlineProvider } from '../../server/llm/offline'
import { mskToday } from '../../shared/birthDate'
import { withTestDb } from './_db'

const assistant = createAssistant({ provider: offlineProvider(), log: () => {} })
const bare = (t: string) => t.replace(/\*\*/g, '').replace(/[\u00A0\u202F]/g, ' ')
/** 20 лет назад от сегодняшнего дня по Москве: ДД.ММ.ГГГГ и YYYY-MM-DD */
const [ty, tm, td] = mskToday().split('-')
const BIRTH = `${td}.${tm}.${Number(ty) - 20}`
const BIRTH_ISO = `${Number(ty) - 20}-${tm}-${td}`

test('заявки из Telegram и веб-чата в PostgreSQL: 18+, согласие, телефон, практика, код, статус', async () => {
  await withTestDb('w1-bot-pg', async (sql) => {
    const storage = new PostgresStorage(sql)
    const engine = createEngine(storage, { siteUrl: 'https://ochakovo.test', assistant })
    const run = (user: DialogUser, meta?: HandleMeta) => async (...steps: (string | DialogEvent)[]) => {
      let last
      for (const step of steps) {
        const event: DialogEvent = typeof step === 'string' ? (/^[a-z]{1,2}:\S*$/.test(step) ? { type: 'action', action: step } : { type: 'text', text: step }) : step
        last = await engine.handle(user, event, meta)
      }
      return last!
    }

    // Telegram: имя из кнопки, телефон текстом, практика от вуза
    const tg: DialogUser = { channel: 'telegram', id: '5550001', firstName: 'Даня', username: 'danya' }
    const done = await run(tg)(
      { type: 'start', payload: 'fair-mgupp' },
      'a:start:bottling-operator',
      BIRTH,
      'a:name',
      'Петров',
      '8 (916) 123-45-67',
      'МГУПП',
      'a:mdone',
      'a:sr:now',
      'a:v:bottling-operator',
      'a:practice',
      'a:ok',
    )
    const id = /Заявка № (\w+) отправлена/.exec(bare(done.messages[0].text))?.[1]
    assert.ok(id, done.messages[0].text)
    assert.equal(done.application, undefined, 'в мессенджер номер и токен не уходят')
    const [row] = await sql<{ adult: boolean; phone: string; channel: string; channel_user_id: string; consent_at: Date | null; consent_version: string; consent_source: string; practice_school: boolean; wants_to_stay: boolean; ref_code: string | null; source: string; name: string; last_name: string; birth_date: string; school: string; start_ready: string }[]>`
      select adult, phone, channel, channel_user_id, consent_at, consent_version, consent_source, practice_school, wants_to_stay, ref_code, source,
             name, last_name, birth_date::text as birth_date, school, start_ready from applications where id = ${id!}`
    assert.equal(row.adult, true)
    assert.equal(row.phone, '+79161234567')
    assert.equal(row.channel, 'telegram')
    assert.equal(row.channel_user_id, '5550001')
    assert.ok(row.consent_at, 'время согласия записано')
    assert.equal(row.consent_version, CONSENT_VERSION)
    assert.equal(row.consent_source, 'telegram')
    assert.equal(row.practice_school, true)
    assert.equal(row.wants_to_stay, false)
    assert.match(row.ref_code ?? '', /^[a-z2-9]{6}$/)
    assert.equal(row.source, 'fair-mgupp')
    assert.equal(row.name, 'Даня')
    assert.equal(row.last_name, 'Петров')
    assert.equal(row.birth_date, BIRTH_ISO)
    assert.equal(row.school, 'МГУПП')
    assert.equal(row.start_ready, 'now')
    const hr = await new WorkflowRepo(sql).get(id!)
    assert.ok(hr && !missingProfile(hr).includes('дата рождения') && !missingProfile(hr).includes('фамилия'), 'в HR нет «не хватает: дата рождения, фамилия»')
    const status = await run(tg)('моя заявка')
    assert.ok(bare(status.messages[0].text).startsWith(`Заявка № ${id} · Оператор линии розлива`), status.messages[0].text)

    // Чат на сайте: код браузера, ник вместо телефона, заявка возвращается сайту с токеном
    const web: DialogUser = { channel: 'web', id: 'w1-bot-browser' }
    const meta: HandleMeta = { refCode: 'kvas23' }
    const webDone = await run(web, meta)('a:start', BIRTH, 'Оля', 'Морозова', 'можно без телефона?', '@olya_kvas', 'a:nostudy', 'a:mnone', 'a:sr:after_session', 'a:v:any', 'a:stay', 'a:ok')
    const app = webDone.application
    assert.ok(app && app.token.length > 20, JSON.stringify(webDone))
    assert.equal(app.contact, '@olya_kvas')
    const [w] = await sql<{ consent_source: string; ref_code: string | null; wants_to_stay: boolean; channel_user_id: string | null }[]>`
      select consent_source, ref_code, wants_to_stay, channel_user_id from applications where id = ${app.id}`
    assert.equal(w.consent_source, 'site_chat')
    assert.equal(w.ref_code, 'kvas23')
    assert.equal(w.wants_to_stay, true)
    assert.equal(w.channel_user_id, null, 'у заявки с сайта нет id пользователя мессенджера')
    const webStatus = await run(web, { ...meta, application: { id: app.id, token: app.token } })('Моя заявка')
    assert.ok(bare(webStatus.messages[0].text).startsWith(`Заявка № ${app.id}`), webStatus.messages[0].text)
    assert.ok(webStatus.messages[0].text.includes('напишет'), 'без телефона HR пишет в мессенджер')
  })
})
