// Концепция HR-бренда (docs/brand/concept.md): все части задачи на месте, слоган отобран по правилам,
// цифры совпадают с официальными фактами (docs/case.md), тексты — по docs/quality-brief.md.
// Запуск: pnpm test c2-brand-concept (без базы)

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const root = join(import.meta.dirname, '..', '..')
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')
const DOC = 'docs/brand/concept.md'
const doc = read(DOC)
const caseText = read('docs/case.md')

/** Текст раздела второго уровня, в заголовке которого есть title, — до следующего «## » */
function section(text: string, title: string): string {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.startsWith('## ') && l.includes(title))
  assert.ok(start >= 0, `нет раздела «${title}»`)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => l.startsWith('## '))
  return (end < 0 ? rest : rest.slice(0, end)).join('\n')
}

/** Подраздел третьего уровня внутри текста раздела */
function subsection(text: string, title: string): string {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.startsWith('### ') && l.includes(title))
  assert.ok(start >= 0, `нет подраздела «${title}»`)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => /^#{2,3} /.test(l))
  return (end < 0 ? rest : rest.slice(0, end)).join('\n')
}

const CYR = 'а-яё'
/** «не X, а Y» и «не только X, но и Y» — шаблоны, запрещённые в docs/quality-brief.md */
const NOT_X_BUT_Y = new RegExp(`(?<![${CYR}])не\\s+[^.,;:!?—\\n]{1,40}?,\\s*а\\s`, 'iu')
const NOT_ONLY = new RegExp(`(?<![${CYR}])не\\s+только[^.\\n]{1,60}?[\\s,]но\\s+и(?![${CYR}])`, 'iu')
/** Мужской или женский род там, где нужен нейтральный */
const GENDERED = new RegExp(`(?<![${CYR}])(готов|готова|согласен|согласна|уверен|уверена|должен|должна|рад|рада|сам|сама|самому|поймал|поймала|пришёл|пришла)(?![${CYR}])`, 'iu')
/** Алкоголь — только в разделе «Границы»; «безалкогольные» сюда не попадает */
const ALCOHOL = new RegExp(`(?<![${CYR}])(пив|сидр|коктейл|алкогол|джин)`, 'iu')
const OFFICIALESE = /осуществл|предоставля|в\s+рамках/iu

/** Нарушения правил текстов в куске документа. Литерал «не X, а Y» — название шаблона, его не считаем */
function textProblems(text: string): string[] {
  const t = text.replaceAll('«не X, а Y»', '')
  const out: string[] = []
  if (t.includes('!')) out.push('восклицательный знак')
  if (/…|\.\.\./.test(t)) out.push('многоточие')
  if (NOT_X_BUT_Y.test(t)) out.push(`«не X, а Y»: ${t.match(NOT_X_BUT_Y)?.[0]}`)
  if (NOT_ONLY.test(t)) out.push(`«не только X, но и Y»: ${t.match(NOT_ONLY)?.[0]}`)
  if (GENDERED.test(t)) out.push(`род: ${t.match(GENDERED)?.[0]}`)
  // Канцелярит в «ёлочках» — это примеры того, что не пишем (колонка «Чего не пишем»)
  const unquoted = t.replace(/«[^«»\n]*»/g, '')
  if (OFFICIALESE.test(unquoted)) out.push(`канцелярит: ${unquoted.match(OFFICIALESE)?.[0]}`)
  // Прямые кавычки — только в коде; в тексте «ёлочки» и „лапки“ внутри них
  if (/["”]/.test(t.replace(/`[^`\n]*`/g, ''))) out.push('прямые кавычки')
  return out
}

/** Проблемы слогана: правила текстов плюс длина, вопросы и обещания «лучший» */
function sloganProblems(s: string): string[] {
  const out = textProblems(s)
  if (s.includes('?')) out.push('вопрос')
  if (s.split(/\s+/).length > 5) out.push('длиннее пяти слов')
  if (ALCOHOL.test(s)) out.push('алкоголь')
  if (/лучш|уникальн|№\s?1|номер один/iu.test(s)) out.push('превосходная степень')
  return out
}

const pick = (label: string) => {
  const m = doc.match(new RegExp(`^\\*\\*${label}:\\*\\* «(.+)»\\s*$`, 'm'))
  assert.ok(m, `нет строки «**${label}:** «…»»`)
  return m[1]
}
const main = pick('Основной')
const spares = [pick('Запасной 1'), pick('Запасной 2')]

type Variant = { n: number; text: string; failed: string; decision: string }
/** Таблица вариантов слогана из приложения А */
const variants: Variant[] = subsection(section(doc, 'Приложение А'), 'Варианты')
  .split('\n')
  .filter((l) => /^\| \d+ \|/.test(l))
  .map((l) => {
    const cells = l.split('|').map((c) => c.trim())
    return { n: Number(cells[1]), text: cells[2].replace(/^«|»$/g, ''), failed: cells[3], decision: cells[4] }
  })

test('концепция на месте: идея, цель, слоган, образы, тон, легенда, Квасыч, посылы, границы, приложения', () => {
  for (const title of ['Коротко', 'Опоры', 'Идея', 'Цель', 'Слоган', 'Ключевые образы', 'Тон', 'Легенда', 'Квасыч', 'Посылы', 'Границы', 'Приложение А', 'Приложение Б'])
    assert.ok(section(doc, title).trim().length > 100, `раздел «${title}» пустой`)
  // Опоры — брендбук, справочник и проблемы кейса
  const base = section(doc, 'Опоры')
  for (const part of ['Натуральные — значит настоящие', 'Патриоты своего дела', 'ответственный', 'сильный', 'доброжелательный', 'искренний', 'деятельный', 'наставник', 'испытательного срока', 'общежитие', 'экзамены', '47 до 52', '38%', '0,02%'])
    assert.ok(base.toLowerCase().includes(part.toLowerCase()), `в опорах нет «${part}»`)
  // Не меньше пяти ключевых образов, среди них Квасыч и настоящие наставники
  const images = section(doc, 'Ключевые образы')
  assert.ok((images.match(/^\d+\. \*\*/gm) ?? []).length >= 5)
  assert.match(images, /Квасыч/)
  assert.match(images, /Наставник и новичок/)
  // Тон: все пять ценностей бренда в таблице
  const tone = section(doc, 'Тон')
  for (const v of ['Ответственный', 'Сильный', 'Доброжелательный', 'Искренний', 'Деятельный']) assert.ok(tone.includes(`| ${v} (`), v)
})

test('слоган: основной и два запасных, все по правилам текстов и короткие', () => {
  for (const s of [main, ...spares]) assert.deepEqual(sloganProblems(s), [], s)
  assert.equal(new Set([main, ...spares]).size, 3, 'слоганы не повторяются')
  // В «Коротко» тот же основной слоган, что в разделе «Слоган»
  assert.ok(section(doc, 'Коротко').includes(`**Слоган.** «${main}»`))
  // Фокус-группа получает ровно эти три слогана в том же порядке
  const focus = subsection(section(doc, 'Слоган'), 'Для фокус-группы')
  const listed = [...focus.matchAll(/^\d+\. «(.+)»$/gm)].map((m) => m[1])
  assert.deepEqual(listed, [main, ...spares])
})

test('отбор слогана: 15+ вариантов, у каждого решение с причиной, выбор совпадает с разделом «Слоган»', () => {
  assert.ok(variants.length >= 15, `вариантов ${variants.length}`)
  assert.deepEqual(variants.map((v) => v.n), variants.map((_, i) => i + 1), 'номера по порядку')
  assert.equal(new Set(variants.map((v) => v.text)).size, variants.length, 'варианты не повторяются')
  const kind = (v: Variant) => v.decision.split(/[\s:]/)[0]
  for (const v of variants) {
    assert.ok(['основной', 'запасной', 'отклонён'].includes(kind(v)), `вариант ${v.n}: решение «${v.decision}»`)
    assert.ok(v.decision.length >= 30, `вариант ${v.n}: нет причины`)
    if (kind(v) === 'отклонён') assert.match(v.failed, /К[1-7]/, `вариант ${v.n}: не указан критерий`)
    else assert.deepEqual(sloganProblems(v.text), [], `вариант ${v.n}`)
  }
  assert.deepEqual(variants.filter((v) => kind(v) === 'основной').map((v) => v.text), [main])
  assert.deepEqual(variants.filter((v) => kind(v) === 'запасной').map((v) => v.text), spares)
  // Критерии К1–К7 описаны, финалисты сравнены по каждому
  const appendix = section(doc, 'Приложение А')
  for (let k = 1; k <= 7; k++) assert.match(appendix, new RegExp(`\\*\\*К${k} `), `нет критерия К${k}`)
  const finals = subsection(appendix, 'Финалисты')
  assert.ok(finals.includes(`«${main}»`) && spares.every((s) => finals.includes(`«${s}»`)))
  for (let k = 1; k <= 7; k++) assert.match(finals, new RegExp(`^\\| К${k} `, 'm'), `в сравнении нет К${k}`)
})

test('тексты по quality-brief: без «!», многоточий, «не X, а Y», прямых кавычек и рода к читателю', () => {
  // Отклонённые варианты — примеры того, как не пишем: их строки не проверяем
  const rejected = new Set(variants.filter((v) => v.decision.startsWith('отклонён')).map((v) => v.text))
  const lines = doc.split('\n').filter((l) => {
    const m = l.match(/^\| \d+ \| «(.+?)» \|/)
    return !(m && rejected.has(m[1]))
  })
  assert.deepEqual(textProblems(lines.join('\n')), [])
  // «ё» в частых словах
  assert.ok(!new RegExp(`(?<![${CYR}])(еще|ее|учеба|зачет|отчет)(?![${CYR}])`, 'iu').test(doc), 'нужна «ё»')
})

test('дат нет: только исторические годы из официальных фактов', () => {
  assert.deepEqual(doc.match(/(?<!\d)20\d{2}(?!\d)/g) ?? [], [], 'годы текущего века')
  assert.deepEqual(doc.match(/\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/g) ?? [], [], 'даты в цифрах')
  const years = [...new Set(doc.match(/(?<!\d)19\d{2}(?!\d)/g) ?? [])]
  assert.deepEqual(years.sort(), ['1978', '1996', '1998'])
  for (const y of years) assert.ok(caseText.includes(y), `${y} нет в docs/case.md`)
})

test('цифры — из официальных фактов: суммы и проценты есть в docs/case.md, старых сумм и ДМС нет', () => {
  const norm = (s: string) => s.replace(/[\s  ]/g, '')
  const grouped = (text: string) => new Set([...text.matchAll(/(?<!\d)\d{1,3}(?:[   ]\d{3})+(?!\d)/g)].map((m) => norm(m[0])))
  const official = grouped(caseText)
  for (const n of grouped(doc)) assert.ok(official.has(n), `число ${n} не из docs/case.md`)
  const percents = (text: string) => new Set([...text.matchAll(/(\d+(?:,\d+)?)\s?%/g)].map((m) => m[1]))
  const officialPercents = percents(caseText)
  for (const p of percents(doc)) assert.ok(officialPercents.has(p), `${p}% не из docs/case.md`)
  // Главные факты кейса и справочника на месте
  for (const part of ['56 000', '60 000', '70 000', '3 400', '6 800', '12-го и 27-го', 'кабинет 525', 'Учебном центре', 'корпоративный автобус', 'м. «Озёрная»', 'с 18 лет', '60 регионах', '30 странах'])
    assert.ok(doc.includes(part), `нет «${part}»`)
  // Старые суммы и выдуманные «оценки» — нет; ДМС — только в «Границах» как то, что не обещаем
  for (const stale of ['57 000', '89 000', '102 000', '107 000']) assert.ok(!doc.includes(stale), stale)
  const outside = doc.replace(section(doc, 'Границы'), '')
  assert.ok(!outside.includes('ДМС'))
  assert.match(section(doc, 'Границы'), /ДМС не обещаем/)
})

test('алкоголь — только в «Границах», и там — как запрет', () => {
  const limits = section(doc, 'Границы')
  const outside = doc.replace(limits, '')
  assert.ok(!ALCOHOL.test(outside), `вне «Границ»: ${outside.match(ALCOHOL)?.[0]}`)
  assert.match(limits, /не показываем и не упоминаем/)
  assert.match(limits, /«О рекламе»/)
})

test('посылы: инженеры, профильные, линейные, 4-е курсы и выпускники — у каждого главный посыл и доводы', () => {
  const messages = section(doc, 'Посылы')
  for (const group of ['Инженерные специальности', 'Профильные специалисты', 'Линейный персонал', 'Студенты 4-х курсов', 'Выпускники']) {
    const part = subsection(messages, group)
    const m = part.match(/^\*\*Главный посыл:\*\* «(.+)»\.$/m)
    assert.ok(m, `${group}: нет главного посыла`)
    assert.deepEqual(textProblems(m[1]), [], `${group}: ${m[1]}`)
    assert.ok((part.match(/^- /gm) ?? []).length >= 3, `${group}: меньше трёх доводов`)
    // Деньги первыми: сумма в самом посыле или в первом доводе
    const first = part.split('\n').find((l) => l.startsWith('- ')) ?? ''
    assert.ok(m[1].includes('₽') || first.includes('₽'), `${group}: сумма не первая`)
  }
  // Линейным — деньги первыми; бесплатная практика без суммы
  const line = subsection(messages, 'Линейный персонал')
  assert.match(line.match(/\*\*Главный посыл:\*\* «(.+)»/)![1], /^От 56 000 до 70 000 ₽ до вычета налога/)
  assert.match(subsection(messages, 'Инженерные специальности'), /Бесплатная практика по договорённости:[^₽\n]+$/m)
})

test('легенда и Квасыч: наставник из Учебного центра, история по годам, Квасыч — персонаж', () => {
  const legend = subsection(section(doc, 'Легенда'), 'Текст для сайта и бота')
  const text = legend
    .split('\n')
    .filter((l) => l.startsWith('>'))
    .map((l) => l.replace(/^>\s?/, ''))
    .join(' ')
  for (const part of ['1978', 'Олимпиад', '1996', 'двойное брожение', '1998', '«Очаковский»', 'наставника', 'Учебном центре', 'Квасыч'])
    assert.ok(text.includes(part), `в легенде нет «${part}»`)
  assert.ok(text.length < 1200, `легенда длинная: ${text.length} знаков`)
  // Порядок: история, потом наставники, потом Квасыч
  assert.ok(text.indexOf('1978') < text.indexOf('наставника') && text.indexOf('наставника') < text.indexOf('Квасыч'))
  const kvasych = section(doc, 'Квасыч, мастер-наставник')
  assert.match(kvasych, /персонаж/)
  assert.match(kvasych, /Учебн/)
  assert.match(kvasych, /docs\/kvasych\.md/)
  // Карточки настоящих наставников — только с согласия, без выдуманных имён
  assert.match(section(doc, 'Легенда'), /письменного согласия/)
  assert.match(section(doc, 'Легенда'), /Имён и цитат не придумываем/)
})

test('пути в документе существуют', () => {
  const KNOWN = ['src', 'server', 'shared', 'scripts', 'docs', 'public', 'archive']
  const broken: string[] = []
  for (const [, span] of doc.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g))
    for (const raw of span.split(/\s+/)) {
      const token = raw.replace(/^[(«"']+|[)»"',.:;]+$/g, '')
      if (!token.includes('/') || token.startsWith('/') || /^[a-z]+:/i.test(token) || /[*<>#?]/.test(token)) continue
      if (!/\.[a-z]{2,4}$/i.test(token) && !KNOWN.includes(token.split('/')[0])) continue
      if (!existsSync(join(root, token))) broken.push(token)
    }
  assert.deepEqual(broken, [])
})

test('проверки ловят нарушения на примерах', () => {
  const bad = [
    'Работа мечты!',
    'Ждём тебя…',
    'Это не подработка, а карьера.',
    'Не только деньги, но и опыт.',
    'Если ты готов, откликайся.',
    'Мы осуществляем подбор.',
    'Пиши "да".',
  ]
  for (const s of bad) assert.notDeepEqual(textProblems(s), [], s)
  assert.deepEqual(textProblems('Сначала научим, потом доверим. Шаблон «не X, а Y» не используем. Безалкогольные напитки.'), [])
  assert.ok(sloganProblems('Самая лучшая работа на заводе кваса').length > 0)
  assert.ok(sloganProblems('Куда пойти летом?').includes('вопрос'))
  assert.ok(ALCOHOL.test('пивной бокал') && !ALCOHOL.test('безалкогольный квас'))
})
