// Офлайн-Квасыч: вопросы кейса, живая речь, факты по официальным материалам, тексты в лад с сайтом, темы «Вопросов к Квасычу».
// Ответы проверяются и через помощника, и через движок бота (как в pnpm bot:sim и в чате на сайте).
// Факты — «Описание практики» и «Справочник студента» (shared/content): оплачиваемая практика от 56 000 до 70 000 ₽,
// корпоративный автобус от м. «Озёрная», общежитие 3 400 ₽ для студентов, наставник у каждого новичка.
// Запуск: pnpm test w1-assistant

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAssistant } from '../../server/assistant/assistant'
import { checkAnswer } from '../../server/assistant/guard'
import { chunks, knowledgeText } from '../../server/assistant/knowledge'
import { gapTopic } from '../../server/assistant/topics'
import type { AssistantTurn, KbGapInput } from '../../server/assistant/types'
import { createEngine } from '../../server/dialog/engine'
import { memoryStorage } from '../../server/dialog/storage'
import type { DialogUser } from '../../server/dialog/types'
import { offlineProvider } from '../../server/llm/offline'
import { fixTypos, normalize, oneEditApart, splitParts, stripLead } from '../../server/llm/speech'
import { responsePromise } from '../../shared/candidateStatus'
import { contacts, myths } from '../../shared/content/content'
import { faqAnswer } from '../../shared/content/faq'
import { dorm } from '../../shared/content/handbook'
import { PLANT_BOTTLES_PER_HOUR } from '../../shared/content/production'
import { asksPortfolio, scheduleSummary, shiftPay, vacancies, vacancyById } from '../../shared/content/vacancies'

const plain = (t: string) => t.replace(/[\u00A0\u202F]/g, ' ')
/** Первое предложение: до точки или вопроса с пробелом, «м.», «ул.» и «доб.» не в счёт; одиночное «Да.» — не предложение */
const firstSentence = (t: string) =>
  plain(t)
    .replace(/^(Да|Нет)\.\s+/, '')
    .split(/(?<!(?:^|\s)(?:м|ул|доб|ст)\.)(?<=[.?])\s|\n/)[0]
const quiet = () => {}
const rub = (n: number) => `${n.toLocaleString('ru-RU').replace(/\s/g, ' ')} ₽`

function offline(gaps: KbGapInput[] = []) {
  return createAssistant({ provider: offlineProvider(), logGap: async (g) => void gaps.push(g), log: quiet })
}
async function ask(question: string, before: string[] = [], gaps: KbGapInput[] = []) {
  const assistant = offline(gaps)
  const history: AssistantTurn[] = []
  for (const q of before) {
    const r = await assistant.answer({ question: q, history: [...history], sessionId: 't', channel: 'web' })
    history.push({ role: 'user', text: q }, { role: 'assistant', text: r.text })
  }
  return assistant.answer({ question, history, sessionId: 't', channel: 'web' })
}

/** Ответ движка бота на текст — тот же путь, что у pnpm bot:sim и чата на сайте */
async function viaBot(text: string, channel: 'telegram' | 'web' = 'telegram') {
  const engine = createEngine(memoryStorage(), { siteUrl: 'http://localhost:5180', assistant: offline() })
  const user: DialogUser = channel === 'web' ? { channel, id: `w-${text}` } : { channel, id: `t-${text}`, firstName: 'Даня' }
  const r = await engine.handle(user, { type: 'text', text })
  return r.messages.map((m) => m.text).join('\n\n')
}

const NOT_ON_TOPIC = ['Тут не подскажу', 'Точного ответа', 'Под эти условия вакансий', 'Да, на июнь', 'Да, на июль', 'Здесь лучше ответит отдел персонала']

// ── Вопросы кейса ─────────────────────────────────────────────────────────

/** Формулировки вопросов кейса и слово, которое должно быть в первой фразе ответа */
const CASE: [string, RegExp][] = [
  ['нужна практика от вуза, подпишете дневник практики?', /практик/i],
  ['можно пройти у вас производственную практику?', /практик/i],
  ['нужен договор с вузом на практику', /практик/i],
  ['преддипломная практика есть?', /практик/i],
  ['учебную практику можно у вас пройти', /практик/i],
  ['можно остаться после лета на постоянку?', /постоянн|практик/i],
  ['можно ли перейти в штат после сезона?', /постоянн|практик/i],
  ['есть карьерный рост?', /постоянн|практик/i],
  ['как проходит первая смена?', /смен/i],
  ['что будет в первый день?', /смен/i],
]

test('вопросы кейса: ответ по теме в первой фразе — у помощника, в боте и в чате на сайте', async () => {
  for (const [q, topic] of CASE) {
    for (const text of [(await ask(q)).text, await viaBot(q, 'telegram'), await viaBot(q, 'web')]) {
      assert.match(firstSentence(text), topic, `${q} → ${text}`)
      for (const bad of NOT_ON_TOPIC) assert.ok(!text.includes(bad), `${q}: «${bad}» в ответе ${text}`)
    }
  }
})

test('практика: четыре отдела и суммы из «Описания практики», ответы кейса — тексты из «Вопросов» на сайте', async () => {
  const practice = await ask('можно пройти у вас производственную практику?')
  assert.ok(plain(practice.text).startsWith(plain(faqAnswer('practice'))), practice.text)
  assert.ok(plain(practice.text).includes('от 56 000 до 70 000 ₽'), practice.text)
  assert.ok(practice.actions.some((a) => a.type === 'start_application'), 'кнопка «Откликнуться»')
  assert.ok(practice.actions.some((a) => a.type === 'open_vacancy' && vacancyById(a.vacancyId)?.format === 'Оплачиваемая практика'), 'кнопки практик')
  const pairs: [string, Parameters<typeof faqAnswer>[0]][] = [
    ['можно пройти у вас производственную практику?', 'practice'],
    ['какие документы нужны для практики', 'practice-docs'],
    ['можно ли перейти в штат после сезона?', 'after-season'],
    ['как проходит первая смена?', 'first-shift'],
    ['медкнижка нужна?', 'medbook'],
    ['можно уйти раньше, в июле?', 'quit'],
    ['можно ли совмещать с учебой', 'study'],
    ['что взять на собеседование', 'interview-bring'],
    ['что за бесплатная практика', 'free-practice'],
  ]
  for (const [q, id] of pairs) {
    const faq = faqAnswer(id)
    assert.ok(faq, `в faq.ts есть ответ ${id}`)
    const r = await ask(q)
    assert.ok(plain(r.text).includes(plain(faq).replace(/^Да[.,:]\s*/, '').slice(1)), `${q}: ответ не совпадает с «Вопросами» на сайте:\n${r.text}\n— ожидалось —\n${faq}`)
  }
})

test('наставник — факт из справочника: «кто будет учить» отвечает наставником и Учебным центром первой фразой', async () => {
  for (const q of ['кто будет учить?', 'есть наставник?', 'научат на месте?']) {
    const r = await ask(q)
    assert.match(firstSentence(r.text), /наставник/i, `${q} → ${r.text}`)
    assert.ok(r.text.includes('Учебном центре'), r.text)
    assert.ok(!r.escalated, q)
  }
})

test('«после лета» и «до лета» — не лето', async () => {
  const r = await ask('можно остаться после лета на постоянку?')
  assert.ok(!/июнь — август|с июня по август/.test(r.text), r.text)
  assert.ok(!/^Да, на/.test(r.text), r.text)
})

test('практика от вуза и документы теперь отвечены справочником — в «Вопросы к Квасычу» не уходят, тема в словаре прежняя', async () => {
  const gaps: KbGapInput[] = []
  for (const q of ['подпишете дневник практики?', 'нужен договор с вузом на практику', 'как оформить производственную практику от колледжа'])
    assert.ok(!(await ask(q, [], gaps)).escalated, q)
  assert.equal(gaps.length, 0, JSON.stringify(gaps))
  for (const q of ['подпишете дневник практики?', 'нужен договор с вузом на практику', 'характеристику дадите?']) assert.equal(gapTopic(q), 'практика от вуза', q)
})

test('тема вопроса без ответа — из словаря, а не первые слова вопроса', async () => {
  const gaps: KbGapInput[] = []
  await ask('а тату можно на линии', [], gaps)
  await ask('дресс-код какой в офисе', [], gaps)
  await ask('есть ли парковка для сотрудников', [], gaps)
  assert.deepEqual(
    gaps.map((g) => g.topic),
    ['внешний вид', 'внешний вид', 'парковка'],
  )
  assert.equal(gapTopic('премия за переработку будет?'), 'премии')
  assert.equal(gapTopic('сверхурочные оплачивают?'), 'переработки')
  assert.equal(gapTopic('сколько стоит общага'), 'стоимость общежития')
  // Все формы слова: «девушек» без «к» перед окончанием
  for (const q of ['девушек берут на склад?', 'девушку возьмут на линию?', 'я девушка, возьмут?', 'парни нужны на склад?', 'парней берут в лабораторию?'])
    assert.equal(gapTopic(q), 'кого берут', q)
  assert.notEqual(gapTopic('распарнёте бутылки?'), 'кого берут')
})

// ── Живая речь ────────────────────────────────────────────────────────────

test('живая речь: приветствие, сленг, контекст, частые темы', async () => {
  const starts: [string, string, string[]?][] = [
    ['привет, сколько платят?', `От ${rub(56000)}`],
    ['зп белая?', 'Да, официально'],
    ['а на складе?', 'На складе платят 56 000–60 000 ₽', ['сколько платят операторам линии']],
    ['мне 27, возьмут?', 'Да, возраст подходит'],
    ['мне 17, можно?', 'Нет, берут с 18 лет'],
    ['можно удалённо?', 'Удалённой работы в вакансиях нет'],
    ['сколько длится смена', 'Смена длится 12 часов'],
    ['кто такой Квасыч', 'Я Квасыч, бот «Очаково»'],
    ['это развод?', 'Работодатель: АО МПБК «Очаково»'],
    ['привет', 'Привет.'],
  ]
  for (const [q, start, before] of starts) {
    const r = await ask(q, before)
    assert.ok(plain(r.text).startsWith(start), `${q} → ${r.text}`)
  }
  const master = await ask('сколько получает мастер смены')
  assert.ok(master.text.startsWith('Вакансии «мастер смены» нет'), master.text)
  const scam = (await ask('это развод?')).text
  assert.ok(scam.includes('Рябиновая, 44') && scam.includes('ТК РФ'), scam)
})

test('ни один вопрос с рабочим словом не получает «Тут не подскажу»', async () => {
  for (const q of [
    'можно уволиться раньше',
    'а квас бесплатный для сотрудников',
    'работа тяжелая физически?',
    'большая нагрузка?',
    'можно сидеть в телефоне на смене',
    'это развод?',
    'есть отзывы сотрудников',
    'развозка есть',
    'мне 27, возьмут?',
    'чо по зп',
    'собес где проходит',
    'постоянка есть?',
    'расчетный лист где смотреть',
    'что если экзамен в июне',
    'характеристику дадите?',
  ]) {
    const r = await ask(q)
    assert.ok(!r.text.includes('Тут не подскажу'), `${q} → ${r.text}`)
  }
})

test('медкнижка — до 400 знаков, первый абзац — до двух предложений, повторов абзацев нет', async () => {
  const med = await ask('медкнижка нужна?')
  assert.ok(med.text.length <= 400, `${med.text.length} знаков`)
  for (const q of ['а ночные смены есть? и доплата за ночь какая', 'сколько платят, где жить и как устроиться', 'Хочу с другом в одну смену, и общага платная?']) {
    const paragraphs = (await ask(q)).text.split('\n\n').map((p) => p.trim())
    assert.equal(new Set(paragraphs).size, paragraphs.length, q)
  }
})

test('составной вопрос: ответ на каждую часть, не длиннее 900 знаков', async () => {
  const r = await ask('сколько платят, где жить и как устроиться')
  assert.ok(r.text.length <= 900, `${r.text.length} знаков`)
  for (const part of ['56 000', 'общежити', 'Начни с заявки']) assert.ok(plain(r.text).includes(part), `нет «${part}»:\n${r.text}`)
})

// ── Опечатки, сленг, начало фразы, составные вопросы ────────────────────

test('опечатки: одна правка, слово от 6 букв, только к словам базы и при одном кандидате', () => {
  assert.ok(oneEditApart('зарпалта', 'зарплата'), 'перестановка')
  assert.ok(oneEditApart('общижитие', 'общежитие'), 'замена')
  assert.ok(oneEditApart('скалад', 'склад'), 'лишняя буква')
  assert.ok(!oneEditApart('медкнига', 'медкнижка'), 'две правки')
  const fix = (t: string) => fixTypos(t, () => false)
  assert.equal(fix('зарпалта оператора'), 'зарплата оператора')
  assert.equal(fix('общижитие есть'), 'общежитие есть')
  assert.equal(fix('где скалад'), 'где склад')
  // Короче 6 букв, числа и обычные слова не трогаем
  assert.equal(fix('грфик'), 'грфик')
  assert.equal(fix('за 107000 в месяц'), 'за 107000 в месяц')
  for (const phrase of ['сколько стоит обучение', 'можно со стажем работать', 'когда ответят', 'расскажи историю завода', 'хочу работать летом']) {
    assert.equal(normalize(phrase), phrase, phrase)
  }
})

test('сленг и вежливое начало', () => {
  assert.equal(normalize('чо по зп'), 'что по зарплата')
  assert.equal(normalize('собес когда'), 'собеседование когда')
  assert.equal(normalize('удалёнка есть'), 'удаленная работа есть')
  assert.equal(normalize('постоянку дадут'), 'постоянная работа дадут')
  assert.deepEqual(stripLead('Привет, сколько платят?'), { rest: 'сколько платят?', lead: 'hello' })
  assert.deepEqual(stripLead('спасибо, а заявку где оставить'), { rest: 'а заявку где оставить', lead: 'thanks' })
  assert.deepEqual(stripLead('ок'), { rest: '', lead: 'ok' })
  assert.deepEqual(stripLead('кто такой Квасыч'), { rest: 'кто такой Квасыч', lead: null })
})

test('составной вопрос: запятая делит, только если в каждой части свой вопрос', () => {
  assert.deepEqual(splitParts('сколько платят, где жить и как устроиться'), ['сколько платят', 'где жить', 'как устроиться'])
  assert.deepEqual(splitParts('Скока на руки без опыта, мне 18?'), ['Скока на руки без опыта, мне 18'])
})

// ── Факты по официальным материалам ──────────────────────────────────────

test('дорога: «есть развозка?», «как добраться от метро», «автобус до завода» — один ответ, первым корпоративный автобус', async () => {
  const texts = await Promise.all(['есть развозка?', 'как добраться от метро', 'автобус до завода'].map(async (q) => (await ask(q)).text))
  assert.equal(new Set(texts).size, 1, texts.join('\n---\n'))
  assert.ok(plain(texts[0]).includes('610 и 807') && texts[0].includes('275'), texts[0])
  assert.match(firstSentence(texts[0]), /корпоративный автобус/)
  assert.ok(texts[0].includes(contacts.routeShort.replace('Корпоративный автобус от ', '')), texts[0])
  for (const s of contacts.route.split(/(?<=»)\.\s|\.\s(?=[А-ЯЁ])/)) assert.ok(plain(texts[0]).includes(plain(s).replace(/\.$/, '').slice(0, 30)), s)
})

test('ДМС не обещаем, общежитие — с ценой из справочника, «бесплатно» только там, где это правда', async () => {
  for (const q of ['есть ДМС?', 'медстраховка будет?']) {
    const r = await ask(q)
    assert.match(r.text, /ДМС не указан/, `${q} → ${r.text}`)
    assert.ok(/отдел/.test(r.text), `${q} → ${r.text}`)
  }
  const free = await ask('общага бесплатная?')
  assert.ok(plain(free.text).startsWith(`Нет, платное: для студентов койко-место стоит ${rub(dorm.priceStudent)}`), free.text)
  assert.ok(plain(free.text).includes(rub(dorm.priceOther)), free.text)
  for (const q of ['есть общага?', 'сколько стоит общежитие', 'обед бесплатный?', 'кормят бесплатно?']) {
    const r = await ask(q)
    assert.ok(!/бесплатн[а-я]*\s+(общежит|жиль|обед)|(общежит|обед)[а-я]*\s+бесплатн/i.test(r.text), `${q} → ${r.text}`)
    assert.equal(r.source, 'offline', `${q}: ответ отклонила проверка — ${r.text}`)
  }
})

test('старых вакансий и решений в ответах нет: экскурсовод, аппаратчик, механик, стажёр, «стоимость у HR»', async () => {
  const removed = /Экскурсовод на производстве|Помощник аппаратчика|Механик|Стажёр|стоимость — у HR|107 000|102 000|сезонную работу/
  for (const q of ['какие вакансии есть', 'я учусь на историка, свободна летом', 'я на маркетинге, хочу стажировку', 'учусь на механика', 'сколько платят?', 'есть общага?', 'можно на лето?', 'какие практики есть']) {
    const r = await ask(q)
    assert.doesNotMatch(r.text, removed, `${q} → ${r.text}`)
  }
})

// ── Тексты в лад с сайтом ────────────────────────────────────────────────

test('«какой график» — тот же текст, что в «Условиях»', async () => {
  const r = await ask('какой график?')
  assert.equal(plain(r.text).replace(/\n\n/g, ' '), plain(scheduleSummary.text))
})

test('деньги за смену и в час — из shiftPay, guard их пропускает', async () => {
  const withShift = vacancies.filter((v) => shiftPay(v))
  assert.ok(withShift.length > 0, 'shiftPay считает хотя бы одну вакансию')
  const p = shiftPay(vacancyById('fermentation-assistant')!)!
  const r = await ask('сколько за смену в технологическом цехе')
  assert.ok(plain(r.text).includes(rub(p.perShift)) && plain(r.text).includes(rub(p.perHour)), r.text)
  assert.equal(r.source, 'offline')
  for (const v of withShift) {
    const s = shiftPay(v)!
    assert.ok(checkAnswer(`от ${s.perShift.toLocaleString('ru-RU')} ₽ за смену, от ${s.perHour} ₽ в час`).ok, v.id)
  }
  assert.ok(!checkAnswer('от 9 999 ₽ за смену').ok, 'выдуманная сумма за смену режется')
  // У линии розлива график без 2/2 — за смену не считаем, но называем ту же сумму на графике 2/2
  const line = await ask('сколько в час на линии')
  assert.ok(line.text.includes('не считаю') && plain(line.text).includes(rub(p.perShift)), line.text)
})

test('мифы в базе — полем fact, «В десять раз больше» нет; масштаб — из PLANT_BOTTLES_PER_HOUR', async () => {
  for (const m of myths) assert.ok(chunks.some((c) => c.answer === m.fact), m.id)
  assert.ok(!knowledgeText().includes('В десять раз больше'))
  const r = await ask('сколько бутылок в час')
  assert.ok(plain(r.text).includes(PLANT_BOTTLES_PER_HOUR.toLocaleString('ru-RU').replace(/\s/g, ' ')), r.text)
  assert.ok(!r.text.includes('В десять раз'), r.text)
})

test('«Путь кваса», срок ответа и портфолио — как на сайте', async () => {
  assert.ok((await ask('как варят квас?')).text.includes('«Путь кваса»'))
  const when = await ask('когда ответят после заявки')
  assert.ok(when.text.startsWith(`${responsePromise('call')} после заявки.`), when.text)
  const portfolio = await ask('куда кинуть портфолио')
  const ids = portfolio.actions.flatMap((a) => (a.type === 'open_vacancy' ? [a.vacancyId] : []))
  assert.ok(ids.length > 0 && ids.every((id) => asksPortfolio(vacancyById(id)!)), JSON.stringify(ids))
})
