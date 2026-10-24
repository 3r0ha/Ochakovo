// Главная по полному кейсу, история и наставники (w2-hm-c2, w2-hm-c4): легенда «Квас делают люди» дословно из концепции,
// годы — из таймлайна shared, без алкоголя; карточки наставников — только с согласием. Запуск: pnpm test w2-home

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { brands, companyFigures, timeline } from '../../shared/content/company'
import { LEGEND, legendParagraphs, mentorCards } from '../../src/home/legend'

const read = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')
const concept = read('docs/brand/concept.md')
const history = read('src/home/History.tsx')
const mentors = read('src/home/Mentors.tsx')
const legendSrc = read('src/home/legend.ts')
const home = read('src/pages/Home.tsx')

/** Абзацы цитаты «Текст для сайта и бота» из раздела 7 концепции: первый — заголовок в **…** */
function conceptLegend() {
  const start = concept.indexOf('### Текст для сайта и бота')
  assert.ok(start >= 0, 'в docs/brand/concept.md нет «Текст для сайта и бота»')
  const block = concept
    .slice(start)
    .split('\n')
    .slice(1)
    .filter((l, i, all) => l.startsWith('>') || (i < all.findIndex((x) => x.startsWith('>')) && !l.trim()))
  const lines = block.filter((l) => l.startsWith('>')).map((l) => l.replace(/^>\s?/, ''))
  const paragraphs = lines.join('\n').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  return { title: paragraphs[0].replace(/^\*\*|\*\*$/g, ''), paragraphs: paragraphs.slice(1) }
}

test('легенда на главной — слово в слово абзацы концепции, заголовок — основной слоган', () => {
  const { title, paragraphs } = conceptLegend()
  assert.equal(LEGEND.title, title)
  assert.match(concept, new RegExp(`\\*\\*Основной:\\*\\* «${LEGEND.title}»`))
  assert.deepEqual(legendParagraphs(), paragraphs)
})

test('история: три года из таймлайна shared и «сегодня» в цифрах, лет в коде нет', () => {
  for (const y of LEGEND.years) {
    const t = timeline.find((x) => x.id === y.id)
    assert.ok(t, `в таймлайне нет ${y.id}`)
    assert.ok(y.text.includes(`${t.when} году`), `${y.id}: год в тексте не из таймлайна`)
  }
  // Три года по порядку; сами числа сверяет с концепцией проверка легенды выше
  const years = LEGEND.years.map((y) => Number(timeline.find((x) => x.id === y.id)!.when))
  assert.ok(years.every((y, i) => Number.isInteger(y) && (!i || y > years[i - 1])), `годы: ${years}`)
  assert.ok(timeline.some((t) => t.id === 'today'))
  assert.ok(companyFigures.length >= 4)
  assert.match(history, /companyFigures\.map/)
  assert.match(history, /brands\.map/)
  // Годы — данные, а не числа в коде главной
  for (const [name, src] of [['History.tsx', history], ['legend.ts', legendSrc], ['Mentors.tsx', mentors]] as const)
    assert.doesNotMatch(src, /\b(19[5-9]\d|20\d\d)\b/, `${name}: год в коде`)
})

test('бренды и тексты без алкоголя, без «не X, а Y» и восклицаний', () => {
  for (const b of brands) assert.doesNotMatch(`${b.name} ${b.kind}`, /пив|сидр|джин|вин|коктейл|Kern/i)
  const all = [...legendParagraphs(), ...LEGEND.steps].join(' ')
  assert.doesNotMatch(all, /!|\.\.\.|…|не [а-яё]+, а /i)
  assert.doesNotMatch(history + mentors, /пиво|сидр|ДМС/i)
})

test('наставники: три шага справочника, Квасыч — образ, карточки — только с согласием и без выдуманных', () => {
  assert.deepEqual([...LEGEND.steps], ['освоить процессы', 'освоить оборудование', 'работать на нём'])
  assert.match(LEGEND.kvasych, /На заводе учит настоящий наставник/)
  for (const m of mentorCards) {
    assert.equal(m.consent, true, `${m.name}: нет согласия`)
    assert.ok(m.name && m.teaches && m.advice && m.years, `${m.name}: карточка не по шаблону`)
  }
  // Кнопка Квасыча открывает чат вопросом — через openKvasychChat в стрелочной функции (контракт bus.ts)
  assert.match(mentors, /onClick=\{\(\) => openKvasychChat\('Кто будет учить\?'\)\}/)
})

test('порядок главной: история и наставники перед «Правдой или мифом», контрольные вопросы — в блоке мифа', () => {
  const order = [...home.matchAll(/<(\w+) \/>/g)].map((m) => m[1])
  const at = (name: string) => order.indexOf(name)
  assert.ok(at('Practice') === 1, 'практика — сразу после первого экрана')
  assert.ok(at('VacancyList') < at('History') && at('History') < at('Mentors') && at('Mentors') < at('MythSection'))
  const myth = read('src/home/MythSection.tsx')
  assert.match(myth, /<KnowledgeCheck /)
  const card = read('src/home/KnowledgeCheck.tsx')
  assert.match(card, /COMPANY_QUIZ_URL = '\/game\?t=quiz'/)
  assert.match(card, /COMPANY_QUIZ_ROUND/)
})
