// «Спросить Квасыча» на главной: фрагмент разговора — слово в слово то, что отвечает офлайн-Квасыч,
// а готовые вопросы-кнопки получают ответ по теме. Владелец во второй волне — w2-home. Запуск: pnpm test w1-home-sections

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createAssistant } from '../../server/assistant/assistant'
import { offlineProvider } from '../../server/llm/offline'

const source = readFileSync(new URL('../../src/home/BotBlock.tsx', import.meta.url), 'utf8')

/** Пары «вопрос — ответ» из BOT_SAMPLE: компонент тянет браузерные модули, поэтому читаем исходник */
function samples() {
  const start = source.indexOf('const BOT_SAMPLE')
  const end = source.indexOf('\n]', start)
  assert.ok(start >= 0 && end > start, 'в BotBlock.tsx нет BOT_SAMPLE')
  return [...source.slice(start, end).matchAll(/q:\s*'([^']+)',\s*a:\s*'([^']+)'/g)].map((m) => ({ q: m[1], a: m[2].replace(/\\n/g, '\n') }))
}

function ready() {
  const m = /const READY = \[([^\]]+)\]/.exec(source)
  assert.ok(m, 'в BotBlock.tsx нет READY')
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}

/** Неразрывные пробелы и невидимые символы типографа — в обычные пробелы, лишние пробелы — в один */
const plain = (t: string) =>
  t
    .replace(/[\u00A0\u202F]/g, ' ')
    .replace(/\u2060/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim()

const assistant = createAssistant({ provider: offlineProvider(), log: () => {} })
const ask = (question: string) => assistant.answer({ question, history: [], sessionId: 'home-botblock', channel: 'web' })

test('во фрагменте два вопроса', () => {
  assert.equal(samples().length, 2)
})

test('ответы во фрагменте — слово в слово ответ офлайн-Квасыча, с теми же абзацами', async () => {
  for (const { q, a } of samples()) {
    const reply = await ask(q)
    const paragraphs = (t: string) => t.split(/\n\s*\n/).map(plain)
    assert.deepEqual(paragraphs(a), paragraphs(reply.text), `«${q}»: на сайте одно, движок отвечает другое`)
  }
})

test('три готовых вопроса, каждый получает ответ по теме', async () => {
  const list = ready()
  assert.equal(list.length, 3)
  for (const q of list) {
    const reply = await ask(q)
    const text = plain(reply.text)
    assert.ok(text.length > 20, `«${q}»: пустой ответ`)
    assert.doesNotMatch(text, /Тут не подскажу|Точного ответа нет|не понял/i, `«${q}»: ответ не по теме — ${text.slice(0, 120)}`)
    // Выдуманных льгот нет: ДМС в материалах «Очаково» не значится
    assert.doesNotMatch(text, /ДМС/, `«${q}»: в ответе ДМС`)
  }
})

test('«Напомнить о наборе»: диплинк remind-<метка>, без метки — remind, не длиннее 64 символов', () => {
  const m = /const remindParam = \(source: string \| null \| undefined\) => \{([\s\S]+?)\n\}/.exec(source)
  assert.ok(m, 'в BotBlock.tsx нет remindParam')
  const remindParam = new Function('source', m[1]) as (s: string | null | undefined) => string
  assert.equal(remindParam('fair-mgupp'), 'remind-fair-mgupp')
  assert.equal(remindParam(null), 'remind')
  assert.equal(remindParam('ярмарка'), 'remind')
  assert.equal(remindParam('x'.repeat(80)).length, 64)
  // Кнопки напоминания — только рядом с работающими ботами: в том же блоке bots.length > 0
  const block = source.slice(source.indexOf('{bots.length > 0 && ('), source.indexOf('</section>'))
  assert.match(block, /data-remind/)
  assert.match(block, /href=\{b\.remind\}/)
})

test('диплинк бота: метка источника очищается до [A-Za-z0-9_-], без метки — site', () => {
  const m = /const startParam = \(source: string \| null \| undefined\) => (.+)\n/.exec(source)
  assert.ok(m, 'в BotBlock.tsx нет startParam')
  const startParam = new Function('source', `return ${m[1]}`) as (s: string | null | undefined) => string
  assert.equal(startParam('fair-mgupp'), 'fair-mgupp')
  assert.equal(startParam('friend-abc234'), 'friend-abc234')
  assert.equal(startParam(null), 'site')
  assert.equal(startParam('ярмарка'), 'site')
  assert.equal(startParam('vk:spring.2'), 'vkspring2')
  assert.equal(startParam('x'.repeat(80)).length, 64)
})
