// ₽ и стрелки своими шрифтами: дополнение Ochakovo Display Signs к Sofia Sans (начертания 800 и 900) не больше 4 КБ,
// с лицензией OFL, подключено первым в --font-display; ≈ — из Onest под отдельным именем. Знаки в файлах проверяет
// fontTools, если он есть (python3 -c "import fontTools"). Запуск: pnpm test w1-home-hero

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const path = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url))
const read = (p: string) => readFileSync(path(p), 'utf8')
const SIGNS = ['src/fonts/display-signs-800.woff2', 'src/fonts/display-signs-900.woff2']

test('дополнение со знаками ₽ ← → есть, вместе не больше 4 КБ, рядом лицензия OFL', () => {
  const total = SIGNS.reduce((sum, f) => sum + statSync(path(f)).size, 0)
  assert.ok(total <= 4096, `дополнение весит ${total} байт`)
  const license = read('src/fonts/OFL.txt')
  assert.match(license, /SIL Open Font License, Version 1\.1/)
  assert.match(license, /Sofia Sans Project Authors/)
  assert.match(license, /Onest Project Authors/)
})

test('подключение: своё семейство для ₽ и стрелок первым, Onest только для ≈, без Onest для букв заголовков', () => {
  const fonts = read('src/fonts.css')
  for (const weight of [800, 900]) {
    const face = fonts.match(new RegExp(`@font-face \\{[^}]*font-family: 'Ochakovo Display Signs';[^}]*font-weight: ${weight};[^}]*\\}`))?.[0] ?? ''
    assert.match(face, new RegExp(`url\\(\\./fonts/display-signs-${weight}\\.woff2\\)`), `начертание ${weight}`)
    assert.match(face, /unicode-range: U\+20BD, U\+2190, U\+2192;/)
  }
  // Onest Signs — только ≈: своё дополнение встроено в CSS и не может не загрузиться отдельно, запас для ₽ и стрелок не нужен
  const signs = [...fonts.matchAll(/@font-face \{[^}]*font-family: 'Onest Signs';[^}]*\}/g)].map((m) => m[0])
  assert.equal(signs.length, 1)
  assert.match(signs[0], /unicode-range: U\+2248;/)
  const stack = read('src/index.css').match(/--font-display: ([^;]+);/)?.[1] ?? ''
  assert.equal(stack, '"Ochakovo Display Signs", "Sofia Sans Extra Condensed Variable", "Onest Signs", "Arial Narrow", sans-serif')
})

test('в файлах дополнения ровно ₽, ← и →, свои имена в таблице name, начертания 800 и 900', (t) => {
  const probe = spawnSync('python3', ['-c', 'import fontTools, brotli'], { encoding: 'utf8' })
  if (probe.status !== 0) return t.skip('нет python3 с fontTools и brotli')
  const script = `
import json, sys
from fontTools.ttLib import TTFont
out = []
for f in sys.argv[1:]:
    font = TTFont(f)
    cmap = font.getBestCmap()
    glyf = font['glyf']
    name = font['name']
    out.append({
        'codes': sorted(cmap),
        'contours': {hex(c): glyf[g].numberOfContours for c, g in cmap.items()},
        'family': name.getDebugName(1),
        'weight': font['OS/2'].usWeightClass,
        'license': name.getDebugName(13) or '',
    })
print(json.dumps(out))
`
  const run = spawnSync('python3', ['-c', script, ...SIGNS.map(path)], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  const fonts = JSON.parse(run.stdout) as { codes: number[]; contours: Record<string, number>; family: string; weight: number; license: string }[]
  assert.deepEqual(
    fonts.map((f) => f.weight),
    [800, 900],
  )
  for (const f of fonts) {
    assert.deepEqual(f.codes, [0x2190, 0x2192, 0x20bd].sort((a, b) => a - b))
    assert.equal(f.family, 'Ochakovo Display Signs')
    assert.match(f.license, /Open Font License/)
    // ₽ — «Р» с врезанной перекладиной: внешний контур и просвет чаши, без отдельного контура поверх
    assert.equal(f.contours['0x20bd'], 2)
    assert.equal(f.contours['0x2192'], 1)
    assert.equal(f.contours['0x2190'], 1)
  }
})

test('скрипт сборки шрифтов на месте и без вписанных годов в уведомлениях', () => {
  assert.ok(existsSync(path('scripts/fonts-subset.py')))
  const py = read('scripts/fonts-subset.py')
  assert.match(py, /instancer\.instantiateVariableFont/)
  assert.match(py, /TransformPen/)
  assert.match(py, /getDebugName\(0\)/)
})
