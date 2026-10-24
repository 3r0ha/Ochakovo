// Анкета фокус-группы (w2-fc-1) совпадает с протоколом и концепцией, ответы проверяются, личные данные вырезаются.
// Протокол прямо требует: «Формулировки и варианты на странице совпадают с этим списком, иначе ответы онлайн и на встречах
// нельзя сравнить» (docs/brand/focus-group.md, раздел 5). Слоганы — в порядке docs/brand/concept.md, «Для фокус-группы».
// Запуск: pnpm test focus-questionnaire (без базы)

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { dorm } from '../../shared/content/handbook'
import { maxEntryPay, minPracticePay } from '../../shared/content/vacancies'
import {
  checkFocusAnswers,
  cleanFreeText,
  FOCUS_CHOICE_IDS,
  FOCUS_SLOGANS,
  FOCUS_TEXT_MAX,
  focusCsv,
  focusQuestions,
  normalizeFocusTag,
  voterHash,
  type FocusRow,
} from '../../server/db/focus'

const root = new URL('../../', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, root), 'utf8')

/** Кавычки и пробелы к одному виду: „Очаково“ внутри «…» в документе, неразрывные пробелы в суммах */
const plain = (s: string) => s.replace(/[„“]/g, (q) => (q === '„' ? '«' : '»')).replace(/[\u00a0\u2009\u202f]/g, ' ').trim()
const lower = (s: string) => plain(s).toLowerCase().replace(/[.]$/, '')

/** Раздел документа от заголовка до следующего заголовка того же или старшего уровня */
function section(doc: string, heading: string): string {
  const start = doc.indexOf(heading)
  assert.ok(start >= 0, `в документе есть «${heading}»`)
  const rest = doc.slice(start + heading.length)
  const level = heading.match(/^#+/)![0].length
  const next = rest.search(new RegExp(`\\n#{1,${level}} `))
  return next < 0 ? rest : rest.slice(0, next)
}

const protocol = section(read('docs/brand/focus-group.md'), '### Анкета на странице `/focus`')
/** Пункты анкеты верхнего уровня: «1. «Вопрос» Варианты…» */
const items = protocol
  .split('\n')
  .filter((l) => /^\d+\. /.test(l))
  .map((l) => plain(l.replace(/^\d+\. /, '')))
/** Слоганы — вложенный список под первым вопросом */
const protocolSlogans = protocol
  .split('\n')
  .filter((l) => /^\s+\d+\. /.test(l))
  .map((l) => plain(l.replace(/^\s+\d+\. /, '')))

/** Варианты после вопроса: «…?» Один ответ: a; b; c. → [a, b, c] */
const optionsOf = (item: string) =>
  item
    .slice(item.indexOf('?»') + 2)
    .replace(/^\s*(Один ответ:)?\s*/, '')
    .split(';')
    .map(lower)
    .filter(Boolean)

test('шесть вопросов в порядке протокола, формулировки дословно', () => {
  const qs = focusQuestions()
  assert.equal(items.length, 6, 'в протоколе шесть вопросов анкеты')
  assert.deepEqual(
    qs.map((q) => q.id),
    ['clear', 'interest', 'hook', 'intent', 'missing', 'study'],
  )
  qs.forEach((q, i) => assert.ok(items[i].startsWith(`«${q.title}»`), `вопрос ${i + 1}: «${q.title}» — в протоколе «${items[i].slice(0, 80)}»`))
  for (const q of qs) {
    assert.doesNotMatch(q.title + q.short, /!|\.\.\.|…/, 'без восклицаний и многоточий')
    if (q.kind === 'one') for (const o of q.options) assert.doesNotMatch(o.label, /!|…/)
  }
})

test('слоганы — как в концепции и протоколе, в том же порядке, плюс «Ни один»', () => {
  const concept = section(read('docs/brand/concept.md'), '### Для фокус-группы')
  const conceptList = concept
    .split('\n')
    .filter((l) => /^\d+\. /.test(l))
    .map((l) => plain(l.replace(/^\d+\. /, '')))
  const ours = FOCUS_SLOGANS.map((s) => s.label)
  assert.deepEqual(conceptList, ours, 'docs/brand/concept.md, раздел 4 «Для фокус-группы»')
  assert.deepEqual(protocolSlogans, ours, 'docs/brand/focus-group.md, вопрос 1')
  assert.match(items[0], /«Ни один»/)
  assert.match(items[1], /Те же варианты/)
  const [clear, interest] = focusQuestions()
  for (const q of [clear, interest]) {
    assert.ok(q.kind === 'one')
    assert.deepEqual(
      q.options.map((o) => o.label),
      [...ours, 'Ни один'],
    )
    assert.equal(q.look, 'slogan')
  }
})

test('варианты вопросов 3, 4 и 6 дословно, суммы — из данных вакансий и справочника', () => {
  const qs = focusQuestions()
  for (const [i, id] of [
    [2, 'hook'],
    [3, 'intent'],
    [5, 'study'],
  ] as const) {
    const q = qs.find((x) => x.id === id)!
    assert.ok(q.kind === 'one')
    assert.deepEqual(q.options.map((o) => lower(o.label)), optionsOf(items[i]), `вопрос ${i + 1}`)
  }
  const hook = qs.find((q) => q.id === 'hook')!
  assert.ok(hook.kind === 'one')
  const label = (id: string) => plain(hook.options.find((o) => o.id === id)!.label)
  const num = (n: number) => n.toLocaleString('ru-RU').replace(/\s/g, ' ')
  assert.equal(label('pay'), `Сумма от ${num(minPracticePay)} до ${num(maxEntryPay)} ₽`)
  assert.equal(label('dorm'), `Общежитие студентам за ${num(dorm.priceStudent)} ₽`)
  assert.match(items[2], /Один ответ/)
})

test('свободный ответ — до 300 знаков, как в протоколе', () => {
  const q = focusQuestions().find((x) => x.id === 'missing')!
  assert.ok(q.kind === 'text')
  assert.equal(q.max, FOCUS_TEXT_MAX)
  assert.match(items[4], new RegExp(`Свободный ответ до ${FOCUS_TEXT_MAX} знаков`))
  assert.match(q.hint, /анонимн/)
})

test('проверка ответов: всё с вариантами обязательно, свободный ответ — нет, чужие варианты отклоняются', () => {
  const ok = { clear: 'teach', interest: 'people', hook: 'mentor', intent: 'maybe', study: 'uni_senior' }
  assert.deepEqual(checkFocusAnswers(ok), { value: { ...ok, missing: '' }, errors: {} })

  const empty = checkFocusAnswers({})
  assert.deepEqual(Object.keys(empty.errors).sort(), [...FOCUS_CHOICE_IDS].sort())
  assert.equal(empty.errors.clear, 'Выбери один вариант')
  assert.deepEqual(Object.keys(checkFocusAnswers(null).errors).sort(), [...FOCUS_CHOICE_IDS].sort())
  assert.deepEqual(Object.keys(checkFocusAnswers([1, 2]).errors).sort(), [...FOCUS_CHOICE_IDS].sort())

  // Вариант другого вопроса и выдуманный — ошибка
  assert.ok(checkFocusAnswers({ ...ok, clear: 'yes' }).errors.clear)
  assert.ok(checkFocusAnswers({ ...ok, intent: 'teach' }).errors.intent)
  assert.ok(checkFocusAnswers({ ...ok, study: 'school' }).errors.study)
  assert.ok(checkFocusAnswers({ ...ok, hook: 1 }).errors.hook)

  assert.equal(checkFocusAnswers({ ...ok, missing: '  про график  ' }).value.missing, 'про график')
  assert.equal(checkFocusAnswers({ ...ok, missing: 'а'.repeat(FOCUS_TEXT_MAX) }).value.missing.length, FOCUS_TEXT_MAX)
  assert.equal(checkFocusAnswers({ ...ok, missing: 'а'.repeat(FOCUS_TEXT_MAX + 1) }).errors.missing, `Не длиннее ${FOCUS_TEXT_MAX} знаков`)
  assert.equal(checkFocusAnswers({ ...ok, missing: 42 }).errors.missing, 'Ответ — текстом')
  assert.deepEqual(checkFocusAnswers({ ...ok, missing: null }).errors, {})
})

test('свободный ответ без личных данных: телефон, почта, ник, имя и ссылки вырезаются', () => {
  const cases: [string, string][] = [
    ['звоните +7 916 123-45-67', 'звоните [телефон скрыт]'],
    ['мой 89161234567', 'мой [телефон скрыт]'],
    ['8 (916) 123 45 67 после шести', '[телефон скрыт] после шести'],
    ['пишите anna.k@mail.ru', 'пишите [почта скрыта]'],
    ['тг @anna_k или t.me/anna_k', 'тг [ник скрыт] или [ссылка скрыта]'],
    ['вот https://vk.com/id123 там всё', 'вот [ссылка скрыта] там всё'],
    ['Меня зовут Анна Котова, нужен график', 'Меня зовут [имя скрыто], нужен график'],
  ]
  for (const [raw, clean] of cases) assert.equal(cleanFreeText(raw), clean, raw)
  // Суммы, часы и курсы — не телефоны
  for (const keep of ['70 000 ₽ мало для 12 часов', 'общежитие 3 400 ₽ — это в месяц?', '4 курс, 2/2 неудобно']) assert.equal(cleanFreeText(keep), keep)
  // Переводы строк, табуляция и невидимые знаки — в один пробел
  assert.equal(cleanFreeText('график\n\n\tи   дорога\u200b'), 'график и дорога')
  assert.equal(cleanFreeText('я'.repeat(400)).length, FOCUS_TEXT_MAX)
})

test('метка: как метки источников, непохожая — пустая', () => {
  assert.equal(normalizeFocusTag('fg-a'), 'fg-a')
  assert.equal(normalizeFocusTag('  FG-B '), 'fg-b')
  assert.equal(normalizeFocusTag('vk-mgupp-2'), 'vk-mgupp-2')
  for (const bad of ['', '-fg', 'fg-', 'fg a', 'фг-а', 'a'.repeat(41), '<script>', null, 12]) assert.equal(normalizeFocusTag(bad), '', String(bad))
})

test('отпечаток устройства: 64 знака, от cookie не отличить и обратно не восстановить', () => {
  const a = voterHash('x'.repeat(32))
  assert.match(a, /^[0-9a-f]{64}$/)
  assert.notEqual(a, voterHash('y'.repeat(32)))
  assert.equal(a, voterHash('x'.repeat(32)))
})

test('CSV: BOM, «;», вопросы дословно в шапке, подписи вместо кодов, защита от формул', () => {
  const at = new Date(Date.now() - 60 * 60 * 1000)
  const rows: FocusRow[] = [
    { id: 7, tag: 'fg-a', version: 1, at, clear: 'teach', interest: 'none', hook: 'dorm', intent: 'yes', missing: '=СУММ(1;2) и график', study: 'college' },
    { id: 8, tag: '', version: 1, at, clear: 'people', interest: 'natural', hook: 'pay', intent: 'no', missing: 'про "общагу"', study: 'graduated' },
  ]
  const csv = focusCsv(rows)
  assert.ok(csv.startsWith('\uFEFF'))
  const [head, first, second] = csv.slice(1).split('\r\n')
  assert.match(head, /^"№";"Метка";"Время, МСК";"1\. Какой слоган понятнее\?";/)
  assert.match(head, /"5\. Чего не хватает, чтобы решиться\?";"6\. Где ты сейчас учишься\?"$/)
  assert.match(first, /^"7";"fg-a";"\d\d\.\d\d\.\d{4} \d\d:\d\d";"«Сначала научим, потом доверим»";"Ни один";"Общежитие студентам за 3 400 ₽";"Да";"'=СУММ\(1;2\) и график";"Колледж"$/)
  assert.match(second, /^"8";"без метки";/)
  assert.match(second, /"про ""общагу""";"Уже не учусь"$/)
})
