// Логотип без квадрата из брендбука (векторы из .ai), шапка и подвал, фавиконки без символа «квадрат с кругом».
// Файлы готовит node scripts/media.mjs brand и favicon. Запуск: pnpm test c2-brand-media-logo

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import sharp from 'sharp'
import { Logo, logoRatio } from '../../src/components/Logo'

const url = (p: string) => new URL(`../../${p}`, import.meta.url)
const read = (p: string) => readFileSync(url(p), 'utf8')
const paths = (svg: string) => [...svg.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1])

const LOGO_FILES = ['logo-red.svg', 'logo-white.svg', 'logo-line-red.svg', 'logo-line-white.svg', 'logo-frieze-red.svg', 'logo-frieze-white.svg']

test('логотип: красный и белый варианты в трёх компоновках, только контуры букв', () => {
  for (const f of LOGO_FILES) {
    const svg = read(`public/brand/${f}`)
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 [\d.]+ 100"/, f)
    assert.match(svg, f.includes('-red') ? /fill="#D50032"/ : /fill="#FFFFFF"/, `${f}: цвет брендбука`)
    // Ни круга, ни рамки: только контуры надписи
    assert.doesNotMatch(svg, /<(circle|ellipse|rect|image)\b/, f)
    assert.ok(paths(svg).length >= 2, `${f}: ОЧАКОВО и «Натуральные напитки»`)
    assert.ok(svg.length < 8_000, `${f}: ${svg.length} байт`)
  }
  // Белый и красный — одни и те же контуры
  for (const name of ['logo', 'logo-line', 'logo-frieze']) assert.deepEqual(paths(read(`public/brand/${name}-red.svg`)), paths(read(`public/brand/${name}-white.svg`)))
})

test('Logo.tsx рисует те же контуры, что файлы из брендбука', () => {
  const src = read('src/components/Logo.tsx')
  for (const [variant, file] of [
    ['line', 'logo-line-red.svg'],
    ['block', 'logo-red.svg'],
  ] as const) {
    const html = renderToStaticMarkup(createElement(Logo, { variant }))
    assert.deepEqual(paths(html), paths(read(`public/brand/${file}`)), `${variant}: перезапустите node scripts/media.mjs brand`)
    const box = read(`public/brand/${file}`).match(/viewBox="0 0 ([\d.]+) 100"/)![1]
    assert.ok(Math.abs(logoRatio(variant) - Number(box) / 100) < 1e-6)
  }
  assert.ok(src.includes('// <media:logos>') && src.includes('// </media:logos>'))
})

test('Logo: цвет от текста, без подписи скрыт от диктора, с подписью — картинка с именем', () => {
  const plain = renderToStaticMarkup(createElement(Logo, { variant: 'line', className: 'w-24' }))
  assert.match(plain, /^<svg viewBox="0 0 [\d.]+ 100" width="[\d.]+" height="100" fill="currentColor" class="w-24" aria-hidden="true" focusable="false">/)
  const titled = renderToStaticMarkup(createElement(Logo, { variant: 'block', title: 'Очаково. Натуральные напитки' }))
  assert.match(titled, /role="img" aria-label="Очаково\. Натуральные напитки"/)
  assert.doesNotMatch(titled, /aria-hidden/)
})

test('шапка и подвал — логотип без квадрата из брендбука', () => {
  const layout = read('src/components/Layout.tsx')
  assert.doesNotMatch(layout, /logo-wordmark/, 'прежний знак без подписи больше не в шапке и подвале')
  assert.match(layout, /<Link to="\/" onClick=\{closeMenu\} aria-label="Очаково, на главную"[^>]*>\s*<Logo variant="line"/)
  assert.match(layout, /<footer[\s\S]*<Logo variant="block" title="[^"]+"/)
  assert.match(layout, /import \{ Logo \} from '\.\/Logo'/)
})

test('в public/brand нет файлов с прежним знаком «квадрат с кругом»', () => {
  const files = readdirSync(url('public/brand'))
  for (const old of ['favicon.ico', 'logo.svg', 'logo.png', 'logo-lockup-2016-wikimedia.jpg', 'og-default-official.jpg']) assert.ok(!files.includes(old), `лишний файл public/brand/${old}`)
  // Знак без подписи остаётся: его рисуют этикетка бутылки в игре и картинки бота
  assert.ok(files.includes('logo-wordmark-red.svg') && files.includes('logo-wordmark-white.svg'))
})

/** Значки внутри ICO: размеры и PNG */
function icoEntries(buf: Buffer) {
  assert.equal(buf.readUInt16LE(0), 0)
  assert.equal(buf.readUInt16LE(2), 1, 'тип — значок')
  const n = buf.readUInt16LE(4)
  return Array.from({ length: n }, (_, i) => {
    const e = 6 + 16 * i
    const size = buf[e] || 256
    const bytes = buf.readUInt32LE(e + 8)
    const offset = buf.readUInt32LE(e + 12)
    return { size, png: buf.subarray(offset, offset + bytes) }
  })
}

test('favicon.ico: 16, 32 и 48 px из favicon.svg — бутылка кваса, без рамки и круга', async () => {
  const ico = readFileSync(url('public/favicon.ico'))
  const entries = icoEntries(ico)
  assert.deepEqual(
    entries.map((e) => e.size),
    [16, 32, 48],
  )
  for (const { size, png } of entries) {
    assert.equal(png.toString('latin1', 1, 4), 'PNG')
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    assert.deepEqual([info.width, info.height], [size, size])
    // Края значка прозрачные: ни квадратной рамки, ни заливки во весь значок
    const alphaAt = (x: number, y: number) => data[(y * size + x) * 4 + 3]
    for (let i = 0; i < size; i++) {
      assert.ok(alphaAt(i, 0) < 128 || alphaAt(0, i) < 128, `${size}px: рамка по краю`)
      assert.equal(alphaAt(0, i), 0, `${size}px: левый край`)
      assert.equal(alphaAt(size - 1, i), 0, `${size}px: правый край`)
    }
    // Силуэт бутылки — высокий и узкий: занятых столбцов меньше половины
    let cols = 0
    for (let x = 0; x < size; x++) if (Array.from({ length: size }, (_, y) => alphaAt(x, y)).some((a) => a > 128)) cols++
    assert.ok(cols > 0 && cols < size / 2, `${size}px: ширина силуэта ${cols}`)
    // Цвета кваса: в значке есть янтарь
    let amber = 0
    for (let p = 0; p < data.length; p += 4) if (data[p + 3] > 200 && data[p] > data[p + 2] + 40 && data[p + 1] > data[p + 2]) amber++
    assert.ok(amber > 0, `${size}px: квас цвета кваса`)
  }
  assert.ok(ico.length < 6_000, `favicon.ico: ${ico.length} байт`)
})

test('index.html: значок SVG и иконка для экрана «Домой»; favicon.ico лежит в корне сайта', () => {
  const html = read('index.html')
  assert.match(html, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml" \/>/)
  assert.match(html, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png" \/>/)
  // favicon.ico без ссылки: его по адресу /favicon.ico просят сами браузеры и сервисы, второй rel="icon" сбил бы выбор SVG
  assert.equal((html.match(/rel="icon"/g) ?? []).length, 1)
  assert.ok(existsSync(url('public/favicon.ico')))
  assert.doesNotMatch(read('public/favicon.svg'), /<circle|<ellipse/)
})
