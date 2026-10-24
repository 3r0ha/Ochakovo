// Секции главной говорят то же, что данные и чат: график, деньги за смену, факты без усиления.
// После полного кейса (docs/case-delta.md): корпоративный автобус и «за счёт компании» про медосмотр — факты справочника студента,
// ДМС в материалах «Очаково» нет. Владелец во второй волне — w2-home. Запуск: pnpm test w1-home-sections

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { contacts } from '../../shared/content/content'
import { faq } from '../../shared/content/faq'
import { handbookText } from '../../shared/content/handbook'
import { formatRub, scheduleByUnit, scheduleNote, scheduleSummary, shiftHours, shiftPay, vacancyById } from '../../shared/content/vacancies'
import { createAssistant } from '../../server/assistant/assistant'
import { offlineProvider } from '../../server/llm/offline'

const files = [
  'Money.tsx',
  'Conditions.tsx',
  'VacancyList.tsx',
  'BotBlock.tsx',
  'ProductionPath.tsx',
  'MythSection.tsx',
  'QuizSection.tsx',
  'GameSection.tsx',
  'Faq.tsx',
  'tasks.ts',
  'Practice.tsx',
  'ShiftInside.tsx',
  'History.tsx',
  'Mentors.tsx',
  'KnowledgeCheck.tsx',
  'QcFragment.tsx',
  'Pictogram.tsx',
  'legend.ts',
]
const read = (name: string) => readFileSync(new URL(`../../src/home/${name}`, import.meta.url), 'utf8')

const plain = (t: string) =>
  t
    .replace(/[  ]/g, ' ')
    .replace(/⁠/g, '')
    .replace(/\s+/g, ' ')
    .trim()

const assistant = createAssistant({ provider: offlineProvider(), log: () => {} })
const ask = async (question: string) => plain((await assistant.answer({ question, history: [], sessionId: 'home-facts', channel: 'web' })).text)

test('в секциях нет неподтверждённых фактов, GSAP и дат', () => {
  for (const name of files) {
    const text = read(name)
    for (const bad of [/ДМС/, /дают общежитие/i, /бесплатн\S* жиль/i, /первые в СССР/i, /квест/i, /бонус/i, /прототип/i, /сезонн\S* работ/i, /стажир/i])
      assert.doesNotMatch(text, bad, `${name}: ${bad}`)
    assert.doesNotMatch(text, /from 'gsap|@gsap\/|useGSAP|\bgsap\./, `${name}: GSAP`)
    assert.doesNotMatch(text, /\b(19[5-9]\d|20[0-9]\d)\b/, `${name}: похоже на год или дату`)
  }
})

test('«Условия»: деньги, график, учёба, документы и дорога — текстами справочника студента и shared', () => {
  const text = read('Conditions.tsx')
  assert.match(text, /Рябиновая, 44/)
  assert.match(text, /scheduleSummary\.title/)
  // График — таблицей из тех же частей, из которых собран ответ чата (scheduleSummary.text)
  for (const part of ['shiftHours', 'scheduleByUnit', 'scheduleNote']) assert.match(text, new RegExp(part))
  assert.equal(scheduleSummary.text, `${shiftHours} ${scheduleByUnit.map((s) => `${s.where}: ${s.text}`).join('; ')}. ${scheduleNote}`)
  assert.match(text, /contacts\.route/)
  for (const id of ['payday', 'exams', 'practice-docs']) {
    assert.match(text, new RegExp(`handbookText\\('${id}'\\)`), `строка «Условий» из справочника: ${id}`)
    assert.ok(handbookText(id as 'payday').trim(), `пустой текст справочника: ${id}`)
  }
  // Справочник студента: «от м. Озёрная ходит корпоративный автобус» — первым в маршруте
  assert.match(contacts.route, /^От м\. «Озёрная» ходит корпоративный автобус/)
  // Что даёт компания — в блоке «Практика», в «Условиях» не повторяется; ДМС нигде нет
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
  assert.doesNotMatch(code, /perkLine|ДМС|общежит/i)
  // Абзацы приглушённым цветом вместо таблицы — нет
  assert.doesNotMatch(text, /text-mute|text-ink\/75/)
})

test('«Условия» и чат отвечают на «какой график» одним текстом', async () => {
  const reply = await ask('какой график')
  assert.ok(reply.includes(plain(scheduleSummary.text)), `чат: ${reply.slice(0, 200)}`)
})

test('«Собери лето»: деньги за смену и в час есть у всех трёх должностей и совпадают с чатом', async () => {
  const money = read('Money.tsx')
  const ids = [...money.slice(money.indexOf('const roles'), money.indexOf('const SUMMER')).matchAll(/id: '([a-z-]+)'/g)].map((m) => m[1])
  // Три должности 2/2 по 12 часов с суммой из источника: две роли оплачиваемой практики и фирменный магазин
  assert.deepEqual(ids, ['fermentation-assistant', 'lab-chemist', 'store-worker'])
  for (const id of ids) assert.ok(vacancyById(id), `в вакансиях нет ${id}`)
  const questions: Record<string, string> = {
    'fermentation-assistant': 'Сколько платят за смену в технологическом цехе?',
    'lab-chemist': 'Сколько за смену получает лаборант?',
    'store-worker': 'Сколько в час платят в фирменном магазине?',
  }
  for (const id of ids) {
    const v = vacancyById(id)!
    const s = shiftPay(v)
    assert.ok(s, `shiftPay(${id}) пуст: у должности 2/2 с суммой с hh.ru должны быть деньги за смену`)
    assert.ok(s.perShift > 0 && s.perHour > 0 && s.shiftsPerMonth > 0)
    const reply = await ask(questions[id])
    const want = id === 'store-worker' ? formatRub(s.perHour) : formatRub(s.perShift)
    assert.ok(reply.includes(plain(want)), `${id}: на сайте ${plain(want)}, чат: ${reply.slice(0, 200)}`)
  }
})

test('«Вопросы»: в faq.ts не меньше восьми ответов, новые вопросы кейса заполнены', () => {
  const filled = faq.filter((f) => f.a.trim())
  assert.ok(filled.length >= 8, `заполнено ${filled.length}`)
  for (const id of ['practice', 'after-season', 'first-shift', 'medbook', 'clothes', 'study', 'interview-bring', 'quit'])
    assert.ok(faq.find((f) => f.id === id)?.a.trim(), `пустой ответ: ${id}`)
})
