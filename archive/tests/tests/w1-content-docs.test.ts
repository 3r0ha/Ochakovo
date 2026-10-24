// README, стратегия, дорожная карта и брифы не противоречат продукту и друг другу.
// Запуск: pnpm test w1-content-docs (без базы)

import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const root = join(import.meta.dirname, '..', '..')
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')

/** README и docs/*.md, кроме планов (plan.md, case-delta.md) и текста кейса — их пишут не здесь */
const docs = ['README.md', ...readdirSync(join(root, 'docs')).filter((f) => f.endsWith('.md') && !['plan.md', 'case.md', 'case-delta.md'].includes(f)).map((f) => `docs/${f}`)]

/** Пункты списка из раздела с заголовком, где есть слово heading */
function section(rel: string, heading: string): string[] {
  const text = read(rel)
  const start = text.split('\n').findIndex((l) => /^#{2,3} /.test(l) && l.includes(heading))
  assert.ok(start >= 0, `в ${rel} нет раздела «${heading}»`)
  const lines = text.split('\n').slice(start + 1)
  const end = lines.findIndex((l) => /^#{1,3} /.test(l))
  return (end < 0 ? lines : lines.slice(0, end)).filter((l) => l.startsWith('- ')).map((l) => l.trim())
}

test('нет устаревших обещаний и неверных путей', () => {
  const banned: [RegExp, string][] = [
    [/src\/data\//, 'src/data/'],
    [/таблиц\S* рекордов/i, 'таблицы рекордов'],
    [/лучшие 10/i, 'лучшие 10'],
    [/все проверены/i, 'все проверены'],
    [/сортировк\S*(\s+\S+){0,2}\s+по\s+[«"]?смен/i, 'сортировка по «Смене»'],
    // Корпоративный автобус от м. «Озёрная», медосмотр и спецодежда за счёт компании — факты справочника студента
    // и «Описания практики» (docs/case-delta.md). Под запретом только ДМС за счёт компании: его в материалах нет
    [/ДМС[^.\n]{0,40}за\s+сч[её]т\s+компании|за\s+сч[её]т\s+компании[^.\n]{0,40}ДМС/i, 'ДМС за счёт компании'],
    [/дают\s+общежитие|его\s+дают/i, 'дают общежитие'],
    [/первые в СССР/i, 'первые в СССР'],
    [/прототип/i, 'прототип'],
    [/дегустатор/i, 'дегустатор'],
    [/двух рабочих/i, 'двух рабочих — срок ответа живёт в shared/candidateStatus.ts'],
  ]
  const hits: string[] = []
  for (const f of docs) {
    const text = read(f)
    for (const [re, name] of banned) if (re.test(text)) hits.push(`${f}: ${name}`)
    // «Рассмотрит заявку первой» — только в таблице отменённых решений дорожной карты
    for (const line of text.split('\n').filter((l) => /рассмотрит заявку первой/i.test(l)))
      if (!(f === 'docs/roadmap.md' && line.startsWith('| «Пройдёшь 4 задания'))) hits.push(`${f}: рассмотрит заявку первой`)
  }
  assert.deepEqual(hits, [])
})

test('дат нет: ни годов текущего века, ни дат в цифрах', () => {
  const hits: string[] = []
  for (const f of [...docs, 'archive/docs/concept-brief.md', 'archive/docs/home-brief.md']) {
    // Размеры «850 × 2000 мм» и «1080 × 1920» — не годы
    const text = read(f).replace(/\d+(?:[,.]\d+)?\s?×\s?\d+(?:[,.]\d+)?/g, '')
    for (const m of text.matchAll(/\b20[0-9]{2}\b|\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/g)) hits.push(`${f}: ${m[0]}`)
  }
  assert.deepEqual(hits, [])
})

test('список «Согласовать» одинаков в README, дорожной карте и стратегии', () => {
  const readme = section('README.md', 'Согласовать')
  const roadmap = section('docs/roadmap.md', 'Согласовать')
  const strategy = section('docs/strategy.md', 'Согласовать')
  assert.ok(readme.length >= 8)
  assert.deepEqual(roadmap, readme)
  assert.deepEqual(strategy, readme)
  const all = readme.join(' ')
  // Автобус, общежитие, переход в штат и документы практики теперь известны из справочника студента — их согласовывать не нужно
  for (const topic of ['Срок ответа', 'ДМС', 'согласия', 'Бонус за друга']) assert.ok(all.includes(topic), topic)
  // «Дальше» в README — по дорожной карте
  assert.deepEqual(section('README.md', 'Дальше'), section('docs/roadmap.md', 'Дальше'))
})

test('стратегия: одно определение «вышел на смену», экран у метрик, маркировка рекламы, без бонуса за задания', () => {
  const s = read('docs/strategy.md')
  assert.ok(!/первую неделю/.test(s))
  assert.equal((s.match(/\*\*Вышел на смену\*\* —/g) ?? []).length, 1)
  assert.match(s, /первая смена отработана/)
  assert.match(s, /определение — §1/)
  assert.ok(!/бонус за «?Смену 4\/4/i.test(s) && !/бонус за 4/i.test(s))
  assert.ok(!/запись на собеседование через QR/i.test(s))
  assert.match(s, /время собеседования назначает HR/i)
  assert.match(s, /ОРД/)
  assert.match(s, /erid/)
  assert.match(s, /10 тысяч подписчиков/)
  assert.match(s, /завод, где одновременно разливали Pepsi и Fanta/)
  // У каждой метрики — экран продукта
  const metrics = s.slice(s.indexOf('### Метрики'), s.indexOf('### Пилот'))
  const rows = metrics.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Метрика') && !l.startsWith('|---'))
  assert.ok(rows.length >= 5)
  for (const r of rows) assert.match(r.split('|')[3], /«Воронка»|карточке/, r)
})

test('стратегия: деньги пилота — вилка, допущения, обратный расчёт и пустая клетка для данных компании', () => {
  const s = read('docs/strategy.md')
  const money = s.slice(s.indexOf('### Пилот: деньги'), s.indexOf('## 9.'))
  assert.match(money, /\*\*Итог: пилот стоит от 780 тыс\. до 2,2 млн ₽\*\*/)
  assert.match(money, /400 ÷ 0,13/)
  assert.match(money, /______ ₽/)
  // У каждой строки сметы и целей по каналам — источник или «допущение»
  for (const title of ['**Цели по каналам.**', '**Смета по статьям §5**']) {
    const part = money.slice(money.indexOf(title))
    const table = part.split('\n\n')[1].split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Канал') && !l.startsWith('| Статья') && !l.startsWith('| **'))
    assert.ok(table.length >= 5, title)
    for (const row of table) assert.match(row, /допущение|сумма строк/, row)
  }
  // Сумма строк сметы совпадает с итогом
  const smeta = money.slice(money.indexOf('**Смета по статьям §5**')).split('\n\n')[1]
  const rows = smeta.split('\n').filter((l) => /^\| [^*|-]/.test(l) && !l.startsWith('| Статья'))
  const sum = (i: number) => rows.reduce((acc, r) => acc + Number(r.split('|')[i].trim().replace(/\s/g, '')), 0)
  assert.equal(sum(2), 780)
  assert.equal(sum(3), 2220)
})

test('брифы — в архиве с пометкой «устарело», ссылки на них верные', () => {
  for (const f of ['concept-brief.md', 'home-brief.md']) {
    assert.ok(!existsSync(join(root, 'docs', f)), `docs/${f} должен уехать в archive/docs`)
    assert.match(read(`archive/docs/${f}`), /\*\*Устарело\.\*\*/)
  }
  for (const f of docs) assert.ok(!/docs\/(concept|home)-brief\.md/.test(read(f).replace(/archive\/docs\//g, '')), f)
})

test('README: задания в порядке сайта и верная длительность игры', () => {
  const r = read('README.md')
  const order = ['«Собери лето»', '«Подбор работы»', '«Поймай брак»', '«Правда или миф»'].map((t) => r.indexOf(`. ${t}`))
  assert.ok(order.every((i) => i > 0), 'все четыре задания пронумерованы')
  assert.deepEqual([...order].sort((a, b) => a - b), order)
  assert.ok(!/30 секунд/.test(r))
  assert.match(r, /фильтр по заданиям/)
  assert.ok(!/HR дописывает базу|и дописывает базу/.test(read('docs/llm.md')))
})
