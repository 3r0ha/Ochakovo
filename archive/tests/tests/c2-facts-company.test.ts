// История и бренды «Очаково» без алкоголя: таймлайн 1978, 1996, 1998, сегодня; «Очаково» сегодня в цифрах;
// ключевые безалкогольные бренды — только с ochakovo.ru/brands и из материалов компании.
// Запуск: pnpm test c2-facts-company (без базы)

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { brandPlatform, brands, brandsLine, companyFigures, companySummary, timeline } from '../../shared/content/company'
import { companyQuiz } from '../../shared/content/companyQuiz'
import { contacts, myths, perks, phonebook, steps } from '../../shared/content/content'
import { departments } from '../../shared/content/departments'
import { faq } from '../../shared/content/faq'
import { handbook } from '../../shared/content/handbook'
import { freePracticeInfo, paidPracticeInfo } from '../../shared/content/practice'
import { stages } from '../../shared/content/production'
import { quiz } from '../../shared/content/quiz'
import { scheduleSummary, vacancies } from '../../shared/content/vacancies'

const root = join(import.meta.dirname, '..', '..')
const companyTs = readFileSync(join(root, 'shared/content/company.ts'), 'utf8')

/** Всё, что из shared/content видит человек: тексты данных, без комментариев в исходниках */
const visible = JSON.stringify([
  timeline, companyFigures, companySummary, brands, brandsLine, brandPlatform, myths, perks, steps, contacts, phonebook,
  departments, faq, handbook, paidPracticeInfo, freePracticeInfo, stages, quiz, vacancies, scheduleSummary, companyQuiz,
])

test('таймлайн: 1978, 1996, 1998 и сегодня — без пива и коктейлей', () => {
  assert.deepEqual(timeline.map((t) => t.when), ['1978', '1996', '1998', 'Сегодня'])
  const by = Object.fromEntries(timeline.map((t) => [t.when, t]))
  assert.match(by['1978'].text, /Олимпиад/)
  assert.match(by['1978'].text, /самое мощное предприятие отрасли в Европе и СССР/)
  assert.match(by['1996'].text, /двойное брожение кваса, молочнокислое и дрожжевое/)
  assert.match(by['1998'].text, /кваса «Очаковский», самого известного бренда/)
  assert.match(by['Сегодня'].title, /Лидер рынка натурального кваса/)
  for (const part of ['Москве, Краснодаре, Пензе и Тюмени', '60 регионах', '30 странах', 'без иностранного капитала']) assert.ok(by['Сегодня'].text.includes(part), part)
  // 1993–1995 (пиво) и 1997 (джин-тоник) из каталога не берём
  for (const year of ['1993', '1994', '1995', '1997']) assert.ok(!timeline.some((t) => t.when === year), year)
})

test('нигде в видимых текстах контента нет алкоголя', () => {
  const alcohol = /(?<![а-яё])(пив[аоуе]?(?![а-яё])|пивн|пивовар|сидр|джин|коктейл|водк|вин[оа](?![а-яё])|винн|алкогол|слабоалкогол|мохито)/i
  const m = alcohol.exec(visible.toLowerCase())
  assert.equal(m, null, m ? `найдено «${m[0]}»: …${visible.slice(Math.max(0, m.index - 60), m.index + 60)}…` : '')
})

test('«Очаково» сегодня в цифрах — из каталога и ochakovo.ru', () => {
  const byId = Object.fromEntries(companyFigures.map((f) => [f.id, f.value]))
  assert.deepEqual(byId, { regions: '60', countries: '30+', plants: '10', cities: '4', bottles: '70 000', russian: '100%' })
  assert.match(companySummary, /лидирует на рынке натурального кваса/)
  assert.match(companySummary, /1978/)
})

test('бренды — только безалкогольные с ochakovo.ru/brands, квас первым', () => {
  // https://ochakovo.ru/brands/: безалкогольные категории «Квас», «Лимонады», «Газированные напитки», «Холодный чай», «Питьевая вода», «Соки»
  const onSite = ['«Очаковский»', '«Семейный секрет»', '«Очаковский лимонад»', 'CoolCola', 'Fancy', 'Street', 'Toness', 'Inice', 'Goodini', 'Cristallo di rocco', '«Ах!»']
  for (const b of brands) assert.ok(onSite.includes(b.name), `${b.name} нет в безалкогольных категориях ochakovo.ru`)
  assert.deepEqual(brands.filter((b) => b.key).map((b) => b.name), ['«Очаковский»', '«Семейный секрет»'])
  assert.equal(brands[0].name, '«Очаковский»')
  assert.ok(!brands.some((b) => /Мохито|Kern|Powran|Varan/i.test(b.name)), 'спорные бренды не берём')
  assert.match(brandsLine, /^квас «Очаковский» и «Семейный секрет»/)
  assert.match(companyTs, /https:\/\/ochakovo\.ru\/brands\//)
})

test('платформа бренда — из брендбука', () => {
  assert.equal(brandPlatform.calling, 'Натуральные — значит настоящие')
  assert.equal(brandPlatform.essence, 'Патриоты своего дела')
  assert.equal(brandPlatform.mission, 'Во благо людей. На благо страны.')
  assert.deepEqual(brandPlatform.values.map((v) => v.value), ['Добросовестность', 'Патриотизм', 'Забота о людях', 'Честность', 'Созидательность'])
})

test('у таймлайна — цитаты каталога и источник', () => {
  for (const quote of ['в преддверии Олимпиады-80', 'двойного (молочнокислого', 'Начало выпуска самого известного бренда', 'Лидер рынка натурального кваса', '10 предприятий, построенных', 'в 60 регионов'])
    assert.ok(companyTs.includes(quote), quote)
  assert.match(companyTs, /archive\/case-materials\/history/)
})
