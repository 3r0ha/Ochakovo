// Картинки превью ссылок и иконка: размеры, вес и числа, из которых они нарисованы (scripts/og.mjs).
// Если поменялись зарплаты, число вакансий, график, адрес или длина игры — перерисуйте: node scripts/og.mjs
// Запуск: pnpm test ops-og

import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { test } from 'node:test'
import { contacts } from '../../shared/content/content'
import { maxEntryPay, minMonthlyPay, netPay, scheduleSummary, vacancies } from '../../shared/content/vacancies'

/** Ширина и высота PNG из заголовка IHDR */
function pngSize(file: string) {
  const b = readFileSync(file)
  assert.equal(b.subarray(1, 4).toString('latin1'), 'PNG', `${file}: это PNG`)
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), bytes: b.length }
}

test('три картинки превью 1200×630 до 300 КБ и иконка 180×180', () => {
  for (const name of ['home', 'vacancies', 'game']) {
    const file = `public/og/${name}.png`
    const { width, height, bytes } = pngSize(file)
    assert.deepEqual({ width, height }, { width: 1200, height: 630 }, file)
    assert.ok(bytes <= 300 * 1024, `${file}: ${Math.round(bytes / 1024)} КБ — больше 300 КБ`)
  }
  const icon = pngSize('public/apple-touch-icon.png')
  assert.deepEqual({ width: icon.width, height: icon.height }, { width: 180, height: 180 })
  assert.ok(statSync('scripts/og.mjs').isFile())
})

test('картинки нарисованы по текущим данным shared', () => {
  const drawn = JSON.parse(readFileSync('public/og/og.json', 'utf8')) as Record<string, unknown>
  const gameSeconds = Number(readFileSync('src/game/useConveyorGame.ts', 'utf8').match(/export const GAME_SECONDS = (\d+)/)?.[1])
  const now = {
    minMonthlyPay,
    maxEntryPay,
    netMinMonthlyPay: netPay(minMonthlyPay),
    vacancies: vacancies.length,
    gameSeconds,
    schedule: scheduleSummary.title,
    address: contacts.address,
  }
  assert.deepEqual(drawn, now, 'данные изменились — перерисуйте картинки: node scripts/og.mjs')
})
