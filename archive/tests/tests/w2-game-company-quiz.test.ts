// «Что ты знаешь об „Очаково“» (w2-gm-c1): ход прохождения, счёт, клавиши, тексты итога и страница /game?t=quiz.
// Логика — чистые функции src/game/companyQuizPlay.ts, разметка проверяется по исходникам. Запуск: pnpm test w2-game

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { COMPANY_QUIZ_ROUND, companyQuiz, companyQuizById } from '../../shared/content/companyQuiz'
import { paidPracticeInfo } from '../../shared/content/practice'
import {
  advance,
  answer,
  currentItem,
  feedbackFor,
  isAnswered,
  isFinished,
  mistakesOf,
  newPlay,
  optionForKey,
  practiceLine,
  resultTail,
  scoreOf,
  topicLabels,
  verdictAt,
  type QuizPlay,
} from '../../src/game/companyQuizPlay'

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const plain = (t: string) => t.replace(/[  ]/g, ' ').replace(/⁠/g, '')

/** Повторяемый генератор: одинаковый сид — одинаковый раунд */
function seeded(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Пройти раунд: right — отвечать верно на эти номера вопросов, на остальные — первым неверным вариантом */
function playThrough(p: QuizPlay, right: (i: number) => boolean) {
  let s = p
  while (!isFinished(s)) {
    const item = currentItem(s)!
    const wrong = item.options.findIndex((_, i) => i !== item.answer)
    s = advance(answer(s, right(s.index) ? item.answer : wrong))
  }
  return s
}

test('раунд: 7 разных вопросов из 12, варианты перемешаны, правильный ответ указывает на тот же текст', () => {
  assert.equal(COMPANY_QUIZ_ROUND, 7)
  for (let seed = 1; seed <= 40; seed++) {
    const p = newPlay(seeded(seed))
    assert.equal(p.items.length, COMPANY_QUIZ_ROUND)
    assert.equal(new Set(p.items.map((q) => q.id)).size, COMPANY_QUIZ_ROUND, 'вопросы не повторяются')
    for (const q of p.items) {
      const src = companyQuizById(q.id)!
      assert.equal(q.options[q.answer], src.options[src.answer], `${q.id}: правильный вариант после перемешивания`)
      assert.deepEqual([...q.options].sort(), [...src.options].sort())
    }
  }
  // Случайность настоящая: за 40 раундов правильный ответ стоит не только первым
  const positions = new Set(Array.from({ length: 40 }, (_, s) => newPlay(seeded(s + 100)).items[0].answer))
  assert.ok(positions.size > 1, 'правильный ответ всегда на одном месте')
})

test('ответ: сразу виден итог вопроса, второй ответ и вариант вне списка ничего не меняют, «Дальше» — только после ответа', () => {
  const p = newPlay(seeded(7))
  assert.equal(isAnswered(p), false)
  assert.equal(advance(p), p, 'без ответа дальше не идём')
  assert.equal(answer(p, 9), p)
  assert.equal(answer(p, -1), p)
  assert.equal(answer(p, 1.5), p)

  const item = currentItem(p)!
  const a = answer(p, item.answer)
  assert.equal(isAnswered(a), true)
  assert.equal(verdictAt(a, 0), true)
  assert.equal(answer(a, (item.answer + 1) % item.options.length), a, 'ответ не переигрывается')
  assert.equal(scoreOf(a), 1)

  const b = advance(a)
  assert.equal(b.index, 1)
  assert.equal(isAnswered(b), false)
  assert.equal(verdictAt(b, 1), null)
})

test('счёт и разбор: все верно — 7 из 7 без ошибок; через один — счёт и правильные варианты в разборе', () => {
  const all = playThrough(newPlay(seeded(3)), () => true)
  assert.equal(isFinished(all), true)
  assert.equal(scoreOf(all), 7)
  assert.deepEqual(mistakesOf(all), [])
  assert.equal(currentItem(all), null)
  assert.equal(advance(all), all)

  const half = playThrough(newPlay(seeded(5)), (i) => i % 2 === 0)
  assert.equal(scoreOf(half), 4)
  const mistakes = mistakesOf(half)
  assert.equal(mistakes.length, 3)
  for (const m of mistakes) {
    const src = companyQuizById(m.id)!
    assert.equal(m.question, src.question)
    assert.equal(m.right, src.options[src.answer])
  }
})

test('клавиши: 1–4 и А–Г в русской раскладке, лишние — мимо', () => {
  assert.equal(optionForKey('1', 4), 0)
  assert.equal(optionForKey('4', 4), 3)
  assert.equal(optionForKey('4', 3), null, 'четвёртого варианта нет')
  assert.equal(optionForKey('а', 4), 0)
  assert.equal(optionForKey('Б', 4), 1)
  assert.equal(optionForKey('г', 4), 3)
  for (const k of ['0', '5', 'Enter', ' ', 'ArrowLeft', 'a', 'д']) assert.equal(optionForKey(k, 4), null, k)
})

test('объяснение: «Верно» или «Неверно», диктор слышит объяснение, которое начинается с правильного ответа', () => {
  for (const q of companyQuiz) {
    const item = { ...q, order: q.options.map((_, i) => i) }
    const right = feedbackFor(item, q.answer)
    assert.equal(right.correct, true)
    assert.equal(right.title, 'Верно')
    assert.ok(right.announce.endsWith(q.explain))
    const wrong = feedbackFor(item, (q.answer + 1) % q.options.length)
    assert.equal(wrong.title, 'Неверно')
    // Первая фраза объяснения называет правильный вариант: человек сразу видит ответ, даже если ошибся
    const lead = plain(q.explain).split(/\.\s/)[0].toLowerCase()
    const keys = plain(q.options[q.answer]).toLowerCase().match(/\d+|[а-яё]{4,}/g) ?? []
    assert.ok(keys.some((k) => lead.includes(k)), `${q.id}: первая фраза объяснения не называет ответ`)
  }
})

test('итог: фраза без счёта в начале, с заглавной, с точкой, без «!» и рода; строка о практике — суммы из shared', () => {
  for (let total = 1; total <= 7; total++)
    for (let score = 0; score <= total; score++) {
      const tail = resultTail(score, total)
      assert.doesNotMatch(tail, /^\d/, tail)
      assert.match(tail, /^[А-ЯЁ]/, tail)
      assert.match(tail, /\.$/, tail)
      assert.doesNotMatch(tail, /!|…|\(а\)|ответил|молодец/i, tail)
    }
  assert.equal(resultTail(7, 7), 'Все ответы верные.')

  const line = plain(practiceLine())
  const rub = (n: number) => plain(n.toLocaleString('ru-RU'))
  assert.ok(line.includes(`от ${rub(paidPracticeInfo.payFrom)} до ${rub(paidPracticeInfo.payTo)} ₽ в месяц до вычета налога`), line)
  assert.ok(line.includes(`${paidPracticeInfo.units.length} отдела`), line)
  assert.doesNotMatch(line, /!/)
})

test('у каждой темы вопросов есть подпись', () => {
  for (const q of companyQuiz) assert.ok(topicLabels[q.topic], q.topic)
})

test('страница: /game?t=quiz — режим страницы игры с h1, переключатель режимов и заголовок вкладки', () => {
  const page = read('src/pages/Game.tsx')
  assert.match(page, /params\.get\('t'\) === 'quiz'/)
  assert.match(page, /to: '\/game\?t=quiz'/)
  assert.match(page, /aria-current=\{on \? 'page' : undefined\}/)
  assert.match(page, /<CompanyQuiz tone="dark" size="page"/)
  // «7 вопросов об „Очаково“»: число — из данных раунда; метка «Викторина» не спорит с пунктом меню «Вопросы»
  assert.match(page, /\{COMPANY_QUIZ_ROUND\} вопросов <br className="lg:hidden" \/>\s*об&nbsp;<span className="text-brand">«Очаково»<\/span>/)
  assert.match(page, /label: 'Викторина', to: '\/game\?t=quiz'/)
  assert.doesNotMatch(page, /Что ты знаешь|Контрольные вопросы'/)
  assert.match(page, /document\.title = /)
})

test('виджет: CompanyQuizCard и CompanyQuiz экспортируются, итог ведёт на оплачиваемую практику и в заявку, счёт — в хранилище', () => {
  const src = read('src/game/CompanyQuiz.tsx')
  assert.match(src, /export function CompanyQuizCard\(/)
  assert.match(src, /export function CompanyQuiz\(/)
  assert.match(src, /to="\/vacancies#paid"/)
  assert.match(src, /to="\/apply"/)
  // Главное действие итога — заявка (красная), практика — вторым, обводкой
  assert.match(src, /<Link to="\/apply" className=\{`\$\{buttonBase\} \$\{t\.primary\}`\}>/)
  assert.match(src, /<Link to="\/vacancies#paid" className=\{`\$\{buttonBase\} \$\{t\.ghost\}`\}>/)
  assert.ok(src.indexOf('<Link to="/apply"') < src.indexOf('<Link to="/vacancies#paid"'), 'заявка не первой')
  // Карточка — те же названия, что на странице игры и на главной
  assert.match(src, /export const COMPANY_QUIZ_KICKER = 'Викторина'/)
  assert.match(src, /export const COMPANY_QUIZ_TITLE = `\$\{COMPANY_QUIZ_ROUND\} \$\{plural\(COMPANY_QUIZ_ROUND, \['вопрос', 'вопроса', 'вопросов'\]\)\} об\\u00A0«Очаково»`/)
  assert.match(src, /useCompanyQuiz\.getState\(\)\.finish\(/)
  // Доступность: живой регион, переход фокуса, подписи для диктора, клавиатура
  assert.match(src, /<Announce message=\{message\} \/>/)
  assert.match(src, /focus\(\{ preventScroll: true \}\)/)
  assert.match(src, /className="sr-only"/)
  assert.match(src, /optionForKey\(e\.key/)
  // Тексты для людей: без «!» и многоточий
  const strings = src.match(/'[^'\n]*[а-яё][^'\n]*'|`[^`\n]*[а-яё][^`\n]*`|>[^<>{}\n]*[а-яё][^<>{}\n]*</gi) ?? []
  for (const s of strings) assert.doesNotMatch(s, /!(?!=)|…/, s)
})

test('хранилище: лучший счёт только растёт, первый законченный раунд — одно событие воронки', () => {
  const store = read('src/game/companyQuizStore.ts')
  assert.match(store, /name: 'ochakovo\.companyQuiz'/)
  assert.match(store, /if \(s\.rounds === 0\) trackEvent\('task_done', \{ task: 'company' \}\)/)
  assert.match(store, /score \/ total > s\.best\.score \/ s\.best\.total/)
  assert.match(store, /export const companyQuizSnapshot = /)
})
