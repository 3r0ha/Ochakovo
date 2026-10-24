// Макеты листовок (docs/brand/print/*.html): открываются без сети, все файлы на месте, размеры страниц для печати
// и вылетов, тексты по правилам и совпадают с данными сайта (shared/content), логотип без квадрата, пиктограммы
// только из фирменного набора без исключённых.
// Запуск: pnpm test w2-brand-docs (без базы и браузера)

import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { test } from 'node:test'
import { phonebook } from '../../shared/content/content'
import { dorm, PASS_FINE, practiceDocs, TRAINING_CENTER_ROOM } from '../../shared/content/handbook'
import { maxEntryPay, minMonthlyPay, paidPractice } from '../../shared/content/vacancies'

const root = join(import.meta.dirname, '..', '..')
const dir = 'docs/brand/print'
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')
const pages = readdirSync(join(root, dir)).filter((f) => f.endsWith('.html')).sort()
const html = Object.fromEntries(pages.map((f) => [f, read(`${dir}/${f}`)]))
const css = read(`${dir}/print.css`)
const caseText = read('docs/case.md')
const manifest = JSON.parse(read('public/brand/pictograms/manifest.json')) as {
  pictograms: { id: string }[]
  excluded: { id: string }[]
}

/** Видимый текст страницы: без стилей, скриптов, комментариев и тегов, неразрывные пробелы — обычные */
function visibleText(source: string): string {
  return source
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/[  ]/g, ' ')
    .replace(/\s+/g, ' ')
}

const CYR = 'а-яё'
const GENDERED = new RegExp(
  `(?<![${CYR}])(готов|готова|согласен|согласна|должен|должна|сам|сама|пришёл|пришла|пошёл|пошла|прошёл|прошла|закончил|закончила)(?![${CYR}])`,
  'iu',
)
const ALCOHOL = new RegExp(`(?<![${CYR}])(пив|сидр|коктейл|алкогол|джин)`, 'iu')
/** Текст самих листов, без подписи над макетами */
const sheetText = (source: string) => visibleText(source.replace(/<div class="notes">[\s\S]*?<\/div>/, ''))
const rub = (n: number) => `${n.toLocaleString('ru-RU').replace(/\s/g, ' ')} ₽`

test('макеты есть: листовка A5, листовка для вузов, памятка A6', () => {
  assert.deepEqual(pages, ['first-shift-a6.html', 'insert-vuz.html', 'leaflet-a5.html'])
  for (const [f, src] of Object.entries(html)) {
    assert.match(src, /^<!doctype html>/i, f)
    assert.match(src, /<html lang="ru">/, f)
    assert.match(src, /<title>[^<]+<\/title>/, f)
    assert.match(src, /<link rel="stylesheet" href="print\.css">/, f)
    assert.equal((src.match(/<section class="sheet/g) ?? []).length, 2, `${f}: две стороны`)
  }
})

test('без сети: все файлы локальные и существуют, внешних адресов нет', () => {
  const missing: string[] = []
  for (const [f, src] of Object.entries({ ...html, 'print.css': css })) {
    assert.ok(!/https?:\/\//.test(src.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')), `${f}: внешний адрес`)
    const refs = [...src.matchAll(/(?:src|href)="([^"#]+)"/g), ...src.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1].replace(/^['"]|['"]$/g, ''))
    for (const ref of refs) if (!existsSync(join(root, normalize(join(dir, ref))))) missing.push(`${f}: ${ref}`)
  }
  assert.deepEqual(missing, [])
  // Шрифты под OFL — вместе с лицензией
  assert.ok(existsSync(join(root, dir, 'fonts/OFL.txt')))
  for (const f of readdirSync(join(root, dir, 'img'))) assert.ok(statSync(join(root, dir, 'img', f)).size < 200_000, `${f} тяжелее 200 КБ`)
})

test('печать: A5 и A6 без полей, вылеты по 3 мм с метками реза, цвета брендбука', () => {
  assert.match(css, /@page\s*\{\s*size:\s*A5;\s*margin:\s*0;/)
  assert.match(css, /@page a6-sheet\s*\{\s*size:\s*105mm 148mm;/)
  // С вылетами: обрез + 2 × 3 мм вылета + 2 × 6 мм поля под метки реза
  assert.match(css, /@page a5-bleed\s*\{\s*size:\s*166mm 228mm;/)
  assert.match(css, /@page a6-bleed\s*\{\s*size:\s*123mm 166mm;/)
  assert.match(css, /html\.bleed \{\s*--bleed: 3mm;\s*--slug: 6mm;/)
  for (const c of ['#d50032', '#ab2328', '#a2aaad']) assert.ok(css.toLowerCase().includes(c), c)
  // Режим вылетов включает отдельный скрипт: встроенные скрипты сайт не выполняет (CSP script-src 'self')
  assert.match(read(`${dir}/bleed.js`), /location\.hash === '#bleed'/)
  for (const [f, src] of Object.entries(html)) assert.match(src, /<script src="bleed\.js"><\/script>/, `${f}: нет режима вылетов`)
})

test('тексты по правилам: без «!», многоточий, рода к читателю, дат и алкоголя', () => {
  for (const [f, src] of Object.entries(html)) {
    const t = visibleText(src)
    assert.ok(!t.includes('!'), `${f}: «!»`)
    assert.ok(!/…|\.\.\./.test(t), `${f}: многоточие`)
    assert.ok(!/,\s*а\s+не\s/u.test(t) && !/(?<![а-яё])не\s+[^.,;:!?—]{1,40}?,\s*а\s/iu.test(t), `${f}: «не X, а Y»`)
    assert.ok(!GENDERED.test(t), `${f}: ${t.match(GENDERED)?.[0]}`)
    assert.ok(!ALCOHOL.test(t), `${f}: ${t.match(ALCOHOL)?.[0]}`)
    assert.ok(!/(?<!\d)20\d{2}(?!\d)/.test(t), `${f}: год`)
    assert.ok(!/\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/.test(t), `${f}: дата`)
    assert.ok(!/["”]/.test(t), `${f}: прямые кавычки`)
    assert.ok(!/ДМС|бонус/i.test(t), `${f}: ДМС или бонус`)
  }
})

test('суммы и условия совпадают с данными сайта', () => {
  const grouped = (text: string) => [...text.matchAll(/(?<![\d,])\d{1,3}(?:[ ]\d{3})+(?![\d,])/g)].map((m) => m[0].replace(/\s/g, ''))
  const official = new Set([...grouped(caseText.replace(/[  ]/g, ' ')), String(dorm.priceStudent), String(PASS_FINE)])
  for (const [f, src] of Object.entries(html)) for (const n of grouped(visibleText(src))) assert.ok(official.has(n), `${f}: ${n} не из официальных фактов`)

  const a5 = sheetText(html['leaflet-a5.html'])
  assert.ok(a5.includes('Квас делают люди'))
  assert.ok(a5.includes(`от ${minMonthlyPay.toLocaleString('ru-RU').replace(/\s/g, ' ')} до ${rub(maxEntryPay)}`))
  for (const v of paidPractice) {
    assert.ok(a5.includes(v.title), v.title)
    const after = a5.slice(a5.indexOf(v.title))
    assert.ok(after.match(/от \d{2} \d{3} ₽/)?.[0] === `от ${rub(v.pay!.from)}`, `${v.title}: сумма не та`)
  }
  assert.ok(a5.includes(rub(dorm.priceStudent)))
  assert.ok(a5.includes('С 18 лет') && a5.includes('Берём с 18 лет'))
  assert.ok(a5.includes('корпоративный автобус'))

  const vuz = sheetText(html['insert-vuz.html'])
  for (const d of practiceDocs) assert.ok(vuz.includes(d.title.split(' ')[0]), d.title)
  assert.ok(vuz.includes(`кабинет ${TRAINING_CENTER_ROOM}`))
  assert.ok(vuz.includes('Берём с 18 лет'))

  const a6 = sheetText(html['first-shift-a6.html'])
  for (const p of phonebook) {
    const number = p.ext ?? p.phone
    assert.ok(a6.includes(number), `${p.who}: ${number}`)
  }
  assert.ok(a6.includes(`штраф ${rub(PASS_FINE)}`))
  for (const part of ['12-го и 27-го', '23:00 до 6:00', 'корпоративный автобус', '11:30–14:30', '20:30–22:00']) assert.ok(a6.includes(part), part)
})

test('логотип — без квадрата, пиктограммы — из фирменного набора без исключённых', () => {
  const ids = new Set(manifest.pictograms.map((p) => p.id))
  const excluded = new Set(manifest.excluded.map((p) => p.id))
  for (const [f, src] of Object.entries(html)) {
    const logos = [...src.matchAll(/public\/brand\/(logo-[a-z-]+)\.svg/g)].map((m) => m[1])
    assert.ok(logos.length >= 1, `${f}: нет логотипа`)
    for (const l of logos) assert.ok(existsSync(join(root, `public/brand/${l}.svg`)), l)
    assert.ok(!/favicon|apple-touch-icon/.test(src), `${f}: знак с квадратом`)
    for (const [, id] of src.matchAll(/pictograms\/([a-z-]+)\.svg/g)) {
      assert.ok(ids.has(id), `${f}: пиктограммы ${id} нет в наборе`)
      assert.ok(!excluded.has(id), `${f}: исключённая пиктограмма ${id}`)
    }
  }
})
