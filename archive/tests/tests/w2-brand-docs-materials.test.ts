// Материалы бренда (docs/brand/*.md, кроме concept.md, и docs/analytics.md): все части задач на месте,
// тексты — по docs/quality-brief.md, суммы — из официальных фактов и shared/content, у внешних цифр есть источник,
// дат нет, пути и картинки существуют, результаты фокус-группы не выдуманы.
// Запуск: pnpm test w2-brand-docs (без базы)

import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { test } from 'node:test'
import { dorm, PASS_FINE, practiceDocs } from '../../shared/content/handbook'
import { maxEntryPay, minMonthlyPay, paidPractice } from '../../shared/content/vacancies'

const root = join(import.meta.dirname, '..', '..')
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')

const FILES = {
  readme: 'docs/brand/README.md',
  visuals: 'docs/brand/visuals.md',
  merch: 'docs/brand/merch.md',
  video: 'docs/brand/video.md',
  clips: 'docs/brand/clips.md',
  rationale: 'docs/brand/rationale.md',
  focus: 'docs/brand/focus-group.md',
  analytics: 'docs/analytics.md',
} as const
type Key = keyof typeof FILES
const docs = Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, read(f)])) as Record<Key, string>
const caseText = read('docs/case.md')
const concept = read('docs/brand/concept.md')

const nbsp = (s: string) => s.replace(/[  ]/g, ' ')
const rub = (n: number) => `${n.toLocaleString('ru-RU').replace(/\s/g, ' ')} ₽`

/** Текст раздела второго уровня, в заголовке которого есть title, — до следующего «## » */
function section(text: string, title: string): string {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.startsWith('## ') && l.includes(title))
  assert.ok(start >= 0, `нет раздела «${title}»`)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => l.startsWith('## '))
  return (end < 0 ? rest : rest.slice(0, end)).join('\n')
}

/** Подраздел третьего уровня внутри текста раздела — до следующего заголовка второго или третьего уровня */
function subsection(text: string, title: string): string {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.startsWith('### ') && l.includes(title))
  assert.ok(start >= 0, `нет подраздела «${title}»`)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => /^#{2,3} /.test(l))
  return (end < 0 ? rest : rest.slice(0, end)).join('\n')
}

/** Строки таблицы без шапки и разделителя: массив ячеек */
function tableRows(text: string): string[][] {
  return text
    .split('\n')
    .filter((l) => l.startsWith('|') && !/^\|[-\s|]+\|$/.test(l))
    .slice(1)
    .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()))
}

const CYR = 'а-яё'
const NOT_X_BUT_Y = new RegExp(`(?<![${CYR}])не\\s+[^.,;:!?—\\n]{1,40}?,\\s*а\\s`, 'iu')
const NOT_ONLY = new RegExp(`(?<![${CYR}])не\\s+только[^.\\n]{1,60}?[\\s,]но\\s+и(?![${CYR}])`, 'iu')
/** Мужской или женский род там, где к читателю нужен нейтральный */
const GENDERED = new RegExp(
  `(?<![${CYR}])(готов|готова|согласен|согласна|уверен|уверена|должен|должна|рад|рада|сам|сама|самому|поймал|поймала|пришёл|пришла|пошёл|пошла|поменял|поменяла|прошёл|прошла|закончил|закончила|привёл|привела|смог|смогла)(?![${CYR}])`,
  'iu',
)
const ALCOHOL = new RegExp(`(?<![${CYR}])(пив|сидр|коктейл|алкогол|джин)`, 'iu')
const OFFICIALESE = /осуществл|предоставля|в\s+рамках/iu

/** Нарушения правил текстов. Ссылки и код не проверяем: в адресах бывают любые знаки */
function textProblems(text: string): string[] {
  const t = text
    .replace(/!\[/g, '[')
    .replace(/\]\([^)\s]+\)/g, ']')
    .replace(/`[^`\n]*`/g, '')
    .replaceAll('«не X, а Y»', '')
  const out: string[] = []
  if (t.includes('!')) out.push('восклицательный знак')
  if (/…|\.\.\./.test(t)) out.push('многоточие')
  if (NOT_X_BUT_Y.test(t)) out.push(`«не X, а Y»: ${t.match(NOT_X_BUT_Y)?.[0]}`)
  if (NOT_ONLY.test(t)) out.push(`«не только X, но и Y»: ${t.match(NOT_ONLY)?.[0]}`)
  if (/,\s*а\s+не\s/iu.test(t)) out.push(`«X, а не Y»: ${t.match(/[^.,]{0,30},\s*а\s+не\s[^.,]{0,20}/u)?.[0]}`)
  if (GENDERED.test(t)) out.push(`род: ${t.match(GENDERED)?.[0]}`)
  const unquoted = t.replace(/«[^«»\n]*»/g, '')
  if (OFFICIALESE.test(unquoted)) out.push(`канцелярит: ${unquoted.match(OFFICIALESE)?.[0]}`)
  if (/["”]/.test(t)) out.push('прямые кавычки')
  if (new RegExp(`(?<![${CYR}])(еще|ее|учеба|зачет|отчет)(?![${CYR}])`, 'iu').test(t)) out.push('нужна «ё»')
  return out
}

/** Шапка таблицы, к которой относится строка с номером i, или пустая строка */
function tableHeader(lines: string[], i: number): string {
  if (!lines[i].startsWith('|')) return ''
  let j = i
  while (j > 0 && lines[j - 1].startsWith('|')) j--
  return lines[j]
}

// Суммы из официальных фактов: «Описание практики», справочник студента и данные сайта
const norm = (s: string) => s.replace(/[\s  ]/g, '')
const grouped = (text: string) => [...nbsp(text).matchAll(/(?<![\d,])\d{1,3}(?:[ ]\d{3})+(?![\d,])/g)].map((m) => norm(m[0]))
const OFFICIAL = new Set([
  ...grouped(caseText),
  ...[minMonthlyPay, maxEntryPay, dorm.priceStudent, dorm.priceOther, PASS_FINE].map(String),
  ...paidPractice.map((v) => String(v.pay?.from)),
])

/** Суммы в рублях в строке: числа с разрядами и число прямо перед «₽» или «тыс. ₽» */
function amounts(line: string): string[] {
  const l = nbsp(line)
  const out = grouped(l)
  for (const m of l.matchAll(/(?<![\d,])(?<!\d )(\d+)\s?(тыс\.\s?)?₽/g)) out.push(m[2] ? `${m[1]}000` : m[1])
  return out
}

test('все части задач на месте: листовки, маскот, образы, референсы, мерч, ролик, обоснование, аналитика, фокус-группа', () => {
  const need: Record<Key, string[]> = {
    readme: [],
    visuals: ['Коротко', 'Фирменный стиль', 'Ключевые образы', 'Листовки', 'Маскот', 'Референсы', 'Согласовать'],
    merch: ['Коротко', 'Что отражает', 'Набор', 'Как выглядит', 'Сколько стоит', 'Чего не делаем', 'Источники', 'Согласовать'],
    video: ['Коротко', 'Зачем', 'Сценарий', 'Что можно взять', 'Как снимать', 'Где показываем', 'Сколько стоит', 'Референсы', 'Согласовать'],
    clips: ['Коротко', 'Как устроен', 'Сценарии', 'съёмочный день', 'Чего не делаем', 'Сколько стоит', 'Согласовать'],
    rationale: ['Коротко', 'Как мы пришли', 'проблемы кейса', 'образы', 'представлен бренд', 'Затраты', 'Риски', 'Как проверить'],
    focus: ['Коротко', 'Гипотезы', 'Кого зовём', 'Данные и согласие', 'Сценарий', 'Вопросы', 'Что меряем', 'Результаты', 'Что меняем'],
    analytics: ['Коротко', 'Целевая аудитория', 'Потенциальная аудитория', 'Путь кандидата', 'Аналоги', 'Выводы', 'Источники'],
  }
  for (const [key, titles] of Object.entries(need) as [Key, string[]][])
    for (const t of titles) assert.ok(section(docs[key], t).trim().length > 80, `${FILES[key]}: раздел «${t}» пустой`)
  // Индекс материалов ведёт на каждый документ
  for (const f of ['concept.md', 'visuals.md', 'merch.md', 'video.md', 'clips.md', 'rationale.md', 'focus-group.md', '../analytics.md'])
    assert.ok(docs.readme.includes(`](${f})`), `README бренда не ссылается на ${f}`)
})

test('тексты по quality-brief: без «!», многоточий, «не X, а Y», рода к читателю, канцелярита и прямых кавычек', () => {
  for (const [key, text] of Object.entries(docs) as [Key, string][]) assert.deepEqual(textProblems(text), [], FILES[key])
})

test('дат нет: только исторические годы из официальных фактов', () => {
  // Размеры «850 × 2000 мм» и «1080 × 1920» — не годы
  for (const [key, raw] of Object.entries(docs) as [Key, string][]) {
    const text = raw.replace(/\d+(?:[,.]\d+)?\s?×\s?\d+(?:[,.]\d+)?/g, '')
    assert.deepEqual(text.match(/(?<!\d)20\d{2}(?!\d)/g) ?? [], [], `${FILES[key]}: год текущего века`)
    assert.deepEqual(text.match(/\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/g) ?? [], [], `${FILES[key]}: дата в цифрах`)
    for (const y of text.match(/(?<!\d)19\d{2}(?!\d)/g) ?? []) assert.ok(['1978', '1996', '1998'].includes(y), `${FILES[key]}: год ${y}`)
  }
})

test('суммы: официальные или помечены как ориентир, старых сумм нет', () => {
  for (const [key, text] of Object.entries(docs) as [Key, string][]) {
    const lines = text.split('\n')
    let heading = ''
    lines.forEach((line, i) => {
      if (/^#{2,3} /.test(line)) heading = line
      if (!line.includes('₽')) return
      // Ориентиры и допущения команды — только с пометкой в строке или в разделе о цене
      if (/ориентир|допущени/i.test(line) || /Сколько стоит|Затраты/.test(heading)) return
      for (const a of amounts(line)) assert.ok(OFFICIAL.has(a), `${FILES[key]}:${i + 1}: сумма ${a} не из официальных фактов: ${line}`)
    })
    for (const stale of ['57 000', '73 000', '89 000', '102 000', '107 000']) assert.ok(!nbsp(text).includes(stale), `${FILES[key]}: ${stale}`)
    assert.ok(!/бонус/i.test(text), `${FILES[key]}: слово «бонус»`)
  }
})

test('у внешних цифр есть источник: процент не из кейса — только рядом со ссылкой', () => {
  const official = new Set([...caseText.matchAll(/(\d+(?:,\d+)?)\s?%/g)].map((m) => m[1]))
  for (const [key, text] of Object.entries(docs) as [Key, string][])
    text.split('\n').forEach((line, i) => {
      const external = [...line.matchAll(/(\d+(?:,\d+)?)\s?%/g)].map((m) => m[1]).filter((p) => !official.has(p))
      if (external.length) assert.match(line, /\]\(https:\/\//, `${FILES[key]}:${i + 1}: ${external.join(', ')}% без источника`)
    })
})

test('алкоголь — только как запрет или исключение, ДМС — только «не обещаем»', () => {
  for (const [key, text] of Object.entries(docs) as [Key, string][]) {
    const lines = text.split('\n')
    lines.forEach((line, i) => {
      if (ALCOHOL.test(line)) {
        const negated = /(?<![а-яё])(не|без|нет|исключ|вырез|кроме)/iu.test(line) || /Чего не/.test(tableHeader(lines, i))
        assert.ok(negated, `${FILES[key]}:${i + 1}: алкоголь без запрета: ${line}`)
      }
      if (line.includes('ДМС')) assert.match(line, /ДМС не обещаем/, `${FILES[key]}:${i + 1}`)
    })
  }
})

test('пути, картинки и ссылки существуют, картинки лёгкие', () => {
  const KNOWN = ['src', 'server', 'shared', 'scripts', 'docs', 'public', 'archive']
  const broken: string[] = []
  for (const [key, text] of Object.entries(docs) as [Key, string][]) {
    const file = FILES[key]
    for (const [, span] of text.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g))
      for (const raw of span.split(/\s+/)) {
        const token = raw.replace(/^[(«"']+|[)»"',.:;]+$/g, '')
        if (!token.includes('/') || token.startsWith('/') || /^[a-z]+:/i.test(token) || /[*<>#?=]/.test(token)) continue
        if (!/\.[a-z0-9]{2,5}$/i.test(token) && !KNOWN.includes(token.split('/')[0])) continue
        if (!existsSync(join(root, token))) broken.push(`${file}: ${token}`)
      }
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^https?:/.test(target)) {
        assert.ok(target.startsWith('https://'), `${file}: ссылка без https: ${target}`)
        continue
      }
      const p = normalize(join(dirname(file), target.split('#')[0]))
      if (!existsSync(join(root, p))) broken.push(`${file}: ${p}`)
      else if (/\.(jpg|webp|png)$/.test(p)) assert.ok(statSync(join(root, p)).size < 250_000, `${p} тяжелее 250 КБ`)
    }
  }
  assert.deepEqual(broken, [])
})

test('листовки: суммы и роли совпадают с данными вакансий, у каждой листовки формат, сетка, тексты и макет', () => {
  const leaflets = section(docs.visuals, 'Листовки')
  const a5 = subsection(leaflets, 'A5 «Оплачиваемая практика»')
  for (const part of ['**Формат.**', '**Сетка.**', '**Тексты лицевой стороны**', '**Тексты оборота**', '**Печатная версия.**', '`/hr/poster`', '`docs/brand/print/leaflet-a5.html`'])
    assert.ok(a5.includes(part), `A5: нет «${part}»`)
  // Таблица ролей на обороте — те же роли, отделы и суммы, что в shared/content/vacancies.ts
  const rows = tableRows(a5)
  assert.equal(rows.length, paidPractice.length)
  for (const v of paidPractice) {
    const row = rows.find((r) => r[1] === v.title)
    assert.ok(row, `в таблице нет роли «${v.title}»`)
    assert.ok(row[3].startsWith(`от ${rub(v.pay!.from)}`), `${v.title}: ${row[3]}`)
  }
  assert.ok(a5.includes(`от ${minMonthlyPay.toLocaleString('ru-RU').replace(/\s/g, ' ')} до ${rub(maxEntryPay)}`))
  assert.ok(a5.includes(rub(dorm.priceStudent)))
  assert.match(a5, /С 18 лет/)
  const vuz = subsection(leaflets, 'Практика по договору с вузом')
  for (const d of practiceDocs) assert.ok(vuz.toLowerCase().includes(d.title.toLowerCase().split(' ')[0]), `листовка для вузов: нет «${d.title}»`)
  assert.match(vuz, /кабинет 525/)
  assert.match(vuz, /Берём с 18 лет/)
  const a6 = subsection(leaflets, 'Перед первой сменой')
  for (const part of ['1244', '3105', '1234', '1370', '1490', '8 495 446-42-55', rub(PASS_FINE), '12-го и 27-го', 'корпоративный автобус'])
    assert.ok(a6.includes(part), `памятка A6: нет «${part}»`)
  for (const sub of [a5, vuz, a6]) for (const part of ['**Формат.**', '**Сетка.**', '](img/']) assert.ok(sub.includes(part), part)
})

test('маскот: роль наставника, ссылка на бриф, правила', () => {
  const m = section(docs.visuals, 'Маскот')
  assert.match(m, /`docs\/kvasych\.md`/)
  assert.match(m, /Учебн/)
  assert.match(m, /В руках только квас/)
  assert.match(m, /вместо людей не ставим/)
  assert.match(m, /Рисунков нет/)
})

test('референсы: у каждого источник, что берём и чего не берём', () => {
  const check = (text: string, name: string) => {
    const rows = tableRows(text)
    assert.ok(rows.length >= 5, `${name}: референсов ${rows.length}`)
    for (const r of rows) {
      assert.ok(r.length >= 4, `${name}: ${r.join(' | ')}`)
      assert.match(r[r.length - 1], /\]\(https:\/\/|`[^`]+`/, `${name}: у «${r[0]}» нет источника`)
    }
  }
  check(section(docs.visuals, 'Референсы').split('\n\n')[0], 'визуальные')
  check(section(docs.video, 'Референсы'), 'ролик')
  const analogs = section(docs.analytics, 'Аналоги')
  check(analogs.split('\n\n')[0], 'аналоги')
  for (const name of ['Мармеладыч', 'Боржоми', 'Северсталь', 'X5', 'Открой#Моспром']) assert.ok(analogs.includes(name), `нет аналога «${name}»`)
})

test('мерч: за что получают — контрольные вопросы, первая смена, приглашение друга, практика; худи только после практики', () => {
  const set = section(docs.merch, 'Набор')
  const rows = tableRows(set.split('\n\n')[0])
  assert.ok(rows.length >= 5)
  const why = rows.map((r) => r[1]).join(' ')
  for (const step of ['контрольные вопросы', 'первая смена', 'приглашение друга', 'законченная практика']) assert.ok(why.includes(step), `нет шага «${step}»`)
  const hoodie = rows.find((r) => r[0].startsWith('Худи'))
  assert.ok(hoodie && hoodie[1] === 'законченная практика' && hoodie[2].includes('Я делаю натуральные напитки'))
  assert.match(set, /Худи не раздаём на ярмарках/)
  // Итог сметы сходится со строками
  const cost = section(docs.merch, 'Сколько стоит')
  const lines = tableRows(cost).filter((r) => !r[0].startsWith('**'))
  const range = (cell: string) => {
    const m = nbsp(cell).match(/(\d+)–(\d+) тыс\. ₽/)
    return m ? [Number(m[1]), Number(m[2])] : [0, 0]
  }
  const sum = lines.reduce((acc, r) => [acc[0] + range(r[3])[0], acc[1] + range(r[3])[1]], [0, 0])
  assert.ok(nbsp(cost).includes(`**от ${sum[0]} до ${sum[1]} тыс. ₽**`), `итог должен быть от ${sum[0]} до ${sum[1]}`)
  assert.ok(nbsp(section(docs.merch, 'Коротко')).includes(`от ${sum[0]} до ${sum[1]} тыс. ₽`), 'в «Коротко» другой итог')
})

test('ролик: сцены идут подряд и дают 60 секунд, у каждой источник; четыре отдела и сумма в кадре', () => {
  const script = section(docs.video, 'Сценарий')
  const rows = tableRows(script.split('\n\n')[0])
  const sec = (t: string) => {
    const [m, s] = t.split(':').map(Number)
    return m * 60 + s
  }
  let at = 0
  for (const r of rows) {
    const [from, to] = r[1].split('–').map(sec)
    assert.equal(from, at, `сцена ${r[0]} начинается не там`)
    assert.ok(to > from)
    assert.ok(r[5].length > 5, `сцена ${r[0]}: нет источника`)
    at = to
  }
  assert.equal(at, 60)
  const text = rows.map((r) => r.join(' ')).join(' ')
  for (const unit of ['Лаборатория', 'Технологический цех', 'Склад', 'Цех розлива']) assert.ok(text.includes(unit), unit)
  assert.ok(nbsp(text).includes(`от ${minMonthlyPay.toLocaleString('ru-RU').replace(/\s/g, ' ')} до ${rub(maxEntryPay)}`))
  assert.match(text, /С 18 лет/)
  // Вертикальная версия: арифметика сходится
  const vertical = nbsp(subsection(script, 'Вертикальная версия'))
  const m = vertical.match(/((?:\d+ \+ )+\d+) = (\d+)/)
  assert.ok(m)
  assert.equal(m[1].split(' + ').reduce((a, b) => a + Number(b), 0), Number(m[2]))
  // Опора на ролики компании, четвёртый — исключён с причиной
  for (const v of ['Машинист оборудования', 'Оператор линии розлива', 'Химик-лаборант']) assert.ok(docs.video.includes(`«${v}»`), v)
  assert.match(section(docs.video, 'Коротко'), /«Процесс создания нового вкуса», не используем/)
})

test('фокус-группа: слоганы как в концепции, сценарий на 75 минут, листовка до анкеты, пороги и поведение, анонимность, результатов не выдумываем', () => {
  const conceptFocus = subsection(section(concept, 'Слоган'), 'Для фокус-группы')
  const slogans = [...conceptFocus.matchAll(/^\d+\. «(.+)»$/gm)].map((m) => m[1])
  const form = subsection(section(docs.focus, 'Вопросы'), 'Анкета')
  const listed = [...form.matchAll(/^\s+\d+\. «(.+)»$/gm)].map((m) => m[1])
  assert.deepEqual(listed, slogans)
  // Сценарий встречи: блоки подряд от 0 до 60 минут
  let at = 0
  for (const r of tableRows(section(docs.focus, 'Сценарий'))) {
    const [from, to] = r[0].split('–').map(Number)
    assert.equal(from, at, `блок «${r[1]}»`)
    at = to
  }
  assert.equal(at, 75)
  // Тест памяти по листовке — до анкеты: анкета сама показывает сумму и условия
  const blocks = tableRows(section(docs.focus, 'Сценарий')).map((r) => r[1])
  assert.ok(blocks.indexOf('Листовка') >= 0 && blocks.indexOf('Листовка') < blocks.indexOf('Анкета'), 'листовка после анкеты')
  // У каждой гипотезы порог и решение на случай провала; поведенческие метрики рядом со словами
  const hypotheses = tableRows(section(docs.focus, 'Гипотезы'))
  assert.ok(hypotheses.filter((r) => /^Г\d+$/.test(r[0])).length >= 8)
  for (const r of hypotheses) assert.ok(r[3]?.length > 10 && r[4]?.length > 10, `${r[0]}: нет порога или решения`)
  assert.ok(hypotheses.some((r) => /^П\d+$/.test(r[0]) && /QR/.test(r[2])), 'нет поведенческой метрики по QR')
  const data = section(docs.focus, 'Данные и согласие')
  assert.match(data, /анонимная/)
  assert.match(data, /по IP и cookie/)
  assert.match(docs.focus, /с 18 лет/)
  // Результатов нет: в таблице только прочерки
  const results = section(docs.focus, 'Результаты')
  assert.match(results, /Встреч пока не было/)
  for (const r of tableRows(results)) assert.deepEqual(r.slice(1), r.slice(1).map(() => '—'), r[0])
  assert.ok(!/\d+\s?%/.test(results))
})

test('обоснование и аналитика: цифры проблем кейса и связь с концепцией', () => {
  const problems = section(docs.rationale, 'проблемы кейса')
  for (const part of ['47 до 52', '38%', '0,02%', '18–20', '21–30']) assert.ok(problems.includes(part), `обоснование: нет «${part}»`)
  assert.match(docs.rationale, /Чего концепция не решает/)
  const path = section(docs.analytics, 'Путь кандидата')
  assert.ok(tableRows(path).length >= 6)
  for (const r of tableRows(path)) assert.ok(r.every((c) => c.length > 2), `путь: пустая ячейка у «${r[0]}»`)
  for (const seg of ['Инженеры', 'Профильные специалисты', 'Линейный персонал', 'Студенты 4-х курсов', 'Выпускники'])
    assert.ok(section(docs.analytics, 'Целевая аудитория').includes(`| ${seg} |`), seg)
})

test('проверки ловят нарушения на примерах', () => {
  for (const bad of ['Работа мечты!', 'Важна практика, а не диплом.', 'Ждём тебя…', 'Это не подработка, а карьера.', 'Если ты готов, откликайся.', 'Пиши "да".', 'Куда бы ты пошёл?', 'Еще раз.'])
    assert.notDeepEqual(textProblems(bad), [], bad)
  assert.deepEqual(textProblems('Сначала научим, потом доверим. Ссылка [hh](https://hh.ru/article/1?a=b!c).'), [])
  assert.deepEqual(amounts('от 56 000 до 70 000 ₽, штраф 500 ₽, 200–450 тыс. ₽'), ['56000', '70000', '500', '450000'])
  assert.ok(OFFICIAL.has('56000') && OFFICIAL.has('3400') && !OFFICIAL.has('57000'))
})

test('мерч: макеты и файлы принтов — локальные, в миллиметрах, текст в кривых, пиктограммы из фирменного набора', () => {
  const rel = 'docs/brand/merch/layouts.html'
  const src = read(rel)
  assert.ok(!/https?:\/\//.test(src.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')), 'внешний адрес')
  const refs = [...src.matchAll(/(?:src|href)="([^"#]+)"/g), ...src.matchAll(/url\(([^)#]+)\)/g)].map((m) => m[1].replace(/^['"]|['"]$/g, ''))
  assert.ok(refs.length > 10)
  for (const ref of refs) assert.ok(existsSync(join(root, normalize(join(dirname(rel), ref)))), `нет файла ${ref}`)
  const visible = src.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
  assert.ok(!ALCOHOL.test(visible), 'алкоголь в тексте')
  assert.deepEqual(textProblems(visible), [])

  const manifest = JSON.parse(read('public/brand/pictograms/manifest.json')) as { excluded: { id: string }[] }
  const art = 'docs/brand/merch/art'
  const files = readdirSync(join(root, art)).filter((f) => f.endsWith('.svg'))
  // Каждый файл, на который ссылаются макеты и документ, на месте, и каждый файл принта где-то используется
  for (const f of ['hoodie-back', 'hoodie-neck', 'chest-lab', 'chest-bottling', 'chest-brewing', 'chest-warehouse', 'longsleeve-sleeve', 'longsleeve-chest', 'longsleeve-nape', 'tee-fermentation', 'tote-sostav', 'pins', 'stickers', 'socks', 'lanyard', 'patch-mentor', 'picto-warehouse'])
    assert.ok(files.includes(`${f}.svg`), `нет ${f}.svg`)
  for (const f of files) {
    const svg = read(`${art}/${f}`)
    assert.match(svg, /^<svg [^>]*width="[\d.]+mm" height="[\d.]+mm" viewBox="0 0 [\d.]+ [\d.]+"/, `${f}: размеры не в миллиметрах`)
    assert.ok(!/<text|<image|https?:/.test(svg.replace('xmlns="http://www.w3.org/2000/svg"', '')), `${f}: текст не в кривых или внешние ссылки`)
    assert.match(svg, /<title>[^<]+<\/title><desc>[^<]+<\/desc>/, `${f}: нет названия и техники нанесения`)
    for (const { id } of manifest.excluded) assert.ok(!svg.includes(id), `${f}: исключённая пиктограмма ${id}`)
    assert.ok(!ALCOHOL.test(svg.replace(/<path[^>]*>/g, '')), `${f}: алкоголь`)
    if (f !== 'layouts.html') assert.ok(src.includes(`art/${f}`) || f.startsWith('chest-') || read('docs/brand/merch.md').includes(f), `${f} нигде не показан`)
  }
  // Цвета принтов — только брендбук, никель значков, контур высечки и цвет фона носков
  const colors = new Set(files.flatMap((f) => [...read(`${art}/${f}`).matchAll(/(?:fill|stroke)="(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1].toUpperCase())))
  for (const c of colors) assert.ok(['#D50032', '#AB2328', '#FFFFFF', '#3E3E3E', '#C9CDD0', '#FF00FF', '#141414'].includes(c), `цвет ${c} не из брендбука`)
  // Наклейки — с контуром высечки, носки — с сеткой петель
  assert.match(read(`${art}/stickers.svg`), /CutContour/)
  assert.ok(existsSync(join(root, art, 'socks-grid.txt')))
  // Мерч в документе: надпись на худи и слоган, коллекция из шести значков
  const merch = read('docs/brand/merch.md')
  for (const s of ['Я делаю натуральные напитки', 'Квас делают люди', 'День — ночь — отсыпной — выходной', 'Состав смены', 'Двойное брожение'])
    assert.ok(merch.includes(s), `в документе нет «${s}»`)
})
