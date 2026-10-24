// Бот без личных данных в журнале и без sharp: сбой сценария пишет только канал, тип события и кнопку,
// а без модуля картинок бот отвечает текстом. Запуск: pnpm test w1-bot-ops

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { createAssistant } from '../../server/assistant/assistant'
import { createEngine } from '../../server/dialog/engine'
import { configureImages } from '../../server/dialog/images'
import { memoryStorage, type Storage } from '../../server/dialog/storage'
import type { DialogEvent, DialogReply, DialogUser } from '../../server/dialog/types'
import { offlineProvider } from '../../server/llm/offline'
import { mskToday } from '../../shared/birthDate'

const assistant = createAssistant({ provider: offlineProvider(), log: () => {} })

/** Всё, что ушло в console.* за время fn */
async function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = []
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const
  const saved = methods.map((m) => console[m])
  for (const m of methods) console[m] = (...args: unknown[]) => void lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
  try {
    return { result: await fn(), lines }
  } finally {
    methods.forEach((m, i) => (console[m] = saved[i]))
  }
}

const textOf = (r: DialogReply) => r.messages.map((m) => m.text).join('\n\n')

/** Дата рождения 20 лет назад от сегодняшнего дня по Москве: ДД.ММ.ГГГГ */
const adultBirthDate = () => {
  const [y, m, d] = mskToday().split('-')
  return `${d}.${m}.${Number(y) - 20}`
}

test('сбой при сохранении заявки: в журнале канал, тип события и кнопка, без имени, телефона и id', async () => {
  const PHONE = '+79161234567'
  const NAME = 'Секретная Анна'
  const base = memoryStorage()
  // База отвечает ошибкой, в тексте которой — данные заявки, как у настоящего драйвера при нарушении ограничения
  const broken: Storage = {
    ...base,
    async saveApplication(input) {
      throw new Error(`duplicate key: phone=${input.phone} name=${input.name}\nподробности: ${input.name}`)
    },
  }
  const engine = createEngine(broken, { siteUrl: 'https://ochakovo.test', assistant })
  const user: DialogUser = { channel: 'telegram', id: '700100200', firstName: 'Анна', username: 'secret_anna' }
  const send = (event: DialogEvent) => engine.handle(user, event)

  await send({ type: 'action', action: 'a:start' })
  await send({ type: 'text', text: adultBirthDate() })
  await send({ type: 'text', text: NAME })
  await send({ type: 'text', text: '8 916 123-45-67' })
  await send({ type: 'text', text: 'Колледж' })
  await send({ type: 'action', action: 'a:mdone' })
  await send({ type: 'action', action: 'a:sr:now' })
  await send({ type: 'action', action: 'a:v:any' })
  const { result, lines } = await captureConsole(() => send({ type: 'action', action: 'a:ok' }))

  assert.ok(textOf(result).startsWith('Что-то пошло не так'), 'человек получает меню после сбоя')
  const log = lines.join('\n')
  assert.ok(log.includes('[dialog]'), `сбой записан: ${log}`)
  assert.ok(log.includes('telegram') && log.includes('"event":"action"') && log.includes('a:ok'), `канал, тип события и кнопка в журнале: ${log}`)
  for (const secret of [PHONE, '9161234567', 'Секретная', 'Анна', '700100200', 'secret_anna', 'duplicate key', 'подробности']) {
    assert.ok(!log.includes(secret), `в журнале нет «${secret}»: ${log}`)
  }
})

test('сбой на текстовом шаге: текст сообщения в журнал не попадает', async () => {
  const base = memoryStorage()
  const engine = createEngine(base, {
    siteUrl: 'https://ochakovo.test',
    // Помощник падает с текстом вопроса в ошибке
    assistant: {
      mode: 'offline',
      async answer(input) {
        throw new Error(`не разобрал: ${input.question}`)
      },
    },
  })
  const user: DialogUser = { channel: 'max', id: '42' }
  const question = 'сколько платят, мой номер 89991112233'
  const { result, lines } = await captureConsole(() => engine.handle(user, { type: 'text', text: question }))
  assert.ok(textOf(result).startsWith('Что-то пошло не так'))
  const log = lines.join('\n')
  assert.ok(log.includes('max') && log.includes('"event":"text"'), log)
  assert.ok(!log.includes('89991112233') && !log.includes('сколько платят') && !log.includes('не разобрал'), log)
})

test('без sharp бот отвечает текстом: приветствие, вакансия, «Путь кваса», игра зовёт на сайт', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'w1-bot-nosharp-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  configureImages({ loadSharp: () => Promise.reject(new Error('Cannot find module sharp')), cacheDir: dir })
  const engine = createEngine(memoryStorage(), { siteUrl: 'https://ochakovo.test', assistant })
  const user: DialogUser = { channel: 'telegram', id: 'nosharp', firstName: 'Боря' }

  const { result: start, lines } = await captureConsole(() => engine.handle(user, { type: 'start' }))
  assert.equal(start.messages.length, 2)
  assert.ok(start.messages[0].text.startsWith('Привет, я Квасыч'), 'приветствие текстом')
  assert.equal(start.messages[0].image, undefined, 'без картинки')
  assert.equal(lines.filter((l) => l.includes('картинки для ботов не рисуются')).length, 1, 'одно предупреждение в журнале')

  const vacancy = await engine.handle(user, { type: 'action', action: 'v:open:bottling-operator' })
  assert.ok(vacancy.messages[0].text.includes('Оператор линии розлива') && !vacancy.messages[0].image)

  const tour = await engine.handle(user, { type: 'action', action: 'm:tour' })
  assert.ok(tour.messages[0].text.includes('Путь кваса · 1 из') && !tour.messages[0].image)

  const myth = await engine.handle(user, { type: 'action', action: 'm:myth' })
  assert.ok(myth.messages[0].text.includes('Правда или миф · 1 из') && !myth.messages[0].image)

  const game = await engine.handle(user, { type: 'action', action: 'g:go' })
  const links = game.messages.flatMap((m) => m.buttons?.flat() ?? []).filter((b) => b.kind === 'link')
  assert.ok(game.messages[0].text.startsWith('Картинки раундов сейчас не загружаются'), textOf(game))
  assert.ok(links.some((b) => b.kind === 'link' && b.url === 'https://ochakovo.test/game?src=telegram'), 'ссылка на игру на сайте')
  const session = await engine.handle(user, { type: 'action', action: 'g:0:1' })
  assert.ok(session.messages.length > 0, 'кнопка без игры не роняет бота')
})

test('с sharp картинки снова рисуются в новый кэш', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'w1-bot-sharp-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  configureImages({ cacheDir: dir })
  const engine = createEngine(memoryStorage(), { siteUrl: 'https://ochakovo.test', assistant })
  const game = await engine.handle({ channel: 'telegram', id: 'sharp' }, { type: 'action', action: 'g:go' })
  const path = game.messages[0].image?.path ?? ''
  assert.ok(path.startsWith(dir), path)
})

after(() => configureImages())
