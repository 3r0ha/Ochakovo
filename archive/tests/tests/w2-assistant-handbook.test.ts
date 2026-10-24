// Квасыч по «Справочнику студента» (w2-as-c1): общежитие, столовая, дни зарплаты, экзамены, спецодежда и прачечная,
// пропуск, здравпункт, документы по практике, наставник, испытательный срок у студентов, корпоративный автобус,
// добавочные телефоны. Каждую тему спрашиваем несколькими словами: ответ — по существу, с цифрами из shared/content,
// проходит проверку guard (source = offline) и не уходит в «Вопросы к Квасычу».
// Запуск: pnpm test w2-assistant-handbook (без базы)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAssistant } from '../../server/assistant/assistant'
import { checkAnswer } from '../../server/assistant/guard'
import { chunks, knowledgeText } from '../../server/assistant/knowledge'
import type { KbGapInput } from '../../server/assistant/types'
import { createEngine } from '../../server/dialog/engine'
import { memoryStorage } from '../../server/dialog/storage'
import { offlineProvider } from '../../server/llm/offline'
import { contacts, phonebook, phoneLine } from '../../shared/content/content'
import { faq } from '../../shared/content/faq'
import { canteen, dorm, handbook, handbookText, PASS_FINE, PAY_DAYS, TRAINING_CENTER_ROOM } from '../../shared/content/handbook'

const plain = (t: string) => t.replace(/[  ]/g, ' ').replace(/⁠/g, '')
const rub = (n: number) => `${n.toLocaleString('ru-RU').replace(/\s/g, ' ')} ₽`
const ext = (id: string) => phonebook.find((p) => p.id === id)!

const gaps: KbGapInput[] = []
const assistant = createAssistant({ provider: offlineProvider(), logGap: async (g) => void gaps.push(g), log: () => {} })
const ask = (question: string) => assistant.answer({ question, history: [], sessionId: 'w2-handbook', channel: 'web' })

/** Тема — формулировки — что обязательно есть в ответе (из shared/content) */
const TOPICS: { topic: string; questions: string[]; must: string[] }[] = [
  { topic: 'общежитие: цена', questions: ['сколько стоит общежитие', 'общага платная?', 'почём койка в общаге'], must: [rub(dorm.priceStudent), rub(dorm.priceOther)] },
  { topic: 'общежитие: адрес', questions: ['где общежитие?', 'есть общага?', 'где жить, если я не из москвы'], must: ['Рябиновая, 36, к. 2'] },
  { topic: 'общежитие: режим', questions: ['во сколько закрывается общежитие', 'до скольки можно вернуться в общагу'], must: ['с 23:00 до 6:00'] },
  { topic: 'общежитие: заселение', questions: ['когда заселяться в общагу', 'как заехать в общежитие'], must: ['до 14:00 или после 16:00', ext('dorm').phone] },
  { topic: 'общежитие: быт', questions: ['есть кухня в общежитии?', 'что взять с собой в общагу', 'сколько человек в комнате'], must: [] },
  { topic: 'столовая', questions: ['обед есть?', 'во сколько обед', 'кормят на заводе?'], must: ['11:30 до 14:30', 'Половину стоимости компенсирует компания'] },
  { topic: 'столовая: ужин и деньги', questions: ['ужин есть?', 'нужны деньги на обед?'], must: ['20:30 до 22:00'] },
  { topic: 'дни зарплаты', questions: ['когда зарплата', 'когда платят зарплату', 'какого числа зп', 'аванс есть?'], must: [`${PAY_DAYS[0]}-го и ${PAY_DAYS[1]}-го`] },
  { topic: 'переработки', questions: ['переработки оплачиваются?', 'сверхурочные платят?'], must: ['часы сверх нормы'] },
  { topic: 'экзамены', questions: ['можно ли сдать сессию', 'что если экзамен в июне', 'как быть с зачётом'], must: ['смены на это время не'] },
  { topic: 'отпуск', questions: ['можно в отпуск летом?', 'отпуск дают?'], must: ['отпуска ограничены', 'за две недели'] },
  { topic: 'спецодежда', questions: ['форму дают?', 'обувь своя нужна?'], must: ['выдают'] },
  { topic: 'прачечная', questions: ['прачечная есть?', 'где стирать форму'], must: ['8:30 до 16:30', '1–2 дня'] },
  { topic: 'пропуск', questions: ['как получить пропуск', 'потерял пропуск', 'пропуск потеряла, что будет'], must: ['отдел кадров', `штраф ${rub(PASS_FINE)}`] },
  { topic: 'здравпункт', questions: ['есть медпункт?', 'заболел на смене', 'плохо стало на смене, куда идти'], must: ['1370 или 1303', 'круглосуточно'] },
  { topic: 'документы по практике', questions: ['какие документы нужны для практики', 'характеристику дадите?', 'подпишете дневник практики?'], must: [`кабинет ${TRAINING_CENTER_ROOM}`] },
  { topic: 'наставник', questions: ['кто будет учить?', 'есть наставник?', 'кто учит новичков на заводе?', 'научат на месте?'], must: ['наставник', 'Учебном центре'] },
  { topic: 'испытательный срок', questions: ['есть испытательный срок?', 'испытательный срок у студентов какой'], must: [handbookText('probation')] },
  { topic: 'корпоративный автобус', questions: ['есть развозка?', 'корпоративный автобус откуда ходит', 'как добраться от метро'], must: ['корпоративный автобус', 'м. «Озёрная»', '610 и 807'] },
  { topic: 'телефоны отделов', questions: ['телефон учебного центра', 'где учебный центр'], must: [ext('training').ext!] },
  { topic: 'телефоны отделов', questions: ['номер отдела кадров', 'как связаться с отделом кадров'], must: [ext('personnel').ext!] },
  { topic: 'телефоны отделов', questions: ['телефон здравпункта'], must: [ext('medical').ext!] },
  { topic: 'телефоны отделов', questions: ['телефон охраны'], must: [ext('security').ext!] },
  { topic: 'телефоны отделов', questions: ['номер коменданта общаги', 'телефон коменданта'], must: [ext('dorm').phone] },
  { topic: 'телефоны отделов', questions: ['все телефоны', 'добавочные номера отделов'], must: phonebook.map((p) => p.who) },
  { topic: 'график', questions: ['можно выбрать график?', 'кто составляет график'], must: ['составляет руководитель'] },
  { topic: 'договор', questions: ['какой договор', 'трудовая книжка бумажная?'], must: ['срочный трудовой договор', 'электронная'] },
]

test('каждая тема справочника: ответ по существу, с цифрами из shared, проверку прошёл, в «Вопросы к Квасычу» не ушёл', async () => {
  for (const { topic, questions, must } of TOPICS) {
    for (const q of questions) {
      const before = gaps.length
      const r = await ask(q)
      const text = plain(r.text)
      assert.equal(r.source, 'offline', `${topic} — «${q}»: ответ не прошёл проверку или не найден:\n${text}`)
      assert.ok(!r.escalated && gaps.length === before, `${topic} — «${q}» ушёл в «Вопросы к Квасычу»`)
      assert.doesNotMatch(text, /Тут не подскажу|Точного ответа|Здесь лучше ответит|!/, `${topic} — «${q}»:\n${text}`)
      for (const part of must) assert.ok(text.includes(plain(part)), `${topic} — «${q}»: нет «${part}»\n${text}`)
    }
  }
})

test('ответы «да или нет» начинаются с ответа, а не с пересказа', async () => {
  const cases: [string, RegExp][] = [
    ['общага бесплатная?', /^Нет, платное/],
    ['общага платная?', /^Да, платное/],
    ['есть наставник?', /^Да, к каждому новичку/],
    ['нужны деньги на обед?', /^Нет, деньги с собой не нужны/],
    ['ужин есть?', /^Да, вечернее питание/],
    ['прачечная есть?', /^Да, прачечная/],
    ['можно выбрать график?', /^Нет, график составляет руководитель/],
    ['можно поменяться сменой?', /^Да, в исключительных случаях/],
    ['трудовая книжка бумажная?', /^Нет, трудовая книжка электронная/],
    ['характеристику дадите?', /^Да, характеристику выдаёт компания после практики/],
    ['есть испытательный срок?', /^У студентов испытательного срока нет/],
  ]
  for (const [q, re] of cases) assert.match(plain((await ask(q)).text), re, q)
})

test('тексты Квасыча совпадают с shared/content: справочник, телефоны и «Вопросы» — в базе знаний слово в слово', () => {
  const kb = plain(knowledgeText())
  for (const h of handbook) assert.ok(kb.includes(plain(h.text)), `в базе нет текста справочника «${h.id}»`)
  for (const p of phonebook.filter((x) => x.id !== 'recruiting')) assert.ok(kb.includes(plain(phoneLine(p))), `в базе нет телефона «${p.who}»`)
  for (const f of faq.filter((x) => x.a)) assert.ok(kb.includes(plain(f.a)), `в базе нет ответа «${f.id}»`)
  for (const part of [dorm.checkIn, dorm.curfew, dorm.kitchen, canteen.lunch, canteen.dinner, contacts.shuttle.replace(/\.$/, '')])
    assert.ok(kb.includes(plain(part)), `в базе нет «${part}»`)
})

test('каждая фраза базы знаний проходит проверку guard: суммы, время и проценты справочника разрешены', () => {
  for (const line of knowledgeText().split('\n')) {
    const r = checkAnswer(line)
    assert.ok(r.ok, `${line}\n→ ${r.ok ? '' : r.problems.join('; ')}`)
  }
  for (const c of chunks) {
    const r = checkAnswer(c.answer)
    assert.ok(r.ok, `${c.id}: ${c.answer}\n→ ${r.ok ? '' : r.problems.join('; ')}`)
  }
})

test('в боте и в чате на сайте — те же ответы справочника', async () => {
  const engine = createEngine(memoryStorage(), { siteUrl: 'http://localhost:5180', assistant })
  for (const [q, want] of [
    ['сколько стоит общежитие', rub(dorm.priceStudent)],
    ['потерял пропуск', `штраф ${rub(PASS_FINE)}`],
    ['телефон учебного центра', ext('training').ext!],
    ['кто будет учить?', 'наставник'],
  ] as const) {
    for (const channel of ['telegram', 'web'] as const) {
      const r = await engine.handle({ channel, id: `hb-${channel}-${q}` }, { type: 'text', text: q })
      const text = plain(r.messages.map((m) => m.text).join('\n'))
      assert.ok(text.includes(plain(want)), `${channel} — «${q}»: ${text.slice(0, 300)}`)
    }
  }
})

test('вопросы без ответа в данных уходят в «Вопросы к Квасычу», даже если в них есть «общежитие», «склад» или «перерыв»', async () => {
  const cases: [string, string][] = [
    ['нужна временная регистрация, если живу в общежитии?', 'прописка и регистрация'],
    ['девушку возьмут на склад?', 'кого берут'],
    ['можно ли сидеть в телефоне на перерыве', 'правила на смене'],
    ['в наушниках на линии работать можно?', 'правила на смене'],
    ['есть парковка для сотрудников у завода?', 'парковка'],
    ['можно машину оставить у проходной?', 'парковка'],
    ['с цветными волосами возьмут на линию?', 'внешний вид'],
    ['где почитать отзывы сотрудников о заводе?', 'отзывы о работе'],
  ]
  for (const [q, topic] of cases) {
    const before = gaps.length
    const r = await ask(q)
    assert.ok(r.escalated, `«${q}» не ушёл к HR: ${r.text}`)
    assert.match(r.text, /^Точного ответа в моих данных нет/, q)
    assert.equal(gaps.at(-1)?.topic, topic, q)
    assert.equal(gaps.length, before + 1, q)
  }
  // «Я девушка, сколько платят?» — про зарплату, а не «возьмут ли»
  assert.match(plain((await ask('я девушка, сколько платят?')).text), /^От 56 000 ₽/)
})

test('живая речь по справочнику: опечатки в словах справочника и составные вопросы про общежитие', async () => {
  const typos: [string, RegExp][] = [
    ['наставнек будет?', /^Да, к каждому новичку прикрепляют наставника/],
    ['телефон комменданта', /^Телефон коменданта общежития: 8 495 446-42-55/],
    ['характиристику дадите?', /^Да, характеристику выдаёт компания после практики/],
    ['испытательнй срок есть?', /^У студентов испытательного срока нет/],
  ]
  for (const [q, re] of typos) assert.match(plain((await ask(q)).text), re, q)
  const compound = plain((await ask('сколько стоит общага, во сколько закрывается и где обедать')).text)
  for (const part of [rub(dorm.priceStudent), 'с 23:00 до 6:00', canteen.lunch]) assert.ok(compound.includes(plain(part)), `нет «${part}»:\n${compound}`)
  assert.ok(!compound.includes('Дневная смена'), '«во сколько закрывается» — про общежитие, а не про смены')
  const kitchen = plain((await ask('сколько стоит общага и есть ли кухня')).text)
  assert.ok(kitchen.includes(rub(dorm.priceStudent)) && kitchen.includes('общие кухни'), kitchen)
})
