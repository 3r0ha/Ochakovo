// Фирменные пиктограммы и паттерн из брендбука (OCHAKOVO_pictograms.ai, OCHAKOVO_pattern_01.ai) и токены цветов.
// Файлы готовит node scripts/media.mjs brand. Запуск: pnpm test c2-brand-media-pictograms

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'

const url = (p: string) => new URL(`../../${p}`, import.meta.url)
const read = (p: string) => readFileSync(url(p), 'utf8')

type Pictogram = { id: string; name: string; genre: 'process' | 'equipment' | 'raw' | 'product'; genreName: string; file: string }
const manifest = JSON.parse(read('public/brand/pictograms/manifest.json')) as {
  module: number
  rules: string[]
  colors: Record<string, string>
  pictograms: Pictogram[]
  excluded: { id: string; name: string; why: string }[]
}
const BEER = ['beer-bottle', 'keg', 'bottle-crate', 'hop', 'hop-cones']

test('пиктограммы: отдельные SVG в одном модуле 48×48, фирменный красный, четыре жанра', () => {
  assert.equal(manifest.module, 48)
  const ids = manifest.pictograms.map((p) => p.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.deepEqual([...new Set(manifest.pictograms.map((p) => p.genre))].sort(), ['equipment', 'process', 'product', 'raw'])
  const names = { process: 'процесс', equipment: 'оборудование', raw: 'сырьё', product: 'продукция' }
  for (const p of manifest.pictograms) {
    assert.equal(p.genreName, names[p.genre])
    assert.equal(p.file, `/brand/pictograms/${p.id}.svg`)
    const svg = read(`public${p.file}`)
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 48 48" width="48" height="48" fill="#D50032">/, p.id)
    assert.match(svg, new RegExp(`<title>${p.name}</title>`))
    assert.equal((svg.match(/<path /g) ?? []).length, 1)
    assert.doesNotMatch(svg, /transform|rotate|scale\(-/, 'без поворотов и отражений')
    assert.ok(svg.length < 6_000)
    // Пиктограмма внутри модуля
    const d = svg.match(/<path d="([^"]+)"/)![1]
    const nums = [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]))
    assert.ok(Math.min(...nums) >= -0.5 && Math.max(...nums) <= 48.5, `${p.id}: выходит за модуль`)
  }
  assert.ok(manifest.pictograms.length >= 18)
})

test('пиво, кег, ящик с бутылками и хмель не выгружены', () => {
  assert.deepEqual(manifest.excluded.map((e) => e.id).sort(), [...BEER].sort())
  for (const e of manifest.excluded) assert.ok(e.why.length > 3)
  const files = readdirSync(url('public/brand/pictograms'))
  for (const id of BEER) {
    assert.ok(!files.includes(`${id}.svg`), id)
    assert.ok(!manifest.pictograms.some((p) => p.id === id))
  }
  assert.deepEqual(files.sort(), [...manifest.pictograms.map((p) => `${p.id}.svg`), 'manifest.json'].sort())
})

test('паттерн: три сочетания цветов, серые фигуры на втором плане, рядом нет одинаковых, пива нет', () => {
  const colors = { red: '#D50032', white: '#FFFFFF', 'dark-red': '#AB2328' }
  const ids = new Set(manifest.pictograms.map((p) => p.id))
  let grid: string | null = null
  for (const [name, color] of Object.entries(colors)) {
    const svg = read(`public/brand/pattern-${name}.svg`)
    assert.ok(svg.length < 60_000, `pattern-${name}: ${svg.length} байт`)
    // Фигуры (серые) идут раньше пиктограмм — значит, лежат под ними
    const shapes = svg.indexOf('<g fill="#A2AAAD">')
    const picts = svg.indexOf(`<g fill="${color}">`)
    assert.ok(shapes > 0 && picts > shapes, `pattern-${name}: порядок слоёв`)
    const uses = [...svg.matchAll(/<use href="#([a-z-]+)" transform="translate\(([-\d.]+) ([-\d.]+)\) scale\(([\d.]+)\)"\/>/g)]
    assert.equal(uses.length, 50, 'две части по 5×5')
    const scales = new Set(uses.map((u) => u[4]))
    assert.equal(scales.size, 1, 'единый масштаб пиктограмм')
    for (const u of uses) {
      assert.ok(ids.has(u[1]), `в паттерне ${u[1]}`)
      assert.ok(!BEER.includes(u[1]))
    }
    // Сетка 10×5 с шагом модуля: соседи (и по диагонали) различаются
    const step = 48 * Number(uses[0][4])
    const cell = new Map(uses.map((u) => [`${Math.round(Number(u[3]) / step)}:${Math.round(Number(u[2]) / step)}`, u[1]]))
    assert.equal(cell.size, 50)
    for (const [key, id] of cell) {
      const [r, c] = key.split(':').map(Number)
      for (const [dr, dc] of [[0, 1], [1, -1], [1, 0], [1, 1]]) assert.notEqual(cell.get(`${r + dr}:${c + dc}`), id, `рядом две «${id}» в ${key}`)
    }
    const order = [...cell.entries()].sort().map(([k, v]) => `${k}=${v}`).join(',')
    if (grid) assert.equal(order, grid, 'раскладка одинакова во всех цветах')
    grid = order
  }
})

test('токены брендбука в index.css: тёмно-красный и серый', () => {
  const css = read('src/index.css')
  assert.match(css, /--color-brand: #d50032;/)
  assert.match(css, /--color-brand-dark: #ab2328;/)
  assert.match(css, /--color-brand-grey: #a2aaad;/)
  // Значения — из брендбука (стр. 58), если материалы заказчика на месте
  const book = 'archive/case-materials/brandbook/_text.txt'
  if (existsSync(url(book))) {
    const text = read(book)
    assert.match(text, /Web AB2328/)
    assert.match(text, /Web A2AAAD/)
    assert.match(text, /Web D50032/)
  }
  // Кольцо фокуса знает новые фоны
  assert.match(css, /\.bg-brand-dark, \[data-surface="dark"\]\) > \*/)
  assert.match(css, /\.bg-brand-grey, \[data-surface="light"\]\) > \*/)
})

/** Контраст по WCAG */
function contrast(a: string, b: string) {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl
  }
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

test('сочетания цветов пиктограмм читаются: белый и тёмно-красный на красном, красный на белом', () => {
  assert.ok(contrast('#D50032', '#FFFFFF') >= 4.5)
  assert.ok(contrast('#AB2328', '#FFFFFF') >= 4.5)
  // Тёмно-красный на красном — «приглушённо» по брендбуку: заметно, но не текст
  assert.ok(contrast('#AB2328', '#D50032') > 1.2)
  // Серый — только для фигур: для текста на белом не годится
  assert.ok(contrast('#A2AAAD', '#FFFFFF') < 3)
})
