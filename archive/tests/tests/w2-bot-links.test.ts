// w2-bt-1, w2-bt-2, w2-bt-4 в PostgreSQL: заявка с сайта привязывается к боту по одноразовой ссылке start=app_<токен>,
// подписка «Напомнить о наборе» в bot_users (миграция 018), «Удалить мои данные» из бота. Время — от текущего момента.
// Запуск: pnpm test w2-bot-links (база создаётся и удаляется сама)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CONSENT_VERSION } from '../../shared/applications'
import { normalizeApplicationInput } from '../../shared/applicationInput'
import { mskToday } from '../../shared/birthDate'
import { createAssistant } from '../../server/assistant/assistant'
import { PostgresStorage } from '../../server/db'
import { createEngine } from '../../server/dialog/engine'
import { botLinkHash } from '../../server/dialog/storage'
import type { DialogEvent, DialogReply, DialogUser } from '../../server/dialog/types'
import { offlineProvider } from '../../server/llm/offline'
import { withTestDb } from './_db'

const assistant = createAssistant({ provider: offlineProvider(), log: () => {} })
const plain = (r: DialogReply) => r.messages.map((m) => m.text).join('\n\n').replace(/\*\*/g, '').replace(/[  ]/g, ' ')
const actions = (r: DialogReply) => r.messages.flatMap((m) => (m.buttons ?? []).flat()).flatMap((b) => (b.kind === 'action' ? [b.action] : []))
const [ty, tm, td] = mskToday().split('-')
const BIRTH_ISO = `${Number(ty) - 20}-${tm}-${td}`
const names = { telegram: 'ochakovo_kvasych_bot', max: 'kvasych' }

test('ссылка с сайта на бота, «Напомнить о наборе» и «Удалить мои данные» в PostgreSQL', async () => {
  await withTestDb('w2-bot-links', async (sql) => {
    const storage = new PostgresStorage(sql)
    const engine = createEngine(storage, { siteUrl: 'https://ochakovo.test', assistant })
    const send = (user: DialogUser, step: string | DialogEvent) =>
      engine.handle(user, typeof step === 'string' ? (/^[a-z]{1,3}:\S*$/.test(step) ? { type: 'action', action: step } : { type: 'text', text: step }) : step)
    const site = await storage.saveApplication(
      normalizeApplicationInput({
        name: 'Лена', lastName: 'Сайтова', phone: '+7 916 800-00-01', birthDate: BIRTH_ISO, school: 'МГУПП', startReady: 'now', vacancyId: 'lab-chemist',
        source: 'vk-ads', consent: true, consentVersion: CONSENT_VERSION, consentSource: 'site_form', game: { quizResult: null, conveyorBest: 0 },
      }),
    )

    // Ссылка: одноразовый токен, в базе — только хеш и срок 24 часа
    assert.equal(await storage.createBotLink(site.id, { telegram: null, max: null }), null, 'без подключённых ботов ссылки нет')
    const links = await storage.createBotLink(site.id, names)
    const token = /start=app_([A-Za-z0-9_-]+)$/.exec(links?.telegram ?? '')?.[1] ?? ''
    assert.ok(links?.max?.endsWith(`start=app_${token}`) && `app_${token}`.length <= 64, JSON.stringify(links))
    const [stored] = await sql<{ bot_link_hash: string; hours: number }[]>`
      select bot_link_hash, extract(epoch from bot_link_expires_at - now()) / 3600 as hours from applications where id = ${site.id}`
    assert.equal(stored.bot_link_hash, botLinkHash(token))
    assert.ok(!JSON.stringify(stored).includes(token), 'сам токен в базе не хранится')
    assert.ok(stored.hours > 23.9 && stored.hours <= 24, `срок ${stored.hours} ч`)

    const tg: DialogUser = { channel: 'telegram', id: '8001', firstName: 'Лена' }
    const linked = await send(tg, { type: 'start', payload: `app_${token}` })
    assert.ok(plain(linked).startsWith(`Заявка № ${site.id} у HR. Сообщения о ней придут сюда.`), plain(linked))
    assert.ok(!plain(linked).includes('Лена') && !plain(linked).includes('800-00-01'), 'без имени и телефона')
    const [row] = await sql<{ channel: string; source: string; bot_channel: string; bot_user_id: string; bot_link_hash: string | null }[]>`
      select channel, source, bot_channel, bot_user_id, bot_link_hash from applications where id = ${site.id}`
    assert.deepEqual(row, { channel: 'web', source: 'vk-ads', bot_channel: 'telegram', bot_user_id: '8001', bot_link_hash: null })
    const [audience] = await sql<{ source: string | null }[]>`select source from bot_users where channel = 'telegram' and user_id = '8001'`
    assert.equal(audience.source, null, 'app_<токен> не стал меткой источника')
    assert.equal((await storage.latestApplicationFor('telegram', '8001'))?.id, site.id)

    // Повторный, чужой и просроченный токен — одинаковый ответ без номера
    const other: DialogUser = { channel: 'max', id: '8002' }
    const repeat = plain(await send(other, { type: 'start', payload: `app_${token}` }))
    assert.ok(repeat.startsWith('Ссылка уже использована или устарела') && !repeat.includes(site.id), repeat)
    assert.equal(plain(await send(other, { type: 'start', payload: `app_${'B'.repeat(32)}` })), repeat)
    const again = await storage.createBotLink(site.id, names)
    await sql`update applications set bot_link_expires_at = now() - interval '1 minute' where id = ${site.id}`
    const expiredToken = /start=app_([A-Za-z0-9_-]+)$/.exec(again?.max ?? '')?.[1] ?? ''
    assert.equal(plain(await send(other, { type: 'start', payload: `app_${expiredToken}` })), repeat)
    assert.equal(await storage.latestApplicationFor('max', '8002'), null)

    // /stop отвязывает
    const stop = plain(await send(tg, '/stop'))
    assert.ok(stop.startsWith('Заявка с сайта отвязана'), stop)
    assert.equal(await storage.latestApplicationFor('telegram', '8001'), null)

    // «Напомнить о наборе»: start=remind-<метка>, направление, «Не присылать» — одной кнопкой
    const fan: DialogUser = { channel: 'telegram', id: '8003', firstName: 'Гена', username: 'gena' }
    const offer = await send(fan, { type: 'start', payload: 'remind-fair-mgupp' })
    assert.ok(plain(offer).startsWith('Напомнить о наборе'), plain(offer))
    await send(fan, 'rm:production')
    const remindRow = async () =>
      (await sql<{ source: string; remind_at: Date | null; remind_source: string | null; remind_dept: string | null; remind_off_at: Date | null }[]>`
        select source, remind_at, remind_source, remind_dept, remind_off_at from bot_users where channel = 'telegram' and user_id = '8003'`)[0]
    const on = await remindRow()
    assert.ok(on.remind_at && on.remind_off_at === null, 'подписан')
    assert.equal(on.remind_dept, 'production')
    assert.equal(on.remind_source, 'fair-mgupp', 'метка источника подписки')
    assert.equal(on.source, 'fair-mgupp', 'источник человека — исходная метка, без remind-')
    assert.ok(actions(await send(fan, { type: 'action', action: 'm' })).includes('rm:off'), 'в меню — «Не присылать о наборе»')
    // Обезличивание по сроку стирает имя и ник, подписку не трогает
    await sql`update bot_users set first_name = null, username = null where channel = 'telegram' and user_id = '8003'`
    assert.ok((await remindRow()).remind_at && (await remindRow()).remind_off_at === null)
    await send(fan, 'rm:off')
    assert.ok((await remindRow()).remind_off_at, 'отписан одной кнопкой')
    assert.ok(actions(await send(fan, { type: 'action', action: 'm' })).includes('m:remind'), 'в меню снова «Напомнить о наборе»')

    // «Удалить мои данные»: заявка из бота и привязанная с сайта обезличены, диалог удалён, аудитория не меняется
    const me: DialogUser = { channel: 'telegram', id: '8004', firstName: 'Стёпа', username: 'stepa' }
    const site2 = await storage.saveApplication(
      normalizeApplicationInput({
        name: 'Стёпа', lastName: 'Удалов', phone: '+7 916 800-00-04', birthDate: BIRTH_ISO, school: 'МГУПП', startReady: 'now',
        consent: true, consentVersion: CONSENT_VERSION, consentSource: 'site_form', game: { quizResult: null, conveyorBest: 0 },
      }),
    )
    const link2 = await storage.createBotLink(site2.id, names)
    await send(me, { type: 'start', payload: `app_${/app_(.+)$/.exec(link2!.telegram!)![1]}` })
    await send(me, 'm:remind')
    await send(me, 'rm:any')
    const audienceBefore = await storage.botAudience()
    const ask = await send(me, '/delete')
    assert.ok(actions(ask).includes('del:yes'), plain(ask))
    const done = plain(await send(me, 'del:yes'))
    assert.ok(done.startsWith('Заявки, история разговора и подписка удалены'), done)
    const [erased] = await sql<{ name: string; phone: string; anonymized_at: Date | null; bot_user_id: string | null }[]>`
      select name, phone, anonymized_at, bot_user_id from applications where id = ${site2.id}`
    assert.deepEqual({ ...erased, anonymized_at: Boolean(erased.anonymized_at) }, { name: '', phone: '', anonymized_at: true, bot_user_id: null })
    assert.equal((await sql`select 1 from sessions where channel = 'telegram' and user_id = '8004'`).length, 0, 'диалог удалён')
    const [user] = await sql<{ first_name: string | null; username: string | null; remind_at: Date | null }[]>`
      select first_name, username, remind_at from bot_users where channel = 'telegram' and user_id = '8004'`
    // Строка пользователя удаляется целиком, на её месте — обезличенный счётчик erased для отчёта аудитории
    assert.equal(user, undefined)
    assert.deepEqual(await storage.botAudience(), audienceBefore, 'отчёт аудитории не меняется')
    const [logged] = await sql<{ count: number }[]>`select count(*)::int as count from retention_log where application_id = ${site2.id} and kind = 'request'`
    assert.ok(logged.count >= 1, 'удаление записано в журнал сроков хранения')
  })
})
