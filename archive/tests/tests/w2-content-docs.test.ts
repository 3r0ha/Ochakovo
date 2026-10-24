// README для экспертов и документы совпадают с продуктом: маршруты API из таблицы есть на сервере и наоборот,
// страницы есть в маршрутах сайта, цифры — из shared/, требования кейса закрыты строками таблицы, факты стратегии —
// по официальным материалам. Запуск: pnpm test w2-content-docs (нужен PostgreSQL для списка маршрутов)

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { createApp } from '../../server/app'
import type { Registry } from '../../server/channels/registry'
import { PostgresStorage } from '../../server/db'
import { dorm } from '../../shared/content/handbook'
import { companyQuiz, COMPANY_QUIZ_ROUND } from '../../shared/content/companyQuiz'
import { paidPracticeInfo } from '../../shared/content/practice'
import { maxEntryPay, minMonthlyPay, paidPractice } from '../../shared/content/vacancies'
import { serverSettled, withTestDb } from './_db'

const root = join(import.meta.dirname, '..', '..')
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')
const readme = read('README.md')
const noBots: Registry = { get: () => undefined, active: () => [], failed: () => [], start: () => {} }

/** Текст без блоков кода и без кода в обратных кавычках — для проверок стиля */
const prose = (text: string) => text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
/** «56 000» в тексте: обычный или неразрывный пробел */
const rub = (n: number) => new RegExp(n.toLocaleString('ru-RU').replace(/\s/g, '[\\s\\u00a0]'))

/** Раздел документа от заголовка со словом heading до следующего заголовка того же или старшего уровня */
function section(text: string, heading: string): string {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => /^#{2,3} /.test(l) && l.includes(heading))
  assert.ok(start >= 0, `нет раздела «${heading}»`)
  const level = lines[start].match(/^#+/)![0].length
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => new RegExp(`^#{1,${level}} `).test(l))
  return (end < 0 ? rest : rest.slice(0, end)).join('\n')
}

/** Строки таблицы Markdown: ячейки без крайних «|», без шапки и разделителя */
function tableRows(text: string): string[][] {
  const rows = text.split('\n').filter((l) => l.startsWith('| ') && !/^\|[-|\s]+\|$/.test(l))
  return rows.slice(1).map((l) => l.slice(1, -1).split(' | ').map((c) => c.trim()))
}

/** {a,b} в пути → несколько путей */
const expand = (p: string): string[] => {
  const m = p.match(/\{([^{}]+)\}/)
  return m ? m[1].split(',').flatMap((alt) => expand(p.replace(m[0], alt))) : [p]
}

/** Маршруты API из таблицы README: метод → пути */
function documentedRoutes() {
  const api = section(readme, 'Сервер и боты')
  const table = api.slice(api.indexOf('| Метод | Путь |'))
  const rows = tableRows(table.slice(0, table.indexOf('\n\n')))
  return rows.map(([methods, paths, what]) => ({
    methods: methods.split(',').map((m) => m.trim()),
    paths: [...paths.matchAll(/`([^`]+)`/g)].flatMap((m) => expand(m[1].replace(/\?.*$/, ''))),
    what,
  }))
}

test('README: таблица API совпадает с маршрутами сервера в обе стороны', async () => {
  await withTestDb('w2-content-routes', async (sql) => {
    const app = await createApp({ storage: new PostgresStorage(sql), engine: null, bots: noBots, hrToken: '', env: { NODE_ENV: 'test' } })
    await serverSettled(sql)
    // Параметр с шаблоном Hono (:file{applications\.(xlsx|csv)}) в README пишется просто :file
    const real = app.routes.filter((r) => r.method !== 'ALL' && /^\/(api|bots)\//.test(r.path)).map((r) => `${r.method} ${r.path.replace(/(:\w+)\{.*\}/, '$1')}`)
    const realSet = new Set(real)
    const rows = documentedRoutes()
    assert.ok(rows.length >= 20, 'таблица API на месте')

    // Каждый путь из таблицы есть на сервере хотя бы с одним методом своей строки, каждый метод строки где-то используется
    const lies: string[] = []
    for (const row of rows) {
      for (const p of row.paths) if (!row.methods.some((m) => realSet.has(`${m} ${p}`))) lies.push(`${row.methods.join(', ')} ${p}`)
      for (const m of row.methods) if (!row.paths.some((p) => realSet.has(`${m} ${p}`))) lies.push(`${m} без пути в строке «${row.paths.join(', ')}»`)
    }
    assert.deepEqual(lies, [], `в README есть маршруты, которых нет на сервере:\n${lies.join('\n')}`)

    // Каждый маршрут сервера описан: строкой таблицы или в абзаце о старых адресах
    const documented = new Set(rows.flatMap((r) => r.paths))
    const legacy = section(readme, 'Сервер и боты').match(/Старые адреса[^\n]+/)?.[0] ?? ''
    const legacyPaths = new Set([...legacy.matchAll(/`([^`]+)`/g)].map((m) => m[1]))
    const missing = [...new Set(real.filter((r) => {
      const path = r.slice(r.indexOf(' ') + 1)
      return !documented.has(path) && !legacyPaths.has(path)
    }))]
    assert.deepEqual(missing, [], `маршруты сервера без строки в README, раздел «Сервер и боты»:\n${missing.join('\n')}`)
  })
})

test('README: страницы сайта из текста есть в маршрутах, контрольные вопросы открываются по адресу', () => {
  const app = read('src/App.tsx')
  const pages = new Set([...readme.matchAll(/`(\/[a-z][a-z/-]*)(\?[^`]*)?`/g)].map((m) => m[1]).filter((p) => !/^\/(api|bots)\//.test(p)))
  assert.ok(pages.size >= 6)
  for (const p of pages) {
    const route = p.slice(1)
    assert.ok(app.includes(`path="${route}"`), `страницы ${p} нет в src/App.tsx`)
  }
  if (readme.includes('/game?t=quiz')) {
    const game = existsSync(join(root, 'src/pages/Game.tsx')) ? read('src/pages/Game.tsx') : ''
    assert.match(game, /quiz/, 'README ведёт на /game?t=quiz, а src/pages/Game.tsx не знает режим quiz')
  }
})

test('README: цифры совпадают с shared/', () => {
  assert.match(readme, new RegExp(`от ${rub(minMonthlyPay).source} до ${rub(maxEntryPay).source} ₽ до вычета налога`))
  assert.match(readme, new RegExp(`${paidPractice.length} ролей оплачиваемой практики в ${paidPracticeInfo.units.length} отделах`))
  assert.match(readme, new RegExp(`${COMPANY_QUIZ_ROUND} случайных из ${companyQuiz.length} вопросов`))
  assert.ok(!/57[\s ]000/.test(readme), 'старая сумма 57 000')
})

test('README: каждое требование кейса закрыто строкой таблицы', () => {
  const table = tableRows(section(readme, 'Требования кейса'))
  const firsts = table.map((r) => r[0]).join('\n')
  for (const need of ['ФИО', 'дата рождения', 'готовность выйти', 'вуз или колледж', '18 лет', 'игровая форма', 'Контрольные вопросы', 'История', 'бренды', 'Связь с аудиторией', 'Концепция HR-бренда', 'слоган', 'Визуальные материалы', 'Мерч', 'Сторителлинг', 'Видеоролик', 'Обоснование', 'аналитика', 'Рябиновая, 44'])
    assert.ok(firsts.includes(need), `нет строки про «${need}»`)
  for (const row of table) assert.ok(row[1] && row[1].length > 10, `пустая ячейка «Где» у «${row[0]}»`)
  // Переменные окружения из таблицы интеграций существуют
  const env = read('.env.example')
  const vars = [...section(readme, 'имитациях').matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map((m) => m[1])
  assert.ok(vars.length >= 8)
  for (const v of vars) assert.ok(env.includes(`${v}=`), `${v} нет в .env.example`)
})

test('стратегия: официальные факты, посылы концепции и исследования с источниками', () => {
  const s = read('docs/strategy.md')
  assert.ok(!/57[\s ]000/.test(s), 'старая сумма 57 000')
  assert.ok(!/стоимость\s*—\s*у\s*HR|места и стоимость/i.test(s), 'общежитие «у HR»')
  assert.ok(!/полис ДМС для сотрудников/i.test(s), 'ДМС среди преимуществ')
  for (const line of s.split('\n').filter((l) => /ДМС/.test(l))) assert.match(line, /не обещаем|нет|подтвердить|согласуем/i, `ДМС без оговорки: ${line}`)
  assert.match(s, rub(minMonthlyPay))
  assert.match(s, rub(maxEntryPay))
  assert.match(s, rub(dorm.priceStudent))
  assert.match(s, /«Сначала научим, потом доверим»/)
  assert.match(s, /«Смена»/)
  assert.match(s, /корпоративный автобус/)
  // Посылы трёх блоков кейса и двух приоритетных групп — дословно из концепции
  const concept = read('docs/brand/concept.md')
  const messages = [...concept.matchAll(/\*\*Главный посыл:\*\* (.+)$/gm)].map((m) => m[1].trim())
  assert.equal(messages.length, 5)
  for (const m of messages) assert.ok(s.includes(m.replace(/\.$/, '')), `в стратегии нет посыла ${m}`)
  // У каждой цифры исследования есть источник в той же строке
  const research = section(s, 'Аудитория').split('\n').filter((l) => l.startsWith('- ') && /\d+(,\d+)?%/.test(l))
  assert.ok(research.length >= 4)
  for (const l of research) assert.match(l, /Источник|\]\(https:\/\/|опрос/i, l)
  // «Высокой» зарплату не называем
  assert.ok(!/высок\S* зарплат|зарплат\S* высок/i.test(prose(s)))
})

test('Квасыч: мастер-наставник, без шутки про возраст', () => {
  const k = read('docs/kvasych.md')
  assert.match(k, /Мастер-наставник/)
  assert.match(k, /Наставника прикрепляют к каждому новичку/)
  assert.match(k, /Учебн\S+ центр/)
  assert.ok(!/на заводе с 1978|по стажу|наставника на смене кандидатам не обещаем/i.test(k))
})

test('документы: без «!», многоточий и шаблона «не X, а Y» в тексте', () => {
  for (const f of ['README.md', 'docs/strategy.md', 'docs/roadmap.md', 'docs/kvasych.md', 'docs/hr.md']) {
    const t = prose(read(f)).replace(/\[[^\]]*\]\([^)]*\)/g, '')
    assert.ok(!t.includes('!'), `«!» в ${f}`)
    // Многоточие внутри «ёлочек» — заглушка в цитате интерфейса («по заявке № …»), его не считаем
    assert.ok(!/\.\.\.|…/.test(t.replace(/«[^»\n]*»/g, '')), `многоточие в ${f}`)
    // \b в JS не видит границ кириллических слов — граница задаётся явно
    const hits = t.split('\n').filter((l) => /,\s+а\s+не\s|(?:^|[\s(«])не\s+[^\s,]+,\s+а\s/.test(l))
    assert.deepEqual(hits, [], `«не X, а Y» в ${f}`)
  }
})
