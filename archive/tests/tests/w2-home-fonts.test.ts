// Ядро латиницы (w2-hm-4): страницы на русском качают маленькие файлы с ASCII и знаками типографа, остальная латиница
// fontsource — отдельным @font-face, только по требованию. Диапазоны не пересекаются и вместе покрывают прежний.
// Запуск: pnpm test w2-home

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const path = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url))
const read = (p: string) => readFileSync(path(p), 'utf8')
const css = read('src/fonts.css')
const py = read('scripts/fonts-subset.py')

/** Прежний латинский диапазон fontsource */
const FONTSOURCE_LATIN = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'

function parseRange(range: string) {
  const out = new Set<number>()
  for (const part of range.split(',').map((p) => p.trim().replace(/^U\+/i, ''))) {
    const [a, b = a] = part.split('-').map((x) => parseInt(x, 16))
    for (let c = a; c <= b; c++) out.add(c)
  }
  return out
}

/** unicode-range у @font-face семейства с файлом, имя которого содержит file */
function faceRange(family: string, file: string) {
  const face = [...css.matchAll(/@font-face \{[^}]*\}/g)].map((m) => m[0]).find((f) => f.includes(`'${family}'`) && f.includes(file))
  assert.ok(face, `нет @font-face ${family} с ${file}`)
  return parseRange(/unicode-range: ([^;]+);/.exec(face)![1])
}

/** LATIN_CORE из scripts/fonts-subset.py: числа и range(a, b) */
function latinCore() {
  const body = /LATIN_CORE = \[([\s\S]+?)\n\]/.exec(py)?.[1] ?? ''
  assert.ok(body, 'в fonts-subset.py нет LATIN_CORE')
  const out = new Set<number>()
  for (const m of body.matchAll(/\*range\((0x[0-9A-F]+), (0x[0-9A-F]+)\)|(0x[0-9A-F]+)/gi)) {
    if (m[3]) out.add(parseInt(m[3], 16))
    else for (let c = parseInt(m[1], 16); c < parseInt(m[2], 16); c++) out.add(c)
  }
  return out
}

test('ядро и остаток латиницы: ядро = LATIN_CORE, не пересекаются, вместе — прежний диапазон fontsource', () => {
  const core = latinCore()
  const original = parseRange(FONTSOURCE_LATIN)
  for (const [family, coreFile, restFile] of [
    ['Onest Variable', 'onest-latin-core-wght.woff2', 'onest-latin-wght-normal.woff2'],
    ['Sofia Sans Extra Condensed Variable', 'sofia-latin-core-wght.woff2', 'sofia-sans-extra-condensed-latin-wght-normal.woff2'],
  ] as const) {
    const c = faceRange(family, coreFile)
    const r = faceRange(family, restFile)
    assert.deepEqual([...c].sort((a, b) => a - b), [...core].sort((a, b) => a - b), `${family}: ядро в CSS не совпадает с LATIN_CORE`)
    assert.deepEqual([...c].filter((x) => r.has(x)), [], `${family}: ядро и остаток пересекаются`)
    assert.deepEqual([...original].filter((x) => !c.has(x) && !r.has(x)), [], `${family}: часть прежнего диапазона потерялась`)
  }
  // Знаки, которые реально стоят на страницах: цифры, «ёлочки», неразрывный пробел, ·, ×, тире, разделитель слов типографа
  for (const ch of [0x30, 0x41, 0xa0, 0xab, 0xbb, 0xb7, 0xd7, 0x2013, 0x2014, 0x2060]) assert.ok(core.has(ch), `в ядре нет U+${ch.toString(16)}`)
})

test('файлы ядра легче прежних минимум на 24 КБ вместе', () => {
  const before = statSync(path('node_modules/@fontsource-variable/onest/files/onest-latin-wght-normal.woff2')).size + statSync(path('node_modules/@fontsource-variable/sofia-sans-extra-condensed/files/sofia-sans-extra-condensed-latin-wght-normal.woff2')).size
  const after = statSync(path('src/fonts/onest-latin-core-wght.woff2')).size + statSync(path('src/fonts/sofia-latin-core-wght.woff2')).size
  assert.ok(before - after >= 24 * 1024, `экономия ${before - after} байт`)
})

test('в файлах ядра — все знаки шрифта из LATIN_CORE, ось wght и цифры tnum', (t) => {
  const probe = spawnSync('python3', ['-c', 'import fontTools, brotli'], { encoding: 'utf8' })
  if (probe.status !== 0) return t.skip('нет python3 с fontTools и brotli')
  const script = `
import json, sys
from fontTools.ttLib import TTFont
out = []
for f in sys.argv[1:]:
    font = TTFont(f)
    feats = sorted({r.FeatureTag for r in font['GSUB'].table.FeatureList.FeatureRecord}) if 'GSUB' in font else []
    out.append({'codes': sorted(font.getBestCmap()), 'axes': [a.axisTag for a in font['fvar'].axes], 'features': feats})
print(json.dumps(out))
`
  const files = ['src/fonts/onest-latin-core-wght.woff2', 'src/fonts/sofia-latin-core-wght.woff2']
  const run = spawnSync('python3', ['-c', script, ...files.map(path)], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  const fonts = JSON.parse(run.stdout) as { codes: number[]; axes: string[]; features: string[] }[]
  for (const f of fonts) {
    for (let c = 0x20; c < 0x7f; c++) assert.ok(f.codes.includes(c), `нет U+${c.toString(16)}`)
    for (const c of [0xa0, 0xab, 0xbb, 0xb7, 0xd7, 0x2013, 0x2014]) assert.ok(f.codes.includes(c), `нет U+${c.toString(16)}`)
    assert.ok(f.codes.every((c) => latinCore().has(c)), 'лишние знаки в ядре')
    assert.deepEqual(f.axes, ['wght'])
    assert.ok(f.features.includes('tnum'), 'нет tnum — суммы с tabular-nums поедут')
  }
})
