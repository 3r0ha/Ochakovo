// Проверка адаптеров Telegram и MAX без настоящих токенов: фейковый HTTP API + сценарий-заглушка.
// Запуск: pnpm test:channels
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createMaxAdapter } from '../server/channels/max'
import { maxBodies, maxSendable, newTgChat, tgPlanSend, type TgCall } from '../server/channels/payload'
import { createTelegramAdapter, FOREIGN_CONTACT_PLAIN, FOREIGN_CONTACT_TEXT, PHONE_PLACEHOLDER } from '../server/channels/telegram'
import type { Button, DialogEngine, DialogEvent, DialogReply, DialogUser, OutMessage } from '../server/dialog/types'

type Hit = { method: string; url: string; headers: IncomingMessage['headers']; raw: string; json: any }
type Handler = (hit: Hit, res: ServerResponse) => void

async function fakeApi(handler: Handler) {
  const hits: Hit[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('latin1')
      let json: any = null
      if ((req.headers['content-type'] ?? '').includes('json')) json = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const hit = { method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers, raw, json }
      hits.push(hit)
      handler(hit, res)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { base, hits, close: () => new Promise<void>((r) => server.close(() => r())) }
}

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('таймаут ожидания')
    await new Promise((r) => setTimeout(r, 10))
  }
}

// 1×1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64')

const LONG = Array.from({ length: 60 }, (_, i) => `Абзац ${i + 1}. **Жирная мысль номер ${i + 1}**, а потом обычный текст про смены, зарплату и общежитие рядом с заводом.`).join('\n\n')

/** Сообщения для сверки адаптеров со сборщиками: картинка с кнопками, длинный текст, длинные ряды, контакт и сообщение после него */
const SAMPLES = (imagePath: string): OutMessage[] => {
  const eight: Button[] = Array.from({ length: 8 }, (_, i) => ({ kind: 'action', text: `К${i + 1}`, action: `k:${i + 1}` }))
  const links: Button[] = Array.from({ length: 4 }, (_, i) => ({ kind: 'link', text: `Ссылка ${i + 1}`, url: `https://example.com/${i + 1}` }))
  return [
    { text: 'Фото с линии', image: { path: imagePath }, buttons: [[{ kind: 'action', text: 'Дальше', action: 'next' }]] },
    { text: LONG, buttons: [[{ kind: 'action', text: 'Меню', action: 'm' }]] },
    { text: 'Ряды', buttons: [eight, links] },
    { text: 'Оставь телефон', input: 'phone', buttons: [[{ kind: 'contact', text: 'Отправить номер' }], [{ kind: 'action', text: 'Отмена', action: 'x' }, { kind: 'link', text: 'Политика', url: 'https://example.com/privacy' }]] },
    { text: 'Где учишься?', buttons: [[{ kind: 'action', text: 'Уже не учусь', action: 'a:nostudy' }]] },
  ]
}

function stubEngine(imagePath: string) {
  const events: { user: DialogUser; event: DialogEvent }[] = []
  const engine: DialogEngine = {
    async handle(user, event): Promise<DialogReply> {
      events.push({ user, event })
      if (event.type === 'start')
        return {
          messages: [
            {
              text: `Привет, **${user.firstName}**. Метка: ${event.payload ?? 'нет'}`,
              buttons: [[{ kind: 'action', text: 'Дальше', action: 'next' }], [{ kind: 'link', text: 'Сайт', url: 'https://example.com' }]],
            },
          ],
        }
      if (event.type === 'contact') return { messages: [{ text: `Номер ${event.phone} сохранён`, buttons: [[{ kind: 'action', text: 'В меню', action: 'menu' }]] }] }
      if (event.type === 'action') {
        if (event.action === 'next') return { notice: 'Принято', messages: [{ text: 'Второй экран', replace: true, buttons: [[{ kind: 'action', text: 'Фото', action: 'photo' }]] }] }
        if (event.action === 'photo') return { messages: [{ text: 'Фото с линии', image: { path: imagePath } }] }
        if (event.action === 'ask-contact')
          return {
            messages: [
              { text: 'Поделись номером', buttons: [[{ kind: 'contact', text: 'Отправить номер' }], [{ kind: 'action', text: 'Ввести вручную', action: 'manual' }]] },
            ],
          }
        if (event.action === 'manual') return { messages: [{ text: 'Напиши номер' }] }
        // Шаги заявки: имя — inline-кнопки, телефон — кнопка контакта и подсказка в поле ввода
        if (event.action === 'ask-name') return { messages: [{ text: 'Как тебя зовут?', input: 'name', buttons: [[{ kind: 'action', text: 'Отмена', action: 'x' }]] }] }
        if (event.action === 'ask-phone')
          return {
            messages: [
              { text: 'Оставь телефон', input: 'phone', buttons: [[{ kind: 'contact', text: 'Отправить номер' }], [{ kind: 'action', text: 'Отмена', action: 'x' }]] },
            ],
          }
      }
      if (event.type === 'text' && event.text === 'long') return { messages: [{ text: LONG }] }
      // Долгий ответ (как у помощника на GigaChat): за это время «печатает…» должно повториться
      if (event.type === 'text' && event.text === 'slow') {
        await new Promise((r) => setTimeout(r, 150))
        return { messages: [{ text: 'Готово' }] }
      }
      return { messages: [{ text: 'Эхо' }] }
    },
  }
  return { engine, events }
}

const warns: string[] = []
const silent = { info() {}, warn: (...a: unknown[]) => void warns.push(a.join(' ')), error: (...a: unknown[]) => console.error(...a) }
let passed = 0
const ok = (name: string) => {
  passed++
  console.log(`  ✓ ${name}`)
}

async function testTelegram(imagePath: string) {
  console.log('Telegram')
  let messageId = 0
  let pollCalls = 0
  let typingFails = false
  const api = await fakeApi((hit, res) => {
    const method = hit.url.split('/').pop()!
    if (method === 'sendChatAction' && typingFails) return send(res, 400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' })
    if (method === 'getUpdates') {
      pollCalls++
      const updates =
        pollCalls === 1 ? [{ update_id: 100, message: { message_id: 1, from: { id: 5, first_name: 'Поллинг' }, chat: { id: 5, type: 'private' }, text: '/start' } }] : []
      return setTimeout(() => send(res, 200, { ok: true, result: updates }), pollCalls === 1 ? 0 : 50)
    }
    if (method === 'sendMessage' || method === 'sendPhoto') {
      return send(res, 200, { ok: true, result: { message_id: ++messageId, chat: { id: 42, type: 'private' }, photo: method === 'sendPhoto' ? [{ file_id: 'small' }, { file_id: 'FILE_BIG' }] : undefined } })
    }
    send(res, 200, { ok: true, result: true })
  })
  const { engine, events } = stubEngine(imagePath)
  const tg = createTelegramAdapter('T0KEN', { apiBase: api.base, log: silent, typingInterval: 40 })
  const from = { id: 42, first_name: 'Даня', username: 'danya' }
  const chat = { id: 42, type: 'private' }
  const methods = () => api.hits.map((h) => h.url.split('/').pop())
  const last = (m: string) => [...api.hits].reverse().find((h) => h.url.endsWith('/' + m))!

  // Старт с меткой
  await tg.handleWebhook(engine, { update_id: 1, message: { message_id: 10, from, chat, text: '/start fair-mgupp' } })
  assert.deepEqual(events.at(-1)!.event, { type: 'start', payload: 'fair-mgupp' })
  assert.deepEqual(events.at(-1)!.user, { channel: 'telegram', id: '42', firstName: 'Даня', username: 'danya' })
  assert.ok(last('sendMessage').url.includes('/botT0KEN/'))
  assert.deepEqual(last('sendMessage').json, {
    chat_id: '42',
    text: 'Привет, <b>Даня</b>. Метка: fair-mgupp',
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: 'Дальше', callback_data: 'next' }], [{ text: 'Сайт', url: 'https://example.com' }]] },
  })
  ok('start с меткой → sendMessage с inline-кнопками')

  // Нажатие с заменой сообщения
  api.hits.length = 0
  await tg.handleWebhook(engine, { update_id: 2, callback_query: { id: 'cb1', from, data: 'next', message: { message_id: 1, chat, text: 'Привет' } } })
  assert.deepEqual(events.at(-1)!.event, { type: 'action', action: 'next' })
  assert.deepEqual(methods(), ['answerCallbackQuery', 'editMessageText'])
  assert.deepEqual(api.hits[0].json, { callback_query_id: 'cb1', text: 'Принято' })
  assert.deepEqual(api.hits[1].json, {
    chat_id: '42',
    message_id: 1,
    text: 'Второй экран',
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: 'Фото', callback_data: 'photo' }]] },
  })
  ok('callback с replace → answerCallbackQuery + editMessageText')

  // Фото: первая отправка multipart, вторая — по file_id
  api.hits.length = 0
  await tg.handleWebhook(engine, { update_id: 3, callback_query: { id: 'cb2', from, data: 'photo', message: { message_id: 2, chat, text: 'x' } } })
  await tg.handleWebhook(engine, { update_id: 4, callback_query: { id: 'cb3', from, data: 'photo', message: { message_id: 2, chat, text: 'x' } } })
  const photos = api.hits.filter((h) => h.url.endsWith('/sendPhoto'))
  assert.equal(photos.length, 2)
  assert.match(photos[0].headers['content-type'] ?? '', /multipart\/form-data/)
  assert.match(photos[0].raw, /name="photo"; filename="pixel\.png"/)
  assert.match(photos[0].raw, /name="caption"/)
  assert.deepEqual(photos[1].json, { chat_id: '42', photo: 'FILE_BIG', caption: 'Фото с линии', parse_mode: 'HTML' })
  ok('фото: multipart один раз, дальше file_id из кэша')

  // Запрос контакта: reply-клавиатура, текст кнопки → action, затем ReplyKeyboardRemove
  api.hits.length = 0
  await tg.handleWebhook(engine, { update_id: 5, callback_query: { id: 'cb4', from, data: 'ask-contact', message: { message_id: 3, chat, text: 'x' } } })
  assert.deepEqual(last('sendMessage').json.reply_markup, {
    keyboard: [[{ text: 'Отправить номер', request_contact: true }], [{ text: 'Ввести вручную' }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  })
  await tg.handleWebhook(engine, { update_id: 6, message: { message_id: 11, from, chat, text: 'Ввести вручную' } })
  assert.deepEqual(events.at(-1)!.event, { type: 'action', action: 'manual' })
  assert.deepEqual(last('sendMessage').json.reply_markup, { remove_keyboard: true })
  ok('контакт: reply-клавиатура, текстовая кнопка приходит как action, клавиатура убирается')

  api.hits.length = 0
  await tg.handleWebhook(engine, { update_id: 7, callback_query: { id: 'cb5', from, data: 'ask-contact', message: { message_id: 4, chat, text: 'x' } } })
  await tg.handleWebhook(engine, { update_id: 8, message: { message_id: 12, from, chat, contact: { phone_number: '79991234567', user_id: 42 } } })
  assert.deepEqual(events.at(-1)!.event, { type: 'contact', phone: '+79991234567' })
  const afterContact = api.hits.slice(-2)
  assert.deepEqual(afterContact[0].json, { chat_id: '42', text: 'Номер +79991234567 сохранён', parse_mode: 'HTML', reply_markup: { remove_keyboard: true } })
  assert.ok(afterContact[1].url.endsWith('/editMessageReplyMarkup'))
  assert.deepEqual(afterContact[1].json.reply_markup, { inline_keyboard: [[{ text: 'В меню', callback_data: 'menu' }]] })
  ok('контакт получен → ReplyKeyboardRemove + inline-кнопки правкой')

  // Длинный текст режется на части ≤ 4096, жирный не рвётся
  api.hits.length = 0
  await tg.handleWebhook(engine, { update_id: 9, message: { message_id: 13, from, chat, text: 'long' } })
  const parts = api.hits.filter((h) => h.url.endsWith('/sendMessage'))
  assert.ok(parts.length >= 2, 'ожидалось несколько сообщений')
  for (const p of parts) {
    assert.ok(p.json.text.length <= 4096)
    assert.equal((p.json.text.match(/<b>/g) ?? []).length, (p.json.text.match(/<\/b>/g) ?? []).length)
  }
  ok(`длинный текст → ${parts.length} сообщения по ≤ 4096 символов`)

  // Шаг телефона: reply-клавиатура с подсказкой в поле ввода; шаг имени — inline-кнопки без подсказки
  api.hits.length = 0
  await tg.handleWebhook(engine, { update_id: 20, callback_query: { id: 'cb20', from, data: 'ask-name', message: { message_id: 5, chat, text: 'x' } } })
  assert.deepEqual(last('sendMessage').json, {
    chat_id: '42',
    text: 'Как тебя зовут?',
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: 'Отмена', callback_data: 'x' }]] },
  })
  await tg.handleWebhook(engine, { update_id: 21, callback_query: { id: 'cb21', from, data: 'ask-phone', message: { message_id: 6, chat, text: 'x' } } })
  assert.equal(PHONE_PLACEHOLDER, 'Телефон или @ник')
  assert.deepEqual(last('sendMessage').json, {
    chat_id: '42',
    text: 'Оставь телефон',
    parse_mode: 'HTML',
    reply_markup: {
      keyboard: [[{ text: 'Отправить номер', request_contact: true }], [{ text: 'Отмена' }]],
      resize_keyboard: true,
      one_time_keyboard: true,
      input_field_placeholder: 'Телефон или @ник',
    },
  })
  ok('шаг телефона: input_field_placeholder «Телефон или @ник» вместе с reply-клавиатурой, у шага имени подсказки нет')

  // Чужой контакт не принимается: движок его не видит, клавиатура с кнопкой контакта показывается снова
  api.hits.length = 0
  const before = events.length
  await tg.handleWebhook(engine, { update_id: 22, message: { message_id: 14, from, chat, contact: { phone_number: '79990000001', user_id: 77 } } })
  await tg.handleWebhook(engine, { update_id: 23, message: { message_id: 15, from, chat, contact: { phone_number: '79990000002' } } })
  assert.equal(events.length, before, 'чужой контакт дошёл до движка')
  const refusals = api.hits.filter((h) => h.url.endsWith('/sendMessage'))
  assert.equal(refusals.length, 2)
  for (const r of refusals) {
    assert.equal(r.json.text, FOREIGN_CONTACT_TEXT)
    assert.equal(r.json.reply_markup.keyboard[0][0].request_contact, true)
    assert.equal(r.json.reply_markup.input_field_placeholder, 'Телефон или @ник')
  }
  assert.ok(!JSON.stringify(api.hits).includes('79990000001'), 'чужой номер ушёл в ответ')
  await tg.handleWebhook(engine, { update_id: 24, message: { message_id: 16, from, chat, contact: { phone_number: '+7 999 123-45-67', user_id: 42 } } })
  assert.deepEqual(events.at(-1)!.event, { type: 'contact', phone: '+79991234567' })
  ok('чужой контакт и контакт без user_id не принимаются, свой — принимается')

  // Без reply-клавиатуры на экране отказ — без упоминания кнопки
  api.hits.length = 0
  await tg.handleWebhook(engine, { update_id: 25, message: { message_id: 17, from, chat, contact: { phone_number: '79990000003', user_id: 78 } } })
  assert.deepEqual(last('sendMessage').json, { chat_id: '42', text: FOREIGN_CONTACT_PLAIN })
  ok('чужой контакт вне шага телефона — короткий отказ без клавиатуры')

  // Только личный чат с самим отправителем: подмена chat.id, группы и чужие нажатия до движка не доходят
  api.hits.length = 0
  const count = events.length
  const stranger = { id: 111, first_name: 'Чужой' }
  await tg.handleWebhook(engine, { update_id: 30, message: { message_id: 20, from: stranger, chat: { id: 999, type: 'private' }, text: 'что с моей заявкой' } })
  await tg.handleWebhook(engine, { update_id: 31, message: { message_id: 21, from: stranger, chat: { id: -100500, type: 'supergroup' }, text: '/start' } })
  await tg.handleWebhook(engine, { update_id: 32, message: { message_id: 22, from: stranger, chat: { id: 111, type: 'group' }, text: 'привет' } })
  await tg.handleWebhook(engine, { update_id: 33, callback_query: { id: 'cb30', from: stranger, data: 'next', message: { message_id: 1, chat: { id: 999, type: 'private' }, text: 'x' } } })
  await tg.handleWebhook(engine, { update_id: 34, message: { message_id: 23, from: stranger, chat: { id: 999, type: 'private' }, contact: { phone_number: '79991112233', user_id: 111 } } })
  assert.equal(events.length, count, 'апдейт из чужого чата дошёл до движка')
  assert.deepEqual(methods(), [], 'бот ответил в чужой чат')
  ok('from=111, chat=999, группы и чужие нажатия: движок не вызван, sendMessage нет')

  // «Печатает…»: sendChatAction раньше ответа и повторяется, пока ответ готовится
  api.hits.length = 0
  await tg.handleWebhook(engine, { update_id: 40, message: { message_id: 30, from, chat, text: 'slow' } })
  const order = methods()
  const firstAnswer = order.indexOf('sendMessage')
  const typing = order.filter((m, i) => m === 'sendChatAction' && i < firstAnswer)
  assert.equal(order[0], 'sendChatAction')
  assert.ok(typing.length >= 2, `«печатает…» не повторилось: ${order.join(', ')}`)
  assert.ok(!order.slice(firstAnswer).includes('sendChatAction'), '«печатает…» после ответа')
  assert.deepEqual(api.hits[0].json, { chat_id: '42', action: 'typing' })
  ok(`«печатает…»: ${typing.length} sendChatAction до sendMessage, после ответа — ни одного`)

  // Нажатия и /start идут без «печатает…»
  api.hits.length = 0
  await tg.handleWebhook(engine, { update_id: 41, message: { message_id: 31, from, chat, text: '/start' } })
  assert.ok(!methods().includes('sendChatAction'))
  ok('/start и кнопки без «печатает…»')

  // Сбой «печатает…» не мешает ответу
  api.hits.length = 0
  typingFails = true
  warns.length = 0
  await tg.handleWebhook(engine, { update_id: 42, message: { message_id: 32, from, chat, text: 'привет' } })
  typingFails = false
  assert.equal(methods()[0], 'sendChatAction')
  assert.equal(warns.filter((w) => w.startsWith('[telegram] sendChatAction')).length, 1, warns.join('\n'))
  assert.deepEqual(last('sendMessage').json, { chat_id: '42', text: 'Эхо', parse_mode: 'HTML' })
  ok('ошибка sendChatAction записана в журнал, ответ ушёл')

  // Сборщики: адаптер отправляет ровно то, что собирает tgPlanSend (им же пользуется предпросмотр в HR-панели)
  api.hits.length = 0
  const plan: TgCall[] = []
  const chatPlan = newTgChat()
  for (const m of SAMPLES(imagePath)) plan.push(...tgPlanSend('77', m, chatPlan))
  await tg.sendTo('77', SAMPLES(imagePath))
  assert.deepEqual(methods(), plan.map((c) => c.method))
  plan.forEach((c, i) => {
    const hit = api.hits[i]
    if (c.method === 'sendPhoto') {
      // Картинка уже в кэше адаптера (file_id) — тело JSON; поля плана те же
      assert.deepEqual(hit.json, { ...c.body, photo: 'FILE_BIG' })
    } else if (c.method === 'editMessageReplyMarkup') {
      assert.deepEqual({ ...hit.json, message_id: undefined }, { ...c.body, message_id: undefined })
    } else assert.deepEqual(hit.json, c.body, `${c.method} №${i}`)
  })
  ok(`сборщик tgPlanSend: ${plan.length} запросов адаптера совпали с планом (кнопки, части, картинка, reply-клавиатура, ссылки)`)

  // Long polling: событие из getUpdates, offset сдвигается, остановка по сигналу
  api.hits.length = 0
  const ctrl = new AbortController()
  const loop = tg.startPolling(engine, ctrl.signal)
  await until(() => events.some((e) => e.user.id === '5'))
  await until(() => api.hits.filter((h) => h.url.endsWith('/getUpdates')).length >= 2)
  ctrl.abort()
  await loop
  const polls = api.hits.filter((h) => h.url.endsWith('/getUpdates'))
  assert.equal(polls[0].json.offset, 0)
  assert.equal(polls[1].json.offset, 101)
  ok('long polling: событие доставлено, offset сдвинут, остановка по AbortSignal')

  await api.close()
}

async function testMax(imagePath: string) {
  console.log('MAX')
  let notReadyOnce = true
  let pollCalls = 0
  let typingFails = false
  const api = await fakeApi((hit, res) => {
    const u = new URL(hit.url, 'http://x')
    if (/^\/chats\/-?\d+\/actions$/.test(u.pathname)) return typingFails ? send(res, 500, { code: 'internal', message: 'Internal error' }) : send(res, 200, { success: true })
    if (u.pathname === '/updates') {
      pollCalls++
      const body =
        pollCalls === 1
          ? { updates: [{ update_type: 'bot_started', user: { user_id: 9, first_name: 'Поллинг' }, payload: null }], marker: 77 }
          : { updates: [], marker: 77 }
      return setTimeout(() => send(res, 200, body), pollCalls === 1 ? 0 : 50)
    }
    if (u.pathname === '/uploads') return send(res, 200, { url: `${api.base}/upload-slot` })
    if (u.pathname === '/upload-slot') return send(res, 200, { photos: { p1: { token: 'IMG_TOKEN' } } })
    if (u.pathname === '/messages') {
      if (JSON.stringify(hit.json).includes('IMG_TOKEN') && notReadyOnce) {
        notReadyOnce = false
        return send(res, 400, { code: 'attachment.not.ready', message: 'Key: errors.process.attachment.file.not.processed' })
      }
      return send(res, 200, { message: { body: { mid: 'mid.1' } } })
    }
    send(res, 200, { success: true })
  })
  const { engine, events } = stubEngine(imagePath)
  const max = createMaxAdapter('MAX_T0KEN', { apiBase: api.base, log: silent, chatInterval: 0, pollDelay: 10, typingInterval: 40 })
  const user = { user_id: 7, first_name: 'Алиса', username: 'alisa' }
  const paths = () => api.hits.map((h) => new URL(h.url, 'http://x').pathname)
  const kb = (buttons: unknown) => ({ type: 'inline_keyboard', payload: { buttons } })

  // bot_started с меткой
  await max.handleWebhook(engine, { update_type: 'bot_started', timestamp: 1, chat_id: 70, user, payload: 'vk' })
  assert.deepEqual(events.at(-1)!.event, { type: 'start', payload: 'vk' })
  assert.deepEqual(events.at(-1)!.user, { channel: 'max', id: '7', firstName: 'Алиса', username: 'alisa' })
  const first = api.hits.at(-1)!
  assert.equal(first.url, '/messages?user_id=7')
  assert.equal(first.headers.authorization, 'MAX_T0KEN')
  assert.deepEqual(first.json, {
    text: 'Привет, <b>Алиса</b>. Метка: vk',
    format: 'html',
    attachments: [kb([[{ type: 'callback', text: 'Дальше', payload: 'next' }], [{ type: 'link', text: 'Сайт', url: 'https://example.com' }]])],
  })
  ok('bot_started с payload → POST /messages с inline_keyboard, токен в Authorization')

  // Нажатие с заменой — одним вызовом /answers
  api.hits.length = 0
  await max.handleWebhook(engine, { update_type: 'message_callback', callback: { callback_id: 'c1', payload: 'next', user }, message: {} })
  assert.deepEqual(events.at(-1)!.event, { type: 'action', action: 'next' })
  assert.deepEqual(paths(), ['/answers'])
  assert.equal(api.hits[0].url, '/answers?callback_id=c1')
  assert.deepEqual(api.hits[0].json, {
    notification: 'Принято',
    message: { text: 'Второй экран', format: 'html', attachments: [kb([[{ type: 'callback', text: 'Фото', payload: 'photo' }]])] },
  })
  ok('callback с replace → один POST /answers (notification + message)')

  // Фото: загрузка один раз, повтор при attachment.not.ready, дальше токен из кэша
  api.hits.length = 0
  await max.handleWebhook(engine, { update_type: 'message_callback', callback: { callback_id: 'c2', payload: 'photo', user }, message: {} })
  assert.deepEqual(paths(), ['/uploads', '/upload-slot', '/messages', '/messages'])
  assert.equal(api.hits[0].url, '/uploads?type=image')
  assert.match(api.hits[1].raw, /name="data"; filename="pixel\.png"/)
  assert.equal(api.hits[1].headers.authorization, undefined)
  assert.deepEqual(api.hits[3].json, { text: 'Фото с линии', format: 'html', attachments: [{ type: 'image', payload: { token: 'IMG_TOKEN' } }] })
  api.hits.length = 0
  await max.handleWebhook(engine, { update_type: 'message_callback', callback: { callback_id: 'c3', payload: 'photo', user }, message: {} })
  assert.deepEqual(paths(), ['/messages'])
  ok('фото: /uploads → multipart data → токен, повтор при not.ready, затем кэш')

  // Контакт: request_contact в inline-клавиатуре, vCard → телефон
  api.hits.length = 0
  await max.handleWebhook(engine, { update_type: 'message_callback', callback: { callback_id: 'c4', payload: 'ask-contact', user }, message: {} })
  assert.deepEqual(api.hits.at(-1)!.json.attachments, [
    kb([[{ type: 'request_contact', text: 'Отправить номер' }], [{ type: 'callback', text: 'Ввести вручную', payload: 'manual' }]]),
  ])
  await max.handleWebhook(engine, {
    update_type: 'message_created',
    message: {
      sender: user,
      recipient: { chat_id: 70, chat_type: 'dialog' },
      body: { mid: 'mid.2', text: null, attachments: [{ type: 'contact', payload: { vcf_info: 'BEGIN:VCARD\\r\\nVERSION:3.0\\r\\nFN:Алиса\\r\\nTEL;TYPE=cell:79991234567\\r\\nEND:VCARD' } }] },
    },
  })
  assert.deepEqual(events.at(-1)!.event, { type: 'contact', phone: '+79991234567' })
  ok('контакт: кнопка request_contact, телефон из vcf_info')

  // Длинный текст — несколько сообщений ≤ 4000, кнопки только у последнего
  api.hits.length = 0
  await max.handleWebhook(engine, { update_type: 'message_created', message: { sender: user, recipient: { chat_type: 'dialog' }, body: { text: 'long' } } })
  const sent = api.hits.filter((h) => h.url.startsWith('/messages'))
  assert.ok(sent.length >= 2)
  for (const s of sent) {
    assert.ok(s.json.text.length <= 4000)
    assert.equal((s.json.text.match(/<b>/g) ?? []).length, (s.json.text.match(/<\/b>/g) ?? []).length)
  }
  ok(`длинный текст → ${sent.length} сообщения по ≤ 4000 символов`)

  // «Печатает…»: typing_on в chat_id из recipient раньше ответа
  api.hits.length = 0
  await max.handleWebhook(engine, { update_type: 'message_created', message: { sender: user, recipient: { chat_id: 70, chat_type: 'dialog' }, body: { mid: 'mid.3', text: 'slow' } } })
  const order = paths()
  const firstAnswer = order.indexOf('/messages')
  assert.equal(order[0], '/chats/70/actions')
  assert.deepEqual(api.hits[0].json, { action: 'typing_on' })
  assert.equal(api.hits[0].headers.authorization, 'MAX_T0KEN')
  assert.ok(firstAnswer > 0 && !order.slice(firstAnswer).includes('/chats/70/actions'), order.join(', '))
  assert.deepEqual(api.hits[firstAnswer].json, { text: 'Готово', format: 'html', attachments: [] })
  ok('«печатает…»: POST /chats/70/actions {typing_on} раньше /messages')

  // Сбой typing_on не отменяет ответ
  api.hits.length = 0
  typingFails = true
  warns.length = 0
  await max.handleWebhook(engine, { update_type: 'message_created', message: { sender: user, recipient: { chat_id: 70, chat_type: 'dialog' }, body: { mid: 'mid.4', text: 'привет' } } })
  typingFails = false
  assert.equal(warns.filter((w) => w.startsWith('[max] typing_on')).length, 1, warns.join('\n'))
  assert.deepEqual(paths(), ['/chats/70/actions', '/messages'])
  assert.equal(api.hits[1].json.text, 'Эхо')
  ok('ошибка typing_on записана в журнал, ответ ушёл')

  // Сборщики: адаптер отправляет ровно то, что собирает maxBodies (им же пользуется предпросмотр в HR-панели)
  api.hits.length = 0
  await max.sendTo('7', SAMPLES(imagePath))
  const planned = SAMPLES(imagePath).flatMap((m) => maxBodies(m, m.image ? 'IMG_TOKEN' : null).filter(maxSendable))
  const posted = api.hits.filter((h) => h.url.startsWith('/messages'))
  assert.deepEqual(
    posted.map((h) => h.json),
    planned,
  )
  for (const body of planned)
    for (const a of body.attachments)
      if (a.type === 'inline_keyboard') for (const row of a.payload.buttons) assert.ok(row.length <= (row.some((b) => b.type !== 'callback') ? 3 : 7))
  ok(`сборщик maxBodies: ${planned.length} сообщений адаптера совпали с планом, ряды не длиннее 7 (ссылки и контакт — 3)`)

  // Long polling с маркером
  api.hits.length = 0
  const ctrl = new AbortController()
  const loop = max.startPolling(engine, ctrl.signal)
  await until(() => events.some((e) => e.user.id === '9'))
  await until(() => api.hits.filter((h) => h.url.startsWith('/updates')).length >= 2)
  ctrl.abort()
  await loop
  const polls = api.hits.filter((h) => h.url.startsWith('/updates')).map((h) => new URL(h.url, 'http://x').searchParams)
  assert.equal(polls[0].get('marker'), null)
  assert.equal(polls[0].get('types'), 'bot_started,message_created,message_callback')
  assert.equal(polls[1].get('marker'), '77')
  ok('long polling: маркер передаётся, остановка по AbortSignal')

  // Вебхук-подписка
  api.hits.length = 0
  const hooked = createMaxAdapter('MAX_T0KEN', { apiBase: api.base, log: silent, secret: 'sec_123' })
  await hooked.setWebhook('https://bot.example.ru/bots/max')
  assert.deepEqual(api.hits[0].json, { url: 'https://bot.example.ru/bots/max', update_types: ['bot_started', 'message_created', 'message_callback'], secret: 'sec_123' })
  ok('setWebhook → POST /subscriptions с secret')

  await api.close()
}

const dir = await mkdtemp(path.join(tmpdir(), 'ochakovo-channels-'))
const imagePath = path.join(dir, 'pixel.png')
await writeFile(imagePath, PNG)

try {
  await testTelegram(imagePath)
  await testMax(imagePath)
  console.log(`\nВсе проверки пройдены: ${passed}`)
} catch (e) {
  console.error('\nПРОВАЛ:', e)
  process.exit(1)
}
