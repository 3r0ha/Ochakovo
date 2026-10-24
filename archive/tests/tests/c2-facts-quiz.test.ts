// Контрольные вопросы на знание компании (companyQuiz.ts) и «Подбор работы» (quiz.ts) по новым вакансиям.
// Запуск: pnpm test c2-facts-quiz (без базы)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  COMPANY_QUIZ_ROUND,
  companyQuiz,
  companyQuizById,
  companyQuizResult,
  companyQuizRound,
} from '../../shared/content/companyQuiz'
import { dorm, PAY_DAYS } from '../../shared/content/handbook'
import { quiz, scoreQuiz, type QuizAnswer } from '../../shared/content/quiz'
import { freePractice, vacancies, vacancyById } from '../../shared/content/vacancies'

/** Повторяемый генератор случайных чисел (mulberry32) */
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

/** Предложения: точки после «к.», «доб.», «ст.» концом не считаются */
const sentences = (text: string) =>
  text
    .replace(/(^|[\s(«])(ст|м|ул|д|доб|г|к)\.(?=\s)/gi, '$1$2')
    .split(/(?<=[.?!])\s+/)
    .filter(Boolean)

test('12 контрольных вопросов: 3–4 варианта, правильный ответ, объяснение в одну-две фразы и источник', () => {
  assert.equal(companyQuiz.length, 12)
  assert.equal(new Set(companyQuiz.map((q) => q.id)).size, 12)
  const sources = new Set(['Каталог продукции «Очаково»', 'ochakovo.ru, «История»', 'Описание практики «Очаково»', 'Справочник студента «Очаково»'])
  for (const q of companyQuiz) {
    assert.match(q.id, /^[a-z0-9-]+$/, 'id годится для кнопок бота')
    assert.ok(q.options.length >= 3 && q.options.length <= 4, `${q.id}: ${q.options.length} вариантов`)
    assert.equal(new Set(q.options).size, q.options.length, `${q.id}: варианты повторяются`)
    assert.ok(Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length, q.id)
    assert.ok(q.question.endsWith('?') || q.question.endsWith('?»'), `${q.id}: вопрос без знака вопроса`)
    const n = sentences(q.explain).length
    assert.ok(n >= 1 && n <= 2, `${q.id}: объяснение из ${n} фраз`)
    assert.ok(sources.has(q.source), `${q.id}: источник «${q.source}»`)
    for (const text of [q.question, q.explain, ...q.options]) {
      assert.ok(!text.includes('!'), `«!» в ${q.id}`)
      assert.ok(!/все (ответы|варианты) верн|ничего из перечисленного/i.test(text), q.id)
      assert.ok(!/\b(готов|согласен|должен|прош[её]л|заболел)\b/i.test(text), `род в ${q.id}: ${text}`)
    }
    // Объяснение начинается с правильного ответа: первое слово варианта есть в первой фразе
    const key = q.options[q.answer].split(/[\s:,—]+/).find((w) => w.replace(/[«»]/g, '').length >= 2)!.replace(/[«»]/g, '')
    assert.ok(sentences(q.explain)[0].toLowerCase().includes(key.toLowerCase()), `${q.id}: «${key}» нет в первой фразе объяснения`)
  }
})

test('вопросы не школьные: история, квас, практика, наставник, сезон и быт', () => {
  const topics = new Set(companyQuiz.map((q) => q.topic))
  for (const t of ['history', 'kvass', 'practice', 'mentor', 'season', 'life']) assert.ok(topics.has(t as never), t)
  assert.ok(companyQuiz.filter((q) => ['practice', 'mentor', 'season', 'life'].includes(q.topic)).length >= 6, 'больше половины — о работе и практике')
})

test('цифры в вопросах — из вакансий и справочника', () => {
  const pay = companyQuizById('operator-pay')!
  assert.match(pay.options[pay.answer].replace(/\s/g, ' '), new RegExp(`От ${(vacancyById('bottling-operator')!.pay!.from).toLocaleString('ru-RU').replace(/\s/g, ' ')} ₽`))
  const d = companyQuizById('dorm')!
  assert.equal(d.options[d.answer].replace(/\s/g, ' '), `${dorm.priceStudent.toLocaleString('ru-RU').replace(/\s/g, ' ')} ₽`)
  const p = companyQuizById('payday')!
  assert.equal(p.options[p.answer], `${PAY_DAYS[0]}-го и ${PAY_DAYS[1]}-го числа`)
  assert.match(companyQuizById('practice-units')!.explain, /в 4 отделах/)
  assert.match(companyQuizById('mentor')!.explain, /Учебном центре/)
  assert.match(companyQuizById('probation')!.options[0], /^Нет, вместо него производственная практика$/)
})

test('раунд: 7 вопросов без повторов, варианты перемешаны, правильный ответ не теряется', () => {
  assert.equal(COMPANY_QUIZ_ROUND, 7)
  const seen = new Set<string>()
  const firstCorrect = new Set<number>()
  for (let i = 0; i < 200; i++) {
    const round = companyQuizRound(seeded(i + 1))
    assert.equal(round.length, 7)
    assert.equal(new Set(round.map((q) => q.id)).size, 7)
    for (const q of round) {
      const base = companyQuizById(q.id)!
      assert.equal(q.options[q.answer], base.options[base.answer], `${q.id}: правильный ответ потерялся`)
      assert.deepEqual([...q.options].sort(), [...base.options].sort())
      assert.deepEqual(q.order.map((i) => base.options[i]), q.options)
      seen.add(q.id)
      firstCorrect.add(q.answer)
    }
  }
  assert.equal(seen.size, 12, 'за много раундов выпадает каждый вопрос')
  assert.ok(firstCorrect.size >= 3, 'правильный ответ стоит на разных местах')
  // Один rng — один раунд; крайние значения rng не ломают раунд
  assert.deepEqual(companyQuizRound(seeded(5)).map((q) => q.id), companyQuizRound(seeded(5)).map((q) => q.id))
  assert.equal(companyQuizRound(() => 0).length, 7)
  assert.equal(companyQuizRound(() => 0.9999999).length, 7)
  assert.equal(companyQuizRound(seeded(1), 50).length, 12)
})

test('итог раунда — счёт одной фразой, без «!»', () => {
  assert.equal(companyQuizResult(7, 7), '7 из 7, все ответы верные.')
  assert.match(companyQuizResult(5, 7), /^5 из 7\. /)
  assert.match(companyQuizResult(1, 7), /^1 из 7\. /)
  for (let s = 0; s <= 7; s++) assert.ok(!companyQuizResult(s, 7).includes('!'))
})

// ── «Подбор работы» ─────────────────────────────────────────────────────

const all: { picks: QuizAnswer[]; id: string }[] = []
for (const a of quiz[0].answers) for (const b of quiz[1].answers) for (const c of quiz[2].answers) for (const d of quiz[3].answers) all.push({ picks: [a, b, c, d], id: scoreQuiz([a, b, c, d]) })
const study = (prefix: string) => all.filter((r) => r.picks[2].text.startsWith(prefix))

test('подбор работы: веса только у существующих вакансий, каждая вакансия кому-то выпадает', () => {
  const ids = new Set(vacancies.map((v) => v.id))
  for (const q of quiz) for (const a of q.answers) for (const id of Object.keys(a.weights)) assert.ok(ids.has(id), `нет вакансии ${id}`)
  const results = new Set(all.map((r) => r.id))
  for (const v of vacancies) assert.ok(results.has(v.id), `${v.id} не выпадает никогда`)
  // На сайте «1–2 месяца» показывают летние месяцы — текст ответа начинается так
  assert.ok(quiz[3].answers.some((a) => a.text.startsWith('1–2 месяца')))
})

test('подбор работы: профильная учёба решает, маркетолог не попадает в лабораторию и цех', () => {
  const chem = study('Технолог')
  const chemProfile = chem.filter((r) => ['lab-chemist', 'fermentation-assistant', 'microbiologist-intern'].includes(r.id))
  assert.ok(chemProfile.length >= chem.length * 0.9, 'химик — в лабораторию или технологический цех')
  assert.ok(chem.filter((r) => r.id === 'lab-chemist').length >= chem.length / 4, 'химику чаще всего — лаборант')
  const eng = study('Инженерное')
  assert.ok(eng.filter((r) => r.id === 'automation-intern').length > eng.length / 2, 'инженеру — практика с инженерами')
  // Роли с профильной учёбой без неё не выпадают: лаборатория — только химикам, практика с инженерами — только инженерам
  const profile = { 'lab-chemist': 'Технолог', 'microbiologist-intern': 'Технолог', 'automation-intern': 'Инженерное' } as Record<string, string>
  for (const r of all)
    if (profile[r.id]) assert.ok(r.picks[2].text.startsWith(profile[r.id]) || r.picks[2].text.startsWith('Другое'), `${r.id} выпал при учёбе «${r.picks[2].text}»`)
  const mkt = study('Маркетинг')
  assert.ok(mkt.filter((r) => r.id === 'marketing-intern').length > mkt.length / 2)
  const hum = study('История')
  assert.ok(hum.filter((r) => r.id === 'marketing-intern').length > hum.length / 2, 'гуманитарию — практика в офисе')
  const log = study('Логистика')
  assert.ok(log.filter((r) => vacancyById(r.id)!.department === 'logistics' || r.id === 'merchandiser').length >= log.length * 0.85, 'логисту — склад')
})

test('подбор работы: «1–2 месяца» ведёт в бесплатную практику, «с весны» — в оплачиваемую', () => {
  const short = all.filter((r) => r.picks[3].text.startsWith('1–2 месяца') && !r.picks[2].text.startsWith('Другое'))
  const free = new Set(freePractice.map((v) => v.id))
  assert.ok(short.filter((r) => free.has(r.id)).length > short.length * 0.6, 'короткий срок — бесплатная практика')
  // Оплачиваемая практика есть для технологов, химиков, логистов и тех, кто учится на другое; маркетологам и инженерам — бесплатная
  const spring = all.filter((r) => r.picks[3].text === 'С весны до конца лета' && /^(Технолог|Логистика|Другое)/.test(r.picks[2].text))
  assert.ok(spring.filter((r) => vacancyById(r.id)!.format === 'Оплачиваемая практика').length > spring.length * 0.6)
  // «Постоянно» без профильной учёбы — работа в магазине или мерчандайзером
  const perm = all.filter((r) => r.picks[3].text === 'Хочу работать постоянно' && r.picks[2].text.startsWith('Другое'))
  assert.ok(perm.some((r) => vacancyById(r.id)!.format === 'Постоянная работа'))
})
