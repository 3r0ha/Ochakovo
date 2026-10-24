// Свой кодировщик QR (shared/qr.ts, w2-src-2) против эталонов из scripts/fixtures/qr/cases.json: их сделала библиотека
// Project Nayuki «QR Code generator» и перепроверила python-qrcode (как — в scripts/fixtures/qr/make.py).
// Для каждого случая совпадают версия, выбранная маска и каждый модуль; для части — матрицы со всеми восемью масками.
// Запуск: pnpm test w2-hr-sources-qr

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { encodeQr, QR_QUIET, qrDataCapacity, qrPath, qrRows, qrSvg, QrTooLong, type QrMask } from '../../shared/qr'

type Case = { text: string; version: number; mask: number; rows: string[]; forced?: string[][]; pyqrcodeAgrees?: boolean }
const fixtures = JSON.parse(readFileSync(new URL('../fixtures/qr/cases.json', import.meta.url), 'utf8')) as { generator: string; cases: Case[] }

test('эталоны покрывают версии 1–10 и байты не из ASCII', () => {
  const versions = new Set(fixtures.cases.map((c) => c.version))
  for (let v = 1; v <= 10; v++) assert.ok(versions.has(v), `нет эталона версии ${v}`)
  assert.ok(fixtures.cases.some((c) => /[^\x00-\x7f]/.test(c.text)), 'есть строка в UTF-8')
  assert.ok(fixtures.cases.filter((c) => c.forced).length >= 8)
  // Вторая независимая реализация согласна с эталоном по всем восьми маскам
  for (const c of fixtures.cases.filter((x) => x.forced)) assert.equal(c.pyqrcodeAgrees, true, c.text)
})

test('версия, маска и каждый модуль совпадают с эталоном', () => {
  for (const c of fixtures.cases) {
    const qr = encodeQr(c.text)
    assert.equal(qr.version, c.version, `версия: ${c.text}`)
    assert.equal(qr.mask, c.mask, `маска: ${c.text}`)
    assert.equal(qr.size, 17 + 4 * c.version)
    assert.deepEqual(qrRows(qr), c.rows, `матрица: ${c.text}`)
  }
})

test('каждая из восьми масок накладывается как в эталоне', () => {
  for (const c of fixtures.cases.filter((x) => x.forced)) {
    c.forced!.forEach((rows, m) => assert.deepEqual(qrRows(encodeQr(c.text, { mask: m as QrMask })), rows, `маска ${m}: ${c.text}`))
  }
})

test('ссылка с меткой — версия 3–5, длинная метка влезает, больше 213 байт — ошибка', () => {
  assert.equal(encodeQr('https://season.ochakovo.ru/?src=fair-misis').version, 3)
  assert.ok(encodeQr(`https://season.ochakovo.ru/?src=${'a'.repeat(40)}`).version <= 5)
  assert.equal(qrDataCapacity(10), 216)
  assert.equal(encodeQr('z'.repeat(213)).version, 10)
  assert.throws(() => encodeQr('z'.repeat(214)), QrTooLong)
  // Байты и та же строка — один код
  const text = 'https://season.ochakovo.ru/?src=edu-mgupp'
  assert.deepEqual(qrRows(encodeQr(new TextEncoder().encode(text))), qrRows(encodeQr(text)))
})

test('SVG для печати: свободное поле 4 модуля, чёткие края, только тёмные модули в контуре', () => {
  const qr = encodeQr('https://season.ochakovo.ru/?src=fair-misis')
  const side = qr.size + QR_QUIET * 2
  const svg = qrSvg(qr, { size: '30mm', title: 'QR <метка>' })
  assert.match(svg, new RegExp(`viewBox="0 0 ${side} ${side}"`))
  assert.match(svg, /width="30mm" height="30mm"/)
  assert.match(svg, /shape-rendering="crispEdges"/)
  assert.match(svg, /<title>QR &#60;метка&#62;<\/title>/)
  assert.match(svg, /<rect width="\d+" height="\d+" fill="#ffffff"\/>/)
  assert.doesNotMatch(qrSvg(qr, { light: null }), /<rect/)
  // Площадь отрезков в контуре равна числу тёмных модулей
  const dark = qr.modules.flat().filter(Boolean).length
  const area = [...qrPath(qr).matchAll(/h(\d+)v1/g)].reduce((n, m) => n + Number(m[1]), 0)
  assert.equal(area, dark)
  // Первый отрезок — левый верхний угол узора поиска, сдвинутый на свободное поле
  assert.ok(qrPath(qr).startsWith(`M${QR_QUIET} ${QR_QUIET}h7`))
})
